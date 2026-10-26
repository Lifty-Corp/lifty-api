import { test } from "node:test";
import { resolveHubSpotGrant } from "./hubspot-grant-policy.ts";
import { hubSpotGrantCases } from "./hubspot-grant-policy-cases.ts";

for (const scenario of hubSpotGrantCases) {
  test(scenario.name, () => scenario.run(resolveHubSpotGrant));
}
