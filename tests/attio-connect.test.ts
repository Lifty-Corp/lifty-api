import { describe, expect, it, vi } from "vitest";
import type { AuthSession } from "../src/app.js";
import { AttioCallbackError, createAttioConnectOperations } from "../src/attio-connect.js";
import { ATTIO_REQUIRED_SCOPES, buildAttioAuthorizationUrl } from "../src/attio-oauth.js";
import { openAttioConnectIntent, sealAttioConnectIntent } from "../src/attio-state.js";
import { createApp, type AppDependencies } from "../src/app.js";
import { STAGE_CLIENT_CONTRACT } from "../src/agent-context.js";
import { PublicError } from "../src/errors.js";

const SETTINGS = {
  clientId: "attio-client",
  clientSecret: "attio-client-secret",
  publicBaseUrl: "https://api.lifty.test/",
  supabaseUrl: "https://project.supabase.test",
  publishableKey: "sb_publishable_test",
};
const WORKSPACE_ID = "aaaaaaaa-1238-4000-a000-000000000001";
const TOKEN = `attio-access-${"x".repeat(40)}`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const session = (rpc: (name: string) => Promise<{ data: unknown; error: unknown }>): AuthSession => ({ userId: "founder", client: { rpc } });

function provider(overrides: { self?: Record<string, unknown>; store?: Response } = {}) {
  const calls: Array<{ url: string; body: string }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: String(init?.body ?? "") });
    if (url === "https://app.attio.com/oauth/token") return json({ access_token: TOKEN, token_type: "Bearer" });
    if (url === "https://api.attio.com/v2/self") return json({ active: true, workspace_id: WORKSPACE_ID, workspace_slug: "acme",
      workspace_name: "Acme", client_id: SETTINGS.clientId, scope: [...ATTIO_REQUIRED_SCOPES, "user_management:read"].join(" "), ...overrides.self });
    if (url.endsWith("/rpc/complete_lifty_attio_connection")) return overrides.store ?? json({ provider: "attio", status: "connected" });
    if (url.endsWith("/rpc/fail_lifty_connect_attempt")) return json({ status: "failed" });
    throw new Error(`unexpected URL ${url}`);
  }) as typeof fetch;
  return { calls, operations: createAttioConnectOperations({ ...SETTINGS, fetchImpl }) };
}

describe("Attio connection operations", () => {
  it("mints a sealed link to LIFT's Attio consent and never exposes the intent token", async () => {
    const rpc = vi.fn(async () => ({ data: { intent_token: "a".repeat(64), expires_in_seconds: 600,
      attempt_ref: "12380000-0000-4000-a000-000000000001", expires_at: "2026-10-06T00:10:00Z" }, error: null }));
    const { operations } = provider();
    const result = await operations.startConnect(session(rpc));
    expect(rpc).toHaveBeenCalledWith("create_lifty_attio_connect_intent");
    const url = new URL(result.connect_url);
    expect(url.origin + url.pathname).toBe("https://api.lifty.test/attio/start");
    expect(openAttioConnectIntent(url.searchParams.get("intent") ?? "", SETTINGS.clientSecret)).toBe("a".repeat(64));
    expect(result.connect_url).not.toContain("a".repeat(64));
    const authorize = new URL(buildAttioAuthorizationUrl({ clientId: SETTINGS.clientId, redirectUri: "https://api.lifty.test/attio/callback", state: "sealed" }));
    expect(authorize.origin + authorize.pathname).toBe("https://app.attio.com/authorize");
    expect(Object.fromEntries(authorize.searchParams)).toEqual({ response_type: "code", client_id: SETTINGS.clientId,
      redirect_uri: "https://api.lifty.test/attio/callback", state: "sealed" });
  });

  it("refuses consent while HubSpot is the workspace's CRM", async () => {
    const { operations } = provider();
    await expect(operations.startConnect(session(async () => ({ data: null,
      error: { code: "PT409", message: "lifty_crm_provider_conflict" } })))).rejects.toMatchObject({ status: 409, code: "CRM_PROVIDER_CONFLICT" });
  });

  it("verifies the token's Attio workspace before storing the plain bearer token", async () => {
    const { calls, operations } = provider();
    const state = sealAttioConnectIntent("b".repeat(64), SETTINGS.clientSecret);
    await expect(operations.completeCallback({ code: "authorization-code", state })).resolves.toEqual({ workspaceId: WORKSPACE_ID, workspaceSlug: "acme" });
    expect(calls.map(call => call.url)).toEqual([
      "https://app.attio.com/oauth/token",
      "https://api.attio.com/v2/self",
      "https://project.supabase.test/rest/v1/rpc/complete_lifty_attio_connection",
    ]);
    expect(Object.fromEntries(new URLSearchParams(calls[0]!.body))).toEqual({ grant_type: "authorization_code", code: "authorization-code",
      redirect_uri: "https://api.lifty.test/attio/callback", client_id: SETTINGS.clientId, client_secret: SETTINGS.clientSecret });
    expect(JSON.parse(calls[2]!.body)).toEqual({ p_intent_token: "b".repeat(64), p_attio_workspace_id: WORKSPACE_ID,
      p_workspace_slug: "acme", p_workspace_name: "Acme", p_scopes: [...ATTIO_REQUIRED_SCOPES, "user_management:read"].sort(), p_access_token: TOKEN });
  });

  it.each([
    [{ scope: "record_permission:read-write" }, "scope_mismatch"],
  ])("ends the attempt when Attio identifies %j", async (self, reason) => {
    const { calls, operations } = provider({ self });
    await expect(operations.completeCallback({ code: "code", state: sealAttioConnectIntent("c".repeat(64), SETTINGS.clientSecret) }))
      .rejects.toMatchObject({ reason });
    expect(calls.map(call => call.url).at(-1)).toBe("https://project.supabase.test/rest/v1/rpc/fail_lifty_connect_attempt");
    expect(calls.some(call => call.url.endsWith("complete_lifty_attio_connection"))).toBe(false);
    expect(JSON.parse(calls.at(-1)!.body)).toMatchObject({ p_provider: "attio", p_intent_token: "c".repeat(64), p_status: "failed",
      p_error_code: "permission_missing" });
  });

  // LIF-1282/LIF-1584: each known refusal records its own cause for the page and the agent.
  it.each([
    ["lifty_attio_workspace_already_connected", "workspace_taken", "account_in_use"],
    ["lifty_crm_account_mismatch", "account_mismatch", "account_mismatch"],
    ["lifty_crm_provider_conflict", "crm_provider_conflict", "crm_provider_conflict"],
  ])("records the named cause when the store refuses with %s", async (marker, reason, code) => {
    const { calls, operations } = provider({ store: json({ message: marker }, 409) });
    await expect(operations.completeCallback({ code: "code", state: sealAttioConnectIntent("f".repeat(64), SETTINGS.clientSecret) }))
      .rejects.toEqual(new AttioCallbackError(reason, 409));
    expect(JSON.parse(calls.at(-1)!.body)).toEqual({ p_provider: "attio", p_intent_token: "f".repeat(64), p_status: "failed", p_error_code: code });
  });

  it("keeps an inactive token or an uncertain store pending instead of failed", async () => {
    const inactive = provider({ self: { active: false } });
    await expect(inactive.operations.completeCallback({ code: "code", state: sealAttioConnectIntent("d".repeat(64), SETTINGS.clientSecret) }))
      .rejects.toMatchObject({ reason: "account_lookup_failed", status: 502 });
    expect(inactive.calls.some(call => call.url.endsWith("fail_lifty_connect_attempt"))).toBe(false);
    const taken = provider({ store: json({ message: "lifty_attio_workspace_already_connected" }, 409) });
    await expect(taken.operations.completeCallback({ code: "code", state: sealAttioConnectIntent("e".repeat(64), SETTINGS.clientSecret) }))
      .rejects.toEqual(new AttioCallbackError("workspace_taken", 409));
    await expect(provider().operations.completeCallback({ code: "code", state: "forged" })).rejects.toMatchObject({ reason: "link_invalid" });
  });
});

describe("Attio CRM stage routes", () => {
  const headers = { authorization: "Bearer founder", "content-type": "application/json", "x-lifty-client-contract": STAGE_CLIENT_CONTRACT };
  const workspace = { state: "ready_for_connections" as const, workspace: { workspace_ref: "12380000-0000-4000-a000-00000000000a", name: "Acme" }, next_action: null };
  const base: Partial<AppDependencies> = {
    authenticate: async () => ({ ok: true, session: { userId: "founder", client: {} } }),
    getWorkspace: async () => workspace,
    log: () => {},
  };
  const connected = { provider: "attio" as const, status: "connected" as const, attio_workspace_id: WORKSPACE_ID, workspace_slug: "acme",
    workspace_name: "Acme", granted_scopes: [...ATTIO_REQUIRED_SCOPES], connected_at: null, reconnect_required: false };

  it("starts Attio consent only when the founder chooses Attio", async () => {
    const startAttioConnect = vi.fn(async () => ({ provider: "attio" as const, connect_url: "https://api.lifty.test/attio/start?intent=x",
      expires_in_seconds: 600, attempt_ref: "12380000-0000-4000-a000-000000000001", expires_at: "2026-10-06T00:10:00Z" }));
    const startHubspotConnect = vi.fn();
    const app = createApp({ ...base, startAttioConnect, startHubspotConnect });
    const response = await app.request("/v1/workspace/crm", { method: "POST", headers, body: JSON.stringify({ provider: "attio" }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "authorization_required", connection_url: "https://api.lifty.test/attio/start?intent=x" });
    expect(startHubspotConnect).not.toHaveBeenCalled();
    expect((await app.request("/v1/workspace/crm", { method: "POST", headers, body: JSON.stringify({ provider: "salesforce" }) })).status).toBe(400);
  });

  it("reads the connected CRM and names no provider when none is connected", async () => {
    const hubspot = async () => ({ provider: "hubspot" as const, status: "not_connected" as const });
    const app = createApp({ ...base, getHubspotConnection: hubspot, getAttioConnection: async () => connected });
    expect(await (await app.request("/v1/workspace/crm", { headers })).json()).toEqual(connected);
    const none = createApp({ ...base, getHubspotConnection: hubspot, getAttioConnection: async () => ({ provider: "attio", status: "not_connected" }) });
    expect(await (await none.request("/v1/workspace/crm", { headers })).json()).toEqual({ provider: null, status: "not_connected" });
  });

  it("resolves an exact Attio attempt that the HubSpot ledger does not know", async () => {
    const ref = "12380000-0000-4000-a000-000000000002";
    const getConnectionAttempt = vi.fn(async (_session: unknown, provider: string) => {
      if (provider === "hubspot") throw new PublicError({ status: 404, code: "CONNECTION_ATTEMPT_NOT_FOUND", message: "missing" });
      return { attempt_ref: ref, status: "connected" as const, verified: true as const };
    });
    const app = createApp({ ...base, getConnectionAttempt });
    const response = await app.request(`/v1/workspace/crm?attempt_ref=${ref}`, { headers });
    expect(await response.json()).toEqual({ attempt_ref: ref, status: "connected", verified: true });
    expect(getConnectionAttempt.mock.calls.map(call => call[1])).toEqual(["hubspot", "attio"]);
  });

  it("never runs the HubSpot company setup or a HubSpot-named sync for an Attio workspace", async () => {
    const startCrmSyncRun = vi.fn();
    const app = createApp({ ...base, getAttioConnection: async () => connected, startCrmSyncRun });
    const context = await app.request("/v1/workspace/crm/mapping-context", { headers });
    expect(context.status).toBe(409);
    expect(await context.json()).toMatchObject({ error: { code: "COMPANY_SETUP_NOT_REQUIRED" } });
    const sync = await app.request("/v1/integrations/hubspot/sync", { method: "POST", headers, body: "{}" });
    expect(sync.status).toBe(409);
    expect(startCrmSyncRun).not.toHaveBeenCalled();
  });

  it("syncs through the neutral CRM route and disconnects the connected Attio", async () => {
    const run = { state: "queued" as const, run_ref: "12380000-0000-4000-a000-000000000003", requested_leads: 3, portal_id: null,
      workspace: { workspace_ref: workspace.workspace.workspace_ref, name: "Acme" }, created: true };
    const enqueueCrmSync = vi.fn(async () => ({ id: "run_trigger" }));
    const disconnectIntegration = vi.fn(async (_session: unknown, provider: string) => ({ provider: provider as "attio", status: "disconnected" as const,
      portal_id: null, disconnected_at: "2026-10-06T00:00:00Z", workspace: run.workspace, revocation_ref: null }));
    const app = createApp({ ...base, getAttioConnection: async () => connected, startCrmSyncRun: async () => run, enqueueCrmSync, disconnectIntegration });
    const sync = await app.request("/v1/workspace/crm/sync", { method: "POST", headers, body: "{}" });
    expect(await sync.json()).toEqual(run);
    expect(enqueueCrmSync).toHaveBeenCalledWith(run.run_ref);
    const disconnected = await app.request("/v1/workspace/crm/disconnect", { method: "POST", headers, body: "{}" });
    expect(disconnected.status).toBe(200);
    expect(disconnectIntegration.mock.calls[0]?.[1]).toBe("attio");
  });

  // LIF-1223: a member of several workspaces selects one with
  // x-lifty-workspace; the internal request behind a stage operation must
  // carry the same selection or the database cannot tell which workspace.
  it("keeps the selected workspace on the internal request behind a stage disconnect", async () => {
    const selections: Array<string | null> = [];
    const disconnectIntegration = vi.fn(async (_session: unknown, provider: string) => ({ provider: provider as "slack", status: "disconnected" as const,
      portal_id: null, disconnected_at: "2026-10-07T00:00:00Z", workspace: { workspace_ref: workspace.workspace.workspace_ref, name: "Acme" }, revocation_ref: null }));
    const app = createApp({ ...base, disconnectIntegration, authenticate: async (request: Request) => {
      selections.push(request.headers.get("x-lifty-workspace"));
      return { ok: true, session: { userId: "founder", client: {} } };
    } });
    const response = await app.request("/v1/workspace/notifications/disconnect",
      { method: "POST", headers: { ...headers, "x-lifty-workspace": "lifty-gtm" }, body: "{}" });
    expect(response.status).toBe(200);
    expect(disconnectIntegration.mock.calls[0]?.[1]).toBe("slack");
    expect(selections).toEqual(["lifty-gtm", "lifty-gtm"]);
  });
});
