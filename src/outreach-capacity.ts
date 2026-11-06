import { z } from "zod";

const Count = z.number().int().nonnegative();
const Rate = z.number().nonnegative();
const Inbox = z.object({
  mailbox: z.string().min(3).max(254), status: z.enum(["sendable", "warming", "not_counted"]),
  cap: Count, planned: Count, ready_on: z.iso.date().nullable(), safety_check_stale: z.boolean(),
});
const Person = z.object({
  sender_ref: z.uuid(), sender_name: z.string().min(1).max(200),
  inboxes: z.array(Inbox), sendable_inboxes: Count, warming_inboxes: Count,
  capacity_per_day: Rate, capacity_at_caps_per_day: Rate, capacity_at_full_pace_per_day: Rate,
  target_rate: Rate, committed_rate: Rate, rate: Rate,
  backlog: z.object({ overdue_steps: Count, waiting_journeys: Count, steps: Count }),
  days_to_clear: Rate.nullable(), clears: z.boolean(), inboxes_needed: Count, on_deck: Count, inboxes_to_connect: Count, inboxes_short: Count,
});
/** What the need is read back from: leads a week × emails per lead × valid email share ÷ 5 ÷ people. */
const EmailPlan = z.object({ leads_per_week: Count, valid_email_share: z.number().min(0).max(1), emails_per_lead: Rate, emails_per_week: Rate, people: Count });

/** Only the calculation's member-safe fields cross the API. Raw gate/hold causes and other workspace evidence stay private. */
export const OutreachCapacitySource = z.object({
  workspace_ref: z.uuid(), assessed_at: z.iso.datetime({ offset: true }), window_days: Count, business_days: Count,
  email: z.object({
    operating: z.boolean(), short: z.boolean(), on_deck_total: Count, inboxes_to_connect: Count, inboxes_short: Count,
    plan: EmailPlan, people: z.array(Person),
  }),
  linkedin: z.object({
    operating: z.boolean(), short: z.boolean(), sendable_accounts: Count, invitations_per_week: Count,
    planned_messages_per_day: Count, invitations_needed_per_week: Rate, messages_needed_per_day: Rate,
    senders_needed: Count, senders_to_add: Count, backlog: z.object({ invitations: Count }),
    days_to_clear: Rate.nullable(), clears: z.boolean(),
    limits: z.object({ reply_share: z.number().min(0).max(1), new_sender: z.object({
      invitations_per_7_days: Count, messages_per_day: Count, planned_messages_per_day: Count,
    }) }),
  }),
});

export const OutreachCapacityReadout = z.discriminatedUnion("status", [
  OutreachCapacitySource.extend({ status: z.literal("available") }),
  z.object({ status: z.literal("unavailable"), workspace_ref: z.uuid() }),
]);
export type OutreachCapacityReadout = z.infer<typeof OutreachCapacityReadout>;

/** No fallback arithmetic: older databases and malformed/foreign reads remain explicitly unavailable. */
export function capacityReadout(workspaceRef: string, value: unknown): OutreachCapacityReadout {
  const parsed = OutreachCapacitySource.safeParse(value);
  return parsed.success && parsed.data.workspace_ref === workspaceRef
    ? { status: "available", ...parsed.data }
    : { status: "unavailable", workspace_ref: workspaceRef };
}
