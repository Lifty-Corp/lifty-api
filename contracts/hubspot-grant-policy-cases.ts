/** Canonical behavioral matrix, vendored beside the policy in every runtime. */
import type {
  HubSpotGrantResult,
  HubSpotGrantStorage,
  OAuthGrant,
  ResolveHubSpotGrantOptions,
} from "./hubspot-grant-policy.ts";

type Resolve = (
  options: ResolveHubSpotGrantOptions,
  storage: HubSpotGrantStorage,
) => Promise<HubSpotGrantResult>;
type Case = { name: string; run(resolve: Resolve): Promise<void> };
const portalId = "49072478";
const workspaceId = "85800000-0000-4000-a000-00000000000a";
const requestId = "request-policy-fixture";
const scopes = [
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
];
const legacyScopes = scopes.filter((scope) =>
  !scope.includes("deals") && !scope.startsWith("crm.schemas.") ||
  ["crm.schemas.companies.read", "crm.schemas.contacts.read"].includes(scope)
);
const original: OAuthGrant = {
  access_token: "original-access",
  client_id: "fixture-client",
  client_secret: "fixture-secret",
  refresh_token: "original-refresh",
  obtained_at_epoch: 1000,
  expires_at_epoch: 2000,
  portal_id: portalId,
  scopes,
};
function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Policy assertion failed: ${JSON.stringify(actual)} != ${
        JSON.stringify(expected)
      }`,
    );
  }
}
interface Scenario {
  secret?: string | null;
  now?: number;
  expectedPortalId?: string;
  tokenPayload?: unknown;
  accountPayload?: unknown;
  tokenStatus?: number;
  accountStatus?: number;
  failFetchAt?: number;
  invalidJsonAt?: number;
  rotation?: "ok" | "reject" | "throw";
  reconnectThrows?: boolean;
  result: HubSpotGrantResult;
  requests?: number;
  rotate?: boolean;
  reconnect?: boolean;
  grantScopes?: string[];
}
async function exercise(resolve: Resolve, scenario: Scenario): Promise<void> {
  const rotations: Array<Parameters<HubSpotGrantStorage["rotateGrant"]>[0]> =
    [];
  const reconnects: Array<
    Parameters<HubSpotGrantStorage["markReconnectRequired"]>[0]
  > = [];
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const result = await resolve({
    workspaceId,
    requestId,
    nowEpochSeconds: scenario.now ?? 1700,
    secret: scenario.secret === undefined
      ? JSON.stringify(original)
      : scenario.secret,
    expectedPortalId: scenario.expectedPortalId,
    fetcher: async (url, init) => {
      requests.push({ url: String(url), init });
      if (scenario.failFetchAt === requests.length) {
        throw new Error("provider-sensitive-failure");
      }
      if (scenario.invalidJsonAt === requests.length) {
        return new Response("not-json");
      }
      const tokenRequest = String(url).endsWith("/token");
      const payload = tokenRequest
        ? scenario.tokenPayload === undefined
          ? {
            access_token: "next-access",
            refresh_token: "next-refresh",
            expires_in: 1800,
            scope: scopes.join(" "),
            hub_id: portalId,
          }
          : scenario.tokenPayload
        : scenario.accountPayload === undefined
        ? { portalId }
        : scenario.accountPayload;
      return new Response(JSON.stringify(payload), {
        status:
          (tokenRequest ? scenario.tokenStatus : scenario.accountStatus) ?? 200,
      });
    },
  }, {
    async rotateGrant(input) {
      rotations.push(input);
      if (scenario.rotation === "throw") {
        throw new Error("storage-sensitive-failure");
      }
      return scenario.rotation !== "reject";
    },
    async markReconnectRequired(input) {
      reconnects.push(input);
      if (scenario.reconnectThrows) throw new Error("audit-sensitive-failure");
    },
  });
  equal(result, scenario.result);
  equal(requests.length, scenario.requests ?? 0);
  equal(rotations.length, scenario.rotate ? 1 : 0);
  equal(reconnects.length, scenario.reconnect ? 1 : 0);
  if (reconnects[0]) equal(reconnects[0], { workspaceId, requestId, portalId });
  if (rotations[0]) {
    const rotated = rotations[0];
    equal([rotated.workspaceId, rotated.requestId, rotated.portalId], [
      workspaceId,
      requestId,
      portalId,
    ]);
    equal(rotated.grant.access_token, "next-access");
    equal(rotated.grant.refresh_token, "next-refresh");
    equal(rotated.grant.scopes, scenario.grantScopes ?? scopes);
    equal(rotated.grant.obtained_at_epoch, scenario.now ?? 1700);
    equal(rotated.grant.expires_at_epoch, (scenario.now ?? 1700) + 1800);
    equal(rotated.previousGrant.access_token, "original-access");
    equal(rotated.grant.client_secret, original.client_secret);
    equal(
      new URLSearchParams(String(requests[0]?.init?.body)).get("refresh_token"),
      "original-refresh",
    );
    equal(requests[1]?.init?.headers, { authorization: "Bearer next-access" });
  }
}
const failed: HubSpotGrantResult = { ok: false, error: "refresh_failed" };
const invalid: HubSpotGrantResult = { ok: false, error: "grant_invalid" };
const refreshed: HubSpotGrantResult = { ok: true, token: "next-access" };
const fresh: HubSpotGrantResult = { ok: true, token: "original-access" };
const token = {
  access_token: "next-access",
  refresh_token: "next-refresh",
  expires_in: 1800,
  scope: scopes.join(" "),
  hub_id: portalId,
};
const scenarios: Array<Scenario & { name: string }> = [
  {
    name: "missing credential",
    secret: null,
    result: { ok: true, token: null },
  },
  {
    name: "legacy bearer",
    secret: "pat-na1-fixture",
    result: { ok: true, token: "pat-na1-fixture" },
  },
  {
    name: "legacy explicit portal match",
    secret: "pat-na1-fixture",
    expectedPortalId: portalId,
    result: { ok: true, token: "pat-na1-fixture" },
    requests: 1,
  },
  {
    name: "legacy explicit portal mismatch",
    secret: "pat-na1-fixture",
    expectedPortalId: "999",
    result: invalid,
    requests: 1,
  },
  { name: "fresh OAuth", now: 1699, result: fresh },
  {
    name: "fresh OAuth explicit portal match",
    now: 1699,
    expectedPortalId: portalId,
    result: fresh,
  },
  {
    name: "fresh OAuth explicit portal mismatch",
    now: 1699,
    expectedPortalId: "999",
    result: invalid,
  },
  { name: "invalid expected portal", expectedPortalId: "bad", result: invalid },
  {
    name: "five minute refresh boundary",
    result: refreshed,
    requests: 2,
    rotate: true,
  },
  {
    name: "expired OAuth",
    now: 2100,
    result: refreshed,
    requests: 2,
    rotate: true,
  },
  {
    name: "legacy seven scopes remain usable",
    secret: JSON.stringify({ ...original, scopes: legacyScopes }),
    now: 1699,
    result: fresh,
  },
  {
    name: "legacy seven scopes refresh unchanged",
    secret: JSON.stringify({ ...original, scopes: legacyScopes }),
    tokenPayload: { ...token, scope: legacyScopes.join(" ") },
    result: refreshed,
    requests: 2,
    rotate: true,
    grantScopes: legacyScopes,
  },
  {
    name: "unsorted grant scopes refresh",
    secret: JSON.stringify({ ...original, scopes: [...scopes].reverse() }),
    result: refreshed,
    requests: 2,
    rotate: true,
  },
  {
    name: "refresh without optional portal field",
    tokenPayload: { ...token, hub_id: undefined },
    result: refreshed,
    requests: 2,
    rotate: true,
  },
  {
    name: "rotation rejected",
    rotation: "reject",
    result: { ok: false, error: "rotation_failed" },
    requests: 2,
    rotate: true,
  },
  {
    name: "rotation throws safely",
    rotation: "throw",
    result: { ok: false, error: "rotation_failed" },
    requests: 2,
    rotate: true,
  },
  {
    name: "refresh HTTP failure",
    tokenStatus: 400,
    result: failed,
    requests: 1,
    reconnect: true,
  },
  {
    name: "refresh network failure",
    failFetchAt: 1,
    result: failed,
    requests: 1,
    reconnect: true,
  },
  {
    name: "refresh invalid JSON",
    invalidJsonAt: 1,
    result: failed,
    requests: 1,
    reconnect: true,
  },
  {
    name: "refresh JSON null",
    tokenPayload: null,
    result: failed,
    requests: 1,
    reconnect: true,
  },
  {
    name: "refresh JSON array",
    tokenPayload: [],
    result: failed,
    requests: 1,
    reconnect: true,
  },
  {
    name: "refresh scopes changed",
    tokenPayload: { ...token, scope: legacyScopes.join(" ") },
    result: failed,
    requests: 1,
    reconnect: true,
  },
  {
    name: "refresh portal changed",
    tokenPayload: { ...token, hub_id: "999" },
    result: failed,
    requests: 1,
    reconnect: true,
  },
  {
    name: "refresh malformed portal",
    tokenPayload: { ...token, hub_id: "bad" },
    result: failed,
    requests: 1,
    reconnect: true,
  },
  {
    name: "refresh expiry nonpositive",
    tokenPayload: { ...token, expires_in: 0 },
    result: failed,
    requests: 1,
    reconnect: true,
  },
  {
    name: "refresh expiry not integer",
    tokenPayload: { ...token, expires_in: 10.1 },
    result: failed,
    requests: 1,
    reconnect: true,
  },
  {
    name: "refresh expiry overflow",
    tokenPayload: { ...token, expires_in: Number.MAX_SAFE_INTEGER },
    result: failed,
    requests: 1,
    reconnect: true,
  },
  {
    name: "refresh missing refresh token",
    tokenPayload: { ...token, refresh_token: undefined },
    result: failed,
    requests: 1,
    reconnect: true,
  },
  {
    name: "account portal changed",
    accountPayload: { portalId: "999" },
    result: failed,
    requests: 2,
    reconnect: true,
  },
  {
    name: "account HTTP failure",
    accountStatus: 401,
    result: failed,
    requests: 2,
    reconnect: true,
  },
  {
    name: "account network failure",
    failFetchAt: 2,
    result: failed,
    requests: 2,
    reconnect: true,
  },
  {
    name: "account invalid JSON",
    invalidJsonAt: 2,
    result: failed,
    requests: 2,
    reconnect: true,
  },
  {
    name: "account JSON null",
    accountPayload: null,
    result: failed,
    requests: 2,
    reconnect: true,
  },
  {
    name: "reconnect throws safely",
    failFetchAt: 1,
    reconnectThrows: true,
    result: failed,
    requests: 1,
    reconnect: true,
  },
];
for (
  const secret of [
    "",
    " ",
    "{",
    "[]",
    '"quoted-token"',
    "token\r\nAuthorization: injected",
    JSON.stringify({ access_token: "incomplete" }),
    JSON.stringify({ ...original, extra: true }),
    JSON.stringify({ ...original, obtained_at_epoch: -1 }),
    JSON.stringify({ ...original, expires_at_epoch: 1000 }),
    JSON.stringify({ ...original, scopes: ["oauth"] }),
    JSON.stringify({ ...original, access_token: '{"bundle":true}' }),
  ]
) {
  scenarios.push({
    name: `malformed persisted credential ${scenarios.length}`,
    secret,
    result: invalid,
  });
}
export const hubSpotGrantCases: Case[] = scenarios.map((
  { name, ...scenario },
) => ({
  name,
  run: (resolve) => exercise(resolve, scenario),
}));
