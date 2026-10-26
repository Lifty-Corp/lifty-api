// Generated from lift-gtm-dashboard/lib/crm-shared/evaluator.ts; regenerate with scripts/sync-crm-contract.mjs.

import { expectedDashboardRecovery } from "../dashboard-errors/policy.js";
// Shared pure CRM contract from lift-gtm-jobs (LIF-740/741/742/743).
// Keep behavior aligned; crm-shared-conformance.test.ts runs the jobs fixtures.

import type { ScoutContractField } from "./scout-input.js";
import { inspectExecutableMappings, mappingCollisionKey } from "./executable.js";
import type { BuildCrmPropertyPayloadInput, BuildCrmPropertyPayloadResult, BuildScoutResearchSchemaInput, CrmFieldMapping, CrmTransform, CrmWriteRule, JsonObject, JsonSchema } from "./types.js";
const SKIP_VALUE = "skip";

export function buildCrmPropertyPayload(
  input: BuildCrmPropertyPayloadInput,
): BuildCrmPropertyPayloadResult {
  const result: BuildCrmPropertyPayloadResult = {
    payload: {},
    pushed: [],
    skipped_no_value: [],
    skipped_write_rule: [],
  };

  const applicable = input.mappings.filter((row) => row.enabled && row.provider === input.provider && row.source_stage === input.stage && row.destination_object === input.destinationObject);
  const findings = inspectExecutableMappings(applicable);
  if (findings.length) throw new Error(findings.map((f) => `${f.code}: ${f.message}`).join("; "));
  const chosen = new Set<string>();
  // Evaluate shared source payload before source-entity filtering so a fallback
  // spanning lead/company cannot overwrite the higher-priority candidate.
  const groups = new Map<string, CrmFieldMapping[]>();
  for (const row of applicable) {
    const key = mappingCollisionKey(row);
    const group = groups.get(key) ?? [];
    group.push(row); groups.set(key, group);
  }
  const ordered = [...groups.values()].flatMap((group) =>
    group.sort((a, b) => (a.fallback_priority ?? 0) - (b.fallback_priority ?? 0)));
  for (const mapping of ordered) {
    if (
      !mapping.enabled ||
      mapping.source_stage !== input.stage ||
      mapping.destination_object !== input.destinationObject ||
      !mapping.destination_field
    ) {
      continue;
    }

    const source_path = pathToString(mapping.source_path);
    const rawValue = resolveMappingValue(mapping, input);
    const transformed = transformCrmValue(
      rawValue,
      mapping.transform,
      mapping.transform_config,
    );
    const value = coerceCrmValue(transformed);
    const entry = {
      source_field: mapping.source_field,
      source_path,
      destination_field: mapping.destination_field,
    };

    if (value === null) {
      result.skipped_no_value.push(entry);
      continue;
    }

    const collisionKey = mappingCollisionKey(mapping);
    if (chosen.has(collisionKey)) continue;
    chosen.add(collisionKey);
    if (mapping.source_entity !== input.sourceEntity) continue;

    if (
      !shouldWriteField(
        mapping.write_rule,
        input.writeMode,
        input.existingProperties?.[mapping.destination_field],
        hasOwn(input.existingProperties, mapping.destination_field),
        value,
        mapping.transform_config,
      )
    ) {
      result.skipped_write_rule.push({
        ...entry,
        value,
        write_rule: mapping.write_rule,
      });
      continue;
    }

    result.payload[mapping.destination_field] = value;
    result.pushed.push({ ...entry, value });
  }

  return result;
}


/** Canonical CRM destination. */
export function buildScoutResearchSchema(
  input: BuildScoutResearchSchemaInput,
): JsonSchema {
  if (input.approaches && input.approaches.length === 0) {
    throw new Error("Scout schema requires at least one eligible workspace approach");
  }
  const schema = cloneSchema(input.baseSchema);
  schema.title = input.schemaName;
  schema.type = schema.type ?? "object";
  schema.properties = schema.properties ?? {};
  schema.required = schema.required ?? [];

  if (input.approaches) {
    const approachType = schema.properties.approach_type ?? {};
    schema.properties.approach_type = approachType;
    approachType.type = "string";
    approachType.enum = [...input.approaches];
    addRequired(schema, "approach_type");
  }

  const seen = new Set<string>();
  let customFields: JsonSchema | null = null;
  for (const mapping of input.mappings) {
    if (
      !mapping.enabled ||
      mapping.source_stage !== "research" ||
      !mapping.required_from_agent ||
      mapping.source_path[0] !== "custom_fields"
    ) {
      continue;
    }

    const relativePath = mapping.source_path.slice(1);
    if (relativePath.length === 0) continue;
    if (!customFields) {
      customFields = ensureObjectProperty(schema, "custom_fields");
      addRequired(schema, "custom_fields");
    }
    const key = pathToString(relativePath);
    if (seen.has(key)) continue;
    seen.add(key);

    setRequiredSchemaPath(
      customFields,
      relativePath,
      schemaTypeForMapping(mapping),
      mapping.label ?? mapping.source_field,
    );
  }

  return schema;
}

function resolveMappingValue(
  mapping: CrmFieldMapping,
  input: BuildCrmPropertyPayloadInput,
): unknown {
  switch (mapping.value_source) {
    case "path":
      return readPath(input.source, mapping.source_path);
    case "constant":
      return mapping.transform_config.constant_value;
    case "runtime":
      return readPath(input.runtime ?? {}, mapping.source_path);
    case "counterpart_property":
      return readPath(input.counterpartProperties ?? {}, mapping.source_path);
  }
}

function readPath(source: unknown, path: string[]): unknown {
  let current = source;
  for (const segment of path) {
    if (current == null) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function transformCrmValue(
  value: unknown,
  transform: CrmTransform,
  config: JsonObject,
): unknown {
  switch (transform) {
    case "none":
      return value;
    case "bucket":
      return bucketValue(value, config);
    case "map_value":
      return mapValue(value, config);
    case "join_list":
      return joinList(value, config);
    case "json_string":
      return value === null || value === undefined ? null : JSON.stringify(value);
    case "scale_number":
      return scaleNumber(value, config);
    case "normalize_domain":
      // Canonical bare host (strip scheme + leading www.) so company search
      // and create share one dedup key. Unparseable values resolve to null.
      return typeof value === "string" && value.trim()
        ? extractDomain(value.trim())
        : null;
  }
}

function scaleNumber(value: unknown, config: JsonObject): unknown {
  if (isSkippedValue(value, config.skip_values)) return null;

  const numeric = parseFiniteNumber(value);
  if (!Number.isFinite(numeric)) return null;

  const scale = typeof config.scale === "number" ? config.scale : 1;
  const scaled = numeric * scale;
  return config.round === true ? Math.round(scaled) : scaled;
}

function parseFiniteNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) return Number(value);
  return Number.NaN;
}

function bucketValue(value: unknown, config: JsonObject): unknown {
  if (isSkippedValue(value, config.skip_values)) return null;

  const numeric = parseFiniteNumber(value);
  if (!Number.isFinite(numeric)) return null;

  const buckets = Array.isArray(config.buckets) ? config.buckets : [];
  for (const bucket of buckets) {
    if (!bucket || typeof bucket !== "object") continue;
    const candidate = bucket as JsonObject;
    const min = typeof candidate.min === "number" ? candidate.min : null;
    const max =
      typeof candidate.max === "number"
        ? candidate.max
        : candidate.max === null
          ? null
          : undefined;
    const label =
      typeof candidate.label === "string"
        ? candidate.label
        : typeof candidate.to === "string"
          ? candidate.to
          : null;
    if (!label) continue;
    if (min !== null && numeric < min) continue;
    if (max !== undefined && max !== null && numeric > max) continue;
    return label;
  }

  return null;
}

function isSkippedValue(value: unknown, skipValues: unknown): boolean {
  if (!Array.isArray(skipValues)) return false;
  return skipValues.some((skipValue) => value === skipValue);
}

function mapValue(value: unknown, config: JsonObject): unknown {
  if (value === null || value === undefined) return null;
  const key = String(value).trim();
  const map =
    config.map && typeof config.map === "object" && !Array.isArray(config.map)
      ? (config.map as Record<string, unknown>)
      : {};
  const mapped = map[key] ?? map[key.toLowerCase()];
  if (mapped === SKIP_VALUE) return null;
  if (mapped !== undefined) return mapped;
  if (config.fallback === "uppercase_snake") {
    return key
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toUpperCase();
  }
  return value;
}

function joinList(value: unknown, config: JsonObject): unknown {
  if (!Array.isArray(value) || value.length === 0) return null;
  const separator =
    typeof config.separator === "string"
      ? config.separator
      : typeof config.join_separator === "string"
        ? config.join_separator
        : ", ";
  const parts = value
    .filter((item) => item !== null && item !== undefined && item !== "")
    .map((item) => (typeof item === "string" ? item : JSON.stringify(item)));
  return parts.length > 0 ? parts.join(separator) : null;
}

function coerceCrmValue(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : null;
  return JSON.stringify(value);
}

function shouldWriteField(
  rule: CrmWriteRule,
  writeMode: "create" | "update",
  existingValue: unknown,
  existingValueKnown: boolean,
  desiredValue: string,
  transformConfig: JsonObject,
): boolean {
  switch (rule) {
    case "create_only":
      return writeMode === "create";
    case "only_if_empty":
      if (writeMode === "create") return true;
      if (writeMode === "update" && !existingValueKnown) return false;
      return isEmptyCrmValue(existingValue);
    case "overwrite_lift_field":
      return true;
    case "managed_enum_transition": {
      if (writeMode === "create") return true;
      if (!existingValueKnown) return false;
      if (isEmptyCrmValue(existingValue)) return true;
      if (String(existingValue) === desiredValue) return false;
      const managedValues = Array.isArray(transformConfig.managed_values)
        ? transformConfig.managed_values.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      return managedValues.includes(String(existingValue));
    }
  }
}

function isEmptyCrmValue(value: unknown): boolean {
  return value === null || value === "";
}

function hasOwn(source: Record<string, unknown> | undefined, key: string): boolean {
  return source ? Object.prototype.hasOwnProperty.call(source, key) : false;
}

function cloneSchema(schema: JsonSchema): JsonSchema {
  return JSON.parse(JSON.stringify(schema)) as JsonSchema;
}

function ensureObjectProperty(parent: JsonSchema, key: string): JsonSchema {
  parent.properties = parent.properties ?? {};
  const existing = parent.properties[key];
  if (existing) {
    existing.type = existing.type ?? "object";
    existing.properties = existing.properties ?? {};
    existing.required = existing.required ?? [];
    return existing;
  }

  const child: JsonSchema = {
    type: "object",
    properties: {},
    required: [],
  };
  parent.properties[key] = child;
  return child;
}

function setRequiredSchemaPath(
  root: JsonSchema,
  path: string[],
  type: string,
  label: string,
): void {
  let current = root;
  for (const [index, segment] of path.entries()) {
    const isLeaf = index === path.length - 1;
    addRequired(current, segment);
    if (isLeaf) {
      current.properties = current.properties ?? {};
      current.properties[segment] = {
        type,
        description: label,
      };
      return;
    }
    current = ensureObjectProperty(current, segment);
  }
}

function addRequired(schema: JsonSchema, key: string): void {
  schema.required = schema.required ?? [];
  if (!schema.required.includes(key)) {
    schema.required.push(key);
  }
}

function schemaTypeForMapping(mapping: ScoutContractField): string {
  const sourceType = mapping.transform_config.source_type;
  const type = typeof sourceType === "string" ? sourceType : undefined;
  switch (type) {
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
    case "array_csv":
      return "array";
    case "object":
    case "json":
      return "object";
    default:
      return "string";
  }
}

function pathToString(path: string[]): string {
  return path.join(".");
}

function extractDomain(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const hostname = new URL(url.startsWith("http") ? url : `https://${url}`).hostname;
    return hostname.replace(/^www\./, "");
  } catch {
      expectedDashboardRecovery("invalid-input", undefined);
    return null;
  }
}
