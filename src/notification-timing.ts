import { z } from "zod";
import { NotificationTypeCodeSchema } from "./contracts.js";

const timezone = z.string().min(1).max(100).refine(value => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
}, "Choose an IANA timezone");
const clock = { hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59), timezone };
export const NotificationTimingSchema = z.union([
  z.object({ kind: z.literal("immediate") }).strict(),
  z.object({ kind: z.literal("delay"), delayMinutes: z.number().int().min(1).max(525600) }).strict(),
  z.object({ kind: z.literal("calendar"), frequency: z.literal("daily"), ...clock }).strict(),
  z.object({ kind: z.literal("calendar"), frequency: z.literal("weekly"), weekday: z.number().int().min(0).max(6), ...clock }).strict(),
]);
const version = z.number().int().nonnegative();
export const NotificationTimingConfigurationSchema = z.object({
  workspaceId: z.uuid().nullable(), typeCode: NotificationTypeCodeSchema, editable: z.boolean(),
  effective: NotificationTimingSchema,
  global: z.object({ timing: NotificationTimingSchema, version }).strict(),
  workspace: z.object({ timing: NotificationTimingSchema.nullable(), version }).strict().nullable(),
}).strict().refine(value => (value.workspaceId === null) === (value.workspace === null), "Timing scope is inconsistent");
export const SetNotificationTimingRequestSchema = z.object({
  notification_type: NotificationTypeCodeSchema, expected_version: version, timing: NotificationTimingSchema.nullable(),
}).strict();
export type NotificationTimingConfiguration = z.infer<typeof NotificationTimingConfigurationSchema>;
export type SetNotificationTimingRequest = z.infer<typeof SetNotificationTimingRequestSchema>;
