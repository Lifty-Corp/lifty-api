import { describe,it,expect } from "vitest";
import { createUnipileV2Provider } from "../src/unipile-v2-provider.js";
import { UnipileTransport } from "../src/unipile-transport.js";

const transport:UnipileTransport={api_version:"v2",connection_ref:null,canonical_account_id:"legacy_account",provider_namespace:"unipile:legacy",
  account_id:"acc_test",application_id:"app_test",account_scope_id:"scope_test",generation:1,owner_profile_id:null,user_id:"owner",v1_account_id:"legacy_account",hosted_auth_origin:"https://connect-v2.lifty.test"};
const email="founder@example.test";
const account={object:"Account",id:"acc_test",application_id:"app_test",account_scope_id:"scope_test",user_id:"owner",
  provider:"google",status:"running",is_locked:false,metadata:{v1_account_id:"legacy_account",products_connection_status:{gmail:"running"}}};
const outlook={...account,provider:"outlook",oauth_scope:"User.Read,Mail.ReadWrite,Mail.Send",metadata:{v1_account_id:"legacy_account",products_connection_status:{mail:"running"}}};
const senders={data:[{object:"EmailSender",email,is_primary:true,verification_status:"verified"}]};
const profile={object:"UserProfile",provider:"linkedin",id:"owner",type:"individual",display_name:"Founder",public_identifier:"founder",specifics:{network_distance:"SELF"}};
function harness(options:{account?:unknown;senders?:unknown;profile?:unknown;link?:string;status?:number;body?:Response}={}) {
  const calls:{url:string;init:RequestInit|undefined}[]=[];
  const fetchImpl:typeof fetch=async(url,init)=>{
    calls.push({url:String(url),init});
    expect(init?.headers).toMatchObject({"X-API-KEY":"v2-test-key"});
    expect(init?.redirect).toBe("error");
    if(options.body)return options.body;
    const result=String(url).endsWith("auth/link") ? {object:"HostedAuthLink",link:options.link??"https://connect-v2.lifty.test/?token=opaque"}
      : String(url).includes("email-senders") ? options.senders??senders
      : String(url).includes("/users/") ? options.profile??profile : options.account??account;
    return new Response(JSON.stringify(result),{status:options.status??200});
  };
  return {calls,provider:createUnipileV2Provider({accessToken:"v2-test-key",applicationId:"app_test",hostedAuthOrigins:["https://connect-v2.lifty.test"],fetchImpl})};
}
describe("Unipile V2 failures",()=>{
  it("keeps the documented type and request id of a failed call, and nothing else of its body",async()=>{
    const h=harness({body:new Response(JSON.stringify({object:"Error",status:403,type:"api/inactive_subscription",title:"Forbidden",detail:"Private text",req_id:"req-1"}),{status:403})});
    await expect(h.provider.readEmailIdentity("acc_test",transport,email)).rejects.toMatchObject({code:"UNIPILE_UNAVAILABLE",
      diagnostics:{upstream_operation:"unipile",upstream_code:"403",upstream_kind:"provider",provider_error:"api/inactive_subscription",provider_request_id:"req-1"}});
    await harness({body:new Response(JSON.stringify({object:"Error",status:403,type:"api/inactive_subscription",detail:"Private text"}),{status:403})})
      .provider.readEmailIdentity("acc_test",transport,email).catch((error:{diagnostics:unknown})=>expect(JSON.stringify(error.diagnostics)).not.toContain("Private"));
  });
  it("a gateway page still fails with its status",async()=>{
    const h=harness({body:new Response("<html>Bad Gateway</html>",{status:502})});
    await expect(h.provider.readEmailIdentity("acc_test",transport,email)).rejects.toMatchObject({code:"UNIPILE_UNAVAILABLE",
      diagnostics:{upstream_operation:"unipile",upstream_code:"502",upstream_kind:"provider"}});
  });
});
describe("Unipile V2 authenticated contract",()=>{
  it.each([{raw:account,readiness:"verified"},{raw:outlook,readiness:"verified"},{raw:outlook,readiness:"unknown"}])("retains canonical identity after exact application/scope/owner/alias readback: $raw.provider/$readiness",async({raw,readiness})=>{
    const h=harness({account:raw,senders:{data:[{...senders.data[0],verification_status:readiness}]}});
    expect(await h.provider.readEmailIdentity("acc_test",transport,email)).toEqual({accountId:"legacy_account",email,type:raw.provider === "outlook" ? "OUTLOOK" : "GOOGLE_OAUTH",healthy:true,healthStatus:"running",
      verifiedTransport:{api_version:"v2",account_id:"acc_test",application_id:"app_test",account_scope_id:"scope_test",user_id:"owner",owner_profile_id:null,v1_account_id:"legacy_account"}});
    expect(h.calls.map(c=>c.url)).toEqual(["https://api.unipile.com/v2/accounts/acc_test","https://api.unipile.com/v2/acc_test/email-senders"]);
  });
  for (const raw of [account,outlook]) it.each([
    {id:"foreign"},{application_id:"app_foreign"},{account_scope_id:"foreign"},{account_scope_id:null},{user_id:"other"},
    {metadata:{v1_account_id:"other"}},{metadata:{}},{provider:"linkedin"},
  ])(`rejects authentic but incorrectly bound ${raw.provider} account %j`,async(change)=>{
    const h=harness({account:{...raw,...change}});
    await expect(h.provider.readEmailIdentity("acc_test",transport,email)).rejects.toMatchObject({code:"UNIPILE_IDENTITY_MISMATCH"});
    expect(h.calls).toHaveLength(1);
  });
  it("does not invent a V1 alias for a new V2-only account",async()=>{
    const h=harness({account:{...account,metadata:{}}});
    const identity=await h.provider.readEmailIdentity("acc_test",{...transport,provider_namespace:"unipile:v2:app_test",canonical_account_id:null,account_id:null,user_id:null,v1_account_id:null},email);
    expect(identity.accountId).toBe("acc_test");expect(identity.verifiedTransport.v1_account_id).toBeNull();
  });
  it.each(["imap"])("does not substitute Gmail evidence for unverified V2 %s policy",async(provider)=>{
    const h=harness({account:{...account,provider}});
    await expect(h.provider.readEmailIdentity("acc_test",transport,email)).rejects.toMatchObject({code:"UNIPILE_MAILBOX_UNVERIFIABLE"});
    expect(h.calls).toHaveLength(1);
  });
  for (const raw of [account,outlook]) it.each([
    {data:[]},{data:[...senders.data,...senders.data]},
    {data:[{...senders.data[0],is_primary:false}]},{data:[{...senders.data[0],verification_status:"pending"}]},
    {...senders,next_cursor:"more"},{...senders,total_count:2},
  ])("fails closed on ambiguous/incomplete primary address evidence %j",async(senders)=>{
    await expect(harness({account:raw,senders}).provider.readEmailIdentity("acc_test",transport,email)).rejects.toBeDefined();
  });
  it("keeps Google unknown readiness unverified",async()=>{
    await expect(harness({senders:{data:[{...senders.data[0],verification_status:"unknown"}]}}).provider.readEmailIdentity("acc_test",transport,email))
      .rejects.toMatchObject({code:"UNIPILE_MAILBOX_UNVERIFIABLE"});
  });
  it.each([
    {data:[{...senders.data[0],is_primary:false,verification_status:"unknown"}]},
    {data:[{...senders.data[0],verification_status:"unknown"},{...senders.data[0],email:"other@example.test",verification_status:"unknown"}]},
    {data:[{...senders.data[0],email:"other@example.test",verification_status:"unknown"}]},
  ])("does not use Outlook unknown readiness to relax primary identity: %j",async(senders)=>{
    await expect(harness({account:outlook,senders}).provider.readEmailIdentity("acc_test",transport,email)).rejects.toBeDefined();
  });
  it.each([account,outlook])("rejects an alias even when a provider profile contains it: $provider",async(raw)=>{
    await expect(harness({account:raw}).provider.readEmailIdentity("acc_test",transport,"alias@example.test")).rejects.toMatchObject({code:"UNIPILE_IDENTITY_MISMATCH"});
  });
  it.each([{status:"disconnected"},{status:"errored"},{is_locked:true},{metadata:{...account.metadata,products_connection_status:{gmail:"disconnected"}}},{metadata:{...account.metadata,products_connection_status:{google_calendar:"running"}}}])("never reports unhealthy Gmail as running %j",async(change)=>{
    expect((await harness({account:{...account,...change}}).provider.readEmailIdentity("acc_test",transport,email)).healthy).toBe(false);
  });
  it.each(["partial","degraded"])("verifies Gmail independently of %s Calendar health",async(status)=>{
    const h=harness({account:{...account,status,metadata:{...account.metadata,products_connection_status:{gmail:"running",google_calendar:"errored"}}}});
    expect(await h.provider.readEmailIdentity("acc_test",transport,email)).toMatchObject({healthy:true,healthStatus:"running",email});
    expect(h.calls).toHaveLength(2);
  });
  it.each([undefined,"","User.Read,Calendars.ReadWrite","User.Read,Mail.Send","User.Read,Mail.ReadWrite","User.Read,Mail.Read,Mail.Send"])("requires Microsoft mail read/write and send permissions: %s",async(oauth_scope)=>{
    const h=harness({account:{...outlook,oauth_scope}});
    expect(await h.provider.readEmailIdentity("acc_test",transport,email)).toMatchObject({type:"OUTLOOK",healthy:false,healthStatus:"unknown"});
    expect(h.calls).toHaveLength(1);
  });
  it("accepts Microsoft Graph-qualified granted permissions",async()=>{
    expect(await harness({account:{...outlook,oauth_scope:"https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send"}}).provider.readEmailIdentity("acc_test",transport,email)).toMatchObject({type:"OUTLOOK",healthy:true});
  });
  it.each([{status:"partial"},{status:"degraded"},{status:"disconnected"},{is_locked:true},
    {metadata:{...outlook.metadata,products_connection_status:{outlook:"errored"}}},
    {metadata:{...outlook.metadata,products_connection_status:{}}}])("never treats uncertain or unhealthy Microsoft as ready: %j",async(change)=>{
    const h=harness({account:{...outlook,...change}});
    expect(await h.provider.readEmailIdentity("acc_test",transport,email)).toMatchObject({type:"OUTLOOK",healthy:false});
    expect(h.calls).toHaveLength(1);
  });
  it("uses an independent self profile for LinkedIn identity",async()=>{
    const h=harness({account:{...account,provider:"linkedin"}});
    const identity=await h.provider.readLinkedinIdentity("acc_test",{...transport,owner_profile_id:"owner"},"owner");
    expect(identity).toMatchObject({accountId:"legacy_account",profileId:"owner",profileUrl:"https://www.linkedin.com/in/founder/",healthy:true});
    expect(h.calls[1]?.url).toBe("https://api.unipile.com/v2/acc_test/users/me");
  });
  it.each([{id:"foreign"},{provider:"mock"},{type:"organization"},{specifics:{network_distance:"FIRST_DEGREE"}},{specifics:{}}])("rejects wrong LinkedIn owner profile %j",async(change)=>{
    await expect(harness({account:{...account,provider:"linkedin"},profile:{...profile,...change}}).provider.readLinkedinIdentity("acc_test",{...transport,owner_profile_id:"owner"},"owner")).rejects.toBeDefined();
  });
  it("produces distinct create and reconnect bodies with the snapshotted domain",async()=>{
    for(const reconnect of [false,true]){
      const h=harness();await h.provider.createLink({channel:"email",state:"opaque-state",redirectUri:"https://api.lifty.test/return",expiresAt:"2026-09-18T00:00:00.000Z",transport:{...transport,account_id:reconnect?"acc_test":null}});
      const body=JSON.parse(String(h.calls[0]?.init?.body));
      expect(body).toEqual({...(reconnect?{account_id:"acc_test"}:{providers:["google","outlook"]}),config:{outlook:{oauth_scope:["Mail.ReadWrite","Mail.Send"]}},account_scope_id:"scope_test",domain:"connect-v2.lifty.test",
        state:"opaque-state",redirect_uri:"https://api.lifty.test/return",expires_on:"2026-09-18T00:00:00.000Z"});
      expect(body).not.toHaveProperty("notify_url");
    }
  });
  it.each(["https://account.unipile.com/?token=x","https://auth.unipile.com/?token=x","http://connect-v2.lifty.test/?token=x","https://connect-v2.lifty.test:444/?token=x","https://user@connect-v2.lifty.test/?token=x","https://connect-v2.lifty.test/?token=x#fragment","https://evil.test/?token=x"])("rejects wrong hosted URL %s",async(link)=>{
    await expect(harness({link}).provider.createLink({channel:"linkedin",state:"opaque",redirectUri:"https://api.lifty.test/return",expiresAt:"2026-09-18T00:00:00.000Z",transport})).rejects.toMatchObject({code:"UNIPILE_HOSTED_URL_INVALID"});
  });
  it("never sends a founder to Unipile's default sign-in page",async()=>{
    expect(()=>createUnipileV2Provider({accessToken:"v2-test-key",applicationId:"app_test",hostedAuthOrigins:["https://connect-v2.lifty.test","https://auth.unipile.com"]})).toThrow();
    const h=harness();
    await expect(h.provider.createLink({channel:"email",state:"opaque",redirectUri:"https://api.lifty.test/return",expiresAt:"2026-09-18T00:00:00.000Z",
      transport:{...transport,hosted_auth_origin:"https://auth.unipile.com"}})).rejects.toMatchObject({code:"UNIPILE_IDENTITY_MISMATCH"});
    expect(h.calls).toHaveLength(0);
  });
  it("never retries or exposes errors containing provider secrets",async()=>{
    const h=harness({status:503});
    await expect(h.provider.createLink({channel:"email",state:"opaque",redirectUri:"https://api.lifty.test/return",expiresAt:"2026-09-18T00:00:00.000Z",transport})).rejects.toMatchObject({code:"UNIPILE_UNAVAILABLE"});
    expect(h.calls).toHaveLength(1);
  });
  it("never exposes a rejected or malformed hosted setup response",async()=>{
    for(const [body,code] of [[new Response(JSON.stringify({object:"Error",status:400,type:"api/invalid_parameters",detail:"secret token"}),{status:400}),"UNIPILE_HOSTED_REJECTED"],[new Response("{broken secret"),"UNIPILE_UNAVAILABLE"]] as const){
      const h=harness({body});
      const issue=await h.provider.createLink({channel:"linkedin",state:"opaque",redirectUri:"https://api.lifty.test/return",expiresAt:"2099-01-01T00:00:00Z",transport}).catch(error=>error);
      expect(issue).toMatchObject({code});
      expect(String(issue)+JSON.stringify(issue)).not.toContain("secret");
      expect(h.calls).toHaveLength(1);
    }
  });
});

describe("V2 bounded HTTP",()=>{
  it("aborts a response body that never completes without retry",async()=>{
    let requests=0;
    const provider=createUnipileV2Provider({accessToken:"v2-test",applicationId:"app_test",hostedAuthOrigins:[transport.hosted_auth_origin],timeoutMs:20,
      fetchImpl:async()=>{requests++;return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode("{"));}}));}});
    await expect(provider.readEmailIdentity("acc_test",transport,email)).rejects.toMatchObject({code:"UNIPILE_UNAVAILABLE"});
    expect(requests).toBe(1);
  });
  it("caps bodies even when a server ignores content length",async()=>{
    const h=harness({body:new Response("x".repeat(1_048_577))});
    await expect(h.provider.readEmailIdentity("acc_test",transport,email)).rejects.toMatchObject({code:"UNIPILE_UNAVAILABLE"});
    expect(h.calls).toHaveLength(1);
  });
  it("rejects invalid JSON and unknown status without exposing the response",async()=>{
    const h=harness({body:new Response("secret provider diagnostic")});
    await expect(h.provider.readEmailIdentity("acc_test",transport,email)).rejects.toMatchObject({code:"UNIPILE_UNAVAILABLE"});
    await expect(harness({account:{...account,status:"new_future_state"}}).provider.readEmailIdentity("acc_test",transport,email)).rejects.toMatchObject({code:"UNIPILE_UNAVAILABLE"});
  });
});


describe("V2 LinkedIn copied owner evidence",()=>{
  const copied={...transport,user_id:"Display Name",owner_profile_id:"owner"};
  const raw={...account,user_id:"Display Name",provider:"linkedin"};
  it("keeps raw account metadata separate from the retained authenticated SELF owner",async()=>{
    const h=harness({account:raw});
    const result=await h.provider.readLinkedinIdentity("acc_test",copied,"owner");
    expect(result).toMatchObject({accountId:"legacy_account",profileId:"owner",healthy:true,
      verifiedTransport:{user_id:"Display Name",owner_profile_id:"owner",v1_account_id:"legacy_account"}});
    expect(h.calls.map(call=>call.url)).toEqual(["https://api.unipile.com/v2/accounts/acc_test","https://api.unipile.com/v2/acc_test/users/me"]);
  });
  it.each([
    {binding:{owner_profile_id:"foreign"},expected:"owner",response:profile},
    {binding:{},expected:"foreign",response:profile},
    {binding:{owner_profile_id:null},expected:"owner",response:profile},
    {binding:{},expected:"owner",response:{...profile,id:"foreign"}},
    {binding:{},expected:"owner",response:{...profile,specifics:{network_distance:"FIRST_DEGREE"}}},
  ])("rejects mismatched or absent owner evidence %j",async({binding,expected,response})=>{
    await expect(harness({account:raw,profile:response}).provider.readLinkedinIdentity("acc_test",{...copied,...binding},expected)).rejects.toBeDefined();
  });
  it("establishes a new V2-only owner solely from authenticated SELF",async()=>{
    const h=harness({account:{...raw,metadata:{}}});
    const result=await h.provider.readLinkedinIdentity("acc_test",{...copied,canonical_account_id:null,connection_ref:null,
      account_id:null,provider_namespace:"unipile:v2:app_test",v1_account_id:null,user_id:null,owner_profile_id:null});
    expect(result).toMatchObject({accountId:"acc_test",profileId:"owner",verifiedTransport:{user_id:"Display Name",owner_profile_id:"owner",v1_account_id:null}});
  });
  it("reports an established disconnected owner without pretending a fresh SELF proof",async()=>{
    const h=harness({account:{...raw,status:"disconnected"}});
    expect(await h.provider.readLinkedinIdentity("acc_test",copied,"owner")).toMatchObject({profileId:"owner",healthy:false,
      healthStatus:"disconnected",verifiedTransport:{user_id:"Display Name",owner_profile_id:null}});
    expect(h.calls).toHaveLength(1);
  });
  it("does not invent an owner for a disconnected new connection",async()=>{
    const h=harness({account:{...raw,status:"disconnected",metadata:{}}});
    await expect(h.provider.readLinkedinIdentity("acc_test",{...copied,canonical_account_id:null,account_id:null,
      provider_namespace:"unipile:v2:app_test",v1_account_id:null,user_id:null,owner_profile_id:null})).rejects.toBeDefined();
    expect(h.calls).toHaveLength(1);
  });
  it("accepts historical V1 and Google transport snapshots without the additive owner field",()=>{
    const {owner_profile_id:_,...old}=transport;
    expect(UnipileTransport.parse(old).owner_profile_id).toBeNull();
    expect(UnipileTransport.parse({...old,api_version:"v1"}).owner_profile_id).toBeNull();
  });
});


describe("LinkedIn raw account metadata drift",()=>{
  const retained={...transport,user_id:"Old Display Name",owner_profile_id:"owner"};
  const changed={...account,provider:"linkedin",user_id:"Updated Display Name"};
  it.each(["running","disconnected"])("accepts changed raw metadata with exact SELF owner while %s",async(status)=>{
    const h=harness({account:{...changed,status}});
    const result=await h.provider.readLinkedinIdentity("acc_test",retained,"owner");
    expect(result).toMatchObject({profileId:"owner",healthy:status==="running",verifiedTransport:{user_id:"Updated Display Name",owner_profile_id:"owner"}});
    expect(h.calls[1]?.url).toBe("https://api.unipile.com/v2/acc_test/users/me");
    expect(retained.user_id).toBe("Old Display Name");
  });
  for(const status of ["running","disconnected"])it.each([{...profile,id:"foreign"},{}, {...profile,specifics:{}}])(`denies changed raw metadata without exact SELF while ${status}: %j`,async(response)=>{
    await expect(harness({account:{...changed,status},profile:response}).provider.readLinkedinIdentity("acc_test",retained,"owner")).rejects.toBeDefined();
  });
  it.each([{application_id:"other"},{account_scope_id:"other"},{metadata:{v1_account_id:"other"}}])("keeps immutable account bindings strict %j",async(change)=>{
    const h=harness({account:{...changed,...change}});
    await expect(h.provider.readLinkedinIdentity("acc_test",retained,"owner")).rejects.toBeDefined();
    expect(h.calls).toHaveLength(1);
  });
});
