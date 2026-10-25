import { describe, expect, it, vi } from "vitest";
import { createDeploymentApp } from "../src/service.js";
import { loadConfig } from "../src/config.js";

const environment = {
  LIFTY_RUNTIME_PROFILE: "connections",
  SUPABASE_URL: "https://staging.supabase.test",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_staging",
  SUPABASE_JWKS: JSON.stringify({ keys: [{ kty: "EC", crv: "P-256", x: "x", y: "y" }] }),
  PUBLIC_BASE_URL: "https://api.pilot.liftygtm.com",
  LIFTY_DASHBOARD_ORIGIN: "https://pilot.liftygtm.com",
  LIFTY_EMAIL_SERVER_KEY: "e".repeat(40),
  LIFTY_LINKEDIN_SERVER_KEY: "l".repeat(40),
  UNIPILE_V2_ACCESS_TOKEN: "isolated-application-key",
  UNIPILE_V2_APPLICATION_ID: "app_pilot",
  UNIPILE_V2_HOSTED_AUTH_ORIGINS: "https://auth.pilot.liftygtm.com",
};

describe("isolated connection deployment", () => {
  it("starts real login and connection handlers without unavailable provider or job credentials", async () => {
    const config = loadConfig(environment);
    expect(config.hubspot).toBeNull();
    expect(config.trigger).toBeNull();
    expect(config.notificationsTrigger).toBeNull();
    const app = createDeploymentApp(environment);
    expect((await app.request("/healthz")).status).toBe(200);
    const login = await app.request(`/cli/auth?state=${"a".repeat(43)}&port=12345`);
    expect(login.status).toBe(200);
    expect(await login.text()).toContain("https://staging.supabase.test");
    // A real connection handler rejects an invalid capability without provider I/O.
    expect((await app.request("/connect/email?intent=invalid")).status).toBe(400);
    expect((await app.request("/connect/linkedin?intent=invalid")).status).toBe(400);
    // The same session fence protects the enabled workspace handlers.
    expect((await app.request("/v1/workspace/senders")).status).toBe(401);
  });

  it("offers Trusted setup for the configured Google client only", () => {
    const clientId = "123-pilot.apps.googleusercontent.com";
    const config = loadConfig({ ...environment, LIFTY_WARMUP_GOOGLE_CLIENT_ID: clientId });
    expect(config.accounts?.emailSetup?.google).toEqual({
      url: "https://admin.google.com/ac/owl/list?tab=configuredApps", clientId,
    });
    expect(loadConfig(environment).accounts?.emailSetup).toEqual({});
  });

  it("closes every sending, warmup, job and integration entry before any external request", async () => {
    const external = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected external request"));
    try {
      const app = createDeploymentApp(environment);
      for (const [method, path] of [
        ["POST", "/v1/workspace/setup"], ["POST", "/v1/workspace/research-schedule/activate"],
        ["POST", "/v1/workspace/campaigns"], ["POST", "/v1/email/campaign"],
        ["POST", "/v1/email/warmup/start"], ["POST", "/v1/email/placement/start"],
        ["POST", "/v1/integrations/hubspot/connect"], ["POST", "/v1/notifications/destinations/test/test"],
        ["POST", "/v1/workspace/sending-accounts/id/resume"],
      ]) {
        const result = await app.request(path!, { method: method! });
        expect(result.status, `${method} ${path}`).toBe(503);
        expect(await result.json()).toMatchObject({ error: { code: "OPERATION_UNAVAILABLE" } });
      }
      expect(external).not.toHaveBeenCalled();
    } finally { external.mockRestore(); }
  });

  it("advertises only operations available in the connection deployment", async () => {
    const app = createDeploymentApp(environment);
    const spec = await (await app.request("/openapi.json")).json();
    expect(spec.paths["/v1/workspace/senders"].post).toBeDefined();
    expect(spec.paths["/v1/workspace/sending-accounts/connect"].post).toBeDefined();
    expect(spec.paths["/v1/email/warmup/start"]).toBeUndefined();
    expect(spec.paths["/v1/workspace/setup"]).toBeUndefined();
  });

  it.each(["TRIGGER_SECRET_KEY", "NOTIFICATIONS_TRIGGER_SECRET_KEY", "HUBSPOT_CLIENT_SECRET", "SLACK_CLIENT_SECRET",
    "MAILIVERY_API_KEY", "UNIPILE_ACCESS_TOKEN", "LIFTY_WARMUP_GOOGLE_CLIENT_SECRET"])("refuses copied %s credentials", name => {
    expect(() => loadConfig({ ...environment, [name]: "should-never-be-loaded" })).toThrow(/connections profile/);
  });
});
