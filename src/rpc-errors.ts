import { z } from "zod";
import { RepairIssueSchema } from "./business-contracts.js";
import { PublicError, type PublicErrorOptions } from "./errors.js";

// The one public vocabulary for typed database errors. RPCs raise the code as
// the exception message with errcode PT4xx and optional JSON detail; the PT
// code chooses the HTTP status. A code missing here never reaches a customer:
// it becomes the operation's 502 "unavailable" error and stays in the logs.
export const RPC_ERROR_MESSAGES: Record<string, string> = {
  INVALID_REQUEST: "Repair the request using the current operation schema.",
  WORKSPACE_FORBIDDEN: "You do not belong to this workspace.",
  WORKSPACE_SELECTION_REQUIRED:
    "You belong to several workspaces. Choose one with the x-lifty-workspace header (lifty use <workspace> in the CLI).",
  WORKSPACE_SUSPENDED: "This workspace is suspended. Contact LIFT support.",
  WORKSPACE_NOT_READY: "Create a workspace before continuing.",
  VERSION_CONFLICT:
    "The resource changed. Read its current version and apply your intended edit again.",
  VERSION_REQUIRED: "Supply the current expected_version from a resource read.",
  // Business resources (LIF-1173).
  ALREADY_CONFIGURED:
    "This workspace already has a setup from another draft version.",
  SETUP_ALREADY_SUBMITTED: "The submitted setup draft is immutable.",
  SETUP_STALE:
    "The profile or Scout base changed. Read setup context and generate fresh criteria.",
  PROFILE_CONFIRMATION_REQUIRED:
    "Confirm the value proposition, offerings and problems solved before submitting setup.",
  SETUP_REQUIRED: "Complete initial setup before editing targeting.",
  TARGETING_LANE_UNKNOWN:
    "This lane is absent from the current targeting. Read the lane ids, or omit id to add a lane.",
  CRITERIA_REGENERATION_REQUIRED:
    "Persona changes need regenerated criteria and its expected_version in the same request.",
  PROFILE_INVALID: "Repair the commercial profile fields.",
  TARGETING_INVALID: "Repair the targeting fields.",
  CRITERIA_INVALID: "Repair the Scout criteria fields.",
  VOICE_INVALID: "Repair the voice fields.",
  SETUP_DRAFT_INVALID: "Repair the setup draft fields.",
  SETUP_INVALID:
    "Complete the setup gates and generated criteria before submission.",
  // Research schedule and weekly volume (LIF-1174).
  TARGET_INVALID: "Choose a whole-number weekly target of at least 1.",
  TARGET_ABOVE_LIMIT:
    "The weekly target is above this workspace's weekly research limit. Choose a target up to the returned limit.",
  RESEARCH_NOT_CONFIGURED:
    "Save targeting and research criteria before activating weekly research.",
  WEEK_NOT_MONDAY: "Choose a week by its Monday (UTC) in YYYY-MM-DD form.",
  RESEARCH_LIMIT_REACHED:
    "This week's research limit has fewer than five people left for a sample. Start it again after the returned reset time.",
  // Senders and sending accounts (LIF-1182).
  SENDER_INVALID: "Repair the sender fields.",
  SENDER_NOT_FOUND: "This sender is not available in the selected workspace. Read senders for current ids.",
  CAMPAIGN_RESUME_ACCOUNT_BLOCKED: "Reconnect the same LinkedIn account and resume its usage first. Sending holds and unverified health must be resolved before resuming campaigns.",
  ACCOUNT_NOT_FOUND: "This sending account is not available in the selected workspace. Read sending-accounts for current ids.",
  ACCOUNT_DISCONNECTED: "This account is disconnected. Reconnect it before resuming or changing it.",
  LINKEDIN_ALREADY_CONNECTED: "This sender already has a LinkedIn account. Reconnect that account instead of connecting another.",
  CONNECTION_ATTEMPT_NOT_FOUND: "This connection attempt is not available in the selected workspace.",
  CONNECT_UNAVAILABLE: "Lifty cannot open a sign-in for this account right now. Try again later or contact LIFT support.",
  OUTREACH_INVALID: "Repair the audience, start rules or campaign fields using the current schema.",
  OUTREACH_RESOURCE_FORBIDDEN: "This outreach resource is unavailable in the selected workspace.",
  OUTREACH_REVISION_MISMATCH: "Read the resource and use its exact revision and digest.",
  OUTREACH_APPROVAL_REQUIRED: "Publish the exact chosen revision before activating it.",
  OUTREACH_CONFIGURATION_REQUIRED: "Activate the approved Journey and the Campaign that starts it; the executable version is derived from them.",
  OUTREACH_CUSTOMER_LIST_NOT_CURRENT: "An enabled CRM customer source is missing or out of date. Read customer-exclusions status for its crm_refresh reason and repair that source; activate again once it is current. The founder can explicitly choose file-only or neither instead. Saved exclusions and started Journeys remain protected.",
  OUTREACH_HISTORICAL_RETIRED: "This draft belongs to retired outreach. Its history remains available, but it cannot be edited, approved, retried, skipped or rewritten.",
  OUTREACH_MESSAGE_MOVED: "This message is no longer the exact unapproved draft you read. Read its current review state before retrying.",
  OUTREACH_SEND_UNCONFIRMED: "This message has begun, unknown or confirmed sending work. Read its saved evidence before changing it; repeating a send could duplicate it.",
  OUTREACH_TARGET_STOPPED: "Outreach has stopped for this person. Read its current state before reviewing more messages.",
  OUTREACH_REPLY_MOVED: "This reply turn changed or was already answered. Read its current state before deciding again.",
  OUTREACH_SETTINGS_MOVED: "Review settings changed since you read them. Read the current settings and apply your change again.",
  OUTREACH_REPLY_ROUTE_UNAVAILABLE: "The original reply account or conversation could not be verified. Read its status before sending.",
  OUTREACH_ACCOUNT_UNAVAILABLE: "The saved account is not ready to send. Check its status in Senders before trying again.",
  OUTREACH_APPROACH_UNAVAILABLE: "This message's approved writing approach is no longer available. Read its Campaign before approving it.",
  OUTREACH_SENDER_UNAVAILABLE: "The person or sending account saved for this message could not be verified. Read its exact assignment before approving it.",
  OUTREACH_TEMPLATE_UNAVAILABLE: "This message's saved template could not be verified. Read its Campaign and saved revision before approving it.",
  OUTREACH_MESSAGE_SIGNATURE_UNAVAILABLE: "This draft has no exact saved person/signature version. Restore that provenance before correcting it; current Identity cannot substitute.",
  OUTREACH_REQUEST_CONFLICT: "This request reference already records another payload. Recover its saved test or use a new reference for a new request.",
  OUTREACH_BASELINE_UNAVAILABLE: "Choose a completed saved test from this campaign as the baseline.",
  OUTREACH_SAMPLE_UNAVAILABLE: "This sample lacks saved research. Choose researched leads before testing.",
  OUTREACH_SAMPLE_SENDER_CONFLICT: "The saved sample person is not permitted by this revision. Preserve that person and repair the permitted senders.",
  OUTREACH_COPY_INVALID: "Repair the saved message content using the campaign schema.",
  OUTREACH_SENDER_CONFLICT: "The lead's assigned person is not permitted for this campaign. Preserve its assignment and resolve the conflict.",
  // CRM preferences (LIF-1239).
  CRM_NOT_SELECTED: "This workspace has no CRM connected. Connect one before choosing what Lifty writes to it.",
  CRM_PREFERENCES_INVALID: "Repair the CRM preferences using the current operation schema.",
  // CRM counting rules (LIF-1477).
  CRM_RULES_INVALID: "Repair the CRM counting rules using the current operation schema.",
  CUSTOMER_EXCLUSIONS_INVALID: "Repair the customer CSV using the current import schema.",
  CUSTOMER_EXCLUSIONS_TOO_LARGE: "The customer list exceeds the import limit. Use the current CSV size and row limits.",
  CUSTOMER_EXCLUSIONS_REVISION_CONFLICT: "This import revision already records different customer data. Read status and import the intended file again.",
  CUSTOMER_SOURCE_CHOICE_INVALID: "Choose the current CRM provider and authorized sources, or choose file/none with a null provider and no CRM sources.",
  CUSTOMER_SOURCE_CHOICE_MOVED: "The customer-source choice changed. Read its current version and save only the founder's intended choice again.",
  // Calibration sample runs.
  RUN_NOT_CONFIGURED:
    "Save targeting and research criteria before starting the sample.",
  RUN_ALREADY_COMPLETED:
    "The sample for the current targeting is complete. Read it instead of starting another.",
  RUN_UNAVAILABLE:
    "Lifty cannot start research for this workspace right now. Contact LIFT support.",
  RUN_IN_PROGRESS:
    "Another research run is in progress for this workspace. Start the sample after it finishes.",
  RUN_NOT_FOUND: "This research run is unavailable in the selected workspace.",
  RUN_NOT_REVIEWABLE: "Only a finished sample can be confirmed. Wait for it to finish, then confirm it.",
  RUN_PROGRESS_UNAVAILABLE:
    "Research progress is unavailable for the selected workspace or sample.",
  // Operator acquisition recovery (admin HTTP route, not in the catalog).
  ACQUISITION_FORBIDDEN: "Recovery is limited to LIFT operators for a first run of this workspace.",
  ACQUISITION_STALE: "The acquisition changed. Read recovery status and use its exact current reference.",
  ACQUISITION_PARENT_HISTORY_INCOMPLETE:
    "Earlier task attempts cannot be verified completely; this acquisition remains blocked.",
  ACQUISITION_NOT_RECOVERABLE: "This first run has no failed acquisition that can be verified for recovery.",
  ACQUISITION_IN_PROGRESS: "Acquisition work is still active. It must finish before a restart can be verified.",
  RECOVERY_RESTART_REQUIRED: "This acquisition has ended. Use the explicit recovery restart with its current reference.",
};

// Lower-case tokens raised by the shared database workspace resolver
// (private.lifty_pick_workspace / lifty_business_workspace). Mapped by value,
// never by route.
const DATABASE_TOKENS: Record<string, string> = {
  UNAUTHENTICATED: "UNAUTHORIZED",
  LIFTY_WORKSPACE_AMBIGUOUS: "WORKSPACE_SELECTION_REQUIRED",
  LIFTY_WORKSPACE_FORBIDDEN: "WORKSPACE_FORBIDDEN",
  LIFTY_WORKSPACE_MISSING: "WORKSPACE_NOT_READY",
};

const STATUS = new Set([400, 401, 403, 404, 409, 413, 422, 429, 503]);
const DatabaseError = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
  details: z.string().nullable().optional(),
});
const Detail = z.object({
  issues: z.array(RepairIssueSchema).max(20).optional().catch(undefined),
  current_version: z.number().int().nonnegative().optional().catch(undefined),
  stale_sources: z
    .array(z.enum(["profile", "draft", "base"]))
    .max(3)
    .optional()
    .catch(undefined),
  workspaces: z
    .array(z.object({ workspace_ref: z.uuid(), name: z.string(), slug: z.string() }).strip())
    .max(200)
    .optional()
    .catch(undefined),
  limit: z.number().int().positive().optional().catch(undefined),
  resets_at: z.iso.datetime({ offset: true }).optional().catch(undefined),
});

export interface Unavailable {
  /** RPC name, logged for operators; never returned to the caller. */
  operation: string;
  code: string;
  message: string;
}

type DetailFields = Pick<PublicErrorOptions, "issues" | "current_version" | "stale_sources" | "workspaces" | "limit" | "resets_at">;
// Only validated, documented fields pass; raw database detail never does.
function detailOf(details: string | null | undefined): DetailFields {
  let value: unknown;
  try { value = JSON.parse(details ?? "{}"); } catch { return {}; }
  const parsed = Detail.safeParse(value);
  if (!parsed.success) return {};
  return Object.fromEntries(Object.entries(parsed.data).filter(([, item]) => item !== undefined)) as DetailFields;
}

/** Map a PostgREST/RPC failure (or a thrown transport error) to the public envelope. */
export function rpcFailure(error: unknown, unavailable: Unavailable): PublicError {
  const parsed = DatabaseError.safeParse(error);
  const raw = parsed.success ? parsed.data : {};
  const upstream = raw.code && /^(?:[A-Z0-9]{5}|PGRST[0-9]{3})$/.test(raw.code) ? raw.code : undefined;
  const token = (raw.message ?? "").trim().toUpperCase();
  const code = DATABASE_TOKENS[token] ?? token;
  const status = upstream?.startsWith("PT") ? Number(upstream.slice(2)) : null;
  if (upstream === "PT401" || upstream === "PGRST301" || upstream === "PGRST303" || code === "UNAUTHORIZED") {
    return new PublicError({ status: 401, code: "UNAUTHORIZED", message: "A valid Lifty session is required.", cause: error });
  }
  if (status !== null && STATUS.has(status) && Object.hasOwn(RPC_ERROR_MESSAGES, code)) {
    const detail = detailOf(raw.details);
    return new PublicError({ status, code, message: RPC_ERROR_MESSAGES[code]!, cause: error, ...detail });
  }
  return new PublicError({
    status: 502,
    code: unavailable.code,
    message: unavailable.message,
    cause: error,
    diagnostics: {
      upstream_operation: unavailable.operation,
      ...(upstream ? { upstream_code: upstream } : {}),
      upstream_kind: upstream === "XX001" ? "database_storage" : upstream === "57014" ? "database_timeout" : upstream ? "database_error" : "transport",
    },
  });
}
