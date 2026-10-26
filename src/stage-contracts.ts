import { outreachOperationDefinitions } from "./outreach-operations.js";
import { businessOperationDefinitions } from "./business-operations.js";
import { researchOperationDefinitions } from "./research-operations.js";
import { identityOperationDefinitions, type IdentityDefinition } from "./identity-operations.js";
import { linkedinOperationDefinitions } from "./linkedin-operations.js";
import { crmPreferencesOperationDefinitions } from "./crm-preferences.js";
import { crmSyncControlsOperationDefinitions } from "./crm-sync-controls.js";
import { customerExclusionsOperationDefinitions } from "./customer-exclusions.js";
import { RunProgressQuerySchema, RunProgressSchema } from "./run-progress.js";
import { NextStepSchema } from "./next-step-contracts.js";
import { WorkspaceSummarySchema, readResult } from "./workspace-summary.js";
import { CrmRecordsQuerySchema, CrmRecordsSchema } from "./crm-records.js";
import {
  CrmCapabilitiesReadSchema, CrmMappingCatalogSchema, CrmMappingSourcesRequestSchema, CrmMappingSourcesSchema,
  CrmMappingPreviewRequestSchema, CrmMappingPreviewSchema, CrmMappingApplyRequestSchema,
  CrmMappingApplySchema, CrmMappingPropertyCreateRequestSchema, CrmMappingPropertyCreateSchema,
  CrmMappingSyncRequestSchema, CrmMappingSyncSchema, CrmMappingStatusQuerySchema, CrmMappingStatusSchema,
} from "./crm-mapping/contracts.js";
import { z } from "zod";
import { ConfirmRunReviewRequestSchema, CrmConnectionStatusSchema, NotificationConfigSchema, NotificationDestinationSchema, RunStatusSchema, SetNotificationRouteRequestSchema, SlackNotificationChannelsSchema, StartRunResultSchema, UpsertNotificationDestinationRequestSchema, WorkspaceStatusSchema, StartCrmSyncResultSchema, CrmSyncStatusSchema, DisconnectResponseSchema, NotificationTestResultSchema } from "./contracts.js";
import { DeleteLoginRequest, DeleteLoginResult } from "./login-deletion.js";
import { CompanyMappingContextSchema, CompanyMappingReceiptSchema } from "./company-mapping.js";
import { CompanyPlanSchema } from "./company-mapping/contract.js";
import { WarmupWorkspaceRequest, WarmupStatus, WarmupStartResult } from "./email-warmup-contracts.js";
import { ConnectionPlacementStatus, PlacementStartRequest, PlacementStatusRequest } from "./email-connection-placement.js";
import { DeliverabilityQueryParams, DeliverabilityResponse } from "./email-deliverability-contracts.js";

const JsonSchema = z.record(z.string(), z.unknown());
export const StageOperationSchema = z.object({
  method: z.enum(["GET", "POST", "PATCH", "DELETE"]),
  readOnly: z.boolean(),
  route: z.string().regex(/^\/v1\/[A-Za-z0-9_{}\/-]+$/),
  description: z.string().min(1),
  request: z.object({ path: JsonSchema, query: JsonSchema, body: JsonSchema.nullable() }),
  responses: z.record(z.string().regex(/^[1-5][0-9]{2}$/), JsonSchema),
  cli: z.object({ operation: z.string().min(1) }).strict().optional(),
});
export type StageOperation = z.infer<typeof StageOperationSchema>;

export const StageErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), issues: z.array(z.object({code:z.string(),path:z.string(),message:z.string(),suggestion:z.string()}).strict()).optional(), current_version:z.number().int().nonnegative().optional(), stale_sources:z.array(z.string()).optional(), workspaces:z.array(z.object({workspace_ref:z.uuid(),name:z.string(),slug:z.string()}).strict()).optional(), limit:z.number().int().positive().optional(), resets_at:z.iso.datetime({ offset: true }).optional() }),
  request_id: z.string(),
});
const Empty = z.object({}).strict();
const CrmMaintenance = " May refresh and replace stored CRM credentials or mark the connection as needing reconnect; this synchronous maintenance uses the existing authorization and does not save mappings or write CRM records.";
/** The founder's CRM; an omitted provider keeps older clients on HubSpot. Never inferred. */
export const CrmConnectRequestSchema = z.object({ provider: z.enum(["hubspot", "attio"]).optional() }).strict();
// LIF-1138: one of the caller's own workspaces, by slug or reference.
const AttemptRef = z.uuid();
export const AuthorizationRequiredSchema = z.object({
  status: z.literal("authorization_required"),
  attempt_ref: AttemptRef,
  connection_url: z.url(),
  expires_at: z.iso.datetime({ offset: true }),
}).strict();
export const ConnectionAttemptStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending"), attempt_ref: AttemptRef,
    expires_at: z.iso.datetime({ offset: true }), retry_after_seconds: z.number().int().min(1) }).strict(),
  z.object({ status: z.literal("connected"), attempt_ref: AttemptRef,
    verified: z.literal(true) }).strict(),
  z.object({ status: z.enum(["expired", "denied", "failed"]), attempt_ref: AttemptRef,
    error_code: z.string().min(1).optional() }).strict(),
]);
export const ConnectionAttemptQuerySchema = z.object({ attempt_ref: AttemptRef.optional() }).strict();
export const NotificationStagePatchSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("destination"), values: UpsertNotificationDestinationRequestSchema }).strict(),
  z.object({ operation: z.literal("route"), values: SetNotificationRouteRequestSchema }).strict(),
]);

function json(schema: z.ZodType, io: "input" | "output" = "output") {
  return z.toJSONSchema(schema, { io });
}
function operation(method: StageOperation["method"], route: string, description: string,
  response: z.ZodType | null, body: z.ZodType | null = null, query: z.ZodType = Empty,
  path: z.ZodType = Empty): StageOperation {
  return {
    method, route, description, readOnly: method === "GET",
    request: { path: json(path, "input"), query: { type: "object", ...json(query, "input") }, body: body ? json(body, "input") : null },
    responses: response
      ? { "200": json(response), "400": json(StageErrorSchema), "401": json(StageErrorSchema),
        "403": json(StageErrorSchema), "404": json(StageErrorSchema), "413": json(StageErrorSchema), "409": json(StageErrorSchema), "422": json(StageErrorSchema),
        "429": json(StageErrorSchema), "502": json(StageErrorSchema), "503": json(StageErrorSchema), "504": json(StageErrorSchema) }
      : { "405": json(StageErrorSchema), "401": json(StageErrorSchema) },
  };
}
const stageRoute = (stage: string) => `/v1/workspace/${stage}`;
const unsupported = (stage: string, method: "POST" | "PATCH" | "DELETE", reason: string) =>
  operation(method, stageRoute(stage), `Unsupported: ${reason} Returns 405 STAGE_OPERATION_UNSUPPORTED; no changes.`, null, Empty);
const businessCatalog = Object.fromEntries(Object.entries(businessOperationDefinitions).map(([resource, entries]) => [resource, Object.fromEntries(Object.entries(entries).map(([key, definition]) => [key, {
  ...operation(definition.method, definition.route, definition.description, definition.response,
    ["POST", "PATCH"].includes(definition.method) ? definition.request : null),
  ...("cli" in definition ? { cli: definition.cli } : {}),
  ...(resource === "business" && key === "post" ? { responses: { ...operation(definition.method, definition.route, definition.description, definition.response, definition.request).responses, "201": json(definition.response) } } : {}),
}]))]));
// Identity and LinkedIn operations publish their success status: 201 for
// creation and, for disconnect/delete, both 200 (access removal confirmed) and 202.
const definitionCatalog = (definitions: Record<string, Record<string, IdentityDefinition>>) => Object.fromEntries(Object.entries(definitions).map(([resource, entries]) => [resource, Object.fromEntries(Object.entries(entries).map(([key, definition]) => {
  const base = operation(definition.method, definition.route, definition.description, definition.response, definition.request, definition.query, definition.path);
  const success = json(definition.response);
  const { "200": _ok, ...errors } = base.responses;
  return [key, { ...base, readOnly: definition.readOnly ?? base.readOnly, ...(definition.cli ? { cli: definition.cli } : {}),
    responses: definition.success === 201 ? { "201": success, ...errors } : definition.success === 202 ? { "200": success, "202": success, ...errors } : base.responses }];
}))]));
const identityCatalog = definitionCatalog(identityOperationDefinitions);
const linkedinCatalog = definitionCatalog(linkedinOperationDefinitions);
const crmPreferencesCatalog = definitionCatalog(crmPreferencesOperationDefinitions);
const crmSyncControlsCatalog = definitionCatalog(crmSyncControlsOperationDefinitions);
const customerExclusionsCatalog = definitionCatalog(customerExclusionsOperationDefinitions);
const outreachCatalog = Object.fromEntries(Object.entries(outreachOperationDefinitions).map(([resource, entries]) => [resource,
  Object.fromEntries(Object.entries(entries).map(([key, definition]) => {
    const base = operation(definition.method, definition.route, definition.description, definition.response, definition.request, definition.query, definition.path);
    const { "200": _ok, ...errors } = base.responses;
    return [key, { ...base, cli: definition.cli, responses: { [definition.success]: json(definition.response), ...errors } }];
  }))]));
// Public guide of an Identity stage; `lifty context <stage>` and the MCP tool read the same document.
const stageContext = (stage: string, description: string) => ({ ...operation("GET", `/v1/context/${stage}`, description, z.record(z.string(), z.unknown())), cli: { operation: "context" } });
const researchCatalog = Object.fromEntries(Object.entries(researchOperationDefinitions).map(([resource, entries]) => [resource, Object.fromEntries(Object.entries(entries).map(([key, definition]) => [key, {
  ...operation(definition.method, definition.route, definition.description, definition.response, definition.request, definition.query),
  ...("cli" in definition ? { cli: definition.cli } : {}),
}]))]));
// These definitions are also the contracts for the thin authenticated adapters
// implemented with the generic stage transport. Existing business handlers and
// their authorization, validation, jobs and protected-field rules remain owners.
export const stageOperations: Record<string, Record<string, StageOperation>> = {
  summary: {
    next_step: operation("GET", "/v1/workspace/next-step", "Read the next step from saved Business resources, setup draft, research and campaign receipts together with the current stage guide. Does not start work, accept a sample or authorize sending.", NextStepSchema),
    context: operation("GET", "/v1/context/{task}", "Read the complete current guide, references and operation schemas for a specific requested Lifty stage.", z.record(z.string(), z.unknown()), null, Empty, z.object({ task: z.string().regex(/^[a-z][a-z-]{0,63}$/) }).strict()),
    get: operation("GET", stageRoute("summary"), "Read the selected workspace's typed Business resources and versions, immutable setup receipt, first research run, research schedule, HubSpot and its last sync, senders with their sending accounts, and the saved campaign. Read-only: it never checks or changes a provider. Does not authorize outreach. Unavailable means retry, not missing setup.", WorkspaceSummarySchema),
    post: unsupported("summary", "POST", "The summary is read-only."),
    patch: unsupported("summary", "PATCH", "The summary is read-only."),
  },
  business: { ...businessCatalog.business!, delete: unsupported("business", "DELETE", "Profile revisions and pinned history are retained. Customers cannot delete a workspace; contact LIFT support.") },
  targeting: { ...businessCatalog.targeting!, post: unsupported("targeting", "POST", "Setup creates targeting together with criteria."), delete: unsupported("targeting", "DELETE", "Search activation belongs to the research schedule; targeting history is retained.") },
  "research-criteria": { ...businessCatalog["research-criteria"]!, post: unsupported("research-criteria", "POST", "Setup creates criteria together with targeting."), delete: unsupported("research-criteria", "DELETE", "Use PATCH to clear criteria; pinned history is retained.") },
  "customer-exclusions": customerExclusionsCatalog["customer-exclusions"]!,
  setup: businessCatalog.setup!,
  account: { delete: operation("POST", "/v1/me/delete", "Delete your own login only after all memberships and retained-history restrictions are resolved.", DeleteLoginResult, DeleteLoginRequest) },
  "sample-review": {
    progress: operation("GET", "/v1/workspace/runs/progress", "Wait up to 25 seconds for a change to this exact run. Pass the last cursor to resume. Returns the complete current bounded cohort, live research count and terminal state; not a persisted event history. A failed run's error_code is a customer reason. Read-only and reauthorized on each poll.", RunProgressSchema, null, RunProgressQuerySchema),
    get: operation("GET", stageRoute("sample-review"), "Read the current sample: its five people, grades, run state, reviewed_at once the founder confirmed it and, when failed, the customer reason in error_code.", RunStatusSchema),
    confirm: operation("POST", "/v1/workspace/sample-review/confirm", "Record that the founder confirmed the latest finished sample, by its run_ref, when they accept it or move on without changes. Repeating it keeps the first confirmation. next_step returns the sample review until the latest sample is confirmed. Does not change targeting, start research or authorize outreach.", RunStatusSchema, ConfirmRunReviewRequestSchema),
    post: operation("POST", stageRoute("sample-review"), "Queue a five-person discovery and research sample for the current targeting, reattach an active run, or retry an incomplete failed sample using its saved people. Consumes this week's research volume; when a new sample cannot reserve five places, returns RESEARCH_LIMIT_REACHED and resets_at and starts nothing. Check sample_review_progress or sample_review_get for completion. Never activates weekly research, CRM sync or outreach.", StartRunResultSchema, Empty),
  },
  "research-schedule": {
    ...researchCatalog["research-schedule"]!,
    post: unsupported("research-schedule", "POST", "The schedule exists from workspace creation; use activate or pause."),
    delete: unsupported("research-schedule", "DELETE", "The schedule has no delete; pause it to stop new research."),
  },
  leads: {
    ...researchCatalog.leads!,
    post: unsupported("leads", "POST", "Leads are research results; Lifty creates them."),
    patch: unsupported("leads", "PATCH", "Lead detail and feedback live in the dashboard."),
    delete: unsupported("leads", "DELETE", "Researched leads and their history are retained."),
  },
  "commercial-voice": { ...businessCatalog["commercial-voice"]!, post: unsupported("commercial-voice", "POST", "Empty voice exists at version 0 from workspace creation."), delete: unsupported("commercial-voice", "DELETE", "Use PATCH to clear values; pinned history is retained.") },
  crm: {
    sync_start: operation("POST", "/v1/workspace/crm/sync", "Queue delivery of up to 2,000 eligible saved leads to the current workspace's connected HubSpot or Attio account. Reattaches an active sync or retries its failed cohort before selecting unsynced qualified leads. Creates or updates CRM contacts and companies and mirrors research according to saved CRM preferences. Returns an asynchronous run_ref; does not discover leads or send outreach. While automatic sync is paused it returns CRM_AUTOMATIC_SYNC_PAUSED.", StartCrmSyncResultSchema, Empty),
    sync_status: operation("GET", "/v1/workspace/crm/sync", "Read the latest CRM sync receipt, identified by its run_ref. A different run cannot prove an earlier sync completed. This read never starts or repeats a sync.", CrmSyncStatusSchema),
    capabilities: { ...operation("GET", "/v1/workspace/crm/capabilities", "Read whether the CRM is connected, needs a reconnect or is not connected and, when connected, whether its credential can map fields and create fields per object, from the scopes the provider reports. Reconnecting with POST adds a missing permission." + CrmMaintenance, CrmCapabilitiesReadSchema), readOnly: false },
    mapping_catalog: { ...operation("GET", "/v1/workspace/crm/mapping/catalog", "Read the current workspace's full saved mapping, supported sources/transforms/write rules, the connection's capabilities and the live CRM schema: HubSpot contact/company properties or Attio People/Companies attributes, including internal enum values and select options. Covers the complete mapping rather than only bounded company setup." + CrmMaintenance, CrmMappingCatalogSchema), readOnly: false },
    mapping_sources: { ...operation("POST", "/v1/workspace/crm/mapping/sources", "Read saved discovery/research evidence for the explicitly selected leads. Person location and company headquarters are distinct; a missing source is unknown. Does not acquire or enrich leads.", CrmMappingSourcesSchema, CrmMappingSourcesRequestSchema), readOnly: true },
    mapping_preview: operation("POST", "/v1/workspace/crm/mapping/preview", "Preview up to 25 explicitly selected saved leads against the connected HubSpot or Attio schema and existing record values, using saved mappings or optional unsaved edits. Returns proposed field values, skipped reasons, conflicts and preview_digest." + CrmMaintenance, CrmMappingPreviewSchema, CrmMappingPreviewRequestSchema),
    mapping_apply: operation("POST", "/v1/workspace/crm/mapping/apply", "Save explicit validated edits to the full mapping with current portal and mapping version checks, preserving unrelated mappings. Does not sync CRM records or create properties.", CrmMappingApplySchema, CrmMappingApplyRequestSchema),
    property_create: operation("POST", "/v1/workspace/crm/mapping/property_create", "Explicitly create a missing HubSpot property or Attio attribute when the connection has the permission (capabilities create_fields); otherwise returns *_PERMISSION_REQUIRED. Requires evidence that no compatible property already exists; cannot bypass mapping conflicts.", CrmMappingPropertyCreateSchema, CrmMappingPropertyCreateRequestSchema),
    mapping_sync: operation("POST", "/v1/workspace/crm/mapping/sync", "Queue updates to existing contacts and companies in the current workspace's connected HubSpot or Attio account for up to 25 explicitly selected leads, using saved mappings, the current preview_digest and a stable request_ref. Mapping write policies may overwrite existing field values. Repeating the same request reuses its exact run_ref. Returns an asynchronous receipt, not verified completion. Does not create CRM records, discover leads or send outreach.", CrmMappingSyncSchema, CrmMappingSyncRequestSchema),
    mapping_status: operation("GET", "/v1/workspace/crm/mapping/status", "Read the exact mapping replay receipt, including per-field live readback and skipped or stale values. Partial or failed runs are not full success.", CrmMappingStatusSchema, null, CrmMappingStatusQuerySchema),
    ...crmPreferencesCatalog.crm!,
    ...crmSyncControlsCatalog.crm!,
    records: { ...operation("GET", "/v1/workspace/crm/records", "Read verified HubSpot or Attio contact and company links for the existing sync cohort. Supply the known run_ref or omit for the latest CRM sync. This never starts a sync." + CrmMaintenance, CrmRecordsSchema, null, CrmRecordsQuerySchema), readOnly: false },
    get: operation("GET", stageRoute("crm"), "Without attempt_ref read the connected CRM (HubSpot or Attio; provider null when none). With it verify only that exact authorization attempt, including reconnection.", z.union([CrmConnectionStatusSchema, ConnectionAttemptStatusSchema]), null, ConnectionAttemptQuerySchema),
    post: operation("POST", stageRoute("crm"), "Start a new connection/reconnection of the CRM the founder uses and return the real consent link immediately. Send provider hubspot or attio; omitted means HubSpot. One CRM at a time: disconnect the other first.", AuthorizationRequiredSchema, CrmConnectRequestSchema),
    patch: operation("PATCH", stageRoute("crm"), "HubSpot only: apply a bounded company mapping plan using the current mapping schema. No tokens, arbitrary mappings or connected flag updates.", CompanyMappingReceiptSchema, CompanyPlanSchema),
    mapping_context: { ...operation("GET", "/v1/workspace/crm/mapping-context", "HubSpot only: read the live portal company schema/mapping and its bounded input schema. Attio needs no separate company setup." + CrmMaintenance, CompanyMappingContextSchema), readOnly: false },
    disconnect: operation("POST", "/v1/workspace/crm/disconnect", "Disconnect the connected CRM (HubSpot or Attio) from the current workspace. HubSpot grants are revoked at HubSpot; Lifty deletes its Attio token. Refused while a CRM sync is running or when no CRM is connected. Records already written stay in the CRM.", DisconnectResponseSchema, Empty),
    client_mapping_context: { ...operation("GET", "/v1/integrations/hubspot/company-mapping/context", "Read the live HubSpot company schema, current mapping and bounded plan schema for an explicitly named workspace you belong to." + CrmMaintenance, CompanyMappingContextSchema, null, z.object({ workspace_ref: z.uuid() }).strict()), readOnly: false },
    client_mapping_apply: operation("POST", "/v1/integrations/hubspot/company-mapping", "Apply a bounded company mapping plan to the workspace named in the plan, using its current mapping and schema versions. No tokens, arbitrary mappings or connected flag updates.", CompanyMappingReceiptSchema, CompanyPlanSchema),
  },
  senders: {
    context: stageContext("senders", "Read the public guide for senders: who a sender is, roster-first lookup by id, name, signature and booking link rules, and soft delete. No workspace data."),
    ...identityCatalog.senders!,
  },
  "sending-accounts": {
    context: stageContext("sending-accounts", "Read the public guide for sending accounts: connect, reconnect, pause, resume, disconnect, observation and the browser declaration. No workspace data."),
    ...identityCatalog["sending-accounts"]!,
    // Email-owned operations keep their single implementation and wording here until the Email block (LIF-1186) moves them.
    warmup_status: operation("GET","/v1/email/warmup","Read warmup status for an explicit workspace and mailbox. connection_ref is the sending account id; it is required when the workspace has several email accounts. warmup_ready is warmup's own contribution only: campaign activation, placement and pauses are separate.",WarmupStatus,null,WarmupWorkspaceRequest),
    deliverability: operation("GET","/v1/email/deliverability","Read inbox health for an explicit workspace: each inbox's senders, warmup, recent placement tests, campaigns, send checks and today's sends against its daily limit, with the same states and explanations as the Deliverability page. Filter by sender ref or unassigned, or one mailbox; detail=placement reads stored reports for one mailbox_ref. Read-only: never starts a placement test or changes sending.",DeliverabilityResponse,null,DeliverabilityQueryParams),
    warmup_start: operation("POST","/v1/email/warmup/start","Start warmup for a verified mailbox (connection_ref = sending account id, required when the workspace has several email accounts) through Lifty's setup link for Google or Microsoft, the owner's second sign-in after connecting; no password fallback. connect_url is null when this mailbox's warmup is already set up, and a new call replaces an unused link. A dedicated mailbox needs a healthy check after 21 active warmup days before it can send. Starting warmup never pauses or resumes campaigns.",WarmupStartResult,WarmupWorkspaceRequest),
    placement_status: operation("GET","/v1/email/placement","Read the latest Mailivery placement test for one warmed mailbox (connection_ref when the workspace has several), whether a new one can be requested, and whether its result gates sending. Read-only.",ConnectionPlacementStatus,null,PlacementStatusRequest),
    placement_start: operation("POST","/v1/email/placement/start","Queue one Mailivery placement test for a warmed mailbox only after the user explicitly agrees: Mailivery sends the given subject/body from that mailbox to roughly 20-40 of its seed inboxes and uses one test credit. Use the first email of the real sequence. A retried start returns the open test. The result never releases a mailbox or starts campaigns.",ConnectionPlacementStatus,PlacementStartRequest),
    ...Object.fromEntries((["pause","resume","remove"] as const).map(action=>[`warmup_${action}`,operation("POST",`/v1/email/warmup/${action}`,`${action[0]!.toUpperCase()+action.slice(1)} warmup for the explicit workspace and mailbox (connection_ref = sending account id). Warmup pause, resume and remove never pause or resume outreach campaigns.`,WarmupStatus,WarmupWorkspaceRequest)])),
  },
  ...outreachCatalog,
  linkedin: {
    context: stageContext("linkedin", "Read the public guide for LinkedIn outreach: what Lifty sends, who owns sequences and accounts, what the activity counts mean and why work waits. No workspace data."),
    ...linkedinCatalog.linkedin!,
  },
  notifications: {
    get: operation("GET", stageRoute("notifications"), "Without attempt_ref read the notification types with the channels each can use, the destinations (each saved Slack channel and the workspace owner's email) with the types each receives, and Slack state. With it verify only that exact Slack authorization attempt.", z.union([NotificationConfigSchema, ConnectionAttemptStatusSchema]), null, ConnectionAttemptQuerySchema),
    post: operation("POST", stageRoute("notifications"), "Start Slack connection/reconnection and immediately return the workspace consent link and exact attempt reference. Supersedes earlier unused pending Slack consent links for this workspace. Does not replace the existing Slack grant, change notification destinations or post a message. Show the returned link; connection requires user consent and verification of that exact attempt.", AuthorizationRequiredSchema, Empty),
    patch: operation("PATCH", stageRoute("notifications"), "Save a Slack channel as a destination (operation destination; needs connected Slack; a new destination receives every default-on type Slack can show), or subscribe or unsubscribe one destination, a Slack channel or the owner email, to one notification type (operation route). Returns the saved destination. This cannot authorize Slack or send a test.", NotificationDestinationSchema, NotificationStagePatchSchema),
    channels: operation("GET", "/v1/notifications/slack/channels", "Read Slack channels currently available to Lifty before choosing a destination.", SlackNotificationChannelsSchema),
    test: operation("POST", "/v1/notifications/destinations/{destination_ref}/test", "Send one test message to a saved Slack destination, active or not; needs connected Slack. Posts a visible message in that channel and returns the accepted request_ref, not proof of delivery. The owner email destination cannot be tested. Does not change subscriptions or authorize outreach.", NotificationTestResultSchema, Empty, Empty, z.object({ destination_ref: z.uuid() }).strict()),
    disconnect: operation("POST", "/v1/workspace/notifications/disconnect", "Disconnect Slack from the current workspace. Slack notifications stop until Slack is reconnected; saved destinations and their subscriptions are not deleted.", DisconnectResponseSchema, Empty),
  },
};
