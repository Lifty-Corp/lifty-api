import { z } from "zod";

// LIF-1672, LIF-1770, LIF-1771: whether an account takes part in new Journeys,
// and the one place that turns its causes into words. The database decides the
// status, the cause and their order; this module says who acts and what to do.
// Senders, Deliverability, activation and the agent all read the same
// `next_step`, so a client renders it and never words a cause itself.
const Timestamp = z.iso.datetime({ offset: true });
const Count = z.number().int().nonnegative();

export const SendingScope = z.enum(["account", "sender", "channel", "workspace", "all_workspaces"]);

// What a LIFT admin picks from, then the call sites that stop an account on
// their own. Read strictly: a new code needs this API first, so a code nobody
// has worded never reaches a member.
export const StopPersonReason = z.enum(["deliverability_review", "account_safety", "setup", "client_request", "maintenance", "other"]);
export const StopReason = z.enum([...StopPersonReason.options, "cutover", "not_executed_by_lifty", "ambiguous_send",
  "provider_risk", "recipient_restricted", "recorded_before_lif1710", "unspecified"]);
export type StopReason = z.infer<typeof StopReason>;
export const StopOrigin = z.enum(["person", "system"]);
const Stop = z.object({ scope: SendingScope, origin: StopOrigin, reason: StopReason, review_by: Timestamp }).strict();
const HealthReason = z.enum(["complaint", "bounce_rate", "provider_health", "placement_failed", "safety_check_failed", "workspace_complaint"]);

const PARTICIPATION = {
  sending: ["active_journeys"],
  no_active_campaign: ["no_active_campaign_on_channel"],
  waiting_for_first_lead: ["no_lead_yet"],
  paused: ["paused_by_member", "paused_by_disconnect", "campaign_paused", "workspace_suspended", "sender_off", "sender_paused", "paused_by_lift"],
  not_connected: ["disconnected", "needs_reconnect", "unverified"],
  email_not_ready: ["warming", "placement_required", "declaration_required", "signature_missing", "mailbox_not_ready", "health_hold"],
} as const;
type ParticipationStatus = keyof typeof PARTICIPATION;
const participationStatuses = Object.keys(PARTICIPATION) as [ParticipationStatus, ...ParticipationStatus[]];
export type ParticipationCause = (typeof PARTICIPATION)[ParticipationStatus][number];
const participationCauses = Object.values(PARTICIPATION).flat() as [ParticipationCause, ...ParticipationCause[]];
const belongs = (value: { status: ParticipationStatus; cause: ParticipationCause }) =>
  (PARTICIPATION[value.status] as readonly string[]).includes(value.cause);

export const ParticipationOwner = z.enum(["member", "lifty", "none"]);
export const ParticipationAction = z.enum(["none", "wait", "lifty_review", "contact_lift", "reconnect", "resume_account", "resume_sender",
  "turn_on_sender", "resume_campaigns", "resume_campaign", "set_mailbox_use", "add_signature"]);
/**
 * The words and the action for one cause. `since_estimated` is null on a
 * secondary cause, which reports only `since`. `review_by` is the date Lifty
 * reviews a stop, and null once that date has passed.
 */
export const ParticipationNextStep = z.object({
  label: z.string().min(1).max(200),
  owner: ParticipationOwner,
  action: ParticipationAction,
  since: Timestamp.nullable(),
  since_estimated: z.boolean().nullable(),
  review_by: Timestamp.nullable(),
}).strict();
export type ParticipationNextStep = z.infer<typeof ParticipationNextStep>;

const Words = (label: string, short: string, owner: z.infer<typeof ParticipationOwner>, action: z.infer<typeof ParticipationAction>) =>
  ({ label, short, owner, action });
// `short` is how the same cause reads after a person's name: "Lee · warming".
const CAUSES: Record<ParticipationCause, ReturnType<typeof Words>> = {
  active_journeys: Words("Sending", "sending", "none", "none"),
  no_active_campaign_on_channel: Words("Connected · sends once a campaign is active", "no active campaign", "none", "none"),
  no_lead_yet: Words("Ready · sends once a lead reaches this channel", "ready", "none", "none"),
  paused_by_member: Words("Paused", "paused", "member", "resume_account"),
  sender_paused: Words("Sender paused", "sender paused", "member", "resume_sender"),
  sender_off: Words("Sender retired", "retired", "member", "turn_on_sender"),
  paused_by_disconnect: Words("Paused after a disconnect", "paused after a disconnect", "member", "resume_campaigns"),
  campaign_paused: Words("Campaign paused", "campaign paused", "member", "resume_campaign"),
  workspace_suspended: Words("Workspace paused", "workspace paused", "lifty", "contact_lift"),
  paused_by_lift: Words("Paused by Lifty", "paused by Lifty", "lifty", "lifty_review"),
  disconnected: Words("Disconnected", "disconnected", "member", "reconnect"),
  needs_reconnect: Words("Reconnect needed", "needs reconnecting", "member", "reconnect"),
  unverified: Words("Connection not verified yet", "connection not verified yet", "lifty", "wait"),
  warming: Words("Warming up", "warming", "lifty", "wait"),
  placement_required: Words("Needs an inbox placement test", "needs an inbox placement test", "lifty", "wait"),
  declaration_required: Words("Confirm how this mailbox is used", "mailbox use not confirmed", "member", "set_mailbox_use"),
  signature_missing: Words("Needs a signature", "signature missing", "member", "add_signature"),
  mailbox_not_ready: Words("Not ready to send yet", "not ready to send yet", "lifty", "wait"),
  health_hold: Words("On hold", "on hold", "lifty", "lifty_review"),
};

// A cause a member reads never names a vendor or an operator's note. `other`
// and `unspecified` show no reason at all.
const PLAIN_STOP_REASON: Record<StopReason, string | null> = {
  deliverability_review: "deliverability review",
  account_safety: "account safety", provider_risk: "account safety", ambiguous_send: "account safety", recipient_restricted: "account safety",
  setup: "setup", cutover: "setup", recorded_before_lif1710: "setup", not_executed_by_lifty: "setup",
  client_request: "at your request",
  maintenance: "maintenance",
  other: null, unspecified: null,
};
const PLAIN_HEALTH_REASON: Record<z.infer<typeof HealthReason>, string> = {
  complaint: "spam complaint", workspace_complaint: "spam complaint", bounce_rate: "too many bounces", safety_check_failed: "too many bounces",
  provider_health: "inbox health", placement_failed: "placement test failed",
};

const SHORT_DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
/** "Nov 14": the day a stop is reviewed or a mailbox clears, in UTC. */
export const shortDay = (value: string) => SHORT_DAY.format(new Date(value));

function stopStep(stop: z.infer<typeof Stop>, now: number): { label: string; review_by: string | null } {
  // The every-workspace stop is ours alone: it has no date and is never a review of this account.
  if (stop.scope === "all_workspaces") return { label: "Paused by Lifty · maintenance", review_by: null };
  const reason = PLAIN_STOP_REASON[stop.reason];
  const open = Date.parse(stop.review_by) > now;
  return { label: ["Paused by Lifty", ...(reason ? [reason] : []), open ? `we review it by ${shortDay(stop.review_by)}` : "under review"].join(" · "),
    review_by: open ? stop.review_by : null };
}

const Secondary = z.object({
  status: z.enum(participationStatuses), cause: z.enum(participationCauses), category: z.enum(["transient", "fixable_by_client", "long", "intentional"]).nullable(),
  since: Timestamp.nullable(), next_step: ParticipationNextStep.optional(),
}).strict().refine(belongs, "The cause belongs to another status.");

function nextStep(value: Omit<Reported, "also">, primary: boolean, now: number): ParticipationNextStep {
  const words = CAUSES[value.cause];
  const stopped = value.stop ? stopStep(value.stop, now) : null;
  const health = value.health ? `On hold · ${PLAIN_HEALTH_REASON[value.health.reason]}` : null;
  return { label: stopped?.label ?? health ?? words.label, owner: words.owner, action: words.action, since: value.since ?? null,
    since_estimated: primary ? value.since_estimated ?? false : null, review_by: stopped?.review_by ?? null };
}

type Reported = { cause: ParticipationCause; since?: string | null | undefined; since_estimated?: boolean | undefined; stop?: z.infer<typeof Stop> | undefined;
  health?: { reason: z.infer<typeof HealthReason> } | undefined; also?: z.infer<typeof Secondary>[] | undefined };
/** The same participation with every cause's words, as of `now`. */
export function presentParticipation<T extends Reported>(value: T, now: number) {
  return { ...value, next_step: nextStep(value, true, now),
    ...(value.also ? { also: value.also.map(item => ({ ...item, next_step: nextStep(item, false, now) })) } : {}) };
}

/**
 * The database's participation, with `next_step` added on every read so no
 * route or client can miss it. `category`, `since` and the rest stay optional
 * while an older database still answers `{status, cause}` (this API ships
 * first). A cause of another status is still refused.
 */
export const ParticipationSchema = z.object({
  status: z.enum(participationStatuses), cause: z.enum(participationCauses),
  category: z.enum(["transient", "fixable_by_client", "long", "intentional"]).nullable().optional(),
  since: Timestamp.nullable().optional(), since_estimated: z.boolean().optional(),
  waiting_journeys: Count.optional(), stop: Stop.optional(), health: z.object({ reason: HealthReason }).strict().optional(),
  also: z.array(Secondary).max(20).optional(), next_step: ParticipationNextStep.optional(),
}).strict().refine(belongs, "The cause belongs to another status.")
  .refine(value => !["sending", "waiting_for_first_lead", "no_active_campaign"].includes(value.status) || value.waiting_journeys === undefined,
    "This status reports no waiting Journeys.")
  .refine(value => value.stop === undefined || value.cause === "paused_by_lift", "Only a Lifty stop reports stop facts.")
  .refine(value => value.health === undefined || value.cause === "health_hold", "Only a health hold reports its reason.")
  .overwrite(value => presentParticipation(value, Date.now()));
export type Participation = z.infer<typeof ParticipationSchema>;

const SENDABLE: readonly ParticipationStatus[] = ["sending", "waiting_for_first_lead", "no_active_campaign"];
/** Whether this account can send once a lead reaches it. */
export const canSend = (participation: Participation) => SENDABLE.includes(participation.status);

/** "Lee · warming until Nov 14". Without a date it only names the cause. */
export function blockedLabel(name: string, cause: ParticipationCause, clearsOn: string | null): string {
  return `${name} · ${CAUSES[cause].short}${clearsOn ? ` until ${shortDay(clearsOn)}` : ""}`;
}
