import { z } from "zod";
import { connectionFetch } from "./connection-confirmation.js";
// Attio OAuth for LIFT's registered Attio app. Access tokens do not expire and
// Attio issues no refresh token; GET /v2/self identifies the token's workspace.

const AUTHORIZATION_ENDPOINT = "https://app.attio.com/authorize";
const TOKEN_ENDPOINT = "https://app.attio.com/oauth/token";
const SELF_ENDPOINT = "https://api.attio.com/v2/self";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TokenResponse = z.looseObject({ access_token: z.string().min(20).max(4096).regex(/^\S+$/) });
const SelfResponse = z.looseObject({
  active: z.literal(true),
  workspace_id: z.string().trim().regex(UUID),
  workspace_slug: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/),
  workspace_name: z.string().trim().min(1).max(255),
  scope: z.string().catch(""),
});

/** People/Companies records, attribute schema, research notes and the
 * meeting reads that detect booked meetings (sync-attio-meetings). */
export const ATTIO_REQUIRED_SCOPES: readonly string[] = Object.freeze([
  "meeting:read",
  "note:read-write",
  "object_configuration:read-write",
  "record_permission:read-write",
]);

export interface AttioTokenIdentity {
  workspaceId: string;
  workspaceSlug: string;
  workspaceName: string;
  scopes: string[];
}

export function buildAttioAuthorizationUrl(options: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  for (const [name, value] of Object.entries(options)) {
    if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  }
  const url = new URL(AUTHORIZATION_ENDPOINT);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("state", options.state);
  return url.toString();
}

export async function exchangeAttioAuthorizationCode(options: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const fetchImpl = connectionFetch(options.fetchImpl ?? fetch);
  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: options.code,
      redirect_uri: options.redirectUri,
      client_id: options.clientId,
      client_secret: options.clientSecret,
    }).toString(),
  });
  if (!response.ok) {
    await response.text();
    throw new Error(`Attio token request failed with status ${response.status}`);
  }
  const payload = TokenResponse.safeParse(await response.json());
  if (!payload.success) throw new Error("Attio token response did not include an access token");
  return payload.data.access_token;
}

export async function identifyAttioToken(options: {
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<AttioTokenIdentity> {
  const fetchImpl = connectionFetch(options.fetchImpl ?? fetch);
  const response = await fetchImpl(SELF_ENDPOINT, {
    method: "GET", redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${options.accessToken}`, accept: "application/json" },
  });
  if (!response.ok) {
    await response.text();
    throw new Error(`Attio identify request failed with status ${response.status}`);
  }
  const payload = SelfResponse.safeParse(await response.json());
  if (!payload.success) throw new Error("Attio did not identify an active workspace token");
  const { workspace_id, workspace_slug, workspace_name, scope } = payload.data;
  return {
    workspaceId: workspace_id,
    workspaceSlug: workspace_slug,
    workspaceName: workspace_name,
    scopes: scope.split(/\s+/).filter(Boolean).sort(),
  };
}

export function missingAttioScopes(granted: readonly string[]): string[] {
  const set = new Set(granted);
  return ATTIO_REQUIRED_SCOPES.filter((scope) => !set.has(scope));
}
