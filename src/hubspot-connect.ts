import { connectionFetch } from "./connection-confirmation.js";
import type { AuthSession } from "./app.js";
import {
  HubspotConnectStartSchema,
  HubspotConnectionStatusSchema,
  type HubspotConnectStart,
  type HubspotConnectionStatus,
} from "./contracts.js";
import { PublicError } from "./errors.js";
import { CRM_REFUSAL_CODES, recordOAuthFailure } from "./connection-attempt.js";
import {
  HUBSPOT_REQUIRED_SCOPES,
  exchangeAuthorizationCode,
  getAccountDetails,
  refreshAccessToken,
  scopeSetMatchesExactly,
} from "./hubspot-oauth.js";
import {
  openHubspotConnectIntent,
  sealHubspotConnectIntent,
} from "./hubspot-state.js";

export interface HubspotConnectSettings {
  clientId: string;
  clientSecret: string;
  publicBaseUrl: string;
  supabaseUrl: string;
  publishableKey: string;
  fetchImpl?: typeof fetch;
}

export interface HubspotCallbackSuccess {
  portalId: string;
  hubDomain: string | null;
}

interface RpcClient {
  rpc<T>(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<{ data: T; error: unknown }>;
}

function getRpcClient(session: AuthSession): RpcClient {
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
  if (code === "PT409" && message.includes("lifty_crm_provider_conflict")) {
    return new PublicError({
      status: 409,
      code: "CRM_PROVIDER_CONFLICT",
      message: "Attio is this workspace's connected CRM. Disconnect Attio before connecting HubSpot.",
      cause: error,
    });
  }
  if (code === "PT409" && message.includes("lifty_workspace_missing")) {
    return new PublicError({
      status: 409,
      code: "WORKSPACE_NOT_READY",
      message: "Provision a LIFTY workspace before connecting HubSpot.",
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

// Callback failures render as safe HTML; `reason` doubles as the log code.
export class HubspotCallbackError extends Error {
  readonly reason: string;
  readonly status: number;
  readonly safeMessage: string;

  constructor(reason: string, status: number, safeMessage: string) {
    super(reason);
    this.name = "HubspotCallbackError";
    this.reason = reason;
    this.status = status;
    this.safeMessage = safeMessage;
  }
}

const COMPLETION_FAILURES: ReadonlyArray<[string, string, number, string]> = [
  ["lifty_connect_intent_invalid", "link_invalid", 403,
    "This connection link is not valid. Ask Lifty for a new HubSpot connection link."],
  ["lifty_connect_intent_replayed", "link_used", 409,
    "This connection link was already used. Ask Lifty for a new HubSpot connection link."],
  ["lifty_connect_intent_expired", "link_expired", 410,
    "This connection link expired. Ask Lifty for a new HubSpot connection link."],
  ["lifty_portal_already_connected", "portal_taken", 409,
    "That HubSpot account is already connected to another LIFTY workspace."],
  ["lifty_crm_account_mismatch", "account_mismatch", 409,
    "That is a different HubSpot account from the one connected to this workspace. Sign in to the same account."],
  ["lifty_crm_provider_conflict", "crm_provider_conflict", 409,
    "Another CRM is connected to this workspace. Disconnect it in Lifty before connecting HubSpot."],
];

export interface HubspotConnectOperations {
  startConnect(session: AuthSession): Promise<HubspotConnectStart>;
  getConnection(session: AuthSession): Promise<HubspotConnectionStatus>;
  completeCallback(input: { code: string; state: string }): Promise<HubspotCallbackSuccess>;
  denyCallback(state: string): Promise<void>;
}

export function createHubspotConnectOperations(
  settings: HubspotConnectSettings,
): HubspotConnectOperations {
  const fetchImpl = connectionFetch(settings.fetchImpl ?? fetch);
  const publicBaseUrl = settings.publicBaseUrl.replace(/\/$/, "");
  const redirectUri = `${publicBaseUrl}/hubspot/callback`;

  async function startConnect(session: AuthSession): Promise<HubspotConnectStart> {
    const { data, error } = await getRpcClient(session).rpc<Record<string, unknown>>(
      "create_lifty_hubspot_connect_intent",
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

    const state = sealHubspotConnectIntent(token, settings.clientSecret);
    return HubspotConnectStartSchema.parse({
      provider: "hubspot",
      connect_url: `${publicBaseUrl}/hubspot/start?intent=${encodeURIComponent(state)}`,
      expires_in_seconds: expiresIn,
      ...(data.attempt_ref !== undefined ? { attempt_ref: data.attempt_ref, expires_at: data.expires_at } : {}),
    });
  }

  async function getConnection(session: AuthSession): Promise<HubspotConnectionStatus> {
    const { data, error } = await getRpcClient(session).rpc<unknown>(
      "get_lifty_hubspot_connection",
      ...(session.workspaceRef ? [{ p_workspace_id: session.workspaceRef }] : []),
    );
    if (error) throw mapConnectRpcError(error);

    const parsed = HubspotConnectionStatusSchema.safeParse(data);
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
  ): Promise<HubspotCallbackSuccess> {
    let intentToken: string;
    try {
      intentToken = openHubspotConnectIntent(input.state, settings.clientSecret);
    } catch {
      throw new HubspotCallbackError("link_invalid", 403,
        "This connection link is not valid. Ask Lifty for a new HubSpot connection link.");
    }
    let grant;
    try {
      grant = await exchangeAuthorizationCode({
        clientId: settings.clientId,
        clientSecret: settings.clientSecret,
        redirectUri,
        code: input.code,
        fetchImpl,
      });
    } catch {
      throw new HubspotCallbackError("exchange_failed", 502,
        "HubSpot did not accept the authorization. Ask Lifty for a new HubSpot connection link.");
    }

    if (!scopeSetMatchesExactly(grant.scopes)) {
      throw new HubspotCallbackError("scope_mismatch", 403,
        "The authorization did not grant every permission LIFTY needs. "
        + "Approve all requested permissions and try again.");
    }

    let account;
    try {
      account = await getAccountDetails({ accessToken: grant.accessToken, fetchImpl });
    } catch {
      throw new HubspotCallbackError("account_lookup_failed", 502,
        "LIFTY could not verify the HubSpot account. Ask Lifty for a new HubSpot connection link.");
    }
    if (grant.hubId !== null && grant.hubId !== account.portalId) {
      throw new HubspotCallbackError("portal_mismatch", 409,
        "The HubSpot account could not be verified. Ask Lifty for a new HubSpot connection link.");
    }

    let refreshedGrant;
    try {
      refreshedGrant = await refreshAccessToken({
        clientId: settings.clientId,
        clientSecret: settings.clientSecret,
        refreshToken: grant.refreshToken,
        fetchImpl,
      });
    } catch {
      throw new HubspotCallbackError("refresh_failed", 502,
        "LIFTY could not verify that the HubSpot connection is refreshable. "
        + "Ask Lifty for a new HubSpot connection link.");
    }
    if (!scopeSetMatchesExactly(refreshedGrant.scopes)) {
      throw new HubspotCallbackError("scope_mismatch", 403,
        "The refreshed authorization did not preserve every permission LIFTY needs. "
        + "Ask Lifty for a new HubSpot connection link.");
    }
    if (refreshedGrant.hubId !== null && refreshedGrant.hubId !== account.portalId) {
      throw new HubspotCallbackError("portal_mismatch", 409,
        "The refreshed HubSpot account could not be verified. "
        + "Ask Lifty for a new HubSpot connection link.");
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const hubDomain = refreshedGrant.hubDomain ?? grant.hubDomain;
    const scopes = [...refreshedGrant.scopes].sort();
    const response = await fetchImpl(
      `${settings.supabaseUrl}/rest/v1/rpc/complete_lifty_hubspot_connection`,
      {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
        headers: {
          apikey: settings.publishableKey,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          p_intent_token: intentToken,
          p_portal_id: account.portalId,
          p_hub_domain: hubDomain,
          p_scopes: scopes,
          p_token_bundle: {
            access_token: refreshedGrant.accessToken,
            client_id: settings.clientId,
            client_secret: settings.clientSecret,
            refresh_token: refreshedGrant.refreshToken,
            expires_at_epoch: refreshedGrant.expiresInSeconds === null
              ? null
              : nowSeconds + refreshedGrant.expiresInSeconds,
            obtained_at_epoch: nowSeconds,
            portal_id: account.portalId,
            scopes,
          },
        }),
      },
    );

    if (!response.ok) {
      let message = "";
      try {
        const payload = (await response.json()) as { message?: unknown };
        message = typeof payload?.message === "string" ? payload.message : "";
      } catch {
        message = "";
      }
      for (const [marker, reason, status, safeMessage] of COMPLETION_FAILURES) {
        if (message.includes(marker)) {
          throw new HubspotCallbackError(reason, status, safeMessage);
        }
      }
      throw new HubspotCallbackError("store_failed", 502,
        "LIFTY could not record the connection. Ask Lifty for a new HubSpot connection link.");
    }

    return { portalId: account.portalId, hubDomain };
  }

  async function failCallback(state: string, status: "denied" | "failed", code: string) {
    // Decryption authenticates the domain-separated callback state before the
    // private intent token is used to update the exact durable intent.
    const intentToken = openHubspotConnectIntent(state, settings.clientSecret);
    await recordOAuthFailure({ provider: "hubspot", intentToken, status, code,
      supabaseUrl: settings.supabaseUrl, publishableKey: settings.publishableKey, fetchImpl });
  }
  return { startConnect, getConnection,
    denyCallback: state => failCallback(state, "denied", "authorization_denied"),
    completeCallback: async input => {
      try { return await completeCallback(input); }
      catch (error) {
        if (error instanceof HubspotCallbackError && error.status < 500 && !["link_invalid", "link_used", "link_expired"].includes(error.reason)) {
          try { await failCallback(input.state, "failed", CRM_REFUSAL_CODES[error.reason] ?? "callback_failed"); }
          catch { /* Preserve the original safe failure; reads remain unverified if persistence failed. */ }
        }
        throw error;
      }
    },
  };
}

export { HUBSPOT_REQUIRED_SCOPES };
