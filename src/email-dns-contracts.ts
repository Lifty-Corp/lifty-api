import { z } from "zod";
import { EmailWorkspace } from "./email-contracts.js";

export const EmailDnsRequest = z.object({ workspace: EmailWorkspace, connection_ref: z.uuid() }).strict();
export type EmailDnsInput = z.infer<typeof EmailDnsRequest>;

const timestamp = z.iso.datetime({ offset: true });
const DnsRecord = z.enum(["spf", "dkim", "dmarc", "mx"]);
const DnsValue = z.object({
  type: z.enum(["TXT", "MX"]), name: z.string().min(1).max(255), value: z.string().min(1).max(255),
  priority: z.number().int().min(0).max(65535).optional(),
}).strict();
const Recheck = z.object({
  recheck_ref: z.uuid(), state: z.enum(["pending", "passed", "failing", "inconclusive", "canceled"]),
  requested_at: timestamp, deadline_at: timestamp, completed_at: timestamp.nullable(), failing: z.array(DnsRecord),
}).strict();
const status = {
  workspace_ref: z.uuid(), connection_ref: z.uuid(), domain: z.string().min(1).max(253),
  state: z.enum(["clear", "failing", "passing"]), checked_at: timestamp.nullable(),
  provider: z.enum(["google", "microsoft"]).nullable(), failing: z.array(DnsRecord), recheck: Recheck.nullable(),
};

// The database owns the guidance, so a notice and this response cannot disagree.
// Parsing strips unknown keys: a newer database cannot leak additions outward.
export const StoredDnsStatus = z.object({ ...status, recheck: Recheck.strip().nullable(), fixes: z.array(z.object({
  record: DnsRecord, step: z.string().min(1).max(500), dns: DnsValue.optional(),
  adminUrl: z.url().optional(), adminLabel: z.string().min(1).max(200).optional(),
})) });
export type StoredDnsStatus = z.infer<typeof StoredDnsStatus>;

/** Strict so older clients fail closed on additions. DKIM carries no value. */
export const EmailDnsStatus = z.object({ ...status, fixes: z.array(z.object({
  record: DnsRecord, step: z.string().min(1).max(500), dns: DnsValue.optional(),
  admin_url: z.url().optional(), admin_label: z.string().min(1).max(200).optional(),
}).strict()) }).strict();
export type EmailDnsStatus = z.infer<typeof EmailDnsStatus>;
