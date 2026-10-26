import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createProductionApp } from "../src/service.js";
import { createAccountConnection } from "../src/account-connection.js";
import { sealConnectAttempt } from "../src/connect-state.js";

// LIF-1182 sending-account connections through the production app: Lifty's
// connect page, the shared confirmation shell and access removal. Only the
// trusted database RPC and the provider HTTP API are replaced.
const emailKey = "e".repeat(40), linkedinKey = "l".repeat(40);
const env = {
  SUPABASE_URL: "https://project.supabase.co", SUPABASE_PUBLISHABLE_KEY: "sb_public",
  SUPABASE_JWKS_URL: "https://project.supabase.co/auth/v1/.well-known/jwks.json",
  HUBSPOT_CLIENT_ID: "client", HUBSPOT_CLIENT_SECRET: "secret", PUBLIC_BASE_URL: "https://api.lifty.test", TRIGGER_SECRET_KEY: "trigger", NOTIFICATIONS_TRIGGER_SECRET_KEY: "notifications-trigger",
  LIFTY_EMAIL_SERVER_KEY: emailKey, LIFTY_LINKEDIN_SERVER_KEY: linkedinKey,
  UNIPILE_V2_ACCESS_TOKEN: "v2-secret", UNIPILE_V2_APPLICATION_ID: "app_test", UNIPILE_V2_HOSTED_AUTH_ORIGINS: "https://connect.lifty.test",
};
const attemptId = "11111111-1111-4111-8111-111111111111";
const hostedLink = "https://connect.lifty.test/session-1";
const transport = { api_version: "v2", application_id: "app_test", account_scope_id: null, provider_namespace: "unipile:v2:app_test",
  hosted_auth_origin: "https://connect.lifty.test", account_id: null as string | null, generation: 0 };

type Db = ReturnType<typeof attemptDb>;
function attemptDb(channel: "email" | "linkedin" = "email") {
  return {
    channel, internal_state: "pending" as "pending" | "ready" | "completed" | "failed", state: "pending",
    reason: null as string | null, declaration: null as Record<string, unknown> | null, hosted_url: null as string | null,
    expected_identity: null as Record<string, string> | null, transport: { ...transport },
    authorization: { received: false, account_id: null as string | null, return_error: null as string | null },
    ops: [] as string[], payloads: {} as Record<string, Record<string, unknown>>,
    // The conflict read's answer (undefined: the read is unavailable) and the revocation context.
    conflict: undefined as Record<string, unknown> | undefined, revocation: null as Record<string, unknown> | null,
  };
}
function progress(db: Db) {
  if (db.internal_state === "completed") return { stage: "complete" };
  if (db.authorization.received) return { stage: "verifying" };
  if (!db.declaration) return { stage: "declaration_required" };
  if (db.hosted_url) return { stage: "sign_in_required" };
  return { stage: "preparing" };
}
const snapshot = (db: Db, extra: Record<string, unknown> = {}) => ({
  attempt: { id: attemptId, workspace: { workspace_ref: "22222222-2222-4222-8222-222222222222", name: "Example", state: "ready_for_connections" },
    sender: { id: "33333333-3333-4333-8333-333333333333", name: "Ana <Pérez>" }, channel: db.channel, reconnect: db.expected_identity !== null,
    account_id: null, expected_identity: db.expected_identity, internal_state: db.internal_state, state: db.state, reason: db.reason,
    declaration: db.declaration, declaration_required: true, issuer_user_id: "44444444-4444-4444-8444-444444444444",
    created_at: "2026-10-02T12:00:00Z", expires_at: "2099-01-01T00:00:00Z", hosted_url: db.hosted_url, progress: progress(db) },
  transport: db.transport,
  authorization: { ...db.authorization, event_id: null, at: null }, ...extra });

interface Provider { mailboxProvider: "google" | "outlook"; verificationStatus: "verified" | "pending" | "unknown"; senders: string; accountStatus: number; deleteStatus: number; calls: string[]; bodies: Record<string, unknown>[] }
function stub(db: Db, provider: Partial<Provider> = {}) {
  const p: Provider = { mailboxProvider: "google", verificationStatus: "verified", senders: "ana@example.test", accountStatus: 200, deleteStatus: 200, calls: [], bodies: [], ...provider };
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin === "https://api.unipile.com") {
      p.calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
      // Each provider call returns a distinct session, like Unipile.
      if (url.pathname === "/v2/auth/link") { p.bodies.push(JSON.parse(String(init!.body))); return Response.json({ object: "HostedAuthLink", link: `https://connect.lifty.test/session-${p.bodies.length}` }); }
      if (init?.method === "DELETE") return new Response("{}", { status: p.deleteStatus });
      if (p.accountStatus !== 200) return new Response("PRIVATE provider body", { status: p.accountStatus });
      if (url.pathname.endsWith("/email-senders")) return Response.json({ data: [{ object: "EmailSender", email: p.senders, is_primary: true, verification_status: p.verificationStatus }] });
      return Response.json({ object: "Account", id: "acc_new", application_id: "app_test", account_scope_id: null, user_id: "user-1",
        provider: p.mailboxProvider, oauth_scope: "User.Read,Mail.ReadWrite,Mail.Send", status: "running", is_locked: false, metadata: { products_connection_status: { gmail: "running" } } });
    }
    const body = JSON.parse(String(init!.body));
    if (url.toString() === "https://project.supabase.co/rest/v1/rpc/lifty_sending_account_conflict") {
      db.ops.push("conflict"); db.payloads.conflict = body;
      return db.conflict ? Response.json(db.conflict) : Response.json({ message: "unavailable" }, { status: 503 });
    }
    expect(url.toString()).toBe("https://project.supabase.co/rest/v1/rpc/lifty_sending_account_provider");
    expect(body.p_server_key).toBe(db.channel === "email" ? emailKey : linkedinKey);
    const op = body.p_operation as string, payload = body.p_payload as Record<string, unknown>;
    db.ops.push(op); db.payloads[op] = payload;
    if (op === "declare") db.declaration = payload.declaration as Record<string, unknown>;
    // Like the database, the first stored link wins.
    if (op === "link" && !db.hosted_url && !db.authorization.received) { db.internal_state = "ready"; db.hosted_url = String(payload.url); }
    // Like the database, only the first hint is kept.
    if (op === "return_error") db.authorization.return_error ??= String(payload.return_error);
    if (op === "fail") { db.internal_state = "failed"; db.state = "failed"; db.reason = String(payload.reason); }
    if (op === "complete") { db.internal_state = "completed"; db.state = "connected"; }
    if (op === "revocation_context") return Response.json(db.revocation);
    if (op === "revocation_confirmed") return Response.json({ account: {} });
    return Response.json(snapshot(db));
  });
  vi.stubGlobal("fetch", fetchImpl);
  return { fetchImpl, provider: p };
}
const app = () => createProductionApp(loadConfig(env));
const intent = (channel: "email" | "linkedin" = "email") => sealConnectAttempt(channel, attemptId, channel === "email" ? emailKey : linkedinKey);
const form = (body: string, origin = "https://api.lifty.test") => ({ method: "POST",
  headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body });
const status = (channel: string, state: string, errorType?: string, errorDetail?: string) => ({ method: "POST",
  headers: { origin: "https://api.lifty.test", "content-type": "application/json", "x-lifty-connection": "1" },
  body: JSON.stringify({ state, ...(errorType ? { errorType } : {}), ...(errorDetail ? { errorDetail } : {}) }) });

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("Lifty connect page", () => {
  it("asks the declaration before any sign-in link, then issues exactly one link for repeated visits", async () => {
    const db = attemptDb(); const { provider } = stub(db); const server = app(); let state = intent();
    const page = await server.request(`/connect/email?intent=${encodeURIComponent(state)}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('action="/connect/email"');
    expect(html).toContain("Ana &lt;Pérez&gt;");
    // LIF-1603: the person chooses the mailbox use; neither is preselected.
    expect(html).toContain('value="habitual"'); expect(html).toContain('value="dedicated"');
    expect(html).not.toMatch(/name="mailbox_use"[^>]*checked/);
    // Company approval is the person's own click, never a default.
    expect(html).not.toMatch(/name="admin_approval"[^>]*checked/);
    expect(page.headers.get("content-security-policy")).toContain("form-action 'self' https://connect.lifty.test");
    expect(db.ops).toEqual(["context"]); expect(provider.calls).toEqual([]);

    const declared = await server.request("/connect/email", form(`intent=${encodeURIComponent(state)}&mailbox_use=dedicated&provider=google&admin_approval=google`));
    expect(declared.status).toBe(303);
    const next = new URL(declared.headers.get("location")!, "https://api.lifty.test");
    state = next.searchParams.get("intent")!;
    expect(next.searchParams.get("prepare")).toBe("1");
    expect(provider.calls).toEqual([]);
    const prepared = await server.request("/connect/email/return/process", status("email", state));
    expect(await prepared.json()).toMatchObject({ status: "pending", progress: { stage: "sign_in_required" }, reference: attemptId });
    expect(db.declaration).toEqual({ mailbox_use: "dedicated" });
    // The link is stored with the attempt's deterministic auth state.
    expect(db.ops).toEqual(["context", "declare", "context", "link"]);
    expect(provider.bodies).toEqual([expect.objectContaining({ providers: ["google"], domain: "connect.lifty.test",
      redirect_uri: `https://api.lifty.test/connect/email/return?intent=${encodeURIComponent(state)}`, state: db.payloads.link!.state })]);
    expect(db.payloads.link).toEqual({ attempt_id: attemptId, state: db.payloads.link!.state, url: hostedLink });

    for (let visit = 0; visit < 2; visit++) {
      const again = await server.request(`/connect/email?intent=${encodeURIComponent(state)}`);
      expect(again.headers.get("location")).toBe(hostedLink);
    }
    expect(provider.calls).toEqual(["POST /v2/auth/link"]);
  });

  it.each(["google", "outlook"] as const)("keeps the chosen %s provider through refresh and reuses the first link", async selected => {
    const db = attemptDb(); const { provider } = stub(db); const server = app();
    const response = await server.request("/connect/email", form(new URLSearchParams({ intent: intent(), mailbox_use: "habitual", provider: selected, admin_approval: selected }).toString()));
    expect(response.status).toBe(303);
    const next = new URL(response.headers.get("location")!, "https://api.lifty.test");
    const state = next.searchParams.get("intent")!;
    expect((await server.request(next.pathname + next.search)).status).toBe(200);
    expect(provider.calls).toEqual([]);
    await server.request("/connect/email/return/process", status("email", state));
    expect(provider.bodies).toEqual([expect.objectContaining({ providers: [selected], redirect_uri: `https://api.lifty.test/connect/email/return?intent=${encodeURIComponent(state)}` })]);
    expect(db.declaration).toEqual({ mailbox_use: "habitual" });
    await server.request("/connect/email/return/process", status("email", state));
    expect((await server.request(`/connect/email?intent=${encodeURIComponent(state)}`)).headers.get("location")).toBe(hostedLink);
    expect(provider.calls).toEqual(["POST /v2/auth/link"]);
    // Even another browser's selected provider cannot replace the stored link.
    const second = await server.request("/connect/email", form(new URLSearchParams({ intent: intent(), mailbox_use: "habitual", provider: selected === "google" ? "outlook" : "google", admin_approval: selected === "google" ? "outlook" : "google" }).toString()));
    expect(second.headers.get("location")).toBe(hostedLink);
    expect(provider.calls).toHaveLength(1);
    // The new browser token is still channel/key bound and tamper evident.
    const tampered = state.replace(/^v2/, "v1");
    const before = db.ops.length;
    expect((await server.request(`/connect/email?intent=${encodeURIComponent(tampered)}`)).status).toBe(400);
    expect((await server.request(`/connect/linkedin?intent=${encodeURIComponent(state)}`)).status).toBe(400);
    expect(db.ops).toHaveLength(before);
  });

  it.each(["provider=imap", "provider=google&provider=outlook", "provider=google&mailbox_use=habitual"])("rejects invalid or ambiguous email choices before work: %s", async fields => {
    const db = attemptDb(); const { provider } = stub(db);
    expect((await app().request("/connect/email", form(`intent=${encodeURIComponent(intent())}&mailbox_use=dedicated&admin_approval=google&${fields}`))).status).toBe(400);
    expect(db.ops).toEqual([]); expect(provider.calls).toEqual([]);
  });

  it.each(["", "&admin_approval=outlook", "&admin_approval=google&admin_approval=google"])("requires one acknowledgement for the selected provider before any work: %s", async acknowledgement => {
    const db = attemptDb(); const { provider } = stub(db);
    const response = await app().request("/connect/email", form(`intent=${encodeURIComponent(intent())}&mailbox_use=habitual&provider=google${acknowledgement}`));
    expect(response.status).toBe(400);
    expect(db.ops).toEqual([]); expect(provider.calls).toEqual([]);
  });

  it("requires both LinkedIn confirmations and reconnects the pinned provider account", async () => {
    const db = attemptDb("linkedin"); db.transport.account_id = "acc_pinned"; db.expected_identity = { profile_id: "ACoAA" };
    const { provider } = stub(db); const server = app(); const state = encodeURIComponent(intent("linkedin"));
    expect((await server.request("/connect/linkedin", form(`intent=${state}&habitual_personal_account=yes`))).status).toBe(400);
    expect(db.ops).toEqual([]);
    const response = await server.request("/connect/linkedin", form(`intent=${state}&habitual_personal_account=yes&no_other_automation=yes`));
    expect(response.headers.get("location")).toContain("&prepare=1");
    await server.request("/connect/linkedin/return/process", status("linkedin", decodeURIComponent(state)));
    expect(db.declaration).toEqual({ habitual_personal_account: true, no_other_automation: true });
    expect(provider.bodies[0]).toMatchObject({ account_id: "acc_pinned" });
    expect(provider.bodies[0]).not.toHaveProperty("providers");
  });

  it("rejects forged, cross-channel, malformed and cross-origin requests before any database or provider call", async () => {
    const db = attemptDb(); const { fetchImpl } = stub(db); const server = app();
    const email = intent();
    for (const path of [`/connect/linkedin?intent=${encodeURIComponent(email)}`, `/connect/email?intent=${encodeURIComponent(email.slice(0, -2) + (email.endsWith("AA") ? "BB" : "AA"))}`,
      `/connect/email?intent=${encodeURIComponent(email)}&intent=${encodeURIComponent(email)}`, `/connect/email?intent=${encodeURIComponent(email)}&next=x`]) {
      expect((await server.request(path)).status, path).toBe(400);
    }
    expect((await server.request("/connect/email", form(`intent=${encodeURIComponent(email)}&mailbox_use=habitual`, "https://evil.test"))).status).toBe(403);
    expect((await server.request("/connect/email", form(`intent=${encodeURIComponent(email)}&mailbox_use=personal&provider=google&admin_approval=google`))).status).toBe(400);
    expect((await server.request("/connect/email", form(`intent=${encodeURIComponent(email)}&mailbox_use=habitual&provider=google&admin_approval=google&email=a@b.test`))).status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["https://evil.test/session", "https://account.unipile.com/session", "http://connect.lifty.test/session", "https://connect.lifty.test:8443/session"])(
    "never redirects to a stored sign-in URL outside Lifty's hosted origins: %s", async target => {
      const db = attemptDb(); db.declaration = { mailbox_use: "habitual" }; db.internal_state = "ready"; db.hosted_url = target;
      stub(db); const response = await app().request(`/connect/email?intent=${encodeURIComponent(intent())}`);
      expect(response.status).toBe(503);
      expect(response.headers.get("location")).toBeNull();
      expect(await response.text()).not.toContain(target);
    });

  it("acknowledges an authorization already received instead of issuing another link", async () => {
    const db = attemptDb(); db.declaration = { mailbox_use: "habitual" }; db.authorization.received = true;
    const { provider } = stub(db); const state = intent();
    const response = await app().request(`/connect/email?intent=${encodeURIComponent(state)}`);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/connect/email/return?intent=${encodeURIComponent(state)}`);
    expect(db.ops).toEqual(["context"]); expect(provider.calls).toEqual([]);
  });
  // LIF-1415: a hosted link connects nothing until someone signs in through a
  // link Lifty showed, so no link failure may leave the attempt stuck.
  it.each(["provider timeout", "provider rejection", "lost save response", "failed save"])(
    "keeps the same attempt retryable after a %s and reaches sign-in on the next try", async failure => {
      const db = attemptDb(); db.declaration = { mailbox_use: "habitual" };
      const { fetchImpl, provider } = stub(db), original = fetchImpl.getMockImplementation()!;
      let failed = false;
      fetchImpl.mockImplementation(async (input, init) => {
        const link = String(input).endsWith("/auth/link"), save = String(init?.body).includes('"p_operation":"link"');
        if (!failed && link && failure.startsWith("provider")) {
          failed = true; await original(input, init);
          if (failure === "provider timeout") throw new DOMException("response lost", "TimeoutError");
          return Response.json({ object: "Error", status: 400, type: "api/invalid_parameters", detail: "PRIVATE" }, { status: 400 });
        }
        if (!failed && save && failure.includes("save")) {
          failed = true;
          if (failure === "failed save") return Response.json({ message: "unavailable" }, { status: 503 });
          await original(input, init); throw new DOMException("response lost", "TimeoutError");
        }
        return original(input, init);
      });
      const logged: string[] = [];
      vi.spyOn(process.stderr, "write").mockImplementation(line => { logged.push(String(line)); return true; });
      const server = app(), state = intent();
      const first = await (await server.request("/connect/email/return/process", status("email", state))).json();
      // A refusal is not shown as a sign-in still being prepared; only its error code is logged.
      expect(first).toEqual({ status: "pending", progress: { stage: "preparing" }, reference: attemptId,
        ...(failure === "provider rejection" ? { attention: "sign_in_unavailable" } : {}) });
      if (failure === "provider rejection") expect(logged.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({
        event: "connection_confirmation", stage: "process", upstream_code: "400", provider_error: "api/invalid_parameters" }));
      expect(logged.join("")).not.toContain("PRIVATE");
      const next = await (await server.request("/connect/email/return/status", status("email", state))).json();
      expect(next).toMatchObject({ status: "pending", progress: { stage: "sign_in_required" }, reference: attemptId });
      // A save that landed is found by the next read without asking the provider again.
      expect(provider.calls).toHaveLength(failure === "lost save response" ? 1 : 2);
      // Both links carry the same auth state; the stored one opens.
      expect(new Set(provider.bodies.map(body => body.state)).size).toBe(1);
      const open = await server.request(`/connect/email?intent=${encodeURIComponent(state)}`);
      expect(open.headers.get("location")).toBe(db.hosted_url);
      expect(db.ops).not.toContain("fail"); expect(db.state).toBe("pending");
    });

  it("renders the shell while the provider is stalled and keeps the first stored link for concurrent tabs", async () => {
    const db = attemptDb(); db.declaration = { mailbox_use: "habitual" };
    const { fetchImpl, provider } = stub(db), original = fetchImpl.getMockImplementation()!;
    let release!: () => void, started!: () => void, stalled = true;
    const held = new Promise<void>(resolve => { release = resolve; });
    const dispatched = new Promise<void>(resolve => { started = resolve; });
    fetchImpl.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/auth/link") && stalled) { stalled = false; started(); await held; }
      return original(input, init);
    });
    const server = app(), state = intent();
    const first = server.request("/connect/email/return/process", status("email", state));
    await dispatched;
    const shell = await server.request(`/connect/email/return?intent=${encodeURIComponent(state)}&prepare=1`);
    expect(shell.status).toBe(200); expect(await shell.text()).toContain("Preparing sign-in");
    const second = await server.request("/connect/email/return/process", status("email", state));
    expect(await second.json()).toMatchObject({ status: "pending", progress: { stage: "sign_in_required" } });
    const stored = db.hosted_url;
    release();
    expect(await (await first).json()).toMatchObject({ status: "pending", progress: { stage: "sign_in_required" } });
    expect(provider.calls).toHaveLength(2);
    expect(db.hosted_url).toBe(stored);
    expect((await server.request(`/connect/email?intent=${encodeURIComponent(state)}`)).headers.get("location")).toBe(stored);
  });

  it("bounds a stalled provider call and lets the next check ask again", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; });
    const db = attemptDb(); db.declaration = { mailbox_use: "habitual" };
    const { fetchImpl } = stub(db), original = fetchImpl.getMockImplementation()!;
    let calls = 0;
    fetchImpl.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/auth/link") && ++calls === 1) {
        return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("PRIVATE stalled provider")), { once: true }));
      }
      return original(input, init);
    });
    const server = app(), state = intent();
    const work = server.request("/connect/email/return/process", status("email", state));
    await vi.advanceTimersByTimeAsync(15_000);
    const stalled = await (await work).json();
    expect(stalled).toMatchObject({ status: "pending", progress: { stage: "preparing" } });
    expect(JSON.stringify(stalled)).not.toContain("PRIVATE");
    const retried = await server.request("/connect/email/return/status", status("email", state));
    expect(await retried.json()).toMatchObject({ status: "pending", progress: { stage: "sign_in_required" } });
    expect(calls).toBe(2);
  });

});

describe("shared confirmation for sending accounts", () => {
  it.each(["google", "outlook"] as const)("treats a browser error as a hint and completes only a signed authorization with verified identity: %s", async (mailboxProvider) => {
    const db = attemptDb(); db.declaration = { mailbox_use: "habitual" }; db.internal_state = "ready"; db.hosted_url = hostedLink;
    const { provider } = stub(db, { mailboxProvider, verificationStatus: mailboxProvider === "outlook" ? "unknown" : "verified" }); const server = app(); const state = intent();
    const shell = await server.request(`/connect/email/return?intent=${encodeURIComponent(state)}&error_type=canceled`);
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain("Checking your connection");
    const hinted = await server.request("/connect/email/return/status", status("email", state, "canceled"));
    expect(await hinted.json()).toMatchObject({ status: "pending", attention: "canceled" });
    expect(db.ops).toEqual(["context", "return_error"]);
    expect(db.state).toBe("pending");
    // The signed authorization arrives later (another tab): it wins.
    db.authorization = { received: true, account_id: "acc_new", return_error: "authorization_cancelled" };
    const confirmed = await server.request("/connect/email/return/status", status("email", state, "canceled"));
    expect(await confirmed.json()).toEqual({ status: "connected", account: null, reference: attemptId, next: "warmup" });
    expect(db.payloads.complete).toEqual({ attempt_id: attemptId, verified: { api_version: "v2", application_id: "app_test",
      account_scope_id: null, account_id: "acc_new", user_id: "user-1", email: "ana@example.test" } });
    expect(provider.calls).toEqual(["GET /v2/accounts/acc_new", "GET /v2/acc_new/email-senders"]);
  });

  it("explains a provider refusal and releases the retained account it names, so the same attempt can be retried", async () => {
    const retained = "a0000000-0000-4000-8000-000000000009";
    const db = attemptDb(); db.declaration = { mailbox_use: "habitual" }; db.internal_state = "ready"; db.hosted_url = hostedLink;
    db.conflict = { conflict: "retained", account_id: retained };
    db.revocation = { revocable: true, transport: { ...transport, account_id: "acc_old" } };
    const { provider } = stub(db); const server = app(); const state = intent();
    const shell = await (await server.request(`/connect/email/return?intent=${encodeURIComponent(state)}&error_type=api%2Falready_exists&error_detail=acc_old`)).text();
    expect(shell).toContain('data-retry="/connect/email"');
    const refused = await server.request("/connect/email/return/status", status("email", state, "api/already_exists", "acc_old"));
    expect(await refused.json()).toMatchObject({ status: "pending", attention: "released" });
    expect(db.ops).toEqual(["context", "return_error", "conflict", "revocation_context", "revocation_confirmed"]);
    expect(db.payloads.conflict).toEqual({ p_server_key: emailKey, p_attempt_id: attemptId, p_account_id: "acc_old" });
    expect(provider.calls).toEqual(["DELETE /v2/accounts/acc_old"]);
    expect(db.payloads.revocation_confirmed).toEqual({ account_id: retained, provider_account_id: "acc_old", evidence: "deleted" });
    expect(db.state).toBe("pending");

    // Live accounts are named without a workspace; anything uncertain stays generic.
    const cases: Array<[Record<string, unknown> | undefined, string]> = [[{ conflict: "live_elsewhere" }, "in_use"],
      [{ conflict: "live_here" }, "already_connected"], [{ conflict: "released" }, "released"], [{ conflict: "kept" }, "exists"],
      [{ conflict: "none" }, "exists"], [undefined, "exists"]];
    for (const [conflict, attention] of cases) {
      db.conflict = conflict; db.ops = [];
      const response = await server.request("/connect/email/return/status", status("email", state, "api/already_exists", "acc_old"));
      expect(await response.json()).toMatchObject({ status: "pending", attention });
      expect(db.ops).toEqual(["context", "conflict"]);
    }
    db.conflict = { conflict: "retained", account_id: retained }; db.ops = [];
    const unnamed = await server.request("/connect/email/return/status", status("email", state, "api/already_exists"));
    expect(await unnamed.json()).toMatchObject({ status: "pending", attention: "exists" });
    const failed = await server.request("/connect/email/return/status", status("email", state, "api/internal_error", "acc_old"));
    expect(await failed.json()).toMatchObject({ status: "pending", attention: "provider" });
    // Neither reads the conflict: an unnamed refusal or another provider error.
    expect(db.ops).toEqual(["context", "context", "return_error"]);
    // A provider deletion Lifty cannot confirm is not reported as released.
    provider.deleteStatus = 500; provider.calls.length = 0; db.ops = [];
    const unconfirmed = await server.request("/connect/email/return/status", status("email", state, "api/already_exists", "acc_old"));
    expect(await unconfirmed.json()).toMatchObject({ status: "pending", attention: "exists" });
    expect(db.ops).toEqual(["context", "conflict", "revocation_context"]);

    // The retry returns through the same attempt; the signed authorization still wins.
    db.authorization = { received: true, account_id: "acc_new", return_error: "account_exists" }; db.ops = [];
    const confirmed = await server.request("/connect/email/return/status", status("email", state));
    expect(await confirmed.json()).toEqual({ status: "connected", account: null, reference: attemptId, next: "warmup" });
    expect(db.ops).toEqual(["context", "complete"]);
  });

  it("keeps the saved provider refusal visible after the browser hint is absent", async () => {
    const db = attemptDb(); db.declaration = { mailbox_use: "habitual" }; db.internal_state = "ready"; db.hosted_url = hostedLink;
    db.authorization.return_error = "account_exists";
    const { provider } = stub(db);
    const response = await app().request("/connect/email/return/status", status("email", intent()));
    expect(await response.json()).toMatchObject({ status: "pending", attention: "exists", reference: attemptId });
    expect(provider.calls).toEqual([]); expect(db.ops).toEqual(["context"]);
  });

  it.each(["google", "outlook"] as const)("keeps an unverified primary mailbox pending and accepts later verified evidence: %s", async (mailboxProvider) => {
    const db = attemptDb(); db.expected_identity = { email: "ana@example.test" };
    db.authorization = { received: true, account_id: "acc_new", return_error: null };
    const { provider } = stub(db, { mailboxProvider, verificationStatus: "pending" });
    const server = app();
    const pending = await server.request("/connect/email/return/status", status("email", intent()));
    expect(await pending.json()).toMatchObject({ status: "pending" });
    expect(db.ops).not.toContain("fail");
    expect(db.ops).not.toContain("complete");
    provider.verificationStatus = "verified";
    const confirmed = await server.request("/connect/email/return/status", status("email", intent()));
    // A reconnected mailbox keeps its warmup, so the page asks for no warmup sign-in.
    expect(await confirmed.json()).toEqual({ status: "connected", account: null, reference: attemptId });
    expect(db.ops.filter(op => op === "complete")).toHaveLength(1);
  });

  it.each(["google", "outlook"] as const)("fails a reconnect authorized by another mailbox and keeps provider outages pending: %s", async (mailboxProvider) => {
    const mismatch = attemptDb(); mismatch.expected_identity = { email: "ana@example.test" };
    mismatch.authorization = { received: true, account_id: "acc_new", return_error: null };
    stub(mismatch, { mailboxProvider, senders: "someone-else@example.test" });
    const failed = await app().request("/connect/email/return/status", status("email", intent()));
    expect(await failed.json()).toEqual({ status: "failed", reason: "verification", reference: attemptId });
    expect(mismatch.payloads.fail).toEqual({ attempt_id: attemptId, reason: "identity_mismatch" });
    expect(mismatch.ops).not.toContain("complete");

    const outage = attemptDb(); outage.authorization = { received: true, account_id: "acc_new", return_error: null };
    stub(outage, { mailboxProvider, accountStatus: 503 });
    const pending = await app().request("/connect/email/return/status", status("email", intent()));
    expect(pending.status).toBe(202);
    expect(await pending.json()).toMatchObject({ status: "pending" });
    expect(outage.ops).toEqual(["context"]);
  });
});

describe("access removal", () => {
  const settings = (fetchImpl: typeof fetch) => createAccountConnection({ publicBaseUrl: "https://api.lifty.test", supabaseUrl: "https://project.supabase.co",
    publishableKey: "sb_public", serverKeys: { email: emailKey, linkedin: linkedinKey }, fetchImpl,
    provider: { v2: { accessToken: "v2-secret", applicationId: "app_test", hostedAuthOrigins: ["https://connect.lifty.test"] },
      v1: { dsn: "https://api1.unipile.com:13111", accessToken: "v1-secret" }, fetchImpl } });
  const blocked = (id: string, channel = "email") => ({ id, sender_id: "33333333-3333-4333-8333-333333333333", channel, identity: null,
    status: "disconnected", state: "paused", checked_at: null, observation: { state: "verified" }, connected_at: null,
    disconnected_at: "2026-10-02T12:00:00Z", access_revoked_at: null, declaration: null, sends: { today: 0, last_7_days: 0 } }) as const;

  it("confirms only with provider evidence, skips unsupported providers and stops at the shared deadline", async () => {
    const confirmed: unknown[] = [], provider: string[] = [];
    const contexts: Record<string, unknown> = {
      "a0000000-0000-4000-8000-000000000001": { revocable: true, transport: { ...transport, account_id: "acc_gone" } },
      "a0000000-0000-4000-8000-000000000002": { revocable: false, reason: "unsupported_provider", transport: null },
      "a0000000-0000-4000-8000-000000000003": { revocable: true, transport: { ...transport, api_version: "v1", account_id: "v1_account" } },
    };
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname.endsWith("unipile.com")) {
        provider.push(`${init?.method} ${url.origin}${url.pathname}`);
        return new Response("{}", { status: url.pathname.includes("acc_gone") ? 404 : 200 });
      }
      const body = JSON.parse(String(init!.body));
      if (body.p_operation === "revocation_context") return Response.json(contexts[body.p_payload.account_id]);
      confirmed.push(body.p_payload);
      // The shared budget ends after the first confirmation.
      controller.abort();
      return Response.json({ account: {} });
    }) as typeof fetch;
    await settings(fetchImpl).revoke(["a0000000-0000-4000-8000-000000000001", "a0000000-0000-4000-8000-000000000002", "a0000000-0000-4000-8000-000000000003"]
      .map(id => blocked(id)) as never, controller.signal);
    expect(provider).toEqual(["DELETE https://api.unipile.com/v2/accounts/acc_gone"]);
    expect(confirmed).toEqual([{ account_id: "a0000000-0000-4000-8000-000000000001", provider_account_id: "acc_gone", evidence: "not_found" }]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    provider.length = 0; confirmed.length = 0;
    await settings(fetchImpl).revoke([blocked("a0000000-0000-4000-8000-000000000003")] as never, new AbortController().signal);
    expect(provider).toEqual(["DELETE https://api1.unipile.com:13111/api/v1/accounts/v1_account"]);
    expect(confirmed).toEqual([{ account_id: "a0000000-0000-4000-8000-000000000003", provider_account_id: "v1_account", evidence: "deleted" }]);

    const none = vi.fn() as unknown as typeof fetch;
    await settings(none).revoke([blocked("a0000000-0000-4000-8000-000000000001")] as never, AbortSignal.abort());
    expect(none).not.toHaveBeenCalled();
  });

  it("never confirms when the provider refuses or the deadline expires mid-request", async () => {
    const operations: string[] = [];
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname.endsWith("unipile.com")) {
        controller.abort();
        return new Promise<Response>((_resolve, reject) => init!.signal!.aborted ? reject(new Error("aborted"))
          : init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      }
      const body = JSON.parse(String(init!.body)); operations.push(body.p_operation);
      return Response.json({ revocable: true, transport: { ...transport, account_id: "acc_slow" } });
    }) as typeof fetch;
    await settings(fetchImpl).revoke([blocked("a0000000-0000-4000-8000-000000000001"), blocked("a0000000-0000-4000-8000-000000000002")] as never, controller.signal);
    expect(operations).toEqual(["revocation_context"]);
  });
});
