import { describe, expect, it } from "vitest";

import { createDeploymentApp, createProductionApp } from "../src/service.js";
import { sealHubspotConnectIntent } from "../src/hubspot-state.js";

describe("production service composition", () => {
  it("wires the Supabase authenticator into the REST app", async () => {
    const app = createProductionApp({
      host: "0.0.0.0",
      port: 3000,
      supabase: {
        supabaseUrl: "https://project.supabase.test",
        publishableKey: "sb_publishable_test_abcdefghijklmnopqrstuvwxyz",
        jwks: { keys: [{ kty: "EC", crv: "P-256", x: "x", y: "y" }] },
      },
      hubspot: {
        clientId: "client-123",
        clientSecret: "client-secret",
        publicBaseUrl: "https://api.lifty.test",
        supabaseUrl: "https://project.supabase.test",
        publishableKey: "sb_publishable_test_abcdefghijklmnopqrstuvwxyz",
      },
      slack: {
        clientId: "slack-client-123",
        clientSecret: "slack-client-secret",
        publicBaseUrl: "https://api.lifty.test",
        supabaseUrl: "https://project.supabase.test",
        publishableKey: "sb_publishable_test_abcdefghijklmnopqrstuvwxyz",
      },
      trigger: {
        apiUrl: "https://api.trigger.test",
        secretKey: "tr_prod_test_key",
      },
      notificationsTrigger: {
        apiUrl: "https://notifications.trigger.test",
        secretKey: "tr_prod_notifications_test_key",
      },
    });

    const response = await app.request("/v1/workspace", {
      headers: { authorization: "Bearer malformed.jwt.token" },
    });

    expect(response.status).toBe(401);
  });

  it("constructs a fetch-compatible app from deployment environment values", async () => {
    const serviceModule = await import("../src/service.js");
    const createDeploymentApp = (
      serviceModule as Record<string, unknown>
    ).createDeploymentApp;

    expect(createDeploymentApp).toBeTypeOf("function");

    const app = (createDeploymentApp as (
      environment: Record<string, string | undefined>,
    ) => ReturnType<typeof createProductionApp>)({
      SUPABASE_URL: "https://project.supabase.test",
      SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_abcdefghijklmnopqrstuvwxyz",
      SUPABASE_JWKS: JSON.stringify({
        keys: [{ kty: "EC", crv: "P-256", x: "x", y: "y" }],
      }),
      HUBSPOT_CLIENT_ID: "client-123",
      HUBSPOT_CLIENT_SECRET: "client-secret",
      SLACK_CLIENT_ID: "slack-client-123",
      SLACK_CLIENT_SECRET: "slack-client-secret",
      PUBLIC_BASE_URL: "https://api.lifty.test",
      TRIGGER_SECRET_KEY: "tr_prod_test_key",
      NOTIFICATIONS_TRIGGER_SECRET_KEY: "tr_prod_notifications_test_key",
    });

    const response = await app.request("/healthz");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });

    const state = sealHubspotConnectIntent("a".repeat(64), "client-secret");
    const redirect = await app.request(`/hubspot/start?intent=${state}`);
    const location = new URL(redirect.headers.get("location") ?? "");
    expect(redirect.status).toBe(302);
    expect(location.searchParams.get("client_id")).toBe("client-123");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://api.lifty.test/hubspot/callback",
    );
    expect(location.searchParams.get("state")).toBe(state);
  });

  it("keeps the control plane healthy before Slack OAuth credentials are configured", async () => {
    const app = createDeploymentApp({
      SUPABASE_URL: "https://project.supabase.test",
      SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_abcdefghijklmnopqrstuvwxyz",
      SUPABASE_JWKS: JSON.stringify({
        keys: [{ kty: "EC", crv: "P-256", x: "x", y: "y" }],
      }),
      HUBSPOT_CLIENT_ID: "client-123",
      HUBSPOT_CLIENT_SECRET: "client-secret",
      PUBLIC_BASE_URL: "https://api.lifty.test",
      TRIGGER_SECRET_KEY: "tr_prod_test_key",
      NOTIFICATIONS_TRIGGER_SECRET_KEY: "tr_prod_notifications_test_key",
    });

    const response = await app.request("/healthz");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

});
