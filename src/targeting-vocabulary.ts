import { z } from "zod";
import { INDUSTRY_LABELS } from "./generated/industry-labels.js";
import { NAICS_2022 } from "./generated/naics-2022.js";

// LIF-1694: discovery passes industries and NAICS codes to search verbatim, and
// an unknown value finds nobody instead of failing. Writes accept only the
// generated label list and 2022 NAICS codes; reads stay tolerant so a value
// saved before this check still loads and is reported for repair.
export { INDUSTRY_LABELS };
const LABELS: ReadonlySet<string> = new Set(INDUSTRY_LABELS);
const CODES = Object.keys(NAICS_2022);
const MAX_OPTIONS = 5;
const MAX_ISSUES = 20;

/** Published like the seniority enum; targetingVocabularyIssues enforces it with repair options. */
export const IndustryLabelInputSchema = z.string().trim().min(1).max(200).meta({ enum: [...INDUSTRY_LABELS] });
export const NaicsCodeInputSchema = z
  .string()
  .regex(/^[0-9]{2,6}$/)
  .meta({ description: "2022 NAICS code; write sector 31-33 as 31, 32 or 33." });

type RepairIssue = { code: string; path: string; message: string; suggestion: string };
const FIELDS = ["industries", "industry_codes", "excluded_industry_codes"] as const;
const pointer = (parts: readonly (string | number)[]) =>
  `/${parts.map((part) => String(part).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;
const quote = (value: string) => JSON.stringify(value.length > 200 ? `${value.slice(0, 200)}…` : value);
const NEVER_ASK = "Translate the founder's words yourself; never ask the founder for labels or codes.";

const normalize = (value: string) => value.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
const STOP = new Set(["and", "the", "for", "with", "other"]);
const words = (value: string) => normalize(value).split(" ").filter((word) => word.length > 2 && !STOP.has(word));
const grams = (value: string) => {
  const text = ` ${words(value).join(" ")} `;
  return new Set(Array.from({ length: Math.max(0, text.length - 2) }, (_, index) => text.slice(index, index + 3)));
};
const related = (a: string, b: string) => a === b || (a.length >= 5 && b.length >= 5 && a.slice(0, 5) === b.slice(0, 5));
function similarity(value: string, label: string) {
  if (normalize(value) === normalize(label)) return 3;
  const valueWords = words(value);
  const labelWords = words(label);
  const shared = valueWords.filter((word) => labelWords.some((other) => related(word, other))).length;
  const a = grams(value);
  const b = grams(label);
  const common = [...a].filter((gram) => b.has(gram)).length;
  const dice = a.size + b.size ? (2 * common) / (a.size + b.size) : 0;
  return (valueWords.length ? shared / valueWords.length : 0) + dice;
}

/** Up to five published labels closest to a rejected value, best first. */
export function closestIndustryLabels(value: string): string[] {
  const scored = INDUSTRY_LABELS.map((label) => ({ label, score: similarity(value, label) }));
  // A spelling or case variant of a label has one unambiguous repair.
  const exact = scored.filter(({ score }) => score === 3);
  return (exact.length ? exact : scored.filter(({ score }) => score >= 0.35))
    .sort((a, b) => b.score - a.score || (a.label < b.label ? -1 : 1))
    .slice(0, MAX_OPTIONS)
    .map(({ label }) => label);
}

/** Up to five 2022 NAICS codes nearest a rejected code: its deepest valid parent, then nearby codes. */
export function closestNaicsCodes(value: string): string[] {
  const digits = value.replace(/\D/g, "").slice(0, 6);
  let prefix = digits;
  while (prefix && !CODES.some((code) => code.startsWith(prefix))) prefix = prefix.slice(0, -1);
  const pool = prefix ? CODES.filter((code) => code.startsWith(prefix)) : CODES.filter((code) => code.length === 2);
  const parent = pool.filter((code) => digits.startsWith(code)).sort((a, b) => b.length - a.length)[0];
  const position = (code: string) => Number(code.padEnd(6, "0"));
  const target = Number((digits || "0").padEnd(6, "0"));
  const nearby = pool
    .filter((code) => code !== parent)
    .sort((a, b) => Math.abs(a.length - digits.length) - Math.abs(b.length - digits.length)
      || Math.abs(position(a) - target) - Math.abs(position(b) - target) || (a < b ? -1 : 1));
  return [...(parent ? [parent] : []), ...nearby].slice(0, MAX_OPTIONS);
}

function labelIssue(value: string): Omit<RepairIssue, "path"> | null {
  if (LABELS.has(value)) return null;
  const options = closestIndustryLabels(value);
  return {
    code: "industry_label_unknown",
    message: `${quote(value)} is not a searchable industry label; search finds nobody with it.`,
    suggestion: (options.length
      ? `Use the published label that keeps the founder's meaning, for example ${options.map(quote).join(", ")}.`
      : "Use a label from the published industry list.")
      + ` If no label fits, use company.industry_codes (2022 NAICS) instead. ${NEVER_ASK}`,
  };
}

function codeIssue(value: string): Omit<RepairIssue, "path"> | null {
  if (Object.hasOwn(NAICS_2022, value)) return null;
  const options = closestNaicsCodes(value);
  return {
    code: "industry_code_unknown",
    message: `${quote(value)} is not a 2022 NAICS code; search finds nobody with it.`,
    suggestion: `Use the 2022 NAICS code that keeps the founder's meaning${options.length
      ? `, for example ${options.map((code) => `"${code}" (${NAICS_2022[code]})`).join(", ")}`
      : ""}. Sectors 31-33, 44-45 and 48-49 are written as each two-digit part. ${NEVER_ASK}`.slice(0, 1000),
  };
}

/**
 * Repair issues for every industry label and NAICS code in `lanes` that search
 * cannot use. `prefix` is the JSON-pointer path of the lanes array.
 */
export function targetingVocabularyIssues(lanes: unknown, prefix: readonly (string | number)[]): RepairIssue[] {
  if (!Array.isArray(lanes)) return [];
  const issues: RepairIssue[] = [];
  lanes.forEach((lane, index) => {
    const company = lane && typeof lane === "object" ? (lane as { company?: unknown }).company : undefined;
    if (!company || typeof company !== "object") return;
    for (const field of FIELDS) {
      const values = (company as Record<string, unknown>)[field];
      if (!Array.isArray(values)) continue;
      values.forEach((value, position) => {
        if (typeof value !== "string") return;
        const issue = field === "industries" ? labelIssue(value) : codeIssue(value);
        if (issue) issues.push({ ...issue, path: pointer([...prefix, index, "company", field, position]) });
      });
    }
  });
  return issues.slice(0, MAX_ISSUES);
}
