import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AuthSession } from "../app.js";
import { parsePersistedGrant, resolveHubSpotGrant } from "../generated/hubspot-grant-policy.js";
import {
  MappingError,
  type State,
  type CrmMappingOptions,
} from "./contracts.js";
const PROVIDER_REQUEST_TIMEOUT_MS = 15_000;
const ATTIO_API = "https://api.attio.com/v2";
// HubSpot reports a private-app token's current scopes here (the OAuth token
// metadata endpoints refuse pat- tokens). Scopes change when the app is edited
// while the token string stays the same, so a lookup is reused only briefly.
const HUBSPOT_PRIVATE_APP_INFO = "https://api.hubapi.com/oauth/v2/private-apps/get/access-token-info";
const PRIVATE_APP_SCOPES_TTL_MS = 5 * 60_000;
export interface CrmMappingSettings {
  serverKey: string;
  readOnly?: boolean;
  fetch?: typeof fetch;
  operationTimeoutMs?: number;
  enqueue?: (runRef: string, workspaceRef: string) => Promise<void>;
}
export const scoped = (state: State) => ({
  workspace_ref: state.workspace_ref,
  integration_ref: state.integration_ref,
  portal_id: state.portal_id,
});
/** How Lifty holds the account and the scopes the provider reports for it (null: unreadable). */
export interface CrmAccess {
  credential: "oauth" | "private_app";
  scopes: string[] | null;
}
type ScopeCache = Map<string, { scopes: string[]; expiresAt: number }>;
const privateAppScopes = new WeakMap<CrmMappingSettings, ScopeCache>();
export interface MappingSession {
  /** The credential kind and its provider-reported scopes, verified like every provider call. */
  access: (state: State) => Promise<CrmAccess>;
  rpc: (
    operation: string,
    payload?: Record<string, unknown>,
  ) => Promise<unknown>;
  call: (
    state: State,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ) => Promise<unknown>;
}
const Credential = z.object({
  secret: z.string().min(1),
  credential_version: z.string().regex(/^[a-f0-9]{64}$/),
  workspace_ref: z.uuid(),
  integration_ref: z.uuid(),
  portal_id: z.string(),
});
const RpcResult = z.object({
  data: z.unknown(),
  error: z.unknown().nullable(),
});
const RpcError = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
});

function storageError(error: unknown): MappingError {
  const value = RpcError.safeParse(error);
  const names: Record<string, string> = {
    unauthenticated: "UNAUTHORIZED",
    lifty_crm_service_forbidden: "CRM_MAPPING_NOT_CONFIGURED",
    lifty_workspace_ambiguous: "WORKSPACE_SELECTION_REQUIRED",
    lifty_workspace_missing: "WORKSPACE_NOT_READY",
    lifty_workspace_suspended: "WORKSPACE_SUSPENDED",
    lifty_company_mapping_unsupported: "WORKSPACE_UNSUPPORTED",
    lifty_hubspot_reconnect_required: "HUBSPOT_RECONNECT_REQUIRED",
    lifty_hubspot_connection_unavailable: "HUBSPOT_NOT_CONNECTED",
    lifty_attio_reconnect_required: "ATTIO_RECONNECT_REQUIRED",
    lifty_attio_connection_unavailable: "ATTIO_NOT_CONNECTED",
    lifty_company_mapping_forbidden: "FORBIDDEN_WORKSPACE",
    lifty_company_mapping_stale: "STALE_CONTEXT",
    lifty_crm_credential_stale: "STALE_CONTEXT",
    lifty_company_mapping_conflict: "MAPPING_CONFLICT",
    lifty_crm_mapping_stale: "STALE_CONTEXT",
    lifty_crm_mapping_conflict: "MAPPING_CONFLICT",
    lifty_crm_mapping_forbidden: "FORBIDDEN_WORKSPACE",
    lifty_crm_mapping_invalid: "INVALID_MAPPING_REQUEST",
    lifty_crm_request_invalid: "INVALID_MAPPING_REQUEST",
    lifty_crm_actor_forbidden: "FORBIDDEN_WORKSPACE",
    lifty_crm_lead_selection_invalid: "INVALID_LEAD_SELECTION",
    lifty_crm_mapping_plan_invalid: "INVALID_REPLAY_PLAN",
    lifty_crm_mapping_request_conflict: "MAPPING_REQUEST_CONFLICT",
    lifty_crm_mapping_run_not_found: "MAPPING_RUN_NOT_FOUND",
  };
  const code = value.success ? names[value.data.message ?? ""] : undefined;
  if (!code) return new MappingError("MAPPING_STORAGE_FAILED", 502);
  const status =
    code === "UNAUTHORIZED"
      ? 401
      : code === "FORBIDDEN_WORKSPACE"
        ? 403
        : code === "CRM_MAPPING_NOT_CONFIGURED"
          ? 503
          : code === "MAPPING_RUN_NOT_FOUND"
            ? 404
            : code.startsWith("INVALID_")
              ? 422
              : 409;
  return new MappingError(code, status);
}

export async function withMappingSession<T>(
  session: AuthSession,
  settings: CrmMappingSettings,
  options: CrmMappingOptions,
  work: (tools: MappingSession) => Promise<T>,
): Promise<T> {
  const workspaceRef = options.workspaceRef;
  const requestId = randomUUID();
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const timeoutMs = settings.operationTimeoutMs ?? 55_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const fetcher = settings.fetch ?? fetch;
  const client = session.client;
  if (
    !client ||
    typeof client !== "object" ||
    !("rpc" in client) ||
    typeof client.rpc !== "function"
  ) {
    clearTimeout(timer);
    throw new MappingError("MAPPING_STORAGE_FAILED", 502);
  }
  const rpcMethod = client.rpc;
  const checkActive = () => {
    if (signal.aborted) throw new MappingError("CRM_MAPPING_TIMEOUT", 504);
  };
  async function rpc(operation: string, payload: Record<string, unknown> = {}) {
    checkActive();
    let request: unknown = rpcMethod.call(
      client,
      ["credential", "rotate", "reconnect"].includes(operation)
        ? "lifty_crm_company_tools"
        : "lifty_crm_mapping_tools",
      {
        p_server_key: settings.serverKey,
        p_operation: operation,
        p_payload: {
          ...(workspaceRef ? { workspace_ref: workspaceRef } : {}),
          request_id: requestId,
          ...payload,
        },
      },
    );
    if (
      request &&
      typeof request === "object" &&
      "abortSignal" in request &&
      typeof request.abortSignal === "function"
    )
      request = request.abortSignal(signal);
    const result = RpcResult.safeParse(await request);
    checkActive();
    if (!result.success) throw new MappingError("INVALID_STATE", 502);
    if (result.data.error) throw storageError(result.data.error);
    return result.data.data;
  }
  const tokens = new Map<string, string>();
  const grants = new Map<string, { credential: CrmAccess["credential"]; scopes: string[] | null; version: string }>();
  const providerFetch: typeof fetch = async (url, init) => {
    checkActive();
    const result = await fetcher(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
      ]),
    });
    checkActive();
    return result;
  };
  async function tokenFor(state: State): Promise<string> {
    const cacheKey = `${state.integration_ref}:${state.portal_id}`;
    const cached = tokens.get(cacheKey);
    if (cached) return cached;
    const parsed = Credential.safeParse(await rpc("credential", scoped(state)));
    if (!parsed.success) throw new MappingError(state.provider === "attio" ? "ATTIO_NOT_CONNECTED" : "HUBSPOT_NOT_CONNECTED", 409);
    const credential = parsed.data;
    if (
      credential.workspace_ref !== state.workspace_ref ||
      credential.integration_ref !== state.integration_ref ||
      credential.portal_id !== state.portal_id
    )
      throw new MappingError("WORKSPACE_OR_PORTAL_CHANGED", 409);
    if (state.provider === "attio") {
      // Attio tokens never expire; an inactive or revoked one needs a reconnect.
      const response = await providerFetch(`${ATTIO_API}/self`, {
        headers: { authorization: `Bearer ${credential.secret}` },
      });
      const self = z
        .object({ active: z.boolean(), workspace_id: z.string().optional(), scope: z.string().optional() })
        .safeParse(await response.json().catch(() => null));
      if (response.status === 401 || (response.ok && self.success && !self.data.active)) {
        await rpc("reconnect", { ...scoped(state), credential_version: credential.credential_version });
        throw new MappingError("ATTIO_RECONNECT_REQUIRED", 409);
      }
      if (!response.ok || !self.success || self.data.workspace_id !== state.portal_id)
        throw new MappingError("WORKSPACE_OR_PORTAL_CHANGED", 409);
      // /v2/self reports the token's current scopes as one space-separated string.
      grants.set(cacheKey, { credential: "oauth", version: credential.credential_version,
        scopes: self.data.scope === undefined ? null : [...new Set(self.data.scope.split(/\s+/).filter(Boolean))].sort() });
      tokens.set(cacheKey, credential.secret);
      return credential.secret;
    }
    const resolved = await resolveHubSpotGrant(
      {
        workspaceId: state.workspace_ref,
        requestId,
        secret: credential.secret,
        expectedPortalId: state.portal_id,
        nowEpochSeconds: Math.floor(Date.now() / 1000),
        fetcher: providerFetch,
      },
      {
        rotateGrant: async ({ grant }) => {
          const result = await rpc("rotate", {
            ...scoped(state),
            credential_version: credential.credential_version,
            grant,
          });
          return z.object({ status: z.literal("rotated") }).safeParse(result)
            .success;
        },
        markReconnectRequired: async () => {
          await rpc("reconnect", {
            ...scoped(state),
            credential_version: credential.credential_version,
          });
        },
      },
    );
    checkActive();
    if (!resolved.ok || !resolved.token)
      throw new MappingError("HUBSPOT_RECONNECT_REQUIRED", 409);
    const response = await providerFetch(
      "https://api.hubapi.com/account-info/2026-03/details",
      { headers: { authorization: `Bearer ${resolved.token}` } },
    );
    const account = z
      .object({ portalId: z.union([z.string(), z.number()]) })
      .safeParse(await response.json().catch(() => null));
    if (
      !response.ok ||
      !account.success ||
      String(account.data.portalId) !== state.portal_id
    )
      throw new MappingError("WORKSPACE_OR_PORTAL_CHANGED", 409);
    // An OAuth grant carries the scopes HubSpot returned with its latest token,
    // checked again on every refresh; a bare token is a private app's.
    const stored = parsePersistedGrant(credential.secret);
    grants.set(cacheKey, stored.kind === "oauth"
      ? { credential: "oauth", scopes: stored.grant.scopes, version: credential.credential_version }
      : { credential: "private_app", scopes: null, version: credential.credential_version });
    tokens.set(cacheKey, resolved.token);
    return resolved.token;
  }
  async function access(state: State): Promise<CrmAccess> {
    const token = await tokenFor(state);
    const cacheKey = `${state.integration_ref}:${state.portal_id}`;
    const grant = grants.get(cacheKey)!;
    if (grant.credential === "oauth" || grant.scopes) return { credential: grant.credential, scopes: grant.scopes };
    let cache = privateAppScopes.get(settings);
    if (!cache) privateAppScopes.set(settings, cache = new Map());
    const key = `${cacheKey}:${grant.version}`, now = Date.now();
    for (const [entry, value] of cache) if (value.expiresAt <= now) cache.delete(entry);
    const cached = cache.get(key);
    if (cached) return { credential: "private_app", scopes: grant.scopes = cached.scopes };
    try {
      const response = await providerFetch(HUBSPOT_PRIVATE_APP_INFO, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ tokenKey: token }),
      });
      const info = z.object({ hubId: z.union([z.string(), z.number()]).optional(), scopes: z.array(z.string()) })
        .safeParse(response.ok ? await response.json().catch(() => null) : await response.text().then(() => null));
      // An unreadable or foreign answer leaves the scopes unknown, never assumed.
      if (!info.success || (info.data.hubId !== undefined && String(info.data.hubId) !== state.portal_id))
        return { credential: "private_app", scopes: null };
      grant.scopes = [...new Set(info.data.scopes)].sort();
      cache.set(key, { scopes: grant.scopes, expiresAt: now + PRIVATE_APP_SCOPES_TTL_MS });
      return { credential: "private_app", scopes: grant.scopes };
    } catch (error) {
      if (error instanceof MappingError) throw error;
      return { credential: "private_app", scopes: null };
    }
  }
  async function call(
    state: State,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ) {
    const token = await tokenFor(state);
    const attio = state.provider === "attio";
    const response = await providerFetch(`${attio ? ATTIO_API : "https://api.hubapi.com"}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const prefix = attio ? "ATTIO" : "HUBSPOT";
    if (response.status === 401)
      throw new MappingError(`${prefix}_RECONNECT_REQUIRED`, 409);
    if (response.status === 403)
      throw new MappingError(`${prefix}_PERMISSION_REQUIRED`, 409);
    if (response.status === 429)
      throw new MappingError(`${prefix}_RATE_LIMITED`, 429);
    if (!response.ok)
      throw new MappingError(
        response.status === 409
          ? `${prefix}_PROPERTY_CONFLICT`
          : `${prefix}_REQUEST_FAILED`,
        response.status === 409 ? 409 : 502,
      );
    return response.json().catch(() => null);
  }
  let onAbort: (() => void) | undefined;
  try {
    checkActive();
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new MappingError("CRM_MAPPING_TIMEOUT", 504));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    return await Promise.race([work({ access, rpc, call }), aborted]);
  } catch (error) {
    if (signal.aborted) throw new MappingError("CRM_MAPPING_TIMEOUT", 504);
    if (error instanceof MappingError) throw error;
    throw new MappingError("CRM_MAPPING_UNAVAILABLE", 502);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
