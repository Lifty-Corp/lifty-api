import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "vitest";
import assert from "node:assert/strict";
import { resolveHubSpotGrant } from "../src/generated/hubspot-grant-policy.js";
import { hubSpotGrantCases } from "../src/generated/hubspot-grant-policy-cases.js";

for (const scenario of hubSpotGrantCases) {
  test(`shared HubSpot grant policy: ${scenario.name}`, () => scenario.run(resolveHubSpotGrant));
}
test("HubSpot grant artifacts match the reviewed manifest", async () => {
  const manifest = JSON.parse(await readFile(new URL("../src/generated/hubspot-grant-policy.manifest.json", import.meta.url), "utf8")) as { files: Record<string, string> };
  assert.deepEqual(Object.keys(manifest.files).sort(), ["hubspot-grant-policy-cases.ts", "hubspot-grant-policy.ts"]);
  for (const [file, sha256] of Object.entries(manifest.files)) {
    const bytes = await readFile(new URL(`../src/generated/${file}`, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), sha256, `${file} drifted; regenerate from lifty-api/contracts with its sync-hubspot-grant-policy script`);
  }
});
