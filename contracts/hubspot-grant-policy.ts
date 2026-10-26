/**
 * Canonical HubSpot grant policy. Edit this workspace source, then run
 * scripts/sync-hubspot-grant-policy.mjs. Consumers vendor identical bytes;
 * no runtime imports, environment access, storage authority or logging here.
 */
const TOKEN_ENDPOINT = "https://api.hubapi.com/oauth/2026-03/token";
const ACCOUNT_DETAILS_ENDPOINT =
  "https://api.hubapi.com/account-info/2026-03/details";
export const REFRESH_BEFORE_EXPIRY_SECONDS = 300;

export const HUBSPOT_OAUTH_SCOPES: readonly string[] = Object.freeze([
  "crm.objects.companies.read",
  "crm.objects.companies.write",
  "crm.objects.contacts.read",
  "crm.objects.contacts.write",
  "crm.objects.deals.read",
  "crm.objects.deals.write",
  "crm.schemas.companies.read",
  "crm.schemas.companies.write",
  "crm.schemas.contacts.read",
  "crm.schemas.contacts.write",
  "oauth",
]);

export const HUBSPOT_LEGACY_OAUTH_SCOPES: readonly string[] = Object.freeze([
  "crm.objects.companies.read",
  "crm.objects.companies.write",
  "crm.objects.contacts.read",
  "crm.objects.contacts.write",
  "crm.schemas.companies.read",
  "crm.schemas.contacts.read",
  "oauth",
]);

export interface OAuthGrant {
  access_token: string;
  client_id: string;
  client_secret: string;
  refresh_token: string;
  expires_at_epoch: number;
  obtained_at_epoch: number;
  portal_id: string;
  scopes: string[];
}

export type HubSpotGrantErrorReason =
  | "grant_invalid"
  | "refresh_failed"
  | "rotation_failed";
export type HubSpotGrantResult =
  | { ok: true; token: string | null }
  | { ok: false; error: HubSpotGrantErrorReason };

export interface HubSpotGrantBinding {
  workspaceId: string;
  requestId: string;
  portalId: string;
}

/** These callbacks retain runtime-specific authorization, audit and CAS checks. */
export interface HubSpotGrantStorage {
  rotateGrant(
    input: HubSpotGrantBinding & {
      previousGrant: OAuthGrant;
      grant: OAuthGrant;
    },
  ): Promise<boolean>;
  markReconnectRequired(input: HubSpotGrantBinding): Promise<void>;
}

export interface ResolveHubSpotGrantOptions {
  workspaceId: string;
  requestId: string;
  /** Only the authorized storage adapter may supply the persisted value. */
  secret: string | null;
  /** Required for new callers with independently resolved integration state. */
  expectedPortalId?: string | undefined;
  nowEpochSeconds: number;
  fetcher: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isBearerToken(value: unknown): value is string {
  // Reject serialized bundles, whitespace and header injection. This is the
  // bearer-token alphabet, not a restriction to one HubSpot token prefix.
  return typeof value === "string" && /^[A-Za-z0-9._~+/-]+=*$/.test(value);
}

function isPortalId(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,20}$/.test(value);
}

function scopeSetMatches(
  value: unknown,
  expected: readonly string[],
): value is string[] {
  if (!Array.isArray(value) || !value.every(isNonEmptyString)) return false;
  const actual = [...new Set(value)].sort();
  const wanted = [...new Set(expected)].sort();
  return actual.length === wanted.length &&
    actual.every((scope, index) => scope === wanted[index]);
}

export function parsePersistedGrant(secret: string):
  | { kind: "legacy"; token: string }
  | { kind: "oauth"; grant: OAuthGrant }
  | { kind: "invalid" } {
  if (!secret.trimStart().startsWith("{")) {
    return isBearerToken(secret)
      ? { kind: "legacy", token: secret }
      : { kind: "invalid" };
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(secret);
  } catch {
    return { kind: "invalid" };
  }
  if (!isRecord(candidate)) return { kind: "invalid" };
  const expectedKeys = [
    "access_token",
    "client_id",
    "client_secret",
    "expires_at_epoch",
    "obtained_at_epoch",
    "portal_id",
    "refresh_token",
    "scopes",
  ];
  if (
    Object.keys(candidate).sort().join("\u0000") !==
      expectedKeys.join("\u0000") ||
    !isBearerToken(candidate.access_token) ||
    !isNonEmptyString(candidate.client_id) ||
    !isNonEmptyString(candidate.client_secret) ||
    !isNonEmptyString(candidate.refresh_token) ||
    !isPortalId(candidate.portal_id) ||
    !Number.isSafeInteger(candidate.expires_at_epoch) ||
    !Number.isSafeInteger(candidate.obtained_at_epoch) ||
    (candidate.obtained_at_epoch as number) < 0 ||
    (candidate.expires_at_epoch as number) <=
      (candidate.obtained_at_epoch as number) ||
    !(scopeSetMatches(candidate.scopes, HUBSPOT_OAUTH_SCOPES) ||
      scopeSetMatches(candidate.scopes, HUBSPOT_LEGACY_OAUTH_SCOPES))
  ) return { kind: "invalid" };
  return {
    kind: "oauth",
    grant: {
      ...(candidate as unknown as OAuthGrant),
      scopes: [...new Set(candidate.scopes as string[])].sort(),
    },
  };
}

function normalizeScopes(payload: Record<string, unknown>): string[] {
  const raw = payload.scopes ?? payload.scope;
  const entries = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
    ? raw.split(/[ ,]+/)
    : [];
  if (!entries.every((entry): entry is string => typeof entry === "string")) {
    return [];
  }
  return [...new Set(entries.filter(Boolean))].sort();
}

function normalizePortalId(payload: Record<string, unknown>): string | null {
  const value = payload.portalId ?? payload.hubId ?? payload.hub_id;
  if (
    typeof value !== "string" &&
    !(typeof value === "number" && Number.isSafeInteger(value))
  ) return null;
  const normalized = String(value);
  return isPortalId(normalized) ? normalized : null;
}

async function fetchRecord(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetcher(url, init);
    if (!response.ok) {
      // Consume and discard the provider body without exposing it in errors.
      await response.text();
      return null;
    }
    const payload: unknown = await response.json();
    return isRecord(payload) ? payload : null;
  } catch {
    return null;
  }
}

async function portalMatches(
  options: ResolveHubSpotGrantOptions,
  token: string,
  portalId: string,
): Promise<boolean> {
  const account = await fetchRecord(options.fetcher, ACCOUNT_DETAILS_ENDPOINT, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  return account !== null && normalizePortalId(account) === portalId;
}

/**
 * Return a usable token only after grant validation and any required refresh,
 * portal verification and successful persistence. Storage must bind the secret
 * to workspaceId; callers with an expected portal must supply that binding.
 * Existing legacy callers without a portal retain their pass-through behavior.
 */
export async function resolveHubSpotGrant(
  options: ResolveHubSpotGrantOptions,
  storage: HubSpotGrantStorage,
): Promise<HubSpotGrantResult> {
  if (options.secret === null) return { ok: true, token: null };
  if (
    !Number.isSafeInteger(options.nowEpochSeconds) ||
    options.nowEpochSeconds < 0 ||
    (options.expectedPortalId !== undefined &&
      !isPortalId(options.expectedPortalId))
  ) {
    return { ok: false, error: "grant_invalid" };
  }
  const parsed = parsePersistedGrant(options.secret);
  if (parsed.kind === "invalid") return { ok: false, error: "grant_invalid" };
  if (parsed.kind === "legacy") {
    if (
      options.expectedPortalId !== undefined &&
      !await portalMatches(options, parsed.token, options.expectedPortalId)
    ) {
      return { ok: false, error: "grant_invalid" };
    }
    return { ok: true, token: parsed.token };
  }
  const grant = parsed.grant;
  if (
    options.expectedPortalId !== undefined &&
    grant.portal_id !== options.expectedPortalId
  ) {
    return { ok: false, error: "grant_invalid" };
  }
  if (
    grant.expires_at_epoch >
      options.nowEpochSeconds + REFRESH_BEFORE_EXPIRY_SECONDS
  ) {
    return { ok: true, token: grant.access_token };
  }

  const binding = {
    workspaceId: options.workspaceId,
    requestId: options.requestId,
    portalId: grant.portal_id,
  };
  const refreshFailed = async (): Promise<HubSpotGrantResult> => {
    try {
      await storage.markReconnectRequired(binding);
    } catch { /* Preserve the safe failure result. */ }
    return { ok: false, error: "refresh_failed" };
  };
  const payload = await fetchRecord(options.fetcher, TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: grant.client_id,
      client_secret: grant.client_secret,
      refresh_token: grant.refresh_token,
    }).toString(),
  });
  if (!payload) return refreshFailed();
  const scopes = normalizeScopes(payload);
  const portalId = normalizePortalId(payload);
  const hasPortalId = ["portalId", "hubId", "hub_id"].some((key) =>
    payload[key] !== undefined
  );
  if (
    !isBearerToken(payload.access_token) ||
    !isNonEmptyString(payload.refresh_token) ||
    !Number.isSafeInteger(payload.expires_in) ||
    (payload.expires_in as number) <= 0 ||
    !Number.isSafeInteger(
      options.nowEpochSeconds + (payload.expires_in as number),
    ) ||
    !scopeSetMatches(scopes, grant.scopes) ||
    (hasPortalId && portalId !== grant.portal_id)
  ) {
    return refreshFailed();
  }
  if (!await portalMatches(options, payload.access_token, grant.portal_id)) {
    return refreshFailed();
  }
  const nextGrant: OAuthGrant = {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    client_id: grant.client_id,
    client_secret: grant.client_secret,
    obtained_at_epoch: options.nowEpochSeconds,
    expires_at_epoch: options.nowEpochSeconds + (payload.expires_in as number),
    portal_id: grant.portal_id,
    scopes,
  };
  try {
    if (
      !await storage.rotateGrant({
        ...binding,
        previousGrant: grant,
        grant: nextGrant,
      })
    ) {
      return { ok: false, error: "rotation_failed" };
    }
  } catch {
    return { ok: false, error: "rotation_failed" };
  }
  return { ok: true, token: nextGrant.access_token };
}
