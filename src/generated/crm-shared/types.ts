// Generated from lift-gtm-dashboard/lib/crm-shared/types.ts; regenerate with scripts/sync-crm-contract.mjs.
// Shared pure CRM contract from lift-gtm-jobs (LIF-740/741/742/743).
// Keep behavior aligned; crm-shared-conformance.test.ts runs the jobs fixtures.

import type { ScoutContractField } from "./scout-input.js";
export type CrmProvider = "hubspot" | "attio";
export type CrmObject = "contact" | "company" | "lift_person" | "lift_company";

export type CrmSourceStage =
  | "discovery"
  | "research"
  | "outreach"
  | "verification";
export type CrmSourceEntity = "lead" | "company";
/**
 * Where a mapping's value comes from. Counterpart properties are remote CRM values.
 */
export type CrmValueSource = "path" | "constant" | "runtime" | "counterpart_property";
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

export type JsonObject = Record<string, unknown>;

export interface CrmFieldMapping {
  id: string;
  workspace_id: string;
  provider: CrmProvider;
  source_stage: CrmSourceStage;
  source_entity: CrmSourceEntity;
  source_field: string;
  label: string | null;
  source_path: string[];
  destination_object: CrmObject;
  destination_field: string | null;
  write_rule: CrmWriteRule;
  transform: CrmTransform;
  transform_config: JsonObject;
  value_source: CrmValueSource;
  enabled: boolean;
  required_from_agent: boolean;
  fallback_group: string | null;
  fallback_priority: number | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export type CrmWriteMode = "create" | "update";

export interface BuildCrmPropertyPayloadInput {
  provider: CrmProvider;
  mappings: CrmFieldMapping[];
  source: unknown;
  stage: CrmSourceStage;
  sourceEntity: CrmSourceEntity;
  destinationObject: CrmObject;
  writeMode: CrmWriteMode;
  existingProperties?: Record<string, unknown> | undefined;
  runtime?: Record<string, unknown> | undefined;
  counterpartProperties?: Record<string, unknown> | undefined;
}

export interface CrmPropertyPayloadEntry {
  source_field: string;
  source_path: string;
  destination_field: string;
  value?: string;
  write_rule?: CrmWriteRule;
}

export interface BuildCrmPropertyPayloadResult {
  payload: Record<string, string>;
  pushed: CrmPropertyPayloadEntry[];
  skipped_no_value: CrmPropertyPayloadEntry[];
  skipped_write_rule: CrmPropertyPayloadEntry[];
}

export interface JsonSchema {
  type?: string;
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  additionalProperties?: boolean | JsonSchema;
  [key: string]: unknown;
}

export interface BuildScoutResearchSchemaInput {
  mappings: ScoutContractField[];
  baseSchema: JsonSchema;
  schemaName: string;
  /** Legacy scout.v1/v2 global recommendation enum. Omit for scout.v3. */
  approaches?: string[];
}
