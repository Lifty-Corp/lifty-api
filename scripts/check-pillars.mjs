#!/usr/bin/env node
// Engineering pillars check (LIF-1831). A pillar is a rule, a model file and this
// check. pillars.exceptions.json freezes the violations that already exist: the
// list can only shrink, so new code follows the rule and old code migrates.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";

const RULES_URL =
  "https://linear.app/lifty-corp/document/lead-gen-system-engineering-pillars-d387e90e3f29";
const EXCEPTIONS_FILE = "pillars.exceptions.json";

// Repository checks. `check` returns the current violations as
// [{ path, line, message }], with paths relative to the repository root.
const PILLARS = {
  validation: { model: "src/attio-oauth.ts", check: findValidationViolations },
};

// Generated code belongs to its sync script and its shared contract.
function sourceFiles() {
  return readdirSync("src", { recursive: true })
    .map((file) => `src/${file}`)
    .filter((path) => path.endsWith(".ts") && !path.startsWith("src/generated/"))
    .sort()
    .map((path) => ({ path, text: readFileSync(path, "utf8") }));
}

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

// Inline scripts the browser runs: they hold no server transport or schema.
const BROWSER_SCRIPTS = new Set(["src/auth-browser.ts", "src/cli-auth-page.ts", "src/connection-confirmation.ts"]);

const CAST_JSON = /(?:\.json\(\)|JSON\.parse\()[^;\n]*\s+as\s+(?!unknown\b)/g;
const UNTYPED_JSON = /(?:const|let)\s+\w+\s*=\s*await\s+[\w.?]+\.json\(\)/g;
const UNBOUNDED_BODY = /\.req\.(?:json|text|formData|parseBody)\(/g;
const BODY_TEXT_PARSE = /(\w+)\s*=\s*JSON\.parse\(\w+\.text\)/g;

function findValidationViolations() {
  const violations = [];
  for (const { path, text } of sourceFiles()) {
    const report = (index, message) => violations.push({ path, line: lineOf(text, index), message });
    for (const { index } of text.matchAll(CAST_JSON)) report(index, "JSON is cast instead of parsed with zod.");
    if (!BROWSER_SCRIPTS.has(path)) {
      for (const { index } of text.matchAll(UNTYPED_JSON)) report(index, "Response JSON is used as `any` instead of parsed with zod.");
    }
    for (const { index } of text.matchAll(UNBOUNDED_BODY)) {
      report(index, "Read a request body with readRequestTextWithinLimit, then parse it with zod.");
    }
    for (const { 1: body, index } of text.matchAll(BODY_TEXT_PARSE)) {
      const handler = text.slice(index).split("\n").slice(0, 6).join("\n");
      if (!new RegExp(`\\.(?:safeParse|parse)\\(${body}\\b`).test(handler)) {
        report(index, "A request body reaches its handler without a zod parse.");
      }
    }
  }
  return violations;
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

// The exception list at the merge-base. Null means there is nothing to compare
// with: the list is new on this branch, or the base is not available (a shallow
// CI clone). The counts in the working tree are still enforced in those cases.
function baseExceptions(baseRef) {
  try {
    const mergeBase = git("merge-base", baseRef, "HEAD").trim();
    return JSON.parse(git("show", `${mergeBase}:${EXCEPTIONS_FILE}`));
  } catch {
    return null;
  }
}

function checkPillars(exceptions) {
  const failures = [];
  for (const pillar of Object.keys(exceptions)) {
    if (!PILLARS[pillar]) failures.push(`${EXCEPTIONS_FILE}: unknown pillar "${pillar}".`);
  }

  for (const [pillar, { model, check }] of Object.entries(PILLARS)) {
    const byFile = new Map();
    for (const violation of check()) {
      byFile.set(violation.path, [...(byFile.get(violation.path) ?? []), violation]);
    }

    const frozen = exceptions[pillar] ?? {};
    for (const [path, violations] of byFile) {
      if (violations.length <= (frozen[path]?.count ?? 0)) continue;
      for (const { line, message } of violations) {
        failures.push(`${path}:${line} [${pillar}] ${message} Copy ${model}. Rule: ${RULES_URL}`);
      }
    }

    for (const [path, { count, reason }] of Object.entries(frozen)) {
      const actual = byFile.get(path)?.length ?? 0;
      if (actual < count) {
        failures.push(
          `${EXCEPTIONS_FILE}: [${pillar}] ${path} lists ${count} but has ${actual}. Lower the count, or delete the entry at 0.`,
        );
      }
      if (typeof reason !== "string" || !reason.trim()) {
        failures.push(`${EXCEPTIONS_FILE}: [${pillar}] ${path} needs a reason.`);
      }
    }
  }
  return failures;
}

function checkListDidNotGrow(exceptions, base) {
  const failures = [];
  for (const [pillar, files] of Object.entries(exceptions)) {
    for (const [path, { count }] of Object.entries(files)) {
      const before = base[pillar]?.[path]?.count ?? 0;
      if (count > before) {
        failures.push(
          `${EXCEPTIONS_FILE}: [${pillar}] ${path} grew from ${before} to ${count}. The list only shrinks: fix the code instead. Rule: ${RULES_URL}`,
        );
      }
    }
  }
  return failures;
}

function main() {
  const baseFlag = process.argv.indexOf("--base");
  const baseRef = baseFlag === -1 ? "origin/develop" : process.argv[baseFlag + 1];

  const exceptions = existsSync(EXCEPTIONS_FILE)
    ? JSON.parse(readFileSync(EXCEPTIONS_FILE, "utf8"))
    : {};
  const base = baseExceptions(baseRef);
  const failures = [
    ...checkPillars(exceptions),
    ...(base ? checkListDidNotGrow(exceptions, base) : []),
  ];

  if (failures.length) {
    console.error(`Engineering pillars check failed:\n${failures.join("\n")}`);
    process.exit(1);
  }
  console.log("Engineering pillars check passed.");
}

main();
