import { z } from "zod";
import type { AuthSession } from "./app.js";
import { PublicError } from "./errors.js";
import { rpcFailure } from "./rpc-errors.js";

// LIF-1174 weekly research volume and researched leads. Every definition is
// a catalog operation: HTTP routes, MCP tools, CLI nouns and public context
// derive from it. The database selects the workspace from the session's
// x-lifty-workspace header with the shared rule (p_workspace_id is null); the
// admin onboarding read names the workspace instead (LIF-1260).
const Empty = z.object({}).strict();
const Timestamp = z.iso.datetime({ offset: true });
const Count = z.number().int().nonnegative();
const isMonday = (value: string) => new Date(`${value}T00:00:00Z`).getUTCDay() === 1;
const Monday = z.iso
  .date()
  .refine(isMonday, "Choose the Monday (UTC) that starts the week, as YYYY-MM-DD.")
  .describe("The Monday (UTC) that starts the week, YYYY-MM-DD.");
const Grade = z.enum(["A", "B", "C"]);

export const ResearchLimitSchema = z
  .object({
    weekly_research_limit: z.number().int().positive(),
    // LIF-1258: a plan's total and what is left of it, null when the plan has
    // none (Seed has 50). Optional until every database release reports them.
    total_research_limit: z.number().int().positive().nullable().optional(),
    total_remaining: Count.nullable().optional(),
    plan_name: z.string().min(1).optional(),
    source: z.enum(["free", "paid"]),
    effective_from: Timestamp,
  })
  .strict();
export const ResearchScheduleSchema = z
  .object({
    version: Count,
    state: z.enum(["active", "paused"]),
    weekly_target: z.number().int().positive(),
    limit: ResearchLimitSchema,
    effective_target: Count,
    updated_at: Timestamp,
    updated_by: z.uuid().nullable(),
  })
  .strict();
export const ExpectedVersionSchema = z
  .object({ expected_version: Count })
  .strict();
export const ResearchSchedulePatchSchema = z
  .object({
    expected_version: Count,
    weekly_target: z
      .number()
      .int()
      .min(1)
      // The RPC accepts one-to-nine-digit targets before enforcing plan limits.
      .max(999_999_999)
      .nullable()
      .describe("People per week, from 1 up to the limit, or null to follow the plan's full limit."),
  })
  .strict();
export const ResearchStatusQuerySchema = z
  .object({ week: Monday.optional() })
  .strict();
export const ResearchStatusSchema = z
  .object({
    week_start: z.iso.date(),
    resets_at: Timestamp,
    state: z.enum(["active", "paused"]),
    policy_version: Count.nullable(),
    limit: ResearchLimitSchema,
    effective_target: Count,
    completed: Count,
    qualified: Count,
    reserved: Count,
    remaining: Count,
    daily: z
      .array(z.object({ date: z.iso.date(), completed: Count }).strict())
      .min(1)
      .max(7),
    shortfall: z
      .object({
        count: z.number().int().positive(),
        reason: z.enum(["search_exhausted", "research_failed", "paused"]),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .refine(
    (status) =>
      status.daily.reduce((sum, day) => sum + day.completed, 0) === status.completed &&
      status.qualified <= status.completed,
    "Daily completions must add up to the weekly total.",
  );
export const LeadsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/).optional(),
    grade: z.array(Grade).min(1).max(3).optional(),
    week: Monday.optional(),
  })
  .strict();
const LeadItem = z
  .object({
    lead_ref: z.uuid(),
    name: z.string(),
    title: z.string().nullable(),
    company: z.string().nullable(),
    linkedin_url: z.string().nullable(),
    grade: Grade.nullable(),
    fit_rationale: z.string().nullable(),
    researched_at: Timestamp,
    research_url: z.url(),
  })
  .strict();
export const LeadsPageSchema = z
  .object({
    items: z.array(LeadItem).max(100),
    next_cursor: z.string().nullable(),
  })
  .strict();
// The database returns the rows without links: the dashboard origin is API
// configuration (LIFTY_DASHBOARD_ORIGIN), the same owner that builds
// sample-review research links.
const LeadsRowsSchema = z
  .object({
    items: z.array(LeadItem.omit({ research_url: true })).max(100),
    next_cursor: z.string().nullable(),
  })
  .strict();

type Input = { query: Record<string, unknown>; body: unknown };
interface Definition {
  method: "GET" | "POST" | "PATCH";
  route: string;
  cli?: { operation: string };
  rpc: string;
  query: z.ZodType;
  request: z.ZodType | null;
  invalid: { status: 400 | 422; code: string };
  response: z.ZodType;
  unavailable: { code: string; message: string };
  args(input: Input): Record<string, unknown>;
  description: string;
}
const schedule = {
  code: "RESEARCH_SCHEDULE_UNAVAILABLE",
  message: "The research schedule could not be verified. Read it again before retrying a change.",
};
const scheduleRoute = "/v1/workspace/research-schedule";
const transition = (action: "activate" | "pause", description: string): Definition => ({
  method: "POST",
  route: `${scheduleRoute}/${action}`,
  cli: { operation: action },
  rpc: `${action}_lifty_research_schedule`,
  query: Empty,
  request: ExpectedVersionSchema,
  invalid: { status: 400, code: "INVALID_REQUEST" },
  response: ResearchScheduleSchema,
  unavailable: schedule,
  args: ({ body }) => ({ p_payload: body }),
  description,
});
export const researchOperationDefinitions = {
  "research-schedule": {
    get: {
      method: "GET",
      route: scheduleRoute,
      rpc: "get_lifty_research_schedule",
      query: Empty,
      request: null,
      invalid: { status: 400, code: "INVALID_REQUEST" },
      response: ResearchScheduleSchema,
      unavailable: schedule,
      args: () => ({}),
      description:
        "Read the weekly research schedule: active or paused, weekly_target, this workspace's plan with its weekly research limit and, when the plan has one, its total and what is left of it, and the effective target (the weekly target capped by the limit and by what was left of the total when the week began). Until the founder sets a number, weekly_target follows the plan and reads as its limit. Every workspace has one from creation, paused at version 0.",
    },
    patch: {
      method: "PATCH",
      route: scheduleRoute,
      rpc: "patch_lifty_research_schedule",
      query: Empty,
      request: ResearchSchedulePatchSchema,
      invalid: { status: 422, code: "TARGET_INVALID" },
      response: ResearchScheduleSchema,
      unavailable: schedule,
      args: ({ body }) => ({ p_payload: body }),
      description:
        "Synchronously change weekly_target with expected_version: a number from 1 up to the limit, or null to follow the plan's full limit again, including later plan changes. It applies to the current week; people already completed or reserved stay counted. A target above the weekly research limit returns TARGET_ABOVE_LIMIT with the limit. Does not activate research.",
    },
    activate: transition(
      "activate",
      "Activate weekly research with expected_version. Requires saved targeting and research criteria; does not require a sample, CRM or outreach. Research starts from the next platform cycle within the remaining weekly volume. Repeating the current state returns it unchanged. Never activates outreach.",
    ),
    pause: transition(
      "pause",
      "Pause weekly research with expected_version. No new people are admitted; research already in progress finishes and its results stay. Repeating the current state returns it unchanged. Does not change outreach, CRM or the sample.",
    ),
    status: {
      method: "GET",
      route: `${scheduleRoute}/status`,
      cli: { operation: "status" },
      rpc: "get_lifty_research_status",
      query: ResearchStatusQuerySchema,
      request: null,
      invalid: { status: 400, code: "INVALID_REQUEST" },
      response: ResearchStatusSchema,
      unavailable: {
        code: "RESEARCH_STATUS_UNAVAILABLE",
        message: "Weekly research status could not be read. Retry; this is not zero or paused.",
      },
      args: ({ query }) => ({ p_week: query.week ?? null }),
      description:
        "Read one Monday-to-Monday UTC week (default: the current week): completed and qualified people, reservations, remaining volume, a per-day breakdown that adds up to completed, the reset time and, for a closed week under target that the workspace existed for in full, the shortfall reason (paused when the schedule was paused at any time in the week).",
    },
  },
  leads: {
    list: {
      method: "GET",
      route: "/v1/workspace/leads",
      cli: { operation: "get" },
      rpc: "list_lifty_leads",
      query: LeadsQuerySchema,
      request: null,
      invalid: { status: 400, code: "INVALID_REQUEST" },
      response: LeadsPageSchema,
      unavailable: {
        code: "LEADS_UNAVAILABLE",
        message: "Researched leads could not be read. Retry with the same cursor.",
      },
      args: ({ query }) => ({ p_query: query }),
      description:
        "List researched people, newest first: grade, fit rationale, research time and a dashboard link. Filter by grade and by the Monday of the week their first research completed; page with next_cursor. Read-only; detail and feedback live in the dashboard.",
    },
  },
} satisfies Record<string, Record<string, Definition>>;

export const researchEntries = () =>
  Object.entries(researchOperationDefinitions).flatMap(([resource, operations]) =>
    Object.entries(operations).map(([action, definition]) => ({
      key: `${resource}.${action}`,
      resource,
      action,
      definition: definition as Definition,
    })),
  );

/** Zod at the boundary; repair issues carry the failing path and a suggestion. */
export function validateResearchInput(
  schema: z.ZodType,
  input: unknown,
  invalid: Definition["invalid"],
) {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new PublicError({
    status: invalid.status,
    code: invalid.code,
    message: "Repair these fields using the current operation schema.",
    issues: parsed.error.issues.slice(0, 20).map((issue) => ({
      code: issue.code === "custom" ? "invalid_value" : `schema_${issue.code}`,
      path: `/${issue.path.map((part) => String(part).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`,
      message: "This field does not match the current operation contract.",
      suggestion:
        issue.code === "custom"
          ? issue.message
          : issue.code === "unrecognized_keys"
            ? "Remove fields absent from the published operation schema."
            : "Use the field type and bounds shown in the current operation schema.",
    })),
  });
}

export async function executeResearchOperation(
  session: AuthSession,
  key: string,
  input: Input,
  dashboardOrigin: string,
): Promise<unknown> {
  const entry = researchEntries().find((item) => item.key === key);
  if (!entry) throw new Error("Unknown research operation");
  const { definition } = entry;
  const unavailable = { operation: definition.rpc, ...definition.unavailable };
  let result: { data: unknown; error: unknown };
  try {
    result = await (
      session.client as {
        rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }>;
      }
    ).rpc(definition.rpc, { p_workspace_id: session.workspaceRef ?? null, ...definition.args(input) });
  } catch (cause) {
    throw rpcFailure(cause, unavailable);
  }
  if (result.error) throw rpcFailure(result.error, unavailable);
  // A response that cannot be verified is unknown, never zero or paused.
  const unknown = () =>
    new PublicError({ status: 502, code: unavailable.code, message: unavailable.message });
  if (key === "leads.list") {
    const rows = LeadsRowsSchema.safeParse(result.data);
    if (!rows.success) throw unknown();
    return LeadsPageSchema.parse({
      next_cursor: rows.data.next_cursor,
      items: rows.data.items.map((item) => ({
        ...item,
        research_url: `${dashboardOrigin}/protected/leads/${item.lead_ref}`,
      })),
    });
  }
  const parsed = definition.response.safeParse(result.data);
  if (!parsed.success) throw unknown();
  return parsed.data;
}
