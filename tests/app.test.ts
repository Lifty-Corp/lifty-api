import { describe, expect, it } from "vitest";


import { createCurrentClient as createApp } from "./current-client.js";
import { PublicError } from "../src/errors.js";
import { HubspotCallbackError } from "../src/hubspot-connect.js";
import { sealHubspotConnectIntent } from "../src/hubspot-state.js";
import { SlackCallbackError } from "../src/slack-connect.js";
import { sealSlackConnectIntent } from "../src/slack-state.js";
import { getNotificationConfig, setNotificationRoute } from "../src/workspace-operations.js";
import { notificationsDatabase, ownerEmail, slackChannel, slackRef, storedTypes } from "./notification-fixtures.js";

const SECRET_FIELD_NAME = /token$|api_?key|secret|credential/i;

function collectSecretBearingFieldNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectSecretBearingFieldNames);
  if (!value || typeof value !== "object") return [];

  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [
    ...(SECRET_FIELD_NAME.test(key) ? [key] : []),
    ...collectSecretBearingFieldNames(child),
  ]);
}

describe("LIFTY API", () => {
  it("serves the Lifty browser icon from the API host", async () => {
    const response = await createApp().request("/favicon.ico");
    const bytes = new Uint8Array(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/x-icon");
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(Array.from(bytes.slice(0, 4))).toEqual([0, 0, 1, 0]);
    expect(bytes.length).toBeGreaterThan(1000);
  });

  it("keeps secrets out of every public contract", async () => {
    const document = await (await createApp().request("/openapi.json")).json();
    expect(collectSecretBearingFieldNames(document)).toEqual([]);
    expect(collectSecretBearingFieldNames({
      access_token: { type: "string" },
      providerToken: { type: "string" },
    })).toEqual(["access_token", "providerToken"]);
  });

  it("serves an unauthenticated health check with a correlation id", async () => {
    const app = createApp();

    const response = await app.request("/healthz", {
      headers: { "x-request-id": "11111111-1111-4111-8111-111111111111" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("replaces an untrusted request id before reflecting or logging it", async () => {
    const privateMarker = "founder-private-content";
    const logEvents: unknown[] = [];
    const app = createApp({
      authenticate: async () => ({
        ok: true,
        session: { userId: "founder-123", client: { kind: "scoped" } },
      }),
      getWorkspace: async () => {
        throw new Error("failed safely");
      },
      log: (event) => logEvents.push(event),
    });

    const response = await app.request("/v1/workspace", {
      headers: {
        authorization: "Bearer valid-token",
        "x-request-id": privateMarker,
      },
    });
    const responseText = await response.text();
    const responseId = response.headers.get("x-request-id");

    expect(response.status).toBe(500);
    expect(responseId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(responseText).not.toContain(privateMarker);
    expect(JSON.stringify(logEvents)).not.toContain(privateMarker);
    expect(logEvents).toMatchObject([{ request_id: responseId }]);
  });

  it("serves readiness only after the configured app exists", async () => {
    const response = await createApp().request("/readyz");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready" });
  });

  it("reports 503 when the readiness dependency says the backend is unreachable", async () => {
    const app = createApp({ checkReadiness: async () => false });

    const response = await app.request("/readyz");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "unready" });
  });

  it("reports 503 when the readiness dependency throws", async () => {
    const app = createApp({
      checkReadiness: async () => {
        throw new Error("supabase unreachable");
      },
    });

    const response = await app.request("/readyz");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "unready" });
  });

  it("rejects an unauthenticated workspace request before business logic", async () => {
    const app = createApp({
      authenticate: async () => ({ ok: false, reason: "invalid_session" }),
    });

    const response = await app.request("/v1/workspace", {
      headers: { "x-request-id": "22222222-2222-4222-8222-222222222222" },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        code: "UNAUTHORIZED",
        message: "A valid LIFTY session is required.",
      },
      request_id: "22222222-2222-4222-8222-222222222222",
    });
  });

  it("returns the authenticated founder's workspace status", async () => {
    const app = createApp({
      authenticate: async () => ({
        ok: true,
        session: { userId: "founder-123", client: { kind: "scoped" } },
      }),
      getWorkspace: async (session) => {
        if (session.userId !== "founder-123") throw new Error("wrong actor");
        return {
          state: "ready_for_connections",
          workspace: { workspace_ref: "ws_opaque", name: "Example" },
          next_action: null,
        };
      },
    });

    const response = await app.request("/v1/workspace", {
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      state: "ready_for_connections",
      workspace: { workspace_ref: "ws_opaque", name: "Example" },
      next_action: null,
    });
  });

  it("rejects a secret-bearing workspace result before serializing or logging it", async () => {
    const providerToken = "synthetic-provider-token-never-surface";
    const logEvents: unknown[] = [];
    const app = createApp({
      authenticate: async () => ({
        ok: true,
        session: { userId: "founder-123", client: { kind: "scoped" } },
      }),
      getWorkspace: async () => ({
        state: "ready_for_connections",
        workspace: {
          workspace_ref: "ws_opaque",
          name: "Example",
          access_token: providerToken,
        },
        next_action: null,
      } as never),
      log: (event) => logEvents.push(event),
    });

    const response = await app.request("/v1/workspace", {
      headers: { authorization: "Bearer valid-token" },
    });
    const responseText = await response.text();

    expect(response.status).toBe(500);
    expect(responseText).not.toContain(providerToken);
    expect(JSON.stringify(logEvents)).not.toContain(providerToken);
  });

  const submissionFixture = (importStatus: "pending" | "imported" | "failed") => ({
    state: "submitted" as const,
    submission_ref: "11111111-1111-4111-8111-111111111111",
    draft_digest: `sha256:${"a".repeat(64)}`,
    import_status: importStatus,
    workspace: { workspace_ref: "ws_opaque", name: "Example" },
    created: importStatus === "pending",
  });

  const startRunFixture = (created: boolean) => ({
    state: "queued" as const,
    run_ref: "22222222-2222-4222-8222-222222222222",
    requested_leads: 5,
    workspace: { workspace_ref: "ws_opaque", name: "Example" },
    created,
  });

  it("propagates a resumed run attempt without creating another ledger run", async () => {
    const enqueued:unknown[]=[];
    const result={...startRunFixture(false),attempt:2};
    const app=createApp({authenticate:async()=>({ok:true,session:{userId:"founder",client:{}}}),startRun:async()=>result,enqueueFirstRun:async(runId,attempt)=>{enqueued.push({runId,attempt});return {id:"wake"};}});
    const response=await app.request("/v1/workspace/sample-review",{method:"POST",headers:{"x-lifty-client-contract":"lifty-cli-context.v11"}});
    expect(response.status).toBe(200);expect(await response.json()).toEqual(result);
    expect(enqueued).toEqual([{runId:result.run_ref,attempt:2}]);
  });

  it("starts the first run and enqueues exactly one job", async () => {
    const enqueued: string[] = [];
    const app = createApp({
      authenticate: async () => ({
        ok: true,
        session: { userId: "founder-123", client: { kind: "scoped" } },
      }),
      startRun: async () => startRunFixture(true),
      enqueueFirstRun: async (runId) => {
        enqueued.push(runId);
        return { id: "run_first" };
      },
    });

    const response = await app.request("/v1/workspace/sample-review", {
      method: "POST",
      headers: { authorization: "Bearer valid-token", "x-lifty-client-contract": "lifty-cli-context.v11" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(startRunFixture(true));
    expect(enqueued).toEqual(["22222222-2222-4222-8222-222222222222"]);
  });

  it("re-attaching to an active run still re-enqueues idempotently", async () => {
    const enqueued: string[] = [];
    const app = createApp({
      authenticate: async () => ({
        ok: true,
        session: { userId: "founder-123", client: { kind: "scoped" } },
      }),
      startRun: async () => startRunFixture(false),
      enqueueFirstRun: async (runId) => {
        enqueued.push(runId);
        return { id: "run_first" };
      },
    });

    const response = await app.request("/v1/workspace/sample-review", {
      method: "POST",
      headers: { authorization: "Bearer valid-token", "x-lifty-client-contract": "lifty-cli-context.v11" },
    });

    expect(response.status).toBe(200);
    expect(enqueued).toEqual(["22222222-2222-4222-8222-222222222222"]);
  });

  it("returns the run status for the authenticated founder", async () => {
    const status = {
      state: "succeeded" as const,
      run_ref: "22222222-2222-4222-8222-222222222222",
      requested_leads: 5,
      leads_discovered: 5,
      leads_researched: 5,
      error_code: null,
      started_at: "2026-09-01T21:00:00Z",
      completed_at: "2026-09-01T21:20:00Z",
      reviewed_at: null,
      workspace: { workspace_ref: "ws_opaque", name: "Example" },
      leads: [
        {
          name: "Pat Lopez",
          title: "VP Operations",
          company: "Acme Plants",
          linkedin_url: null,
          tier: "A",
          fit_rationale: "Owns the inspection budget.",
          stage: "qualified",
        },
      ],
    };
    const app = createApp({
      authenticate: async () => ({
        ok: true,
        session: { userId: "founder-123", client: { kind: "scoped" } },
      }),
      getRunStatus: async () => status,
    });

    const response = await app.request("/v1/workspace/sample-review", {
      headers: { authorization: "Bearer valid-token", "x-lifty-client-contract": "lifty-cli-context.v11" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(status);
  });

  it("returns a short-lived HubSpot connection URL for an authenticated founder", async () => {
    const app = createApp({
      authenticate: async () => ({
        ok: true,
        session: { userId: "founder-123", client: { kind: "scoped" } },
      }),
      startHubspotConnect: async (session) => {
        expect(session.userId).toBe("founder-123");
        return {
          provider: "hubspot",
          connect_url: "https://api.lifty.test/hubspot/start?intent=opaque",
          expires_in_seconds: 600,
        };
      },
    });

    const response = await app.request("/v1/integrations/hubspot/connect", {
      method: "POST",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      provider: "hubspot",
      connect_url: "https://api.lifty.test/hubspot/start?intent=opaque",
      expires_in_seconds: 600,
    });
  });

  it("reports HubSpot connection status without exposing credentials", async () => {
    const app = createApp({
      authenticate: async () => ({
        ok: true,
        session: { userId: "founder-123", client: { kind: "scoped" } },
      }),
      getHubspotConnection: async () => ({
        provider: "hubspot",
        status: "connected",
        portal_id: "49072478",
        hub_domain: "example.test",
        granted_scopes: ["oauth"],
        connected_at: "2026-08-31T16:00:00Z",
        reconnect_required: false,
      }),
    });

    const response = await app.request("/v1/integrations/hubspot", {
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      provider: "hubspot",
      status: "connected",
      portal_id: "49072478",
      hub_domain: "example.test",
      granted_scopes: ["oauth"],
      connected_at: "2026-08-31T16:00:00Z",
      reconnect_required: false,
    });
  });

  it("redirects a valid one-time intent to HubSpot consent without cookies", async () => {
    const state = sealHubspotConnectIntent("a".repeat(64), "test-secret");
    const authorizeUrl = `https://app.hubspot.com/oauth/authorize?state=${state}`;
    const app = createApp({
      buildHubspotAuthorizeUrl: (receivedState) => {
        expect(receivedState).toBe(state);
        return authorizeUrl;
      },
    });

    const response = await app.request(`/hubspot/start?intent=${state}`);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(authorizeUrl);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("serves CLI login from the hosted runtime with strict no-store headers", async () => {
    const rendered: Array<{ state: string; port: number }> = [];
    const response = await createApp({
      renderCliAuthPage: (state, port) => {
        rendered.push({ state, port });
        return {
          html: "<!doctype html><title>Authorize LIFTY</title>",
          scriptNonce: "test-nonce-value",
        };
      },
    }).request(`/cli/auth?state=${"s".repeat(43)}&port=49152`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toContain(
      "script-src 'nonce-test-nonce-value'",
    );
    expect(response.headers.get("content-security-policy")).toContain("img-src 'self'");
    expect(rendered).toEqual([{ state: "s".repeat(43), port: 49152 }]);
  });

  it("rejects invalid CLI login parameters before rendering auth", async () => {
    let rendered = false;
    const app = createApp({
      renderCliAuthPage: () => {
        rendered = true;
        return { html: "must not render", scriptNonce: "unused" };
      },
    });

    expect((await app.request("/cli/auth?state=bad state&port=49152")).status)
      .toBe(400);
    expect((await app.request("/cli/auth?state=safe&port=80")).status).toBe(400);
    expect(rendered).toBe(false);
  });

  it("rejects malformed HubSpot intents before building an authorization URL", async () => {
    let built = false;
    const response = await createApp({
      buildHubspotAuthorizeUrl: () => {
        built = true;
        return "https://must-not-open.example";
      },
    }).request("/hubspot/start?intent=not-a-capability");

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(built).toBe(false);
  });

  it("completes a HubSpot callback without reflecting its code or state", async () => {
    const code = "provider-authorization-code-never-reflect";
    const state = sealHubspotConnectIntent("b".repeat(64), "test-secret");
    const app = createApp({
      completeHubspotCallback: async (input) => {
        expect(input).toEqual({ code, state });
        return { portalId: "49072478", hubDomain: "example.test" };
      },
    });

    const response = await app.request(
      `/hubspot/callback?code=${encodeURIComponent(code)}&state=${state}`,
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(html).toContain("Checking your connection");
    expect(html).not.toContain(code);
    expect(html).not.toContain(state);
  });

  it("fails a denied HubSpot callback without attempting a token exchange", async () => {
    let completed = false;
    const response = await createApp({
      denyHubspotCallback: async () => {},
      completeHubspotCallback: async () => {
        completed = true;
        throw new Error("must not exchange");
      },
    }).request(
      `/hubspot/callback?error=access_denied&state=${sealHubspotConnectIntent("c".repeat(64), "test-secret")}`,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Checking your connection");
    expect(completed).toBe(false);
  });

  it("gives an admin recovery path without reflecting provider error details", async () => {
    let completed = false;
    const state = sealHubspotConnectIntent("e".repeat(64), "test-secret");
    const response = await createApp({ denyHubspotCallback: async () => {}, completeHubspotCallback: async () => {
      completed = true;
      return { portalId: "123", hubDomain: null };
    }}).request(`/hubspot/callback?error=insufficient_scope&error_description=private-provider-detail&state=${state}`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("super admin");
    expect(html).toContain("Approved apps");
    expect(html).not.toContain("private-provider-detail");
    expect(html).not.toContain(state);
    expect(completed).toBe(false);
  });

  it("keeps callback processing failures pending and logs no credentials", async () => {
    const marker="PRIVATE_CODE",state=sealHubspotConnectIntent("d".repeat(64),"secret"),events:unknown[]=[];
    const app=createApp({connectionCallbacks:{hubspot:{validate:()=>{},status:async()=>({status:"pending"}),
      process:async()=>{throw new Error(marker);}}},log:event=>events.push(event)});
    const response=await app.request("https://api.lifty.test/hubspot/callback/process",{method:"POST",
      headers:{origin:"https://api.lifty.test","content-type":"application/json","x-lifty-connection":"1"},body:JSON.stringify({state,code:marker})});
    expect(response.status).toBe(202);expect(await response.json()).toEqual({status:"pending"});
    expect(JSON.stringify(events)).not.toContain(marker);expect(JSON.stringify(events)).not.toContain(state);
    expect(events).toMatchObject([{event:"connection_confirmation",stage:"process",error_code:"pending"}]);
  });

  it("returns a short-lived Slack connection URL for an authenticated founder", async () => {
    const app = createApp({
      authenticate: async () => ({
        ok: true,
        session: { userId: "founder-123", client: { kind: "scoped" } },
      }),
      startSlackConnect: async (session) => {
        expect(session.userId).toBe("founder-123");
        return {
          provider: "slack",
          connect_url: "https://api.lifty.test/slack/start?intent=opaque",
          expires_in_seconds: 600,
        };
      },
    });

    const response = await app.request("/v1/integrations/slack/connect", {
      method: "POST",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      provider: "slack",
      connect_url: "https://api.lifty.test/slack/start?intent=opaque",
      expires_in_seconds: 600,
    });
  });

  it("reports Slack connection status without exposing credentials", async () => {
    const app = createApp({
      authenticate: async () => ({
        ok: true,
        session: { userId: "founder-123", client: { kind: "scoped" } },
      }),
      getSlackConnection: async () => ({
        provider: "slack",
        status: "connected",
        team_id: "T123TEAM",
        team_name: "Example",
        enterprise_id: null,
        bot_user_id: "U123BOT",
        scopes: ["channels:read", "chat:write", "groups:read"],
        connected_at: "2026-09-03T14:00:00Z",
        reconnect_required: false,
      }),
    });

    const response = await app.request("/v1/integrations/slack", {
      headers: { authorization: "Bearer valid-token" },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      provider: "slack",
      status: "connected",
      team_id: "T123TEAM",
      reconnect_required: false,
    });
    expect(JSON.stringify(body)).not.toMatch(/xoxb|bot_token|secret/i);
  });

  it("redirects Slack consent and completes its callback without reflecting secrets", async () => {
    const code = "slack-authorization-code-never-reflect";
    const state = sealSlackConnectIntent("e".repeat(64), "test-secret");
    const authorizeUrl = `https://slack.com/oauth/v2/authorize?state=${state}`;
    const app = createApp({
      buildSlackAuthorizeUrl: (receivedState) => {
        expect(receivedState).toBe(state);
        return authorizeUrl;
      },
      completeSlackCallback: async (input) => {
        expect(input).toEqual({ code, state });
        return { teamId: "T123TEAM", teamName: "Example" };
      },
    });

    const start = await app.request(`/slack/start?intent=${state}`);
    expect(start.status).toBe(302);
    expect(start.headers.get("location")).toBe(authorizeUrl);
    expect(start.headers.get("set-cookie")).toBeNull();

    const response = await app.request(
      `/slack/callback?code=${encodeURIComponent(code)}&state=${state}`,
    );
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("Checking your connection");
    expect(html).toContain("Invite @Lifty");
    expect(html).not.toContain("terminal");
    expect(html).not.toContain(code);
    expect(html).not.toContain(state);
  });


});

describe("LIFTY API crm sync endpoints", () => {
  const startFixture = (created: boolean) => ({
    state: "queued" as const,
    run_ref: "33333333-3333-4333-8333-333333333333",
    requested_leads: 4,
    portal_id: "149239526",
    workspace: { workspace_ref: "ws_opaque", name: "Example" },
    created,
  });

  it("starts the sync and enqueues exactly one job", async () => {
    const enqueued: string[] = [];
    const app = createApp({
      authenticate: async () => ({
        ok: true,
        session: { userId: "founder-123", client: { kind: "scoped" } },
      }),
      startCrmSyncRun: async () => startFixture(true),
      enqueueCrmSync: async (runId) => {
        enqueued.push(runId);
        return { id: "run_sync" };
      },
    });

    const response = await app.request("/v1/integrations/hubspot/sync", {
      method: "POST",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(startFixture(true));
    expect(enqueued).toEqual(["33333333-3333-4333-8333-333333333333"]);
  });

  it("re-attaching to an active sync still re-enqueues idempotently", async () => {
    const enqueued: string[] = [];
    const app = createApp({
      authenticate: async () => ({
        ok: true,
        session: { userId: "founder-123", client: { kind: "scoped" } },
      }),
      startCrmSyncRun: async () => startFixture(false),
      enqueueCrmSync: async (runId) => {
        enqueued.push(runId);
        return { id: "run_sync" };
      },
    });

    const response = await app.request("/v1/integrations/hubspot/sync", {
      method: "POST",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.status).toBe(200);
    expect(enqueued).toEqual(["33333333-3333-4333-8333-333333333333"]);
  });

  it("returns the sync status for the authenticated founder", async () => {
    const status = {
      state: "succeeded" as const,
      run_ref: "33333333-3333-4333-8333-333333333333",
      requested_leads: 4,
      leads_synced: 4,
      error_code: null,
      portal_id: "149239526",
      started_at: "2026-09-02T14:00:00Z",
      completed_at: "2026-09-02T14:05:00Z",
      workspace: { workspace_ref: "ws_opaque", name: "Example" },
    };
    const app = createApp({
      authenticate: async () => ({
        ok: true,
        session: { userId: "founder-123", client: { kind: "scoped" } },
      }),
      getCrmSyncStatus: async () => status,
    });

    const response = await app.request("/v1/integrations/hubspot/sync", {
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(status);
  });

  it("rejects an unauthenticated sync start before business logic", async () => {
    const app = createApp({
      authenticate: async () => ({ ok: false as const, reason: "invalid_session" as const }),
      startCrmSyncRun: async () => {
        throw new Error("must not run");
      },
    });

    const response = await app.request("/v1/integrations/hubspot/sync", {
      method: "POST",
    });
    expect(response.status).toBe(401);
  });
});

describe("LIFTY API notification configuration", () => {
  const headers = { authorization: "Bearer valid-token", "content-type": "application/json" };

  it("serves the stored configuration end to end, including types this API has never seen and unnamed channels", async () => {
    const database = notificationsDatabase({
      types: [...storedTypes(), { code: "pipeline.deal_won", name: "Deal won", channels: ["slack", "email"], email_fallback: false, default_on: false, paused: false }],
      destinations: [ownerEmail(), { ...slackChannel(), name: null }],
    });
    const app = createApp({
      authenticate: async () => ({ ok: true as const, session: { userId: "founder-123", client: database.client } }),
      getNotificationConfig, setNotificationRoute,
    });

    const read = await app.request("/v1/notifications", { headers });
    expect(read.status).toBe(200);
    const config = await read.json();
    expect(config.types.map((type: { code: string }) => type.code)).toContain("pipeline.deal_won");
    expect(config.destinations[1]).toEqual({ destination_ref: slackRef, channel: "slack", address: "C643CHANNEL", name: null, active: true,
      types: ["meeting.booked", "sending_account.needs_reconnect"] });
    expect(JSON.stringify(config)).not.toMatch(/bot_user_id|scopes|xoxb|secret/i);

    const route = await app.request("/v1/notifications/routes", { method: "PUT", headers,
      body: JSON.stringify({ notification_type: "pipeline.deal_won", destination_ref: slackRef, enabled: true }) });
    expect(route.status).toBe(200);
    expect((await route.json()).types).toEqual(["meeting.booked", "pipeline.deal_won", "sending_account.needs_reconnect"]);
  });

  it("validates notification writes by shape before any operation", async () => {
    const calls: unknown[] = [];
    const saved = { destination_ref: slackRef, channel: "slack" as const, address: "G643PRIVATE", name: "founders", active: true, types: [] };
    const app = createApp({
      authenticate: async () => ({ ok: true as const, session: { userId: "founder-123", client: {} } }),
      upsertNotificationDestination: async (_session, input) => { calls.push(input); return saved; },
      setNotificationRoute: async (_session, input) => { calls.push(input); return saved; },
      sendNotificationTest: async () => { throw new Error("must not run"); },
    });
    const put = (path: string, body: unknown) => app.request(path, { method: "PUT", headers, body: JSON.stringify(body) });

    for (const notification_type of ["Invented Event", "meeting", "meeting.Booked", "meeting..booked"]) {
      expect((await put("/v1/notifications/routes", { notification_type, destination_ref: slackRef, enabled: true })).status, notification_type).toBe(400);
    }
    expect((await put("/v1/notifications/destinations/slack", { channel_id: "D643DIRECT", channel_name: "dm" })).status).toBe(400);
    expect((await app.request("/v1/notifications/destinations/not-a-uuid/test", { method: "POST", headers })).status).toBe(400);
    expect(calls).toEqual([]);

    // Private channels (G…) are valid destinations.
    const destination = await put("/v1/notifications/destinations/slack", { channel_id: "G643PRIVATE", channel_name: "founders" });
    expect(destination.status).toBe(200);
    expect(await destination.json()).toEqual(saved);
    expect(calls).toEqual([{ channel_id: "G643PRIVATE", channel_name: "founders" }]);
  });

  it("returns the accepted test request and holds test posts to the shared mutation budget", async () => {
    const result = { destination_ref: slackRef, request_ref: "64300000-0000-4000-a000-000000000012", status: "queued" as const };
    const tests: string[] = [];
    const app = createApp({
      authenticate: async () => ({ ok: true as const, session: { userId: "founder-123", client: {} } }),
      sendNotificationTest: async (_session, destinationRef) => { tests.push(destinationRef); return result; },
    });
    const post = () => app.request(`/v1/notifications/destinations/${slackRef}/test`, { method: "POST", headers });

    const first = await post();
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(result);
    for (let i = 1; i < 10; i++) expect((await post()).status).toBe(200);
    const limited = await post();
    expect(limited.status).toBe(429);
    expect(tests).toHaveLength(10);
  });
});
