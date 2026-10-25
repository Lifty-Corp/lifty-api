import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "../src/app.js";
import {
  HUBSPOT_REQUIRED_SCOPES,
  HubspotCallbackError,
  createHubspotConnectOperations,
} from "../src/hubspot-connect.js";
import {
  openHubspotConnectIntent,
  sealHubspotConnectIntent,
} from "../src/hubspot-state.js";

const SETTINGS = {
  clientId: "client-123",
  clientSecret: "client-secret",
  publicBaseUrl: "https://api.lifty.test/",
  supabaseUrl: "https://project.supabase.test",
  publishableKey: "sb_publishable_test",
};

function sessionWithRpc(
  implementation: (name: string, args?: Record<string, unknown>) => Promise<{
    data: unknown;
    error: unknown;
  }>,
): AuthSession {
  return { userId: "founder-123", client: { rpc: implementation } };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("hosted HubSpot connection operations", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T16:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("mints a one-time connect capability with the founder-scoped RPC", async () => {
    const rpc = vi.fn(async () => ({
      data: { intent_token: "a".repeat(64), expires_in_seconds: 600 },
      error: null,
    }));
    const operations = createHubspotConnectOperations({
      ...SETTINGS,
      fetchImpl: vi.fn() as typeof fetch,
    });

    const result = await operations.startConnect(sessionWithRpc(rpc));
    const state = new URL(result.connect_url).searchParams.get("intent") ?? "";

    expect(result).toMatchObject({
      provider: "hubspot",
      expires_in_seconds: 600,
    });
    expect(state).not.toContain("a".repeat(64));
    expect(openHubspotConnectIntent(state, SETTINGS.clientSecret)).toBe(
      "a".repeat(64),
    );
    expect(rpc).toHaveBeenCalledWith("create_lifty_hubspot_connect_intent");
  });

  it("returns only secret-free connection status from the founder-scoped RPC", async () => {
    const rpc = vi.fn(async () => ({
      data: {
        provider: "hubspot",
        status: "connected",
        portal_id: "49072478",
        hub_domain: "example.test",
        granted_scopes: HUBSPOT_REQUIRED_SCOPES,
        connected_at: "2026-08-31T16:00:00Z",
        reconnect_required: false,
      },
      error: null,
    }));
    const operations = createHubspotConnectOperations({
      ...SETTINGS,
      fetchImpl: vi.fn() as typeof fetch,
    });

    const status = await operations.getConnection(sessionWithRpc(rpc));

    expect(status).toMatchObject({
      status: "connected",
      portal_id: "49072478",
      reconnect_required: false,
    });
    expect(JSON.stringify(status)).not.toMatch(/access_token|refresh_token|secret/i);
  });

  it("verifies the account and a rotated grant before persisting the connection", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === "https://api.hubapi.com/oauth/2026-03/token") {
        const grantType = new URLSearchParams(String(init?.body)).get("grant_type");
        return grantType === "authorization_code"
          ? json({
              access_token: "initial-access",
              refresh_token: "initial-refresh",
              expires_in: 1800,
              scopes: HUBSPOT_REQUIRED_SCOPES,
              hub_id: 49072478,
              hub_domain: "example.test",
            })
          : json({
              access_token: "rotated-access",
              refresh_token: "rotated-refresh",
              expires_in: 1800,
              scopes: HUBSPOT_REQUIRED_SCOPES,
              hub_id: 49072478,
              hub_domain: "example.test",
            });
      }
      if (url === "https://api.hubapi.com/account-info/2026-03/details") {
        return json({ portalId: 49072478 });
      }
      if (url === "https://project.supabase.test/rest/v1/rpc/complete_lifty_hubspot_connection") {
        return json({ provider: "hubspot", status: "connected" });
      }
      throw new Error(`unexpected URL ${url}`);
    }) as typeof fetch;
    const operations = createHubspotConnectOperations({ ...SETTINGS, fetchImpl });

    const state = sealHubspotConnectIntent("b".repeat(64), SETTINGS.clientSecret);
    await expect(operations.completeCallback({
      code: "authorization-code",
      state,
    })).resolves.toEqual({ portalId: "49072478", hubDomain: "example.test" });

    expect(calls.map((call) => call.url)).toEqual([
      "https://api.hubapi.com/oauth/2026-03/token",
      "https://api.hubapi.com/account-info/2026-03/details",
      "https://api.hubapi.com/oauth/2026-03/token",
      "https://project.supabase.test/rest/v1/rpc/complete_lifty_hubspot_connection",
    ]);
    const stored = JSON.parse(String(calls[3]?.init?.body));
    expect(stored).toEqual({
      p_intent_token: "b".repeat(64),
      p_portal_id: "49072478",
      p_hub_domain: "example.test",
      p_scopes: [...HUBSPOT_REQUIRED_SCOPES].sort(),
      p_token_bundle: {
        access_token: "rotated-access",
        client_id: "client-123",
        client_secret: "client-secret",
        refresh_token: "rotated-refresh",
        expires_at_epoch: 1788193800,
        obtained_at_epoch: 1788192000,
        portal_id: "49072478",
        scopes: [...HUBSPOT_REQUIRED_SCOPES].sort(),
      },
    });
  });

  it("rejects an expanded scope set before account lookup or persistence", async () => {
    const fetchImpl = vi.fn(async () => json({
      access_token: "initial-access",
      refresh_token: "initial-refresh",
      expires_in: 1800,
      scopes: [...HUBSPOT_REQUIRED_SCOPES, "crm.schemas.deals.read"],
      hub_id: 49072478,
    })) as typeof fetch;
    const operations = createHubspotConnectOperations({ ...SETTINGS, fetchImpl });

    await expect(operations.completeCallback({
      code: "authorization-code",
      state: sealHubspotConnectIntent("c".repeat(64), SETTINGS.clientSecret),
    })).rejects.toMatchObject({
      reason: "scope_mismatch",
      status: 403,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[1]?.[0])).toContain("fail_lifty_connect_attempt");
    expect(JSON.parse(String(((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[1]?.[1] as RequestInit).body)))
      .toMatchObject({ p_status: "failed", p_error_code: "permission_missing" });
  });

  // LIF-1282/LIF-1584: each known refusal records its own cause for the page and the agent.
  it.each([
    ["lifty_portal_already_connected", "portal_taken", "account_in_use"],
    ["lifty_crm_account_mismatch", "account_mismatch", "account_mismatch"],
    ["lifty_crm_provider_conflict", "crm_provider_conflict", "crm_provider_conflict"],
  ])("records the named cause when the store refuses with %s", async (marker, reason, code) => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/oauth/2026-03/token")) return json({ access_token: "access-value", refresh_token: "refresh-value",
        expires_in: 1800, scopes: HUBSPOT_REQUIRED_SCOPES, hub_id: 49072478 });
      if (url.includes("/account-info/")) return json({ portalId: 49072478 });
      if (url.endsWith("/rpc/fail_lifty_connect_attempt")) return json({ status: "failed" });
      return json({ message: marker }, 409);
    }) as typeof fetch;
    const operations = createHubspotConnectOperations({ ...SETTINGS, fetchImpl });
    await expect(operations.completeCallback({ code: "authorization-code",
      state: sealHubspotConnectIntent("e".repeat(64), SETTINGS.clientSecret) })).rejects.toMatchObject({ reason, status: 409 });
    const calls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls;
    expect(String(calls.at(-1)?.[0])).toContain("fail_lifty_connect_attempt");
    expect(JSON.parse(String((calls.at(-1)?.[1] as RequestInit).body))).toEqual({ p_provider: "hubspot",
      p_intent_token: "e".repeat(64), p_status: "failed", p_error_code: code });
  });

  it("maps replayed state to a safe callback error without copying provider tokens", async () => {
    const privateMarker = "provider-private-marker";
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/oauth/2026-03/token")) {
        return json({
          access_token: "access-value",
          refresh_token: "refresh-value",
          expires_in: 1800,
          scopes: HUBSPOT_REQUIRED_SCOPES,
          hub_id: 49072478,
        });
      }
      if (url.includes("/account-info/")) return json({ portalId: 49072478 });
      return json({ message: `lifty_connect_intent_replayed ${privateMarker}` }, 409);
    }) as typeof fetch;
    const operations = createHubspotConnectOperations({ ...SETTINGS, fetchImpl });

    const error = await operations.completeCallback({
      code: "authorization-code",
      state: sealHubspotConnectIntent("d".repeat(64), SETTINGS.clientSecret),
    }).catch((caught) => caught as HubspotCallbackError);

    expect(error).toMatchObject({ reason: "link_used", status: 409 });
    expect(JSON.stringify(error)).not.toContain(privateMarker);
  });
});


describe("correlated hubspot authorization outcomes", () => {
  it("returns the durable attempt UUID and expiry without exposing the intent secret", async () => {
    const ref = "11111111-1111-4111-8111-111111111111", expiry = "2099-09-16T20:00:00Z";
    const operations = createHubspotConnectOperations({ ...SETTINGS, fetchImpl: vi.fn() as typeof fetch });
    const result = await operations.startConnect(sessionWithRpc(async () => ({ data: { intent_token: "c".repeat(64), expires_in_seconds: 600, attempt_ref: ref, expires_at: expiry }, error: null })));
    expect(result).toMatchObject({ attempt_ref: ref, expires_at: expiry });
    expect(JSON.stringify(result)).not.toContain("c".repeat(64));
  });
  it("records observed denial using only cryptographically verified callback state", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ok: true }));
    const operations = createHubspotConnectOperations({ ...SETTINGS, fetchImpl });
    const state = sealHubspotConnectIntent("d".repeat(64), SETTINGS.clientSecret);
    await operations.denyCallback(state);
    const [url, request] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${SETTINGS.supabaseUrl}/rest/v1/rpc/fail_lifty_connect_attempt`);
    expect(JSON.parse(String(request.body))).toEqual({ p_provider: "hubspot", p_intent_token: "d".repeat(64), p_status: "denied", p_error_code: "authorization_denied" });
    expect(request.redirect).toBe("error");
    await expect(operations.denyCallback("forged-state")).rejects.toBeDefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
