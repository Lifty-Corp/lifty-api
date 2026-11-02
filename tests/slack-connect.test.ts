import { describe, expect, it, vi } from "vitest";

import type { AuthSession } from "../src/app.js";
import {
  SlackCallbackError,
  createSlackConnectOperations,
} from "../src/slack-connect.js";
import { openSlackConnectIntent, sealSlackConnectIntent } from "../src/slack-state.js";

const SETTINGS = {
  clientId: "slack-client-123",
  clientSecret: "slack-client-secret",
  publicBaseUrl: "https://api.lifty.test/",
  supabaseUrl: "https://project.supabase.test",
  publishableKey: "sb_publishable_test",
};

function sessionWithRpc(implementation: (name: string) => Promise<{
  data: unknown;
  error: unknown;
}>): AuthSession {
  return { userId: "founder-123", client: { rpc: implementation } };
}

describe("hosted Slack connection operations", () => {
  it("mints a one-time connect capability with the founder-scoped RPC", async () => {
    const rpc = vi.fn(async () => ({
      data: { intent_token: "a".repeat(64), expires_in_seconds: 600 },
      error: null,
    }));
    const operations = createSlackConnectOperations({
      ...SETTINGS,
      fetchImpl: vi.fn() as typeof fetch,
    });

    const result = await operations.startConnect(sessionWithRpc(rpc));
    const state = new URL(result.connect_url).searchParams.get("intent") ?? "";

    expect(result).toMatchObject({ provider: "slack", expires_in_seconds: 600 });
    expect(openSlackConnectIntent(state, SETTINGS.clientSecret)).toBe("a".repeat(64));
    expect(rpc).toHaveBeenCalledWith("create_lifty_slack_connect_intent");
  });

  it("verifies OAuth and stores only the bot token through the capability RPC", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("oauth.v2.access")) {
        return Response.json({
          ok: true,
          access_token: "xoxb-installed-token",
          token_type: "bot",
          scope: "groups:read,chat:write,channels:read",
          bot_user_id: "U123BOT",
          team: { id: "T123TEAM", name: "Example" },
          enterprise: { id: "E123ORG", name: "Example Org" },
        });
      }
      if (url.endsWith("auth.test")) {
        return Response.json({
          ok: true,
          team_id: "T123TEAM",
          user_id: "U123BOT",
          bot_id: "B123BOT",
        });
      }
      if (url.endsWith("complete_lifty_slack_connection")) {
        return Response.json({ provider: "slack", status: "connected" });
      }
      throw new Error(`unexpected URL ${url}`);
    }) as typeof fetch;
    const operations = createSlackConnectOperations({ ...SETTINGS, fetchImpl });

    await expect(operations.completeCallback({
      code: "authorization-code",
      state: sealSlackConnectIntent("b".repeat(64), SETTINGS.clientSecret),
    })).resolves.toEqual({ teamId: "T123TEAM", teamName: "Example" });

    expect(requests.map((request) => request.url)).toEqual([
      "https://slack.com/api/oauth.v2.access",
      "https://slack.com/api/auth.test",
      "https://project.supabase.test/rest/v1/rpc/complete_lifty_slack_connection",
    ]);
    expect(JSON.parse(String(requests[2]?.init?.body))).toEqual({
      p_intent_token: "b".repeat(64),
      p_team_id: "T123TEAM",
      p_team_name: "Example",
      p_enterprise_id: "E123ORG",
      p_bot_user_id: "U123BOT",
      p_scopes: ["channels:read", "chat:write", "groups:read"],
      p_bot_token: "xoxb-installed-token",
    });
  });

  it("connects a Slack workspace that already has the internal app install", async () => {
    // Slack reports the cumulative bot scopes, including the internal install's.
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("oauth.v2.access")) {
        return Response.json({
          ok: true,
          access_token: "xoxb-installed-token",
          token_type: "bot",
          scope: "chat:write,groups:history,incoming-webhook,channels:read,groups:read",
          bot_user_id: "U123BOT",
          team: { id: "T123TEAM", name: "Example" },
        });
      }
      if (url.endsWith("auth.test")) {
        return Response.json({ ok: true, team_id: "T123TEAM", user_id: "U123BOT", bot_id: "B123BOT" });
      }
      return Response.json({ provider: "slack", status: "connected" });
    }) as typeof fetch;
    const operations = createSlackConnectOperations({ ...SETTINGS, fetchImpl });

    await expect(operations.completeCallback({
      code: "authorization-code",
      state: sealSlackConnectIntent("b".repeat(64), SETTINGS.clientSecret),
    })).resolves.toEqual({ teamId: "T123TEAM", teamName: "Example" });
    expect(JSON.parse(String(requests[2]?.init?.body)).p_scopes)
      .toEqual(["channels:read", "chat:write", "groups:read"]);
  });

  // LIF-1282: the page and the attempt read name a known refusal.
  it.each([
    ["channels:read,chat:write,groups:read,channels:history", { ok: true, team_id: "T123TEAM", user_id: "U123BOT", bot_id: "B123BOT" }, null, "permission_missing"],
    ["channels:read,chat:write,groups:read", { ok: true, team_id: "T123TEAM", user_id: "U123BOT", bot_id: "B123BOT" }, "lifty_slack_team_already_connected", "account_in_use"],
    ["channels:read,chat:write,groups:read", { ok: true, team_id: "TOTHER", user_id: "U123BOT", bot_id: "B123BOT" }, null, "callback_failed"],
  ])("records the refusal code for scope %s", async (scope, auth, completion, code) => {
    const failures: unknown[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("oauth.v2.access")) {
        return Response.json({ ok: true, access_token: "xoxb-installed-token", token_type: "bot", scope,
          bot_user_id: "U123BOT", team: { id: "T123TEAM", name: "Example" } });
      }
      if (url.endsWith("auth.test")) return Response.json(auth);
      if (url.endsWith("fail_lifty_connect_attempt")) {
        failures.push(JSON.parse(String(init?.body)));
        return Response.json({ status: "failed" });
      }
      return Response.json({ message: completion }, { status: 409 });
    }) as typeof fetch;
    const operations = createSlackConnectOperations({ ...SETTINGS, fetchImpl });

    await expect(operations.completeCallback({
      code: "authorization-code",
      state: sealSlackConnectIntent("e".repeat(64), SETTINGS.clientSecret),
    })).rejects.toBeInstanceOf(SlackCallbackError);
    expect(failures).toEqual([{ p_provider: "slack", p_intent_token: "e".repeat(64), p_status: "failed", p_error_code: code }]);
  });

  it.each([
    ["lifty_connect_intent_replayed", "link_used", 409],
    ["lifty_connect_intent_revoked", "link_revoked", 403],
  ])("maps %s to a safe callback error", async (failure, reason, status) => {
    const marker = "provider-private-marker";
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("oauth.v2.access")) {
        return Response.json({
          ok: true,
          access_token: "xoxb-installed-token",
          token_type: "bot",
          scope: "channels:read,chat:write,groups:read",
          bot_user_id: "U123BOT",
          team: { id: "T123TEAM", name: "Example" },
        });
      }
      if (url.endsWith("auth.test")) {
        return Response.json({
          ok: true,
          team_id: "T123TEAM",
          user_id: "U123BOT",
          bot_id: "B123BOT",
        });
      }
      return Response.json({ message: `${failure} ${marker}` }, { status });
    }) as typeof fetch;
    const operations = createSlackConnectOperations({ ...SETTINGS, fetchImpl });

    const error = await operations.completeCallback({
      code: "authorization-code",
      state: sealSlackConnectIntent("c".repeat(64), SETTINGS.clientSecret),
    }).catch((caught) => caught as SlackCallbackError);

    expect(error).toMatchObject({ reason, status });
    expect(JSON.stringify(error)).not.toContain(marker);
  });
});


describe("correlated slack authorization outcomes", () => {
  it("returns the durable attempt UUID and expiry without exposing the intent secret", async () => {
    const ref = "11111111-1111-4111-8111-111111111111", expiry = "2099-09-16T20:00:00Z";
    const operations = createSlackConnectOperations({ ...SETTINGS, fetchImpl: vi.fn() as typeof fetch });
    const result = await operations.startConnect(sessionWithRpc(async () => ({ data: { intent_token: "c".repeat(64), expires_in_seconds: 600, attempt_ref: ref, expires_at: expiry }, error: null })));
    expect(result).toMatchObject({ attempt_ref: ref, expires_at: expiry });
    expect(JSON.stringify(result)).not.toContain("c".repeat(64));
  });
  it("records observed denial using only cryptographically verified callback state", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ok: true }));
    const operations = createSlackConnectOperations({ ...SETTINGS, fetchImpl });
    const state = sealSlackConnectIntent("d".repeat(64), SETTINGS.clientSecret);
    await operations.denyCallback(state);
    const [url, request] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${SETTINGS.supabaseUrl}/rest/v1/rpc/fail_lifty_connect_attempt`);
    expect(JSON.parse(String(request.body))).toEqual({ p_provider: "slack", p_intent_token: "d".repeat(64), p_status: "denied", p_error_code: "authorization_denied" });
    expect(request.redirect).toBe("error");
    await expect(operations.denyCallback("forged-state")).rejects.toBeDefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
