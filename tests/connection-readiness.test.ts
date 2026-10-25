import { expect, it, vi } from "vitest";
import { createConnectionReadinessCheck } from "../src/connection-readiness.js";

const config = { supabaseUrl: "https://staging.test", publishableKey: "public-key", jwks: new URL("https://staging.test/jwks") };
const receipt = { version: "lifty.connection-profile.v1", artifact_sha256: "a".repeat(64), sending_available: false };
const keys = { email: "email-capability-key", linkedin: "linkedin-capability-key" };

it("requires both Auth and the installed non-sending database contract", async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async input =>
    Response.json(String(input).endsWith("/health") ? {} : receipt));
  expect(await createConnectionReadinessCheck(config, keys, fetcher)()).toBe(true);
  expect(fetcher.mock.calls.find(([url]) => String(url).includes("/rpc/"))?.[1]).toMatchObject({
    method: "POST", headers: { apikey: "public-key" }, body: JSON.stringify({ p_server_key: keys.email, p_linkedin_server_key: keys.linkedin }),
  });
  for (const invalid of [{}, { ...receipt, version: "old" }, { ...receipt, sending_available: true }]) {
    fetcher.mockImplementation(async input => Response.json(String(input).endsWith("/health") ? {} : invalid));
    expect(await createConnectionReadinessCheck(config, keys, fetcher)()).toBe(false);
  }
  fetcher.mockImplementation(async input => Response.json(receipt, { status: String(input).endsWith("/health") ? 503 : 200 }));
  expect(await createConnectionReadinessCheck(config, keys, fetcher)()).toBe(false);
  fetcher.mockRejectedValue(new Error("unavailable"));
  expect(await createConnectionReadinessCheck(config, keys, fetcher)()).toBe(false);
  fetcher.mockClear();
  expect(await createConnectionReadinessCheck(config, { email: keys.email }, fetcher)()).toBe(false);
  expect(await createConnectionReadinessCheck(config, { linkedin: keys.linkedin }, fetcher)()).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
});
