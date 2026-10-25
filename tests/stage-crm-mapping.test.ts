import { describe, expect, it, vi } from "vitest";
import { createApp, type AppDependencies, type AuthSession } from "../src/app.js";
import { getAgentContext, STAGE_CLIENT_CONTRACT } from "../src/agent-context.js";
import { PublicError } from "../src/errors.js";

const workspaceRef = "22222222-2222-4222-8222-222222222222";
const leadRef = "33333333-3333-4333-8333-333333333333";
const runRef = "44444444-4444-4444-8444-444444444444";
const session: AuthSession = { userId: "founder", client: {} };
const scope = { workspace_ref: workspaceRef, integration_ref: leadRef, portal_id: "123", mapping_version: "a".repeat(64) };
const state = { ...scope, provider: "hubspot", workspace_name: "Example", mappings: [] };
const available = { state: "available", missing_scopes: [] };
const capabilities = { credential: "oauth", scopes: ["crm.objects.contacts.write"], map_fields: available, create_fields: { contact: available, company: available } };
const schemaVersion = "b".repeat(64);
const base: Partial<AppDependencies> = {
  authenticate: async () => ({ ok: true, session }),
  getWorkspace: async () => ({ state: "ready_for_connections", workspace: { workspace_ref: workspaceRef, name: "Example" }, next_action: null }),
  log: () => {},
};
const edit = { workspace_id: workspaceRef, provider: "hubspot", source_stage: "discovery", source_entity: "lead", source_field: "industry",
  label: "Industry", source_path: ["industry"], destination_object: "company", destination_field: "industry", write_rule: "only_if_empty",
  transform: "none", transform_config: {}, value_source: "path", enabled: true, required_from_agent: false,
  clay_path: null, comparison_rule: null, comparison_config: {}, fallback_group: null, fallback_priority: null, sort_order: 20,
  id: null, expected_updated_at: null };
const property = { name: "industry", label: "Industry", type: "enumeration", fieldType: "select", groupName: "companyinformation", options: [{ label: "Software", value: "COMPUTER_SOFTWARE" }] };
const receipt = { run_ref: runRef, workspace_ref: workspaceRef, status: "queued", result: null };
const cases = [
  { action: "capabilities", method: "GET", input: undefined, query: "", output: { workspace_ref: workspaceRef, connection: "connected", provider: "hubspot", integration_ref: leadRef, portal_id: "123", capabilities } },
  { action: "catalog", method: "GET", input: undefined, query: "", output: { ...state, capabilities, schema_version: schemaVersion, properties: { contact: [], company: [property] }, sources: {} } },
  { action: "sources", method: "POST", input: { lead_refs: [leadRef] }, query: "", output: { workspace_ref: workspaceRef, leads: [] } },
  { action: "preview", method: "POST", input: { ...scope, lead_refs: [leadRef], edits: [edit] }, query: "", output: { ...scope, schema_version: schemaVersion, preview_digest: "c".repeat(64), lead_refs: [leadRef], applied_mapping: false, plan: { version: 1, records: [] }, issues: [] } },
  { action: "apply", method: "POST", input: { ...scope, schema_version: schemaVersion, edits: [edit] }, query: "", output: { ...state, state: "applied" } },
  { action: "property_create", method: "POST", input: { ...scope, schema_version: schemaVersion, object: "company", property }, query: "", output: { ...scope, state: "already_exists", property } },
  { action: "sync", method: "POST", input: { ...scope, lead_refs: [leadRef], preview_digest: "c".repeat(64), request_ref: runRef }, query: "", output: receipt },
  { action: "status", method: "GET", input: undefined, query: `?run_ref=${runRef}`, output: { ...receipt, status: "partial", result: { fields: [{ field: "industry", status: "stale" }] } } },
] as const;
function request(app: ReturnType<typeof createApp>, action: string, method = "GET", body?: unknown, query = "") {
  return app.request(`/v1/workspace/crm/${action === "capabilities" ? "" : "mapping/"}${action}${query}`, { method,
    headers: { authorization: "Bearer scoped", "content-type": "application/json", "x-lifty-client-contract": STAGE_CLIENT_CONTRACT },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("full CRM mapping stage surface", () => {
  it.each(cases)("authenticates $action before dispatch", async ({ action, method, input, query }) => {
    const dispatch = vi.fn();
    const response = await request(createApp({ runCrmMapping: dispatch }), action, method, input, query);
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each(cases)("scopes $action to the active workspace and validates its response", async ({ action, method, input, query, output }) => {
    const dispatch = vi.fn(async () => output);
    const response = await request(createApp({ ...base, runCrmMapping: dispatch }), action, method, input, query);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(output);
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(session, action,
      action === "status" ? { run_ref: runRef } : input ?? {},
      { workspaceRef, signal: expect.any(AbortSignal) });
  });

  it("rejects an invalid cohort, forged workspace scope, unknown parameters and excess body before dispatch", async () => {
    const dispatch = vi.fn();
    const app = createApp({ ...base, runCrmMapping: dispatch });
    expect((await request(app, "sources", "POST", { lead_refs: [] })).status).toBe(400);
    expect((await request(app, "sources", "POST", { lead_refs: Array(26).fill(leadRef) })).status).toBe(400);
    expect((await request(app, "sources", "POST", { lead_refs: [leadRef], workspace_ref: leadRef })).status).toBe(400);
    expect((await request(app, "apply", "POST", { ...cases[4].input, workspace_ref: leadRef })).status).toBe(403);
    expect((await request(app, "catalog", "GET", undefined, `?workspace_ref=${leadRef}`)).status).toBe(400);
    expect((await request(app, "status", "GET")).status).toBe(400);
    expect((await request(app, "sources", "POST", { lead_refs: [leadRef], excess: "x".repeat(133 * 1024) })).status).toBe(413);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not expose a response from another workspace", async () => {
    const app = createApp({ ...base, runCrmMapping: async () => ({ workspace_ref: leadRef, leads: [] }) });
    expect((await request(app, "sources", "POST", { lead_refs: [leadRef] })).status).toBe(403);
  });

  it("blocks unavailable workspaces and preserves maintenance/readback failure codes", async () => {
    const dispatch = vi.fn();
    const suspended = createApp({ ...base, runCrmMapping: dispatch, getWorkspace: async () => ({
      state: "suspended", workspace: { workspace_ref: workspaceRef, name: "Example" }, next_action: null,
    }) });
    expect((await request(suspended, "catalog")).status).toBe(409);
    expect(dispatch).not.toHaveBeenCalled();
    const unavailable = createApp({ ...base, runCrmMapping: async () => {
      throw new PublicError({ status: 503, code: "READ_ONLY_MODE", message: "CRM mutations are paused." });
    } });
    const result = await request(unavailable, "sync", "POST", cases[6].input);
    expect(result.status).toBe(503);
    expect((await result.json()).error.code).toBe("READ_ONLY_MODE");
  });

  it("charges mapping mutations once against the shared existing budget", async () => {
    const dispatch = vi.fn(async () => receipt);
    const app = createApp({ ...base, runCrmMapping: dispatch });
    for (let i = 0; i < 10; i++) expect((await request(app, "sync", "POST", cases[6].input)).status).toBe(200);
    expect((await request(app, "sync", "POST", cases[6].input)).status).toBe(429);
    expect(dispatch).toHaveBeenCalledTimes(10);
  });

  it("publishes executable full mapper operations and evidence guidance in fresh v5 context", () => {
    const context = getAgentContext("crm")!;
    for (const { action, method } of cases) {
      const key = ["property_create", "capabilities"].includes(action) ? action : `mapping_${action}`;
      expect(context.operations?.[key]).toMatchObject({ method, route: `/v1/workspace/crm/${action === "capabilities" ? "" : "mapping/"}${action}` });
    }
    expect(context.instructions).toContain("founder's person city");
    expect(context.instructions).toContain("mapping_apply");
    expect(context.instructions).toContain("It does not update CRM records");
    expect(context.instructions).toContain("per-field");
  });
});
