export const workspaceRef = "22222222-2222-4222-8222-222222222222";
export const profileFixture = {
  version: 1,
  updated_at: "2026-10-01T18:00:00Z",
  name: "Example",
  website_url: null,
  one_liner: null,
  description: null,
  value_proposition: {
    text: "Less manual research",
    provenance: "confirmed" as const,
  },
  offerings: [{ text: "Research service", provenance: "confirmed" as const }],
  problems_solved: [
    { text: "Manual research takes time", provenance: "confirmed" as const },
  ],
  confirmation: { complete: true, missing: [] },
};
export const membershipFixture = {
  workspace_ref: workspaceRef,
  slug: "example",
  name: "Example",
  active: true,
  founder_default: true,
  self_service: true,
};
export const laneFixture = {
  id: "33333333-3333-4333-8333-333333333333",
  personas: [
    {
      id: "44444444-4444-4444-8444-444444444444",
      name: "Founder",
      titles: ["Founder"],
      persona_type: null,
    },
  ],
  seniorities: ["founder"],
  person_locations: ["Argentina"],
  company: {
    locations: ["Argentina"],
    industries: ["computer software"],
    industry_codes: ["5415"],
    excluded_industry_codes: ["5241"],
    domains: null,
    employees: [{ min: 11, max: 200 }],
    keywords: "B2B SaaS",
  },
};
export const criteriaFixture = {
  version: 1,
  updated_at: "2026-10-01T18:00:00Z",
  text: "## ICP gate\n" + "Evidence based criteria. ".repeat(20),
  research_fields: [
    { key: "role_start_date", description: "Start date of the lead's current role.", type: "text" as const },
  ],
  source_versions: {
    profile_version: 1,
    targeting_version: 1,
    base_version: "base-v1",
  },
};
const { id: _laneId, personas: lanePersonas, ...laneFilters } = laneFixture;
export const draftFixture = {
  targeting: {
    lanes: [{ ...laneFilters, personas: lanePersonas.map(({ id: _id, ...persona }) => persona) }],
  },
  criteria_inputs: {
    primary_motion: { name: "Find customers" },
    disqualifiers: ["Already uses an in-house research team"],
    size: null,
    broad_search_confirmed: false,
    operating_state: "Founder owns sales",
    parked_motions: [],
    personas: [{ name: "Founder", role: "decision_maker", tell: "Leads sales" }],
  },
  evidence: [
    { kind: "founder_statement", text: "Founder confirmed the market" },
  ],
};
export const draftGetFixture = {
  workspace_ref: workspaceRef,
  version: 1,
  draft: draftFixture,
  generated_criteria: null,
  gates: { next: null, missing: [], issues: [] },
  submitted: false,
  updated_at: "2026-10-01T18:00:00Z",
};
