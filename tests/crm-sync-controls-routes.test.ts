import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { STAGE_CLIENT_CONTRACT, getAgentContext } from "../src/agent-context.js";
import { getStageMcpTools } from "../src/mcp-stage-tools.js";
// Captured from the real local SQL suite (lift-supabase-functions
// scripts/test-lif1622-crm-automatic-sync.py).
import fixture from "./crm-sync-controls-sql-fixture.json" with { type: "json" };

// LIF-1622 `crm automatic_sync` and `crm test_sync`: the routes call the member
// RPCs with the database-resolved workspace, reject an unbounded or invalid
// request before any write, wake lifty-crm-sync for exactly the run the
// database created and never turn an unknown read into a default.
type Rpc = (name: string, args: Record<string, unknown>) => unknown;
function harness(rpc: Rpc) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const client = { rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    try { return { data: await rpc(name, args), error: null }; } catch (error) { return { data: null, error }; }
  }) };
  const enqueued: string[] = [];
  const app = createApp({
    authenticate: async () => ({ ok: true, session: { userId: "founder", client } }), log: () => {},
    enqueueCrmSync: async runRef => { enqueued.push(runRef); return { id: `trigger_${runRef}` }; },
  });
  const headers = { authorization: "Bearer session", "x-lifty-client-contract": STAGE_CLIENT_CONTRACT, "x-lifty-workspace": "example" };
  const send = (method: string, path: string, body?: unknown) => app.request(path, {
    method, headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { send, calls, enqueued };
}
const dbError = (code: string, message: string, details: unknown = null) =>
  Object.assign(new Error(message), { code, message, details: details === null ? null : JSON.stringify(details) });
const automatic = "/v1/workspace/crm/automatic-sync";
const test = "/v1/workspace/crm/test-sync";
const leadRefs = fixture.test_start.lead_refs;

// What Jobs' buildCrmTestReceipt stores for one sample lead.
const results = { version: 1, provider: "hubspot", leads: [{
  lead_ref: leadRefs[0], name: "Ada Lovelace", company: "Analytical",
  contact: { record_id: "901", url: "https://app.hubspot.com/contacts/1622001/record/0-1/901", found: true },
  company_record: { record_id: null, url: null, found: false },
  fields: [
    { object: "contact", field: "jobtitle", label: "Job title", mapping_ref: "8a5d3d80-1622-4000-a000-000000000001", source: "discovery.lead.title",
      result: "written", reason: null, value: "CTO", crm_value: "CTO" },
    { object: "contact", field: "linkedin_profile", label: null, mapping_ref: "8a5d3d80-1622-4000-a000-000000000002", source: "discovery.lead.linkedin_url",
      result: "kept", reason: "only_if_empty", value: "https://linkedin.com/in/ada", crm_value: "https://linkedin.com/in/other" },
    { object: "contact", field: "lift_budget", label: null, mapping_ref: "8a5d3d80-1622-4000-a000-000000000003", source: "research.lead.custom_fields.budget",
      result: "skipped", reason: "research_found_nothing", value: null, crm_value: null },
  ],
}] };

describe("CRM automatic sync routes", () => {
  it("reads and switches automatic sync through the documented RPCs and starts the waiting-lead sync", async () => {
    const h = harness(name => name === "get_lifty_crm_automatic_sync" ? fixture.status_paused : fixture.set_on);
    const read = await h.send("GET", automatic);
    expect([read.status, read.headers.get("cache-control"), await read.json()]).toEqual([200, "no-store", fixture.status_paused]);
    const body = { expected_version: 1, automatic_sync: "on" };
    const changed = await h.send("PATCH", automatic, body);
    expect([changed.status, await changed.json()]).toEqual([200, fixture.set_on]);
    expect(h.calls).toEqual([
      { name: "get_lifty_crm_automatic_sync", args: { p_workspace_id: null } },
      { name: "set_lifty_crm_automatic_sync", args: { p_workspace_id: null, p_payload: body } },
    ]);
    expect(h.enqueued).toEqual([fixture.set_on.catch_up.run_ref]);
  });

  it("pausing starts nothing", async () => {
    const h = harness(() => fixture.set_paused);
    const response = await h.send("PATCH", automatic, { expected_version: 2, automatic_sync: "paused" });
    expect(response.status).toBe(200);
    expect(h.enqueued).toEqual([]);
  });

  it.each<[string, unknown]>([
    ["an unknown state", { expected_version: 1, automatic_sync: "off" }],
    ["a boolean", { expected_version: 1, automatic_sync: true }],
    ["no state", { expected_version: 1 }],
    ["no expected_version", { automatic_sync: "on" }],
    ["an unknown field", { expected_version: 1, automatic_sync: "on", sync_now: true }],
  ])("rejects %s before any write", async (_case, body) => {
    const h = harness(() => { throw new Error("must not be called"); });
    const response = await h.send("PATCH", automatic, body);
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("CRM_AUTOMATIC_SYNC_INVALID");
    expect([h.calls, h.enqueued]).toEqual([[], []]);
  });

  it.each<[string, ReturnType<typeof dbError>, number, Record<string, unknown>]>([
    ["a stale version", dbError("PT409", "VERSION_CONFLICT", { current_version: 3 }), 409, { code: "VERSION_CONFLICT", current_version: 3 }],
    ["a member of another workspace", dbError("PT403", "lifty_workspace_forbidden"), 403, { code: "WORKSPACE_FORBIDDEN" }],
    ["a workspace without a CRM", dbError("PT409", "CRM_NOT_SELECTED"), 409, { code: "CRM_NOT_SELECTED" }],
    ["a suspended workspace", dbError("PT409", "WORKSPACE_SUSPENDED"), 409, { code: "WORKSPACE_SUSPENDED" }],
  ])("returns the typed database error for %s", async (_case, failure, status, error) => {
    const h = harness(() => { throw failure; });
    const response = await h.send("PATCH", automatic, { expected_version: 2, automatic_sync: "on" });
    expect(response.status).toBe(status);
    expect((await response.json()).error).toMatchObject(error);
    expect(h.enqueued).toEqual([]);
  });

  it.each<[string, Rpc]>([
    ["a database failure", () => { throw dbError("XX000", "private database detail"); }],
    ["a missing read", () => null],
    ["an unknown state", () => ({ ...fixture.status_paused, automatic_sync: "off" })],
  ])("reports %s as unavailable, never as a default", async (_case, rpc) => {
    const response = await harness(rpc).send("GET", automatic);
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(JSON.parse(text).error.code).toBe("CRM_SYNC_CONTROLS_UNAVAILABLE");
    expect(text).not.toContain("private database detail");
  });
});

describe("CRM test sync routes", () => {
  it("starts a test with Lifty's pick or explicit leads and wakes lifty-crm-sync for that run", async () => {
    const h = harness(() => fixture.test_start);
    const picked = await h.send("POST", test, {});
    expect([picked.status, await picked.json()]).toEqual([200, fixture.test_start]);
    const rerun = await h.send("POST", test, { lead_refs: leadRefs });
    expect(rerun.status).toBe(200);
    expect(h.calls).toEqual([
      { name: "start_lifty_crm_test_sync", args: { p_workspace_id: null, p_payload: {} } },
      { name: "start_lifty_crm_test_sync", args: { p_workspace_id: null, p_payload: { lead_refs: leadRefs } } },
    ]);
    // A reattached run is enqueued again under the same run-scoped key.
    expect(h.enqueued).toEqual([fixture.test_start.run_ref, fixture.test_start.run_ref]);
  });

  it.each<[string, unknown]>([
    ["more than five leads", { lead_refs: [...leadRefs, "1622aaaa-0000-4000-a000-000000000006"] }],
    ["a repeated lead", { lead_refs: [leadRefs[0], leadRefs[0]] }],
    ["an empty list", { lead_refs: [] }],
    ["a lead that is not a reference", { lead_refs: ["Ada Lovelace"] }],
    ["the bulk sync's limit", { limit: 2000 }],
  ])("rejects %s before any write", async (_case, body) => {
    const h = harness(() => { throw new Error("must not be called"); });
    const response = await h.send("POST", test, body);
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("CRM_TEST_SYNC_LEADS_INVALID");
    expect([h.calls, h.enqueued]).toEqual([[], []]);
  });

  it("reads one exact test with its per-field readback", async () => {
    const done = { ...fixture.test_done, results };
    const h = harness(() => done);
    const response = await h.send("GET", `${test}?run_ref=${done.run_ref}`);
    expect([response.status, await response.json()]).toEqual([200, done]);
    expect(h.calls).toEqual([{ name: "get_lifty_crm_test_sync", args: { p_workspace_id: null, p_run_ref: done.run_ref } }]);
    const latest = harness(() => ({ state: "none" }));
    expect(await (await latest.send("GET", test)).json()).toEqual({ state: "none" });
    expect(latest.calls[0]!.args).toEqual({ p_workspace_id: null, p_run_ref: null });
  });

  it.each<[string, ReturnType<typeof dbError>, number, Record<string, unknown>]>([
    ["another run in progress", dbError("PT409", "CRM_SYNC_IN_PROGRESS"), 409, { code: "CRM_SYNC_IN_PROGRESS" }],
    ["no qualified lead", dbError("PT409", "CRM_TEST_SYNC_NO_LEADS"), 409, { code: "CRM_TEST_SYNC_NO_LEADS" }],
    ["a reconnect-required CRM", dbError("PT409", "CRM_NOT_CONNECTED"), 409, { code: "CRM_NOT_CONNECTED" }],
    ["a lead outside the workspace", dbError("PT422", "CRM_TEST_SYNC_LEADS_INVALID", { issues: [{ code: "invalid_value",
      path: "/lead_refs/1", message: "This lead cannot be written to the CRM.", suggestion: "Omit lead_refs to let Lifty pick them." }] }),
    422, { code: "CRM_TEST_SYNC_LEADS_INVALID", issues: [expect.objectContaining({ path: "/lead_refs/1" })] }],
  ])("returns the typed database error for %s and starts nothing", async (_case, failure, status, error) => {
    const h = harness(() => { throw failure; });
    const response = await h.send("POST", test, { lead_refs: leadRefs.slice(0, 2) });
    expect(response.status).toBe(status);
    expect((await response.json()).error).toMatchObject(error);
    expect(h.enqueued).toEqual([]);
  });

  it("answers an unknown or foreign run_ref with 404", async () => {
    const h = harness(() => { throw dbError("PT404", "CRM_TEST_SYNC_NOT_FOUND"); });
    const response = await h.send("GET", `${test}?run_ref=${fixture.test_start.run_ref}`);
    expect([response.status, (await response.json()).error.code]).toEqual([404, "CRM_TEST_SYNC_NOT_FOUND"]);
  });

  it("is reachable as `lifty get|patch crm automatic_sync`, `lifty post|get crm test_sync` and MCP tools", () => {
    const { operations } = getAgentContext("crm")!;
    const commands = Object.entries(operations!)
      .filter(([, operation]) => ["automatic_sync", "test_sync"].includes(operation.cli?.operation ?? ""))
      .map(([key, operation]) => [key, operation.method, operation.route]);
    expect(commands).toEqual([
      ["automatic_sync_get", "GET", automatic],
      ["automatic_sync_patch", "PATCH", automatic],
      ["test_sync_start", "POST", test],
      ["test_sync_status", "GET", test],
    ]);
    const tools = Object.fromEntries(getStageMcpTools().map(tool => [tool.name, tool]));
    expect(tools.crm_automatic_sync_get?.annotations.readOnlyHint).toBe(true);
    expect(tools.crm_test_sync_status?.annotations.readOnlyHint).toBe(true);
    expect(tools.crm_test_sync_start?.annotations.readOnlyHint).toBe(false);
  });
});
