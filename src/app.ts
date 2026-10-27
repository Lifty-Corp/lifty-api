import { connectionProfileAllows } from "./runtime-profile.js";
import { SetNotificationControlsRequestSchema, SetNotificationPreferencesRequestSchema, type SetNotificationControlsRequest, type SetNotificationPreferencesRequest } from "./contracts.js";
import { historicalEmailResult, historicalOperation, HistoricalEmailResultSchema } from "./historical-outreach.js";
import { executeOutreachOperation, type OutreachInput } from "./outreach-operations.js";
import { executeLinkedinOperation, type LinkedinInput } from "./linkedin-operations.js";
import { executeCrmPreferencesOperation } from "./crm-preferences.js";
import { executeCrmSyncControlsOperation } from "./crm-sync-controls.js";
import { executeCustomerExclusionsOperation } from "./customer-exclusions.js";
import { AcquisitionRecoveryBody, AcquisitionRecoveryStatus, AcquisitionRestartResult, type AcquisitionRecoveryInput, type AcquisitionRecoveryOutput } from "./acquisition-recovery.js";
import { RepairIssueSchema } from "./business-contracts.js";
import { executeBusinessOperation } from "./business-operations.js";
import { executeResearchOperation } from "./research-operations.js";
import { DEFAULT_DASHBOARD_ORIGIN } from "./config.js";
import { createConfirmationRouter, invalidConfirmation, type ConfirmationAdapters, type ConfirmationAdapter, type ConfirmationLog } from "./connection-confirmation.js";
import type { RunProgressQuery, RunProgress } from "./run-progress.js";
import type { CrmMappingOperation } from "./crm-mapping/contracts.js";
import { CrmMappingError } from "./crm-mapping.js";
import { registerStageRoutes } from "./stage-routes.js";
import { handleMcpRequest, mcpResourceMetadata, type McpDependencies } from "./mcp.js";
import { getStageMcpTools, callStageMcpTool } from "./mcp-stage-tools.js";
import { PENDING_SUBMIT_SCRIPT_HASH, renderLiftyPage } from "./lifty-brand.js";
import { readFileSync } from "node:fs";
import { createWarmupSetupRouter } from "./warmup-setup-routes.js";
import type { WarmupSetup } from "./warmup-setup.js";
import { getConnectionAttempt, type ConnectionAttemptStatus, type ConnectionProvider } from "./connection-attempt.js";
import {
  type CompanyMappingOperation,
  CompanyMappingContextSchema,
  CompanyMappingReceiptSchema,
  CompanyMappingError,
} from "./company-mapping.js";
import { RetireWorkspaceRequest, RetireWorkspaceConfirmation, RetireWorkspaceResult, type RetireWorkspaceInput, type RetireWorkspaceOutput } from "./workspace-retirement.js";
import { DeleteLoginRequest, DeleteLoginResult, type DeleteLoginInput, type DeleteLoginOutput } from "./login-deletion.js";
import { MemberWorkspacesResult, type MemberWorkspacesOutput } from "./member-workspaces.js";

import { OpenAPIHono, z } from "@hono/zod-openapi";
import { analyticsSurface, isInternalRequest, noopAnalytics, type Analytics, type AnalyticsSurface } from "./analytics.js";
import { CLIENT_UPGRADE_MESSAGE, STAGE_CLIENT_CONTRACT, SUPPORTED_CLIENT_CONTRACTS, AgentContextSchema, getAgentContext, isSupportedClientContract, type ContextDraft } from "./agent-context.js";
import { readContextDrafts } from "./context-drafts.js";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { DisconnectResponseSchema, IntegrationConnectionStatusSchema, NotificationConfigSchema, NotificationDestinationSchema, NotificationTestResultSchema, SetNotificationRouteRequestSchema, SlackNotificationChannelsSchema, UpsertNotificationDestinationRequestSchema, ProviderConnectStartSchema, LegacyProviderConnectStartSchema, SlackConnectLinkSchema, type SlackConnectLink, ProviderSchema, StartCrmSyncResultSchema, CrmSyncStatusSchema, type DisconnectResult, type HubspotConnectStart, type HubspotConnectionStatus, type AttioConnectStart, type AttioConnectionStatus, type NotificationConfig, type NotificationDestination, type NotificationTestResult, type SetNotificationRouteRequest, type SlackNotificationChannels, type UpsertNotificationDestinationRequest, type Provider, type SlackConnectStart, type SlackConnectionStatus, type RunStatus, type StartRunResult, type StartCrmSyncResult, type CrmSyncStatus, WorkspaceStatusSchema, type WorkspaceStatus } from "./contracts.js";
import { type EnqueueCrmSync, type EnqueueFirstRun, type EnqueueIntegrationRevocation } from "./trigger-client.js";
import { PublicError } from "./errors.js";
import { listAdminWorkspaces, type AdminWorkspace } from "./admin-onboarding.js";
import {
  HubspotCallbackError,
  type HubspotCallbackSuccess,
} from "./hubspot-connect.js";
import { isSealedHubspotState } from "./hubspot-state.js";
import {
  SlackCallbackError,
  type SlackCallbackSuccess,
} from "./slack-connect.js";
import { isSealedSlackState } from "./slack-state.js";
import { isSealedAttioState } from "./attio-state.js";

import { HistoricalEmailCampaignRequest, EmailCampaignRequest, EmailCampaignResult, EmailPlacementResult, EmailPlacementPreview, campaignResultFor, type EmailCampaignInput, type EmailCampaignOutput } from "./email-campaign-contracts.js";
import { EmailWorkspace } from "./email-contracts.js";
import { connectorUnavailable, executeIdentityOperation, type IdentityInput, type IdentityResult } from "./identity-operations.js";
import { createAccountConnectRouter } from "./account-connect-routes.js";
import type { AccountConnection } from "./account-connection.js";
import { WarmupStartResult, WarmupStatus, WarmupWorkspaceRequest, type WarmupStartResult as WarmupStart, type WarmupStatus as WarmupStatusValue } from "./email-warmup-contracts.js";
import { ConnectionPlacementStatus, PlacementStartRequest, PlacementStatusRequest, type PlacementStartInput, type PlacementStatusInput } from "./email-connection-placement.js";
import { DeliverabilityQuery, DeliverabilityQueryParams, DeliverabilityResponse, type DeliverabilityQuery as DeliverabilityQueryValue, type DeliverabilityResponse as DeliverabilityResponseValue } from "./email-deliverability-contracts.js";


const MAX_REQUEST_BYTES = 132 * 1024;
// The create-workspace body carries only a bounded name and description.
const MAX_CREATE_WORKSPACE_BYTES = 16 * 1024;
// One shared per-user budget for expensive provisioning, run and provider operations.
const rateLimitedPaths = new Set([
  "/v1/workspace/business", "/v1/workspace/setup", "/v1/workspace/sample-review", "/v1/integrations/hubspot/company-mapping", "/v1/email/warmup/start",
  "/v1/workspace/customer-exclusions/import",
  "/v1/workspace/crm", "/v1/workspace/notifications", "/v1/workspace/senders", "/v1/workspace/sending-accounts/connect",
  "/v1/workspace/crm/mapping/apply", "/v1/workspace/crm/mapping/property_create", "/v1/workspace/crm/mapping/sync", "/v1/integrations/hubspot/sync", "/v1/integrations/attio/sync", "/v1/workspace/crm/sync",
  "/v1/workspace/crm/test-sync",
]);
const rateLimitedPatterns = [/^\/v1\/workspace\/sending-accounts\/[^/]+\/(?:reconnect|disconnect)$/, /^\/v1\/workspace\/senders\/[^/]+\/delete$/,
  /^\/v1\/notifications\/destinations\/[^/]+\/test$/];
const RequestIdSchema = z.uuid();
const SubmissionRefSchema = z.uuid();
const DestinationRefSchema = z.uuid();

export interface AuthSession {
  userId: string;
  client: unknown;
  /** An explicit workspace for LIFT admin reads (LIF-1297). Founder sessions
   * leave it unset and select through x-lifty-workspace. */
  workspaceRef?: string;
}

export type AuthenticationResult =
  | { ok: true; session: AuthSession }
  | { ok: false; reason: "invalid_session" };

export type { WorkspaceStatus } from "./contracts.js";

export interface AppDependencies {
  runtimeProfile?: "full" | "connections";
  openAiAppsChallenge?: string;
  mcp?: McpDependencies;
  renderOAuthConsentPage?(authorizationId: string): { html: string; scriptNonce: string; connectOrigin: string };
  warmupSetup?: WarmupSetup;
  getConnectionAttempt(session: AuthSession, provider: ConnectionProvider, attemptRef: string, workspace: string): Promise<ConnectionAttemptStatus>;
  acquisitionRecovery(session: AuthSession, input: AcquisitionRecoveryInput): Promise<AcquisitionRecoveryOutput>;
  retireWorkspace(session: AuthSession, input: RetireWorkspaceInput): Promise<RetireWorkspaceOutput>;
  deleteOwnLogin(session: AuthSession, input: DeleteLoginInput): Promise<DeleteLoginOutput>;
  emailCampaign(session: AuthSession, input: EmailCampaignInput): Promise<EmailCampaignOutput>;
  getEmailWarmup(session: AuthSession, workspace: string, connectionRef?: string): Promise<WarmupStatusValue>;
  startEmailWarmup(session: AuthSession, workspace: string, connectionRef?: string): Promise<WarmupStart>;
  changeEmailWarmup(session: AuthSession, workspace: string, operation: "pause" | "resume" | "remove", connectionRef?: string): Promise<WarmupStatusValue>;
  getEmailDeliverability(session: AuthSession, query: DeliverabilityQueryValue): Promise<DeliverabilityResponseValue>;
  getEmailPlacement(session: AuthSession, input: PlacementStatusInput): Promise<ConnectionPlacementStatus>;
  startEmailPlacement(session: AuthSession, input: PlacementStartInput): Promise<ConnectionPlacementStatus>;
  /** Senders and sending accounts (LIF-1182); provider effects go through the account connection. */
  outreachOperation(session: AuthSession, key: string, input: OutreachInput): Promise<unknown>;
  identityOperation(session: AuthSession, key: string, input: IdentityInput, signal?: AbortSignal): Promise<IdentityResult>;
  /** LinkedIn activity and waiting reasons (LIF-1190); read-only. */
  linkedinOperation(session: AuthSession, key: string, input: LinkedinInput): Promise<unknown>;
  /** CRM research-note and conversation preferences (LIF-1239). */
  crmPreferencesOperation(session: AuthSession, key: string, input: IdentityInput): Promise<unknown>;
  /** CRM automatic sync and the bounded test sync (LIF-1622). */
  crmSyncControlsOperation(session: AuthSession, key: string, input: IdentityInput): Promise<unknown>;
  /** Founder CSV customer protections (LIF-1082), with no provider effects. */
  customerExclusionsOperation(session: AuthSession, key: string, input: IdentityInput): Promise<unknown>;
  /** Browser connect page and confirmation shell for sending accounts. */
  accounts?: { connection: AccountConnection; origin: string; hostedOrigins: string[] };
  authenticate(request: Request): Promise<AuthenticationResult>;
  businessOperation(session: AuthSession, key: string, payload?: unknown): Promise<unknown>;
  getWorkspace(session: AuthSession): Promise<WorkspaceStatus>;
  listMemberWorkspaces(session: AuthSession): Promise<MemberWorkspacesOutput>;
  /** Every workspace for a LIFT admin; the database enforces is_admin (LIF-1297). */
  listAdminWorkspaces(session: AuthSession): Promise<AdminWorkspace[]>;
  /** A marked test workspace's context drafts (LIF-1298); never rejects, and
   * any failed read is an empty list, so published context is served. */
  readContextDrafts(session: AuthSession, workspaceRef: string | null): Promise<ContextDraft[]>;
  // Research schedule, weekly status and lead list (LIF-1174). Like every
  // stage RPC, the workspace is the one the database selects for the session.
  researchOperation(session: AuthSession, key: string, input: { query: Record<string, unknown>; body: unknown }): Promise<unknown>;
  startRun(session: AuthSession): Promise<StartRunResult>;
  getRunStatus(session: AuthSession): Promise<RunStatus>;
  confirmRunReview(session: AuthSession, runRef: string): Promise<RunStatus>;
  getRunProgress(session: AuthSession, query: RunProgressQuery, signal: AbortSignal): Promise<RunProgress>;
  enqueueFirstRun: EnqueueFirstRun;
  startCrmSyncRun(session: AuthSession): Promise<StartCrmSyncResult>;
  getCrmSyncStatus(session: AuthSession): Promise<CrmSyncStatus>;
  runCrmMapping: CrmMappingOperation;
  enqueueCrmSync: EnqueueCrmSync;
  disconnectIntegration(session: AuthSession, provider: Provider): Promise<DisconnectResult>;
  enqueueIntegrationRevocation: EnqueueIntegrationRevocation;
  /** Notification configuration in the notifications schema (LIF-1464). */
  getNotificationConfig(session: AuthSession): Promise<NotificationConfig>;
  setNotificationControls(session: AuthSession, input: SetNotificationControlsRequest): Promise<NotificationConfig>;
  setNotificationPreferences(session: AuthSession, input: SetNotificationPreferencesRequest): Promise<NotificationConfig>;
  companyMapping: CompanyMappingOperation;
  listSlackNotificationChannels(session: AuthSession): Promise<SlackNotificationChannels>;
  upsertNotificationDestination(
    session: AuthSession,
    input: UpsertNotificationDestinationRequest,
  ): Promise<NotificationDestination>;
  /** Subscribes or unsubscribes one destination to one type; returns it. */
  setNotificationRoute(
    session: AuthSession,
    input: SetNotificationRouteRequest,
  ): Promise<NotificationDestination>;
  /** Queues one test message to a saved Slack destination. */
  sendNotificationTest(
    session: AuthSession,
    destinationRef: string,
  ): Promise<NotificationTestResult>;
  startHubspotConnect(session: AuthSession): Promise<HubspotConnectStart>;
  getHubspotConnection(session: AuthSession): Promise<HubspotConnectionStatus>;
  completeHubspotCallback(
    input: { code: string; state: string },
  ): Promise<HubspotCallbackSuccess>;
  denyHubspotCallback(state: string): Promise<void>;
  buildHubspotAuthorizeUrl(state: string): string | null;
  startAttioConnect(session: AuthSession): Promise<AttioConnectStart>;
  getAttioConnection(session: AuthSession): Promise<AttioConnectionStatus>;
  buildAttioAuthorizeUrl(state: string): string | null;
  startSlackConnect(session: AuthSession): Promise<SlackConnectStart>;
  createSlackConnectLink(session: AuthSession, workspaceId: string): Promise<SlackConnectLink>;
  getSlackConnection(session: AuthSession): Promise<SlackConnectionStatus>;
  completeSlackCallback(
    input: { code: string; state: string },
  ): Promise<SlackCallbackSuccess>;
  denySlackCallback(state: string): Promise<void>;
  buildSlackAuthorizeUrl(state: string): string | null;
  renderCliAuthPage(
    state: string,
    port: number,
  ): {
    html: string;
    scriptNonce: string;
    connectOrigin?: string;
  } | null;
  renderPasswordRecoveryPage(page: "request" | "update"): {
    html: string; scriptNonce: string; connectOrigin: string;
  } | null;
  checkReadiness(): Promise<boolean>;
  checkCompanyReadiness(): Promise<boolean>;
  checkCrmMappingReadiness(): Promise<boolean>;
  connectionCallbacks?: ConfirmationAdapters;
  /** LIF-1663: operation events for PostHog; the default captures nothing. */
  analytics: Analytics;
  log(event: LogEvent): void;
}

export interface LogEvent {
  level: "warn" | "error";
  event: "request_failed" | "revocation_enqueue_failed" | "connection_confirmation";
  request_id: string;
  method: string;
  path: string;
  error_code: string;
  status: number;
  stage?: string;
  attempts?: number;
  elapsed_ms?: number;
  upstream_operation?: string;
  upstream_code?: string;
  upstream_kind?: string;
  provider_error?: string;
  progress_stage?: string;
  connection_reference?: string;
}

export type AppEnvironment = {
  Variables: {
    requestId: string;
    requestStartedAt: number;
    operationStage?: string;
    authSession: AuthSession;
    surface: AnalyticsSurface;
    /** Non-secret facts a handler learned for analytics (the CRM provider of an attempt). */
    analyticsFacts?: { provider?: string };
  };
};

const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    issues: z.array(RepairIssueSchema).max(20).optional(),
    current_version: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().optional(),
    resets_at: z.string().optional(),
  }),
  request_id: z.string(),
});

const JsonResponse = (schema: z.ZodType) => ({
  content: { "application/json": { schema } },
  description: "JSON response",
});

const ProviderPathParams = z.object({
  provider: ProviderSchema.openapi({ param: { name: "provider", in: "path" } }),
});

async function readRequestTextWithinLimit(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false }> {
  if (!request.body) return { ok: true, text: "" };

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytesRead = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        parts.push(decoder.decode());
        return { ok: true, text: parts.join("") };
      }

      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The response remains 413 even when the upstream stream cannot cancel.
        }
        return { ok: false };
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }
}

function registerOpenApi(app: OpenAPIHono<AppEnvironment>): void {
  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/v1/workspaces/{workspace_ref}/research/recovery/{first_run_ref}",
    operationId: "getAcquisitionRecovery",
    security: [{ bearerAuth: [] }],
    request: { params: z.object({ workspace_ref: z.uuid(), first_run_ref: z.uuid() }) },
    responses: {
      200: JsonResponse(AcquisitionRecoveryStatus),
      400: JsonResponse(ErrorResponseSchema),
      401: JsonResponse(ErrorResponseSchema),
      403: JsonResponse(ErrorResponseSchema),
      502: JsonResponse(ErrorResponseSchema),
    },
  });
  app.openAPIRegistry.registerPath({
    method: "post",
    path: "/v1/workspaces/{workspace_ref}/research/recovery/{first_run_ref}",
    operationId: "requestOrRestartAcquisition",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ workspace_ref: z.uuid(), first_run_ref: z.uuid() }),
      body: {
        required: true,
        content: { "application/json": { schema: AcquisitionRecoveryBody } },
      },
    },
    responses: {
      200: JsonResponse(z.union([AcquisitionRecoveryStatus, AcquisitionRestartResult])),
      400: JsonResponse(ErrorResponseSchema),
      401: JsonResponse(ErrorResponseSchema),
      403: JsonResponse(ErrorResponseSchema),
      409: JsonResponse(ErrorResponseSchema),
      502: JsonResponse(ErrorResponseSchema),
    },
  });

  app.openAPIRegistry.registerPath({method:"post",path:"/v1/workspaces/{workspace_ref}/retire",operationId:"retireWorkspace",security:[{bearerAuth:[]}],
    request:{params:z.object({workspace_ref:z.uuid()}),body:{required:true,content:{"application/json":{schema:RetireWorkspaceConfirmation}}}},
    responses:{200:JsonResponse(RetireWorkspaceResult),400:JsonResponse(ErrorResponseSchema),401:JsonResponse(ErrorResponseSchema),403:JsonResponse(ErrorResponseSchema),409:JsonResponse(ErrorResponseSchema),502:JsonResponse(ErrorResponseSchema)}});
  app.openAPIRegistry.registerPath({method:"get",path:"/v1/me/workspaces",operationId:"listMemberWorkspaces",security:[{bearerAuth:[]}],
    responses:{200:JsonResponse(MemberWorkspacesResult),401:JsonResponse(ErrorResponseSchema),502:JsonResponse(ErrorResponseSchema)}});
  app.openAPIRegistry.registerPath({method:"post",path:"/v1/me/delete",operationId:"deleteOwnLogin",security:[{bearerAuth:[]}],
    request:{body:{required:true,content:{"application/json":{schema:DeleteLoginRequest}}}},
    responses:{200:JsonResponse(DeleteLoginResult),400:JsonResponse(ErrorResponseSchema),401:JsonResponse(ErrorResponseSchema),404:JsonResponse(ErrorResponseSchema),409:JsonResponse(ErrorResponseSchema),502:JsonResponse(ErrorResponseSchema)}});
  app.openAPIRegistry.registerPath({method:"get",path:"/v1/email/campaign/placement/preview",operationId:"previewEmailPlacement",security:[{bearerAuth:[]}],
    request:{query:z.object({workspace:EmailWorkspace,campaign_ref:z.uuid(),digest:z.string().regex(/^[a-f0-9]{64}$/)})},
    responses:{200:JsonResponse(EmailPlacementPreview),400:JsonResponse(ErrorResponseSchema),401:JsonResponse(ErrorResponseSchema),403:JsonResponse(ErrorResponseSchema),409:JsonResponse(ErrorResponseSchema),502:JsonResponse(ErrorResponseSchema)}});
  app.openAPIRegistry.registerPath({method:"get",path:"/v1/email/campaign/placement",operationId:"getEmailPlacement",security:[{bearerAuth:[]}],
    request:{query:z.object({workspace:EmailWorkspace,campaign_ref:z.uuid(),digest:z.string().regex(/^[a-f0-9]{64}$/)})},
    responses:{200:JsonResponse(EmailPlacementResult),400:JsonResponse(ErrorResponseSchema),401:JsonResponse(ErrorResponseSchema),403:JsonResponse(ErrorResponseSchema),409:JsonResponse(ErrorResponseSchema),502:JsonResponse(ErrorResponseSchema)}});
  app.openAPIRegistry.registerPath({method:"post",path:"/v1/email/campaign",operationId:"emailCampaign",security:[{bearerAuth:[]}],
    request:{body:{required:true,content:{"application/json":{schema:HistoricalEmailCampaignRequest}}}},
    responses:{200:JsonResponse(HistoricalEmailResultSchema),400:JsonResponse(ErrorResponseSchema),401:JsonResponse(ErrorResponseSchema),403:JsonResponse(ErrorResponseSchema),409:JsonResponse(ErrorResponseSchema),502:JsonResponse(ErrorResponseSchema),503:JsonResponse(ErrorResponseSchema)}});
  app.openAPIRegistry.registerPath({method:"get",path:"/v1/email/warmup",operationId:"getEmailWarmup",security:[{bearerAuth:[]}],
    request:{query:WarmupWorkspaceRequest},responses:{200:JsonResponse(WarmupStatus),400:JsonResponse(ErrorResponseSchema),401:JsonResponse(ErrorResponseSchema),403:JsonResponse(ErrorResponseSchema),502:JsonResponse(ErrorResponseSchema),503:JsonResponse(ErrorResponseSchema)}});
  app.openAPIRegistry.registerPath({method:"get",path:"/v1/email/deliverability",operationId:"getEmailDeliverability",security:[{bearerAuth:[]}],
    description:"Read-only inbox health shared by the Deliverability page and the Lifty CLI: inboxes, warmup, placement history, campaigns, approval, notes and explained states (email-deliverability.v1). Never creates tests or changes sending.",
    request:{query:DeliverabilityQueryParams},responses:{200:JsonResponse(DeliverabilityResponse),400:JsonResponse(ErrorResponseSchema),401:JsonResponse(ErrorResponseSchema),403:JsonResponse(ErrorResponseSchema),404:JsonResponse(ErrorResponseSchema),502:JsonResponse(ErrorResponseSchema),503:JsonResponse(ErrorResponseSchema)}});
  app.openAPIRegistry.registerPath({method:"get",path:"/v1/email/placement",operationId:"getEmailPlacement",security:[{bearerAuth:[]}],
    description:"LIF-1063: the latest Mailivery placement test for one warmed mailbox, whether a new one can be requested, and whether its result gates sending. Read-only.",
    request:{query:PlacementStatusRequest},responses:{200:JsonResponse(ConnectionPlacementStatus),400:JsonResponse(ErrorResponseSchema),401:JsonResponse(ErrorResponseSchema),403:JsonResponse(ErrorResponseSchema),409:JsonResponse(ErrorResponseSchema),502:JsonResponse(ErrorResponseSchema),503:JsonResponse(ErrorResponseSchema)}});
  app.openAPIRegistry.registerPath({method:"post",path:"/v1/email/placement/start",operationId:"startEmailPlacement",security:[{bearerAuth:[]}],
    description:"LIF-1063: queue one Mailivery connected-mailbox placement test after explicit consent. Mailivery sends the email from the warmed mailbox to its seed inboxes and uses one test credit. A retried start returns the open test. Never releases a mailbox.",
    request:{body:{required:true,content:{"application/json":{schema:PlacementStartRequest}}}},
    responses:{200:JsonResponse(ConnectionPlacementStatus),400:JsonResponse(ErrorResponseSchema),401:JsonResponse(ErrorResponseSchema),403:JsonResponse(ErrorResponseSchema),409:JsonResponse(ErrorResponseSchema),413:JsonResponse(ErrorResponseSchema),502:JsonResponse(ErrorResponseSchema),503:JsonResponse(ErrorResponseSchema)}});
  app.openAPIRegistry.registerPath({method:"post",path:"/v1/email/warmup/start",operationId:"startEmailWarmup",security:[{bearerAuth:[]}],
    description:"Start warmup setup for one verified mailbox account (connection_ref when the workspace has several). Returns a one-hour Lifty setup link that authorizes the mailbox with Google. An already-bound mailbox receives no new link. Never pauses or resumes campaigns.",
    request:{body:{required:true,content:{"application/json":{schema:WarmupWorkspaceRequest}}}},
    responses:{200:JsonResponse(WarmupStartResult),400:JsonResponse(ErrorResponseSchema),401:JsonResponse(ErrorResponseSchema),403:JsonResponse(ErrorResponseSchema),409:JsonResponse(ErrorResponseSchema),429:JsonResponse(ErrorResponseSchema),502:JsonResponse(ErrorResponseSchema),503:JsonResponse(ErrorResponseSchema)}});
  for (const operation of ["pause","resume","remove"] as const) {
    app.openAPIRegistry.registerPath({method:"post",path:`/v1/email/warmup/${operation}`,operationId:`${operation}EmailWarmup`,security:[{bearerAuth:[]}],
      request:{body:{required:true,content:{"application/json":{schema:WarmupWorkspaceRequest}}}},
      responses:{200:JsonResponse(WarmupStatus),400:JsonResponse(ErrorResponseSchema),401:JsonResponse(ErrorResponseSchema),403:JsonResponse(ErrorResponseSchema),409:JsonResponse(ErrorResponseSchema),502:JsonResponse(ErrorResponseSchema),503:JsonResponse(ErrorResponseSchema)}});
  }
  app.openAPIRegistry.registerPath({
    method: "post",
    path: "/v1/workspaces/{workspace_ref}/integrations/slack/connect-link",
    operationId: "createAdminSlackConnectLink",
    description: "Create a single-use, seven-day client invitation. Requires membership in the selected active workspace.",
    security: [{ bearerAuth: [] }],
    request: { params: z.object({ workspace_ref: z.uuid().openapi({ param: { name: "workspace_ref", in: "path" } }) }) },
    responses: {
      200: JsonResponse(SlackConnectLinkSchema),
      400: JsonResponse(ErrorResponseSchema),
      401: JsonResponse(ErrorResponseSchema),
      403: JsonResponse(ErrorResponseSchema),
      409: JsonResponse(ErrorResponseSchema),
      502: JsonResponse(ErrorResponseSchema),
      503: JsonResponse(ErrorResponseSchema),
    },
  });

  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
  });
  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/healthz",
    operationId: "getHealth",
    responses: { 200: JsonResponse(z.object({ status: z.literal("ok") })) },
  });
  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/readyz",
    operationId: "getReadiness",
    responses: {
      200: JsonResponse(z.object({ status: z.literal("ready") })),
      503: JsonResponse(z.object({ status: z.literal("unready") })),
    },
  });
  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/v1/workspace",
    operationId: "getWorkspaceStatus",
    security: [{ bearerAuth: [] }],
    responses: {
      200: JsonResponse(WorkspaceStatusSchema),
      401: JsonResponse(ErrorResponseSchema),
      502: JsonResponse(ErrorResponseSchema),
    },
  });
  app.openAPIRegistry.registerPath({
    method: "post",
    path: "/v1/integrations/{provider}/sync",
    operationId: "startCrmSync",
    security: [{ bearerAuth: [] }],
    request: { params: ProviderPathParams },
    responses: {
      200: JsonResponse(StartCrmSyncResultSchema),
      400: JsonResponse(ErrorResponseSchema),
      401: JsonResponse(ErrorResponseSchema),
      409: JsonResponse(ErrorResponseSchema),
      501: JsonResponse(ErrorResponseSchema),
      502: JsonResponse(ErrorResponseSchema),
    },
  });
  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/v1/integrations/{provider}/sync",
    operationId: "getCrmSyncStatus",
    security: [{ bearerAuth: [] }],
    request: { params: ProviderPathParams },
    responses: {
      200: JsonResponse(CrmSyncStatusSchema),
      400: JsonResponse(ErrorResponseSchema),
      401: JsonResponse(ErrorResponseSchema),
      501: JsonResponse(ErrorResponseSchema),
      502: JsonResponse(ErrorResponseSchema),
    },
  });
  app.openAPIRegistry.registerPath({
    method: "post",
    path: "/v1/integrations/{provider}/connect",
    operationId: "startProviderConnect",
    security: [{ bearerAuth: [] }],
    request: { params: ProviderPathParams },
    responses: {
      200: JsonResponse(LegacyProviderConnectStartSchema),
      400: JsonResponse(ErrorResponseSchema),
      401: JsonResponse(ErrorResponseSchema),
      409: JsonResponse(ErrorResponseSchema),
      501: JsonResponse(ErrorResponseSchema),
      502: JsonResponse(ErrorResponseSchema),
    },
  });
  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/v1/integrations/{provider}",
    operationId: "getProviderConnection",
    security: [{ bearerAuth: [] }],
    request: { params: ProviderPathParams },
    responses: {
      200: JsonResponse(IntegrationConnectionStatusSchema),
      400: JsonResponse(ErrorResponseSchema),
      401: JsonResponse(ErrorResponseSchema),
      409: JsonResponse(ErrorResponseSchema),
      502: JsonResponse(ErrorResponseSchema),
    },
  });
  app.openAPIRegistry.registerPath({
    method: "delete",
    path: "/v1/integrations/{provider}",
    operationId: "disconnectProvider",
    security: [{ bearerAuth: [] }],
    request: { params: ProviderPathParams },
    responses: {
      200: JsonResponse(DisconnectResponseSchema),
      400: JsonResponse(ErrorResponseSchema),
      401: JsonResponse(ErrorResponseSchema),
      409: JsonResponse(ErrorResponseSchema),
      502: JsonResponse(ErrorResponseSchema),
    },
  });
  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/v1/notifications",
    operationId: "getNotificationConfig",
    security: [{ bearerAuth: [] }],
    responses: {
      200: JsonResponse(NotificationConfigSchema),
      401: JsonResponse(ErrorResponseSchema),
      403: JsonResponse(ErrorResponseSchema),
      409: JsonResponse(ErrorResponseSchema),
      502: JsonResponse(ErrorResponseSchema),
    },
  });
  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/v1/integrations/hubspot/company-mapping/context",
    operationId: "getCompanyMappingContext",
    request: { query: z.object({ workspace_ref: z.uuid().optional() }) },
    security: [{ bearerAuth: [] }],
    responses: {
      200: JsonResponse(CompanyMappingContextSchema),
      401: JsonResponse(ErrorResponseSchema),
      409: JsonResponse(ErrorResponseSchema),
      502: JsonResponse(ErrorResponseSchema),
      503: JsonResponse(ErrorResponseSchema),
      504: JsonResponse(ErrorResponseSchema),
    },
  });
  app.openAPIRegistry.registerPath({
    method: "post",
    path: "/v1/integrations/hubspot/company-mapping",
    operationId: "applyCompanyMapping",
    security: [{ bearerAuth: [] }],
    request: {
      body: { content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } },
    },
    responses: {
      200: JsonResponse(CompanyMappingReceiptSchema),
      400: JsonResponse(ErrorResponseSchema),
      401: JsonResponse(ErrorResponseSchema),
      409: JsonResponse(ErrorResponseSchema),
      422: JsonResponse(ErrorResponseSchema),
      502: JsonResponse(ErrorResponseSchema),
      503: JsonResponse(ErrorResponseSchema),
      504: JsonResponse(ErrorResponseSchema),
    },
  });
  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/v1/notifications/slack/channels",
    operationId: "listSlackNotificationChannels",
    security: [{ bearerAuth: [] }],
    responses: {
      200: JsonResponse(SlackNotificationChannelsSchema),
      401: JsonResponse(ErrorResponseSchema),
      409: JsonResponse(ErrorResponseSchema),
      502: JsonResponse(ErrorResponseSchema),
    },
  });
  app.openAPIRegistry.registerPath({
    method: "put",
    path: "/v1/notifications/destinations/slack",
    operationId: "upsertSlackNotificationDestination",
    security: [{ bearerAuth: [] }],
    request: {
      body: {
        required: true,
        content: {
          "application/json": { schema: UpsertNotificationDestinationRequestSchema },
        },
      },
    },
    responses: {
      200: JsonResponse(NotificationDestinationSchema),
      400: JsonResponse(ErrorResponseSchema),
      401: JsonResponse(ErrorResponseSchema),
      403: JsonResponse(ErrorResponseSchema),
      409: JsonResponse(ErrorResponseSchema),
      502: JsonResponse(ErrorResponseSchema),
    },
  });
  app.openAPIRegistry.registerPath({
    method: "put",
    path: "/v1/notifications/routes",
    operationId: "setNotificationRoute",
    security: [{ bearerAuth: [] }],
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: SetNotificationRouteRequestSchema } },
      },
    },
    responses: {
      200: JsonResponse(NotificationDestinationSchema),
      400: JsonResponse(ErrorResponseSchema),
      401: JsonResponse(ErrorResponseSchema),
      403: JsonResponse(ErrorResponseSchema),
      404: JsonResponse(ErrorResponseSchema),
      409: JsonResponse(ErrorResponseSchema),
      502: JsonResponse(ErrorResponseSchema),
    },
  });
  app.openAPIRegistry.registerPath({
    method: "post",
    path: "/v1/notifications/destinations/{destination_ref}/test",
    operationId: "sendNotificationTest",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({
        destination_ref: DestinationRefSchema.openapi({
          param: { name: "destination_ref", in: "path" },
        }),
      }),
    },
    responses: {
      200: JsonResponse(NotificationTestResultSchema),
      400: JsonResponse(ErrorResponseSchema),
      401: JsonResponse(ErrorResponseSchema),
      403: JsonResponse(ErrorResponseSchema),
      404: JsonResponse(ErrorResponseSchema),
      409: JsonResponse(ErrorResponseSchema),
      429: JsonResponse(ErrorResponseSchema),
      502: JsonResponse(ErrorResponseSchema),
    },
  });
}

function hubspotPage(title: string, message: string, success: boolean): string {
  const iconPath = success
    ? "M5 13l4 4L19 7"
    : "M6 6l12 12M18 6L6 18";
  return renderLiftyPage({
    title,
    content: `<div class="symbol${success ? "" : " error"}" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="${iconPath}"></path></svg></div>
<h1>${title}</h1>
<p class="intro">${message}</p>
<p class="reassurance">You can close this tab.</p>`,
  });
}

function hubspotHtmlResponse(
  context: Context<AppEnvironment>,
  status: ContentfulStatusCode,
  title: string,
  message: string,
): Response {
  return context.html(hubspotPage(title, message, status < 400), status, {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
}

function errorJson(
  context: Context<AppEnvironment>,
  status: ContentfulStatusCode,
  code: string,
  message: string,
  issues?: z.infer<typeof RepairIssueSchema>[],
): Response {
  return context.json(
    { error: { code, message, ...(issues ? { issues } : {}) }, request_id: context.get("requestId") },
    status,
  );
}

/** Provider allowlist for `/v1/integrations/{provider}/*`; `ok: false` already carries the 400. */
function resolveProvider(
  context: Context<AppEnvironment>,
): { ok: true; provider: Provider } | { ok: false; response: Response } {
  const parsed = ProviderSchema.safeParse(
    (context.req.param("provider") ?? "").toLowerCase(),
  );
  if (!parsed.success) {
    return {
      ok: false,
      response: errorJson(
        context,
        400,
        "PROVIDER_INVALID",
        "Unknown provider. Supported providers: hubspot, attio, slack.",
      ),
    };
  }
  return { ok: true, provider: parsed.data };
}

// LIF-1119: one lost enqueue used to leave a detached grant pending until an
// operator noticed. Retry a few times inside the disconnect request, each
// attempt bounded. The revocation row is the idempotency key, so an attempt
// Trigger accepted but whose response was lost dedupes on the next one.
const REVOCATION_ENQUEUE_RETRY_DELAYS_MS = [250, 1_000];
const REVOCATION_ENQUEUE_ATTEMPT_TIMEOUT_MS = 3_000;

async function enqueueRevocationWithRetry(
  enqueue: EnqueueIntegrationRevocation,
  revocationRef: string,
): Promise<{ ok: true } | { ok: false; error: unknown; attempts: number }> {
  let lastError: unknown;
  const attempts = REVOCATION_ENQUEUE_RETRY_DELAYS_MS.length + 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, REVOCATION_ENQUEUE_RETRY_DELAYS_MS[attempt - 1]));
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        enqueue(revocationRef),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("revocation enqueue timed out")), REVOCATION_ENQUEUE_ATTEMPT_TIMEOUT_MS);
        }),
      ]);
      return { ok: true };
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, error: lastError, attempts };
}

function providerUnavailable(context: Context<AppEnvironment>, provider: Provider): Response {
  return errorJson(
    context,
    501,
    "PROVIDER_NOT_AVAILABLE",
    `Connecting ${provider} is not available yet.`,
  );
}

const defaultDependencies: AppDependencies = {
  getConnectionAttempt,
  getEmailWarmup: async () => { throw new PublicError({ status: 503, code: "EMAIL_WARMUP_NOT_CONFIGURED", message: "Mailbox warmup is not available on this LIFTY server yet." }); },
  startEmailWarmup: async () => { throw new PublicError({ status: 503, code: "EMAIL_WARMUP_NOT_CONFIGURED", message: "Mailbox warmup is not available on this LIFTY server yet. Nothing was changed." }); },
  changeEmailWarmup: async () => { throw new PublicError({ status: 503, code: "EMAIL_WARMUP_NOT_CONFIGURED", message: "Mailbox warmup is not available on this LIFTY server yet. Nothing was changed." }); },
  getEmailDeliverability: async () => { throw new PublicError({ status: 503, code: "DELIVERABILITY_NOT_CONFIGURED", message: "Deliverability is not available on this LIFTY server yet." }); },
  getEmailPlacement: async () => { throw new PublicError({ status: 503, code: "EMAIL_PLACEMENT_NOT_CONFIGURED", message: "Placement tests are not available on this LIFTY server yet." }); },
  startEmailPlacement: async () => { throw new PublicError({ status: 503, code: "EMAIL_PLACEMENT_NOT_CONFIGURED", message: "Placement tests are not available on this LIFTY server yet. Nothing was requested." }); },
  denyHubspotCallback: async () => { throw new PublicError({ status: 503, code: "CONNECTION_ATTEMPT_UNAVAILABLE", message: "The authorization outcome could not be recorded." }); },
  denySlackCallback: async () => { throw new PublicError({ status: 503, code: "CONNECTION_ATTEMPT_UNAVAILABLE", message: "The authorization outcome could not be recorded." }); },
  acquisitionRecovery: async () => { throw new PublicError({status:503,code:"ACQUISITION_RECOVERY_UNAVAILABLE",message:"Research recovery is not configured."}); },
  retireWorkspace: async () => { throw new PublicError({status:503,code:"WORKSPACE_RETIREMENT_UNAVAILABLE",message:"Workspace retirement is not configured yet."}); },
  deleteOwnLogin: async () => { throw new PublicError({status:503,code:"LOGIN_DELETION_UNAVAILABLE",message:"Login deletion is not configured yet."}); },
  emailCampaign: async () => { throw new PublicError({status:503,code:"EMAIL_NOT_CONFIGURED",message:"Email campaigns are not configured yet."}); },
  authenticate: async () => ({ ok: false, reason: "invalid_session" }),
  businessOperation: executeBusinessOperation,
  outreachOperation: executeOutreachOperation,
  identityOperation: (session, key, input, signal) => executeIdentityOperation(session, key, input, connectorUnavailable, signal),
  linkedinOperation: executeLinkedinOperation,
  crmPreferencesOperation: executeCrmPreferencesOperation,
  crmSyncControlsOperation: executeCrmSyncControlsOperation,
  customerExclusionsOperation: executeCustomerExclusionsOperation,
  researchOperation: (session, key, input) => executeResearchOperation(session, key, input, DEFAULT_DASHBOARD_ORIGIN),
  getWorkspace: async () => {
    throw new Error("getWorkspace is not configured");
  },
  listMemberWorkspaces: async () => { throw new PublicError({status:503,code:"WORKSPACES_UNAVAILABLE",message:"Workspace listing is not configured yet."}); },
  listAdminWorkspaces,
  readContextDrafts,
  startRun: async () => {
    throw new Error("startRun is not configured");
  },
  getRunProgress: async () => { throw new Error("getRunProgress is not configured"); },
  getRunStatus: async () => {
    throw new Error("getRunStatus is not configured");
  },
  confirmRunReview: async () => { throw new Error("confirmRunReview is not configured"); },
  enqueueFirstRun: async () => {
    throw new Error("enqueueFirstRun is not configured");
  },
  startCrmSyncRun: async () => {
    throw new Error("startCrmSyncRun is not configured");
  },
  runCrmMapping: async () => { throw new PublicError({ status: 503, code: "CRM_MAPPING_NOT_CONFIGURED", message: "CRM mapping is not configured." }); },
  getCrmSyncStatus: async () => {
    throw new Error("getCrmSyncStatus is not configured");
  },
  enqueueCrmSync: async () => {
    throw new Error("enqueueCrmSync is not configured");
  },
  disconnectIntegration: async () => {
    throw new Error("disconnectIntegration is not configured");
  },
  enqueueIntegrationRevocation: async () => {
    throw new Error("enqueueIntegrationRevocation is not configured");
  },
  setNotificationControls: async () => { throw new Error("setNotificationControls is not configured"); },
  setNotificationPreferences: async () => { throw new Error("setNotificationPreferences is not configured"); },
  getNotificationConfig: async () => {
    throw new Error("getNotificationConfig is not configured");
  },
  companyMapping: async () => {
    throw new Error("companyMapping is not configured");
  },
  listSlackNotificationChannels: async () => {
    throw new Error("listSlackNotificationChannels is not configured");
  },
  upsertNotificationDestination: async () => {
    throw new Error("upsertNotificationDestination is not configured");
  },
  setNotificationRoute: async () => {
    throw new Error("setNotificationRoute is not configured");
  },
  sendNotificationTest: async () => {
    throw new Error("sendNotificationTest is not configured");
  },
  startHubspotConnect: async () => {
    throw new Error("startHubspotConnect is not configured");
  },
  getHubspotConnection: async () => {
    throw new Error("getHubspotConnection is not configured");
  },
  completeHubspotCallback: async () => {
    throw new HubspotCallbackError(
      "server_misconfigured",
      503,
      "The HubSpot connection service is not configured.",
    );
  },
  buildHubspotAuthorizeUrl: () => null,
  startAttioConnect: async () => {
    throw new PublicError({ status: 503, code: "INTEGRATION_NOT_CONFIGURED", message: "The Attio connection service is not configured." });
  },
  getAttioConnection: async () => ({ provider: "attio", status: "not_connected" }),
  buildAttioAuthorizeUrl: () => null,
  createSlackConnectLink: async () => { throw new Error("createSlackConnectLink is not configured"); },
  startSlackConnect: async () => {
    throw new Error("startSlackConnect is not configured");
  },
  getSlackConnection: async () => {
    throw new Error("getSlackConnection is not configured");
  },
  completeSlackCallback: async () => {
    throw new SlackCallbackError(
      "server_misconfigured",
      503,
      "The Slack connection service is not configured.",
    );
  },
  buildSlackAuthorizeUrl: () => null,
  renderCliAuthPage: () => null,
  renderPasswordRecoveryPage: () => null,
  checkReadiness: async () => true,
  checkCompanyReadiness: async () => false,
  checkCrmMappingReadiness: async () => false,
  analytics: noopAnalytics,
  log: (event) => process.stderr.write(`${JSON.stringify(event)}\n`),
};

export function createApp(
  overrides: Partial<AppDependencies> = {},
): OpenAPIHono<AppEnvironment> {
  const dependencies = { ...defaultDependencies, ...overrides };
  const trustedMcpRequests = new WeakMap<Request, AuthSession>();
  const app = new OpenAPIHono<AppEnvironment>();
  registerOpenApi(app);
  const mutationWindows = new Map<string, { count: number; resetsAt: number }>();
  const favicon = readFileSync(new URL("./favicon.ico", import.meta.url));
  const connectorIcon = readFileSync(new URL("./lifty-orbit-icon.png", import.meta.url));

  app.use("*", async (context, next) => {
    const suppliedRequestId = RequestIdSchema.safeParse(
      context.req.header("x-request-id"),
    );
    const requestId = suppliedRequestId.success
      ? suppliedRequestId.data
      : crypto.randomUUID();
    context.set("requestId", requestId);
    context.set("requestStartedAt", Date.now());
    context.header("x-request-id", requestId);
    if (dependencies.runtimeProfile === "connections" && !connectionProfileAllows(context.req.method, context.req.path)) {
      return context.json({ error: { code: "OPERATION_UNAVAILABLE", message: "This environment supports workspace setup and email connection only.", request_id: requestId } }, 503);
    }
    await next();
  });

  const logConfirmation=(event:ConfirmationLog)=>dependencies.log({level:"warn",event:"connection_confirmation",request_id:event.correlation,method:"POST",
    path:`connection/${event.flow}`,error_code:event.outcome,status:event.status,stage:event.stage,elapsed_ms:event.elapsed_ms,
    ...(event.progress_stage?{progress_stage:event.progress_stage}:{}),
    ...(event.reference?{connection_reference:event.reference}:{}),
    ...(event.upstream_status===undefined?{}:{upstream_code:String(event.upstream_status)}),...(event.upstream_outcome?{upstream_kind:event.upstream_outcome}:{}),...(event.provider_error?{provider_error:event.provider_error}:{})});
  if (dependencies.warmupSetup) app.route("/warmup", createWarmupSetupRouter(dependencies.warmupSetup,logConfirmation));
  app.get("/favicon.ico", (context) => context.body(new Uint8Array(favicon).buffer, 200, {
    "content-type": "image/x-icon",
    "cache-control": "public, max-age=3600",
    "x-content-type-options": "nosniff",
  }));
  app.get("/brand/lifty-orbit-icon.png", (context) => context.body(new Uint8Array(connectorIcon).buffer, 200, {
    "content-type": "image/png",
    "cache-control": "public, max-age=3600",
    "x-content-type-options": "nosniff",
  }));
  if (dependencies.openAiAppsChallenge) {
    app.get("/.well-known/openai-apps-challenge", context => context.text(dependencies.openAiAppsChallenge!, 200, { "cache-control": "no-store" }));
  }
  if (dependencies.mcp) {
    const mcp = dependencies.mcp;
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      app.get(path, context => context.json(mcpResourceMetadata(mcp), 200, { "cache-control": "no-store" }));
    }
    app.all("/mcp", context => handleMcpRequest(context.req.raw, mcp, {
      tools: getStageMcpTools(),
      call: (name, args, request, session) => callStageMcpTool(name, args, request, async (route, init) => {
        const internal = new Request(new URL(route, request.url), init);
        // Authentication binds the workspace header to the Supabase client.
        // A tool-level selection arrives after the outer MCP authentication;
        // reusing that unscoped client silently selects the implicit workspace.
        // Keep the MCP resource/session fence when binding the selected client.
        let selectedSession = session;
        if ((internal.headers.get("x-lifty-workspace")?.trim() ?? "") !== (request.headers.get("x-lifty-workspace")?.trim() ?? "")) {
          const scoped = await mcp.authenticate(internal);
          if (!scoped.ok) return Response.json({ error: { code: "UNAUTHORIZED", message: "A valid Lifty OAuth session is required." } }, { status: 401 });
          selectedSession = scoped.session;
        }
        trustedMcpRequests.set(internal, selectedSession);
        return Promise.resolve(app.fetch(internal));
      }),
      workspaces: session => dependencies.listMemberWorkspaces(session),
    }));
    app.get("/oauth/consent", context => {
      const authorizationId = context.req.query("authorization_id") ?? "";
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(authorizationId)) {
        return hubspotHtmlResponse(context, 400, "Invalid authorization link", "Connect Lifty again to get a fresh link.");
      }
      const page = dependencies.renderOAuthConsentPage?.(authorizationId);
      if (!page || !/^[A-Za-z0-9_-]{16,128}$/.test(page.scriptNonce)
        || !/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(page.connectOrigin)) {
        return hubspotHtmlResponse(context, 503, "Sign-in unavailable", "Try connecting Lifty again in a moment.");
      }
      return context.html(page.html, 200, {
        "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
        "content-security-policy": ["default-src 'none'", `script-src 'nonce-${page.scriptNonce}'`,
          "style-src 'unsafe-inline'", "img-src 'self'", `connect-src ${page.connectOrigin}`, "base-uri 'none'",
          "form-action 'none'", "frame-ancestors 'none'"].join("; "),
      });
    });
  }
  app.get("/healthz", (context) => context.json({ status: "ok" }));
  app.get("/readyz/crm", async (context) => {
    let ready = false;
    try { ready = await dependencies.checkCompanyReadiness(); } catch { /* bounded health response */ }
    return context.json({ status: ready ? "ready" : "not_ready", capability: "lifty-crm-company.v1" }, ready ? 200 : 503);
  });
  app.get("/readyz/crm-mapping", async (context) => {
    let ready = false;
    try { ready = await dependencies.checkCrmMappingReadiness(); } catch { /* bounded health response */ }
    return context.json({ status: ready ? "ready" : "not_ready", capability: "lifty-crm-mapping.v1" }, ready ? 200 : 503);
  });
  app.get("/readyz", async (context) => {
    let ready: boolean;
    try {
      ready = await dependencies.checkReadiness();
    } catch {
      ready = false;
    }
    return ready
      ? context.json({ status: "ready" })
      : context.json({ status: "unready" }, 503);
  });
  for (const [route, mode] of [["/auth/password-reset", "request"], ["/auth/password-update", "update"]] as const) {
    app.get(route, (context) => {
      const page = dependencies.renderPasswordRecoveryPage(mode);
      if (!page || !/^[A-Za-z0-9_-]{16,128}$/.test(page.scriptNonce)
        || !/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(page.connectOrigin)) {
        return hubspotHtmlResponse(context, 503, "Password recovery unavailable", "Try again in a moment.");
      }
      return context.html(page.html, 200, {
        "cache-control": "no-store",
        "content-security-policy": ["default-src 'none'", `script-src 'nonce-${page.scriptNonce}'`,
          "style-src 'unsafe-inline'", `connect-src ${page.connectOrigin}`, "base-uri 'none'",
          "form-action 'none'", "frame-ancestors 'none'"].join("; "),
        "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
      });
    });
  }
  app.get("/cli/auth", (context) => {
    const state = context.req.query("state") ?? "";
    const portValue = context.req.query("port") ?? "";
    const port = Number(portValue);
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(state)
      || !/^\d{4,5}$/.test(portValue)
      || !Number.isInteger(port)
      || port < 1024
      || port > 65535
    ) {
      return hubspotHtmlResponse(
        context,
        400,
        "Invalid CLI authorization link",
        "Run lifty login again to get a fresh link.",
      );
    }
    const page = dependencies.renderCliAuthPage(state, port);
    if (
      !page
      || !/^[A-Za-z0-9_-]{16,128}$/.test(page.scriptNonce)
      || (page.connectOrigin !== undefined
        && !/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(page.connectOrigin))
    ) {
      return hubspotHtmlResponse(
        context,
        503,
        "CLI authorization unavailable",
        "Try lifty login again in a moment.",
      );
    }
    const connectSources = page.connectOrigin
      ? `${page.connectOrigin} http://127.0.0.1:${port}`
      : `http://127.0.0.1:${port}`;
    return context.html(page.html, 200, {
      "cache-control": "no-store",
      "content-security-policy": [
        "default-src 'none'",
        `script-src 'nonce-${page.scriptNonce}'`,
        "style-src 'unsafe-inline'",
        "img-src 'self'",
        `connect-src ${connectSources}`,
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join("; "),
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
  });
  app.get("/hubspot/start", (context) => {
    const intent = context.req.query("intent") ?? "";
    if (!isSealedHubspotState(intent)) {
      return hubspotHtmlResponse(
        context,
        400,
        "Invalid connection link",
        "Ask LIFTY for a fresh HubSpot connection link.",
      );
    }
    const authorizeUrl = dependencies.buildHubspotAuthorizeUrl(intent);
    if (!authorizeUrl) {
      return hubspotHtmlResponse(
        context,
        503,
        "Connection unavailable",
        "The HubSpot connection service is temporarily unavailable.",
      );
    }
    context.header("cache-control", "no-store");
    context.header("referrer-policy", "no-referrer");
    return context.redirect(authorizeUrl, 302);
  });
  app.get("/slack/start", (context) => {
    const intent = context.req.query("intent") ?? "";
    if (!isSealedSlackState(intent)) {
      return hubspotHtmlResponse(
        context,
        400,
        "Invalid connection link",
        "Ask LIFTY for a fresh Slack connection link.",
      );
    }
    const authorizeUrl = dependencies.buildSlackAuthorizeUrl(intent);
    if (!authorizeUrl) {
      return hubspotHtmlResponse(
        context,
        503,
        "Connection unavailable",
        "The Slack connection service is temporarily unavailable.",
      );
    }
    context.header("cache-control", "no-store");
    context.header("referrer-policy", "no-referrer");
    return context.redirect(authorizeUrl, 302);
  });
  app.get("/attio/start", (context) => {
    const intent = context.req.query("intent") ?? "";
    if (!isSealedAttioState(intent)) {
      return hubspotHtmlResponse(context, 400, "Invalid connection link", "Ask LIFTY for a fresh Attio connection link.");
    }
    const authorizeUrl = dependencies.buildAttioAuthorizeUrl(intent);
    if (!authorizeUrl) {
      return hubspotHtmlResponse(context, 503, "Connection unavailable", "The Attio connection service is temporarily unavailable.");
    }
    context.header("cache-control", "no-store");
    context.header("referrer-policy", "no-referrer");
    return context.redirect(authorizeUrl, 302);
  });
  const sealedState = { hubspot: isSealedHubspotState, slack: isSealedSlackState, attio: isSealedAttioState } as const;
  for(const flow of ["hubspot","slack","attio"] as const) {
    const adapter:ConfirmationAdapter=dependencies.connectionCallbacks?.[flow] ?? {
      validate(input:{state:string}) { if(!sealedState[flow](input.state))throw new SyntaxError("invalid_state"); },
      status:async()=>invalidConfirmation(),
    };
    app.route("/",createConfirmationRouter(flow,adapter,{...(adapter.origin ? {origin:adapter.origin} : {}),log:logConfirmation}));
  }
  // Sending accounts: Lifty's connect page and the shared confirmation shell.
  if (dependencies.accounts) app.route("/", createAccountConnectRouter(dependencies.accounts.connection, { origin: dependencies.accounts.origin,
    hostedOrigins: dependencies.accounts.hostedOrigins, log: logConfirmation }));
  app.get("/openapi.json", context => {
    const document = app.getOpenAPI31Document({
      openapi: "3.1.0",
      info: {
        title: "LIFTY Control Plane API",
        version: "1.0.0",
        description: "Authenticated REST boundary for LIFTY workspace provisioning.",
      },
    });
    // Match the shared authenticated boundary on every documented operation.
    for (const methods of Object.values(document.paths ?? {})) {
      for (const method of ["get", "post", "patch", "put", "delete"] as const) {
        const operation = methods?.[method];
        if (!operation?.security?.some(requirement => "bearerAuth" in requirement)) continue;
        operation.parameters = (operation.parameters ?? []).filter(parameter =>
          !("name" in parameter && parameter.in === "header" && parameter.name === "x-lifty-client-contract"));
        operation.parameters.push({ in: "header", name: "x-lifty-client-contract", required: true,
          schema: { type: "string", enum: [...SUPPORTED_CLIENT_CONTRACTS] } });
        operation.responses ??= {};
        operation.responses["409"] ??= { description: "Unsupported client contract; update the installed CLI and skill." };
      }
    }
    if (dependencies.runtimeProfile === "connections") {
      for (const [path, methods] of Object.entries(document.paths ?? {})) {
        for (const method of ["get", "post", "patch", "put", "delete"] as const) {
          if (methods && !connectionProfileAllows(method.toUpperCase(), path)) delete methods[method];
        }
        if (methods && !["get", "post", "patch", "put", "delete"].some(method => method in methods)) delete document.paths![path];
      }
    }
    return context.json(document);
  });

  app.onError((error, context) => {
    const publicError = error instanceof PublicError
      ? error
      : new PublicError({
          status: 500,
          code: "INTERNAL_ERROR",
          message: "LIFTY could not complete the request.",
        });
    dependencies.log({
      level: publicError.status >= 500 ? "error" : "warn",
      event: "request_failed",
      request_id: context.get("requestId"),
      method: context.req.method,
      path: context.req.path,
      error_code: publicError.code,
      status: publicError.status,
      ...(context.get("operationStage") ? { stage: context.get("operationStage"), elapsed_ms: Date.now() - context.get("requestStartedAt") } : {}),
      ...publicError.diagnostics,
    });
    return context.json(
      {
        error: { code: publicError.code, message: publicError.message,
          ...(publicError.issues ? { issues: publicError.issues } : {}),
          ...(publicError.current_version === undefined ? {} : { current_version: publicError.current_version }),
          ...(publicError.stale_sources ? { stale_sources: publicError.stale_sources } : {}),
          ...(publicError.workspaces ? { workspaces: publicError.workspaces } : {}),
          ...(publicError.limit === undefined ? {} : { limit: publicError.limit }),
          ...(publicError.resets_at === undefined ? {} : { resets_at: publicError.resets_at }),

        },
        request_id: context.get("requestId"),
      },
      publicError.status as ContentfulStatusCode,
    );
  });

  // Task documentation is public so an agent can interview before sign-in.
  // Register only this GET before authentication; every business route stays scoped.
  app.get("/v1/context/:task", async (context) => {
    context.header("cache-control", "no-store");
    // Unversioned public links show current documentation; authenticated calls
    // still require the explicit current contract below.
    const clientContract = context.req.query("client_contract") ?? STAGE_CLIENT_CONTRACT;
    if (!isSupportedClientContract(clientContract)) {
      return errorJson(context, 409, "CONTEXT_CLIENT_UNSUPPORTED", CLIENT_UPGRADE_MESSAGE);
    }
    const task = context.req.param("task");
    const document = getAgentContext(task);
    if (!document) return errorJson(context, 404, "CONTEXT_NOT_FOUND", "No instructions are available for this task.");
    // A caller with a session (the MCP adapter forwards it) may be a marked
    // test workspace whose drafts replace published files (LIF-1298). The
    // installed CLI reads anonymously, and an invalid session is anonymous here.
    const session = trustedMcpRequests.get(context.req.raw)
      ?? (context.req.header("authorization")
        ? await dependencies.authenticate(context.req.raw).then(result => result.ok ? result.session : null, () => null)
        : null);
    const drafts = session ? await dependencies.readContextDrafts(session, session.workspaceRef ?? null).catch(() => []) : [];
    return context.json(drafts.length ? getAgentContext(task, drafts) : document);
  });
  app.openAPIRegistry.registerPath({
    method: "get", path: "/v1/context/{task}", operationId: "getAgentTaskContext", security: [],
    request: {
      params: z.object({ task: z.string().min(1).max(64) }),
      query: z.object({ client_contract: z.string().optional() }),
    },
    responses: {
      200: { ...JsonResponse(AgentContextSchema), description: "Public task instructions and input schemas; no workspace data" },
      404: { description: "Unknown task" },
      409: { description: "Unsupported client contract" },
    },
  });

  app.use("/v1/*", async (context, next) => {
    if (context.req.path.startsWith("/v1/workspace/crm/")) context.header("cache-control", "no-store");
    const trusted = trustedMcpRequests.get(context.req.raw);
    trustedMcpRequests.delete(context.req.raw);
    const authentication = trusted ? { ok: true as const, session: trusted } : await dependencies.authenticate(context.req.raw);
    if (!authentication.ok) {
      return context.json(
        {
          error: {
            code: "UNAUTHORIZED",
            message: "A valid LIFTY session is required.",
          },
          request_id: context.get("requestId"),
        },
        401,
      );
    }
    context.set("authSession", authentication.session);
    context.set("surface", analyticsSurface(Boolean(trusted), context.req.header("user-agent")));
    if (!isSupportedClientContract(context.req.header("x-lifty-client-contract"))) {
      return errorJson(context, 409, "CONTEXT_CLIENT_UNSUPPORTED", CLIENT_UPGRADE_MESSAGE);
    }
    await next();
    // LIF-1663: the operation is decided; record it without touching the response.
    if (dependencies.analytics.enabled && !isInternalRequest(context.req.raw)) {
      const error = context.error;
      dependencies.analytics.observe({
        session: authentication.session, method: context.req.method, path: context.req.path,
        query: { attempt_ref: context.req.query("attempt_ref") }, surface: context.get("surface"),
        requestId: context.get("requestId"), selection: context.req.header("x-lifty-workspace")?.trim() || null,
        status: context.res.status, durationMs: Date.now() - context.get("requestStartedAt"),
        errorCode: error instanceof PublicError ? error.code : error ? "INTERNAL_ERROR" : null,
        facts: context.get("analyticsFacts"), response: context.res,
      });
    }
  });

  // Expired entries are removed on access, without a process-owning timer.
  app.use("/v1/*", async (context, next) => {
    if (context.req.method !== "POST" || !(rateLimitedPaths.has(context.req.path) || rateLimitedPatterns.some(pattern => pattern.test(context.req.path)))) return next();
    const now = Date.now();
    for (const [key, window] of mutationWindows) {
      if (window.resetsAt <= now) mutationWindows.delete(key);
    }
    const userId = context.get("authSession").userId;
    const window = mutationWindows.get(userId) ?? { count: 0, resetsAt: now + 60_000 };
    if (window.count >= 10) {
      context.header("Retry-After", String(Math.ceil((window.resetsAt - now) / 1000)));
      return errorJson(context, 429, "RATE_LIMITED", "Too many requests. Try again in a minute.");
    }
    window.count++;
    mutationWindows.set(userId, window);
    await next();
  });

  // ---------------------------------------------------------------- status

  registerStageRoutes(app, dependencies);

  // ---------------------------------------------------------------- workspace

  app.get("/v1/workspace", async (context) => {
    const result = await dependencies.getWorkspace(context.get("authSession"));
    return context.json(WorkspaceStatusSchema.parse(result));
  });

  app.get("/v1/integrations/hubspot/company-mapping/context", async (context) => {
    const workspaceRef = context.req.query("workspace_ref");
    if (workspaceRef !== undefined && !z.uuid().safeParse(workspaceRef).success) return errorJson(context, 400, "INVALID_WORKSPACE", "Select a valid workspace reference.");
    const result = await dependencies.companyMapping(context.get("authSession"), "context", undefined, {
      ...(workspaceRef === undefined ? {} : { workspaceRef }), signal: context.req.raw.signal,
    });
    return context.json(CompanyMappingContextSchema.parse(result));
  });
  app.post("/v1/integrations/hubspot/company-mapping", async (context) => {
    const body = await readRequestTextWithinLimit(context.req.raw, MAX_CREATE_WORKSPACE_BYTES);
    if (!body.ok) return errorJson(context, 413, "PAYLOAD_TOO_LARGE", "The company configuration exceeds 16 KiB.");
    let plan: unknown;
    try {
      plan = JSON.parse(body.text);
    } catch {
      return errorJson(context, 400, "INVALID_JSON", "Send a JSON company configuration.");
    }
    const result = await dependencies.companyMapping(context.get("authSession"), "apply", plan, { signal: context.req.raw.signal });
    return context.json(CompanyMappingReceiptSchema.parse(result));
  });

  // ------------------------------------------------------------ notifications

  app.get("/v1/notifications", async (context) => {
    const result = await dependencies.getNotificationConfig(
      context.get("authSession"),
    );
    return context.json(NotificationConfigSchema.parse(result));
  });

  app.get("/v1/notifications/slack/channels", async (context) => {
    const result = await dependencies.listSlackNotificationChannels(
      context.get("authSession"),
    );
    return context.json(SlackNotificationChannelsSchema.parse(result));
  });

  app.put("/v1/notifications/destinations/slack", async (context) => {
    const requestBody = await readRequestTextWithinLimit(
      context.req.raw,
      MAX_CREATE_WORKSPACE_BYTES,
    );
    if (!requestBody.ok) {
      return errorJson(
        context,
        413,
        "PAYLOAD_TOO_LARGE",
        "The notification destination request exceeds 16 KiB.",
      );
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(requestBody.text);
    } catch {
      parsedJson = null;
    }
    const input = UpsertNotificationDestinationRequestSchema.safeParse(parsedJson);
    if (!input.success) {
      return errorJson(
        context,
        400,
        "INVALID_REQUEST",
        "Choose a valid Slack channel returned by the channel list.",
      );
    }
    const result = await dependencies.upsertNotificationDestination(
      context.get("authSession"),
      input.data,
    );
    return context.json(NotificationDestinationSchema.parse(result));
  });

  app.put("/v1/notifications/routes", async (context) => {
    const requestBody = await readRequestTextWithinLimit(
      context.req.raw,
      MAX_CREATE_WORKSPACE_BYTES,
    );
    if (!requestBody.ok) {
      return errorJson(
        context,
        413,
        "PAYLOAD_TOO_LARGE",
        "The notification route request exceeds 16 KiB.",
      );
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(requestBody.text);
    } catch {
      parsedJson = null;
    }
    const input = SetNotificationRouteRequestSchema.safeParse(parsedJson);
    if (!input.success) {
      return errorJson(
        context,
        400,
        "INVALID_REQUEST",
        "The notification route is invalid.",
      );
    }
    const result = await dependencies.setNotificationRoute(
      context.get("authSession"),
      input.data,
    );
    return context.json(NotificationDestinationSchema.parse(result));
  });

  for (const [path, schema, operation] of [
    ["controls", SetNotificationControlsRequestSchema, (session: AuthSession, input: unknown) => dependencies.setNotificationControls(session, SetNotificationControlsRequestSchema.parse(input))],
    ["preferences", SetNotificationPreferencesRequestSchema, (session: AuthSession, input: unknown) => dependencies.setNotificationPreferences(session, SetNotificationPreferencesRequestSchema.parse(input))],
  ] as const) {
    app.openAPIRegistry.registerPath({ method: "put", path: `/v1/notifications/${path}`,
      operationId: path === "controls" ? "setNotificationControls" : "setNotificationPreferences", security: [{ bearerAuth: [] }],
      request: { body: { required: true, content: { "application/json": { schema } } } },
      responses: { 200: JsonResponse(NotificationConfigSchema), 400: JsonResponse(ErrorResponseSchema),
        401: JsonResponse(ErrorResponseSchema), 403: JsonResponse(ErrorResponseSchema), 409: JsonResponse(ErrorResponseSchema) },
    });
    app.put(`/v1/notifications/${path}`, async context => {
      const body = await readRequestTextWithinLimit(context.req.raw, MAX_CREATE_WORKSPACE_BYTES);
      if (!body.ok) return errorJson(context, 413, "PAYLOAD_TOO_LARGE", "Notification settings exceed 16 KiB.");
      let value: unknown;
      try { value = JSON.parse(body.text); } catch { value = null; }
      const parsed = schema.safeParse(value);
      if (!parsed.success) return errorJson(context, 400, "INVALID_REQUEST", "Notification settings are invalid.");
      return context.json(NotificationConfigSchema.parse(await operation(context.get("authSession"), parsed.data)));
    });
  }

  app.post(
    "/v1/notifications/destinations/:destination_ref/test",
    async (context) => {
      const destinationRef = DestinationRefSchema.safeParse(
        context.req.param("destination_ref"),
      );
      if (!destinationRef.success) {
        return errorJson(
          context,
          400,
          "INVALID_REQUEST",
          "The notification destination reference must be a UUID.",
        );
      }
      const result = await dependencies.sendNotificationTest(
        context.get("authSession"),
        destinationRef.data,
      );
      return context.json(NotificationTestResultSchema.parse(result));
    },
  );

  app.get("/v1/workspaces/:workspace_ref/research/recovery/:first_run_ref", async (context) => {
    context.header("cache-control", "no-store");
    const refs = z.object({
      workspace_ref: z.uuid(),
      first_run_ref: z.uuid(),
    }).safeParse(context.req.param());
    if (!refs.success) {
      return errorJson(context, 400, "INVALID_REQUEST", "Choose exact workspace and first-run references.");
    }
    const result = await dependencies.acquisitionRecovery(context.get("authSession"), {
      ...refs.data,
      operation: "status",
    });
    return context.json(AcquisitionRecoveryStatus.parse(result));
  });
  app.post("/v1/workspaces/:workspace_ref/research/recovery/:first_run_ref", async (context) => {
    context.header("cache-control", "no-store");
    const refs = z.object({
      workspace_ref: z.uuid(),
      first_run_ref: z.uuid(),
    }).safeParse(context.req.param());
    if (!refs.success) {
      return errorJson(context, 400, "INVALID_REQUEST", "Choose exact workspace and first-run references.");
    }
    const raw = await readRequestTextWithinLimit(context.req.raw, 4096);
    if (!raw.ok) {
      return errorJson(context, 413, "INVALID_REQUEST", "Recovery request is too large.");
    }
    let body: unknown;
    try {
      body = JSON.parse(raw.text);
    } catch {
      return errorJson(context, 400, "INVALID_REQUEST", "Provide one recovery request as JSON.");
    }
    const parsed = AcquisitionRecoveryBody.safeParse(body);
    if (!parsed.success) {
      return errorJson(context, 400, "INVALID_REQUEST", "Choose recovery request or restart with the exact acquisition reference.");
    }
    const result = await dependencies.acquisitionRecovery(context.get("authSession"), {
      ...refs.data,
      ...parsed.data,
    });
    const schema = parsed.data.operation === "restart"
      ? AcquisitionRestartResult
      : AcquisitionRecoveryStatus;
    return context.json(schema.parse(result));
  });

  app.post("/v1/workspaces/:workspace_ref/retire", async (context) => {
    context.header("cache-control", "no-store");
    const raw = await readRequestTextWithinLimit(context.req.raw, 4096);
    if (!raw.ok) return errorJson(context, 413, "INVALID_REQUEST", "Workspace retirement request is too large.");
    let body: unknown;
    try { body = JSON.parse(raw.text); } catch { return errorJson(context, 400, "INVALID_REQUEST", "Confirm the workspace ID, slug and name."); }
    const confirmation = RetireWorkspaceConfirmation.safeParse(body);
    const input = confirmation.success ? RetireWorkspaceRequest.safeParse({...confirmation.data,workspace_ref:context.req.param("workspace_ref")}) : null;
    if (!input?.success) return errorJson(context, 400, "INVALID_REQUEST", "Confirm the exact workspace ID, slug and name.");
    return context.json(RetireWorkspaceResult.parse(await dependencies.retireWorkspace(context.get("authSession"), input.data)));
  });

  // Lists only the signed-in caller's own workspace memberships.
  app.get("/v1/me/workspaces", async (context) => {
    context.header("cache-control", "no-store");
    return context.json(MemberWorkspacesResult.parse(await dependencies.listMemberWorkspaces(context.get("authSession"))));
  });

  // Deletes only the signed-in caller's own login, after they type its email.
  app.post("/v1/me/delete", async (context) => {
    context.header("cache-control", "no-store");
    const raw = await readRequestTextWithinLimit(context.req.raw, 4096);
    if (!raw.ok) return errorJson(context, 413, "INVALID_REQUEST", "Login deletion request is too large.");
    let body: unknown;
    try { body = JSON.parse(raw.text); } catch { return errorJson(context, 400, "INVALID_REQUEST", "Confirm the email of the login you are signed in with."); }
    const input = DeleteLoginRequest.safeParse(body);
    if (!input.success) return errorJson(context, 400, "INVALID_REQUEST", "Confirm the email of the login you are signed in with.");
    return context.json(DeleteLoginResult.parse(await dependencies.deleteOwnLogin(context.get("authSession"), input.data)));
  });

  app.get("/v1/email/campaign/placement/preview", async (context) => {
    context.header("cache-control", "no-store");
    const parsed = EmailCampaignRequest.safeParse({operation:"placement-preview",payload:context.req.query()});
    if (!parsed.success) return errorJson(context, 400, "INVALID_REQUEST", "Choose the workspace, campaign and exact digest.");
    return context.json(EmailPlacementPreview.parse(await dependencies.emailCampaign(context.get("authSession"), parsed.data)));
  });

  app.get("/v1/email/campaign/placement", async (context) => {
    context.header("cache-control", "no-store");
    const parsed = EmailCampaignRequest.safeParse({operation:"placement-status",payload:context.req.query()});
    if (!parsed.success) return errorJson(context, 400, "INVALID_REQUEST", "Choose the workspace, campaign and exact digest.");
    return context.json(EmailPlacementResult.parse(await dependencies.emailCampaign(context.get("authSession"), parsed.data)));
  });

  app.post("/v1/email/campaign", async (context) => {
    context.header("cache-control", "no-store");
    const raw = await readRequestTextWithinLimit(context.req.raw, 128 * 1024);
    if (!raw.ok) return errorJson(context, 413, "INVALID_REQUEST", "Campaign request is too large.");
    let body: unknown;
    try { body = JSON.parse(raw.text); } catch { return errorJson(context, 400, "INVALID_REQUEST", "Provide one campaign request as JSON."); }
    const parsed = HistoricalEmailCampaignRequest.safeParse(body);
    if (!parsed.success) return errorJson(context, 400, "INVALID_REQUEST", "Check the campaign operation, workspace and required fields.");
    const result = await historicalOperation(() => dependencies.emailCampaign(context.get("authSession"), parsed.data));
    return context.json(historicalEmailResult(campaignResultFor(parsed.data.operation, result)));
  });

  app.get("/v1/email/warmup", async (context) => {
    context.header("cache-control", "no-store");
    const parsed = WarmupWorkspaceRequest.safeParse(context.req.query());
    if (!parsed.success) return errorJson(context, 400, "INVALID_REQUEST", "Choose a workspace.");
    const target: [string, string?] = parsed.data.connection_ref === undefined
      ? [parsed.data.workspace] : [parsed.data.workspace, parsed.data.connection_ref];
    return context.json(WarmupStatus.parse(await dependencies.getEmailWarmup(context.get("authSession"), ...target)));
  });
  // LIF-1042: the database authorizes scope, filters and cursor with the
  // caller's session; provider reports are read only for authorized tests.
  app.get("/v1/email/deliverability", async (context) => {
    context.header("cache-control", "no-store");
    const params = new URL(context.req.url).searchParams;
    if ([...new Set(params.keys())].some(key => params.getAll(key).length !== 1)) return errorJson(context, 400, "INVALID_REQUEST", "Give each deliverability filter once.");
    const parsed = DeliverabilityQuery.safeParse(context.req.query());
    if (!parsed.success) return errorJson(context, 400, "INVALID_REQUEST",
      parsed.error.issues.find(issue => issue.code === "custom")?.message ?? "Choose a workspace and valid deliverability filters.");
    return context.json(DeliverabilityResponse.parse(await dependencies.getEmailDeliverability(context.get("authSession"), parsed.data)));
  });
  // LIF-1063: member-authorized placement tests for one warmed mailbox. The
  // database checks membership and the exact connection on every request.
  app.get("/v1/email/placement", async (context) => {
    context.header("cache-control", "no-store");
    const parsed = PlacementStatusRequest.safeParse(context.req.query());
    if (!parsed.success) return errorJson(context, 400, "INVALID_REQUEST", "Choose a workspace and, when it has several warmed mailboxes, a connection_ref.");
    return context.json(ConnectionPlacementStatus.parse(await dependencies.getEmailPlacement(context.get("authSession"), parsed.data)));
  });
  app.post("/v1/email/placement/start", async (context) => {
    context.header("cache-control", "no-store");
    const raw = await readRequestTextWithinLimit(context.req.raw, 32_768);
    if (!raw.ok) return errorJson(context, 413, "INVALID_REQUEST", "Placement request is too large.");
    let body: unknown;
    try { body = JSON.parse(raw.text); } catch { return errorJson(context, 400, "INVALID_REQUEST", "Provide the workspace, test subject, body and confirm: true."); }
    const parsed = PlacementStartRequest.safeParse(body);
    if (!parsed.success) return errorJson(context, 400, "INVALID_REQUEST", "Provide the workspace, a subject, a body of at least 10 characters and confirm: true.");
    return context.json(ConnectionPlacementStatus.parse(await dependencies.startEmailPlacement(context.get("authSession"), parsed.data)));
  });
  for (const operation of ["start", "pause", "resume", "remove"] as const) {
    app.post(`/v1/email/warmup/${operation}`, async (context) => {
      context.header("cache-control", "no-store");
      const raw = await readRequestTextWithinLimit(context.req.raw, 4096);
      if (!raw.ok) return errorJson(context, 413, "INVALID_REQUEST", "Warmup request is too large.");
      let body: unknown;
      try { body = JSON.parse(raw.text); } catch { return errorJson(context, 400, "INVALID_REQUEST", "Choose a workspace."); }
      const parsed = WarmupWorkspaceRequest.safeParse(body);
      if (!parsed.success) return errorJson(context, 400, "INVALID_REQUEST", "Choose a workspace explicitly.");
      const session = context.get("authSession");
      const connection: [] | [string] = parsed.data.connection_ref === undefined ? [] : [parsed.data.connection_ref];
      return context.json(operation === "start"
        ? WarmupStartResult.parse(await dependencies.startEmailWarmup(session, parsed.data.workspace, ...connection))
        : WarmupStatus.parse(await dependencies.changeEmailWarmup(session, parsed.data.workspace, operation, ...connection)));
    });
  }
  // ---------------------------------------------------------------- integrations

  app.post("/v1/workspaces/:workspace_ref/integrations/slack/connect-link", async (context) => {
    const workspace = z.uuid().safeParse(context.req.param("workspace_ref"));
    if (!workspace.success) return errorJson(context, 400, "INVALID_REQUEST", "Choose a valid workspace.");
    const result = await dependencies.createSlackConnectLink(context.get("authSession"), workspace.data);
    context.header("cache-control", "no-store");
    return context.json(SlackConnectLinkSchema.parse(result));
  });

  app.post("/v1/integrations/:provider/connect", async (context) => {
    const provider = resolveProvider(context);
    if (!provider.ok) return provider.response;
    const session = context.get("authSession");
    const result = provider.provider === "hubspot" ? await dependencies.startHubspotConnect(session)
      : provider.provider === "attio" ? await dependencies.startAttioConnect(session)
      : await dependencies.startSlackConnect(session);
    const validated = ProviderConnectStartSchema.parse(result);
    return context.json(LegacyProviderConnectStartSchema.parse({ provider: validated.provider,
      connect_url: validated.connect_url, expires_in_seconds: validated.expires_in_seconds }));
  });

  app.get("/v1/integrations/:provider", async (context) => {
    const provider = resolveProvider(context);
    if (!provider.ok) return provider.response;
    const session = context.get("authSession");
    const result = provider.provider === "hubspot" ? await dependencies.getHubspotConnection(session)
      : provider.provider === "attio" ? await dependencies.getAttioConnection(session)
      : await dependencies.getSlackConnection(session);
    return context.json(IntegrationConnectionStatusSchema.parse(result));
  });

  app.delete("/v1/integrations/:provider", async (context) => {
    const provider = resolveProvider(context);
    if (!provider.ok) return provider.response;
    // Confirmation is the skill's job; the RPC refuses while a sync is in
    // flight and when nothing is connected.
    const result = await dependencies.disconnectIntegration(
      context.get("authSession"),
      provider.provider,
    );

    // LIF-681: the RPC detached the grant under a revocation row; ask the
    // provider to revoke it too, best effort. LIFT already cannot use the
    // grant, so a lost enqueue degrades to "not revoked at HubSpot", never to
    // a failed disconnect. LIF-1119: the row stays pending and the overdue
    // revocation alert reports it if every attempt fails.
    if (result.revocation_ref) {
      const enqueued = await enqueueRevocationWithRetry(
        dependencies.enqueueIntegrationRevocation,
        result.revocation_ref,
      );
      if (!enqueued.ok) {
        dependencies.log({
          level: "error",
          event: "revocation_enqueue_failed",
          request_id: context.get("requestId"),
          method: context.req.method,
          path: context.req.path,
          error_code: enqueued.error instanceof PublicError ? enqueued.error.code : "REVOCATION_ENQUEUE_FAILED",
          status: enqueued.error instanceof PublicError ? enqueued.error.status : 502,
          attempts: enqueued.attempts,
        });
      }
    }

    return context.json(
      DisconnectResponseSchema.parse({
        provider: result.provider,
        status: result.status,
        portal_id: result.portal_id,
        disconnected_at: result.disconnected_at,
        workspace: result.workspace,
      }),
    );
  });

  // The sync run follows the workspace's selected CRM; a provider-named route
  // never starts a sync into a different CRM than the one it names.
  async function requireConnectedCrm(context: Context<AppEnvironment>, provider: "hubspot" | "attio") {
    const attio = (await dependencies.getAttioConnection(context.get("authSession"))).status === "connected";
    if (provider === "attio" && !attio) {
      throw new PublicError({ status: 409, code: "ATTIO_NOT_CONNECTED", message: "Connect Attio before syncing leads to it." });
    }
    if (provider === "hubspot" && attio) {
      throw new PublicError({ status: 409, code: "CRM_PROVIDER_MISMATCH",
        message: "This workspace's CRM is Attio. Update Lifty and sync through the CRM stage." });
    }
  }
  app.post("/v1/integrations/:provider/sync", async (context) => {
    const provider = resolveProvider(context);
    if (!provider.ok) return provider.response;
    if (provider.provider === "slack") {
      return providerUnavailable(context, provider.provider);
    }
    await requireConnectedCrm(context, provider.provider);
    const result = await dependencies.startCrmSyncRun(
      context.get("authSession"),
    );
    // Enqueue on every start, including a re-attach — same self-healing
    // run-scoped idempotency as the first run.
    await dependencies.enqueueCrmSync(result.run_ref);
    return context.json(StartCrmSyncResultSchema.parse(result));
  });

  app.get("/v1/integrations/:provider/sync", async (context) => {
    const provider = resolveProvider(context);
    if (!provider.ok) return provider.response;
    if (provider.provider === "slack") {
      return providerUnavailable(context, provider.provider);
    }
    const result = await dependencies.getCrmSyncStatus(
      context.get("authSession"),
    );
    return context.json(CrmSyncStatusSchema.parse(result));
  });

  return app;
}
