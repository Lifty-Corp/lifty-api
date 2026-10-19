import { z } from "zod";
import type { AuthSession } from "./app.js";
import { DisconnectResultSchema, type DisconnectResult, type Provider, RunStatusSchema, type RunStatus, StartRunResultSchema, type StartRunResult, StartCrmSyncResultSchema, type StartCrmSyncResult, CrmSyncStatusSchema, type CrmSyncStatus, WorkspaceStatusSchema, type WorkspaceStatus, NotificationChannelSchema, type NotificationConfig, type NotificationDestination, NotificationTestResultSchema, type NotificationTestResult, NotificationTypeCodeSchema, SetNotificationRouteRequestSchema, type SetNotificationRouteRequest, SlackNotificationChannelsSchema, type SlackNotificationChannels, UpsertNotificationDestinationRequestSchema, type UpsertNotificationDestinationRequest } from "./contracts.js";
import { PublicError } from "./errors.js";
import type { EnqueueNotificationTest } from "./trigger-client.js";
import { rpcFailure } from "./rpc-errors.js";
import { DEFAULT_DASHBOARD_ORIGIN } from "./config.js";

interface RpcClient {
  rpc<T>(
    name: string,
    args?: Record<string, unknown>,
  ): PromiseLike<{ data: T; error: unknown }>;
}

/** The session client also reaches the private `notifications` schema, whose
 * customer-edge functions the Data API exposes to `authenticated` only. */
interface SchemaRpcClient extends RpcClient {
  schema(name: "notifications"): RpcClient;
}

interface FunctionsClient {
  functions: {
    invoke<T>(
      name: string,
      options?: { method?: "GET" | "POST" },
    ): Promise<{ data: T; error: unknown }>;
  };
}

function getRpcClient(session: AuthSession): RpcClient {
  return session.client as RpcClient;
}

function getFunctionsClient(session: AuthSession): FunctionsClient {
  return session.client as FunctionsClient;
}

function unwrapSingleRow(value: unknown): unknown {
  return Array.isArray(value) && value.length === 1 ? value[0] : value;
}

function invalidResponse(cause: unknown): PublicError {
  return new PublicError({
    status: 502,
    code: "SUPABASE_INVALID_RESPONSE",
    message: "LIFTY received an invalid workspace response.",
    cause,
  });
}

function mapRpcError(error: unknown): PublicError {
  const candidate = error as { code?: unknown; message?: unknown };
  const code = typeof candidate?.code === "string" ? candidate.code : "";
  const message = typeof candidate?.message === "string" ? candidate.message : "";
  if (code === "PT409" && message.includes("lifty_workspace_ambiguous")) {
    return new PublicError({ status: 409, code: "WORKSPACE_SELECTION_REQUIRED",
      message: "You belong to several workspaces. Choose one with the x-lifty-workspace header (lifty use <workspace> in the CLI).", cause: error });
  }
  if (code === "PT403" && message.includes("lifty_workspace_forbidden")) {
    return new PublicError({ status: 403, code: "WORKSPACE_FORBIDDEN",
      message: "You don't belong to that workspace. Run whoami to list yours.", cause: error });
  }
  if (code === "PT409" && message.includes("lifty_workspace_suspended")) {
    return new PublicError({ status: 409, code: "WORKSPACE_SUSPENDED",
      message: "This workspace is suspended. Contact LIFT support.", cause: error });
  }

  if (code === "PT409" && message.includes("workspace_already_exists")) {
    return new PublicError({
      status: 409,
      code: "WORKSPACE_ALREADY_EXISTS",
      message: "This account already has a LIFTY workspace.",
      cause: error,
    });
  }

  if (code === "PT409" && message.includes("lifty_sync_not_connected")) {
    return new PublicError({
      status: 409,
      code: "HUBSPOT_NOT_CONNECTED",
      message: "HubSpot is not connected to this workspace. Connect HubSpot first.",
      cause: error,
    });
  }

  if (code === "PT409" && message.includes("lifty_sync_nothing_to_sync")) {
    return new PublicError({
      status: 409,
      code: "NOTHING_TO_SYNC",
      message: "Every researched lead is already in your CRM.",
      cause: error,
    });
  }

  if (code === "PT409" && message.includes("lifty_sync_run_in_progress")) {
    return new PublicError({
      status: 409,
      code: "RUN_IN_PROGRESS",
      message: "A research run is still in progress. Wait for it to finish, then start the CRM sync again.",
      cause: error,
    });
  }

  if (code === "PT409" && message.includes("lifty_sync_workspace_suspended")) {
    return new PublicError({
      status: 409,
      code: "WORKSPACE_SUSPENDED",
      message: "This workspace is suspended. Contact LIFT support.",
      cause: error,
    });
  }

  if (code === "PT409" && message.includes("lifty_sync_in_flight")) {
    return new PublicError({
      status: 409,
      code: "SYNC_IN_PROGRESS",
      message: "A CRM sync is still running. Wait for it to finish, then disconnect.",
      cause: error,
    });
  }

  if (code === "PT409" && message.includes("lifty_integration_not_connected")) {
    return new PublicError({
      status: 409,
      code: "NOT_CONNECTED",
      message: "This provider is not connected to your workspace.",
      cause: error,
    });
  }

  if (code === "PT409" && message.includes("lifty_workspace_missing")) {
    return new PublicError({
      status: 409,
      code: "WORKSPACE_MISSING",
      message: "This account has no Lifty workspace yet. Create the workspace first.",
      cause: error,
    });
  }

  if (code === "PT401") {
    return new PublicError({
      status: 401,
      code: "UNAUTHORIZED",
      message: "A valid LIFTY session is required.",
      cause: error,
    });
  }

  if (code === "PT400" && message.includes("lifty_provider_invalid")) {
    return new PublicError({
      status: 400,
      code: "PROVIDER_INVALID",
      message: "Unknown provider. Supported providers: hubspot, slack.",
      cause: error,
    });
  }

  if (code === "PT413") {
    return new PublicError({
      status: 413,
      code: "DRAFT_TOO_LARGE",
      message: "The request exceeds the server safety limits.",
      cause: error,
    });
  }

  if (code === "PT409") {
    return new PublicError({
      status: 409,
      code: "PROVISIONING_CONFLICT",
      message: "The workspace could not be provisioned because of a conflict.",
      cause: error,
    });
  }

  // P0001 is a plain `raise exception` — a database trigger or function
  // rejected the request outright rather than failing to run.
  if (code === "P0001") {
    return new PublicError({
      status: 502,
      code: "PROVISIONING_REJECTED",
      message: "A LIFTY server-side integrity check rejected the workspace request. Contact LIFT support.",
      cause: error,
    });
  }

  return new PublicError({
    status: 502,
    code: "SUPABASE_REQUEST_FAILED",
    message: "LIFTY could not complete the workspace request.",
    cause: error,
  });
}

export async function getWorkspaceStatus(
  session: AuthSession,
): Promise<WorkspaceStatus> {
  const client = getRpcClient(session);
  const { data, error } = await client.rpc("get_lifty_workspace_status");

  if (error) {
    throw mapRpcError(error);
  }

  const parsed = WorkspaceStatusSchema.safeParse(unwrapSingleRow(data));
  if (!parsed.success) {
    throw invalidResponse(parsed.error);
  }
  return parsed.data;
}

// Calibration runs use the workspace the database selects for the session
// (shared rule, p_workspace_id null); it also enforces suspension and the
// weekly research limit.
const runUnavailable = (operation: string) => ({
  operation,
  code: "SAMPLE_REVIEW_UNAVAILABLE",
  message: "The research sample could not be verified. Read sample-review before retrying.",
});

export async function startRun(session: AuthSession): Promise<StartRunResult> {
  const { data, error } = await getRpcClient(session).rpc<StartRunResult>(
    "start_lifty_run",
    { p_workspace_id: null },
  );
  if (error) throw rpcFailure(error, runUnavailable("start_lifty_run"));

  const parsed = StartRunResultSchema.safeParse(unwrapSingleRow(data));
  if (!parsed.success) {
    throw invalidResponse(parsed.error);
  }
  return parsed.data;
}

export async function getRunStatus(session: AuthSession, dashboardOrigin = DEFAULT_DASHBOARD_ORIGIN): Promise<RunStatus> {
  const { data, error } = await getRpcClient(session).rpc<RunStatus>(
    "get_lifty_run_status",
    { p_workspace_id: session.workspaceRef ?? null },
  );
  if (error) throw rpcFailure(error, runUnavailable("get_lifty_run_status"));
  return runStatusWithLinks(data, dashboardOrigin);
}

// Records the founder's confirmation of the latest sample; repeating it keeps
// the first one (LIF-1303). Returns the sample like getRunStatus.
export async function confirmRunReview(session: AuthSession, runRef: string, dashboardOrigin = DEFAULT_DASHBOARD_ORIGIN): Promise<RunStatus> {
  const { data, error } = await getRpcClient(session).rpc<RunStatus>(
    "confirm_lifty_run_review",
    { p_run_ref: runRef, p_workspace_id: null },
  );
  if (error) throw rpcFailure(error, runUnavailable("confirm_lifty_run_review"));
  return runStatusWithLinks(data, dashboardOrigin);
}

function runStatusWithLinks(data: unknown, dashboardOrigin: string): RunStatus {
  const parsed = RunStatusSchema.safeParse(unwrapSingleRow(data));
  if (!parsed.success) {
    throw invalidResponse(parsed.error);
  }
  if (parsed.data.state === "none" || parsed.data.leads === null) return parsed.data;
  return {...parsed.data, leads: parsed.data.leads.map(lead => ({
    ...lead,
    research_url: lead.research_available === true && lead.lead_ref
      ? `${dashboardOrigin}/protected/leads/${lead.lead_ref}` : null,
  }))};
}

export async function startCrmSyncRun(
  session: AuthSession,
): Promise<StartCrmSyncResult> {
  const { data, error } = await getRpcClient(session).rpc<StartCrmSyncResult>(
    "start_lifty_crm_sync_run",
  );

  if (error) {
    throw mapRpcError(error);
  }

  const parsed = StartCrmSyncResultSchema.safeParse(unwrapSingleRow(data));
  if (!parsed.success) {
    throw invalidResponse(parsed.error);
  }
  return parsed.data;
}

export async function getCrmSyncStatus(
  session: AuthSession,
): Promise<CrmSyncStatus> {
  // Founder calls keep the argument-less form; only admin reads name a workspace.
  const { data, error } = await getRpcClient(session).rpc<CrmSyncStatus>(
    "get_lifty_crm_sync_status",
    ...(session.workspaceRef ? [{ p_workspace_id: session.workspaceRef }] : []),
  );

  if (error) {
    throw mapRpcError(error);
  }

  const parsed = CrmSyncStatusSchema.safeParse(unwrapSingleRow(data));
  if (!parsed.success) {
    throw invalidResponse(parsed.error);
  }
  return parsed.data;
}

// Keep raw PostgREST messages/details in the cause only. They can contain user
// data or SQL; logs get a bounded code and a static operation name instead.
function configRpcError(error: unknown, operation: string, mapped = mapRpcError(error)): PublicError {
  const candidate = error && typeof error === "object" && "code" in error ? error.code : null;
  const code = typeof candidate === "string" && /^(?:[A-Z0-9]{5}|PGRST[0-9]{3})$/.test(candidate) ? candidate : undefined;
  return new PublicError({ status: mapped.status, code: mapped.code, message: mapped.message, cause: error,
    diagnostics: { upstream_operation: operation, ...(code ? { upstream_code: code } : {}),
      upstream_kind: code === "XX001" ? "database_storage" : code === "57014" ? "database_timeout" : code ? "database_error" : "transport" },
  });
}

/** disconnect_lifty_integration: the one destructive founder verb (confirmation is the skill's job). */
export async function disconnectIntegration(
  session: AuthSession,
  provider: Provider,
): Promise<DisconnectResult> {
  const { data, error } = await getRpcClient(session).rpc<DisconnectResult>(
    "disconnect_lifty_integration",
    { p_provider: provider },
  );

  if (error) {
    throw mapRpcError(error);
  }

  const parsed = DisconnectResultSchema.safeParse(unwrapSingleRow(data));
  if (!parsed.success) {
    throw invalidResponse(parsed.error);
  }
  return parsed.data;
}

// ------------------------------------------------------------ notifications
// Configuration lives in the private notifications schema (LIF-1464). Its
// customer-edge functions take the workspace UUID instead of resolving the
// x-lifty-workspace selection, so each operation first resolves the session's
// workspace through the same status RPC every stage uses. Slack connection
// state is not part of that configuration; it comes from the existing
// get_lifty_slack_connection read, which honors the same selection.

function notificationsClient(session: AuthSession): RpcClient {
  return (session.client as SchemaRpcClient).schema("notifications");
}

// The database is the authority on the catalog: unknown type codes pass by
// shape, and fields this API does not publish are dropped, never forwarded.
const StoredNotificationConfigurationSchema = z.object({
  types: z.array(z.object({
    code: NotificationTypeCodeSchema,
    name: z.string(),
    channels: z.array(NotificationChannelSchema),
    email_fallback: z.boolean(),
    default_on: z.boolean(),
    paused: z.boolean(),
  })).nullable(),
  destinations: z.array(z.object({
    id: z.uuid(),
    channel: NotificationChannelSchema,
    address: z.string().nullable(),
    name: z.string().nullable(),
    active: z.boolean(),
    types: z.array(NotificationTypeCodeSchema),
  })).nullable(),
});
type StoredNotificationConfiguration = { types: NotificationConfig["types"]; destinations: NotificationDestination[] };

const StoredSlackConnectionSchema = z.union([
  z.object({ status: z.literal("not_connected") }),
  z.object({ status: z.literal("connected"), team_id: z.string().min(1), team_name: z.string().min(1), reconnect_required: z.boolean() }),
]);
type SlackStatus = NotificationConfig["slack"];

const workspaceForbidden = (cause: unknown) => new PublicError({ status: 403, code: "WORKSPACE_FORBIDDEN",
  message: "You don't belong to that workspace. Run whoami to list yours.", cause });
const destinationNotFound = (cause?: unknown) => new PublicError({ status: 404, code: "DESTINATION_NOT_FOUND",
  message: "That notification destination does not exist in this workspace. Read notifications for current destination refs.", cause });
const typeUnknown = (cause?: unknown) => new PublicError({ status: 400, code: "NOTIFICATION_TYPE_UNKNOWN",
  message: "That notification type does not exist. Read notifications for the current types.", cause });
const channelUnsupported = (cause?: unknown) => new PublicError({ status: 409, code: "NOTIFICATION_CHANNEL_UNSUPPORTED",
  message: "That notification type is not available on this destination's channel. Read the type's channels.", cause });

// 42501 is the functions' one refusal for non-members and unknown workspaces or
// destinations; a caller that already proved membership names the precise case.
function notificationsRpcError(error: unknown, operation: string, forbidden: (cause: unknown) => PublicError = workspaceForbidden): PublicError {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  const mapped = code === "42501" ? forbidden(error)
    : code === "22023" ? new PublicError({ status: 400, code: "INVALID_REQUEST", message: "The notification request is invalid.", cause: error })
    : code === "23514" ? channelUnsupported(error)
    : code === "23503" ? typeUnknown(error)
    : mapRpcError(error);
  return configRpcError(error, operation, mapped);
}

async function notificationWorkspace(session: AuthSession): Promise<string> {
  const status = await getWorkspaceStatus(session);
  if (status.state === "needs_workspace") throw mapRpcError({ code: "PT409", message: "lifty_workspace_missing" });
  const workspaceRef = status.workspace.workspace_ref;
  if (!z.uuid().safeParse(workspaceRef).success) throw invalidResponse(new Error("workspace_ref is not a UUID"));
  return workspaceRef;
}

async function readNotificationConfiguration(session: AuthSession, workspaceRef: string): Promise<StoredNotificationConfiguration> {
  const { data, error } = await notificationsClient(session).rpc<unknown>("get_configuration", { p_workspace_id: workspaceRef });
  if (error) throw notificationsRpcError(error, "notifications.get_configuration");
  const parsed = StoredNotificationConfigurationSchema.safeParse(data);
  if (!parsed.success) throw invalidResponse(parsed.error);
  return {
    types: (parsed.data.types ?? []).map(type => ({ code: type.code, name: type.name, channels: type.channels,
      default_on: type.default_on, paused: type.paused, email_fallback: type.email_fallback })),
    destinations: (parsed.data.destinations ?? []).map(destination => ({ destination_ref: destination.id,
      channel: destination.channel, address: destination.address, name: destination.name,
      active: destination.active, types: destination.types })),
  };
}

async function readSlackStatus(session: AuthSession): Promise<SlackStatus> {
  const { data, error } = await getRpcClient(session).rpc<unknown>("get_lifty_slack_connection");
  if (error) throw configRpcError(error, "get_lifty_slack_connection");
  const parsed = StoredSlackConnectionSchema.safeParse(data);
  if (!parsed.success) throw invalidResponse(parsed.error);
  return parsed.data.status === "connected"
    ? { status: "connected", team_id: parsed.data.team_id, team_name: parsed.data.team_name, reconnect_required: parsed.data.reconnect_required }
    : { status: "not_connected" };
}

// The configuration functions do not check the Slack grant, so writes and tests
// that need Slack refuse here, with the same codes the channel list uses.
function requireUsableSlack(slack: SlackStatus): void {
  if (slack.status !== "connected") {
    throw new PublicError({ status: 409, code: "SLACK_NOT_CONNECTED", message: "Slack is not connected to this workspace. Connect Slack first." });
  }
  if (slack.reconnect_required) {
    throw new PublicError({ status: 409, code: "SLACK_RECONNECT_REQUIRED", message: "Reconnect Slack before configuring or testing a Slack notification channel." });
  }
}

// Both reads run together; the configuration error wins so the result is stable.
async function readConfigurationAndSlack(session: AuthSession, workspaceRef: string) {
  const [configuration, slack] = await Promise.allSettled([readNotificationConfiguration(session, workspaceRef), readSlackStatus(session)]);
  if (configuration.status === "rejected") throw configuration.reason;
  if (slack.status === "rejected") throw slack.reason;
  return { configuration: configuration.value, slack: slack.value };
}

function savedDestination(configuration: StoredNotificationConfiguration, destinationRef: string): NotificationDestination {
  const destination = configuration.destinations.find(item => item.destination_ref === destinationRef);
  if (!destination) throw invalidResponse(new Error("The saved destination is missing from the configuration read"));
  return destination;
}

export async function getNotificationConfig(session: AuthSession): Promise<NotificationConfig> {
  const workspaceRef = await notificationWorkspace(session);
  const { configuration, slack } = await readConfigurationAndSlack(session, workspaceRef);
  return { workspace_ref: workspaceRef, slack, ...configuration };
}

export async function listSlackNotificationChannels(
  session: AuthSession,
): Promise<SlackNotificationChannels> {
  const { data, error } = await getFunctionsClient(session).functions.invoke<unknown>(
    "lifty-slack-channels",
    { method: "POST" },
  );
  if (error) {
    // Read the response structurally: the client's Response may come from a
    // different fetch implementation, so instanceof is not reliable here.
    const response = (error as { context?: { status?: unknown; json?: () => Promise<unknown> } }).context;
    let reason: unknown;
    try { reason = typeof response?.json === "function" ? ((await response.json()) as { error?: unknown } | null)?.error : undefined; } catch { reason = undefined; }
    // Only the reasons the function names are founder setup steps. The
    // workspace ones are the database's own resolution, mapped like any RPC.
    if (reason === "slack_not_connected") {
      throw new PublicError({ status: 409, code: "SLACK_NOT_CONNECTED", message: "Slack is not connected to this workspace. Connect Slack first.", cause: error });
    }
    if (reason === "slack_reconnect_required") {
      throw new PublicError({ status: 409, code: "SLACK_RECONNECT_REQUIRED", message: "Reconnect Slack before choosing a notification channel.", cause: error });
    }
    if (reason === "workspace_selection_required") throw mapRpcError({ code: "PT409", message: "lifty_workspace_ambiguous" });
    if (reason === "workspace_forbidden") throw mapRpcError({ code: "PT403", message: "lifty_workspace_forbidden" });
    if (reason === "workspace_missing") throw mapRpcError({ code: "PT409", message: "lifty_workspace_missing" });
    // Anything else is ours, whatever its status: never a reason to reconnect Slack.
    const upstreamCode = typeof reason === "string" && /^[a-z0-9_]{1,80}$/.test(reason)
      ? reason
      : typeof response?.status === "number" ? `http_${response.status}` : undefined;
    throw new PublicError({
      status: 502,
      code: "SLACK_CHANNELS_UNAVAILABLE",
      message: "LIFTY could not load Slack channels. Try again in a moment.",
      cause: error,
      diagnostics: { upstream_operation: "lifty-slack-channels", ...(upstreamCode ? { upstream_code: upstreamCode } : {}), upstream_kind: "edge_function" },
    });
  }
  const parsed = SlackNotificationChannelsSchema.safeParse(data);
  if (!parsed.success) throw invalidResponse(parsed.error);
  return parsed.data;
}

/** Saves (or renames and reactivates) a Slack channel destination. A new one is
 * subscribed by the database to every default-on type Slack can render. */
export async function upsertNotificationDestination(
  session: AuthSession,
  input: UpsertNotificationDestinationRequest,
): Promise<NotificationDestination> {
  const validated = UpsertNotificationDestinationRequestSchema.parse(input);
  const workspaceRef = await notificationWorkspace(session);
  requireUsableSlack(await readSlackStatus(session));
  const { data, error } = await notificationsClient(session).rpc<unknown>("save_slack_destination", {
    p_workspace_id: workspaceRef, p_channel_id: validated.channel_id, p_name: validated.channel_name, p_active: true,
  });
  if (error) throw notificationsRpcError(error, "notifications.save_slack_destination");
  const destinationRef = z.uuid().safeParse(unwrapSingleRow(data));
  if (!destinationRef.success) throw invalidResponse(destinationRef.error);
  return savedDestination(await readNotificationConfiguration(session, workspaceRef), destinationRef.data);
}

/** Subscribes (enabled) or unsubscribes one destination, Slack or the owner
 * email, to one type. The configuration read proves the destination belongs to
 * this workspace and the type exists and can render on its channel. */
export async function setNotificationRoute(
  session: AuthSession,
  input: SetNotificationRouteRequest,
): Promise<NotificationDestination> {
  const validated = SetNotificationRouteRequestSchema.parse(input);
  const workspaceRef = await notificationWorkspace(session);
  const configuration = await readNotificationConfiguration(session, workspaceRef);
  const destination = configuration.destinations.find(item => item.destination_ref === validated.destination_ref);
  if (!destination) throw destinationNotFound();
  const type = configuration.types.find(item => item.code === validated.notification_type);
  if (!type) throw typeUnknown();
  if (!type.channels.includes(destination.channel)) throw channelUnsupported();
  const { error } = await notificationsClient(session).rpc<unknown>("set_subscription", {
    p_destination_id: validated.destination_ref, p_type_code: validated.notification_type, p_subscribed: validated.enabled,
  });
  // Membership is already proven, so a refusal now means the destination went away.
  if (error) throw notificationsRpcError(error, "notifications.set_subscription", destinationNotFound);
  return savedDestination(await readNotificationConfiguration(session, workspaceRef), validated.destination_ref);
}

/** Asks the notifications service to post one test message to a saved Slack
 * destination, active or not. Each call is its own request: request_ref keys
 * the Trigger run, so a retried acceptance never posts twice. */
export async function sendNotificationTest(
  session: AuthSession,
  destinationRef: string,
  enqueue: EnqueueNotificationTest,
): Promise<NotificationTestResult> {
  const workspaceRef = await notificationWorkspace(session);
  const { configuration, slack } = await readConfigurationAndSlack(session, workspaceRef);
  const destination = configuration.destinations.find(item => item.destination_ref === destinationRef);
  if (!destination) throw destinationNotFound();
  if (destination.channel !== "slack") {
    throw new PublicError({ status: 409, code: "DESTINATION_NOT_TESTABLE", message: "Only Slack destinations can receive a test message." });
  }
  requireUsableSlack(slack);
  const requestRef = crypto.randomUUID();
  await enqueue({ workspaceId: workspaceRef, destinationId: destination.destination_ref, requestId: requestRef });
  return NotificationTestResultSchema.parse({ destination_ref: destination.destination_ref, request_ref: requestRef, status: "queued" });
}
