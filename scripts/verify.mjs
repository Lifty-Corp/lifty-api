#!/usr/bin/env node
// One verify command (LIF-1743). `npm run verify` is the light, impact-aware
// tier; `npm run verify:full` (or `--full`) is the full tier the release pull
// request and Deploy run. It never starts Docker, Supabase, a browser or a server.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));

const usage = "Usage: npm run verify [-- --base <ref>] | npm run verify:full";
let full = false;
let base = process.env.VERIFY_BASE || "origin/develop";
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === "--full") full = true;
  else if (arg === "--base" && args[index + 1] && !args[index + 1].startsWith("--")) base = args[++index];
  else if (arg.startsWith("--base=") && arg.length > 7) base = arg.slice(7);
  else {
    console.error(`verify: unknown or incomplete argument ${arg}\n${usage}`);
    process.exit(2);
  }
}

// Run on the Node major CI pins (actions/setup-node) and at least `engines`.
const engines = JSON.parse(readFileSync("package.json", "utf8")).engines?.node ?? "";
const minimum = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(engines)?.slice(1).map(Number);
const ciMajor = Number(/node-version:\s*["']?(\d+)/.exec(readFileSync(".github/workflows/verify.yml", "utf8"))?.[1]);
if (!minimum || !ciMajor) {
  console.error(`verify: cannot read the Node runtime from package.json engines (${engines}) or verify.yml node-version.`);
  process.exit(1);
}
const current = process.versions.node.split(".").map(Number);
const belowMinimum = current[0] - minimum[0] || current[1] - minimum[1] || current[2] - minimum[2];
if (current[0] !== ciMajor || belowMinimum < 0) {
  console.error(`verify: Node ${process.versions.node} does not match CI (Node ${ciMajor}, engines ${engines}).`);
  console.error(`Run it on CI's runtime instead: fnm exec --using ${ciMajor} npm run verify`);
  process.exit(1);
}

function git(...gitArgs) {
  const result = spawnSync("git", gitArgs, { encoding: "utf8" });
  return result.status === 0 ? result.stdout : null;
}
// Changed set: committed since the merge-base, staged, unstaged and untracked.
const mergeBase = git("merge-base", "HEAD", base)?.trim() || null;
const listed = mergeBase ? [git("diff", "--name-only", "--no-renames", "-z", mergeBase), git("ls-files", "--others", "--exclude-standard", "-z")] : null;
const changed = listed?.every((out) => out !== null) ? [...new Set(listed.join("\0").split("\0").filter(Boolean))].sort() : null;

// Shared connection inventory and conformance suite (Connections release gate).
const INVENTORY_TEST = "tests/connection-confirmation.test.ts";
const isDocs = (file) => !file.startsWith("src/") && (file.endsWith(".md") || file.startsWith("docs/"));
// Dependency, compiler, test-runner, CI or verify changes: impact unknown.
const FULL_INPUTS = /^(package(-lock)?\.json|tsconfig[^/]*\.json|vite(st)?\.(config|workspace)\.[^/]+|scripts\/verify\.mjs|\.github\/.+)$/;
const MAPPED = /^(src|tests|scripts|contracts|config|copy-rehearsal|\.do)\/|^(Dockerfile|\.dockerignore|\.env\.example|\.gitignore)$/;
const BUILD_INPUTS = /^(scripts\/copy-context-assets\.mjs|src\/agent-context\/.+|src\/favicon\.ico|src\/lifty-orbit-icon\.png|Dockerfile|\.dockerignore)$/;
const PILOT_INPUTS = /^(scripts\/(deploy-pilot\.py|test_deploy_pilot\.py|prepare-pilot\.mjs)|\.do\/.+)$/;
// Mirrors deploy.yml paths-ignore.
const DEPLOY_IGNORED = /^(AGENTS\.md|CLAUDE\.md|README\.md|RUNBOOK\.md|docs\/.+)$/;

const step = (name, command, ...commandArgs) => ({ name, command, args: commandArgs });
const POLICY = [step("HubSpot policy check", "npm", "run", "policy:check"), step("HubSpot policy tests", "npm", "run", "test:policy")];
const TYPECHECK = step("Typecheck", "npm", "run", "typecheck");
// The whole suite runs in about 20 s locally and 50 s on CI, and several
// tests read Markdown and JSON fixtures that `vitest related` cannot trace,
// so the light tier runs all of it, the connection inventory included.
const TESTS = step("Vitest suite (connection inventory included)", "npm", "test");
const INVENTORY = step("Connection inventory and conformance", "npm", "test", "--", INVENTORY_TEST);
const BUILD = step("Build", "npm", "run", "build");
const PILOT = step("Deploy-pilot unit tests", "python3", "-m", "unittest", "discover", "-s", "scripts", "-p", "test_deploy_pilot.py");

const trigger = changed?.find((file) => FULL_INPUTS.test(file) || (!isDocs(file) && !MAPPED.test(file)));
let tier;
let steps;
if (full || !changed || trigger) {
  tier = full ? "full tier (requested)" : `full tier (impact unknown: ${changed ? `${trigger} changed` : `no merge-base with ${base}`})`;
  steps = [...POLICY, TYPECHECK, TESTS, BUILD, PILOT];
} else if (changed.every(isDocs)) {
  tier = changed.length ? "docs-only change: prose, link and diff checks apply" : `no changes against ${base}`;
  steps = [INVENTORY];
} else {
  tier = "light tier";
  steps = [...POLICY, TYPECHECK, TESTS];
  if (changed.some((file) => BUILD_INPUTS.test(file))) steps.push(BUILD);
  if (changed.some((file) => PILOT_INPUTS.test(file))) steps.push(PILOT);
}

console.log(`verify: ${tier}`);
if (changed) {
  console.log(`verify: ${changed.length} changed file(s) against ${base} (merge-base ${mergeBase.slice(0, 12)})`);
  for (const file of changed.slice(0, 10)) console.log(`  ${file}`);
  if (changed.length > 10) console.log(`  ...and ${changed.length - 10} more`);
} else {
  console.log(`verify: changed files unknown (no merge-base with ${base})`);
}

const started = performance.now();
const results = [];
for (const { name, command, args: commandArgs } of steps) {
  console.log(`\n==> ${name}: ${[command, ...commandArgs].join(" ")}`);
  const stepStarted = performance.now();
  const run = spawnSync(command, commandArgs, { stdio: "inherit" });
  if (run.error) console.error(`verify: ${run.error.message}`);
  results.push({ name, ok: run.status === 0, seconds: (performance.now() - stepStarted) / 1000 });
  if (run.status !== 0) break;
}

const failed = results.some((result) => !result.ok);
console.log("\nverify summary:");
for (const { name, ok, seconds } of results) console.log(`  ${ok ? "ok    " : "FAILED"}  ${seconds.toFixed(1).padStart(6)}s  ${name}`);
for (const { name } of steps.slice(results.length)) console.log(`  skipped           ${name}`);
console.log(`  total ${((performance.now() - started) / 1000).toFixed(1)}s, ${failed ? "FAILED" : "passed"}`);

const proofs = [
  [(file) => !isDocs(file), "Verify / verify, full tier, on the release pull request develop -> main (npm run verify:full)"],
  [(file) => !DEPLOY_IGNORED.test(file), "Deploy / deploy on the push to main: reuses a passing full-tier Verify of the same tree or runs npm run verify:full, then deploys lifty-api-staging and runs the smoke suite"],
  [(file) => PILOT_INPUTS.test(file) || file === ".github/workflows/verify.yml", "Verify / deploy-pilot on the push to staging, when CONNECTION_PROFILE_ENABLED=true"],
  [(file) => file === ".github/workflows/sync-staging.yml", "Sync staging / sync on the push to main"],
].filter(([applies]) => !changed || changed.some(applies)).map(([, proof]) => proof);
console.log(`\nCI-only proofs for this diff:${proofs.length ? "" : " none"}`);
for (const proof of proofs) console.log(`  - ${proof}`);
process.exit(failed ? 1 : 0);
