import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { createDeploymentApp } from "../src/service.js";
import { renderCliAuthPage } from "../src/cli-auth-page.js";
import { renderPasswordRecoveryPage } from "../src/password-recovery-page.js";

const options = {supabaseUrl:"https://project.supabase.test",publishableKey:"sb_publishable_fixture",publicBaseUrl:"https://api.lifty.test",scriptNonce:"test-script-nonce-value"};
const token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.signature";
const fragment = `#type=recovery&access_token=${token}&refresh_token=PRIVATE_REFRESH&expires_in=3600&token_type=bearer`;
const user = {id:"11111111-1111-4111-8111-111111111111"};
const reply = (status = 200, payload: unknown = {}) => ({ok:status >= 200 && status < 300,status,json:async()=>payload});
const tick = () => new Promise<void>(resolve=>setImmediate(resolve));
type Handler = (event: {preventDefault():void}) => unknown;
class Element {
  value = ""; textContent = ""; hidden = false; disabled = false; className = "";
  autocomplete = ""; minLength = 0;
  readonly handlers = new Map<string,Handler>();
  addEventListener(name:string, handler:Handler) {this.handlers.set(name,handler);}
  async dispatch(name:string) {return this.handlers.get(name)?.({preventDefault(){}});}
}
function browser(html:string, url:string, fetcher = vi.fn(async (_url:string,_init:RequestInit)=>reply())) {
  const elements = new Map<string,Element>();
  for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    const element = new Element(); element.hidden = /\shidden(?:\s|>)/.test(match[0]);
    element.disabled = /\sdisabled(?:\s|>)/.test(match[0]); elements.set(match[1]!,element);
  }
  const location = Object.assign(new URL(url), { assign: vi.fn((value: string) => { location.href = value; }) });
  const clock = {now:Date.now()};
  const timers = new Map<number,()=>void>(); let timerId=0;
  const handlers = new Map<string,()=>void>();
  const get = (id:string) => {const value=elements.get(id);if(!value)throw new Error(`Missing test element ${id}`);return value;};
  const history = {replaceState:vi.fn((_state:unknown,_title:string,path:string)=>{location.href=new URL(path,location).href;})};
  const context = vm.createContext({document:{getElementById:get},window:{location,addEventListener:(event:string,handler:()=>void)=>handlers.set(event,handler)},history,
    URL,URLSearchParams,Date:{now:()=>clock.now},AbortController,fetch:fetcher,
    setTimeout:(fn:()=>void)=>{timers.set(++timerId,fn);return timerId;},clearTimeout:(id:number)=>timers.delete(id),
    // Any storage, logging or implicit navigation is an immediate test failure.
    localStorage:{setItem(){throw Error("persistent storage");}},sessionStorage:{setItem(){throw Error("persistent storage");}},
    console:{log(){throw Error("private log");},error(){throw Error("private log");}},
  });
  const script=html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
  if(!script)throw Error("Missing browser script");
  vm.runInContext(script,context);
  return {get,fetcher,location,history,timers,handlers,context,clock};
}
function recovery(page:"request"|"update", tail=fragment, fetcher?:ReturnType<typeof vi.fn<(url:string,init:RequestInit)=>Promise<ReturnType<typeof reply>>>>) {
  return browser(renderPasswordRecoveryPage({...options,page}),options.publicBaseUrl+`/auth/password-${page === "request" ? "reset" : "update"}`+tail,fetcher);
}
function login(fetcher?:ReturnType<typeof vi.fn<(url:string,init:RequestInit)=>Promise<ReturnType<typeof reply>>>>) {
  return browser(renderCliAuthPage({...options,state:"s".repeat(43),port:49152}),options.publicBaseUrl+"/cli/auth",fetcher);
}

describe("shared OAuth login and consent", () => {
  const authorizationId = "11111111-1111-4111-8111-111111111111";
  const details = { authorization_id: authorizationId, client: { name: "Founder app <script>" },
    redirect_uri: "https://chat.example.test/connector-specific/callback", scope: "openid email profile" };
  const oauthLogin = (fetcher: ReturnType<typeof vi.fn<(url:string,init:RequestInit)=>Promise<ReturnType<typeof reply>>>>) =>
    browser(renderCliAuthPage({ ...options, authorizationId }), options.publicBaseUrl + "/oauth/consent?authorization_id=" + authorizationId, fetcher);
  const signIn = async (b: ReturnType<typeof browser>) => {
    b.get("email").value = "founder@example.test"; b.get("password").value = "password";
    await b.get("auth-form").dispatch("submit");
  };
  it("serves the production consent surface with Auth-only CSP and a validated authorization ID", async () => {
    const app = createDeploymentApp({ SUPABASE_URL: options.supabaseUrl, SUPABASE_PUBLISHABLE_KEY: options.publishableKey,
      SUPABASE_JWKS_URL: options.supabaseUrl + "/auth/v1/.well-known/jwks.json", PUBLIC_BASE_URL: options.publicBaseUrl,
      HUBSPOT_CLIENT_ID: "client", HUBSPOT_CLIENT_SECRET: "secret", TRIGGER_SECRET_KEY: "fixture", NOTIFICATIONS_TRIGGER_SECRET_KEY: "notifications-fixture", LIFTY_MCP_ENABLED: "true" });
    const response = await app.request("/oauth/consent?authorization_id=" + authorizationId + "&returnTo=https://evil.test&port=4444");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("connect-src " + options.supabaseUrl);
    expect(response.headers.get("content-security-policy")).not.toContain("127.0.0.1");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await response.text();
    // The CLI's token callback (and an injected port) never reaches the OAuth
    // page; its loopback allowlist for native MCP clients is expected (LIF-1347).
    expect(html).not.toContain("evil.test"); expect(html).not.toContain("http://127.0.0.1:"); expect(html).not.toContain("4444");
    expect(html).toContain(authorizationId);
    expect((await app.request("/oauth/consent?authorization_id=invalid")).status).toBe(400);
    expect((await createApp().request("/oauth/consent?authorization_id=" + authorizationId)).status).toBe(404);
  });
  it.each(["approve", "deny"])("uses the Auth %s decision and returns only the authorization response to the registered app", async action => {
    const returnUrl = details.redirect_uri + (action === "approve" ? "?code=authorization-code&state=state" : "?error=access_denied&state=state");
    const fetcher = vi.fn(async (_url: string, _init: RequestInit) => reply())
      .mockResolvedValueOnce(reply(200, { access_token: "PRIVATE_ACCESS", refresh_token: "PRIVATE_REFRESH", expires_in: 3600 }))
      .mockResolvedValueOnce(reply(200, details))
      .mockResolvedValueOnce(reply(200, { redirect_url: returnUrl }));
    const b = oauthLogin(fetcher);
    await signIn(b);
    expect(b.get("password").value).toBe("");
    expect(b.get("client-name").textContent).toBe(details.client.name);
    expect(b.get("client-scopes").textContent).toBe(details.scope);
    expect(b.get("client-redirect").textContent).toBe(details.redirect_uri);
    expect(fetcher.mock.calls[1]?.[0]).toBe(options.supabaseUrl + "/auth/v1/oauth/authorizations/" + authorizationId);
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: "GET", headers: { Authorization: "Bearer PRIVATE_ACCESS" } });
    expect(b.location.assign).not.toHaveBeenCalled();
    await b.get(action).dispatch("click");
    expect(fetcher.mock.calls[2]?.[0]).toBe(options.supabaseUrl + "/auth/v1/oauth/authorizations/" + authorizationId + "/consent");
    expect(fetcher.mock.calls[2]?.[1].body).toBe(JSON.stringify({ action }));
    expect(b.location.href).toBe(returnUrl);
    expect(b.location.href).not.toContain("PRIVATE_");
    expect(b.location.href).not.toContain("127.0.0.1");
    await b.get(action).dispatch("click");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("returns local MCP clients to their loopback redirect and nothing else over http (LIF-1347)", async () => {
    for (const [redirect, allowed] of [["http://127.0.0.1:53682/callback", true], ["http://localhost:8080/cb", true], ["http://[::1]:7777/cb", true],
      ["http://chat.example.test/cb", false], ["http://localhost.evil.test/cb", false], ["http://127.0.0.1.nip.io/cb", false],
      ["http://user:pass@localhost:8080/cb", false]] as const) {
      const fetcher = vi.fn(async (_url: string, _init: RequestInit) => reply())
        .mockResolvedValueOnce(reply(200, { access_token: "PRIVATE_ACCESS", refresh_token: "PRIVATE_REFRESH", expires_in: 3600 }))
        .mockResolvedValueOnce(reply(200, { ...details, redirect_uri: redirect }))
        .mockResolvedValueOnce(reply(200, { redirect_url: redirect + "?code=authorization-code&state=state" }));
      const b = oauthLogin(fetcher); await signIn(b);
      expect(b.get("approve").disabled, redirect).toBe(!allowed);
      if (allowed) {
        await b.get("approve").dispatch("click");
        expect(b.location.assign, redirect).toHaveBeenCalledWith(redirect + "?code=authorization-code&state=state");
      } else expect(b.get("auth-error").textContent, redirect).toContain("expired");
    }
  });
  it("handles previously granted consent, expired authorizations and unsafe redirects without persisting or disclosing tokens", async () => {
    for (const payload of [ { redirect_url: details.redirect_uri + "?code=existing" }, { redirect_url: "javascript:alert(1)" }, { message: "PRIVATE_DETAIL" } ]) {
      const fetcher = vi.fn(async (_url:string,_init:RequestInit)=>reply())
        .mockResolvedValueOnce(reply(200, { access_token:"PRIVATE_ACCESS",refresh_token:"PRIVATE_REFRESH" }))
        .mockResolvedValueOnce(reply(200, payload));
      const b = oauthLogin(fetcher); await signIn(b);
      if (payload.redirect_url?.startsWith("https:")) expect(b.location.assign).toHaveBeenCalledWith(payload.redirect_url);
      else { expect(b.location.assign).not.toHaveBeenCalled(); expect(b.get("auth-error").textContent).toContain("expired"); }
      expect(b.get("auth-error").textContent).not.toContain("PRIVATE_");
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
  });
});
async function update(b:ReturnType<typeof browser>,password="new-password-fixture",confirmation=password) {
  b.get("new-password").value=password;b.get("confirm-password").value=confirmation;
  await b.get("update-form").dispatch("submit");
}

describe("password recovery public routes",()=>{
  it.each(["request","update"] as const)("serves %s with only Auth CSP and no session/workspace authority",async page=>{
    const render=vi.fn(()=>({html:renderPasswordRecoveryPage({...options,page}),scriptNonce:options.scriptNonce,connectOrigin:options.supabaseUrl}));
    const authenticate=vi.fn(async()=>({ok:false as const,reason:"invalid_session" as const}));const log=vi.fn();const app=createApp({renderPasswordRecoveryPage:render,authenticate,log});
    const pathname=page === "request" ? "/auth/password-reset" : "/auth/password-update";
    const res=await app.request(pathname+"?returnTo=https://evil.test&port=4444&state=untrusted");
    expect(res.status).toBe(200);expect(authenticate).not.toHaveBeenCalled();expect(log).not.toHaveBeenCalled();
    const html=await res.text();expect(html).not.toContain("evil.test");expect(html).not.toContain("untrusted");
    expect(res.headers.get("cache-control")).toBe("no-store");expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("set-cookie")).toBeNull();expect(res.headers.get("location")).toBeNull();
    const csp=res.headers.get("content-security-policy");expect(csp).toContain("connect-src https://project.supabase.test");
    expect(csp).toContain("form-action 'none'");expect(csp).toContain("frame-ancestors 'none'");expect(csp).not.toContain("127.0.0.1");
    expect((await app.request("/v1/workspace")).status).toBe(401);
  });
  it.each([null,{html:"bad",scriptNonce:"short",connectOrigin:options.supabaseUrl},{html:"bad",scriptNonce:options.scriptNonce,connectOrigin:"https://auth.test https://evil.test"}])("fails closed for unavailable or unsafe render config %#",async config=>{
    const res=await createApp({renderPasswordRecoveryPage:()=>config}).request("/auth/password-reset");expect(res.status).toBe(503);expect(await res.text()).not.toContain("<script");
  });
  it("production composition uses configured canonical origin and fresh nonce, never request host",async()=>{
    const app=createDeploymentApp({SUPABASE_URL:options.supabaseUrl,SUPABASE_PUBLISHABLE_KEY:options.publishableKey,
      SUPABASE_JWKS:JSON.stringify({keys:[{kty:"EC",crv:"P-256",x:"x",y:"y"}]}),HUBSPOT_CLIENT_ID:"fixture-client",HUBSPOT_CLIENT_SECRET:"fixture-secret",PUBLIC_BASE_URL:options.publicBaseUrl,TRIGGER_SECRET_KEY:"tr_fixture",NOTIFICATIONS_TRIGGER_SECRET_KEY:"tr_notifications_fixture"});
    const first=await app.request("https://evil.test/auth/password-reset");const second=await app.request("/auth/password-update");
    expect(first.status).toBe(200);expect(second.status).toBe(200);const html=await first.text();
    expect(html).toContain('"redirectTo":"https://api.lifty.test/auth/password-update"');expect(html).not.toContain("evil.test");
    expect(first.headers.get("content-security-policy")).not.toBe(second.headers.get("content-security-policy"));
  });
  it.each(["http://api.test","https://user:pass@api.test","https://api.test/path","https://api.test?next=evil","https://api.test#evil"])("rejects noncanonical callback base %s",publicBaseUrl=>{
    expect(()=>renderPasswordRecoveryPage({...options,publicBaseUrl,page:"request"})).toThrow("Invalid recovery origin");
  });
  it("escapes public inline config and preserves original login tab",()=>{
    const html=renderPasswordRecoveryPage({...options,page:"request",publishableKey:"</script><script>PRIVATE</script>"});
    expect(html).not.toContain("</script><script>PRIVATE");expect(html).toContain("\\u003c/script");
    const auth=renderCliAuthPage({...options,state:"s".repeat(43),port:49152});
    expect(auth).toContain('href="/auth/password-reset" target="_blank" rel="noopener noreferrer"');
  });
});

describe("recovery request browser behavior",()=>{
  it.each([{}, {id:"existing-account"}])("shows identical success without revealing Auth response %#",async payload=>{
    const fetcher=vi.fn(async()=>reply(200,payload));const b=recovery("request","?redirect_to=https://evil.test",fetcher);
    b.get("email").value="owner@example.test";await b.get("request-form").dispatch("submit");
    expect(b.get("message").textContent).toBe("If an account exists for that email, you'll receive a password recovery link. Check your inbox and spam folder.");
    expect(fetcher).toHaveBeenCalledTimes(1);const [url,init]=fetcher.mock.calls[0]! as unknown as [string,RequestInit];
    expect(url).toBe(options.supabaseUrl+"/auth/v1/recover?redirect_to=https%3A%2F%2Fapi.lifty.test%2Fauth%2Fpassword-update");
    expect(JSON.parse(init.body as string)).toEqual({email:"owner@example.test"});expect(init.redirect).toBe("error");
    expect(init.credentials).toBe("omit");expect(init.referrerPolicy).toBe("no-referrer");expect(init.cache).toBe("no-store");
    expect(b.location.search).toBe("");expect(b.timers.size).toBe(0);
  });
  it.each([[429,{error_code:"over_email_send_rate_limit"},"Too many requests"],[503,{msg:"PRIVATE_SMTP"},"temporarily unavailable"],[422,{error_code:"bad_json",msg:"PRIVATE_EMAIL"},"couldn't request"]] as const)("gives safe request failure for HTTP%s",async(status,payload,message)=>{
    const b=recovery("request","",vi.fn(async()=>reply(status,payload)));await b.get("request-form").dispatch("submit");
    expect(b.get("message").textContent).toContain(message);expect(b.get("message").textContent).not.toContain("PRIVATE");expect(b.fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not retry uncertain email requests or double-submit",async()=>{
    let reject!:(error:unknown)=>void;const b=recovery("request","",vi.fn(()=>new Promise((_resolve,r)=>{reject=r;})));
    const first=b.get("request-form").dispatch("submit");await b.get("request-form").dispatch("submit");expect(b.fetcher).toHaveBeenCalledTimes(1);
    reject(new Error("PRIVATE_NETWORK"));await first;expect(b.get("message").textContent).toContain("Check your inbox before requesting another");expect(b.timers.size).toBe(0);
  });
});

describe("recovery link and password update browser behavior",()=>{
  it("works in a fresh second browser, removes fragment before GET/user and never forwards recovery to CLI",async()=>{
    const fetcher=vi.fn(async()=>reply(200,user));const b=recovery("update",fragment,fetcher);await tick();
    expect(b.history.replaceState).toHaveBeenCalledOnce();
    expect(b.history.replaceState.mock.invocationCallOrder[0]).toBeLessThan(fetcher.mock.invocationCallOrder[0]!);expect(b.location.hash).toBe("");expect(b.location.search).toBe("");
    expect(fetcher).toHaveBeenCalledTimes(1);expect((fetcher.mock.calls as unknown as [string,RequestInit][])[0]?.[0]).toBe(options.supabaseUrl+"/auth/v1/user");
    expect(b.get("update-form").hidden).toBe(false);expect(b.get("update-submit").disabled).toBe(false);
    await update(b);expect(fetcher).toHaveBeenCalledTimes(3);
    const calls=fetcher.mock.calls as unknown as [string,RequestInit][];
    expect(calls[1]?.[1].method).toBe("PUT");expect(JSON.parse(calls[1]?.[1].body as string)).toEqual({password:"new-password-fixture"});
    expect(calls[1]?.[1].headers).toMatchObject({Authorization:`Bearer ${token}`});
    expect(calls[2]?.[0]).toBe(options.supabaseUrl+"/auth/v1/logout?scope=local");
    expect(calls.every(([url])=>url.startsWith(options.supabaseUrl+"/auth/v1/"))).toBe(true);
    expect(JSON.stringify(calls)).not.toContain("PRIVATE_REFRESH");expect(b.get("title").textContent).toBe("Password changed");
    expect(b.get("message").textContent).toBe("Your password was changed. Sign in again to continue.");expect(b.get("new-password").value).toBe("");
    await update(b);expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it.each(["","#error=access_denied&error_code=otp_expired&error_description=PRIVATE","#type=signup&access_token="+token+"&expires_in=3600",fragment+"&type=recovery",fragment+"&access_token="+token,fragment.replace("3600","0"),fragment+"&expires_at=1","?access_token=PRIVATE"+fragment,"#type=recovery&access_token=bad&expires_in=3600"])("rejects malformed, expired, reused or query-supplied capability %#",async tail=>{
    const b=recovery("update",tail);await tick();expect(b.fetcher).not.toHaveBeenCalled();expect(b.get("update-form").hidden).toBe(true);
    expect(b.get("message").textContent).toContain("invalid, expired, or already used");expect(b.get("message").textContent).not.toContain("PRIVATE");expect(b.location.hash).toBe("");expect(b.location.search).toBe("");
  });
  it.each([401,403,429,503])("keeps update unavailable when session validation fails HTTP%s",async status=>{
    const b=recovery("update",fragment,vi.fn(async()=>reply(status,{error_code:"bad_jwt",msg:"PRIVATE"})));await tick();
    expect(b.get("update-submit").disabled).toBe(true);expect(b.get("update-form").hidden).toBe(true);await update(b);expect(b.fetcher).toHaveBeenCalledTimes(1);expect(b.get("message").textContent).not.toContain("PRIVATE");
  });
  it("does not accept an invalid success body as authenticated",async()=>{
    const b=recovery("update",fragment);await tick();expect(b.get("update-submit").disabled).toBe(true);expect(b.get("message").textContent).toContain("invalid");
  });
  it("rejects mismatched or short passwords without PUT",async()=>{
    const b=recovery("update",fragment,vi.fn(async()=>reply(200,user)));await tick();
    await update(b,"short");expect(b.get("message").textContent).toContain("at least 8");
    await update(b,"new-password","different-password");expect(b.get("message").textContent).toContain("don't match");expect(b.fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(["weak_password","same_password"])("shows safe %s and permits explicit correction",async code=>{
    const fetcher=vi.fn(async()=>reply(200,user));fetcher.mockResolvedValueOnce(reply(200,user)).mockResolvedValueOnce(reply(422,{code:400,error_code:code,msg:"PRIVATE"}));
    const b=recovery("update",fragment,fetcher);await tick();await update(b);
    expect(b.get("message").textContent).toContain(code === "weak_password" ? "stronger password" : "different from");expect(b.get("update-submit").disabled).toBe(false);
    expect(b.get("message").textContent).not.toContain("PRIVATE");expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("handles ambiguous password update without automatic replay or claiming success",async()=>{
    const fetcher=vi.fn(async()=>reply(200,user));fetcher.mockResolvedValueOnce(reply(200,user)).mockRejectedValueOnce(new Error("PRIVATE_NETWORK"));
    const b=recovery("update",fragment,fetcher);await tick();await update(b);
    expect(b.get("message").textContent).toContain("couldn't confirm whether your password changed");expect(b.get("update-submit").disabled).toBe(true);
    await update(b);expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("does not erase password success when local session cleanup fails",async()=>{
    const fetcher=vi.fn(async()=>reply(200,user));fetcher.mockResolvedValueOnce(reply(200,user)).mockResolvedValueOnce(reply(200,user)).mockRejectedValueOnce(new Error("PRIVATE"));
    const b=recovery("update",fragment,fetcher);await tick();await update(b);expect(b.get("title").textContent).toBe("Password changed");expect(b.get("message").textContent).toContain("was changed");
  });
  it("stops an expired open form before password submission",async()=>{
    const b=recovery("update",fragment,vi.fn(async()=>reply(200,user)));await tick();b.clock.now+=3601000;
    await update(b);expect(b.fetcher).toHaveBeenCalledTimes(1);expect(b.get("message").textContent).toContain("expired");
  });
  it("keeps rate-limited password changes explicit without replay",async()=>{
    const fetcher=vi.fn(async()=>reply(200,user));fetcher.mockResolvedValueOnce(reply(200,user)).mockResolvedValueOnce(reply(429,{code:429,error_code:"over_request_rate_limit"}));
    const b=recovery("update",fragment,fetcher);await tick();await update(b);
    expect(b.get("message").textContent).toContain("Too many requests");expect(b.get("update-submit").disabled).toBe(false);expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("does not resurrect recovery material when validation completes after pagehide",async()=>{
    let resolve!:(value:ReturnType<typeof reply>)=>void;
    const b=recovery("update",fragment,vi.fn(()=>new Promise(r=>{resolve=r;})));
    b.handlers.get("pagehide")?.();resolve(reply(200,user));await tick();
    expect(b.get("update-submit").disabled).toBe(true);await update(b);expect(b.fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not submit a password twice while its first request is pending",async()=>{
    let resolve!:(value:ReturnType<typeof reply>)=>void;
    const fetcher=vi.fn(async()=>reply(200,user));fetcher.mockResolvedValueOnce(reply(200,user)).mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
    const b=recovery("update",fragment,fetcher);await tick();const first=update(b);await update(b);
    expect(fetcher).toHaveBeenCalledTimes(2);resolve(reply(200,user));await first;expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("drops recovery material when leaving the page",async()=>{
    const b=recovery("update",fragment,vi.fn(async()=>reply(200,user)));await tick();b.handlers.get("pagehide")?.();await update(b);expect(b.fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("login browser errors and normal CLI handoff",()=>{
  it("treats an interrupted CLI callback as uncertain without replaying it",async()=>{
    const fetcher=vi.fn(async()=>reply(200,{access_token:"NORMAL_ACCESS",refresh_token:"NORMAL_REFRESH",expires_in:3600}));
    fetcher.mockResolvedValueOnce(reply(200,{access_token:"NORMAL_ACCESS",refresh_token:"NORMAL_REFRESH",expires_in:3600})).mockRejectedValueOnce(new Error("PRIVATE_NETWORK"));
    const b=login(fetcher);b.get("email").value="owner@example.test";
    await b.get("auth-form").dispatch("submit");
    await b.get("approve").dispatch("click");
    expect(b.get("approve-status").textContent).toContain("couldn't confirm");
    expect(b.get("approve-status").textContent).toContain("lifty whoami");
    expect(b.get("approve-status").textContent).not.toContain("PRIVATE_NETWORK");
    expect(b.get("approve").disabled).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([{code:400,error_code:"invalid_credentials",msg:"Invalid login credentials"},{code:"invalid_credentials",message:"PRIVATE"},{code:400,msg:"Invalid login credentials"}])("recognizes legacy numeric and modern semantic errors %#",async payload=>{
    const b=login(vi.fn(async()=>reply(400,payload)));await b.get("auth-form").dispatch("submit");
    expect(b.get("auth-error").textContent).toBe("The email or password is incorrect.");expect(b.get("approve-card").hidden).toBe(true);
  });
  it.each([429,503])("distinguishes rate/service HTTP%s without raw details",async status=>{
    const b=login(vi.fn(async()=>reply(status,{code:status,msg:"PRIVATE"})));await b.get("auth-form").dispatch("submit");
    expect(b.get("auth-error").textContent).toContain(status===429?"Too many requests":"temporarily unavailable");expect(b.get("auth-error").textContent).not.toContain("PRIVATE");
  });
  it("distinguishes network failure and clears password input",async()=>{
    const b=login(vi.fn(async()=>{throw Error("PRIVATE_NETWORK");}));b.get("password").value="private-fixture";await b.get("auth-form").dispatch("submit");
    expect(b.get("auth-error").textContent).toContain("Check your connection");expect(b.get("password").value).toBe("");expect(b.fetcher).toHaveBeenCalledTimes(1);
  });
  it("bounds Auth request timeouts without retries",async()=>{
    const b=login(vi.fn((_url:string,init:RequestInit)=>new Promise((_resolve,reject)=>{init.signal?.addEventListener("abort",()=>reject(Error("abort")));})));
    const submit=b.get("auth-form").dispatch("submit");b.timers.values().next().value?.();await submit;expect(b.get("auth-error").textContent).toContain("Check your connection");expect(b.fetcher).toHaveBeenCalledTimes(1);expect(b.timers.size).toBe(0);
  });
  it("requires fresh password sign-in and explicit approval with original fixed nonce/loopback",async()=>{
    const fetcher=vi.fn(async()=>reply(200,{access_token:"NORMAL_ACCESS",refresh_token:"NORMAL_REFRESH",expires_in:3600}));
    const b=login(fetcher);b.get("email").value="owner@example.test";b.get("password").value="new-password-fixture";
    await b.get("auth-form").dispatch("submit");expect(fetcher).toHaveBeenCalledTimes(1);expect(b.get("approve-card").hidden).toBe(false);
    await b.get("approve").dispatch("click");const calls=fetcher.mock.calls as unknown as [string,RequestInit][];
    expect(calls[0]?.[0]).toBe(options.supabaseUrl+"/auth/v1/token?grant_type=password");expect(calls[1]?.[0]).toBe("http://127.0.0.1:49152/callback");
    expect(JSON.parse(calls[1]?.[1].body as string)).toMatchObject({state:"s".repeat(43),access_token:"NORMAL_ACCESS",refresh_token:"NORMAL_REFRESH"});
  });
});
