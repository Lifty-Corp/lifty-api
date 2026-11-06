import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { STAGE_CLIENT_CONTRACT, getAgentContext } from "../src/agent-context.js";
import { callStageMcpTool, getStageMcpTools } from "../src/mcp-stage-tools.js";
import { METRIC_IDS, executeReportOperation } from "../src/report-operations.js";
// Captured from the real SQL: the Functions migrations 20261106195000 to 195600
// and these RPCs, read as a member with x-lifty-workspace on the shared
// development database in one rolled-back transaction. measurements_before_migration
// is the same read before those migrations, the shape live until they ship.
import fixture from "./report-sql-fixtures.json" with { type: "json" };

// LIF-1571 reports: the routes call the member RPCs with the caller's session,
// refuse an unbounded or invalid request before any read, pass the stored and
// live payloads through unchanged and turn an unverifiable answer into
// unavailable, never zero.
type Rpc = (name: string, args: Record<string, unknown>) => unknown;
function harness(answer: Rpc) {
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    try { return { data: await answer(name, args), error: null }; } catch (error) { return { data: null, error }; }
  });
  const app = createApp({ authenticate: async () => ({ ok: true, session: { userId: "founder", client: { rpc } } }), log: () => {} });
  const headers = { authorization: "Bearer session", "x-lifty-client-contract": STAGE_CLIENT_CONTRACT, "x-lifty-workspace": "example" };
  return { rpc, app, headers, get: (path: string) => app.request(path, { headers }) };
}
const dbError = (code: string, message: string) => Object.assign(new Error(message), { code, message, details: null });

const reports = "/v1/workspace/reports?start=2026-10-19&end=2026-11-02";
const details = (query: string, week = "2026-10-26") => `/v1/workspace/reports/${week}/details?${query}`;
const measurements = (start: string, end: string) => `/v1/workspace/measurements?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
const metricOf = (rows: typeof fixture.reports_range, week: string) => rows.find(row => row.week_start === week)!.payload.metrics;

describe("weekly report reads", () => {
  it.each(["reports_empty", "reports_range", "reports_crm", "reports_corrected"] as const)("returns the stored rows of %s unchanged", async label => {
    const h = harness(() => fixture[label]);
    const response = await h.get(reports);
    expect([response.status, response.headers.get("cache-control"), await response.json()]).toEqual([200, "no-store", { reports: fixture[label] }]);
    expect(h.rpc.mock.calls).toEqual([["get_workspace_reports", { p_workspace_id: null, p_start: "2026-10-19", p_end: "2026-11-02" }]]);
  });

  it.each([
    ["unavailable", "2026-04-06", "research.researched", "before_history"],
    ["collecting", "2026-10-26", "conversion.email.replied", "cohort_maturing"],
    ["not_applicable", "2026-10-26", "pipeline.meetingsBooked", "crm_not_connected"],
  ] as const)("keeps an %s metric apart from zero", async (availability, week, metric, reason) => {
    const body = await (await harness(() => fixture.reports_range).get(reports)).json() as { reports: typeof fixture.reports_range };
    expect(metricOf(body.reports, week)[metric]).toMatchObject({ availability, reason, value: null });
  });

  it("accepts the longest range, 735 days between two Mondays", async () => {
    const h = harness(() => []);
    expect((await h.get("/v1/workspace/reports?start=2024-10-28&end=2026-11-02")).status).toBe(200);
  });

  it.each([
    ["a start that is not a Monday", "start=2026-10-20&end=2026-11-02"],
    ["an end that is not a Monday", "start=2026-10-19&end=2026-11-03"],
    ["an empty range", "start=2026-10-19&end=2026-10-19"],
    ["a reversed range", "start=2026-11-02&end=2026-10-19"],
    ["a range beyond 735 days", "start=2024-10-21&end=2026-11-02"],
    ["a missing end", "start=2026-10-19"],
    ["an undeclared field", "start=2026-10-19&end=2026-11-02&workspace=other"],
  ])("refuses %s before any read", async (_label, query) => {
    const h = harness(() => { throw new Error("no read expected"); });
    const response = await h.get(`/v1/workspace/reports?${query}`);
    expect([response.status, ((await response.json()) as { error: { code: string } }).error.code]).toEqual([400, "INVALID_REQUEST"]);
    expect(h.rpc).not.toHaveBeenCalled();
  });
});

describe("weekly report details", () => {
  it("names the exact page and keeps the report's microseconds", async () => {
    const h = harness(() => fixture.details_last_page);
    const calculated = "2026-11-05T16:44:52.412938+00:00";
    const response = await h.get(details(`metric=email.peopleReplied&offset=2&limit=2&calculated_at=${encodeURIComponent(calculated)}`));
    expect([response.status, await response.json()]).toEqual([200, fixture.details_last_page]);
    expect(h.rpc.mock.calls).toEqual([["get_workspace_report_details", { p_workspace_id: null, p_week: "2026-10-26",
      p_metric: "email.peopleReplied", p_offset: 2, p_limit: 2, p_calculated_at: calculated }]]);
  });

  it("starts at the first page of 100 without a report identity", async () => {
    const h = harness(() => fixture.details_first_page);
    await h.get(details("metric=email.peopleReplied"));
    expect(h.rpc).toHaveBeenCalledWith("get_workspace_report_details", { p_workspace_id: null, p_week: "2026-10-26",
      p_metric: "email.peopleReplied", p_offset: 0, p_limit: 100, p_calculated_at: null });
  });

  it("pages every contributor exactly once through next_offset", async () => {
    const h = harness((_name, args) => args.p_offset === 0 ? fixture.details_first_page : fixture.details_last_page);
    const first = await (await h.get(details("metric=email.peopleReplied&limit=2"))).json() as typeof fixture.details_first_page;
    const last = await (await h.get(details(`metric=email.peopleReplied&limit=2&offset=${first.next_offset}`))).json() as typeof fixture.details_last_page;
    expect(last.next_offset).toBeNull();
    expect(new Set([...first.items, ...last.items].map(item => item.id)).size).toBe(first.total);
  });

  it.each(["details_messages", "details_research", "details_suppressed", "details_conversion", "details_not_applicable",
    "details_meetings", "details_deals", "details_won", "details_crm_created", "details_crm_enriched"] as const)("returns the real contributors of %s unchanged", async label => {
    const response = await harness(() => fixture[label]).get(details("metric=email.peopleReplied"));
    expect([response.status, await response.json()]).toEqual([200, fixture[label]]);
  });

  it("says a page is stale and gives the corrected count with its details", async () => {
    const corrected = fixture.reports_corrected[0]!;
    const body = await (await harness(() => fixture.details_stale).get(details("metric=email.peopleReplied&offset=2&limit=2"))).json() as typeof fixture.details_stale;
    expect(body).toMatchObject({ stale: true, calculated_at: corrected.calculated_at, metric: corrected.payload.metrics["email.peopleReplied"], total: 4 });
    expect(fixture.details_current).toMatchObject({ stale: false, calculated_at: corrected.calculated_at });
  });

  it("reports a week with no stored report as missing, not as an empty page", async () => {
    const response = await harness(() => fixture.details_missing).get(details("metric=email.peopleReplied"));
    expect([response.status, ((await response.json()) as { error: { code: string } }).error.code]).toEqual([404, "REPORT_NOT_FOUND"]);
  });

  it.each([
    ["a week that is not a Monday", details("metric=email.peopleReplied", "2026-10-27")],
    ["an unknown metric", details("metric=email.everyone")],
    ["a missing metric", details("limit=10")],
    ["a limit of 0", details("metric=email.peopleReplied&limit=0")],
    ["a limit above 500", details("metric=email.peopleReplied&limit=501")],
    ["a negative offset", details("metric=email.peopleReplied&offset=-1")],
    ["a report identity without its offset", details("metric=email.peopleReplied&calculated_at=2026-11-05T16:44:52")],
  ])("refuses %s before any read", async (_label, path) => {
    const h = harness(() => { throw new Error("no read expected"); });
    expect((await h.get(path)).status).toBe(400);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("takes the largest page", async () => {
    expect((await harness(() => fixture.details_first_page).get(details("metric=email.peopleReplied&limit=500"))).status).toBe(200);
  });
});

describe("shared live measurement", () => {
  it("passes the exact range, microseconds included", async () => {
    const h = harness(() => fixture.measurements_range);
    const { start, end } = fixture.measurements_range.period;
    const response = await h.get(measurements(start, end));
    expect([response.status, await response.json()]).toEqual([200, fixture.measurements_range]);
    expect(h.rpc.mock.calls).toEqual([["get_workspace_measurements", { p_workspace_id: null, p_start: start, p_end: end }]]);
  });

  it.each(["measurements_current", "measurements_crm", "measurements_unsynced", "measurements_crm_failed"] as const)("returns %s unchanged", async label => {
    const { start, end } = fixture[label].period;
    const response = await harness(() => fixture[label]).get(measurements(start, end));
    expect([response.status, await response.json()]).toEqual([200, fixture[label]]);
  });

  it("marks the week in progress as open", () => {
    expect(fixture.measurements_current.period_closed).toBe(false);
  });

  it.each([
    ["never synced", fixture.measurements_unsynced, "crm_not_synced"],
    ["failed", fixture.measurements_crm_failed, "crm_source_failed"],
  ])("reads a CRM that %s as unavailable, not zero", async (_label, payload, reason) => {
    const body = await (await harness(() => payload).get(measurements(payload.period.start, payload.period.end))).json() as typeof payload;
    expect(body.metrics["pipeline.meetingsBooked"]).toMatchObject({ availability: "unavailable", reason, value: null });
  });

  it("tolerates the measurement live before the research and CRM migration, adding nothing", async () => {
    const payload = fixture.measurements_before_migration;
    const response = await harness(() => payload).get(measurements(payload.period.start, payload.period.end));
    expect([response.status, await response.json()]).toEqual([200, payload]);
    expect(Object.keys(payload.metrics)).toHaveLength(29);
  });

  it.each([
    ["an empty range", "2026-10-26T00:00:00Z", "2026-10-26T00:00:00Z"],
    ["a reversed range", "2026-10-27T00:00:00Z", "2026-10-26T00:00:00Z"],
    ["a range beyond 731 days", "2024-10-26T00:00:00Z", "2026-10-28T00:00:01Z"],
    ["a bare date", "2026-10-26", "2026-11-02"],
    ["a timestamp without its offset", "2026-10-26T00:00:00", "2026-11-02T00:00:00"],
  ])("refuses %s before any read", async (_label, start, end) => {
    const h = harness(() => { throw new Error("no read expected"); });
    expect((await h.get(measurements(start, end))).status).toBe(400);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("relays the database's refusal of a period only it can measure", async () => {
    const response = await harness(() => { throw dbError("PT422", "MEASUREMENT_PERIOD_INVALID"); }).get(measurements("2026-10-26T00:00:00Z", "2026-11-02T00:00:00Z"));
    expect([response.status, ((await response.json()) as { error: { code: string } }).error.code]).toEqual([422, "MEASUREMENT_PERIOD_INVALID"]);
  });
});

describe("report failures and membership", () => {
  const stored = fixture.reports_range[2]!;
  const { "research.quality": _dropped, ...withoutOneMetric } = stored.payload.metrics;
  const { start, end } = fixture.measurements_range.period;
  const live = measurements(start, end);
  it.each([
    ["an unknown report field", reports, [{ ...stored, extra: 1 }]],
    ["a stored report missing a metric", reports, [{ ...stored, payload: { ...stored.payload, metrics: withoutOneMetric } }]],
    ["an unknown stored metric", reports, [{ ...stored, payload: { ...stored.payload, metrics: { ...stored.payload.metrics, "email.other": stored.payload.metrics["email.peopleReplied"] } } }]],
    ["an unknown availability", reports, [{ ...stored, payload: { ...stored.payload, metrics: { ...stored.payload.metrics, "email.peopleReplied": { ...stored.payload.metrics["email.peopleReplied"], availability: "pending" } } } }]],
    ["a report not published as complete", reports, [{ ...stored, payload: { ...stored.payload, publication_state: "draft" } }]],
    ["a page without stale", details("metric=email.peopleReplied"), (({ stale: _stale, ...page }) => page)(fixture.details_first_page)],
    ["an unknown contributor field", details("metric=email.peopleReplied"), { ...fixture.details_first_page, items: [{ ...fixture.details_first_page.items[0], email: "person@example.test" }] }],
    ["a live metric with an unknown key", live, { ...fixture.measurements_range, metrics: { ...fixture.measurements_range.metrics, "email.other": fixture.measurements_range.metrics["email.peopleReplied"] } }],
    ["a live read without its period", live, (({ period: _period, ...read }) => read)(fixture.measurements_range)],
  ])("reads %s as unavailable", async (_label, path, payload) => {
    const response = await harness(() => payload).get(path);
    expect([response.status, ((await response.json()) as { error: { code: string } }).error.code]).toEqual([502, "REPORTS_UNAVAILABLE"]);
  });

  it("reads an RPC the database does not have yet as unavailable", async () => {
    const response = await harness(() => { throw dbError("PGRST202", "Could not find the function public.get_workspace_reports"); }).get(reports);
    expect([response.status, ((await response.json()) as { error: { code: string } }).error.code]).toEqual([502, "REPORTS_UNAVAILABLE"]);
  });

  it.each([
    ["another workspace", "PT403", "lifty_workspace_forbidden", 403, "WORKSPACE_FORBIDDEN"],
    ["no chosen workspace", "PT409", "lifty_workspace_ambiguous", 409, "WORKSPACE_SELECTION_REQUIRED"],
    ["no workspace at all", "PT404", "WORKSPACE_NOT_FOUND", 404, "WORKSPACE_NOT_READY"],
  ])("relays the database's answer for %s", async (_label, code, message, status, publicCode) => {
    const response = await harness(() => { throw dbError(code, message); }).get(live);
    expect([response.status, ((await response.json()) as { error: { code: string } }).error.code]).toEqual([status, publicCode]);
  });

  it("names the workspace only for an admin read", async () => {
    const rpc = vi.fn(async () => ({ data: fixture.reports_empty, error: null }));
    const session = { userId: "admin", workspaceRef: "15711000-0000-4000-8000-000000000001", client: { rpc } };
    await executeReportOperation(session, "reports.get", { path: {}, query: { start: "2026-10-19", end: "2026-11-02" }, body: undefined });
    expect(rpc).toHaveBeenCalledWith("get_workspace_reports", { p_workspace_id: session.workspaceRef, p_start: "2026-10-19", p_end: "2026-11-02" });
  });

  it("keeps the published metric list equal to the stored report's", () => {
    expect([...METRIC_IDS].sort()).toEqual(Object.keys(stored.payload.metrics).sort());
  });
});

describe("report tools and guide", () => {
  const incoming = () => new Request("https://api.example.test/mcp", { headers: { authorization: "Bearer founder" } });

  it("publishes three read-only tools over the same routes", () => {
    const tools = getStageMcpTools().filter(tool => tool.name.startsWith("reports_"));
    expect(tools.map(tool => tool.name).sort()).toEqual(["reports_details", "reports_get", "reports_measurements"]);
    for (const tool of tools) expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
  });

  it("keeps a report identity intact through the MCP adapter", async () => {
    const h = harness(() => fixture.details_first_page);
    const calculated = "2026-11-05T16:44:52.412938+00:00";
    const result = await callStageMcpTool("reports_details", { path: { week: "2026-10-26" }, query: { metric: "email.peopleReplied", limit: 2, calculated_at: calculated } },
      incoming(), async (route, init) => h.app.request(route, init));
    expect(result.structuredContent).toEqual({ status: 200, data: fixture.details_first_page });
    expect(h.rpc.mock.calls[0]![1]).toMatchObject({ p_week: "2026-10-26", p_limit: 2, p_calculated_at: calculated });
  });

  it("serves a guide listing every operation and the OpenAPI paths", async () => {
    const guide = getAgentContext("reports")!;
    expect(Object.keys(guide.operations!).sort()).toEqual(["details", "get", "measurements"]);
    const paths = (await (await harness(() => null).app.request("/openapi.json")).json() as { paths: Record<string, unknown> }).paths;
    expect(Object.keys(paths)).toEqual(expect.arrayContaining(["/v1/workspace/reports", "/v1/workspace/reports/{week}/details", "/v1/workspace/measurements"]));
  });
});
