import { ConfirmationResult, connectionFetch } from "./connection-confirmation.js";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import type { AuthSession } from "./app.js";
import { PublicError } from "./errors.js";
import type { MailiverySettings } from "./email-warmup.js";
import { WarmupWorkspaceRequest } from "./email-warmup-contracts.js";
import { warmupHandoffRefusal, type WarmupRefusal } from "./warmup-handoff.js";
import { UnipileTransport } from "./unipile-transport.js";

export const WARMUP_SCHEDULES = ["Weekdays - 8am to 6pm", "Weekdays - 7am to 7pm", "Weekdays - 6am to 10pm",
  "With Weekends - 8am to 6pm", "With Weekends - 7am to 7pm", "With Weekends - 6am to 10pm"] as const;
const timezone = z.string().min(1).max(100).refine(value => {
  try { new Intl.DateTimeFormat("en", {timeZone: value}); return true; } catch { return false; }
});
export const WarmupPolicy = z.strictObject({version: z.literal(1), emails_per_day: z.number().int().min(1).max(100),
  ramp: z.enum(["slow", "normal", "fast"]), reply_rate: z.number().int().min(0).max(55),
  schedule: z.enum(WARMUP_SCHEDULES), timezone, audience: z.enum(["inherit", "all", "business", "consumer"])});
export type WarmupPolicy = z.infer<typeof WarmupPolicy>;
export const DEFAULT_WARMUP_POLICY: WarmupPolicy = {version:1, emails_per_day:22, ramp:"normal", reply_rate:30,
  schedule:"Weekdays - 8am to 6pm", timezone:"America/New_York", audience:"inherit"};
const name = z.string().trim().max(80).refine(value => !/[\u0000-\u001f\u007f]/.test(value));
const SetupRecord = z.object({email:z.email().max(254), workspace_ref:z.uuid(), sender_ref:z.uuid(),
  expires_at:z.iso.datetime({offset:true}), state:z.enum(["draft", "authorizing", "claimed", "dispatched", "refused"]),
  refusal_code:z.enum(["mailbox_in_other_warmup","provider_rejected"]).optional(),
  policy:WarmupPolicy.nullable(), first_name:name, last_name:name,
  // LIF-1223: a habitual (`personal`) mailbox is tested as soon as warmup runs.
  // Absent before the Functions migration; the page then shows the dedicated text.
  mailbox_use:z.enum(["personal", "outreach"]).nullable().optional(),
  method:z.enum(["google", "microsoft"]).nullable().optional(),
  transport:UnipileTransport.optional(),
  dispatch:z.boolean().optional(), microsoft_url:z.string().max(8192).nullable().optional(),
  verify_at:z.iso.datetime({offset:true}).nullable().optional()});
export type WarmupSetupRecord = z.infer<typeof SetupRecord>;
export interface WarmupSetupSettings {
  serverKey:string; publicBaseUrl:string; supabaseUrl:string; publishableKey:string;
  googleClientId:string; googleClientSecret:string; mailivery:MailiverySettings;
}
type Rpc = (operation:string, payload:Record<string,unknown>, session?:AuthSession) => Promise<unknown>;
type Identity = {email:string; email_verified:boolean};
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
export const newSetupSecret = () => randomBytes(32).toString("base64url");
export const hashSetupSecret = (value:string) => createHash("sha256").update(value).digest("hex");
function requireSecret(value:string) { if (!tokenPattern.test(value)) throw invalid(); }
const invalid = () => new PublicError({status:400, code:"WARMUP_SETUP_INVALID", message:"This setup link or request is invalid. Run warmup start to get a new link."});
const unavailable = () => new PublicError({status:409, code:"WARMUP_SETUP_UNAVAILABLE", message:"Setup is expired, already submitted, or the mailbox changed. Check warmup status before getting a new link."});
const pending = () => new PublicError({status:502, code:"WARMUP_HANDOFF_PENDING", message:"The warmup handoff needs checking. Lifty will not resend your tokens or create another warmup. Check warmup status or contact support."});
const googleUnavailable = () => new PublicError({status:502, code:"WARMUP_GOOGLE_UNAVAILABLE", message:"Google authorization could not be verified. No mailbox credentials were shared. Run warmup start to try again."});
const IdentityClaims = z.object({email:z.email().max(254), email_verified:z.literal(true), nonce:z.string()});
const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"), {timeoutDuration:10000,[customFetch]:connectionFetch(fetch)});

/** Signature, issuer, audience and nonce are all verified, not just decoded. */
export async function verifyGoogleWarmupIdentity(idToken:string, clientId:string, nonce:string, keys:JWTVerifyGetKey=googleKeys):Promise<Identity> {
  try {
    const {payload} = await jwtVerify(idToken, keys, {issuer:["https://accounts.google.com", "accounts.google.com"], audience:clientId, algorithms:["RS256"], requiredClaims:["exp", "iat", "sub"]});
    const claims = IdentityClaims.parse(payload);
    if (claims.nonce !== nonce || (payload.azp !== undefined && payload.azp !== clientId)) throw new Error();
    return {email:claims.email, email_verified:claims.email_verified};
  } catch { throw googleUnavailable(); }
}

/** Google tokens remain ephemeral. Microsoft grants go directly to Mailivery;
 * only its short-lived consent URL is retained privately to recover lost reads. */
export function createWarmupSetup(settings:WarmupSetupSettings, dependencies:{rpc?:Rpc;fetchImpl?:typeof fetch;
  verifyIdentity?:(token:string, clientId:string, nonce:string)=>Promise<Identity>;
  identifyMailbox?:(transport:UnipileTransport,email:string)=>Promise<"google"|"microsoft">;
  verifyWarmup?:(senderRef:string, attempt:string)=>Promise<unknown>}={}) {
  const fetchImpl = connectionFetch(dependencies.fetchImpl ?? fetch);
  const base = settings.publicBaseUrl.replace(/\/$/, "");
  const redirectUri = `${base}/warmup/google/callback`;
  const mac = (purpose:string, state:string, browser:string) => createHmac("sha256", settings.serverKey)
    .update(`lifty:warmup:v1:${purpose}:${state}:${browser}`).digest("base64url");
  const rpc:Rpc = dependencies.rpc ?? (async (operation, payload, session) => {
    const args = {p_server_key:settings.serverKey, p_operation:operation, p_payload:payload};
    if (session) {
      const result = await (session.client as {rpc(name:string, args:Record<string,unknown>):Promise<{data:unknown;error:unknown}>})
        .rpc("lifty_email_warmup_setup", args);
      if (result.error) throw unavailable();
      return result.data;
    }
    const response = await fetchImpl(`${settings.supabaseUrl}/rest/v1/rpc/lifty_email_warmup_setup`, {
      method:"POST", redirect:"error", signal:AbortSignal.timeout(15000),
      headers:{apikey:settings.publishableKey, "content-type":"application/json"}, body:JSON.stringify(args),
    });
    if (!response.ok) throw unavailable();
    return response.json();
  });
  async function call(operation:string, payload:Record<string,unknown>, session?:AuthSession):Promise<WarmupSetupRecord> {
    try { return SetupRecord.parse(await rpc(operation, payload, session)); }
    catch { throw unavailable(); }
  }
  const oauthPayload = (state:string, browser:string) => {
    requireSecret(state); requireSecret(browser);
    return {oauth_hash:hashSetupSecret(state), browser_hash:hashSetupSecret(browser)};
  };
  async function identify(record:WarmupSetupRecord,intent:string,session?:AuthSession) {
    if(record.method)return record;
    if(!record.transport||!dependencies.identifyMailbox)throw unavailable();
    const method=await dependencies.identifyMailbox(record.transport,record.email);
    const identified=await call("identify",{intent_hash:hashSetupSecret(intent),method,transport:record.transport},session);
    if(identified.method!==method)throw unavailable();
    return identified;
  }
  async function refuse(payload:Record<string,unknown>, record:WarmupSetupRecord, code:WarmupRefusal) {
    const save=async()=>z.object({state:z.literal("refused"),code:z.literal(code)}).parse(await rpc("refuse",{...payload,code}));
    // Retrying the same persistence is safe; never repeat the provider request.
    try { await save(); } catch { await save(); }
    await dependencies.verifyWarmup?.(record.sender_ref, `${payload.oauth_hash}:refused`).catch(()=>{});
  }
  async function microsoftState(state:string,browser:string) {
    const record=await call("microsoft_status",oauthPayload(state,browser));
    if(record.method!=="microsoft")throw unavailable();
    if(record.verify_at)await dependencies.verifyWarmup?.(record.sender_ref,
      hashSetupSecret(`${hashSetupSecret(state)}:${record.verify_at}`)).catch(()=>{});
    return record;
  }
  return {
    origin:new URL(base).origin,
    validateCallback(state:string,browser:string) { oauthPayload(state,browser); },
    async receipt(state:string,browser:string,failure?:"verification"|"provider"|"canceled") {
      const payload=oauthPayload(state,browser);
      const response=await fetchImpl(`${settings.supabaseUrl}/rest/v1/rpc/lifty_warmup_browser_receipt`, {
        method:"POST",redirect:"error",signal:AbortSignal.timeout(8000),
        headers:{apikey:settings.publishableKey,"content-type":"application/json"},
        body:JSON.stringify({p_server_key:settings.serverKey,p_oauth_hash:payload.oauth_hash,p_browser_hash:payload.browser_hash,...(failure?{p_failure:failure}:{})}),
      });
      if(!response.ok)throw pending();
      return ConfirmationResult.parse(await response.json());
    },
    async issue(session:AuthSession, workspace:string, connectionRef?:string) {
      const input = WarmupWorkspaceRequest.parse({workspace, ...(connectionRef === undefined ? {} : {connection_ref:connectionRef})});
      const intent = newSetupSecret();
      const record = await identify(await call("issue", {...input, intent_hash:hashSetupSecret(intent)}, session),intent,session);
      return {url:`${base}/warmup/setup?intent=${intent}`, expiresAt:record.expires_at};
    },
    async read(intent:string) {
      requireSecret(intent);
      const record=await call("read", {intent_hash:hashSetupSecret(intent)});
      return record.state==="draft"?identify(record,intent):record;
    },
    // LIF-1228: the platform owns the warmup policy and schedule; the sender
    // name comes from the Identity person in the database. The browser supplies nothing.
    async choose(intent:string, browser:string):Promise<string> {
      requireSecret(intent); requireSecret(browser);
      const current=await identify(await call("read",{intent_hash:hashSetupSecret(intent)}),intent);
      const state = newSetupSecret();
      const record = await call("choose", {intent_hash:hashSetupSecret(intent), browser_hash:hashSetupSecret(browser),
        oauth_hash:hashSetupSecret(state), method:current.method, policy:DEFAULT_WARMUP_POLICY});
      if(record.method!==current.method)throw unavailable();
      if(record.method==="microsoft")return `${base}/warmup/microsoft/return?state=${state}&prepare=1`;
      const query = new URLSearchParams({client_id:settings.googleClientId, redirect_uri:redirectUri,
        response_type:"code", scope:"openid email https://mail.google.com/", access_type:"offline", prompt:"consent select_account",
        login_hint:record.email, state, nonce:mac("nonce", state, browser), code_challenge:hashPkce(mac("pkce", state, browser)), code_challenge_method:"S256"});
      return `https://accounts.google.com/o/oauth2/v2/auth?${query}`;
    },
    async prepareMicrosoft(state:string,browser:string) {
      const payload=oauthPayload(state,browser);
      // One durable dispatch before the vendor call. Reloads and concurrent
      // tabs only recover its saved link/status; they never request another.
      const record=await call("microsoft_prepare",payload);
      if(record.method!=="microsoft")throw unavailable();
      if(!record.dispatch)return;
      if(!record.policy)throw unavailable();
      try {
        const response=await fetchImpl(`${settings.mailivery.baseUrl??"https://app.mailivery.io/api/v1"}/campaigns/ms-graph`,{
          method:"POST",redirect:"error",signal:AbortSignal.timeout(15000),
          headers:{authorization:`Bearer ${settings.mailivery.apiKey}`,accept:"application/json","content-type":"application/json"},
          body:JSON.stringify({email:record.email,first_name:record.first_name,last_name:record.last_name,
            email_per_day:record.policy.emails_per_day,response_rate:record.policy.reply_rate,warmup_audience_type:record.policy.audience,
            meta:{tags:`lifty-ws:${record.workspace_ref},lifty-sender:${record.sender_ref}`}}),
        });
        if(!response.ok){
          const code=await warmupHandoffRefusal(response);
          if(code){await refuse(payload,record,code);return;}
          throw pending();
        }
        // The response contains only an authorization URL. Never accept an
        // arbitrary redirect or a credential-bearing provider response.
        const reader=response.body?.getReader();if(!reader)throw pending();
        const chunks:Uint8Array[]=[];let size=0;
        try {while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;
          if(size>16384){await reader.cancel();throw pending();}chunks.push(chunk.value);}}
        finally{reader.releaseLock();}
        const value=z.object({success:z.literal(true),data:z.object({url:z.string().max(8192)})})
          .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        const url=validateMicrosoftConsentUrl(value.data.url);
        // Retrying this exact save is safe if its response was lost. The
        // provider link request above is deliberately never retried.
        try{await call("microsoft_link",{...payload,url});}
        catch{await call("microsoft_link",{...payload,url});}
      }catch{throw pending();}
    },
    async microsoftStatus(state:string,browser:string) {await microsoftState(state,browser);},
    async microsoftLink(state:string,browser:string) {
      const record=await microsoftState(state,browser);
      if(!record.microsoft_url)throw unavailable();
      return validateMicrosoftConsentUrl(record.microsoft_url);
    },
    async callback(state:string, browser:string, code:string):Promise<void> {
      const payload = oauthPayload(state, browser);
      if (!code || code.length > 4096) throw invalid();
      // Consumed before token exchange; two callbacks can never exchange/deliver twice.
      const record = await call("claim", payload);
      if(record.method==="microsoft")throw unavailable();
      const tokenSchema = z.object({access_token:z.string().min(1).max(16384), refresh_token:z.string().min(1).max(16384),
        id_token:z.string().min(1).max(16384), token_type:z.literal("Bearer"), scope:z.string().max(2048)});
      let tokens:z.infer<typeof tokenSchema>;
      try {
        const response = await fetchImpl("https://oauth2.googleapis.com/token", {method:"POST", redirect:"error", signal:AbortSignal.timeout(15000),
          headers:{"content-type":"application/x-www-form-urlencoded"}, body:new URLSearchParams({code, client_id:settings.googleClientId,
            client_secret:settings.googleClientSecret, redirect_uri:redirectUri, grant_type:"authorization_code", code_verifier:mac("pkce", state, browser)})});
        if (!response.ok) throw new Error();
        tokens = tokenSchema.parse(await response.json());
        if (!tokens.scope.split(/\s+/).includes("https://mail.google.com/")) throw new Error();
      } catch { throw googleUnavailable(); }
      const identity = await (dependencies.verifyIdentity ?? verifyGoogleWarmupIdentity)(tokens.id_token, settings.googleClientId, mac("nonce", state, browser));
      // No Gmail dot/plus/alias equivalence. Stored Unipile emails are canonical lower-case.
      if (!identity.email_verified || identity.email.toLowerCase() !== record.email) throw new PublicError({status:409,
        code:"WARMUP_IDENTITY_MISMATCH", message:`Google did not verify the mailbox connected to Lifty. No tokens were shared. Run warmup start and choose the same address.`});
      if (!record.policy) throw unavailable();
      await call("dispatch", {...payload, verified_email:identity.email.toLowerCase()});
      const body = new FormData();
      const fields = {email:record.email, first_name:record.first_name, last_name:record.last_name,
        email_per_day:String(record.policy.emails_per_day), response_rate:String(record.policy.reply_rate), with_rampup:"true",
        rampup_speed:record.policy.ramp, sending_schedule_presets:record.policy.schedule, timezone:record.policy.timezone,
        warmup_audience_type:record.policy.audience, tags:`lifty-ws:${record.workspace_ref},lifty-sender:${record.sender_ref}`,
        google_token:tokens.access_token, google_refresh_token:tokens.refresh_token};
      for (const [key,value] of Object.entries(fields)) body.set(key,value);
      try {
        const response = await fetchImpl(`${settings.mailivery.baseUrl ?? "https://app.mailivery.io/api/v1"}/campaigns/google-oauth`, {
          method:"POST", redirect:"error", signal:AbortSignal.timeout(15000), headers:{authorization:`Bearer ${settings.mailivery.apiKey}`, accept:"application/json"}, body});
        if (!response.ok) {
          const code=await warmupHandoffRefusal(response);
          if(code){await refuse(payload,record,code);return;}
          throw new Error();
        }
        // CAMPAIGN_CREATED + active is an acknowledgement of this new start,
        // not binding evidence. Jobs still verifies SMTP, IMAP and both tags.
        // Generic 2xx, adoption, consent and unreadable responses supply no date.
        const created = await googleCreationAcknowledgement(response, record.email);
        if(created) {
          const receipt={...payload,campaign:String(created.id),email:created.email,
            code:"CAMPAIGN_CREATED",status_code:"active",acknowledged_at:new Date().toISOString()};
          const save=async()=>{z.object({recorded:z.literal(true)}).parse(await rpc("start_ack",receipt));};
          try{await save();}catch{await save();}
        }
      } catch { throw pending(); }
      // Jobs verifies and starts this binding now, so the page can confirm it
      // and a habitual mailbox's placement test starts. The handoff already
      // succeeded: a lost trigger only waits for the next scheduled pass.
      await dependencies.verifyWarmup?.(record.sender_ref, payload.oauth_hash).catch(()=>{});
    },
  };
}
/** Bounded parsing of the documented creation response; provider bodies and
 * tokens are never retained. An unknown acknowledgement keeps setup resumable. */
async function googleCreationAcknowledgement(response:Response,email:string) {
  const reader=response.body?.getReader();if(!reader)return null;
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    const expired=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error()),2000);});
    const chunks:Uint8Array[]=[];let size=0;
    while(true){const chunk=await Promise.race([reader.read(),expired]);if(chunk.done)break;
      size+=chunk.value.byteLength;if(size>16384)return null;chunks.push(chunk.value);}
    const result=z.object({success:z.literal(true),status:z.literal(200),code:z.literal("CAMPAIGN_CREATED"),
      data:z.object({id:z.number().int().positive().safe(),email:z.literal(email),status_code:z.literal("active")})})
      .safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    return result.success?result.data.data:null;
  }catch{return null;}
  finally{clearTimeout(timer);void reader.cancel().catch(()=>{});reader.releaseLock();}
}
function validateMicrosoftConsentUrl(value:string):string {
  if(value.length>8192||/[\u0000-\u0020\u007f]/.test(value))throw pending();
  const url=new URL(value);
  if(url.origin!=="https://login.microsoftonline.com"||url.username||url.password||url.hash
    ||!/^\/[A-Za-z0-9.-]+\/oauth2\/v2\.0\/authorize$/.test(url.pathname)
    ||!url.searchParams.get("state")||!url.searchParams.get("client_id")
    ||[...url.searchParams.keys()].some(key=>!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)||["code","access_token","refresh_token","id_token"].includes(key.toLowerCase())))throw pending();
  return url.toString();
}
const hashPkce = (value:string) => createHash("sha256").update(value).digest("base64url");
export type WarmupSetup = ReturnType<typeof createWarmupSetup>;
