import { describe, it, expect } from "vitest";
import { buildPreview } from "../src/crm-mapping/preview.js";
import type {
  State,
  LeadSource,
  Property,
} from "../src/crm-mapping/contracts.js";
const workspace = "89700000-0000-4000-a000-000000000001",
  leadRef = "89700000-0000-4000-a000-000000000002";
const mapping = {
  id: "89700000-0000-4000-a000-000000000003",
  workspace_id: workspace,
  provider: "hubspot" as const,
  source_stage: "discovery" as const,
  source_entity: "lead" as const,
  source_field: "industry",
  label: "Industry",
  source_path: ["industry"],
  destination_object: "company" as const,
  destination_field: "industry",
  write_rule: "only_if_empty" as const,
  transform: "map_value" as const,
  transform_config: { map: { "B2B software": "COMPUTER_SOFTWARE" } },
  value_source: "path" as const,
  enabled: true,
  required_from_agent: false,
  clay_path: null,
  comparison_rule: null,
  comparison_config: {},
  fallback_group: null,
  fallback_priority: null,
  sort_order: 1,
  created_at: "2026-01-01",
  updated_at: "2026-01-01",
};
const state: State = {
  workspace_ref: workspace,
  workspace_name: "Lift",
  integration_ref: "89700000-0000-4000-a000-000000000004",
  portal_id: "52044090",
  provider: "hubspot",
  mapping_version: "a".repeat(64),
  mappings: [mapping],
};
const lead: LeadSource = {
  lead_ref: leadRef,
  name: "Founder",
  company: "Software",
  company_ref: workspace,
  crm_contact_id: "11",
  crm_company_id: "22",
  discovery: {
    email: "founder@example.com",
    company_domain: "example.com",
    industry: "B2B software",
    person_city: null,
  },
  company_discovery: {
    company_name: "Software",
    company_domain: "example.com",
  },
  lead_research: null,
  company_research: { headquarters_city: "Buenos Aires" },
};
const property: Property = {
  name: "industry",
  label: "Industry",
  type: "enumeration",
  fieldType: "select",
  options: [{ label: "Computer Software", value: "COMPUTER_SOFTWARE" }],
};
// HubSpot remote records carry their single identity value and no record URL.
const hs = (values: Record<string, string | null>) => ({ values, identities: [values.email ?? values.domain].filter((v): v is string => !!v), url: null });
const records = {
  contact: new Map([["11", hs({ email: "founder@example.com" })]]),
  company: new Map([["22", hs({ domain: "example.com", industry: null })]]),
};
const build = (
  s = state,
  p = property,
  r: Parameters<typeof buildPreview>[3] = records,
  l = [lead],
) => buildPreview(s, { contact: [], company: [p] }, l, r, true);
describe("CRM mapping preview", () => {
  it("uses existing mapper to transform Industry to exact portal option", async () => {
    const result = await build();
    expect(result.plan.records).toHaveLength(1);
    expect(result.plan.records[0]?.proposed).toEqual({
      industry: "COMPUTER_SOFTWARE",
    });
    expect(result.plan.records[0]?.expected).toEqual({
      industry: null,
      domain: "example.com",
    });
    expect(result.preview_digest).toHaveLength(64);
  });
  it("preserves populated customer fields under only_if_empty", async () => {
    const result = await build(state, property, {
      ...records,
      company: new Map([
        ["22", hs({ domain: "example.com", industry: "CONSULTING" })],
      ]),
    });
    expect(result.plan.records).toEqual([]);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "skipped_write_rule" }),
      ]),
    );
  });
  it("rejects unavailable enum values and missing properties", async () => {
    expect((await build(state, { ...property, options: [] })).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "invalid_enum" }),
      ]),
    );
    expect(
      (await build(state, { ...property, name: "other" })).plan.records,
    ).toEqual([]);
  });
  it("does not link or update mismatched company identities", async () => {
    expect(
      (
        await build(state, property, {
          ...records,
          company: new Map([["22", hs({ domain: "foreign.com", industry: null })]]),
        })
      ).issues,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "identity_mismatch" }),
      ]),
    );
  });
  it("excludes conflicting proposals for a shared company", async () => {
    const second = {
      ...lead,
      lead_ref: "89700000-0000-4000-a000-000000000005",
      discovery: { ...lead.discovery, industry: "Other" },
    };
    const s = {
      ...state,
      mappings: [
        {
          ...mapping,
          transform_config: {
            map: { "B2B software": "COMPUTER_SOFTWARE", Other: "OTHER" },
          },
        },
      ],
    };
    const result = await build(
      s,
      {
        ...property,
        options: [...property.options!, { label: "Other", value: "OTHER" }],
      },
      records,
      [lead, second],
    );
    expect(result.plan.records).toEqual([]);
    expect(result.issues.some((i) => i.reason === "conflicting_sources")).toBe(
      true,
    );
  });
  it("does not invent personal city from company headquarters", async () => {
    const s = {
      ...state,
      mappings: [
        {
          ...mapping,
          source_path: ["person_city"],
          source_field: "person_city",
          destination_object: "contact" as const,
          destination_field: "city",
          transform: "none" as const,
          transform_config: {},
        },
      ],
    };
    const result = await buildPreview(
      s,
      {
        company: [],
        contact: [
          { name: "city", label: "City", type: "string", fieldType: "text" },
        ],
      },
      [lead],
      records,
      true,
    );
    expect(result.plan.records).toEqual([]);
    expect(result.issues.some((i) => i.reason === "skipped_no_value")).toBe(
      true,
    );
  });
});
