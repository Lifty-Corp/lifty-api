import { z } from "zod";
import { WorkspaceIdentitySchema } from "./business-contracts.js";

// LIF-1182 Identity resources: senders (people) and the sending accounts they
// own. The database owns validation, versions, observation freshness and send
// counts; these schemas are the published request/response contract.
export const Id = z.uuid();
export const Timestamp = z.iso.datetime({ offset: true });
export const Count = z.number().int().nonnegative();
const Version = z.number().int().positive();

export const Channel = z.enum(["email", "linkedin"]);
export const SenderName = z.string().trim().min(1).max(200).regex(/^[^\u0000-\u001f\u007f@]+$/)
  .refine(value => !["linkedin", "email"].includes(value.toLowerCase()), "Use the person's name, not a channel or address.");
// The founder's own words: plain text, https links only. The database
// normalizes line endings and surrounding whitespace and stores at most 500.
export const Signature = z.string().min(1).refine(value => [...value].length <= 500);
// Keep the original input for the single SQL normalizer. CRLF and surrounding
// whitespace are normalized before the 500-character limit is applied.
const SignatureInput = z.string().describe("Plain text; 1–500 characters after line-ending and surrounding-whitespace normalization. Links must use https.");
export const BookingUrl = z.url({ protocol: /^https$/ }).max(2048);

const Declaration = z.union([
  z.object({ mailbox_use: z.enum(["habitual", "dedicated"]), declared_by: Id.nullable(), declared_at: Timestamp }).strict(),
  z.object({ habitual_personal_account: z.literal(true), no_other_automation: z.literal(true),
    declared_by: Id.nullable(), declared_at: Timestamp }).strict(),
]);
// LIF-1446: whether the account-level send gate lets this account send now.
// `paused_by_member` is the account's own `state`; `paused_by_lift` is a LIFT
// hold that only LIFT releases, at the reported scope.
export const SendingReason = z.enum([
  "paused_by_member", "paused_by_lift", "channel_paused", "workspace_suspended", "disconnected",
  "needs_reconnect", "status_unconfirmed", "connection_unavailable", "sender_deleted", "mailbox_not_ready",
  "previous_automation_active", "blocked",
]);
export const SendingScope = z.enum(["account", "sender", "channel", "workspace", "all_workspaces"]);
const Sending = z.object({ allowed: z.boolean(), reason: SendingReason.nullable(), scope: SendingScope.nullable() }).strict();
const Limit = z.number().int().nonnegative();
// The limits the send budgets enforce; null when no Lifty budget governs the account.
const Limits = z.union([
  z.object({ emails_per_day: Limit }).strict(),
  z.object({ invitations_per_day: Limit, messages_per_day: Limit, invitations_per_7_days: Limit }).strict(),
]);
export const AccountSchema = z.object({
  id: Id,
  sender_id: Id,
  channel: Channel,
  identity: z.string().min(1).max(2048).nullable(),
  status: z.enum(["connected", "needs_reconnect", "disconnected"]),
  state: z.enum(["active", "paused"]),
  sending: Sending,
  limits: Limits.nullable(),
  disconnect_pause: z.object({ count: Count, can_resume: z.boolean() }).strict().optional(),
  checked_at: Timestamp.nullable(),
  observation: z.object({ state: z.enum(["verified", "unverified"]) }).strict(),
  connected_at: Timestamp.nullable(),
  disconnected_at: Timestamp.nullable(),
  access_revoked_at: Timestamp.nullable(),
  // pending: Lifty still holds provider access to remove; not_applicable: a
  // previous tool's account Lifty never authorized, so nothing to remove.
  access_removal: z.enum(["pending", "confirmed", "not_applicable"]).nullable(),
  declaration: Declaration.nullable(),
  // Connection-only deployments have no receipt metrics; null is unavailable.
  sends: z.object({ today: Count, last_7_days: Count }).strict().nullable(),
}).strict();
export type Account = z.infer<typeof AccountSchema>;
/** Disconnected with provider access still to remove (a retired provider's account has none). */
export const removalPending = (account: Account) =>
  account.status === "disconnected" && !account.access_revoked_at && account.access_removal !== "not_applicable";
export const SenderSchema = z.object({
  id: Id,
  version: Version,
  name: z.string().min(1).max(200),
  signature: Signature.nullable(),
  booking_url: z.string().max(2048).nullable(),
  accounts: z.array(AccountSchema).max(1000),
}).strict();

const Workspace = { workspace: WorkspaceIdentitySchema };
export const SendersGetSchema = z.object({ ...Workspace, senders: z.array(SenderSchema).max(1000) }).strict();
export const SenderResultSchema = z.object({ ...Workspace, sender: SenderSchema }).strict();
export const SenderPatchResultSchema = SenderResultSchema.extend({ recomposing: Count.optional() }).strict();
export const SenderDeleteResultSchema = z.object({ ...Workspace,
  sender: z.object({ id: Id, version: Version, deleted_at: Timestamp }).strict(),
  accounts: z.array(AccountSchema).max(1000),
}).strict();
export const AccountsGetSchema = z.object({ ...Workspace, accounts: z.array(AccountSchema).max(5000) }).strict();
export const AccountResultSchema = z.object({ ...Workspace, account: AccountSchema }).strict();
export const CampaignResumeResultSchema = AccountResultSchema.extend({
  resumed: Count,
  results: z.array(z.object({
    campaign_ref: Id, outcome: z.enum(["resumed", "blocked"]), reason: z.string().nullable(),
  }).strict()),
}).strict();
/** Durable stage shared by the browser and member/agent reads. A timeout is not a failed connection. */
export const AccountConnectionProgress = z.object({
  stage: z.enum(["declaration_required", "preparing", "sign_in_required", "verifying", "complete"]),
}).strict();
export type AccountConnectionProgress = z.infer<typeof AccountConnectionProgress>;
// LIF-1629: closed and replaced end an attempt a member no longer wants;
// unverified ends a received authorization Lifty could not verify in time.
export const AttemptReason = z.enum(["canceled", "account_in_use", "identity_mismatch", "provider_rejected",
  "closed", "replaced", "unverified"]);
/** Lifty's own verification of a received authorization; null when there is none to verify. */
export const AttemptRecovery = z.object({
  state: z.enum(["active", "exhausted"]), attempts: Count, checked_at: Timestamp.nullable(), next_at: Timestamp.nullable(),
}).strict();
export const AttemptSchema = z.object({
  ...Workspace,
  id: Id,
  sender_id: Id,
  channel: Channel,
  state: z.enum(["pending", "connected", "failed", "expired"]),
  reason: AttemptReason.nullable(),
  account_id: Id.nullable(),
  declaration: Declaration.nullable(),
  expires_at: Timestamp,
  progress: AccountConnectionProgress,
  recovery: AttemptRecovery.nullable(),
  replaced_by: Id.nullable(),
  // What the provider's return page reported. History only: never the attempt's outcome.
  provider_hint: z.object({ code: z.enum(["canceled", "account_exists", "provider_rejected"]), at: Timestamp }).strict().nullable(),
}).strict();
export type Attempt = z.infer<typeof AttemptSchema>;
export const AttemptActionOwner = z.enum(["account_owner", "agent", "lifty", "none"]);
export const AttemptAction = z.enum(["open_link", "wait", "close", "replace"]);
const AttemptStep = z.object({
  operation: z.enum(["sending_accounts_attempt", "sending_accounts_replace_attempt"]),
  path: z.object({ id: Id }).strict(),
  query: z.object({ wait_seconds: z.number().int().min(1).max(25) }).strict().optional(),
  message: z.string(),
}).strict();
const WarmupStep = z.object({
  operation: z.literal("sending_accounts_warmup_start"),
  body: z.object({ workspace: Id, connection_ref: Id }).strict(),
  message: z.string(),
}).strict();
/**
 * The attempt with who acts next and what is permitted, the same for the
 * agent and the dashboard. `connection_url` is present while the account
 * owner still has to open it; a connected mailbox's next step is its warmup.
 */
export const AttemptReadSchema = AttemptSchema.extend({
  connection_url: z.url().optional(),
  action_owner: AttemptActionOwner,
  actions: z.array(AttemptAction),
  next_step: z.union([WarmupStep, AttemptStep]).optional(),
}).strict();
export type AttemptRead = z.infer<typeof AttemptReadSchema>;
export const AttemptQuerySchema = z.object({
  wait_seconds: z.coerce.number().int().min(0).max(25).optional()
    .describe("Wait up to this many seconds while the attempt still waits on someone and has not changed."),
}).strict();
// The database opens or reuses the durable attempt; the API adds the link.
export const ConnectStartSchema = z.object({ ...Workspace, id: Id, expires_at: Timestamp, created: z.boolean() }).strict();
export const ConnectResultSchema = ConnectStartSchema.extend({ connection_url: z.url(), progress: AccountConnectionProgress }).strict();
/**
 * LIF-1629 close/replace receipt: what happened to the attempt (connected,
 * recovering, closed, replaced or ended), when a still-verifying
 * authorization may be closed, the attempt itself and its one successor.
 */
export const AttemptCloseResultSchema = z.object({
  ...Workspace,
  disposition: z.enum(["connected", "recovering", "closed", "replaced", "ended"]),
  retry_after: Timestamp.nullable(),
  attempt: AttemptReadSchema,
  successor: ConnectResultSchema.nullable(),
}).strict();
// The database's receipt before the API adds links and next steps.
export const AttemptCloseReceiptSchema = AttemptCloseResultSchema.extend({
  attempt: AttemptSchema, successor: ConnectStartSchema.extend({ channel: Channel }).strict().nullable(),
}).strict();

export const IdPath = z.object({ id: Id }).strict();
export const SenderCreateSchema = z.object({
  name: SenderName, signature: SignatureInput.optional(), booking_url: BookingUrl.optional(),
}).strict();
export const SenderPatchSchema = z.object({
  expected_version: Version,
  name: SenderName.optional(),
  signature: SignatureInput.nullable().optional(),
  booking_url: BookingUrl.nullable().optional(),
}).strict().refine(value => value.name !== undefined || value.signature !== undefined || value.booking_url !== undefined,
  { message: "Change at least one of name, signature or booking_url.", path: [] });
export const SenderDeleteSchema = z.object({ expected_version: Version, confirm: z.literal(true) }).strict();
export const AccountsQuerySchema = z.object({ sender_id: Id.optional(), channel: Channel.optional() }).strict();
export const ConnectSchema = z.object({ sender_id: Id, channel: Channel }).strict();
export const DisconnectSchema = z.object({ confirm: z.literal(true) }).strict();
/** LIF-1603: a member changes how a connected mailbox is used. */
export const DeclareUseSchema = z.object({ mailbox_use: z.enum(["habitual", "dedicated"]), confirm: z.literal(true) }).strict();
