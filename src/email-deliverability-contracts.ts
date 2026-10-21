import { z } from "zod";

// LIF-1042: one read contract for the Deliverability page and `lifty email
// deliverability`. The database read (LIF-1041, deliverability-source.v1)
// authorizes and projects stored evidence; this API turns it into states,
// reasons and freshness once, so neither consumer recalculates health or gates.

export const DELIVERABILITY_SCHEMA_VERSION = "email-deliverability.v1";
export const DELIVERABILITY_SOURCE_CONTRACT = "deliverability-source.v1";

const Uuid = z.uuid();
// Inbox refs are md5-derived identifiers in UUID layout, not RFC 4122 UUIDs.
const Ref = z.guid();
const Timestamp = z.iso.datetime({ offset: true });
const Day = z.iso.date();
const WorkspaceKey = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const Email = z.string().min(3).max(254).regex(/^[^\s@]+@[^\s@]+$/);
const Code = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const Count = z.number().int().min(0).max(1_000_000);
const Pct = z.number().min(0).max(100);
const Text = (max: number) => z.string().min(1).max(max);
const Cursor = z.string().max(1400).regex(/^[A-Za-z0-9_-]+$/);

// Query parameters arrive as strings; digits are parsed only when exact.
const QueryInt = (min: number, max: number, fallback: number) =>
  z.union([z.number(), z.string().regex(/^[0-9]{1,3}$/).transform(Number)]).pipe(z.number().int().min(min).max(max)).default(fallback);

export const DELIVERABILITY_HISTORY_DEFAULT = 3;
export const DELIVERABILITY_HISTORY_MAX = 8;
/** Provider placement reports resolved per detail request. */
export const DELIVERABILITY_DETAIL_MAX_REPORTS = 3;

export const DeliverabilityQuery = z.object({
  workspace: WorkspaceKey.optional(),
  scope: z.enum(["workspace", "fleet"]).default("workspace"),
  sender: z.union([z.literal("unassigned"), Uuid]).optional(),
  mailbox: z.union([Ref, Email]).optional(),
  history_limit: QueryInt(1, DELIVERABILITY_HISTORY_MAX, DELIVERABILITY_HISTORY_DEFAULT),
  limit: QueryInt(1, 100, 50),
  cursor: Cursor.optional(),
  detail: z.literal("placement").optional(),
}).strict()
  .refine(query => query.scope === "fleet" || query.workspace !== undefined,
    { message: "Choose a workspace, or request the fleet explicitly.", path: ["workspace"] })
  .refine(query => query.detail === undefined || (query.mailbox !== undefined && Ref.safeParse(query.mailbox).success),
    { message: "Placement detail needs one mailbox_ref.", path: ["mailbox"] });
export type DeliverabilityQuery = z.output<typeof DeliverabilityQuery>;
export type DeliverabilityQueryInput = z.input<typeof DeliverabilityQuery>;
/** OpenAPI description of the same query string (the parser above is authoritative). */
export const DeliverabilityQueryParams = z.object({
  workspace: z.string().optional().describe("Workspace slug or id. Required unless scope=fleet."),
  scope: z.enum(["workspace", "fleet"]).optional().describe("fleet requires the server-side LIFT admin role."),
  sender: z.string().optional().describe("Sender ref, or unassigned for inboxes without a sender."),
  mailbox: z.string().optional().describe("mailbox_ref or address. detail=placement needs a mailbox_ref."),
  history_limit: z.string().optional().describe("Placement attempts per inbox, 1-8 (default 3)."),
  limit: z.string().optional().describe("Inboxes per page, 1-100 (default 50)."),
  cursor: z.string().optional().describe("next_cursor from the previous page."),
  detail: z.enum(["placement"]).optional().describe("Resolve stored provider reports for up to three recent tests of one inbox."),
});

// ------------------------------------------------------------------ source
// Lenient on additions (unknown keys are stripped) and strict on the fields
// this API reads, so a newer database cannot leak new fields outward.

const SourceCounts = z.object({
  inbox: Count.nullish(), spam: Count.nullish(), other: Count.nullish(), missing: Count.nullish(), total: Count.nullish(),
});
const SourceTest = z.object({
  provider: z.string().max(40),
  test_ref: z.string().min(1).max(200),
  provider_test_ref: z.string().max(200).nullish(),
  placement_ref: Uuid.nullish(),
  connection_ref: Uuid.nullish(),
  source: z.enum(["smartlead_result", "lifty_request", "lifty_evidence"]),
  name: z.string().max(500).nullish(),
  execution_status: z.string().max(40),
  passed: z.boolean().nullish(),
  tested_at: Timestamp,
  completed_at: Timestamp.nullish(),
  failure_code: z.string().max(200).nullish(),
  policy_version: z.string().max(200).nullish(),
  counts: SourceCounts.nullish(),
  families: z.object({ gmail: SourceCounts.nullish(), o365: SourceCounts.nullish(), overall: SourceCounts.nullish() }).nullish(),
});
export type SourceTest = z.infer<typeof SourceTest>;

const SourceControl = z.object({
  scope_key: z.string().max(300), send_paused: z.boolean(), capture_paused: z.boolean(), updated_at: Timestamp.nullish(),
});
const SourceConnection = z.object({
  connection_ref: Uuid,
  provider: z.string().max(40),
  status: z.string().max(40),
  sender_ref: Uuid.nullish(),
  mailbox_use: z.enum(["personal", "outreach"]).nullish(),
  lifty_mailbox_ref: Uuid.nullish(),
  daily_send_limit: Count.nullish(),
  health_checked_at: Timestamp.nullish(),
  created_at: Timestamp,
  updated_at: Timestamp.nullish(),
  send_block_reason: z.string().max(300).nullish(),
  // Only the common strict database gate can establish an all-clear.
  send_gate_known: z.boolean().optional(),
  mailbox_ready: z.boolean().nullish(),
  controls: z.array(SourceControl).max(50).default([]),
  holds: z.array(z.object({ reason: z.string().max(200), updated_at: Timestamp.nullish() })).max(50).default([]),
});
export type SourceConnection = z.infer<typeof SourceConnection>;

// LIF-1341: the send budget's figures for this inbox in this workspace. used,
// available and ambiguous are null when the inbox is also another workspace's.
const SourceSending = z.object({
  limit: Count.nullish(),
  used: Count.nullish(),
  available: Count.nullish(),
  ambiguous: z.boolean().nullish(),
  shared: z.boolean().nullish(),
  timezone: z.string().max(64).nullish(),
  day_started_at: Timestamp.nullish(),
  resets_at: Timestamp.nullish(),
});
export type SourceSending = z.infer<typeof SourceSending>;

const SourceMailiverySnapshot = z.object({
  spf: z.string().max(64).nullish(), dmarc: z.string().max(64).nullish(), mx: z.string().max(64).nullish(),
  emails_sent_today: Count.nullish(), email_per_day_target: Count.nullish(), connection_problem: z.boolean().nullish(),
});
const SourceMailivery = z.object({
  connection_ref: Uuid,
  binding: z.object({
    binding_ref: Uuid, state: z.string().max(40), requested_action: z.string().max(40).nullish(),
    blocking_reason: z.string().max(64).nullish(), provider_campaign_bound: z.boolean().nullish(),
    last_readback_at: Timestamp.nullish(), snapshot: SourceMailiverySnapshot.nullish(),
    created_at: Timestamp, removed_at: Timestamp.nullish(),
  }).nullish(),
  evidence: z.object({
    observed_at: Timestamp, started_at: Timestamp.nullish(), active_duration_days: Count.nullish(),
    healthy: z.boolean().nullish(), passed: z.boolean().nullish(),
  }).nullish(),
  outreach_unlocked: z.boolean().nullish(),
});
export type SourceMailivery = z.infer<typeof SourceMailivery>;

const SourceCampaign = z.object({
  source: z.literal("lifty_direct_email"), connection_ref: Uuid, campaign_count: Count,
  states: z.record(z.string().max(40), Count), latest_created_at: Timestamp.nullish(),
});
export type SourceCampaign = z.infer<typeof SourceCampaign>;

const SourceMailbox = z.object({
  mailbox_ref: Ref,
  workspace_ref: Uuid,
  email: Email,
  domain: z.string().max(253),
  senders: z.array(z.object({ sender_ref: Uuid, name: z.string().max(200) })).max(50),
  identity: z.object({ status: z.enum(["resolved", "ambiguous_owner", "unassigned"]) }),
  connections: z.array(SourceConnection).max(50),
  // Added by LIF-1341; absent from earlier databases.
  sending: SourceSending.nullish(),
  warmup: z.object({
    mailivery: z.array(SourceMailivery).max(50).default([]),
  }),
  placement: z.object({
    test_count: Count,
    recent_tests: z.array(SourceTest).max(DELIVERABILITY_HISTORY_MAX),
    latest_test_ref: z.string().max(200).nullish(),
    latest_completed_test_ref: z.string().max(200).nullish(),
    latest_completed_test: SourceTest.nullish(),
  }),
  campaigns: z.array(SourceCampaign).max(200),
  availability: z.object({
    mailivery_warmup: z.boolean(), placement_tests: z.boolean(),
  }),
});
export type SourceMailbox = z.infer<typeof SourceMailbox>;

const SourceWorkspace = z.object({
  workspace_ref: Uuid, slug: z.string().max(100), name: z.string().max(200), is_active: z.boolean(),
});
export const DeliverabilitySource = z.object({
  contract: z.literal(DELIVERABILITY_SOURCE_CONTRACT),
  generated_at: Timestamp,
  scope: z.object({ kind: z.enum(["workspace", "fleet"]), workspace_ref: Uuid.nullish(), workspace_slug: z.string().max(100).nullish() }),
  query: z.object({ sender: z.string().max(40).nullish(), mailbox: z.string().max(254).nullish(), history_limit: z.number().int(), limit: z.number().int() }),
  filters: z.object({
    workspaces: z.array(SourceWorkspace).max(1000),
    senders: z.array(z.object({ sender_ref: Uuid, workspace_ref: Uuid, name: z.string().max(200), mailbox_count: Count })).max(5000),
    unassigned_count: Count,
  }),
  workspace_health: z.array(SourceWorkspace.extend({
    posture: z.object({
      status: z.string().max(40), source: z.string().max(80).nullish(), captured_at: Timestamp,
      client_label: z.string().max(200).nullish(), metrics: z.unknown().nullish(),
    }).nullish(),
  })).max(1000),
  mailboxes: z.array(SourceMailbox).max(100),
  total_count: Count,
  next_cursor: Cursor.nullish(),
});
export type DeliverabilitySource = z.infer<typeof DeliverabilitySource>;

// ---------------------------------------------------------------- response

export const Tone = z.enum(["ok", "watch", "warn", "bad", "muted"]);
export const Freshness = z.enum(["fresh", "stale", "unknown", "not_applicable"]);
export const Reason = z.object({ code: Code, message: Text(400) }).strict();
export type Reason = z.infer<typeof Reason>;
/** Every state carries its own explanation; the tooltip and the agent read the same text. */
const state = <T extends readonly [string, ...string[]]>(codes: T) => z.object({
  code: z.enum(codes), label: Text(120), tone: Tone, description: Text(600), reasons: z.array(Reason).max(20),
}).strict();
export type State<C extends string = string> = { code: C; label: string; tone: z.infer<typeof Tone>; description: string; reasons: Reason[] };

const Evidence = z.object({ observed_at: Timestamp.nullable(), freshness: Freshness, fresh_until: Timestamp.nullable() }).strict();
const Counts = z.object({ inbox: Count.nullable(), spam: Count.nullable(), other: Count.nullable(), missing: Count.nullable(), total: Count.nullable() }).strict();
const Provider = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/);

export const MailboxStatusCode = ["retired", "paused", "placement_failed", "blocked_in_campaign", "warmup_problem", "needs_approval",
  "placement_due", "in_campaign", "ready_idle", "warming", "no_known_blocker", "not_ready", "no_evidence"] as const;
export const ReadinessCode = ["ready", "partially_ready", "blocked", "no_known_blocker", "unknown"] as const;
export const PathCode = ["allowed", "blocked", "no_known_blocker", "unknown"] as const;
export const WarmupCode = ["active", "paused", "pending", "problem", "not_running", "unknown", "none"] as const;
export const PlacementCode = ["passed", "failed", "stale", "no_result", "no_tests"] as const;
export const CampaignSummaryCode = ["in_campaign_enabled", "in_campaign_blocked", "campaign_paused", "no_campaign", "unverified"] as const;
export const CampaignCode = ["active", "paused", "draft", "closed_to_new_leads", "completed", "archived", "error", "unknown"] as const;
export const IdentityCode = ["resolved", "ambiguous_owner", "unassigned"] as const;
export const SendingCode = ["available", "limit_reached", "not_set", "unknown"] as const;
export const PostureCode = ["healthy", "watch", "degraded", "critical", "insufficient_data", "unknown", "none"] as const;

export const PlacementTest = z.object({
  test_ref: z.string().min(1).max(200),
  provider: Provider,
  source: z.enum(["smartlead_result", "lifty_request", "lifty_evidence"]),
  name: z.string().max(500).nullable(),
  execution_status: z.enum(["pending", "running", "completed", "error", "unknown"]),
  execution_reason: Reason.nullable(),
  verdict: z.enum(["pass", "fail", "unknown"]),
  label: Text(160),
  tested_at: Timestamp,
  completed_at: Timestamp.nullable(),
  age_days: z.number().int().min(0).max(100_000),
  policy_version: z.string().max(200).nullable(),
  counts: Counts.nullable(),
  families: z.object({ gmail: Counts.nullable(), outlook: Counts.nullable() }).strict().nullable(),
  detail_available: z.boolean(),
}).strict();
export type PlacementTest = z.infer<typeof PlacementTest>;

const Breakdown = z.object({ provider: z.enum(["gmail", "outlook", "other"]), inbox: Count.nullable(), spam: Count.nullable(),
  other: Count.nullable(), missing: Count.nullable(), total: Count.nullable() }).strict();
const AuthTally = z.object({ pass: Count, total: Count }).strict();
export const PlacementDetail = z.object({
  test_ref: z.string().min(1).max(200),
  status: z.enum(["ok", "no_report", "not_configured", "unavailable"]),
  message: Text(300),
  providers: z.array(Breakdown).max(3),
  auth: z.object({ spf: AuthTally, dkim: AuthTally, dmarc: AuthTally }).strict().nullable(),
  blacklisted: z.boolean().nullable(),
}).strict();
export type PlacementDetail = z.infer<typeof PlacementDetail>;

const WarmupMetrics = z.object({
  warmup_emails_today: Count.nullable(), ramp_target: Count.nullable(),
}).strict();
const Check = z.enum(["valid", "not_valid", "unknown"]);
export const WarmupSource = z.object({
  provider: z.literal("mailivery"),
  connection_ref: Uuid.nullable(),
  state: state(WarmupCode),
  started_at: Timestamp.nullable(),
  started_at_basis: z.literal("provider_evidence").nullable(),
  active_days: z.number().int().min(0).max(100_000).nullable(),
  required_days: z.number().int().min(1).max(365).nullable(),
  period_complete: z.boolean().nullable(),
  estimated_completion: z.object({ at: Timestamp.nullable(), on: Day.nullable(), basis: Text(300) }).strict().nullable(),
  outreach_unlocked: z.boolean().nullable(),
  last_check: Evidence,
  metrics: WarmupMetrics,
  checks: z.object({ spf: Check, dmarc: Check, mx: Check }).strict().nullable(),
  provider_detail: z.string().max(1000).nullable(),
}).strict();
export type WarmupSource = z.infer<typeof WarmupSource>;

const Path = z.object({
  provider: Provider, connection_ref: Uuid.nullable(),
  gate: z.enum(["strict_sender_checks", "unknown"]),
  state: state(PathCode),
}).strict();

export const Campaign = z.object({
  source: z.literal("lifty_direct_email"),
  connection_ref: Uuid.nullable(),
  provider: Provider,
  campaign_count: Count,
  states: z.record(z.string().max(40), Count),
  status: state(CampaignCode),
  sending: state(["enabled", "blocked", "not_active", "unverified"] as const),
  created_at: Timestamp.nullable(),
}).strict();
export type Campaign = z.infer<typeof Campaign>;

export const Connection = z.object({
  connection_ref: Uuid,
  provider: Provider,
  status: z.string().max(40),
  sender_ref: Uuid.nullable(),
  mailbox_use: z.enum(["personal", "outreach"]).nullable(),
  daily_send_limit: Count.nullable(),
  health_checked_at: Timestamp.nullable(),
  created_at: Timestamp,
  send_gate: state(PathCode),
  controls: z.array(z.object({ scope: z.enum(["global", "workspace", "channel", "sender", "connection", "other"]),
    send_paused: z.boolean(), capture_paused: z.boolean(), updated_at: Timestamp.nullable() }).strict()).max(50),
  holds: z.array(z.object({ reason: z.string().max(200), updated_at: Timestamp.nullable() }).strict()).max(50),
}).strict();

/** Today's sends against the inbox's daily limit: the send budget's own figures, never estimated. */
export const Sending = z.object({
  state: state(SendingCode),
  limit: Count.nullable(),
  used_today: Count.nullable(),
  remaining_today: Count.nullable(),
  timezone: z.string().max(64).nullable(),
  day_started_at: Timestamp.nullable(),
  resets_at: Timestamp.nullable(),
}).strict();

export const DeliverabilityMailbox = z.object({
  mailbox_ref: Ref,
  workspace: z.object({ workspace_ref: Uuid, slug: z.string().max(100).nullable(), name: z.string().max(200).nullable() }).strict(),
  email: Email,
  domain: z.string().max(253),
  senders: z.array(z.object({ sender_ref: Uuid, name: z.string().max(200) }).strict()).max(50),
  identity: state(IdentityCode),
  /** Canonical physical account selected by the shared identity read. Null means unconfirmed. */
  account: z.object({
    connection_ref: Uuid,
    status: z.enum(["connected", "needs_reconnect", "disconnected"]),
    observation: z.enum(["verified", "unverified"]),
    checked_at: Timestamp.nullable(),
    outreach: state(["paused", "blocked", "enabled", "idle", "unknown"] as const),
  }).strict().nullable(),
  providers: z.object({ sending: z.array(Provider).max(5), warmup: z.array(Provider).max(5), placement: z.array(Provider).max(5) }).strict(),
  status: state(MailboxStatusCode),
  readiness: state(ReadinessCode).extend({ paths: z.array(Path).max(50) }).strict(),
  warmup: z.object({
    status: state(WarmupCode),
    sources: z.array(WarmupSource).max(50),
    current: WarmupSource.nullable(),
  }).strict(),
  campaigns: z.object({ status: state(CampaignSummaryCode), items: z.array(Campaign).max(200) }).strict(),
  placement: z.object({
    status: state(PlacementCode),
    evidence: Evidence.extend({ max_age_days: z.number().int().min(1).max(365).nullable(), rule: Text(300) }).strict(),
    test_count: Count,
    latest_test_ref: z.string().max(200).nullable(),
    latest_completed_test_ref: z.string().max(200).nullable(),
    latest_completed_test: PlacementTest.nullable(),
    recent_tests: z.array(PlacementTest).max(DELIVERABILITY_HISTORY_MAX),
    detail: z.array(PlacementDetail).max(DELIVERABILITY_DETAIL_MAX_REPORTS).nullable(),
  }).strict(),
  connections: z.array(Connection).max(50),
  sending: Sending,
  availability: z.object({ mailivery_warmup: z.boolean(), placement_tests: z.boolean() }).strict(),
}).strict();
export type DeliverabilityMailbox = z.infer<typeof DeliverabilityMailbox>;

export const WorkspaceHealth = z.object({
  workspace_ref: Uuid, slug: z.string().max(100), name: z.string().max(200),
  scope_note: Text(200),
  status: state(PostureCode),
  captured_at: Timestamp.nullable(),
  source: z.string().max(80).nullable(),
  components: z.object({ placement: z.string().max(40).nullable(), live: z.string().max(40).nullable(), lifecycle: z.string().max(40).nullable() }).strict(),
  placement: z.object({ gmail_inbox_pct: Pct.nullable(), office365_inbox_pct: Pct.nullable(), overall_spam_pct: Pct.nullable(),
    tested_at: Timestamp.nullable() }).strict(),
  sends: Count.nullable(),
}).strict();

export const DeliverabilityWarning = z.object({
  code: Code, source: z.enum(["placement_detail", "database"]), mailbox_ref: Ref.nullable(), message: Text(300),
}).strict();

export const DeliverabilityResponse = z.object({
  schema_version: z.literal(DELIVERABILITY_SCHEMA_VERSION),
  generated_at: Timestamp,
  scope: z.object({ kind: z.enum(["workspace", "fleet"]), workspace_ref: Uuid.nullable(), workspace_slug: z.string().max(100).nullable() }).strict(),
  query: z.object({ sender: z.string().max(40).nullable(), mailbox: z.string().max(254).nullable(), history_limit: z.number().int().min(1).max(8),
    limit: z.number().int().min(1).max(100), detail: z.literal("placement").nullable() }).strict(),
  filters: z.object({
    workspaces: z.array(z.object({ workspace_ref: Uuid, slug: z.string().max(100), name: z.string().max(200), is_active: z.boolean() }).strict()).max(1000),
    senders: z.array(z.object({ sender_ref: Uuid, workspace_ref: Uuid, name: z.string().max(200), mailbox_count: Count }).strict()).max(5000),
    unassigned_count: Count,
  }).strict(),
  workspace_health: z.array(WorkspaceHealth).max(1000),
  mailboxes: z.array(DeliverabilityMailbox).max(100),
  total_count: Count,
  next_cursor: Cursor.nullable(),
  warnings: z.array(DeliverabilityWarning).max(400),
}).strict();
export type DeliverabilityResponse = z.infer<typeof DeliverabilityResponse>;
