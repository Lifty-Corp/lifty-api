import { connectionFetch } from "./connection-confirmation.js";
import type { AuthSession } from "./app.js";
import {
  AttioConnectStartSchema,
  AttioConnectionStatusSchema,
  type AttioConnectStart,
  type AttioConnectionStatus,
} from "./contracts.js";
import { PublicError } from "./errors.js";
import { CRM_REFUSAL_CODES, recordOAuthFailure } from "./connection-attempt.js";
import {
  exchangeAttioAuthorizationCode,
  identifyAttioToken,
  missingAttioScopes,
} from "./attio-oauth.js";
import { openAttioConnectIntent, sealAttioConnectIntent } from "./attio-state.js";

export interface AttioConnectSettings {
  clientId: string;
  clientSecret: string;
  publicBaseUrl: string;
  supabaseUrl: string;
  publishableKey: string;
  fetchImpl?: typeof fetch;
}

export interface AttioCallbackSuccess {
  workspaceId: string;
  workspaceSlug: string;
}

interface RpcClient {
  rpc<T>(name: string, args?: Record<string, unknown>): Promise<{ data: T; error: unknown }>;
}

function mapConnectRpcError(error: unknown): PublicError {
  const candidate = error as { code?: unknown; message?: unknown };
  const code = typeof candidate?.code === "string" ? candidate.code : "";
  const message = typeof candidate?.message === "string" ? candidate.message : "";
  if (code === "PT401") {
    return new PublicError({ status: 401, code: "UNAUTHORIZED", message: "A valid LIFTY session is required.", cause: error });
  }
  if (code === "PT409" && message.includes("lifty_crm_provider_conflict")) {
    return new PublicError({ status: 409, code: "CRM_PROVIDER_CONFLICT",
      message: "HubSpot is this workspace's connected CRM. Disconnect HubSpot before connecting Attio.", cause: error });
  }
  if (code === "PT409" && message.includes("lifty_workspace_missing")) {
    return new PublicError({ status: 409, code: "WORKSPACE_NOT_READY", message: "Provision a LIFTY workspace before connecting Attio.", cause: error });
  }
  if (code === "PT409" && message.includes("lifty_workspace_suspended")) {
    return new PublicError({ status: 409, code: "WORKSPACE_SUSPENDED",
      message: "This LIFTY workspace is suspended; contact LIFT before connecting providers.", cause: error });
  }
  return new PublicError({ status: 502, code: "SUPABASE_REQUEST_FAILED", message: "LIFTY could not complete the connection request.", cause: error });
}

// Callback failures carry a safe reason; the shared confirmation page shows the outcome.
export class AttioCallbackError extends Error {
  constructor(readonly reason: string, readonly status: number) {
    super(reason);
    this.name = "AttioCallbackError";
  }
}

const COMPLETION_FAILURES: ReadonlyArray<[string, string, number]> = [
  ["lifty_connect_intent_invalid", "link_invalid", 403],
  ["lifty_connect_intent_replayed", "link_used", 409],
  ["lifty_connect_intent_expired", "link_expired", 410],
  ["lifty_attio_workspace_already_connected", "workspace_taken", 409],
  ["lifty_crm_provider_conflict", "crm_provider_conflict", 409],
  ["lifty_attio_scopes_invalid", "scope_mismatch", 403],
  ["lifty_crm_account_mismatch", "account_mismatch", 409],
];

/** Secret-free status; readable even when LIFT's Attio app is not configured. */
export async function getAttioConnection(session: AuthSession): Promise<AttioConnectionStatus> {
  const { data, error } = await (session.client as RpcClient).rpc<unknown>("get_lifty_attio_connection",
    ...(session.workspaceRef ? [{ p_workspace_id: session.workspaceRef }] : []));
  if (error) throw mapConnectRpcError(error);
  const parsed = AttioConnectionStatusSchema.safeParse(data);
  if (!parsed.success) {
    throw new PublicError({ status: 502, code: "SUPABASE_INVALID_RESPONSE", message: "LIFTY received an invalid connection status.", cause: parsed.error });
  }
  return parsed.data;
}

export interface AttioConnectOperations {
  startConnect(session: AuthSession): Promise<AttioConnectStart>;
  getConnection(session: AuthSession): Promise<AttioConnectionStatus>;
  completeCallback(input: { code: string; state: string }): Promise<AttioCallbackSuccess>;
}

export function createAttioConnectOperations(settings: AttioConnectSettings): AttioConnectOperations {
  const fetchImpl = connectionFetch(settings.fetchImpl ?? fetch);
  const publicBaseUrl = settings.publicBaseUrl.replace(/\/$/, "");
  const redirectUri = `${publicBaseUrl}/attio/callback`;

  async function startConnect(session: AuthSession): Promise<AttioConnectStart> {
    const { data, error } = await (session.client as RpcClient).rpc<Record<string, unknown>>("create_lifty_attio_connect_intent");
    if (error) throw mapConnectRpcError(error);
    const token = typeof data?.intent_token === "string" ? data.intent_token : "";
    const expiresIn = Number(data?.expires_in_seconds);
    if (!/^[0-9a-f]{64}$/.test(token) || !Number.isInteger(expiresIn) || expiresIn <= 0) {
      throw new PublicError({ status: 502, code: "SUPABASE_INVALID_RESPONSE", message: "LIFTY received an invalid connection response." });
    }
    return AttioConnectStartSchema.parse({
      provider: "attio",
      connect_url: `${publicBaseUrl}/attio/start?intent=${encodeURIComponent(sealAttioConnectIntent(token, settings.clientSecret))}`,
      expires_in_seconds: expiresIn,
      ...(data.attempt_ref !== undefined ? { attempt_ref: data.attempt_ref, expires_at: data.expires_at } : {}),
    });
  }

  async function completeCallback(input: { code: string; state: string }): Promise<AttioCallbackSuccess> {
    let intentToken: string;
    try { intentToken = openAttioConnectIntent(input.state, settings.clientSecret); }
    catch { throw new AttioCallbackError("link_invalid", 403); }
    let accessToken: string;
    try {
      accessToken = await exchangeAttioAuthorizationCode({ clientId: settings.clientId, clientSecret: settings.clientSecret,
        redirectUri, code: input.code, fetchImpl });
    } catch { throw new AttioCallbackError("exchange_failed", 502); }
    let identity;
    try { identity = await identifyAttioToken({ accessToken, fetchImpl }); }
    catch { throw new AttioCallbackError("account_lookup_failed", 502); }
    // The code was exchanged with LIFT's own client secret, so the token is
    // LIFT's grant; /v2/self names the app by an app ID, not the OAuth client ID.
    if (missingAttioScopes(identity.scopes).length) throw new AttioCallbackError("scope_mismatch", 403);

    const response = await fetchImpl(`${settings.supabaseUrl}/rest/v1/rpc/complete_lifty_attio_connection`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { apikey: settings.publishableKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        p_intent_token: intentToken,
        p_attio_workspace_id: identity.workspaceId,
        p_workspace_slug: identity.workspaceSlug,
        p_workspace_name: identity.workspaceName,
        p_scopes: identity.scopes,
        p_access_token: accessToken,
      }),
    });
    if (!response.ok) {
      let message = "";
      try {
        const payload = (await response.json()) as { message?: unknown };
        message = typeof payload?.message === "string" ? payload.message : "";
      } catch { message = ""; }
      for (const [marker, reason, status] of COMPLETION_FAILURES) {
        if (message.includes(marker)) throw new AttioCallbackError(reason, status);
      }
      throw new AttioCallbackError("store_failed", 502);
    }
    return { workspaceId: identity.workspaceId, workspaceSlug: identity.workspaceSlug };
  }

  return {
    startConnect,
    getConnection: getAttioConnection,
    completeCallback: async input => {
      try { return await completeCallback(input); }
      catch (error) {
        // A known refusal ends this attempt; 5xx stays uncertain for the receipt.
        if (error instanceof AttioCallbackError && error.status < 500 && !["link_invalid", "link_used", "link_expired"].includes(error.reason)) {
          try {
            await recordOAuthFailure({ provider: "attio", intentToken: openAttioConnectIntent(input.state, settings.clientSecret),
              status: "failed", code: CRM_REFUSAL_CODES[error.reason] ?? "callback_failed",
              supabaseUrl: settings.supabaseUrl, publishableKey: settings.publishableKey, fetchImpl });
          } catch { /* Preserve the original safe failure; reads remain unverified if persistence failed. */ }
        }
        throw error;
      }
    },
  };
}
