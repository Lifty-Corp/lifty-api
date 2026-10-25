import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { STAGE_CLIENT_CONTRACT } from "../src/agent-context.js";
import { BASE_CONTEXTS, NEXT_STEP_CATALOG, ON_REQUEST_CONTEXTS } from "../src/next-step.js";
import { getCrmSyncStatus, getRunStatus } from "../src/workspace-operations.js";
import { getAttioConnection } from "../src/attio-connect.js";
import { createHubspotConnectOperations } from "../src/hubspot-connect.js";
import { criteriaFixture, draftGetFixture, laneFixture, profileFixture } from "./business-fixtures.js";
import crmSyncControls from "./crm-sync-controls-sql-fixture.json" with { type: "json" };

const confirming = "1297000a-0000-4000-a000-00000000000a";
const sampling = "1297000b-0000-4000-a000-00000000000b";
const reviewing = "1297000d-0000-4000-a000-00000000000d";
const broken = "1297000c-0000-4000-a000-00000000000c";
const listed = [confirming, sampling, reviewing, broken].map((workspace_ref, index) => ({
  workspace_ref, name: `Workspace ${index}`, slug: `workspace-${index}`, active: true,
  provisioned_by: index === 1 ? null : "lifty", created_at: "2026-10-01T00:00:00Z",
  members: [{ user_ref: "u", email: "founder@example.invalid" }], plan: { plan_key: "free", kind: index === 1 ? "managed" : "free", allowances: { weekly_research: 25 } },
}));
const identity = (ref: string) => ({ workspace_ref: ref, name: "Workspace", state: "ready_for_connections" });

// Each next_step read answers for the workspace it names, as the database does.
function rpcFor(ref: string, name: string): unknown {
  const at = profileFixture.updated_at;
  switch (name) {
    case "get_lifty_business_profile":
      return { workspace: identity(ref), profile: ref === confirming
        ? { ...profileFixture, confirmation: { complete: false, missing: ["offerings"] } } : profileFixture };
    case "get_lifty_targeting": return { workspace_ref: ref, targeting: { version: 1, updated_at: at, lanes: [laneFixture] } };
    case "get_lifty_research_criteria": return { workspace_ref: ref, criteria: criteriaFixture };
    case "get_lifty_setup_status": return { workspace_ref: ref, state: "none" };
    case "get_lifty_setup_draft": return { ...draftGetFixture, workspace_ref: ref };
    case "get_lifty_run_status": return ref === reviewing ? { state: "succeeded", run_ref: "run-1", requested_leads: 5,
      leads_discovered: 5, leads_researched: 5, error_code: null, started_at: at, completed_at: at, reviewed_at: null,
      workspace: { workspace_ref: ref, name: "Workspace" }, leads: [] } : { state: "none" };
    case "get_lifty_campaigns": return { workspace: identity(ref), campaigns: [], next_cursor: null };
    // The sample under review has a connected CRM, so its automatic sync is read too.
    case "get_lifty_hubspot_connection": return ref === reviewing ? { provider: "hubspot", status: "connected", portal_id: "1297001",
      hub_domain: null, granted_scopes: [], connected_at: at, reconnect_required: false } : { provider: "hubspot", status: "not_connected" };
    case "get_lifty_crm_sync_status": return { state: "none" };
    case "get_lifty_crm_automatic_sync": return crmSyncControls.status_paused;
    case "get_lifty_attio_connection": return { provider: "attio", status: "not_connected" };
    case "get_lifty_senders": return { workspace: identity(ref), senders: [] };
    case "get_lifty_context_drafts": return { workspace_ref: ref, drafts: [] };
    case "get_workspace_customer_source_choice": return { workspace_ref: ref, mode: "unselected", provider: null, sources: [], version: 0, updated_at: null, refresh_pending: false };
    default: throw new Error(`Unexpected RPC ${name}`);
  }
}

function harness(admin: boolean) {
  const calls: Array<[string, unknown]> = [];
  const rpc = vi.fn(async (name: string, args?: Record<string, unknown>) => {
    calls.push([name, args]);
    if (name === "admin_list_workspaces") {
      return admin ? { data: { generated_at: "x", workspaces: listed }, error: null }
        : { data: null, error: { code: "PT403", message: "ADMIN_REQUIRED" } };
    }
    const ref = (name === "get_workspace_customer_source_choice" ? args?.p_workspace : args?.p_workspace_id) as string | undefined;
    if (!ref) return { data: null, error: { code: "PT409", message: "lifty_workspace_ambiguous" } };
    if (ref === broken) return { data: null, error: { code: "XX000", message: "private failure" } };
    return { data: rpcFor(ref, name), error: null };
  });
  const hubspot = createHubspotConnectOperations({ clientId: "c", clientSecret: "s", publicBaseUrl: "https://api.test",
    supabaseUrl: "https://db.test", publishableKey: "k" });
  const app = createApp({
    authenticate: async () => ({ ok: true, session: { userId: "admin", client: { rpc } } }),
    getRunStatus: session => getRunStatus(session), getCrmSyncStatus, getAttioConnection,
    getHubspotConnection: hubspot.getConnection, log: () => {},
  });
  const read = () => app.request("/v1/admin/onboarding", {
    headers: { authorization: "Bearer admin", "x-lifty-client-contract": STAGE_CLIENT_CONTRACT } });
  return { read, calls };
}

describe("admin onboarding read", () => {
  it("computes each workspace's next_step by naming that workspace, and keeps member emails out", async () => {
    const h = harness(true);
    const response = await h.read();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.workspaces.map((item: { workspace_ref: string; next_step: { reason: string } | null; error: string | null }) =>
      [item.workspace_ref, item.next_step?.reason ?? null, item.error])).toEqual([
      [confirming, "business_confirmation_needed", null],
      [sampling, "sample_not_started", null],
      [reviewing, "sample_ready_for_founder_review", null],
      [broken, null, "BUSINESS_UNAVAILABLE"],
    ]);
    expect(body.workspaces[1]).toMatchObject({ slug: "workspace-1", plan: { kind: "managed" } });
    // LIF-1198: provisioning origin never reaches the operator view, whatever the database sends.
    expect(body.workspaces.some((item: object) => "provisioned_by" in item)).toBe(false);
    expect(body.workspaces[1].plan).toEqual({ kind: "managed" });
    expect(JSON.stringify(body)).not.toContain("founder@example.invalid");
    expect(JSON.stringify(body)).not.toContain("private failure");
    // Every read after the list names its workspace; none falls back to the caller's selection.
    const reads = h.calls.filter(([name]) => name !== "admin_list_workspaces");
    expect(new Set(reads.map(([name]) => name))).toEqual(new Set(["get_lifty_business_profile", "get_lifty_targeting",
      "get_lifty_research_criteria", "get_lifty_setup_status", "get_lifty_run_status", "get_lifty_campaigns",
      "get_lifty_hubspot_connection", "get_lifty_attio_connection", "get_lifty_crm_sync_status", "get_lifty_crm_automatic_sync",
      "get_lifty_senders", "get_lifty_context_drafts", "get_workspace_customer_source_choice"]));
    expect(reads.every(([name, args]) => typeof (args as Record<string, unknown>)?.[name === "get_workspace_customer_source_choice" ? "p_workspace" : "p_workspace_id"] === "string")).toBe(true);
    expect(body.steps.map((step: { reason: string }) => step.reason)).toEqual(Object.keys(NEXT_STEP_CATALOG));
    expect(body.base).toEqual(BASE_CONTEXTS);
    expect(body.on_request).toEqual(ON_REQUEST_CONTEXTS);
    for (const step of body.steps) {
      expect(step.when.length, step.reason).toBeGreaterThan(0);
      expect(step.guide.revision, step.reason).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(step.guide.size, step.reason).toBeGreaterThan(0);
      // The ops page shows where each step sends the agent (LIF-1301).
      expect(step, step.reason).toMatchObject({ context: NEXT_STEP_CATALOG[step.reason]!.context, related: NEXT_STEP_CATALOG[step.reason]!.related });
    }
  });

  it("refuses a caller who is not a LIFT admin before reading any workspace", async () => {
    const h = harness(false);
    const response = await h.read();
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("ADMIN_REQUIRED");
    expect(h.calls.map(([name]) => name)).toEqual(["admin_list_workspaces"]);
  });
});
