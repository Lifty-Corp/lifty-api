import { describe, expect, it } from "vitest";
import { pilotEnvironment } from "../scripts/prepare-pilot.mjs";

const credentials = {
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_staging",
  LIFTY_EMAIL_SERVER_KEY: "e".repeat(40),
  LIFTY_LINKEDIN_SERVER_KEY: "l".repeat(40),
  UNIPILE_V2_ACCESS_TOKEN: "isolated-app-key",
};

describe("pilot deployment artifact", () => {
  it("pins database, callback origin and application to the approved pilot", () => {
    expect(pilotEnvironment(credentials)).toMatchObject({
      SUPABASE_URL: "https://csyhcwpcojbjlwwxdmhc.supabase.co",
      PUBLIC_BASE_URL: "https://api.pilot.liftygtm.com",
      UNIPILE_V2_APPLICATION_ID: "app_01m5fr5mgdfzx8ftceq7y7z0h4",
      LIFTY_RUNTIME_PROFILE: "connections",
    });
  });
  it.each([
    { SUPABASE_URL: "https://ycwarkyijoeunmgjbikm.supabase.co" },
    { PUBLIC_BASE_URL: "https://api.liftygtm.com" },
    { UNIPILE_V2_APPLICATION_ID: "app_production" },
    { UNIPILE_V2_HOSTED_AUTH_ORIGINS: "https://auth.liftygtm.com" },
    { SUPABASE_SERVICE_ROLE_KEY: "private-admin-key" },
    { TRIGGER_SECRET_KEY: "tr_prod_key" },
    { SUPABASE_PUBLISHABLE_KEY: "service-role-jwt" },
  ])("refuses a mixed target or production credential", override => {
    expect(() => pilotEnvironment({ ...credentials, ...override })).toThrow();
  });
});
