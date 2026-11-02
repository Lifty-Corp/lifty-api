import { describe, expect, it, vi } from "vitest";

import { STAGE_CLIENT_CONTRACT } from "../src/agent-context.js";
import { createAnalytics, type AnalyticsCapture, type AnalyticsGroupIdentify, type AnalyticsReads, type AnalyticsSink } from "../src/analytics.js";
import { createApp, type AppDependencies } from "../src/app.js";
import { PublicError } from "../src/errors.js";

const workspaceRef = "12380000-0000-4000-a000-00000000000a";
const attemptRef = "12380000-0000-4000-a000-000000000007";
const headers = { authorization: "Bearer founder", "content-type": "application/json", "x-lifty-client-contract": STAGE_CLIENT_CONTRACT };
const workspace = { state: "ready_for_connections" as const, workspace: { workspace_ref: workspaceRef, name: "Acme" }, next_action: null };
const run = { state: "queued" as const, run_ref: "12380000-0000-4000-a000-000000000003", requested_leads: 3, portal_id: null,
  workspace: workspace.workspace, created: true };
const settled = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)); };

function harness(overrides: Partial<AppDependencies> = {}, options: { sink?: Partial<AnalyticsSink>; reads?: Partial<AnalyticsReads> } = {}) {
  const captures: AnalyticsCapture[] = [];
  const groups: AnalyticsGroupIdentify[] = [];
  const analytics = createAnalytics({
    sink: { capture: message => { captures.push(message); }, groupIdentify: message => { groups.push(message); }, shutdown: async () => {}, ...options.sink },
    reads: { workspace: async () => workspaceRef, facts: async () => ({ name: "Acme", slug: "acme", plan_key: "free", plan_kind: "self_serve" }), ...options.reads },
  });
  const app = createApp({
    authenticate: async () => ({ ok: true, session: { userId: "founder", client: {} } }),
    getWorkspace: async () => workspace, startCrmSyncRun: async () => run, enqueueCrmSync: async () => ({ id: "run_trigger" }),
    log: () => {}, analytics, ...overrides,
  });
  return { app, captures, groups };
}

describe("operation analytics at the /v1 boundary", () => {
  it("records a founder mutation once, with the workspace group, and a thrown error with its public code", async () => {
    const startCrmSyncRun = vi.fn<AppDependencies["startCrmSyncRun"]>().mockResolvedValueOnce(run)
      .mockRejectedValueOnce(new PublicError({ status: 409, code: "CRM_AUTOMATIC_SYNC_PAUSED", message: "Automatic sync is paused for Acme; the founder said so." }));
    const { app, captures, groups } = harness({ startCrmSyncRun, getCrmSyncStatus: async () => ({ state: "none" as const }) });
    const ok = await app.request("/v1/workspace/crm/sync", { method: "POST", headers, body: "{}" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual(run);
    const paused = await app.request("/v1/workspace/crm/sync", { method: "POST", headers, body: "{}" });
    expect(paused.status).toBe(409);
    // A status read is a poll: no event.
    expect((await app.request("/v1/workspace/crm/sync", { headers })).status).toBe(200);
    await settled();

    expect(captures.map(capture => [capture.event, capture.properties.operation, capture.properties.outcome, capture.properties.error_code])).toEqual([
      ["api_operation_completed", "crm.sync_start", "ok", undefined],
      ["crm_sync_started", "crm.sync_start", undefined, undefined],
      ["api_operation_failed", "crm.sync_start", "failed", "CRM_AUTOMATIC_SYNC_PAUSED"],
    ]);
    for (const capture of captures) {
      expect(capture.distinctId).toBe("founder");
      expect(capture.groups).toEqual({ workspace: workspaceRef });
      expect(capture.properties.surface).toBe("http");
      expect(capture.properties.request_id).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(captures[0]!.properties).toMatchObject({ http_status: 200 });
    expect(typeof captures[0]!.properties.duration_ms).toBe("number");
    expect(JSON.stringify(captures)).not.toContain("founder said so");
    expect(groups).toEqual([{ groupType: "workspace", groupKey: workspaceRef, properties: { name: "Acme", slug: "acme", plan_key: "free", plan_kind: "self_serve" } }]);
  });

  it("names the mcp surface for a tool call dispatched through the MCP fence", async () => {
    const settings = { resourceUrl: "https://api.lifty.test/mcp", authorizationServer: "https://project.supabase.test/auth/v1", allowedOrigins: ["https://api.lifty.test"] };
    const authenticate = async () => ({ ok: true as const, session: { userId: "founder", client: {} } });
    const { app, captures } = harness({ mcp: { ...settings, authenticate }, authenticate });
    const response = await app.request(new Request(settings.resourceUrl, {
      method: "POST", headers: { authorization: "Bearer founder", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "crm_sync_start", arguments: { workspace: "acme" } } }),
    }));
    expect((await response.json()).result.isError).toBe(false);
    await settled();
    expect(captures.map(capture => [capture.event, capture.properties.surface])).toEqual([["api_operation_completed", "mcp"], ["crm_sync_started", "mcp"]]);
  });

  it("counts a stage adapter that forwards into its owning route as one operation", async () => {
    const receipt = { status: "ready" as const, workspace_ref: workspaceRef, portal_id: "123", mapping_count: 5, schema_changes: 0, verified: true as const };
    const { app, captures } = harness({ companyMapping: async () => receipt, getAttioConnection: async () => ({ status: "not_connected" } as never) });
    const plan = { version: 1, workspace_ref: workspaceRef, portal_id: "123", mapping_version: "a".repeat(64), schema_version: "b".repeat(64),
      type_values: { top_target: "Top target", prospect: "Prospect" }, tier_values: { A: "A", B: "B", C: "C", "Non-ICP": "N" }, allow_schema_changes: false };
    const response = await app.request("/v1/workspace/crm", { method: "PATCH", headers, body: JSON.stringify(plan) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(receipt);
    await settled();
    expect(captures.map(capture => [capture.event, capture.properties.operation])).toEqual([["api_operation_completed", "crm.patch"]]);
  });

  it("emits crm_connected once when the attempt read reports the verified provider, without an operation event", async () => {
    const getConnectionAttempt = vi.fn(async (_session: unknown, provider: string) => {
      if (provider === "hubspot") throw new PublicError({ status: 404, code: "CONNECTION_ATTEMPT_NOT_FOUND", message: "Unknown attempt." });
      return { attempt_ref: attemptRef, status: "connected" as const, verified: true as const };
    });
    const { app, captures } = harness({ getConnectionAttempt });
    for (let i = 0; i < 2; i++) {
      const response = await app.request(`/v1/workspace/crm?attempt_ref=${attemptRef}`, { headers });
      expect(await response.json()).toEqual({ attempt_ref: attemptRef, status: "connected", verified: true });
    }
    await settled();
    expect(captures.map(capture => [capture.event, capture.properties.operation, capture.properties.provider])).toEqual([["crm_connected", "crm.get", "attio"]]);
    expect(captures[0]!.groups).toEqual({ workspace: workspaceRef });
  });

  it("never delays or changes a response when the workspace read hangs and the sink throws", async () => {
    const { app, captures } = harness({}, {
      sink: { capture: () => { throw new Error("posthog down"); } },
      reads: { workspace: () => new Promise<string | null>(() => {}) },
    });
    const startedAt = Date.now();
    const response = await app.request("/v1/workspace/crm/sync", { method: "POST", headers, body: "{}" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(run);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    await settled();
    expect(captures).toEqual([]);
  });
});
