import { z } from "zod";
import { WorkspaceIdentitySchema } from "./business-contracts.js";
import { Channel, Count, HandoffRef, Id, Timestamp } from "./identity-contracts.js";
import { ReviewSettingsSchema, ReviewSettingsUpdateSchema } from "./outreach-contracts.js";
import { causeStep, ParticipationNextStep, SendingScope, StopOrigin, StopPersonReason, StopReason } from "./participation.js";

// LIF-1771: the Senders controls the database owns, as published schemas: LIFT
// stops, workspace settings, handoffs, recovery incidents and notification
// action links. Every RPC runs with the caller's session.
const Workspace = { workspace: WorkspaceIdentitySchema };
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const Code = z.string().regex(/^[a-z][a-z0-9_:]{0,99}$/);

// ---------------------------------------------------------------- stops

/** LIFT admins only: this is where who set a stop and its note can be read. */
export const StopSchema = z.object({
  scope: SendingScope, scope_key: z.string().min(1).nullable(), account_id: Id.nullable(), sender_id: Id.nullable(), channel: Channel.nullable(),
  origin: StopOrigin, reason: StopReason, since: Timestamp, since_estimated: z.boolean(), review_by: Timestamp,
  set_by: z.string().max(200).nullable(), note: z.string().nullable(),
}).strict();
export const StopsResultSchema = z.object({ ...Workspace, stops: z.array(StopSchema).max(5000) }).strict();
export const StopResultSchema = z.object({ ...Workspace, stop: StopSchema }).strict();
export const StopReleaseResultSchema = z.object({ ...Workspace, stop: StopSchema.nullable(), released: z.boolean() }).strict();
// A LIFT admin may not belong to the workspace, so it is named here instead of
// in x-lifty-workspace. The database refuses everyone else first.
export const StopQuerySchema = z.object({ workspace_id: Id.optional() }).strict();
const StopNote = z.string().refine(value => [...value.trim()].length <= 1000, "Keep the note to 1000 characters.");
// Plain strings in the published schema: every MCP turn carries it, and the
// timestamp pattern alone is 700 characters. The refinements stay in force.
const StopDate = z.string().max(40).refine(value => Timestamp.safeParse(value).success, "Use an ISO timestamp with its offset.");
const StopTarget = { scope: z.enum(["account", "sender", "channel", "workspace"]), account_id: z.string().optional(), sender_id: z.string().optional(), channel: Channel.optional() };
const Named = (value: string | undefined) => value === undefined || Id.safeParse(value).success;
const coherent = (value: { scope: string; account_id?: string | undefined; sender_id?: string | undefined; channel?: string | undefined }) =>
  Named(value.account_id) && Named(value.sender_id) && (value.scope === "account" ? value.account_id !== undefined && value.sender_id === undefined && value.channel === undefined
    : value.scope === "sender" ? value.sender_id !== undefined && value.account_id === undefined
      : value.scope === "channel" ? value.channel !== undefined && value.account_id === undefined && value.sender_id === undefined
        : value.account_id === undefined && value.sender_id === undefined && value.channel === undefined);
const StopMismatch = { message: "Name exactly what this scope stops: account_id, sender_id, channel, or nothing for the workspace.", path: ["scope"] };
export const StopSetSchema = z.object({ ...StopTarget, reason: StopPersonReason, note: StopNote.optional(), review_by: StopDate.optional() }).strict().refine(coherent, StopMismatch);
export const StopReleaseSchema = z.object({ ...StopTarget, note: StopNote.optional() }).strict().refine(coherent, StopMismatch);
export const StopReviewSchema = z.object({ ...StopTarget, review_by: StopDate, note: StopNote.optional() }).strict().refine(coherent, StopMismatch);

// ---------------------------------------------------------------- settings

export const AssignmentMode = z.enum(["equal", "founder_weight", "tier_a_founder"]);
const SampleSize = z.number().int().min(1).max(100);
export const WorkspaceSettingsResultSchema = z.object({ ...Workspace, settings: z.object({
  // Zero until the workspace saves its first change.
  version: Count,
  assignment: z.object({ mode: AssignmentMode, founder_sender_id: Id.nullable() }).strict(),
  handoff: z.object({ sample_size: SampleSize }).strict(),
  review: ReviewSettingsSchema,
}).strict() }).strict();
export const WorkspaceSettingsPatchSchema = z.object({
  expected_version: Count,
  assignment: z.object({ mode: AssignmentMode, founder_sender_id: Id.nullable().optional() }).strict().optional(),
  handoff: z.object({ sample_size: SampleSize }).strict().optional(),
  review: ReviewSettingsUpdateSchema.optional(),
}).strict().refine(value => value.assignment !== undefined || value.handoff !== undefined || value.review !== undefined,
  { message: "Change at least one of assignment, handoff or review.", path: [] });

// ---------------------------------------------------------------- transfer scope

/**
 * How a retire would divide a person's leads, before anyone chooses a target.
 * `replies` sits inside `conversations`. The groups never sum to all leads: a
 * contacted lead with nothing to continue is in neither, so there is no total.
 * It assumes the replacement can send email; the retire's own receipt decides.
 */
export const TransferScopeSchema = z.object({ ...Workspace, sender_id: Id, not_contacted: Count, conversations: Count, replies: Count }).strict()
  .refine(value => value.replies <= value.conversations, "Replies are part of the conversations.");

// ---------------------------------------------------------------- handoffs

// Read like Deliverability's source: strict on the fields members use, and any
// other key is dropped. The stored route holds the vendor's name and ids, and
// the composer's context holds internal refs; neither crosses this API.
const Person = z.object({ sender_id: Id, display_name: z.string().nullable() });
const AnswerRoute = z.object({
  sender_id: Id, channel: Channel.optional(), connection_ref: Id.nullish(), mailbox_email: z.string().nullish(),
  turn_id: Id.optional(), inbound_event_id: Id.nullish(), handoff_from: Person.nullish(),
  route: z.object({ channel: Channel, connection_ref: Id.nullish(), inbound_channel: Channel.nullish(), recipient_email: z.string().nullish(),
    rerouted: z.boolean().optional(), subject: z.string().nullish() }).optional(),
});
const PriorEmail = z.object({ position: z.number().int().positive().optional(), original_position: z.number().int().positive().optional(),
  subject: z.string().nullable(), text: z.string(), accepted_at: Timestamp });
const SampleContext = z.object({
  handoff_from: Person.nullish(), inbound_event_ref: Id.optional(), kind: Code.optional(), first_due_at: Timestamp.nullish(),
  history: z.array(PriorEmail).max(100).optional(), last_accepted_email: PriorEmail.nullish(), last_proactive_touch_at: Timestamp.nullish(),
  original_next_position: z.number().int().positive().nullish(), original_positions: z.array(z.number().int().positive()).max(100).optional(),
  original_total_steps: z.number().int().positive().optional(),
});
const Sample = z.object({
  kind: Code, lead_ref: Id, prepared: z.boolean(), subject: z.string().nullable(), body: z.string().nullable(), answering_route: AnswerRoute.nullable(),
  context: SampleContext, run_ref: Id.nullish(), source_run_ref: Id.nullish(), message_ref: Id.nullish(), email_version_ref: Id.nullish(),
  turn_ref: Id.nullish(), turn_version: z.number().int().nonnegative().nullish(), draft_event_ref: Id.nullish(),
});
const Member = z.object({
  kind: z.enum(["proactive", "current_reply"]), lead_ref: Id, owner: Id.nullable(), prepared: z.boolean(),
  // Why this lead cannot move now, and why its first message would wait after approval.
  reason: Code.nullable(), dispatch_reason: z.string().min(1).max(500).nullable(),
  run_ref: Id.nullable(), turn_ref: Id.nullable(), turn_version: z.number().int().nonnegative().nullable(), route: AnswerRoute.nullable(),
});
/** One handoff. Approved and queued work has not been sent: no field here reports a send. */
export const HandoffSchema = z.object({
  contract: z.literal("sender-handoff-approval.v2"), drain_ref: HandoffRef, workspace_id: Id, state: Code, source_sender_id: Id,
  replacement: z.object({ available: z.boolean(), sender_id: Id, display_name: z.string().nullable(), signature: z.string().nullable(),
    pinned_signature: z.string().nullable(), version: z.number().int().nullable(), pinned_version: z.number().int().nullable() }),
  authorization: z.object({ state: z.enum(["waiting_sample_approval", "authorized", "canceled"]), actor_id: Id.optional(), approved_at: Timestamp.optional(), revision: Sha256.optional() }),
  confirmation_action: z.literal("approve_sample_and_transfer"), revision: Sha256, scope_sha256: Sha256, settings_sha256: Sha256, context_sha256: Sha256,
  settings_revision: z.number().int().positive(), generation_settings: z.object({ instructions: z.string() }), sample_complete: z.boolean(),
  configured_sample_size: Count, cohort_count: Count, sample_count: Count, remainder_count: Count, current_reply_count: Count, prepared_count: Count,
  preparing_count: Count, held_for_human: Count, transferred_count: Count, untouched_transferred_count: Count, queued_count: Count, waiting_count: Count,
  samples: z.array(Sample).max(100), members: z.array(Member).max(20000),
});
export const HandoffPath = z.object({ handoff_ref: HandoffRef }).strict();
export const HandoffReplyPath = z.object({ handoff_ref: HandoffRef, turn_ref: Id }).strict();
export const HandoffApproveSchema = z.object({
  action: z.literal("approve_sample_and_transfer"), confirm: z.literal(true), source_sender_id: Id, replacement_sender_id: Id,
  scope_sha256: Sha256, settings_sha256: Sha256, context_sha256: Sha256, revision: Sha256,
}).strict();
export const HandoffCancelSchema = z.object({ confirm: z.literal(true), revision: Sha256 }).strict();
export const HandoffSettingsSchema = z.object({ revision: Sha256, generation_settings: z.object({ instructions: z.string().max(6000) }).strict() }).strict();
export const HandoffReplySchema = z.object({ turn_version: z.number().int().nonnegative(), draft_event_ref: Id,
  text: z.string().refine(value => { const length = value.trim().length; return length >= 1 && length <= 20000; }, "Write the reply in 1–20000 characters.") }).strict();

// ---------------------------------------------------------------- recovery

export const RecoveryIncidentsSchema = z.object({ ...Workspace, incidents: z.array(z.object({
  incident_ref: Id, account_id: Id, sender_id: Id, channel: Channel,
  cause: z.enum(["disconnected", "needs_reconnect", "paused_by_lift", "health_hold"]), severity: z.enum(["severe", "recoverable"]),
  since: Timestamp, due_at: Timestamp, state: z.enum(["open", "applied", "recovered"]), handoff_ref: HandoffRef.nullable(),
  // Its sample still waits, even after the inbox recovered. It says nothing about the recovery mode.
  handoff_pending: z.boolean().optional(),
  // The plan of the last wake, or null when nothing recorded one. Only `moved` says work moved.
  counts: z.record(z.string(), Count).nullable(), moved: Count.nullable(), next_step: ParticipationNextStep.optional(),
  // The cause's own words. They name no move: recovery may only be reporting, and members never see that mode.
}).strict().overwrite(incident => ({ ...incident, next_step: causeStep(incident.cause, incident.since, incident.state === "recovered") }))).max(5000) }).strict();

// ---------------------------------------------------------------- action links

export const AccountActionQuery = z.object({ action: z.enum(["reconnect", "warmup"]) }).strict();
/** Where a notification link lands. A read: what `operation` starts is the member's own click. */
export const AccountActionSchema = z.object({ ...Workspace,
  account_id: Id, sender_id: Id, channel: Channel, action: AccountActionQuery.shape.action, available: z.boolean(),
  operation: z.enum(["sending_accounts_reconnect", "sending_accounts_warmup_start"]), next_step: ParticipationNextStep,
}).strict();
