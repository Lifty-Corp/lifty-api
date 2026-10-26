// Generated from lift-gtm-dashboard/lib/crm-shared/conformance-fixtures.ts; regenerate with scripts/sync-crm-contract.mjs.
// Shared acceptance fixtures from lift-gtm-jobs (LIF-742).
import type { CanonicalizeScoutContractInput } from "./scout-contract.js";
import type {
  BuildCrmPropertyPayloadInput,
  BuildCrmPropertyPayloadResult,
  BuildScoutResearchSchemaInput,
  CrmFieldMapping,
  JsonObject,
  JsonSchema,
} from "./types.js";

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export interface PayloadConformanceFixture {
  readonly kind: "payload";
  readonly name: string;
  readonly permutationGroup?: string;
  readonly input: DeepReadonly<BuildCrmPropertyPayloadInput>;
  readonly expected: DeepReadonly<BuildCrmPropertyPayloadResult>;
}

export interface ScoutConformanceFixture {
  readonly kind: "scout";
  readonly name: string;
  readonly schemaInput: DeepReadonly<BuildScoutResearchSchemaInput>;
  readonly expectedSchema: DeepReadonly<JsonSchema>;
  readonly canonicalInputs: readonly DeepReadonly<CanonicalizeScoutContractInput>[];
  readonly expectedCanonical: DeepReadonly<JsonObject>;
  readonly expectedHash: string;
}

export type CrmFieldMappingConformanceFixture =
  | PayloadConformanceFixture
  | ScoutConformanceFixture;

const WORKSPACE_ID = "21000000-0000-4000-8000-000000000001";
const CREATED_AT = "2026-07-21T00:00:00.000Z";

function mapping(
  sourceField: string,
  overrides: Partial<CrmFieldMapping> = {},
): CrmFieldMapping {
  return {
    id: `fixture-${sourceField}`,
    workspace_id: WORKSPACE_ID,
    provider: "hubspot",
    source_stage: "discovery",
    source_entity: "lead",
    source_field: sourceField,
    label: sourceField,
    source_path: [sourceField],
    destination_object: "contact",
    destination_field: sourceField,
    write_rule: "only_if_empty",
    transform: "none",
    transform_config: { source_type: "string" },
    value_source: "path",
    enabled: true,
    required_from_agent: false,
    fallback_group: null,
    fallback_priority: null,
    sort_order: 0,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    ...overrides,
  };
}

const DISCOVERY_MAPPINGS = [
  mapping("first_name", {
    id: "fixture-first-name",
    destination_field: "given_name",
    fallback_group: null,
    fallback_priority: null,
    sort_order: 10,
  }),
  mapping("website", {
    id: "fixture-domain",
    destination_field: "domain",
    transform: "normalize_domain",
    fallback_group: null,
    fallback_priority: null,
    sort_order: 20,
  }),
  mapping("source_system", {
    id: "fixture-source-system",
    destination_field: "lift_source_system",
    write_rule: "overwrite_lift_field",
    value_source: "constant",
    transform_config: {
      source_type: "string",
      constant_value: "scout",
    },
    fallback_group: null,
    fallback_priority: null,
    sort_order: 30,
  }),
];

const ORDERED_DISCOVERY_EXPECTED: BuildCrmPropertyPayloadResult = {
  payload: {
    given_name: "Ada",
    domain: "example.com",
    lift_source_system: "scout",
  },
  pushed: [
    {
      source_field: "first_name",
      source_path: "first_name",
      destination_field: "given_name",
      value: "Ada",
    },
    {
      source_field: "website",
      source_path: "website",
      destination_field: "domain",
      value: "example.com",
    },
    {
      source_field: "source_system",
      source_path: "source_system",
      destination_field: "lift_source_system",
      value: "scout",
    },
  ],
  skipped_no_value: [],
  skipped_write_rule: [],
};

const SCOUT_BASE_SCHEMA: JsonSchema = {
  required: ["summary"],
  properties: {
    summary: {
      description: "Research summary",
      type: "string",
    },
  },
  type: "object",
};

const SCOUT_MAPPINGS = [
  mapping("markets", {
    id: "fixture-scout-markets",
    source_stage: "research",
    source_entity: "company",
    source_path: ["custom_fields", "profile", "markets"],
    label: "Operating Markets",
    destination_object: "company",
    destination_field: "operating_markets",
    write_rule: "overwrite_lift_field",
    transform: "join_list",
    transform_config: { source_type: "array", separator: "; " },
    required_from_agent: true,
    fallback_group: null,
    fallback_priority: null,
    sort_order: 40,
  }),
  mapping("hq_state", {
    id: "fixture-scout-hq-state",
    source_stage: "research",
    source_entity: "company",
    source_path: ["custom_fields", "profile", "hq_state"],
    label: "HQ State",
    destination_object: "company",
    destination_field: "hq_state",
    write_rule: "overwrite_lift_field",
    required_from_agent: true,
    fallback_group: null,
    fallback_priority: null,
    sort_order: 30,
  }),
  mapping("employee_count", {
    id: "fixture-scout-employee-count",
    source_stage: "research",
    source_entity: "company",
    source_path: ["custom_fields", "profile", "employee_count"],
    label: "Employee Count",
    destination_object: "company",
    destination_field: "numberofemployees",
    write_rule: "overwrite_lift_field",
    transform_config: { source_type: "number" },
    required_from_agent: true,
    fallback_group: null,
    fallback_priority: null,
    sort_order: 10,
  }),
  mapping("evidence", {
    id: "fixture-scout-evidence",
    source_stage: "research",
    source_entity: "company",
    source_path: ["custom_fields", "profile", "evidence"],
    label: "Research Evidence",
    destination_object: "company",
    destination_field: "research_evidence",
    write_rule: "overwrite_lift_field",
    transform: "json_string",
    transform_config: { source_type: "object" },
    required_from_agent: true,
    fallback_group: null,
    fallback_priority: null,
    sort_order: 20,
  }),
  mapping("optional_signal", {
    id: "fixture-scout-optional",
    source_stage: "research",
    source_entity: "company",
    source_path: ["custom_fields", "profile", "optional_signal"],
    label: "Optional Signal",
    destination_object: "company",
    destination_field: "optional_signal",
    write_rule: "overwrite_lift_field",
    required_from_agent: false,
    fallback_group: null,
    fallback_priority: null,
    sort_order: 50,
  }),
  mapping("disabled_signal", {
    id: "fixture-scout-disabled",
    source_stage: "research",
    source_entity: "company",
    source_path: ["custom_fields", "profile", "disabled_signal"],
    label: "Disabled Signal",
    destination_object: "company",
    destination_field: "disabled_signal",
    write_rule: "overwrite_lift_field",
    enabled: false,
    required_from_agent: true,
    fallback_group: null,
    fallback_priority: null,
    sort_order: 60,
  }),
  mapping("employee_count_duplicate", {
    id: "fixture-scout-employee-count-contact",
    source_stage: "research",
    source_entity: "lead",
    source_path: ["custom_fields", "profile", "employee_count"],
    label: "Employee Count",
    destination_object: "contact",
    destination_field: "company_employee_count",
    write_rule: "create_only",
    transform: "scale_number",
    transform_config: { source_type: "number", scale: 1 },
    value_source: "runtime",
    required_from_agent: true,
    fallback_group: null,
    fallback_priority: null,
    sort_order: 70,
  }),
];

const SCOUT_SCHEMA_INPUT: BuildScoutResearchSchemaInput = {
  mappings: SCOUT_MAPPINGS,
  baseSchema: SCOUT_BASE_SCHEMA,
  schemaName: "scout.v2.conformance",
  approaches: ["personal", "minimal_ack"],
};

const SCOUT_CANONICAL_INPUT: CanonicalizeScoutContractInput = {
  baseSchema: SCOUT_BASE_SCHEMA,
  schemaName: "scout.v2.conformance",
  contractText: "Return the published Scout conformance contract.",
  mappings: SCOUT_MAPPINGS,
};

const CONFORMANCE_FIXTURES: CrmFieldMappingConformanceFixture[] = [
  {
    kind: "payload",
    name: "ordered discovery mappings",
    permutationGroup: "discovery-order",
    input: {
      provider: "hubspot",
      mappings: DISCOVERY_MAPPINGS,
      source: {
        first_name: "Ada",
        website: "https://www.Example.com/about",
      },
      stage: "discovery",
      sourceEntity: "lead",
      destinationObject: "contact",
      writeMode: "update",
      existingProperties: {
        given_name: "",
        domain: null,
        lift_source_system: "legacy",
      },
    },
    expected: ORDERED_DISCOVERY_EXPECTED,
  },
  {
    kind: "payload",
    name: "permuted discovery mappings",
    permutationGroup: "discovery-order",
    input: {
      provider: "hubspot",
      mappings: [...DISCOVERY_MAPPINGS].reverse(),
      source: {
        first_name: "Ada",
        website: "https://www.Example.com/about",
      },
      stage: "discovery",
      sourceEntity: "lead",
      destinationObject: "contact",
      writeMode: "update",
      existingProperties: {
        given_name: "",
        domain: null,
        lift_source_system: "legacy",
      },
    },
    expected: {
      payload: {
        lift_source_system: "scout",
        domain: "example.com",
        given_name: "Ada",
      },
      pushed: [...ORDERED_DISCOVERY_EXPECTED.pushed].reverse(),
      skipped_no_value: [],
      skipped_write_rule: [],
    },
  },
  {
    kind: "payload",
    name: "bucket transform overwrites a LIFT-owned field",
    input: {
      provider: "hubspot",
      mappings: [
        mapping("total_unit_count", {
          source_stage: "research",
          source_entity: "company",
          source_path: ["custom_fields", "portfolio", "total_unit_count"],
          label: "Total Unit Count",
          destination_object: "company",
          destination_field: "unit_band",
          write_rule: "overwrite_lift_field",
          transform: "bucket",
          transform_config: {
            source_type: "number",
            buckets: [
              { max: 2500, to: "0-2.5K" },
              { max: 10000, to: "2.5K-10K" },
              { max: null, to: "10K+" },
            ],
          },
          required_from_agent: true,
        }),
      ],
      source: {
        custom_fields: { portfolio: { total_unit_count: 8500 } },
      },
      stage: "research",
      sourceEntity: "company",
      destinationObject: "company",
      writeMode: "update",
      existingProperties: { unit_band: "legacy" },
    },
    expected: {
      payload: { unit_band: "2.5K-10K" },
      pushed: [
        {
          source_field: "total_unit_count",
          source_path: "custom_fields.portfolio.total_unit_count",
          destination_field: "unit_band",
          value: "2.5K-10K",
        },
      ],
      skipped_no_value: [],
      skipped_write_rule: [],
    },
  },
  {
    kind: "payload",
    name: "mapped enum advances only a managed value",
    input: {
      provider: "hubspot",
      mappings: [
        mapping("icp_tier", {
          source_stage: "research",
          source_entity: "company",
          destination_object: "company",
          destination_field: "type",
          write_rule: "managed_enum_transition",
          transform: "map_value",
          transform_config: {
            source_type: "string",
            map: { A: "Top Target", C: "PROSPECT" },
            managed_values: ["Top Target", "PROSPECT"],
          },
          required_from_agent: true,
        }),
      ],
      source: { icp_tier: "A" },
      stage: "research",
      sourceEntity: "company",
      destinationObject: "company",
      writeMode: "update",
      existingProperties: { type: "PROSPECT" },
    },
    expected: {
      payload: { type: "Top Target" },
      pushed: [
        {
          source_field: "icp_tier",
          source_path: "icp_tier",
          destination_field: "type",
          value: "Top Target",
        },
      ],
      skipped_no_value: [],
      skipped_write_rule: [],
    },
  },
  {
    kind: "payload",
    name: "joined list does not replace a populated CRM value",
    input: {
      provider: "hubspot",
      mappings: [
        mapping("markets", {
          destination_field: "operating_markets",
          transform: "join_list",
          transform_config: { source_type: "array", separator: " | " },
        }),
      ],
      source: { markets: ["Texas", "Florida"] },
      stage: "discovery",
      sourceEntity: "lead",
      destinationObject: "contact",
      writeMode: "update",
      existingProperties: { operating_markets: "Texas" },
    },
    expected: {
      payload: {},
      pushed: [],
      skipped_no_value: [],
      skipped_write_rule: [
        {
          source_field: "markets",
          source_path: "markets",
          destination_field: "operating_markets",
          value: "Texas | Florida",
          write_rule: "only_if_empty",
        },
      ],
    },
  },
  {
    kind: "payload",
    name: "JSON metadata writes only during create",
    input: {
      provider: "hubspot",
      mappings: [
        mapping("metadata", {
          destination_field: "lift_metadata",
          write_rule: "create_only",
          transform: "json_string",
          transform_config: { source_type: "object" },
        }),
      ],
      source: { metadata: { z: 1, a: true } },
      stage: "discovery",
      sourceEntity: "lead",
      destinationObject: "contact",
      writeMode: "create",
    },
    expected: {
      payload: { lift_metadata: "{\"z\":1,\"a\":true}" },
      pushed: [
        {
          source_field: "metadata",
          source_path: "metadata",
          destination_field: "lift_metadata",
          value: "{\"z\":1,\"a\":true}",
        },
      ],
      skipped_no_value: [],
      skipped_write_rule: [],
    },
  },
  {
    kind: "payload",
    name: "runtime confidence is scaled and rounded",
    input: {
      provider: "hubspot",
      mappings: [
        mapping("confidence", {
          source_stage: "verification",
          destination_field: "lift_confidence_score",
          write_rule: "overwrite_lift_field",
          transform: "scale_number",
          transform_config: { source_type: "number", scale: 100, round: true },
          value_source: "runtime",
        }),
      ],
      source: {},
      runtime: { confidence: 0.876 },
      stage: "verification",
      sourceEntity: "lead",
      destinationObject: "contact",
      writeMode: "update",
      existingProperties: { lift_confidence_score: "50" },
    },
    expected: {
      payload: { lift_confidence_score: "88" },
      pushed: [
        {
          source_field: "confidence",
          source_path: "confidence",
          destination_field: "lift_confidence_score",
          value: "88",
        },
      ],
      skipped_no_value: [],
      skipped_write_rule: [],
    },
  },
  {
    kind: "payload",
    name: "counterpart CRM property supplies a normalized domain",
    input: {
      provider: "hubspot",
      mappings: [
        mapping("company_website", {
          source_path: ["website"],
          destination_field: "company_domain",
          transform: "normalize_domain",
          value_source: "counterpart_property",
        }),
      ],
      source: {},
      counterpartProperties: { website: "https://www.BRMBL.io/team" },
      stage: "discovery",
      sourceEntity: "lead",
      destinationObject: "contact",
      writeMode: "update",
      existingProperties: { company_domain: null },
    },
    expected: {
      payload: { company_domain: "brmbl.io" },
      pushed: [
        {
          source_field: "company_website",
          source_path: "website",
          destination_field: "company_domain",
          value: "brmbl.io",
        },
      ],
      skipped_no_value: [],
      skipped_write_rule: [],
    },
  },
  {
    kind: "scout",
    name: "Scout schema and canonical contract",
    schemaInput: SCOUT_SCHEMA_INPUT,
    expectedSchema: {
      required: ["summary", "approach_type", "custom_fields"],
      properties: {
        summary: {
          description: "Research summary",
          type: "string",
        },
        approach_type: {
          type: "string",
          enum: ["personal", "minimal_ack"],
        },
        custom_fields: {
          type: "object",
          properties: {
            profile: {
              type: "object",
              properties: {
                markets: {
                  type: "array",
                  description: "Operating Markets",
                },
                hq_state: {
                  type: "string",
                  description: "HQ State",
                },
                employee_count: {
                  type: "number",
                  description: "Employee Count",
                },
                evidence: {
                  type: "object",
                  description: "Research Evidence",
                },
              },
              required: ["markets", "hq_state", "employee_count", "evidence"],
            },
          },
          required: ["profile"],
        },
      },
      type: "object",
      title: "scout.v2.conformance",
    },
    canonicalInputs: [
      SCOUT_CANONICAL_INPUT,
      {
        ...SCOUT_CANONICAL_INPUT,
        mappings: [...SCOUT_MAPPINGS].reverse(),
      },
    ],
    expectedCanonical: {
      contract_text: "Return the published Scout conformance contract.",
      mapping_extension: [
        {
          enabled: true,
          label: "Employee Count",
          required_from_agent: true,
          source_path: ["custom_fields", "profile", "employee_count"],
          source_stage: "research",
          source_type: "number",
        },
        {
          enabled: true,
          label: "Research Evidence",
          required_from_agent: true,
          source_path: ["custom_fields", "profile", "evidence"],
          source_stage: "research",
          source_type: "object",
        },
        {
          enabled: true,
          label: "HQ State",
          required_from_agent: true,
          source_path: ["custom_fields", "profile", "hq_state"],
          source_stage: "research",
          source_type: "string",
        },
        {
          enabled: true,
          label: "Operating Markets",
          required_from_agent: true,
          source_path: ["custom_fields", "profile", "markets"],
          source_stage: "research",
          source_type: "array",
        },
      ],
      schema_json: SCOUT_BASE_SCHEMA,
      schema_name: "scout.v2.conformance",
    },
    expectedHash: "bfc6649f7cbf3e91b5c666b4d3b3c439362bb5bcc2a4c230f11f79fd59b6cd89",
  },
];

export const CRM_FIELD_MAPPING_CONFORMANCE_FIXTURES = deepFreeze(
  CONFORMANCE_FIXTURES,
);

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}
