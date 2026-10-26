import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
// Import the existing product contract. No handwritten second evaluator.
const source = process.argv[2];
if (!source)
  throw new Error(
    "Usage: node scripts/sync-crm-contract.mjs <dashboard-checkout>",
  );
const files = [
  "evaluator",
  "executable",
  "types",
  "scout-input",
  "scout-contract",
  "sha256",
  "index",
  "conformance-fixtures",
].map((n) => [`lib/crm-shared/${n}.ts`, `src/generated/crm-shared/${n}.ts`]);
files.push(
  ["lib/crm-field-mappings.ts", "src/generated/crm-field-mappings.ts"],
  ["lib/crm-source-catalog.ts", "src/generated/crm-source-catalog.ts"],
  // The evaluator imports its no-op recovery marker from here.
  ["lib/dashboard-errors/policy.ts", "src/generated/dashboard-errors/policy.ts"],
);
const sourceCommit = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const manifest = [];
for (const [from, to] of files) {
  const original = readFileSync(resolve(source, from), "utf8");
  const adapted = original
    .replace("const first = group[0];", "const first = group[0]!;")
    .replaceAll(
      "existingProperties?: Record<string, unknown>;",
      "existingProperties?: Record<string, unknown> | undefined;",
    )
    .replaceAll(
      "runtime?: Record<string, unknown>;",
      "runtime?: Record<string, unknown> | undefined;",
    )
    .replaceAll(
      "counterpartProperties?: Record<string, unknown>;",
      "counterpartProperties?: Record<string, unknown> | undefined;",
    );
  const content =
    "// Generated from lift-gtm-dashboard/" +
    from +
    "; regenerate with scripts/sync-crm-contract.mjs.\n" +
    adapted.replace(/(from\s+["'][^"']+)\.ts(["'])/g, "$1.js$2");
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, content);
  manifest.push({
    source_commit: sourceCommit,
    source: from,
    target: to,
    source_sha256: createHash("sha256").update(original).digest("hex"),
    generated_sha256: createHash("sha256").update(content).digest("hex"),
  });
}
writeFileSync(
  "src/generated/crm-contract.manifest.json",
  JSON.stringify(manifest, null, 2) + "\n",
);
