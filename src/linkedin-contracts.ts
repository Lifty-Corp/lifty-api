import { z } from "zod";
import { WorkspaceIdentitySchema } from "./business-contracts.js";
import { AccountSchema, Count, Id, Timestamp } from "./identity-contracts.js";

// LIF-1190 LinkedIn activity read. The database owns attribution, periods and
// waiting reasons; accounts keep their canonical Identity ids, status and
// state. Counts are confirmed events (not people) since 00:00 UTC and over the
// rolling last seven days, the same periods as Identity `sends`.
const Counts = z.object({
  invitations_sent: Count,
  invitations_accepted: Count,
  messages_sent: Count,
  replies_received: Count,
}).strict();
// Why an account's due LinkedIn work waits; null when nothing waits.
export const WaitingReason = z.enum([
  "prior_campaign_running", "awaiting_review", "outside_schedule", "daily_limit_reached",
  "campaign_paused", "account_paused", "sender_paused", "paused_by_lift", "account_needs_attention", "on_hold",
]);
const LinkedinAccountSchema = AccountSchema.pick({ id: true, sender_id: true, status: true, state: true })
  .extend({ today: Counts, last_7_days: Counts, waiting_reason: WaitingReason.nullable() }).strict();

export const LinkedinQuerySchema = z.object({ sender_id: Id.optional() }).strict();
export const LinkedinActivitySchema = z.object({
  workspace: WorkspaceIdentitySchema,
  observed_at: Timestamp,
  today: Counts,
  last_7_days: Counts,
  accounts: z.array(LinkedinAccountSchema).max(5000),
}).strict();
