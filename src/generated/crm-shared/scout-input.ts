// Generated from lift-gtm-dashboard/lib/crm-shared/scout-input.ts; regenerate with scripts/sync-crm-contract.mjs.
import type { CrmFieldMapping } from "./types.js";

export type ScoutContractField = Pick<CrmFieldMapping,
  "source_stage" | "source_entity" | "source_field" | "source_path" | "label" |
  "transform_config" | "enabled" | "required_from_agent"> & Partial<Pick<CrmFieldMapping, "transform" | "write_rule" | "value_source">>;

export const RESEARCH_FIELD_TYPES = ["text", "number", "boolean", "list", "object"] as const;
export type ResearchFieldType = (typeof RESEARCH_FIELD_TYPES)[number];

/** A Scout research criterion: a value Scout must report under `custom_fields.<key>`. */
export type ResearchField = { key: string; description: string; type: ResearchFieldType };

const SOURCE_TYPE: Record<ResearchFieldType, string> = {
  text: "string",
  number: "number",
  boolean: "boolean",
  list: "array",
  object: "object",
};

/** Browser-safe counterpart of the jobs adapter from research fields to the internal Scout contract. */
export function scoutResearchFields(fields: readonly ResearchField[]): ScoutContractField[] {
  return fields.map((field) => ({
    source_stage: "research",
    source_entity: "lead",
    source_field: field.key,
    source_path: ["custom_fields", ...field.key.split(".")],
    label: field.description,
    transform_config: { source_type: SOURCE_TYPE[field.type] },
    enabled: true,
    required_from_agent: true,
  }));
}
