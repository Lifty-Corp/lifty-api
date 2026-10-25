import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AuthSession } from "../app.js";
import { CrmRecordsQuerySchema, CrmRecordsSchema } from "../crm-records.js";
import {
  getDiscoverySources,
  aggregateResearchSources,
} from "../generated/crm-source-catalog.js";
import {
  planCrmFieldMappingSave,
  type CrmFieldMappingSaveInput,
} from "../generated/crm-field-mappings.js";
import * as C from "./contracts.js";
import {
  withMappingSession,
  scoped,
  type CrmMappingSettings,
  type MappingSession,
} from "./transport.js";
import { readProperties, readRecords } from "./provider.js";
import {
  buildPreview,
  matchesIdentity,
  RECORD_ID,
  type Properties,
  type Surface,
} from "./preview.js";
import { createAttioAttribute } from "./attio.js";
export type { CrmMappingSettings } from "./transport.js";
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new C.MappingError("INVALID_MAPPING_REQUEST", 422);
  return result.data;
}
const scope = (state: C.State) => ({
  ...scoped(state),
  mapping_version: state.mapping_version,
});
function assertScope(state: C.State, input: z.infer<typeof C.ScopeSchema>) {
  if (C.stableJson(scope(state)) !== C.stableJson(input))
    throw new C.MappingError("STALE_CONTEXT", 409);
}
function checkScope(state: C.State, input: unknown) {
  assertScope(state, C.ScopeSchema.parse(input));
}
// LIF-1584: the scopes each action needs, per provider. Every inner list is
// one requirement met by any of its scopes. Mapping writes contact/people and
// company records; creating a field changes that object's schema.
const REQUIRED_SCOPES: Record<C.CrmProviderName, { map: string[][]; create: Record<Surface, string[][]> }> = {
  hubspot: {
    map: [["crm.objects.contacts.write"], ["crm.objects.companies.write"]],
    create: { contact: [["crm.schemas.contacts.write"]], company: [["crm.schemas.companies.write"]] },
  },
  attio: {
    map: [["record_permission:read-write"], ["object_configuration:read", "object_configuration:read-write"]],
    create: { contact: [["object_configuration:read-write"]], company: [["object_configuration:read-write"]] },
  },
};
function capability(scopes: string[] | null, required: string[][]): z.infer<typeof C.CrmCapabilitySchema> {
  if (!scopes) return { state: "unknown", missing_scopes: [] };
  const missing = required.filter(any => !any.some(scope => scopes.includes(scope))).map(any => any[0]!);
  return { state: missing.length ? "missing_permission" : "available", missing_scopes: missing };
}
async function capabilities(tools: MappingSession, state: C.State): Promise<C.CrmCapabilities> {
  const { credential, scopes } = await tools.access(state);
  const required = REQUIRED_SCOPES[state.provider];
  return {
    credential, scopes,
    map_fields: capability(scopes, required.map),
    create_fields: { contact: capability(scopes, required.create.contact), company: capability(scopes, required.create.company) },
  };
}
// The connection states the CRM page shows instead of an error.
const RECONNECT: Record<string, C.CrmProviderName> = { HUBSPOT_RECONNECT_REQUIRED: "hubspot", ATTIO_RECONNECT_REQUIRED: "attio" };
const NOT_CONNECTED = new Set(["HUBSPOT_NOT_CONNECTED", "ATTIO_NOT_CONNECTED", "WORKSPACE_UNSUPPORTED"]);
function savePlan(state: C.State, edits: CrmFieldMappingSaveInput[]) {
  if (
    new Set(edits.filter((e) => e.id !== null).map((e) => e.id)).size !==
    edits.filter((e) => e.id !== null).length
  )
    throw new C.MappingError("DUPLICATE_MAPPING_EDIT", 422);
  const plan = planCrmFieldMappingSave(
    state.workspace_ref,
    state.mappings,
    edits,
  );
  if (!plan.ok)
    throw new C.MappingError(
      plan.conflict ? "STALE_CONTEXT" : "INVALID_MAPPING_EDIT",
      plan.conflict ? 409 : 422,
      [
        {
          code: "INVALID_MAPPING_EDIT",
          path: "/edits",
          message: plan.error,
          suggestion: "Refresh the catalog and correct the mapping edits.",
        },
      ],
    );
  return plan;
}
function editedState(
  state: C.State,
  edits: CrmFieldMappingSaveInput[],
): C.State {
  savePlan(state, edits);
  const replacements = new Map(
    edits.filter((e) => e.id !== null).map((e) => [e.id, e]),
  );
  const mappings = state.mappings.map((row) => ({
    ...row,
    ...replacements.get(row.id),
    id: row.id,
  }));
  for (const edit of edits.filter((e) => e.id === null))
    mappings.push({
      ...edit,
      id: randomUUID(),
      created_at: "preview",
      updated_at: "preview",
    });
  return C.StateSchema.parse({ ...state, mappings });
}
async function validateDestinations(
  edits: CrmFieldMappingSaveInput[],
  properties: Properties,
) {
  for (const edit of edits.filter((e) => e.enabled)) {
    const property = properties[
      edit.destination_object === "contact" ? "contact" : "company"
    ].find((p) => p.name === edit.destination_field);
    if (
      !property ||
      property.archived ||
      property.modificationMetadata?.readOnlyValue
    )
      throw new C.MappingError("MAPPING_PROPERTY_UNAVAILABLE", 409);
  }
}
const locationSources = [
  { column: "person_city", label: "Person city", data_type: "string" },
  { column: "person_state", label: "Person state", data_type: "string" },
  { column: "person_country", label: "Person country", data_type: "string" },
];
const companySources = [
  "stable_icp_tier",
  "enrichment_source",
  "enrichment_summary",
  "pain_points",
  "talking_points",
  "website",
  "headquarters_address",
  "headquarters_city",
  "headquarters_state",
  "headquarters_postal_code",
  "headquarters_country",
  "company_email",
  "mobile_phone",
  "office_phone",
  "linkedin_url",
];
export async function runCrmMapping(
  session: AuthSession,
  settings: CrmMappingSettings,
  action: C.CrmMappingAction,
  input?: unknown,
  options: C.CrmMappingOptions = {},
) {
  if (
    ["apply", "property_create", "sync"].includes(action) &&
    settings.readOnly
  )
    throw new C.MappingError("MAINTENANCE_READ_ONLY", 503);
  return withMappingSession(session, settings, options, async (tools) => {
    if (action === "capabilities") {
      const workspace_ref = options.workspaceRef;
      if (!workspace_ref) throw new C.MappingError("INVALID_MAPPING_REQUEST", 422);
      try {
        const state = C.StateSchema.parse(await tools.rpc("state"));
        if (state.workspace_ref !== workspace_ref)
          throw new C.MappingError("WORKSPACE_OR_PORTAL_CHANGED", 409);
        return C.CrmCapabilitiesReadSchema.parse({
          workspace_ref, connection: "connected", provider: state.provider,
          integration_ref: state.integration_ref, portal_id: state.portal_id,
          capabilities: await capabilities(tools, state),
        });
      } catch (error) {
        if (!(error instanceof C.MappingError)) throw error;
        const provider = RECONNECT[error.code];
        if (provider) return { workspace_ref, connection: "reconnect_required" as const, provider };
        if (NOT_CONNECTED.has(error.code)) return { workspace_ref, connection: "not_connected" as const, provider: null };
        throw error;
      }
    }
    const state = C.StateSchema.parse(await tools.rpc("state"));
    if (options.workspaceRef && state.workspace_ref !== options.workspaceRef)
      throw new C.MappingError("WORKSPACE_OR_PORTAL_CHANGED", 409);
    const sources = async (refs: string[]) => {
      const result = C.CrmMappingSourcesSchema.parse(
        await tools.rpc("sources", {
          ...scoped(state),
          lead_refs: [...new Set(refs)].sort(),
        }),
      );
      if (
        result.workspace_ref !== state.workspace_ref ||
        result.leads.length !== new Set(refs).size ||
        result.leads.some((l) => !refs.includes(l.lead_ref))
      )
        throw new C.MappingError("INVALID_SOURCE_SCOPE", 502);
      return result;
    };
    const preview = async (
      refs: string[],
      edits?: CrmFieldMappingSaveInput[],
    ) => {
      const next = edits?.length ? editedState(state, edits) : state;
      const properties = await readProperties(tools, state);
      const source = await sources(refs);
      // Read only properties actually present in this portal; missing destinations remain explicit preview issues.
      const readable = {
        ...next,
        mappings: next.mappings.filter((m) =>
          properties[m.destination_object].some(
            (p) => p.name === m.destination_field,
          ),
        ),
      };
      return buildPreview(
        next,
        properties,
        source.leads,
        await readRecords(tools, readable, source.leads),
        !edits?.length,
      );
    };
    if (action === "catalog") {
      const properties = await readProperties(tools, state);
      return C.CrmMappingCatalogSchema.parse({
        ...state,
        capabilities: await capabilities(tools, state),
        properties,
        schema_version: await C.fingerprint(properties),
        sources: {
          discovery: [...getDiscoverySources(), ...locationSources],
          company_discovery: ["company_name", "company_domain"],
          company_research: companySources,
          research:
            "Select lead_refs with mapping_sources to inspect saved research and custom_fields. Personal location is separate from company headquarters.",
        },
      });
    }
    if (action === "sources") {
      const request = parse(C.CrmMappingSourcesRequestSchema, input);
      const result = await sources(request.lead_refs);
      return {
        ...result,
        research_sources: aggregateResearchSources(
          result.leads.map((l) =>
            z
              .record(z.string(), z.unknown())
              .nullable()
              .catch(null)
              .parse(l.lead_research?.custom_fields),
          ),
        ),
      };
    }
    if (action === "records")
      return recordLinks(
        tools,
        state,
        parse(CrmRecordsQuerySchema, input ?? {}),
      );
    if (action === "status")
      return C.CrmMappingStatusSchema.parse(
        await tools.rpc("status", {
          ...scoped(state),
          ...parse(C.CrmMappingStatusQuerySchema, input),
        }),
      );
    if (action === "preview") {
      const request = parse(C.CrmMappingPreviewRequestSchema, input);
      checkScope(state, request);
      return preview(request.lead_refs, request.edits);
    }
    if (action === "apply") {
      const request = parse(C.CrmMappingApplyRequestSchema, input);
      checkScope(state, request);
      const properties = await readProperties(tools, state);
      if (request.schema_version !== (await C.fingerprint(properties)))
        throw new C.MappingError("STALE_SCHEMA", 409);
      await validateDestinations(request.edits, properties);
      const plan = savePlan(state, request.edits);
      let next = state;
      if (plan.updates.length || plan.inserts.length) {
        const result = z
          .object({ state: C.StateSchema })
          .parse(
            await tools.rpc("apply", {
              ...scope(state),
              updates: plan.updates.map((u) => ({
                id: u.id,
                expected_updated_at: u.expectedUpdatedAt,
                values: u.values,
              })),
              inserts: plan.inserts,
            }),
          );
        next = result.state;
      }
      if (
        next.workspace_ref !== state.workspace_ref ||
        next.portal_id !== state.portal_id ||
        next.integration_ref !== state.integration_ref
      )
        throw new C.MappingError("WORKSPACE_OR_PORTAL_CHANGED", 409);
      return C.CrmMappingApplySchema.parse({ ...next, state: "applied" });
    }
    if (action === "property_create")
      return createProperty(
        tools,
        state,
        parse(C.CrmMappingPropertyCreateRequestSchema, input),
      );
    const request = parse(C.CrmMappingSyncRequestSchema, input);
    checkScope(state, request);
    const existing = await tools.rpc("status", {
      ...scoped(state),
      request_ref: request.request_ref,
    });
    const prior = C.CrmMappingStatusSchema.safeParse(existing);
    let receipt: z.infer<typeof C.CrmMappingStatusSchema>;
    if (prior.success) {
      receipt = prior.data;
      if (
        receipt.preview_digest !== request.preview_digest ||
        receipt.mapping_version !== request.mapping_version ||
        receipt.portal_id !== request.portal_id ||
        receipt.integration_ref !== request.integration_ref ||
        C.stableJson(receipt.lead_refs) !==
          C.stableJson([...new Set(request.lead_refs)].sort())
      )
        throw new C.MappingError("MAPPING_REQUEST_CONFLICT", 409);
    } else {
      if (
        !z
          .object({
            state: z.literal("none"),
            workspace_ref: z.literal(state.workspace_ref),
          })
          .safeParse(existing).success
      )
        throw new C.MappingError("INVALID_MAPPING_STATE", 502);
      const current = await preview(request.lead_refs);
      if (current.preview_digest !== request.preview_digest)
        throw new C.MappingError("STALE_PREVIEW", 409);
      if (!current.plan.records.length)
        throw new C.MappingError("NO_FIELDS_TO_APPLY", 409);
      receipt = C.CrmMappingSyncSchema.parse(
        await tools.rpc("sync", {
          ...scope(state),
          request_ref: request.request_ref,
          preview_digest: request.preview_digest,
          lead_refs: current.lead_refs,
          plan: current.plan,
        }),
      );
    }
    if (receipt.workspace_ref !== state.workspace_ref)
      throw new C.MappingError("INVALID_MAPPING_STATE", 502);
    if (receipt.status === "queued") {
      if (!settings.enqueue)
        throw new C.MappingError("CRM_MAPPING_WORKER_UNAVAILABLE", 503);
      try {
        await settings.enqueue(receipt.run_ref, state.workspace_ref);
      } catch {
        throw new C.MappingError("CRM_MAPPING_ENQUEUE_FAILED", 502);
      }
    }
    return receipt;
  });
}
async function recordLinks(
  tools: MappingSession,
  state: C.State,
  input: z.infer<typeof CrmRecordsQuerySchema>,
) {
  const data = z
    .object({
      workspace_ref: z.uuid(),
      integration_ref: z.uuid(),
      portal_id: z.string(),
      run_ref: z.uuid().nullable(),
      sync_state: z.string(),
      leads: z.array(C.LeadSourceSchema).max(2000),
    })
    .parse(await tools.rpc("records", { ...scoped(state), ...input }));
  if (
    data.workspace_ref !== state.workspace_ref ||
    data.portal_id !== state.portal_id ||
    data.integration_ref !== state.integration_ref
  )
    throw new C.MappingError("WORKSPACE_OR_PORTAL_CHANGED", 409);
  if (!data.run_ref)
    return { state: "none" as const, workspace_ref: state.workspace_ref };
  const remote = await readRecords(tools, state, data.leads, true);
  const link = (lead: C.LeadSource, object: Surface) => {
    const id = object === "contact" ? lead.crm_contact_id : lead.crm_company_id;
    const row = id ? remote[object].get(id) : undefined;
    const status =
      !id || !RECORD_ID[state.provider].test(id)
        ? "missing_record"
        : !row
          ? "record_unavailable"
          : !matchesIdentity(lead, object, row)
            ? "identity_mismatch"
            : "verified";
    // Attio links are the record's own web_url; HubSpot's are built from the portal.
    const url = status !== "verified" ? null
      : state.provider === "attio" ? row?.url ?? null
      : `https://app.hubspot.com/contacts/${state.portal_id}/record/${object === "contact" ? "0-1" : "0-2"}/${id}`;
    return { status: status === "verified" && !url ? "record_unavailable" : status, url };
  };
  return CrmRecordsSchema.parse({
    state: "available",
    workspace_ref: state.workspace_ref,
    run_ref: data.run_ref,
    sync_state: data.sync_state,
    portal_id: state.portal_id,
    provider: state.provider,
    leads: data.leads.map((lead) => {
      const contact = link(lead, "contact"),
        company = link(lead, "company");
      return {
        lead_ref: lead.lead_ref,
        name: lead.name,
        company: lead.company,
        crm_contact_id: lead.crm_contact_id,
        crm_company_id: lead.crm_company_id,
        contact_url: contact.url,
        company_url: company.url,
        contact_status: contact.status,
        company_status: company.status,
      };
    }),
  });
}
async function createProperty(
  tools: MappingSession,
  state: C.State,
  request: z.infer<typeof C.CrmMappingPropertyCreateRequestSchema>,
) {
  checkScope(state, request);
  const attio = state.provider === "attio";
  const prefix = attio ? "ATTIO" : "HUBSPOT";
  const definition = request.property;
  // A HubSpot property definition never creates an Attio attribute, or vice versa.
  if (attio === "fieldType" in definition)
    throw new C.MappingError("INVALID_PROPERTY_DEFINITION", 422);
  // The connection's own permission decides (LIF-1584). Unknown scopes let the
  // provider decide; its 403 is the same PERMISSION_REQUIRED (transport).
  const allowed = (await capabilities(tools, state)).create_fields[request.object];
  if (allowed.state === "missing_permission")
    throw new C.MappingError(`${prefix}_PERMISSION_REQUIRED`, 409, [{
      code: `${prefix}_PERMISSION_REQUIRED`,
      path: "/object",
      message: `The ${attio ? "Attio" : "HubSpot"} connection lacks ${allowed.missing_scopes.join(", ")}.`,
      suggestion: `Reconnect ${attio ? "Attio" : "HubSpot"} and approve every permission Lifty requests, or map an existing field.`,
    }]);
  const properties = await readProperties(tools, state);
  if (request.schema_version !== (await C.fingerprint(properties)))
    throw new C.MappingError("STALE_SCHEMA", 409);
  const sameName = properties[request.object].find(
    (p) => p.name === definition.name,
  );
  const sameLabel = properties[request.object].find(
    (p) =>
      p.label.trim().toLowerCase() === definition.label.trim().toLowerCase(),
  );
  if (sameName) {
    if (
      sameName.type !== definition.type ||
      ("fieldType" in definition && sameName.fieldType !== definition.fieldType)
    )
      throw new C.MappingError(`${prefix}_PROPERTY_CONFLICT`, 409);
    return C.CrmMappingPropertyCreateSchema.parse({
      ...scope(state),
      state: "already_exists",
      property: sameName,
    });
  }
  if (sameLabel)
    throw new C.MappingError(`${prefix}_PROPERTY_ALREADY_EXISTS`, 409, [
      {
        code: `${prefix}_PROPERTY_ALREADY_EXISTS`,
        path: "/property",
        message: `Use existing ${attio ? "attribute" : "property"} ${sameLabel.name}.`,
        suggestion: "Map to the existing field instead of creating another.",
      },
    ]);
  const choice = attio ? "select" : "enumeration";
  const labels = definition.options?.map((o) => "value" in o ? o.value : o.label) ?? [];
  if (
    (definition.type === choice && (!labels.length || new Set(labels).size !== labels.length)) ||
    (definition.type !== choice && labels.length)
  )
    throw new C.MappingError("INVALID_PROPERTY_DEFINITION", 422);
  if ("fieldType" in definition) {
    const pairs: Record<string, string[]> = {
      string: ["text", "textarea"],
      number: ["number"],
      enumeration: ["select", "radio", "checkbox"],
      bool: ["booleancheckbox"],
      date: ["date"],
      datetime: ["date"],
    };
    if (!pairs[definition.type]?.includes(definition.fieldType))
      throw new C.MappingError("INVALID_PROPERTY_DEFINITION", 422);
  }
  const fresh = C.StateSchema.parse(await tools.rpc("state"));
  checkScope(fresh, request);
  let verified: C.Property;
  if (!("fieldType" in definition)) {
    verified = await createAttioAttribute(tools, state, request.object, definition);
  } else {
    const path = `/crm/v3/properties/${request.object === "contact" ? "contacts" : "companies"}`;
    await tools.call(state, "POST", path, definition);
    verified = C.PropertySchema.parse(
      await tools.call(state, "GET", `${path}/${encodeURIComponent(definition.name)}`),
    );
    if (verified.fieldType !== definition.fieldType)
      throw new C.MappingError("HUBSPOT_PROPERTY_READBACK_FAILED", 502);
  }
  if (
    verified.name !== definition.name ||
    verified.type !== definition.type ||
    labels.some((value) => !verified.options?.some((v) => v.value === value && !v.hidden))
  )
    throw new C.MappingError(`${prefix}_PROPERTY_READBACK_FAILED`, 502);
  return C.CrmMappingPropertyCreateSchema.parse({
    ...scope(state),
    state: "created",
    property: verified,
  });
}
