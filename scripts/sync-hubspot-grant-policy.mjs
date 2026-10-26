#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// A standalone checkout owns its API copy. Other consumers are opt-in so a
// worktree can never discover and overwrite an unrelated sibling checkout.
const options = { api: root, check: false };
for (let index = 2; index < process.argv.length; index++) {
  const flag = process.argv[index];
  if (flag === "--check") options.check = true;
  else if (["--api", "--jobs", "--db", "--services"].includes(flag) && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) {
    options[flag.slice(2)] = resolve(process.argv[++index]);
  } else throw new Error(`Unknown or incomplete argument: ${flag}`);
}
const files = ["hubspot-grant-policy.ts", "hubspot-grant-policy-cases.ts"];
const sources = await Promise.all(files.map(async (file) => [file, await readFile(resolve(root, "contracts", file), "utf8")]));
const manifest = `${JSON.stringify({
  source: "lifty-api/contracts/hubspot-grant-policy.ts",
  generator: "lifty-api/scripts/sync-hubspot-grant-policy.mjs",
  files: Object.fromEntries(sources.map(([file, bytes]) => [file, createHash("sha256").update(bytes).digest("hex")])),
}, null, 2)}\n`;
const destinations = [
  resolve(options.api, "src/generated"),
  options.jobs && resolve(options.jobs, "src/lib/crm/generated"),
  options.db && resolve(options.db, "supabase/functions/_shared/generated"),
  options.services && resolve(options.services, "services/pipeline/src/generated"),
].filter(Boolean);
for (const destination of destinations) {
  for (const [file, bytes] of [...sources, ["hubspot-grant-policy.manifest.json", manifest]]) {
    const path = resolve(destination, file);
    if (options.check) {
      if (await readFile(path, "utf8") !== bytes) throw new Error(`Generated HubSpot policy drift: ${path}`);
    } else {
      await mkdir(destination, { recursive: true });
      await writeFile(path, bytes);
    }
  }
}
console.log(`HubSpot grant policy ${options.check ? "verified" : "generated"} in ${destinations.length} consumers.`);
