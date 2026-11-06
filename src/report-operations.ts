import { z } from "zod";
import type { AuthSession } from "./app.js";
import { PublicError } from "./errors.js";
import type { IdentityDefinition, IdentityInput } from "./identity-operations.js";
import { Monday } from "./research-operations.js";
import { rpcFailure } from "./rpc-errors.js";

// LIF-1571 weekly reports and shared live measurement: member reads over the
// caller's session, the database resolving the workspace from x-lifty-workspace
// (or AuthSession.workspaceRef for an admin read). This API computes nothing.
// A closed week reads the stored report, the same row the digest reads; any
// other range reads the shared measurement. Unavailable, collecting and not
// applicable metrics stay what they are, never zero.
const Empty = z.object({}).strict();
const Ref = z.uuid();
const Timestamp = z.iso.datetime({ offset: true });
const Count = z.number().int().nonnegative();
const DAY_MS = 86_400_000;
const REPORT_RANGE_DAYS = 735;
const MEASUREMENT_RANGE_DAYS = 731;

const range = (start: string, end: string, limit: number) => Date.parse(start) < Date.parse(end) && Date.parse(end) - Date.parse(start) <= limit * DAY_MS;

// One list for reports, live ranges and drill-downs. A new metric reaches this
// API before the database publishes it: an unknown key fails the response.
export const METRIC_IDS = [
  "linkedin.connectionsSent", "linkedin.connectionsAccepted", "linkedin.peopleMessaged", "linkedin.peopleReplied",
  "email.messagesSent", "email.peopleEmailed", "email.peopleBounced", "email.peopleBlocked", "email.peopleReplied",
  "research.researched", "research.tierA", "research.tierB", "research.tierAB", "research.tierC", "research.unclassified", "research.quality",
  "discovery.suppressedBeforeResearch", "crm.companiesCreated", "crm.companiesEnriched", "crm.contactsCreated", "crm.contactsEnriched",
  "pipeline.meetingsBooked", "pipeline.dealsCreated", "pipeline.dealsWon", "pipeline.createdDealValue", "pipeline.wonDealValue",
  "pipeline.linkedin.meetingsBooked", "pipeline.linkedin.dealsCreated", "pipeline.linkedin.dealsWon", "pipeline.linkedin.createdDealValue", "pipeline.linkedin.wonDealValue",
  "pipeline.email.meetingsBooked", "pipeline.email.dealsCreated", "pipeline.email.dealsWon", "pipeline.email.createdDealValue", "pipeline.email.wonDealValue",
  "conversion.connectionAccepted", "conversion.linkedin.replied", "conversion.email.replied", "conversion.meeting", "conversion.won",
] as const;
const metricObject = (ids: readonly string[], metric: (id: string) => z.ZodType) =>
  z.object(Object.fromEntries(ids.map(id => [id, metric(id)]))).strict();

const Availability = z.enum(["complete", "partial", "unavailable", "not_applicable", "collecting"]);
const Reason = z.string().regex(/^[a-z][a-z_]*$/).max(64).nullable();
const state = { availability: Availability, reason: Reason };
const Money = z.object({ currency: z.string().min(1).nullable(), amount: z.number(), deals: z.number().int().positive() }).strict();
const Metric = z.union([
  z.object({ unit: z.enum(["people", "messages", "meetings", "deals"]), value: Count.nullable(), ...state }).strict(),
  z.object({ unit: z.literal("entities"), value: Count.nullable(), ambiguous_receipts: Count, ...state }).strict(),
  z.object({ unit: z.literal("money"), value: z.array(Money).nullable(), unpriced: Count.nullable(), ...state }).strict(),
  // Cohort conversions add the 28-day horizon; research.quality has none.
  z.object({ unit: z.literal("ratio"), value: z.number().nullable(), numerator: Count.nullable(), denominator: Count.nullable(),
    horizon_days: z.number().int().positive().optional(), matures_at: Timestamp.optional(), ...state }).strict(),
]);
const Period = z.object({ start: Timestamp, end: Timestamp }).strict();
const Sources = z.object({ crm: z.object({ provider: z.enum(["hubspot", "attio"]).nullable(), connected: z.boolean(), synced_at: Timestamp.nullable(), failed: z.boolean() }).strict() }).strict();
const Sender = z.object({ sender_id: Ref, display_name: z.string(), deleted: z.boolean(),
  metrics: metricObject(["linkedin.connectionsSent", "linkedin.peopleMessaged", "email.peopleEmailed"], () => Metric) }).strict();
const measured = { workspace_id: Ref, period: Period, observed_at: Timestamp, senders: z.array(Sender), sources: Sources };

// Optional until Functions 20261106195000 (LIF-1757) is live: the shared
// measurement reports these twelve metrics from that migration on, and this
// API deploys first. Absent is unknown, never zero. Stored reports always have them.
const AWAITING_MIGRATION = /^(?:research|discovery|crm)\./;
export const MeasurementSchema = z.object({ ...measured, period_closed: z.boolean(),
  metrics: metricObject(METRIC_IDS, id => AWAITING_MIGRATION.test(id) ? Metric.optional() : Metric) }).strict();

export const ReportPayloadSchema = z.object({ ...measured, schema_version: z.literal(1), publication_state: z.literal("complete"),
  period_closed: z.literal(true), metrics: metricObject(METRIC_IDS, () => Metric) }).strict();
export const ReportSchema = z.object({ workspace_id: Ref, week_start: z.iso.date(), period_start: Timestamp, period_end: Timestamp,
  calculated_at: Timestamp.describe("The report's calculation identity. It changes when a correction replaces the week."),
  payload: ReportPayloadSchema }).strict();
export const ReportsSchema = z.object({ reports: z.array(ReportSchema).max(105) }).strict();

// One contributor behind a metric, by the family that metric counts.
const ResearchEvidence = z.union([
  z.object({ source: z.literal("run_result"), research_id: Ref, run_ref: Ref, grade: z.string().nullable() }).strict(),
  z.object({ source: z.literal("candidate_at_settlement"), candidate_id: Ref, run_ref: Ref, grade: z.string().nullable() }).strict(),
  z.object({ source: z.literal("unavailable"), grade: z.null() }).strict(),
]);
const CrmWrite = z.object({ event_id: Ref, lead_id: Ref, written_at: Timestamp, operation: z.enum(["create", "update"]), property_keys: z.array(z.string()) }).strict();
const Contributor = z.union([
  z.object({ id: z.string().min(1), lead_id: Ref }).strict(),
  z.object({ id: z.string().min(1), lead_id: Ref.nullable(), candidate_id: Ref.nullable(), settled_at: Timestamp,
    grade: z.enum(["A", "B", "C", "unclassified"]), evidence: ResearchEvidence, converted: z.boolean() }).strict(),
  z.object({ id: z.string().min(1), candidate_id: Ref, suppressed_at: Timestamp }).strict(),
  z.object({ id: z.string().min(1), provider: z.enum(["hubspot", "attio"]), object_type: z.enum(["contact", "company"]), record_id: z.string().min(1), evidence: z.array(CrmWrite).min(1) }).strict(),
  z.object({ id: z.string().min(1), lead_id: Ref, booked_at: Timestamp }).strict(),
  z.object({ id: z.string().min(1), lead_id: Ref, amount: z.number().nullable(), currency: z.string().min(1).nullable(), created_at: Timestamp, closed_at: Timestamp.nullable() }).strict(),
  z.object({ id: z.string().min(1), lead_id: Ref, anchored_at: Timestamp, converted: z.boolean() }).strict(),
]);
export const ReportDetailsSchema = z.object({ workspace_id: Ref, week_start: z.iso.date(), period: Period,
  calculated_at: Timestamp.describe("The report this page belongs to; compare it with the report you hold."),
  stale: z.boolean().describe("true when calculated_at was sent and the week has since been corrected. Reload the report and its details together."),
  metric: Metric, total: Count, offset: Count,
  next_offset: Count.nullable().describe("Send as offset for the next page; null on the last page."),
  items: z.array(Contributor).max(500) }).strict();

export const ReportsQuerySchema = z.object({
  start: Monday.describe("First week's Monday (UTC), YYYY-MM-DD."),
  end: Monday.describe("A later Monday, excluded."),
}).strict().refine(query => range(query.start, query.end, REPORT_RANGE_DAYS), `Choose an end after start, at most ${REPORT_RANGE_DAYS} days later.`);
export const ReportDetailsPathSchema = z.object({ week: Monday }).strict();
export const ReportDetailsQuerySchema = z.object({
  // Checked against the list without publishing it: every MCP turn carries the
  // tool schemas, and a report already names its metrics.
  metric: z.string().refine(id => (METRIC_IDS as readonly string[]).includes(id), "Use a metric id from the report's metrics.")
    .describe("A key of the report's metrics."),
  offset: z.coerce.number().int().min(0).max(1_000_000_000).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  calculated_at: Timestamp.optional().describe("The report's calculated_at, unchanged."),
}).strict();
export const MeasurementsQuerySchema = z.object({
  start: Timestamp.describe("Included, with its offset."),
  end: Timestamp.describe("Excluded, with its offset."),
}).strict().refine(query => range(query.start, query.end, MEASUREMENT_RANGE_DAYS), `Choose an end after start, at most ${MEASUREMENT_RANGE_DAYS} days later.`);

const unavailable = { code: "REPORTS_UNAVAILABLE", message: "Report data could not be read. Retry; a failed read is not zero activity." };
const invalid = { status: 400, code: "INVALID_REQUEST" } as const;
export const reportOperationDefinitions = {
  reports: {
    get: {
      method: "GET", route: "/v1/workspace/reports", rpc: "get_workspace_reports", path: Empty, query: ReportsQuerySchema,
      request: null, invalid, response: ReportsSchema, success: 200,
      args: ({ query }) => ({ p_start: query.start, p_end: query.end }),
      description: "Read the stored weekly reports of [start, end), Mondays UTC at most 735 days apart: the figures the weekly digest shows. A week with no stored report is absent, not zero. calculated_at changes when a correction replaces a week.",
    },
    details: {
      method: "GET", route: "/v1/workspace/reports/{week}/details", rpc: "get_workspace_report_details", path: ReportDetailsPathSchema,
      query: ReportDetailsQuerySchema, request: null, invalid, response: ReportDetailsSchema, success: 200,
      args: ({ path, query }) => ({ p_week: path.week, p_metric: query.metric, p_offset: query.offset, p_limit: query.limit, p_calculated_at: query.calculated_at ?? null }),
      description: "Read one page, limit 1 to 500, of the people and records behind one metric of a stored weekly report. Page with next_offset. stale true means the week was corrected since the calculated_at you sent: read the report and its pages again. REPORT_NOT_FOUND means none is stored for that week.",
    },
    measurements: {
      method: "GET", route: "/v1/workspace/measurements", rpc: "get_workspace_measurements", path: Empty, query: MeasurementsQuerySchema,
      request: null, invalid, response: MeasurementSchema, success: 200,
      args: ({ query }) => ({ p_start: query.start, p_end: query.end }),
      description: "Read the shared live measurement of any range of at most 731 days: the week in progress, an exact 30 days, or a closed week with no stored report. Same metric ids as the report; figures can still change.",
    },
  },
} satisfies Record<string, Record<string, IdentityDefinition>>;

export const reportEntries = () => Object.entries(reportOperationDefinitions).flatMap(([resource, operations]) =>
  Object.entries(operations).map(([action, definition]) => ({ key: `${resource}.${action}`, definition: definition as IdentityDefinition })));

export async function executeReportOperation(session: AuthSession, key: string, input: IdentityInput): Promise<unknown> {
  const entry = reportEntries().find(item => item.key === key);
  if (!entry) throw new Error("Unknown report operation");
  const { definition } = entry;
  const failure = { operation: definition.rpc, ...unavailable };
  let result: { data: unknown; error: unknown };
  try { result = await (session.client as { rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> })
    .rpc(definition.rpc, { p_workspace_id: session.workspaceRef ?? null, ...definition.args(input) }); }
  catch (cause) { throw rpcFailure(cause, failure); }
  if (result.error) throw rpcFailure(result.error, failure);
  if (key === "reports.details" && result.data === null)
    throw new PublicError({ status: 404, code: "REPORT_NOT_FOUND", message: "No report is stored for this week. Read measurements for this exact week instead." });
  const parsed = definition.response.safeParse(key === "reports.get" ? { reports: result.data } : result.data);
  if (!parsed.success) throw new PublicError({ status: 502, ...unavailable });
  return parsed.data;
}
