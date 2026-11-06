import { describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createWarmupSetup, DEFAULT_WARMUP_POLICY, hashSetupSecret, verifyGoogleWarmupIdentity, WarmupPolicy, type WarmupSetupRecord } from "../src/warmup-setup.js";

const secret = "a".repeat(43), browser = "b".repeat(43);
const policy = { version: 1, emails_per_day: 22, ramp: "slow", reply_rate: 30,
  schedule: "Weekdays - 8am to 6pm", timezone: "America/Argentina/Buenos_Aires", audience: "business" };
const record = { email: "founder@example.test", workspace_ref: "22222222-2222-4222-8222-222222222222",
  sender_ref: "33333333-3333-4333-8333-333333333333", expires_at: "2026-10-01T00:00:00Z",
  state: "claimed", method:"google" as const, policy, first_name: "Ada", last_name: "Lovelace" };
function harness(email = record.email, providerFailure = false, tokenOverrides:Record<string,unknown> = {}, recordOverrides:Partial<WarmupSetupRecord> = {}, cleanupFailure = false,
  verifyWarmup?: (senderRef:string, attempt:string)=>Promise<unknown>, creation:unknown={success:true}, ackFailures=0) {
  const writes: {operation: string; payload: Record<string, unknown>}[] = [];
  let claimed = false, dispatched = false;
  const rpc = vi.fn(async (operation: string, payload: Record<string, unknown>) => {
    writes.push({operation, payload});
    if (operation === "claim") { if (claimed) throw new Error("replay"); claimed = true; }
    if (operation === "dispatch") { if (dispatched) throw new Error("duplicate"); dispatched = true; }
    if(operation==="start_ack") {
      if(ackFailures-->0)throw new Error("receipt response lost");
      return {recorded:true};
    }
    return {...record, ...recordOverrides};
  });
  const requests: {url: string; body: unknown}[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    requests.push({url: String(url), body: init?.body});
    if (String(url).includes("oauth2.googleapis.com")) return Response.json({access_token: "ACCESS-PRIVATE",
      refresh_token: "REFRESH-PRIVATE", id_token: "ID-PRIVATE", scope: "openid email https://mail.google.com/", token_type: "Bearer", ...tokenOverrides});
    if (providerFailure) throw new Error("REFRESH-PRIVATE network detail");
    const response=Response.json(creation);
    if(cleanupFailure)response.body!.cancel=async()=>{throw new Error("body cleanup failed");};
    return response;
  };
  const setup = createWarmupSetup({serverKey: "k".repeat(32), publicBaseUrl: "https://api.lifty.test",
    supabaseUrl: "https://db.test", publishableKey: "publishable", googleClientId: "client-id", googleClientSecret: "client-secret",
    mailivery: {apiKey: "mailivery-secret"}}, {rpc, fetchImpl,
      verifyIdentity: async () => ({email, email_verified: true}), ...(verifyWarmup ? {verifyWarmup} : {})});
  return {setup, requests, writes};
}
describe("warmup setup OAuth handoff", () => {
  it("does not turn successful handoff into an error when discarding its response body fails",async()=>{
    const h=harness(record.email,false,{}, {},true);
    await expect(h.setup.callback(secret,browser,"code")).resolves.toBeUndefined();
    expect(h.requests.filter(r=>r.url.includes("mailivery"))).toHaveLength(1);
  });
  it("retains the typed active Google creation acknowledgement before Jobs, retrying the same occurrence",async()=>{
    const h=harness(record.email,false,{}, {},false,undefined,
      {success:true,status:200,code:"CAMPAIGN_CREATED",data:{id:125,email:record.email,status_code:"active"}},1);
    const before=Date.now();
    await h.setup.callback(secret,browser,"code");
    const receipts=h.writes.filter(x=>x.operation==="start_ack");
    expect(receipts).toHaveLength(2);
    expect(receipts[0]).toEqual(receipts[1]);
    expect(receipts[0]!.payload).toMatchObject({campaign:"125",email:record.email,code:"CAMPAIGN_CREATED",status_code:"active",
      oauth_hash:hashSetupSecret(secret),browser_hash:hashSetupSecret(browser)});
    expect(Date.parse(String(receipts[0]!.payload.acknowledged_at))).toBeGreaterThanOrEqual(before);
    expect(h.requests.filter(x=>x.url.includes("mailivery"))).toHaveLength(1);
    expect(JSON.stringify(receipts)).not.toMatch(/PRIVATE|google-code|dashboard_url/);
  });
  it.each([
    {success:true},
    {success:true,status:200,code:"CAMPAIGN_FETCHED",data:{id:125,email:record.email,status_code:"active"}},
    {success:true,status:200,code:"CAMPAIGN_CREATED",data:{id:125,email:"foreign@example.test",status_code:"active"}},
    {success:true,status:200,code:"CAMPAIGN_CREATED",data:{id:125,email:record.email,status_code:"pending"}},
    {success:true,status:200,code:"CAMPAIGN_CREATED",data:{id:"125",email:record.email,status_code:"active"}},
  ])("generic, foreign or non-active creation responses do not manufacture a start: %j",async creation=>{
    const h=harness(record.email,false,{}, {},false,undefined,creation);
    await h.setup.callback(secret,browser,"code");
    expect(h.writes.filter(x=>x.operation==="start_ack")).toHaveLength(0);
  });
  it("checks PKCE, offline access, nonce and exact mailbox hint on Google's consent URL", async()=>{
    const h=harness();
    const url=new URL(await h.setup.choose(secret,browser));
    expect(url.origin).toBe("https://accounts.google.com");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({access_type:"offline",prompt:"consent select_account",login_hint:record.email,
      scope:"openid email https://mail.google.com/",code_challenge_method:"S256",redirect_uri:"https://api.lifty.test/warmup/google/callback"});
    expect(url.searchParams.get("nonce")).toHaveLength(43);
    expect(url.searchParams.get("code_challenge")).toHaveLength(43);
    expect(h.writes.find(x=>x.operation==="choose")?.payload.oauth_hash).toBe(hashSetupSecret(url.searchParams.get("state")!));
    expect(h.writes.find(x=>x.operation==="choose")?.payload).not.toHaveProperty("code_verifier");
  });
  it.each([{refresh_token:""},{scope:"openid email https://www.googleapis.com/auth/gmail.send"},{token_type:"mac"}])("rejects unusable Google credentials before Mailivery: %j",async change=>{
    const h=harness(record.email,false,change);
    await expect(h.setup.callback(secret,browser,"code")).rejects.toMatchObject({code:"WARMUP_GOOGLE_UNAVAILABLE"});
    expect(h.requests).toHaveLength(1);
    expect(h.writes.map(x=>x.operation)).toEqual(["claim"]);
  });
  it("chooses Google with the platform policy only; the browser supplies no name or timezone (LIF-1228)",async()=>{
    const h=harness();
    await h.setup.choose(secret,browser);
    expect(Object.keys(h.writes.find(x=>x.operation==="choose")!.payload).sort()).toEqual(["browser_hash","intent_hash","method","oauth_hash","policy"]);
    expect(h.writes.find(x=>x.operation==="choose")?.payload).toMatchObject({method:"google",policy:DEFAULT_WARMUP_POLICY});
  });
  it("rejects another Google address before any Mailivery request or dispatch", async () => {
    const h = harness("other@example.test");
    await expect(h.setup.callback(secret, browser, "google-code")).rejects.toMatchObject({code: "WARMUP_IDENTITY_MISMATCH"});
    expect(h.requests).toHaveLength(1);
    expect(h.writes.map(x => x.operation)).toEqual(["claim"]);
  });
  it("sends the configured policy and tokens once; persists only hashes and verified identity", async () => {
    const h = harness();
    await h.setup.callback(secret, browser, "google-code");
    const provider = h.requests[1]!;
    expect(provider.url).toBe("https://app.mailivery.io/api/v1/campaigns/google-oauth");
    const fields = Object.fromEntries((provider.body as FormData).entries());
    expect(fields).toMatchObject({email: record.email, google_token: "ACCESS-PRIVATE", google_refresh_token: "REFRESH-PRIVATE",
      email_per_day: "22", rampup_speed: "slow", timezone: policy.timezone, warmup_audience_type: "business"});
    expect(h.writes).toEqual([{operation: "claim", payload: {oauth_hash: hashSetupSecret(secret), browser_hash: hashSetupSecret(browser)}},
      {operation: "dispatch", payload: {oauth_hash: hashSetupSecret(secret), browser_hash: hashSetupSecret(browser), verified_email: record.email}}]);
    await expect(h.setup.callback(secret, browser, "google-code")).rejects.toThrow();
    expect(h.requests).toHaveLength(2);
    expect(JSON.stringify(h.writes)).not.toMatch(/PRIVATE|google-code/);
  });
  it("asks Jobs to verify the binding right after Mailivery accepts; a lost trigger cannot fail the handoff", async () => {
    const order: string[] = [];
    const verify = vi.fn(async () => { order.push("verify"); throw new Error("Trigger.dev unavailable"); });
    const h = harness(record.email, false, {}, {}, false, verify);
    await expect(h.setup.callback(secret, browser, "code")).resolves.toBeUndefined();
    expect(verify).toHaveBeenCalledExactlyOnceWith(record.sender_ref, hashSetupSecret(secret));
    expect(h.requests.at(-1)?.url).toContain("mailivery");
    const failed = vi.fn(async () => undefined);
    await expect(harness(record.email, true, {}, {}, false, failed).setup.callback(secret, browser, "code"))
      .rejects.toMatchObject({code: "WARMUP_HANDOFF_PENDING"});
    expect(failed).not.toHaveBeenCalled();
  });
  it("does not retry or expose provider errors after an ambiguous dispatch", async () => {
    const h = harness(record.email, true);
    await expect(h.setup.callback(secret, browser, "google-code")).rejects.toMatchObject({code: "WARMUP_HANDOFF_PENDING"});
    expect(h.requests).toHaveLength(2);
    expect(h.writes.at(-1)?.operation).toBe("dispatch");
  });

  it("uses each binding's opaque sender reference for different mailboxes in one workspace", async () => {
    const mailboxes = [
      {email:"david@liftygtm.test",sender_ref:"44444444-4444-4444-8444-444444444444"},
      {email:"david@liftyhq.test",sender_ref:"55555555-5555-4555-8555-555555555555"},
      {email:"david@runlifty.test",sender_ref:"66666666-6666-4666-8666-666666666666"},
    ];
    const tags:string[]=[];
    for (const mailbox of mailboxes) {
      const h=harness(mailbox.email,false,{},mailbox);
      await h.setup.callback(secret,browser,"code");
      const fields=Object.fromEntries((h.requests[1]!.body as FormData).entries());
      expect(fields.email).toBe(mailbox.email);
      expect(fields.tags).toBe(`lifty-ws:${record.workspace_ref},lifty-sender:${mailbox.sender_ref}`);
      tags.push(fields.tags as string);
    }
    expect(new Set(tags).size).toBe(3);
  });
  it("rejects invalid policy fields and unknown keys before an external call", () => {
    expect(WarmupPolicy.safeParse(policy).success).toBe(true);
    for (const change of [{emails_per_day:101},{reply_rate:56},{ramp:"extreme"},{timezone:"fake/zone"},{audience:"custom"},{google_token:"secret"}]) {
      expect(WarmupPolicy.safeParse({...policy, ...change}).success).toBe(false);
    }
  });
});
it("verifies Google token signatures, nonce, issuer, audience, expiry and email verification",async()=>{
  const {publicKey,privateKey}=await generateKeyPair("RS256");
  const jwk=await exportJWK(publicKey); const keys=createLocalJWKSet({keys:[{...jwk,alg:"RS256",kid:"test"}]});
  async function token(change:Record<string,unknown>={}) {
    return new SignJWT({email:record.email,email_verified:true,nonce:"expected",...change}).setProtectedHeader({alg:"RS256",kid:"test"})
      .setIssuer("https://accounts.google.com").setAudience("client-id").setSubject("google-user").setIssuedAt().setExpirationTime("5m").sign(privateKey);
  }
  const good=await token();
  expect(await verifyGoogleWarmupIdentity(good,"client-id","expected",keys)).toEqual({email:record.email,email_verified:true});
  for(const [value,client,nonce] of [[good,"wrong-client","expected"],[good,"client-id","wrong-nonce"],
    [await token({email_verified:false}),"client-id","expected"],[await token({azp:"wrong-client"}),"client-id","expected"],
    [`${good.slice(0,-8)}ABCDEFGH`,"client-id","expected"]]) {
    await expect(verifyGoogleWarmupIdentity(value!,client!,nonce!,keys)).rejects.toMatchObject({code:"WARMUP_GOOGLE_UNAVAILABLE"});
  }
  const wrongIssuer=await new SignJWT({email:record.email,email_verified:true,nonce:"expected"}).setProtectedHeader({alg:"RS256",kid:"test"})
    .setIssuer("https://evil.test").setAudience("client-id").setSubject("user").setIssuedAt().setExpirationTime("5m").sign(privateKey);
  await expect(verifyGoogleWarmupIdentity(wrongIssuer,"client-id","expected",keys)).rejects.toMatchObject({code:"WARMUP_GOOGLE_UNAVAILABLE"});
  const expired=await new SignJWT({email:record.email,email_verified:true,nonce:"expected"}).setProtectedHeader({alg:"RS256",kid:"test"})
    .setIssuer("https://accounts.google.com").setAudience("client-id").setSubject("user").setIssuedAt().setExpirationTime(0).sign(privateKey);
  await expect(verifyGoogleWarmupIdentity(expired,"client-id","expected",keys)).rejects.toMatchObject({code:"WARMUP_GOOGLE_UNAVAILABLE"});
});
it("stores only a hash for issued setup URLs and uses the founder session for issue",async()=>{
  const calls:unknown[]=[];
  const session={userId:"user",client:{rpc:async(n:string,args:unknown)=>{calls.push({n,args});return {data:{...record,state:"draft",policy:null},error:null};}}};
  const setup=createWarmupSetup({serverKey:"k".repeat(32),publicBaseUrl:"https://api.lifty.test",supabaseUrl:"https://db.test",publishableKey:"publishable",
    googleClientId:"client",googleClientSecret:"secret",mailivery:{apiKey:"key"}});
  const link=await setup.issue(session,"workspace");
  const intent=new URL(link.url).searchParams.get("intent")!;
  expect(calls).toEqual([{n:"lifty_email_warmup_setup",args:{p_server_key:"k".repeat(32),p_operation:"issue",p_payload:{workspace:"workspace",intent_hash:hashSetupSecret(intent)}}}]);
  expect(JSON.stringify(calls)).not.toContain(intent);
});

it("issues a client setup intent for the selected connection through the authenticated member session",async()=>{
  const calls:unknown[]=[];
  const session={userId:"member",client:{rpc:async(n:string,args:unknown)=>{calls.push({n,args});return {data:{...record,state:"draft",policy:null},error:null};}}};
  const setup=createWarmupSetup({serverKey:"k".repeat(32),publicBaseUrl:"https://api.lifty.test",supabaseUrl:"https://db.test",publishableKey:"publishable",
    googleClientId:"client",googleClientSecret:"secret",mailivery:{apiKey:"key"}}, {fetchImpl:async()=>{throw Error("issue must use the authenticated session");}});
  const connection="55555555-5555-4555-8555-555555555555";
  const link=await setup.issue(session,"lift",connection);
  const intent=new URL(link.url).searchParams.get("intent")!;
  expect(calls).toEqual([{n:"lifty_email_warmup_setup",args:{p_server_key:"k".repeat(32),p_operation:"issue",
    p_payload:{workspace:"lift",connection_ref:connection,intent_hash:hashSetupSecret(intent)}}}]);
  expect(JSON.stringify(calls)).not.toContain(intent);
  expect(link.url).not.toContain(connection);
  await expect(setup.issue(session,"lift","not-a-uuid")).rejects.toThrow();
  expect(calls).toHaveLength(1);
});
