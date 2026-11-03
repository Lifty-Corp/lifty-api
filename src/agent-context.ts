import { operationToolNames } from "./operation-names.js";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { z } from "zod";
import {
  StageErrorSchema,
  StageOperationSchema,
  stageOperations,
  type StageOperation,
} from "./stage-contracts.js";
import { writingRulesSection, type WorkspaceWritingRules } from "./writing-rules.js";

// The transport an installed client implements: authentication, the request
// envelope, the context document and the operation catalog format. It is not
// a version of the API or its guidance: releases ship their context here and
// keep this value, so founders never update the skill for them (LIF-1293).
// tests/installed-client.test.ts holds what installed clients depend on.
export const STAGE_CLIENT_CONTRACT = "lifty-cli-context.v11";
// v10 (CLI 0.1.0-next.34) was retired once v11 (0.1.0-next.35) shipped: the
// one planned forced update (LIF-1296). Add a contract here only for a
// deliberate transport change, and keep the previous one until its client ships.
export const SUPPORTED_CLIENT_CONTRACTS: readonly string[] = [STAGE_CLIENT_CONTRACT];
export const isSupportedClientContract = (value: string | null | undefined) =>
  typeof value === "string" && SUPPORTED_CLIENT_CONTRACTS.includes(value);
export const CLIENT_UPGRADE_MESSAGE = `Update the installed LIFTY CLI and skill to ${STAGE_CLIENT_CONTRACT}. Earlier client contracts are retired. Reload the updated client; setup resumes from the server draft.`;
// A served draft (LIF-1298): which context file it replaced and its revision.
const ServedDraftSchema = z.object({
  draft_ref: z.uuid(),
  file: z.string(),
  revision: z.number().int().positive(),
});
export const AgentContextSchema = z.object({
  format: z.literal("lifty-context.v1"),
  task: z.string().min(1),
  revision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  instructions: z.string().min(1),
  schemas: z.record(z.string(), z.record(z.string(), z.unknown())),
  references: z.record(z.string(), z.string()),
  operations: z.record(z.string(), StageOperationSchema).optional(),
  // Present only when a test workspace's draft replaced a published file.
  drafts: z.array(ServedDraftSchema).optional(),
});

// Only checked-in public guidance goes here. Tenant data and the Scout base
// remain behind the authenticated setup generation-context boundary. Every
// document names the files it is built from, so a draft replaces one file
// wherever it is used (LIF-1298).
const contextDirectory = new URL("./agent-context/", import.meta.url);
export const CONTEXT_FILES: Readonly<Record<string, string>> = Object.fromEntries(
  readdirSync(contextDirectory)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => [name.slice(0, -3), readFileSync(new URL(name, contextDirectory), "utf8")]),
);

/** A draft of one context file for the caller's test workspace. */
export interface ContextDraft {
  draft_ref: string;
  file: string;
  revision: number;
  content: string;
}

interface DocumentSource {
  instructions: string;
  references: Record<string, string>;
  operations?: Record<string, StageOperation>;
}
const documentSources: Record<string, DocumentSource> = {
  "step-sample": { instructions: "step-sample", references: {} },
  "step-review": {
    instructions: "step-review",
    references: { calibration: "calibration", company_mapping: "company-mapping" },
  },
};
const stageSources: Record<string, DocumentSource> = Object.fromEntries(
  Object.entries(stageOperations).map(([stage, operations]) => [
    stage,
    {
      instructions: stage,
      operations,
      references: {
        common: "stage-common",
        ...(["crm", "notifications"].includes(stage)
          ? { connections: "stage-connections" }
          : {}),
        // The interview carries the founder voice and first-reply rules;
        // configuration carries the criteria authoring rules a persona edit
        // needs to regenerate criteria in the same targeting PATCH.
        ...(stage === "business" ? { interview: "interview" } : {}),
        ...(["setup", "targeting", "research-criteria"].includes(stage)
          ? { interview: "interview", configuration: "configuration" }
          : {}),
        ...(["targeting", "research-criteria", "sample-review"].includes(stage)
          ? { calibration: "calibration" }
          : {}),
        // The campaigns stage already carries campaigns.md as its instructions.
        ...(stage === "journeys" ? { campaign: "campaigns" } : {}),
        ...(["campaigns", "journeys"].includes(stage)
          ? { writing: "writing", anti_slop: "anti-slop" }
          : {}),
        ...(stage === "crm" ? { company_mapping: "company-mapping" } : {}),
      },
    },
  ]),
);
const indexSource: DocumentSource = {
  instructions: "stages",
  references: { common: "stage-common" },
  operations: {},
};
const sourceFor = (task: string) =>
  task === "stages"
    ? indexSource
    : Object.hasOwn(stageSources, task)
      ? stageSources[task]
      : Object.hasOwn(documentSources, task)
        ? documentSources[task]
        : undefined;

/** Every published file and where documents use it, for the ops editor. */
export function contextFileUsage() {
  const usage: Record<string, Array<{ task: string; as: string }>> = {};
  const sources: Array<[string, DocumentSource]> = [
    ["stages", indexSource],
    ...Object.entries(documentSources),
    ...Object.entries(stageSources),
  ];
  for (const [task, source] of sources) {
    (usage[source.instructions] ??= []).push({ task, as: "instructions" });
    for (const [name, file] of Object.entries(source.references)) {
      (usage[file] ??= []).push({ task, as: `references.${name}` });
    }
  }
  return usage;
}

// The CLI noun after "lifty <verb> <resource>"; a noun equal to the verb is implicit.
function cliNoun(key: string, op: StageOperation) {
  const noun = op.cli?.operation ?? key;
  return noun === op.method.toLowerCase() ? "" : ` ${noun}`;
}
function operationGuide(
  stage: string,
  operations: Record<string, StageOperation>,
) {
  return (
    `## ${stage} operations\n\n` +
    Object.entries(operations)
      .filter(([, op]) =>
        Object.keys(op.responses).some((code) => code.startsWith("2")),
      )
      .map(
        ([key, op]) =>
          `- ${op.route === `/v1/context/${stage}` ? `lifty context ${stage}` : `lifty ${op.method.toLowerCase()} ${stage}${cliNoun(key, op)}`} → ${op.method} ${op.route}; MCP ${operationToolNames(stage, key).join(" / ")}`,
      )
      .join("\n")
  );
}

// Every error response shares one envelope. Publishing it once per document
// instead of once per status code halves the operation payload; clients
// route by method, route and request schema, never by error schemas.
const errorSchema = compactSchema(z.toJSONSchema(StageErrorSchema)) as Record<
  string,
  unknown
>;
function compactSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactSchema);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "$schema")
      .map(([key, item]) => [key, compactSchema(item)]),
  );
}
// Success schemas were most of every document (112K of sending-accounts' 153K
// characters; deliverability alone 49K), beyond MCP connectors' tool-result
// limit (LIF-1338). The agent reads the actual response, so a document keeps
// only the response's outline: types, required fields and short enums two
// levels deep. Full schemas stay in /openapi.json; no client parses these.
const OUTLINE_DEPTH = 2;
function responseOutline(value: unknown, depth = 0): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const schema = value as Record<string, unknown>;
  const outline: Record<string, unknown> = {};
  for (const key of ["type", "const", "required"] as const) if (schema[key] !== undefined) outline[key] = schema[key];
  if (Array.isArray(schema.enum) && schema.enum.length <= 12) outline.enum = schema.enum;
  for (const key of ["anyOf", "oneOf"] as const)
    if (Array.isArray(schema[key])) outline[key] = (schema[key] as unknown[]).map((branch) => responseOutline(branch, depth));
  if (schema.items) outline.items = depth < OUTLINE_DEPTH ? responseOutline(schema.items, depth + 1) : {};
  if (schema.properties && typeof schema.properties === "object")
    outline.properties = Object.fromEntries(Object.entries(schema.properties as Record<string, unknown>).map(([name, child]) =>
      [name, depth < OUTLINE_DEPTH ? responseOutline(child, depth + 1) : typeOnly(child)]));
  return outline;
}
const typeOnly = (value: unknown) =>
  value && typeof value === "object" && "type" in value ? { type: (value as { type: unknown }).type } : {};
// An outline several operations return (Campaign message reads and reviews,
// sending-account changes) is published once in the document's schemas.
function compactOperations(operations: Record<string, StageOperation>) {
  const outlines = Object.entries(operations).flatMap(([name, operation]) =>
    Object.entries(operation.responses).filter(([status]) => status.startsWith("2"))
      .map(([status, schema]) => ({ key: `${name}_${status}`, outline: responseOutline(compactSchema(schema)) })));
  const shared = new Map<string, string>();
  for (const { key, outline } of outlines) {
    const text = JSON.stringify(outline);
    if (!shared.has(text) && outlines.filter((item) => JSON.stringify(item.outline) === text).length > 1) shared.set(text, `response_${key}`);
  }
  const schemas = Object.fromEntries([...shared].map(([text, name]) => [name, JSON.parse(text) as Record<string, unknown>]));
  const response = (name: string, status: string) => {
    const outline = outlines.find((item) => item.key === `${name}_${status}`)!.outline;
    const ref = shared.get(JSON.stringify(outline));
    return ref ? { $ref: `#/schemas/${ref}` } : outline;
  };
  return {
    schemas,
    operations: Object.fromEntries(
      Object.entries(operations).map(([name, operation]) => [
        name,
        {
          ...operation,
          request: compactSchema(operation.request) as StageOperation["request"],
          responses: Object.fromEntries(
            Object.entries(operation.responses).map(([status]) => [
              status,
              status.startsWith("2") ? response(name, status) : { $ref: "#/schemas/error" },
            ]),
          ),
        },
      ]),
    ),
  };
}

// The file whose served text ends with the caller workspace's own writing
// rules (LIF-1724). Each workspace saves its copy in commercial voice, so no
// list is checked in here and a public read carries none.
const WRITING_RULES_FILE = "anti-slop";
const NO_SESSION: WorkspaceWritingRules = { state: "no_session" };

/** Whether a document, or a step guide with these references, serves the
 * writing rules file, so its caller reads the workspace's copy for it. */
export function servesWritingRules(task: string, references?: readonly string[]) {
  const source = sourceFor(task);
  if (!source) return false;
  return source.instructions === WRITING_RULES_FILE
    || (references ?? Object.keys(source.references)).some((name) => source.references[name] === WRITING_RULES_FILE);
}

// Reads a document's files, the caller's draft winning over the published
// file. Drafts for files this document does not use are ignored.
function fileReader(drafts: readonly ContextDraft[], writingRules: WorkspaceWritingRules) {
  const served = new Map<string, ContextDraft>();
  const read = (file: string) => {
    const draft = drafts.find((item) => item.file === file);
    let content: string;
    if (draft) {
      served.set(file, draft);
      content = draft.content;
    } else {
      const published = CONTEXT_FILES[file];
      if (published === undefined) throw new Error(`Missing context file ${file}`);
      content = published;
    }
    return file === WRITING_RULES_FILE ? `${content.trimEnd()}\n\n${writingRulesSection(writingRules)}\n` : content;
  };
  const marker = () =>
    served.size
      ? {
          drafts: [...served.values()]
            .sort((a, b) => a.file.localeCompare(b.file))
            .map(({ draft_ref, file, revision }) => ({ draft_ref, file, revision })),
        }
      : {};
  return { read, marker };
}

const withRevision = <T extends object>(content: T) =>
  AgentContextSchema.parse({
    ...content,
    revision: `sha256:${createHash("sha256").update(JSON.stringify(content)).digest("hex")}`,
  });

export function getAgentContext(task: string, drafts: readonly ContextDraft[] = [], writingRules = NO_SESSION) {
  const source = sourceFor(task);
  if (!source) return null;
  const { read, marker } = fileReader(drafts, writingRules);
  const instructions = read(source.instructions);
  const references = Object.fromEntries(
    Object.entries(source.references).map(([name, file]) => [name, read(file)]),
  );
  const compacted = source.operations && task !== "stages" ? compactOperations(source.operations) : null;
  const content = {
    format: "lifty-context.v1" as const,
    task,
    instructions:
      task === "stages"
        ? `${instructions}\n${Object.keys(stageOperations)
            .map((stage) => `- [${stage}](/v1/context/${stage})`)
            .join("\n")}\n${Object.entries(stageOperations)
            .map(([stage, operations]) => operationGuide(stage, operations))
            .join("\n")}`
        : source.operations
          ? `${instructions}\n${operationGuide(task, source.operations)}`
          : instructions,
    // Compact per call: operation definitions stay live objects (routes can
    // change at runtime in tests and the revision must follow them). Key
    // order is part of the revision: stage documents put operations before
    // references, the index after.
    schemas: compacted ? { error: errorSchema, ...compacted.schemas } : {},
    ...(compacted ? { operations: compacted.operations } : {}),
    references,
    ...(task === "stages" ? { operations: {} } : {}),
    ...marker(),
  };
  return withRevision(content);
}

// What next_step inlines for one step: the stage's instructions and only the
// references that step needs. Operation schemas stay in the full stage guide,
// one summary_context call away, so every response stays small enough for
// chat connectors (LIF-1149, LIF-1295).
export function getStepGuide(task: string, references: readonly string[], drafts: readonly ContextDraft[] = [], writingRules = NO_SESSION) {
  const source = sourceFor(task);
  if (!source) return null;
  const used = drafts.filter(
    (draft) =>
      draft.file === source.instructions ||
      references.some((name) => source.references[name] === draft.file),
  );
  const stage = getAgentContext(task, used, writingRules)!;
  const content = {
    format: stage.format,
    task: stage.task,
    instructions: stage.instructions,
    schemas: {},
    references: Object.fromEntries(references.map((name) => {
      if (!Object.hasOwn(stage.references, name)) throw new Error(`Unknown ${task} reference ${name}`);
      return [name, stage.references[name]!];
    })),
    ...(stage.drafts ? { drafts: stage.drafts } : {}),
  };
  return withRevision(content);
}
