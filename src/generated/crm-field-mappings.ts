// Generated from lift-gtm-dashboard/lib/crm-field-mappings.ts; regenerate with scripts/sync-crm-contract.mjs.
import { mappingTransformValid, validFallbackGroup } from "./crm-shared/executable.js";
import {
  buildCrmPropertyPayload,
  type CrmFieldMapping as SharedCrmFieldMapping,
} from "./crm-shared/index.js";

export type CrmProvider = "hubspot" | "attio";
export type CrmSourceStage =
  | "discovery"
  | "research"
  | "outreach"
  | "verification";
export type CrmSourceEntity = "lead" | "company";
export type CrmObjectSurface = "contact" | "company";
export type CrmMappingObject =
  | CrmObjectSurface
  | "lift_person"
  | "lift_company";
export type CrmWriteRule =
  | "create_only"
  | "only_if_empty"
  | "overwrite_lift_field"
  | "managed_enum_transition";
export type CrmTransform =
  | "none"
  | "bucket"
  | "map_value"
  | "join_list"
  | "json_string"
  | "scale_number"
  | "normalize_domain";
export type CrmValueSource =
  | "path"
  | "constant"
  | "runtime"
  | "counterpart_property";

export type JsonObject = Record<string, unknown>;

export interface CrmFieldMappingRow {
  id: string;
  workspace_id: string;
  provider: CrmProvider;
  source_stage: CrmSourceStage;
  source_entity: CrmSourceEntity;
  source_field: string;
  label: string | null;
  source_path: string[];
  destination_object: CrmMappingObject;
  destination_field: string;
  fallback_group: string | null;
  fallback_priority: number | null;
  write_rule: CrmWriteRule;
  transform: CrmTransform;
  transform_config: JsonObject;
  value_source: CrmValueSource;
  enabled: boolean;
  required_from_agent: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export type CrmFieldMappingSaveInput = Omit<
  CrmFieldMappingRow,
  "id" | "created_at" | "updated_at"
> & {
  id: string | null;
  expected_updated_at: string | null;
};

export type CrmFieldMappingWriteValues = Omit<
  CrmFieldMappingSaveInput,
  "id" | "expected_updated_at"
>;

export type CrmMappingGroupKey =
  | "discovery_contact"
  | "discovery_company"
  | "research_contact"
  | "research_company"
  | "outreach_contact"
  | "outreach_company"
  | "verification_contact"
  | "verification_company";

export const CRM_MAPPING_GROUPS: readonly {
  key: CrmMappingGroupKey;
  stage: CrmSourceStage;
  object: CrmObjectSurface;
  label: string;
}[] = [
  {
    key: "discovery_contact",
    stage: "discovery",
    object: "contact",
    label: "Discovery → Contact",
  },
  {
    key: "discovery_company",
    stage: "discovery",
    object: "company",
    label: "Discovery → Company",
  },
  {
    key: "research_contact",
    stage: "research",
    object: "contact",
    label: "Research → Contact",
  },
  {
    key: "research_company",
    stage: "research",
    object: "company",
    label: "Research → Company",
  },
  {
    key: "outreach_contact",
    stage: "outreach",
    object: "contact",
    label: "Outreach → Contact",
  },
  {
    key: "outreach_company",
    stage: "outreach",
    object: "company",
    label: "Outreach → Company",
  },
  {
    key: "verification_contact",
    stage: "verification",
    object: "contact",
    label: "Verification → Contact",
  },
  {
    key: "verification_company",
    stage: "verification",
    object: "company",
    label: "Verification → Company",
  },
] as const;

export type CrmFieldMappingGroupable = Pick<
  CrmFieldMappingRow,
  | "source_stage"
  | "destination_object"
  | "sort_order"
  | "source_path"
  | "destination_field"
>;

export type GroupedCrmFieldMappings<T extends CrmFieldMappingGroupable> = Record<
  CrmMappingGroupKey,
  T[]
>;

export function groupCrmFieldMappings<T extends CrmFieldMappingGroupable>(
  rows: readonly T[],
): GroupedCrmFieldMappings<T> {
  const grouped: GroupedCrmFieldMappings<T> = {
    discovery_contact: [],
    discovery_company: [],
    research_contact: [],
    research_company: [],
    outreach_contact: [],
    outreach_company: [],
    verification_contact: [],
    verification_company: [],
  };
  for (const row of [...rows].sort(compareMappingRows)) {
    grouped[`${row.source_stage}_${crmObjectSurface(row.destination_object)}`].push(row);
  }
  return grouped;
}

export function crmObjectSurface(
  object: CrmMappingObject,
): CrmObjectSurface {
  return object === "contact" || object === "lift_person"
    ? "contact"
    : "company";
}

function compareMappingRows(
  a: CrmFieldMappingGroupable,
  b: CrmFieldMappingGroupable,
): number {
  return (
    a.sort_order - b.sort_order ||
    sourcePathLabel(a.source_path).localeCompare(sourcePathLabel(b.source_path)) ||
    (a.destination_field ?? "").localeCompare(b.destination_field ?? "")
  );
}

export function sourcePathLabel(path: readonly string[]): string {
  return path.join(".");
}

export function destinationLabel(row: Pick<CrmFieldMappingRow, "destination_object" | "destination_field" | "write_rule">): string {
  if (!row.destination_field) return "No CRM destination";
  return `${capitalize(row.destination_object)} · ${row.destination_field}`;
}

export function valueSourceSummary(
  row: Pick<CrmFieldMappingRow, "value_source" | "source_path" | "transform_config">,
): string | null {
  switch (row.value_source) {
    case "path":
      return null;
    case "constant": {
      const constant = row.transform_config.constant_value;
      return `Constant${typeof constant === "string" ? ` "${constant}"` : ""}`;
    }
    case "runtime":
      return `Runtime · ${sourcePathLabel(row.source_path)}`;
    case "counterpart_property": {
      const from = row.transform_config.from_object;
      return `From ${typeof from === "string" ? from : "counterpart"} property · ${sourcePathLabel(row.source_path)}`;
    }
  }
}

export function transformSummary(
  row: Pick<CrmFieldMappingRow, "transform" | "transform_config">,
): string {
  const config = row.transform_config;
  const details: string[] = [];
  if (row.transform === "bucket") {
    const buckets = Array.isArray(config.buckets) ? config.buckets : [];
    details.push(`${buckets.length} ranges`);
  } else if (row.transform === "map_value") {
    const map = asRecord(config.map);
    details.push(`${map ? Object.keys(map).length : 0} values`);
  } else if (row.transform === "scale_number") {
    details.push(`×${typeof config.scale === "number" ? config.scale : 1}`);
    if (config.round === true) details.push("rounded");
  } else if (row.transform === "join_list") {
    const separator =
      typeof config.separator === "string"
        ? config.separator
        : typeof config.join_separator === "string"
          ? config.join_separator
          : ", ";
    details.push(`separator ${JSON.stringify(separator)}`);
  }
  if (Array.isArray(config.skip_values) && config.skip_values.length > 0) {
    details.push(`skip ${config.skip_values.map(String).filter(Boolean).join(", ") || "blank"}`);
  }
  return [humanize(row.transform), ...details].join(" · ");
}

export type PropertyAvailability = {
  status: "available" | "missing" | "unknown" | "not_applicable";
  label: string;
};

export function propertyAvailability(
  row: Pick<CrmFieldMappingRow, "destination_field" | "write_rule">,
  available: Set<string> | null,
): PropertyAvailability {
  if (!row.destination_field) {
    return { status: "not_applicable", label: "No destination property" };
  }
  if (available === null) {
    return { status: "unknown", label: "Portal availability unavailable" };
  }
  if (available.has(row.destination_field)) {
    return { status: "available", label: "Available in CRM" };
  }
  return { status: "missing", label: "Configured, missing in CRM" };
}

// LIF-185: property writes that used to be hardcoded (email, apollo_sync_date,
// qualification/enrichment metadata, outreach transitions, suppression) are now
// regular crm_field_mappings rows and appear in the table. Only the
// non-property mechanics remain system-managed.
export const SYSTEM_MANAGED_CRM_EFFECTS = [
  "Exact-email Contact lookup",
  "Normalized-domain Company lookup",
  "Contact → Company association",
  "Research notes controlled by the selected integration artifact policy",
  "Provider-specific field validation and bounded retries",
] as const;

export type CrmFieldMappingSavePlan =
  | {
      ok: true;
      inserts: CrmFieldMappingWriteValues[];
      updates: {
        id: string;
        expectedUpdatedAt: string;
        values: CrmFieldMappingWriteValues;
      }[];
      deletes: never[];
    }
  | { ok: false; error: string; conflict?: true };

export function planCrmFieldMappingSave(
  activeWorkspaceId: string,
  currentRows: readonly CrmFieldMappingRow[],
  edits: readonly CrmFieldMappingSaveInput[],
): CrmFieldMappingSavePlan {
  if (edits.some((edit) => edit.workspace_id !== activeWorkspaceId)) {
    return {
      ok: false,
      error: "Mapping edit does not belong to the active workspace.",
    };
  }

  const currentById = new Map(currentRows.map((row) => [row.id, row]));
  const inserts: CrmFieldMappingWriteValues[] = [];
  const updates: Extract<CrmFieldMappingSavePlan, { ok: true }>["updates"] = [];

  for (const edit of edits) {
    const error = validateSaveInput(edit);
    if (error) return { ok: false, error };
    const values = writeValues(edit, activeWorkspaceId);
    if (edit.id === null) {
      inserts.push(values);
      continue;
    }
    const current = currentById.get(edit.id);
    if (!current) return { ok: false, error: "Mapping no longer exists." };
    if (current.workspace_id !== activeWorkspaceId) {
      return {
        ok: false,
        error: "Mapping edit does not belong to the active workspace.",
      };
    }
    if (edit.expected_updated_at !== current.updated_at) {
      return {
        ok: false,
        conflict: true,
        error: `Mapping ${current.label ?? current.source_field} changed elsewhere. Reload and try again.`,
      };
    }
    if (sameWriteValues(values, currentWriteValues(current))) continue;
    updates.push({
      id: edit.id,
      expectedUpdatedAt: current.updated_at,
      values,
    });
  }

  const replacements = new Map(edits.filter((edit) => edit.id !== null).map((edit) => [edit.id, edit]));
  const resultingRows = [...currentRows.map((row) => replacements.get(row.id) ?? row), ...edits.filter((edit) => edit.id === null)];
  const collisionError = validateMappingFallbacks(resultingRows);
  if (collisionError) return { ok: false, error: collisionError };

  return { ok: true, inserts, updates, deletes: [] };
}

export function validateMappingFallbacks(rows: readonly (CrmFieldMappingRow | CrmFieldMappingSaveInput)[]): string | null {
  const destinations = new Map<string, (CrmFieldMappingRow | CrmFieldMappingSaveInput)[]>();
  for (const row of rows) {
    if (!row.enabled) continue;
    const key = JSON.stringify([row.workspace_id, row.provider, row.source_stage, row.destination_object, row.destination_field]);
    destinations.set(key, [...(destinations.get(key) ?? []), row]);
  }
  for (const group of destinations.values()) {
    if (group.length < 2) continue;
    const first = group[0]!;
    if (!validFallbackGroup(group)) {
      return `Mapping collision at ${first.source_stage} / ${first.destination_object}.${first.destination_field}. Declare one fallback group with unique priorities and compatible write rules.`;
    }
  }
  return null;
}

function currentWriteValues(
  row: CrmFieldMappingRow,
): CrmFieldMappingWriteValues {
  const values: Partial<CrmFieldMappingRow> = { ...row };
  delete values.id;
  delete values.created_at;
  delete values.updated_at;
  return values as CrmFieldMappingWriteValues;
}

function sameWriteValues(
  left: CrmFieldMappingWriteValues,
  right: CrmFieldMappingWriteValues,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateSaveInput(edit: CrmFieldMappingSaveInput): string | null {
  if (!edit.source_field.trim()) return "Source field is required.";
  if (edit.source_path.length === 0 || edit.source_path.some((part) => !part)) {
    return "Source path is required.";
  }
  if (edit.provider !== "hubspot" && edit.provider !== "attio") return "An explicit CRM provider is required.";
  if (!["contact", "company", "lift_person", "lift_company"].includes(edit.destination_object)) return "A supported CRM destination object is required.";
  if (!edit.destination_field?.trim()) return "A CRM destination is required.";
  if (!["create_only", "only_if_empty", "overwrite_lift_field", "managed_enum_transition"].includes(edit.write_rule)) return "Field mappings must use an executable write rule.";
  if (!mappingTransformValid(edit)) return "Mapping transform or value-source configuration is invalid.";
  if (edit.fallback_group !== null && !edit.fallback_group?.trim()) return "Fallback group must not be blank.";
  if ((edit.fallback_group == null) !== (edit.fallback_priority == null)) return "Fallback group and priority must be specified together.";
  if (edit.fallback_priority != null && (!Number.isInteger(edit.fallback_priority) || edit.fallback_priority < 0)) return "Fallback priority must be a non-negative integer.";
  return null;
}

function writeValues(
  edit: CrmFieldMappingSaveInput,
  activeWorkspaceId: string,
): CrmFieldMappingWriteValues {
  const values = { ...edit } as Record<string, unknown>;
  delete values.id;
  delete values.expected_updated_at;
  delete values.created_at;
  delete values.updated_at;
  delete values.clientKey;
  return {
    ...(values as CrmFieldMappingWriteValues),
    workspace_id: activeWorkspaceId,
  };
}

export interface CrmPreviewResult {
  payload: Record<string, string>;
  pushed: PreviewEntry[];
  skipped_no_value: PreviewEntry[];
  skipped_missing_property: PreviewEntry[];
  skipped_write_rule: PreviewEntry[];
}

export interface PreviewEntry {
  source_field: string;
  source_path: string;
  destination_field: string;
  value?: string;
  write_rule?: CrmWriteRule;
}

/**
 * Attio's native people.name attribute accepts the string form
 * "Last name, First name". Keep this runtime-only value out of the stored lead
 * shape while letting the Sync Map preview the exact payload used by jobs.
 */
export function attioPersonNameValue(source: unknown): string | null {
  const row = asRecord(source);
  if (!row) return null;
  const firstName =
    typeof row.first_name === "string" ? row.first_name.trim() : "";
  const lastName =
    typeof row.last_name === "string" ? row.last_name.trim() : "";
  if (!firstName && !lastName) return null;
  if (!lastName) return firstName;
  return `${lastName},${firstName ? ` ${firstName}` : ""}`;
}

export function buildCrmPreview(input: {
  mappings: readonly (CrmFieldMappingRow | CrmFieldMappingSaveInput)[];
  source: unknown;
  stage: CrmSourceStage;
  provider: CrmProvider;
  sourceEntity?: CrmSourceEntity;
  destinationObject: CrmMappingObject;
  availablePropertyNames: Set<string> | null;
  writeMode?: "create" | "update";
  existingProperties?: Record<string, unknown> | undefined;
  runtime?: Record<string, unknown> | undefined;
  counterpartProperties?: Record<string, unknown> | undefined;
}): CrmPreviewResult {
  const runtimeResult = buildCrmPropertyPayload({
    mappings: input.mappings as SharedCrmFieldMapping[],
    provider: input.provider,
    source: input.source,
    stage: input.stage,
    sourceEntity: input.sourceEntity ?? "lead",
    destinationObject: input.destinationObject,
    writeMode: input.writeMode ?? "create",
    existingProperties: input.existingProperties,
    runtime: input.runtime,
    counterpartProperties: input.counterpartProperties,
  });
  const missingNames = input.availablePropertyNames;
  const pushed = runtimeResult.pushed.filter(
    (entry) => missingNames === null || missingNames.has(entry.destination_field),
  );
  const skippedMissingProperty = runtimeResult.pushed.filter(
    (entry) => missingNames !== null && !missingNames.has(entry.destination_field),
  );

  return {
    payload: Object.fromEntries(
      Object.entries(runtimeResult.payload).filter(
        ([field]) => missingNames === null || missingNames.has(field),
      ),
    ),
    pushed,
    skipped_no_value: runtimeResult.skipped_no_value,
    skipped_missing_property: skippedMissingProperty,
    skipped_write_rule: runtimeResult.skipped_write_rule,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function humanize(value: string): string {
  return value
    .split("_")
    .map(capitalize)
    .join(" ");
}

function capitalize(value: string): string {
  return value.length > 0 ? value[0]!.toUpperCase() + value.slice(1) : value;
}
