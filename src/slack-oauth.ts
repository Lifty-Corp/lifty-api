import { connectionFetch } from "./connection-confirmation.js";
const AUTHORIZATION_ENDPOINT = "https://slack.com/oauth/v2/authorize";
const TOKEN_ENDPOINT = "https://slack.com/api/oauth.v2.access";
const AUTH_TEST_ENDPOINT = "https://slack.com/api/auth.test";

export const SLACK_REQUIRED_SCOPES: readonly string[] = Object.freeze([
  "channels:read",
  "chat:write",
  "groups:read",
]);

export interface SlackGrant {
  accessToken: string;
  botUserId: string;
  enterpriseId: string | null;
  scopes: string[];
  teamId: string;
  teamName: string;
}

function requireString(value: unknown, marker: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(marker);
  return value;
}

function normalizeScopes(value: unknown): string[] {
  const entries = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[ ,]+/)
      : [];
  return [...new Set(entries.map(String).filter(Boolean))].sort();
}

// The shared app's internal install (config/slack/lifty.manifest.json) holds
// these too. Slack reports a workspace's cumulative bot scopes, so connecting
// a Slack workspace where that install exists returns them alongside ours.
export const SLACK_INTERNAL_APP_SCOPES: readonly string[] = Object.freeze([
  "groups:history",
  "incoming-webhook",
]);

export function slackScopesAcceptable(
  grantedScopes: readonly string[],
  requiredScopes: readonly string[] = SLACK_REQUIRED_SCOPES,
): boolean {
  const granted = new Set(grantedScopes);
  const allowed = new Set([...requiredScopes, ...SLACK_INTERNAL_APP_SCOPES]);
  return requiredScopes.every((scope) => granted.has(scope))
    && [...granted].every((scope) => allowed.has(scope));
}

export function buildSlackAuthorizationUrl(options: {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes?: readonly string[];
}): string {
  requireString(options.clientId, "slack_client_id_missing");
  requireString(options.redirectUri, "slack_redirect_uri_missing");
  requireString(options.state, "slack_state_missing");

  const url = new URL(AUTHORIZATION_ENDPOINT);
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("scope", (options.scopes ?? SLACK_REQUIRED_SCOPES).join(","));
  url.searchParams.set("state", options.state);
  return url.toString();
}

async function parseSlackResponse(
  response: Response,
  failureMarker: string,
): Promise<Record<string, unknown>> {
  let payload: Record<string, unknown>;
  try {
    payload = await response.json() as Record<string, unknown>;
  } catch {
    throw new Error(failureMarker);
  }
  if (!response.ok || payload.ok !== true) throw new Error(failureMarker);
  return payload;
}

export async function exchangeAndVerifySlackGrant(options: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  fetchImpl?: typeof fetch;
}): Promise<SlackGrant> {
  const fetchImpl = connectionFetch(options.fetchImpl ?? fetch);
  const tokenResponse = await fetchImpl(TOKEN_ENDPOINT, {
    method: "POST", redirect:"error", signal:AbortSignal.timeout(15000),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: options.clientId,
      client_secret: options.clientSecret,
      code: options.code,
      redirect_uri: options.redirectUri,
    }).toString(),
  });
  const payload = await parseSlackResponse(
    tokenResponse,
    "slack_oauth_exchange_failed",
  );

  const accessToken = requireString(
    payload.access_token,
    "slack_oauth_exchange_failed",
  );
  if (payload.token_type !== "bot" || !accessToken.startsWith("xoxb-")) {
    throw new Error("slack_bot_grant_invalid");
  }
  if (!slackScopesAcceptable(normalizeScopes(payload.scope))) {
    throw new Error("slack_scope_mismatch");
  }
  // Record the scopes this connection uses; an internal install's extras are
  // never used through it.
  const scopes = [...SLACK_REQUIRED_SCOPES].sort();

  const team = payload.team as Record<string, unknown> | undefined;
  const enterprise = payload.enterprise as Record<string, unknown> | null | undefined;
  const teamId = requireString(team?.id, "slack_team_invalid");
  const teamName = requireString(team?.name, "slack_team_invalid");
  const botUserId = requireString(payload.bot_user_id, "slack_bot_identity_invalid");
  const enterpriseId = enterprise === null || enterprise === undefined
    ? null
    : requireString(enterprise.id, "slack_enterprise_invalid");

  const authResponse = await fetchImpl(AUTH_TEST_ENDPOINT, {
    method: "GET", redirect:"error", signal:AbortSignal.timeout(15000),
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const auth = await parseSlackResponse(
    authResponse,
    "slack_identity_verification_failed",
  );
  if (
    auth.team_id !== teamId
    || auth.user_id !== botUserId
    || typeof auth.bot_id !== "string"
    || auth.bot_id.length === 0
  ) {
    throw new Error("slack_identity_mismatch");
  }

  return {
    accessToken,
    botUserId,
    enterpriseId,
    scopes,
    teamId,
    teamName,
  };
}
