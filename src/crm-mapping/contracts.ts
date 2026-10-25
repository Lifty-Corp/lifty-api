import { z } from "zod";
import type { AuthSession } from "../app.js";
export {
  MappingError,
  fingerprint,
  stableJson,
} from "../company-mapping/contract.js";
const Json = z.record(z.string(), z.unknown());
const Ref = z.uuid();
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** HubSpot portal/record ids are numeric; Attio workspace/record ids are UUIDs. */
export const CrmIdSchema = z.string().regex(new RegExp(`^([0-9]{1,30}|${UUID})$`));
export const CrmProviderSchema = z.enum(["hubspot", "attio"]);
export type CrmProviderName = z.infer<typeof CrmProviderSchema>;
export const ObjectSchema = z.enum(["contact", "company"]);
export const MappingValuesSchema = z
  .object({
    workspace_id: Ref,
    provider: CrmProviderSchema,
    source_stage: z.enum(["discovery", "research", "outreach", "verification"]),
    source_entity: z.enum(["lead", "company"]),
    source_field: z.string().min(1).max(200),
    label: z.string().max(300).nullable(),
    source_path: z.array(z.string().min(1).max(200)).min(1).max(20),
    destination_object: ObjectSchema,
    destination_field: z.string().min(1).max(200),
    write_rule: z.enum([
      "create_only",
      "only_if_empty",
      "overwrite_lift_field",
      "managed_enum_transition",
    ]),
    transform: z.enum([
      "none",
      "bucket",
      "map_value",
      "join_list",
      "json_string",
      "scale_number",
      "normalize_domain",
    ]),
    transform_config: Json,
    value_source: z.enum([
      "path",
      "constant",
      "runtime",
      "counterpart_property",
    ]),
    enabled: z.boolean(),
    required_from_agent: z.boolean(),
    clay_path: z.array(z.string()).nullable(),
    comparison_rule: z
      .enum([
        "exact",
        "case_insensitive",
        "normalize_then_exact",
        "numeric_tolerance",
        "set_overlap",
      ])
      .nullable(),
    comparison_config: Json,
    fallback_group: z.string().nullable(),
    fallback_priority: z.number().int().nonnegative().nullable(),
    sort_order: z.number().int(),
  })
  .strict();
export const MappingSchema = MappingValuesSchema.extend({
  id: Ref,
  created_at: z.string(),
  updated_at: z.string(),
}).strip();
export const MappingEditSchema = MappingValuesSchema.extend({
  id: Ref.nullable(),
  expected_updated_at: z.string().nullable(),
});
export const ScopeSchema = z.object({
  workspace_ref: Ref,
  integration_ref: Ref,
  portal_id: CrmIdSchema,
  mapping_version: Digest,
});
// The database still sends allow_provisioning (workspaces.allow_hubspot_provisioning).
// Nothing reads it since LIF-1584: field creation follows the connection's own
// permission (capabilities), so the stripped value never reaches a response.
export const StateSchema = ScopeSchema.extend({
  // Databases before LIF-1238 return HubSpot-only state without a provider.
  provider: CrmProviderSchema.default("hubspot"),
  workspace_name: z.string(),
  mappings: z.array(MappingSchema),
});
export type State = z.infer<typeof StateSchema>;
/** LIF-1584: what the stored credential lets Lifty do, from the scopes the provider reports for it. */
export const CrmCapabilityStateSchema = z.enum(["available", "missing_permission", "unknown"])
  .describe("available: the provider reports every scope the action needs. missing_permission: it does not; reconnect and approve every requested permission. unknown: the scopes could not be read; the action may be tried and a provider refusal reports missing_permission.");
export const CrmCapabilitySchema = z.object({
  state: CrmCapabilityStateSchema,
  missing_scopes: z.array(z.string()).describe("Provider scopes the credential lacks for this action; empty unless missing_permission."),
}).strict();
export const CrmCapabilitiesSchema = z.object({
  credential: z.enum(["oauth", "private_app"])
    .describe("oauth: Lifty's own HubSpot or Attio app. private_app: a HubSpot private-app token from an earlier setup; reconnecting replaces it with Lifty's app."),
  scopes: z.array(z.string()).nullable().describe("Scopes the provider reports for the stored credential; null when they could not be read."),
  map_fields: CrmCapabilitySchema.describe("Save mappings to existing CRM fields and write them on records."),
  create_fields: z.object({ contact: CrmCapabilitySchema, company: CrmCapabilitySchema }).strict()
    .describe("Create a HubSpot property or Attio attribute on contacts/people or companies (property_create)."),
}).strict();
export type CrmCapabilities = z.infer<typeof CrmCapabilitiesSchema>;
/** GET /v1/workspace/crm/capabilities: the connection's state and, when connected, what it can do. */
export const CrmCapabilitiesReadSchema = z.discriminatedUnion("connection", [
  z.object({ workspace_ref: Ref, connection: z.literal("not_connected"), provider: z.null() }).strict(),
  z.object({ workspace_ref: Ref, connection: z.literal("reconnect_required"), provider: CrmProviderSchema }).strict()
    .describe("The stored credential is revoked, expired or an Attio API key from an earlier setup. Customers, notes and fields wait for a reconnect of this provider."),
  z.object({ workspace_ref: Ref, connection: z.literal("connected"), provider: CrmProviderSchema,
    integration_ref: Ref, portal_id: CrmIdSchema, capabilities: CrmCapabilitiesSchema }).strict(),
]);
export const PropertySchema = z.object({
  name: z.string(),
  label: z.string(),
  description: z.string().optional(),
  type: z.string(),
  fieldType: z.string(),
  groupName: z.string().optional(),
  archived: z.boolean().optional(),
  options: z
    .array(
      z.object({
        label: z.string(),
        value: z.string(),
        hidden: z.boolean().optional(),
        displayOrder: z.number().optional(),
      }),
    )
    .optional(),
  modificationMetadata: z
    .object({
      readOnlyValue: z.boolean().optional(),
      readOnlyOptions: z.boolean().optional(),
      readOnlyDefinition: z.boolean().optional(),
    })
    .optional(),
});
export type Property = z.infer<typeof PropertySchema>;
export const LeadSourceSchema = z.object({
  lead_ref: Ref,
  name: z.string(),
  company: z.string().nullable(),
  company_ref: Ref.nullable(),
  crm_contact_id: z.string().nullable(),
  crm_company_id: z.string().nullable(),
  discovery: Json,
  company_discovery: Json.nullable().default(null),
  lead_research: Json.nullable(),
  company_research: Json.nullable(),
});
export type LeadSource = z.infer<typeof LeadSourceSchema>;
export const CrmMappingSourcesRequestSchema = z
  .object({ lead_refs: z.array(Ref).min(1).max(25) })
  .strict();
export const CrmMappingSourcesSchema = z.object({
  workspace_ref: Ref,
  leads: z.array(LeadSourceSchema).max(25),
  research_sources: z
    .array(
      z.object({
        path: z.string(),
        seen_in: z.number().int(),
        sampled: z.number().int(),
      }),
    )
    .optional(),
});
export const CrmMappingCatalogSchema = StateSchema.extend({
  capabilities: CrmCapabilitiesSchema,
  schema_version: Digest,
  properties: z.object({
    contact: z.array(PropertySchema),
    company: z.array(PropertySchema),
  }),
  sources: Json,
});
export const CrmMappingPreviewRequestSchema = ScopeSchema.extend({
  lead_refs: z.array(Ref).min(1).max(25),
  edits: z.array(MappingEditSchema).max(200).optional(),
}).strict();
export const EvaluationSchema = z.object({
  stage: z.enum(["discovery", "research", "outreach", "verification"]),
  entity: z.enum(["lead", "company"]),
  source: Json,
  mappings: z.array(MappingSchema),
});
export const ReplayRecordSchema = z.object({
  lead_refs: z.array(Ref),
  object: ObjectSchema,
  record_id: CrmIdSchema,
  expected: z.record(z.string(), z.string().nullable()),
  proposed: z.record(z.string(), z.string()),
  evaluations: z.array(EvaluationSchema),
});
export const ReplayPlanSchema = z.object({
  version: z.literal(1),
  records: z.array(ReplayRecordSchema),
});
export type ReplayPlan = z.infer<typeof ReplayPlanSchema>;
export const PreviewIssueSchema = z.object({
  lead_ref: Ref,
  object: ObjectSchema,
  field: z.string().nullable(),
  reason: z.string(),
  value: z.string().optional(),
});
export const CrmMappingPreviewSchema = ScopeSchema.extend({
  schema_version: Digest,
  preview_digest: Digest,
  lead_refs: z.array(Ref),
  applied_mapping: z.boolean(),
  plan: ReplayPlanSchema,
  issues: z.array(PreviewIssueSchema),
});
export const CrmMappingApplyRequestSchema = ScopeSchema.extend({
  schema_version: Digest,
  edits: z.array(MappingEditSchema).min(1).max(200),
}).strict();
export const CrmMappingApplySchema = StateSchema.extend({
  state: z.literal("applied"),
});
/** Attio attribute definition: api_slug, title and one of the types the sync writes. */
export const AttioAttributeCreateSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/),
    label: z.string().min(1).max(200),
    description: z.string().max(1000).optional(),
    type: z.enum(["text", "number", "checkbox", "select", "date", "timestamp"]),
    options: z.array(z.object({ label: z.string().min(1).max(200) }).strict()).max(500).optional(),
  })
  .strict();
export const CrmMappingPropertyCreateRequestSchema = ScopeSchema.extend({
  schema_version: Digest,
  object: ObjectSchema,
  property: z.union([z
    .object({
      name: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/),
      label: z.string().min(1).max(200),
      description: z.string().max(1000).optional(),
      groupName: z.string().min(1),
      type: z.enum([
        "string",
        "number",
        "enumeration",
        "bool",
        "date",
        "datetime",
      ]),
      fieldType: z.enum([
        "text",
        "textarea",
        "number",
        "select",
        "radio",
        "checkbox",
        "booleancheckbox",
        "date",
      ]),
      options: z
        .array(
          z
            .object({
              label: z.string().min(1),
              value: z.string().min(1).max(100),
            })
            .strict(),
        )
        .max(500)
        .optional(),
    })
    .strict(), AttioAttributeCreateSchema]),
}).strict();
export const CrmMappingPropertyCreateSchema = ScopeSchema.extend({
  state: z.enum(["created", "already_exists"]),
  property: PropertySchema,
});
export const CrmMappingSyncRequestSchema = ScopeSchema.extend({
  lead_refs: z.array(Ref).min(1).max(25),
  preview_digest: Digest,
  request_ref: Ref,
}).strict();
export const CrmMappingStatusQuerySchema = z.object({ run_ref: Ref }).strict();
export const CrmMappingStatusSchema = z
  .object({
    run_ref: Ref,
    workspace_ref: Ref,
    status: z.enum(["queued", "running", "succeeded", "partial", "failed"]),
    result: Json.nullable(),
  })
  .passthrough();
export const CrmMappingSyncSchema = CrmMappingStatusSchema;
export type CrmMappingAction =
  | "capabilities"
  | "catalog"
  | "sources"
  | "preview"
  | "apply"
  | "property_create"
  | "sync"
  | "status"
  | "records";
export interface CrmMappingOptions {
  workspaceRef?: string;
  signal?: AbortSignal;
}
export type CrmMappingOperation = (
  session: AuthSession,
  action: CrmMappingAction,
  input?: unknown,
  options?: CrmMappingOptions,
) => Promise<unknown>;
