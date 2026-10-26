import { connectionFetch } from "./connection-confirmation.js";
// HubSpot OAuth mechanics for the hosted connect flow on the versioned
// 2026-03 endpoints. App configuration belongs to config/hubspot/;
// the LIFTY app (id 50910951) is the only client.

const AUTHORIZATION_ENDPOINT = "https://app.hubspot.com/oauth/authorize";
const TOKEN_ENDPOINT = "https://api.hubapi.com/oauth/2026-03/token";
const ACCOUNT_DETAILS_ENDPOINT =
  "https://api.hubapi.com/account-info/2026-03/details";

export const HUBSPOT_REQUIRED_SCOPES: readonly string[] = Object.freeze([
  "oauth",
  "crm.objects.contacts.read",
  "crm.objects.contacts.write",
  "crm.objects.companies.read",
  "crm.objects.companies.write",
  "crm.objects.deals.read",
  "crm.objects.deals.write",
  "crm.schemas.contacts.read",
  "crm.schemas.contacts.write",
  "crm.schemas.companies.read",
  "crm.schemas.companies.write",
]);

export interface HubspotTokenGrant {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number | null;
  scopes: string[];
  hubId: string | null;
  hubDomain: string | null;
}

export interface HubspotAccount {
  portalId: string;
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function normalizeScopes(payload: Record<string, unknown>): string[] {
  const raw = payload.scopes ?? payload.scope ?? [];
  const entries = Array.isArray(raw) ? raw : String(raw).split(/[ ,]+/);
  return entries.map(String).filter(Boolean).sort();
}

function normalizeHubId(payload: Record<string, unknown>): string | null {
  const candidate = payload.portalId ?? payload.hubId ?? payload.hub_id;
  return candidate === undefined || candidate === null ? null : String(candidate);
}

function parseTokenGrant(payload: Record<string, unknown>): HubspotTokenGrant {
  return {
    accessToken: requireNonEmptyString(payload.access_token, "HubSpot access_token"),
    refreshToken: requireNonEmptyString(payload.refresh_token, "HubSpot refresh_token"),
    expiresInSeconds: Number.isInteger(payload.expires_in)
      ? (payload.expires_in as number)
      : null,
    scopes: normalizeScopes(payload),
    hubId: normalizeHubId(payload),
    hubDomain: typeof payload.hub_domain === "string" && payload.hub_domain.length > 0
      ? payload.hub_domain
      : null,
  };
}

export function buildAuthorizationUrl(options: {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes?: readonly string[];
}): string {
  const scopes = options.scopes ?? HUBSPOT_REQUIRED_SCOPES;
  requireNonEmptyString(options.clientId, "clientId");
  requireNonEmptyString(options.redirectUri, "redirectUri");
  requireNonEmptyString(options.state, "state");

  const url = new URL(AUTHORIZATION_ENDPOINT);
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", options.state);
  return url.toString();
}

export async function exchangeAuthorizationCode(options: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  fetchImpl?: typeof fetch;
}): Promise<HubspotTokenGrant> {
  const fetchImpl = connectionFetch(options.fetchImpl ?? fetch);
  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: "POST", redirect:"error", signal:AbortSignal.timeout(15000),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: options.clientId,
      client_secret: options.clientSecret,
      redirect_uri: options.redirectUri,
      code: options.code,
    }).toString(),
  });

  if (!response.ok) {
    await response.text();
    throw new Error(`HubSpot token request failed with status ${response.status}`);
  }

  return parseTokenGrant((await response.json()) as Record<string, unknown>);
}

export async function refreshAccessToken(options: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetchImpl?: typeof fetch;
}): Promise<HubspotTokenGrant> {
  const fetchImpl = connectionFetch(options.fetchImpl ?? fetch);
  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: "POST", redirect:"error", signal:AbortSignal.timeout(15000),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: options.clientId,
      client_secret: options.clientSecret,
      refresh_token: options.refreshToken,
    }).toString(),
  });

  if (!response.ok) {
    await response.text();
    throw new Error(`HubSpot refresh request failed with status ${response.status}`);
  }

  return parseTokenGrant((await response.json()) as Record<string, unknown>);
}

export async function getAccountDetails(options: {
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<HubspotAccount> {
  const fetchImpl = connectionFetch(options.fetchImpl ?? fetch);
  const response = await fetchImpl(ACCOUNT_DETAILS_ENDPOINT, {
    method: "GET", redirect:"error", signal:AbortSignal.timeout(15000),
    headers: { authorization: `Bearer ${options.accessToken}` },
  });

  if (!response.ok) {
    await response.text();
    throw new Error(
      `HubSpot account details request failed with status ${response.status}`,
    );
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const portalId = normalizeHubId(payload);
  if (!portalId || !/^[0-9]{1,20}$/.test(portalId)) {
    throw new Error("HubSpot account details did not include a portal id");
  }
  return { portalId };
}

export function missingRequiredScopes(
  grantedScopes: readonly string[],
  requiredScopes: readonly string[] = HUBSPOT_REQUIRED_SCOPES,
): string[] {
  const granted = new Set(grantedScopes);
  return requiredScopes.filter((scope) => !granted.has(scope));
}

export function scopeSetMatchesExactly(
  grantedScopes: readonly string[],
  requiredScopes: readonly string[] = HUBSPOT_REQUIRED_SCOPES,
): boolean {
  const granted = new Set(grantedScopes);
  const required = new Set(requiredScopes);
  return granted.size === required.size
    && [...required].every((scope) => granted.has(scope));
}
