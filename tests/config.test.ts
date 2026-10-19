import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const validEnvironment = {
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example",
  SUPABASE_JWKS_URL:
    "https://project.supabase.co/auth/v1/.well-known/jwks.json",
  HUBSPOT_CLIENT_ID: "client-123",
  HUBSPOT_CLIENT_SECRET: "client-secret",
  SLACK_CLIENT_ID: "slack-client-123",
  SLACK_CLIENT_SECRET: "slack-client-secret",
  PUBLIC_BASE_URL: "https://api.liftygtm.com",
  TRIGGER_SECRET_KEY: "tr_prod_test_key",
  NOTIFICATIONS_TRIGGER_SECRET_KEY: "tr_prod_notifications_test_key",
};

describe("service configuration", () => {
  it("keeps domain verification absent until a single portal token is configured", () => {
    expect(loadConfig(validEnvironment).openAiAppsChallenge).toBeUndefined();
    expect(loadConfig({ ...validEnvironment, LIFTY_OPENAI_APPS_CHALLENGE: "openai-verification=example_token" }).openAiAppsChallenge).toBe("openai-verification=example_token");
    for (const value of ["", "one\ntwo", " one", "one two", "x".repeat(4097)]) {
      expect(() => loadConfig({ ...validEnvironment, LIFTY_OPENAI_APPS_CHALLENGE: value })).toThrow(/single exact/);
    }
  });
  it("keeps MCP opt-in and pins its resource and browser origins to safe configuration", () => {
    expect(loadConfig(validEnvironment).mcp).toBeNull();
    expect(loadConfig({ ...validEnvironment, LIFTY_MCP_ENABLED: "true" }).mcp).toEqual({
      resourceUrl: validEnvironment.PUBLIC_BASE_URL + "/mcp", authorizationServer: "https://project.supabase.co/auth/v1",
      allowedOrigins: [validEnvironment.PUBLIC_BASE_URL],
    });
    expect(() => loadConfig({ ...validEnvironment, LIFTY_MCP_ENABLED: "yes" })).toThrow(/true or false/);
    for (const PUBLIC_BASE_URL of ["http://127.0.0.1", "https://user:secret@example.test", "https://example.test/prefix", "https://example.test?query=value"]) {
      expect(() => loadConfig({ ...validEnvironment, PUBLIC_BASE_URL, LIFTY_MCP_ENABLED: "true" })).toThrow(/HTTPS origin/);
    }
    for (const LIFTY_MCP_ALLOWED_ORIGINS of ["https://good.test,http://evil.test", "https://good.test/path", "https://user:secret@example.test"]) {
      expect(() => loadConfig({ ...validEnvironment, LIFTY_MCP_ENABLED: "true", LIFTY_MCP_ALLOWED_ORIGINS })).toThrow();
    }
  });
  it("requires both Google credentials to enable OAuth setup, with no separate Mailivery attestation", () => {
    const env = {...validEnvironment, LIFTY_EMAIL_SERVER_KEY:"e".repeat(32), UNIPILE_DSN:"https://api.unipile.test",
      UNIPILE_ACCESS_TOKEN:"unipile-key", MAILIVERY_API_KEY:"mailivery-token-12345", LIFTY_WARMUP_SETUP_ENABLED:"true"};
    expect(() => loadConfig(env)).toThrow(/warmup/i);
    expect(() => loadConfig({...env, LIFTY_WARMUP_GOOGLE_CLIENT_ID:"client-id"})).toThrow(/warmup/i);
    const ready = {...env, LIFTY_WARMUP_GOOGLE_CLIENT_ID:"client-id", LIFTY_WARMUP_GOOGLE_CLIENT_SECRET:"client-secret"};
    expect(loadConfig(ready).warmupSetup).toMatchObject({googleClientId:"client-id", googleClientSecret:"client-secret"});
    expect(loadConfig(ready).warmupSetup).not.toHaveProperty("appPasswordEnabled");
    const branded = loadConfig({...ready, LIFTY_WARMUP_PUBLIC_BASE_URL:"https://warmup.liftygtm.com"});
    expect(branded.warmupSetup?.publicBaseUrl).toBe("https://warmup.liftygtm.com");
    expect(branded.hubspot.publicBaseUrl).toBe(validEnvironment.PUBLIC_BASE_URL);
    expect(branded.slack?.publicBaseUrl).toBe(validEnvironment.PUBLIC_BASE_URL);
    for (const origin of ["http://warmup.example.com", "https://warmup.example.com/path", "https://warmup.example.com:444", "https://user:pass@warmup.example.com", "https://warmup.example.com?q=x", "https://warmup.example.com#x"]) {
      expect(() => loadConfig({...ready, LIFTY_WARMUP_PUBLIC_BASE_URL:origin})).toThrow();
    }
    expect(loadConfig({...ready, LIFTY_WARMUP_SETUP_ENABLED:"false"}).warmupSetup).toBeNull();
    expect(() => loadConfig({...ready, LIFTY_WARMUP_SETUP_ENABLED:"yes"})).toThrow(/true or false/);
  });
  it("defaults to the verified dashboard and accepts another HTTPS origin", () => {
    expect(loadConfig(validEnvironment).dashboardOrigin).toBe("https://liftygtm.com");
    expect(loadConfig({...validEnvironment,LIFTY_DASHBOARD_ORIGIN:"https://dashboard.example.com"}).dashboardOrigin).toBe("https://dashboard.example.com");
  });
  it.each(["http://dashboard.example.com","https://user:pass@example.com","https://example.com/path","https://example.com?q=x","https://example.com#x","https://example.com:444"])("rejects unsafe dashboard origin %s", origin => {
    expect(() => loadConfig({...validEnvironment,LIFTY_DASHBOARD_ORIGIN:origin})).toThrow(/LIFTY_DASHBOARD_ORIGIN/);
  });
  it("loads a publishable-key-only Supabase configuration", () => {
    const config = loadConfig(validEnvironment);

    expect(config).toMatchObject({
      host: "0.0.0.0",
      port: 3000,
      supabase: {
        supabaseUrl: "https://project.supabase.co",
        publishableKey: "sb_publishable_example",
      },
    });
    expect(config.supabase.jwks).toEqual(
      new URL(validEnvironment.SUPABASE_JWKS_URL),
    );
    expect(config.trigger).toEqual({
      apiUrl: "https://api.trigger.dev",
      secretKey: "tr_prod_test_key",
    });
    expect(config.hubspot).toEqual({
      clientId: "client-123",
      clientSecret: "client-secret",
      publicBaseUrl: "https://api.liftygtm.com",
      supabaseUrl: "https://project.supabase.co",
      publishableKey: "sb_publishable_example",
    });
    expect(config.slack).toEqual({
      clientId: "slack-client-123",
      clientSecret: "slack-client-secret",
      publicBaseUrl: "https://api.liftygtm.com",
      supabaseUrl: "https://project.supabase.co",
      publishableKey: "sb_publishable_example",
    });
  });

  it.each([
    "SUPABASE_SECRET_KEY",
    "SUPABASE_SECRET_KEYS",
    "SUPABASE_SERVICE_ROLE_KEY",
  ])("refuses to boot when %s is present", (secretName) => {
    expect(() =>
      loadConfig({ ...validEnvironment, [secretName]: "must-not-be-loaded" }),
    ).toThrow(/secret Supabase credentials are forbidden/i);
  });

  it("accepts inline JWKS without requiring network access", () => {
    const config = loadConfig({
      ...validEnvironment,
      SUPABASE_JWKS_URL: undefined,
      SUPABASE_JWKS: JSON.stringify({
        keys: [{ kty: "EC", crv: "P-256", x: "x", y: "y" }],
      }),
      PORT: "8787",
      HOST: "127.0.0.1",
    });

    expect(config.port).toBe(8787);
    expect(config.host).toBe("127.0.0.1");
    expect(config.supabase.jwks).toEqual({
      keys: [{ kty: "EC", crv: "P-256", x: "x", y: "y" }],
    });
  });

  it.each([
    {
      ...validEnvironment,
      SLACK_CLIENT_ID: undefined,
      SLACK_CLIENT_SECRET: undefined,
    },
    { ...validEnvironment, SLACK_CLIENT_ID: undefined },
    { ...validEnvironment, SLACK_CLIENT_SECRET: undefined },
  ])("disables Slack OAuth until both credentials are configured", (environment) => {
    expect(loadConfig(environment).slack).toBeNull();
  });

  it.each([
    [{ ...validEnvironment, SUPABASE_URL: undefined }, /SUPABASE_URL/],
    [
      { ...validEnvironment, SUPABASE_JWKS_URL: "http://attacker.example/jwks" },
      /SUPABASE_JWKS_URL/,
    ],
    [{ ...validEnvironment, PORT: "70000" }, /PORT/],
    [{ ...validEnvironment, HUBSPOT_CLIENT_ID: undefined }, /HUBSPOT_CLIENT_ID/],
    [{ ...validEnvironment, HUBSPOT_CLIENT_SECRET: undefined }, /HUBSPOT_CLIENT_SECRET/],
    [{ ...validEnvironment, TRIGGER_SECRET_KEY: undefined }, /TRIGGER_SECRET_KEY/],
    [{ ...validEnvironment, NOTIFICATIONS_TRIGGER_SECRET_KEY: undefined }, /NOTIFICATIONS_TRIGGER_SECRET_KEY is required/],
    [
      { ...validEnvironment, NOTIFICATIONS_TRIGGER_API_URL: "http://attacker.example" },
      /NOTIFICATIONS_TRIGGER_API_URL/,
    ],
    [
      { ...validEnvironment, TRIGGER_API_URL: "http://attacker.example" },
      /TRIGGER_API_URL/,
    ],
    [{ ...validEnvironment, PUBLIC_BASE_URL: undefined }, /PUBLIC_BASE_URL/],
    [
      { ...validEnvironment, PUBLIC_BASE_URL: "http://api.example.test" },
      /PUBLIC_BASE_URL/,
    ],
  ])("fails closed for an invalid environment", (environment, message) => {
    expect(() => loadConfig(environment)).toThrow(message);
  });
});

it("reaches the notifications Trigger project only with its own distinct key", () => {
  expect(loadConfig(validEnvironment).notificationsTrigger).toEqual({ apiUrl: "https://api.trigger.dev", secretKey: "tr_prod_notifications_test_key" });
  expect(loadConfig({ ...validEnvironment, NOTIFICATIONS_TRIGGER_API_URL: "https://notifications.trigger.test/" }).notificationsTrigger.apiUrl)
    .toBe("https://notifications.trigger.test");
  expect(() => loadConfig({ ...validEnvironment, NOTIFICATIONS_TRIGGER_SECRET_KEY: validEnvironment.TRIGGER_SECRET_KEY })).toThrow(/distinct from TRIGGER_SECRET_KEY/);
});

it("CRM capability is optional but must be bounded and dedicated", () => {
  expect(loadConfig(validEnvironment).crm).toBeNull();
  const key = "x".repeat(48);
  expect(loadConfig({...validEnvironment,LIFTY_CRM_SERVER_KEY:key}).crm).toEqual({serverKey:key,readOnly:false});
  for (const value of ["short","x".repeat(257)]) expect(()=>loadConfig({...validEnvironment,LIFTY_CRM_SERVER_KEY:value})).toThrow(/LIFTY_CRM_SERVER_KEY/);
  expect(()=>loadConfig({...validEnvironment,LIFTY_CRM_SERVER_KEY:key,TRIGGER_SECRET_KEY:key})).toThrow(/distinct/);
});

it.each(["DASHBOARD_READ_ONLY_MODE","CONSUMER_READ_ONLY_MODE"])("preserves company maintenance write freeze from %s", name => {
  for(const value of ["1","true","TRUE"]) expect(loadConfig({...validEnvironment,LIFTY_CRM_SERVER_KEY:"x".repeat(48),[name]:value}).crm?.readOnly).toBe(true);
});

describe("staged V2 configuration",()=>{
  const baseline={...validEnvironment,UNIPILE_DSN:"https://api1.unipile.com:13111",UNIPILE_ACCESS_TOKEN:"v1-test",
    LIFTY_EMAIL_SERVER_KEY:"e".repeat(40),LIFTY_LINKEDIN_SERVER_KEY:"l".repeat(40)};
  it("configures per-channel keys and the legacy credential scope for access removal and warmup identity",()=>{
    const config=loadConfig({...baseline,UNIPILE_V2_ACCESS_TOKEN:"v2-test",UNIPILE_V2_APPLICATION_ID:"app_test",
      UNIPILE_PROVIDER_NAMESPACE:" legacy-fixture ",
      UNIPILE_V2_HOSTED_AUTH_ORIGINS:"https://connect-v2.lifty.test,https://previous-v2.lifty.test"});
    expect(config.accounts).toMatchObject({serverKeys:{email:"e".repeat(40),linkedin:"l".repeat(40)},
      provider:{v1:{dsn:baseline.UNIPILE_DSN,accessToken:"v1-test",providerNamespace:"legacy-fixture"},v2:{accessToken:"v2-test",applicationId:"app_test",
        hostedAuthOrigins:["https://connect-v2.lifty.test","https://previous-v2.lifty.test"]}}});
    expect(loadConfig(baseline).accounts).toBeNull();
    expect(()=>loadConfig({...baseline,UNIPILE_ACCESS_TOKEN:""})).toThrow(/UNIPILE_DSN and UNIPILE_ACCESS_TOKEN/);
  });
  it.each([
    {UNIPILE_V2_ACCESS_TOKEN:"token"},{UNIPILE_V2_APPLICATION_ID:"app_test"},
    {UNIPILE_V2_HOSTED_AUTH_ORIGINS:"https://connect-v2.lifty.test"},
    {UNIPILE_V2_ACCESS_TOKEN:"token",UNIPILE_V2_APPLICATION_ID:"not-app"},
    {UNIPILE_V2_ACCESS_TOKEN:"token",UNIPILE_V2_APPLICATION_ID:"app_test",UNIPILE_V2_HOSTED_AUTH_ORIGINS:"https://account.unipile.com"},
    {UNIPILE_V2_ACCESS_TOKEN:"token",UNIPILE_V2_APPLICATION_ID:"app_test",UNIPILE_V2_HOSTED_AUTH_ORIGINS:"https://user:pass@other.test"},
    {UNIPILE_V2_ACCESS_TOKEN:"token",UNIPILE_V2_APPLICATION_ID:"app_test"},
    {UNIPILE_V2_ACCESS_TOKEN:"token",UNIPILE_V2_APPLICATION_ID:"app_test",UNIPILE_V2_HOSTED_AUTH_ORIGINS:"https://auth.unipile.com"},
    {UNIPILE_V2_ACCESS_TOKEN:"token",UNIPILE_V2_APPLICATION_ID:"app_test",UNIPILE_V2_HOSTED_AUTH_ORIGINS:"https://connect-v2.lifty.test,https://auth.unipile.com"},
    ...["http://connect.liftygtm.com","https://connect.liftygtm.com:8443","https://connect.liftygtm.com/path","https://connect.liftygtm.com?x=1",
      "https://connect.liftygtm.com#x","https://localhost","https://127.0.0.1","https://[::1]","https://*.liftygtm.com","not a url"]
      .map(origin=>({UNIPILE_V2_ACCESS_TOKEN:"token",UNIPILE_V2_APPLICATION_ID:"app_test",UNIPILE_V2_HOSTED_AUTH_ORIGINS:origin})),
  ])("rejects incomplete or unsafe V2 config %j",extra=>{expect(()=>loadConfig({...baseline,...extra})).toThrow();});
});

describe("Mailivery warmup configuration", () => {
  it("keeps warmup start closed without a key and accepts one dedicated token", () => {
    expect(loadConfig(validEnvironment).mailivery).toBeNull();
    const key = "mlv_" + "k".repeat(40);
    expect(loadConfig({ ...validEnvironment, MAILIVERY_API_KEY: ` ${key} ` }).mailivery).toEqual({ apiKey: key });
  });
  it.each(["short", "has space inside the key value", "x".repeat(513)])("rejects malformed key %#", value => {
    expect(() => loadConfig({ ...validEnvironment, MAILIVERY_API_KEY: value })).toThrow(/MAILIVERY_API_KEY/);
  });
  it("refuses to reuse a LIFTY service key", () => {
    const key = "x".repeat(48);
    expect(() => loadConfig({ ...validEnvironment, LIFTY_CRM_SERVER_KEY: key, MAILIVERY_API_KEY: key })).toThrow(/distinct/);
  });
});
