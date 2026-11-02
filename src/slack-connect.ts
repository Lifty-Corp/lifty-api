import { connectionFetch } from "./connection-confirmation.js";
import type { AuthSession } from "./app.js";
import {
  SlackConnectStartSchema,
  SlackConnectLinkSchema,
  type SlackConnectLink,
  SlackConnectionStatusSchema,
  type SlackConnectStart,
  type SlackConnectionStatus,
} from "./contracts.js";
import { PublicError } from "./errors.js";
import { CONNECTION_REFUSAL_CODES, recordOAuthFailure } from "./connection-attempt.js";
import { exchangeAndVerifySlackGrant } from "./slack-oauth.js";
import { openSlackConnectIntent, sealSlackConnectIntent } from "./slack-state.js";

export interface SlackConnectSettings {
  clientId: string;
  clientSecret: string;
  publicBaseUrl: string;
  supabaseUrl: string;
  publishableKey: string;
  fetchImpl?: typeof fetch;
}

export interface SlackCallbackSuccess {
  teamId: string;
  teamName: string;
}

interface RpcClient {
  rpc<T>(name: string, params?: Record<string, unknown>): Promise<{ data: T; error: unknown }>;
}

function rpcClient(session: AuthSession): RpcClient {
  return session.client as RpcClient;
}

function mapConnectRpcError(error: unknown): PublicError {
  const candidate = error as { code?: unknown; message?: unknown };
  const code = typeof candidate?.code === "string" ? candidate.code : "";
  const message = typeof candidate?.message === "string" ? candidate.message : "";
  if (code === "PT401") {
    return new PublicError({
      status: 401,
      code: "UNAUTHORIZED",
      message: "A valid LIFTY session is required.",
      cause: error,
    });
  }
  if (code === "PT403") {
    return new PublicError({
      status: 403, code: "FORBIDDEN",
      message: "You must belong to this workspace to create a Slack invitation.",
      cause: error,
    });
  }
  if (code === "PT409" && message.includes("lifty_workspace_missing")) {
    return new PublicError({
      status: 409,
      code: "WORKSPACE_NOT_READY",
      message: "Provision a LIFTY workspace before connecting Slack.",
      cause: error,
    });
  }
  if (code === "PT409" && message.includes("lifty_workspace_suspended")) {
    return new PublicError({
      status: 409,
      code: "WORKSPACE_SUSPENDED",
      message: "This LIFTY workspace is suspended; contact LIFT before connecting providers.",
      cause: error,
    });
  }
  return new PublicError({
    status: 502,
    code: "SUPABASE_REQUEST_FAILED",
    message: "LIFTY could not complete the connection request.",
    cause: error,
  });
}

export class SlackCallbackError extends Error {
  readonly reason: string;
  readonly status: number;
  readonly safeMessage: string;

  constructor(reason: string, status: number, safeMessage: string) {
    super(reason);
    this.name = "SlackCallbackError";
    this.reason = reason;
    this.status = status;
    this.safeMessage = safeMessage;
  }
}

const COMPLETION_FAILURES: ReadonlyArray<[string, string, number, string]> = [
  ["lifty_connect_intent_invalid", "link_invalid", 403,
    "This connection link is not valid. Ask LIFT for a fresh connection link."],
  ["lifty_connect_intent_replayed", "link_used", 409,
    "This connection link was already used. Ask LIFT for a fresh connection link."],
  ["lifty_connect_intent_expired", "link_expired", 410,
    "This connection link expired. Ask LIFT for a fresh connection link."],
  ["lifty_connect_intent_revoked", "link_revoked", 403,
    "This connection link is no longer available. Ask LIFT for a fresh link."],
  ["lifty_slack_team_already_connected", "team_taken", 409,
    "That Slack workspace is already connected to another LIFTY workspace."],
];

export interface SlackConnectOperations {
  startConnect(session: AuthSession): Promise<SlackConnectStart>;
  createConnectLink(session: AuthSession, workspaceId: string): Promise<SlackConnectLink>;
  getConnection(session: AuthSession): Promise<SlackConnectionStatus>;
  completeCallback(input: { code: string; state: string }): Promise<SlackCallbackSuccess>;
  denyCallback(state: string): Promise<void>;
}

export function createSlackConnectOperations(
  settings: SlackConnectSettings,
): SlackConnectOperations {
  const fetchImpl = connectionFetch(settings.fetchImpl ?? fetch);
  const publicBaseUrl = settings.publicBaseUrl.replace(/\/$/, "");
  const redirectUri = `${publicBaseUrl}/slack/callback`;

  async function startConnect(session: AuthSession): Promise<SlackConnectStart> {
    const { data, error } = await rpcClient(session).rpc<Record<string, unknown>>(
      "create_lifty_slack_connect_intent",
    );
    if (error) throw mapConnectRpcError(error);
    const token = typeof data?.intent_token === "string" ? data.intent_token : "";
    const expiresIn = Number(data?.expires_in_seconds);
    if (!/^[0-9a-f]{64}$/.test(token) || !Number.isInteger(expiresIn) || expiresIn <= 0) {
      throw new PublicError({
        status: 502,
        code: "SUPABASE_INVALID_RESPONSE",
        message: "LIFTY received an invalid connection response.",
      });
    }
    const state = sealSlackConnectIntent(token, settings.clientSecret);
    return SlackConnectStartSchema.parse({
      provider: "slack",
      connect_url: `${publicBaseUrl}/slack/start?intent=${encodeURIComponent(state)}`,
      expires_in_seconds: expiresIn,
      ...(data.attempt_ref !== undefined ? { attempt_ref: data.attempt_ref, expires_at: data.expires_at } : {}),
    });
  }

  async function createConnectLink(session: AuthSession, workspaceId: string): Promise<SlackConnectLink> {
    const { data, error } = await rpcClient(session).rpc<Record<string, unknown>>(
      "create_lifty_admin_slack_connect_intent", { p_workspace_id: workspaceId },
    );
    if (error) throw mapConnectRpcError(error);
    const token = typeof data?.intent_token === "string" ? data.intent_token : "";
    if (!/^[0-9a-f]{64}$/.test(token) || data?.workspace_id !== workspaceId
        || data?.expires_in_seconds !== 604800
        || typeof data?.workspace_name !== "string" || !data.workspace_name.trim()) {
      throw new PublicError({ status: 502, code: "SUPABASE_INVALID_RESPONSE",
        message: "LIFTY received an invalid invitation response." });
    }
    const state = sealSlackConnectIntent(token, settings.clientSecret);
    return SlackConnectLinkSchema.parse({
      provider: "slack", workspace_id: workspaceId, workspace_name: data.workspace_name,
      connect_url: `${publicBaseUrl}/slack/start?intent=${encodeURIComponent(state)}`,
      expires_in_seconds: data.expires_in_seconds,
    });
  }

  async function getConnection(session: AuthSession): Promise<SlackConnectionStatus> {
    const { data, error } = await rpcClient(session).rpc<unknown>(
      "get_lifty_slack_connection",
    );
    if (error) throw mapConnectRpcError(error);
    const parsed = SlackConnectionStatusSchema.safeParse(data);
    if (!parsed.success) {
      throw new PublicError({
        status: 502,
        code: "SUPABASE_INVALID_RESPONSE",
        message: "LIFTY received an invalid connection status.",
        cause: parsed.error,
      });
    }
    return parsed.data;
  }

  async function completeCallback(
    input: { code: string; state: string },
  ): Promise<SlackCallbackSuccess> {
    let intentToken: string;
    try {
      intentToken = openSlackConnectIntent(input.state, settings.clientSecret);
    } catch {
      throw new SlackCallbackError(
        "link_invalid",
        403,
        "This connection link is not valid. Ask LIFT for a fresh connection link.",
      );
    }

    let grant;
    try {
      grant = await exchangeAndVerifySlackGrant({
        clientId: settings.clientId,
        clientSecret: settings.clientSecret,
        redirectUri,
        code: input.code,
        fetchImpl,
      });
    } catch (error) {
      const marker = error instanceof Error ? error.message : "";
      if (marker === "slack_scope_mismatch") {
        throw new SlackCallbackError(
          "scope_mismatch",
          403,
          "Slack did not grant the exact permissions LIFTY needs. Ask LIFT for a fresh connection link.",
        );
      }
      if (marker.includes("identity") || marker.includes("team")) {
        throw new SlackCallbackError(
          "identity_mismatch",
          403,
          "LIFTY could not verify the installed Slack bot. Ask LIFT for a fresh connection link.",
        );
      }
      throw new SlackCallbackError(
        "exchange_failed",
        502,
        "Slack did not accept the authorization. Ask LIFT for a fresh connection link.",
      );
    }

    const response = await fetchImpl(
      `${settings.supabaseUrl}/rest/v1/rpc/complete_lifty_slack_connection`,
      {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
        headers: {
          apikey: settings.publishableKey,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          p_intent_token: intentToken,
          p_team_id: grant.teamId,
          p_team_name: grant.teamName,
          p_enterprise_id: grant.enterpriseId,
          p_bot_user_id: grant.botUserId,
          p_scopes: grant.scopes,
          p_bot_token: grant.accessToken,
        }),
      },
    );
    if (!response.ok) {
      let message = "";
      try {
        const payload = await response.json() as { message?: unknown };
        message = typeof payload.message === "string" ? payload.message : "";
      } catch {
        message = "";
      }
      for (const [marker, reason, status, safeMessage] of COMPLETION_FAILURES) {
        if (message.includes(marker)) {
          throw new SlackCallbackError(reason, status, safeMessage);
        }
      }
      throw new SlackCallbackError(
        "store_failed",
        502,
        "LIFTY could not record the Slack connection. Ask LIFT for a fresh connection link.",
      );
    }

    return { teamId: grant.teamId, teamName: grant.teamName };
  }

  async function failCallback(state: string, status: "denied" | "failed", code: string) {
    const intentToken = openSlackConnectIntent(state, settings.clientSecret);
    await recordOAuthFailure({ provider: "slack", intentToken, status, code,
      supabaseUrl: settings.supabaseUrl, publishableKey: settings.publishableKey, fetchImpl });
  }
  return { startConnect, createConnectLink, getConnection,
    denyCallback: state => failCallback(state, "denied", "authorization_denied"),
    completeCallback: async input => {
      try { return await completeCallback(input); }
      catch (error) {
        if (error instanceof SlackCallbackError && error.status < 500 && !["link_invalid", "link_used", "link_expired", "link_revoked"].includes(error.reason)) {
          try { await failCallback(input.state, "failed", error.reason === "exchange_failed" ? "token_exchange_failed" : CONNECTION_REFUSAL_CODES[error.reason] ?? "callback_failed"); }
          catch { /* Preserve the original safe failure; reads remain unverified if persistence failed. */ }
        }
        throw error;
      }
    },
  };
}
