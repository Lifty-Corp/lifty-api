
import { CrmSyncReceiptSchema } from "./crm-sync-receipt.js";
import { z } from "@hono/zod-openapi";

const WorkspaceReferenceSchema = z
  .object({
    workspace_ref: z.string().min(1),
    name: z.string().min(1),
  })
  .strict();

export const WorkspaceStatusSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("needs_workspace"),
      workspace: z.null(),
      next_action: z.literal("provision_workspace"),
    })
    .strict(),
  z
    .object({
      state: z.enum(["ready_for_connections", "suspended"]),
      workspace: WorkspaceReferenceSchema,
      next_action: z.null(),
    })
    .strict(),
]);

const RunStartFields = {
    run_ref: z.string().min(1),
    requested_leads: z.number().int().positive(),
    workspace: WorkspaceReferenceSchema,
    attempt: z.number().int().nonnegative().optional(),
};

const CalibrationPolicySchema = z.enum(["tier_a_v1", "qualified_ab_v1", "researched_v1"]);
// Customer reasons for a failed sample. The database keeps the internal cause
// for operators; provider and capacity details never reach this field.
export const RunErrorCodeSchema = z.enum([
  "calibration_sample_incomplete",
  "calibration_review_required",
  "research_failed",
  "search_exhausted",
  "research_limit_reached",
]);

export const StartRunResultSchema = z.discriminatedUnion("state", [
  z.object({
    ...RunStartFields,
    state: z.enum(["queued", "running"]),
    created: z.boolean(),
    calibration_policy: CalibrationPolicySchema.optional(),
  }).strict(),
  z.object({
    ...RunStartFields,
    state: z.literal("failed"),
    created: z.literal(false),
    calibration_policy: z.literal("qualified_ab_v1"),
    error_code: z.literal("calibration_review_required"),
  }).strict(),
]);

const RunLeadSchema = z
  .object({
    name: z.string(),
    title: z.string().nullable(),
    company: z.string().nullable(),
    linkedin_url: z.string().nullable(),
    lead_ref: z.uuid().nullable().optional(),
    research_url: z.string().nullable().optional(),
    research_available: z.boolean().optional(),
    tier: z.string().nullable(),
    fit_rationale: z.string().nullable(),
    stage: z.string().nullable(),
  })
  .strict();

export const RunStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("none") }).strict(),
  z
    .object({
      state: z.enum(["queued", "running", "succeeded", "failed"]),
      run_ref: z.string().min(1),
      requested_leads: z.number().int().positive(),
      leads_discovered: z.number().int().nonnegative().nullable(),
      calibration_policy: CalibrationPolicySchema.optional(),
      leads_researched: z.number().int().nonnegative().nullable(),
      error_code: RunErrorCodeSchema.nullable(),
      started_at: z.string().min(1),
      completed_at: z.string().nullable(),
      // When the founder confirmed this sample; null until then (LIF-1303).
      reviewed_at: z.string().nullable(),
      workspace: WorkspaceReferenceSchema,
      leads: z.array(RunLeadSchema).nullable(),
    })
    .strict(),
]);

// The founder confirms the sample they reviewed, by its run_ref (LIF-1303).
export const ConfirmRunReviewRequestSchema = z.object({ run_ref: z.uuid() }).strict();

/** Providers the integration routes accept. */
export const ProviderSchema = z.enum(["hubspot", "slack", "attio"]);

export const HubspotConnectStartSchema = z
  .object({
    provider: z.literal("hubspot"),
    connect_url: z.string().url(),
    expires_in_seconds: z.number().int().positive(),
    attempt_ref: z.uuid().optional(),
    expires_at: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

export const HubspotConnectionStatusSchema = z.discriminatedUnion("status", [
  z
    .object({
      provider: z.literal("hubspot"),
      status: z.literal("not_connected"),
    })
    .strict(),
  z
    .object({
      provider: z.literal("hubspot"),
      status: z.literal("connected"),
      portal_id: z.string().regex(/^[0-9]{1,20}$/),
      hub_domain: z.string().nullable(),
      granted_scopes: z.array(z.string()),
      connected_at: z.string().nullable(),
      reconnect_required: z.boolean(),
    })
    .strict(),
]);

export const AttioConnectStartSchema = z
  .object({
    provider: z.literal("attio"),
    connect_url: z.string().url(),
    expires_in_seconds: z.number().int().positive(),
    attempt_ref: z.uuid().optional(),
    expires_at: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

/** The founder's own Attio workspace; the bearer token never leaves the database. */
export const AttioConnectionStatusSchema = z.discriminatedUnion("status", [
  z.object({ provider: z.literal("attio"), status: z.literal("not_connected") }).strict(),
  z
    .object({
      provider: z.literal("attio"),
      status: z.literal("connected"),
      attio_workspace_id: z.uuid(),
      workspace_slug: z.string().min(1).max(100),
      workspace_name: z.string().min(1).max(255),
      granted_scopes: z.array(z.string()),
      connected_at: z.string().nullable(),
      reconnect_required: z.boolean(),
    })
    .strict(),
]);

/** The selected CRM; nothing connected names no provider. */
export const CrmConnectionStatusSchema = z.union([
  z.object({ provider: z.null(), status: z.literal("not_connected") }).strict(),
  HubspotConnectionStatusSchema,
  AttioConnectionStatusSchema,
]);

export const SlackConnectStartSchema = z
  .object({
    provider: z.literal("slack"),
    connect_url: z.string().url(),
    expires_in_seconds: z.number().int().positive(),
    attempt_ref: z.uuid().optional(),
    expires_at: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

export const SlackConnectLinkSchema = SlackConnectStartSchema.extend({
  workspace_id: z.uuid(),
  workspace_name: z.string().min(1),
}).strict();
export type SlackConnectLink = z.infer<typeof SlackConnectLinkSchema>;

export const ProviderConnectStartSchema = z.union([
  HubspotConnectStartSchema,
  SlackConnectStartSchema,
  AttioConnectStartSchema,
]);
// Existing installed clients reject additional handoff keys. Keep the public
// legacy response distinct from internal results consumed by stage adapters.
export const LegacyProviderConnectStartSchema = z.union([
  HubspotConnectStartSchema.omit({ attempt_ref: true, expires_at: true }),
  SlackConnectStartSchema.omit({ attempt_ref: true, expires_at: true }),
  AttioConnectStartSchema.omit({ attempt_ref: true, expires_at: true }),
]);

export const SlackConnectionStatusSchema = z.discriminatedUnion("status", [
  z
    .object({
      provider: z.literal("slack"),
      status: z.literal("not_connected"),
    })
    .strict(),
  z
    .object({
      provider: z.literal("slack"),
      status: z.literal("connected"),
      team_id: z.string().min(1),
      team_name: z.string().min(1),
      enterprise_id: z.string().nullable(),
      bot_user_id: z.string().min(1),
      scopes: z.array(z.string()),
      connected_at: z.string().nullable(),
      reconnect_required: z.boolean(),
    })
    .strict(),
]);

/** GET /v1/integrations/{provider}. */
export const IntegrationConnectionStatusSchema = z.union([
  HubspotConnectionStatusSchema,
  SlackConnectionStatusSchema,
  AttioConnectionStatusSchema,
]);

// Notification configuration lives in the private notifications schema
// (LIF-1464). The database owns the catalog: a type code is validated by shape
// only, so a new catalog type never makes this API reject a request or a read.
export const NotificationTypeCodeSchema = z.string().max(100).regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
export const NotificationChannelSchema = z.enum(["slack", "email"]);

const notificationSources = z.array(z.enum(["email", "linkedin"])).min(1).max(2).refine(v => new Set(v).size === v.length);
const notificationChannels = z.array(NotificationChannelSchema).min(1).max(2).refine(v => new Set(v).size === v.length);
export const NotificationSettingsSchema = z.object({
  enabled: z.boolean(), sources: notificationSources, channels: notificationChannels, version: z.number().int().nonnegative(),
}).strict();
export const NotificationControlsSchema = z.object({ global: NotificationSettingsSchema, workspace: NotificationSettingsSchema }).strict();
export const SetNotificationControlsRequestSchema = NotificationSettingsSchema.omit({ version: true }).extend({ expected_version: z.number().int().nonnegative() });
export const SetNotificationPreferencesRequestSchema = z.object({
  notification_type: NotificationTypeCodeSchema,
  channels: z.array(NotificationChannelSchema).max(2).refine(v => new Set(v).size === v.length),
  slack_destination_ref: z.uuid().nullable(),
}).strict().refine(v => v.channels.includes("slack") === (v.slack_destination_ref !== null), "A Slack choice requires its destination");
export type SetNotificationControlsRequest = z.infer<typeof SetNotificationControlsRequestSchema>;
export type SetNotificationPreferencesRequest = z.infer<typeof SetNotificationPreferencesRequestSchema>;

export const SlackNotificationChannelSchema = z
  .object({
    id: z.string().regex(/^[CG][A-Z0-9]{2,31}$/),
    name: z.string().min(1).max(80),
    is_private: z.boolean(),
  })
  .strict();

export const SlackNotificationChannelsSchema = z
  .object({ channels: z.array(SlackNotificationChannelSchema) })
  .strict();

/** One catalog type and the channels that can render it. */
export const NotificationCatalogTypeSchema = z
  .object({
    code: NotificationTypeCodeSchema,
    name: z.string(),
    channels: z.array(NotificationChannelSchema),
    default_on: z.boolean(),
    paused: z.boolean(),
    // Reaches the owner email only while no active Slack destination is subscribed.
    email_fallback: z.boolean(),
    email_explicit: z.boolean().optional(),
  })
  .strict();

/** A Slack channel (address = channel ID) or the workspace owner's email
 * (address and name null), with the type codes it is subscribed to. */
export const NotificationDestinationSchema = z
  .object({
    destination_ref: z.uuid(),
    channel: NotificationChannelSchema,
    address: z.string().nullable(),
    name: z.string().nullable(),
    active: z.boolean(),
    types: z.array(NotificationTypeCodeSchema),
  })
  .strict();

const NotificationSlackStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_connected") }).strict(),
  z
    .object({
      status: z.literal("connected"),
      team_id: z.string().min(1),
      team_name: z.string().min(1),
      reconnect_required: z.boolean(),
    })
    .strict(),
]);

export const NotificationConfigSchema = z
  .object({
    workspace_ref: z.uuid(),
    slack: NotificationSlackStatusSchema,
    types: z.array(NotificationCatalogTypeSchema),
    destinations: z.array(NotificationDestinationSchema),
    controls: NotificationControlsSchema.optional(),
  })
  .strict();

export const UpsertNotificationDestinationRequestSchema = z
  .object({
    channel_id: z.string().trim().regex(/^[CG][A-Z0-9]{2,31}$/),
    channel_name: z.string().trim().min(1).max(80),
  })
  .strict();

/** Subscribe (enabled) or unsubscribe one destination to one notification type. */
export const SetNotificationRouteRequestSchema = z
  .object({
    notification_type: NotificationTypeCodeSchema,
    destination_ref: z.uuid(),
    enabled: z.boolean(),
  })
  .strict();

/** Trigger.dev accepted the test send; it is not proof of delivery. */
export const NotificationTestResultSchema = z
  .object({
    destination_ref: z.uuid(),
    request_ref: z.uuid(),
    status: z.literal("queued"),
  })
  .strict();

/** What DELETE /v1/integrations/{provider} returns to the CLI. */
export const DisconnectResponseSchema = z
  .object({
    provider: ProviderSchema,
    status: z.literal("disconnected"),
    portal_id: z.string().nullable(),
    disconnected_at: z.string().min(1),
    workspace: WorkspaceReferenceSchema,
  })
  .strict();

/**
 * Exact shape of the disconnect_lifty_integration RPC result. `revocation_ref`
 * (LIF-681) names the detached grant the `lifty-integration-revoke` job must
 * revoke at the provider; it stays internal to the API.
 */
export const DisconnectResultSchema = DisconnectResponseSchema.extend({
  revocation_ref: z.string().nullable().optional(),
}).strict();

export const StartCrmSyncResultSchema = z
  .object({
    state: z.enum(["queued", "running"]),
    run_ref: z.string().min(1),
    requested_leads: z.number().int().positive(),
    portal_id: z.string().regex(/^[0-9]{1,20}$/).nullable(),
    workspace: WorkspaceReferenceSchema,
    created: z.boolean(),
  })
  .strict();

export const CrmSyncStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("none") }).strict(),
  z
    .object({
      state: z.enum(["queued", "running", "succeeded", "failed"]),
      run_ref: z.string().min(1),
      requested_leads: z.number().int().positive(),
      leads_synced: z.number().int().nonnegative().nullable(),
      error_code: z.string().nullable(),
      crm_sync_receipt: CrmSyncReceiptSchema.nullable().optional(),
      portal_id: z.string().regex(/^[0-9]{1,20}$/).nullable(),
      started_at: z.string().min(1),
      completed_at: z.string().nullable(),
      workspace: WorkspaceReferenceSchema,
    })
    .strict(),
]).superRefine((result, ctx) => {
  if (result.state === "succeeded" && result.crm_sync_receipt && result.crm_sync_receipt.status !== "complete") {
    ctx.addIssue({ code: "custom", message: "A successful sync requires complete delivery" });
  }
});

export type WorkspaceStatus = z.infer<typeof WorkspaceStatusSchema>;
export type StartRunResult = z.infer<typeof StartRunResultSchema>;
export type RunStatus = z.infer<typeof RunStatusSchema>;
export type Provider = z.infer<typeof ProviderSchema>;
export type HubspotConnectStart = z.infer<typeof HubspotConnectStartSchema>;
export type HubspotConnectionStatus = z.infer<typeof HubspotConnectionStatusSchema>;
export type AttioConnectStart = z.infer<typeof AttioConnectStartSchema>;
export type AttioConnectionStatus = z.infer<typeof AttioConnectionStatusSchema>;
export type CrmConnectionStatus = z.infer<typeof CrmConnectionStatusSchema>;
export type SlackConnectStart = z.infer<typeof SlackConnectStartSchema>;
export type SlackConnectionStatus = z.infer<typeof SlackConnectionStatusSchema>;
export type IntegrationConnectionStatus = z.infer<typeof IntegrationConnectionStatusSchema>;
export type DisconnectResult = z.infer<typeof DisconnectResultSchema>;
export type StartCrmSyncResult = z.infer<typeof StartCrmSyncResultSchema>;
export type CrmSyncStatus = z.infer<typeof CrmSyncStatusSchema>;
export type SlackNotificationChannels = z.infer<typeof SlackNotificationChannelsSchema>;
export type NotificationDestination = z.infer<typeof NotificationDestinationSchema>;
export type NotificationConfig = z.infer<typeof NotificationConfigSchema>;
export type UpsertNotificationDestinationRequest = z.infer<
  typeof UpsertNotificationDestinationRequestSchema
>;
export type SetNotificationRouteRequest = z.infer<typeof SetNotificationRouteRequestSchema>;
export type NotificationTestResult = z.infer<typeof NotificationTestResultSchema>;
