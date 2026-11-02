# Business setup

The workspace server draft is the only source. Create and confirm the commercial profile first. Read the draft before asking and save each confirmed block with setup_patch_draft, its expected_version and generated_criteria: null. Follow references.interview for the conversation and references.configuration for generation. No duplicate company facts, outreach status or lead-volume knobs belong in the draft.

The draft has three parts:

- targeting: `{lanes}`, the Targeting lane shape without ids. Each lane has personas `{name, titles, persona_type, email_requirement}`, seniorities, person_locations and company filters; company.employees is a list of `{min, max}` ranges. Persona names are unique across the draft; setup assigns lane and persona ids.
- criteria_inputs: primary_motion `{name}`, disqualifiers (exclusions that need evidence), size `{floor, unit}` for a size metric other than employees (for example ARR), broad_search_confirmed, operating_state, parked_motions and personas `[{name, role, tell}]` whose names match draft personas.
- evidence: website, public_research or founder_statement entries with an optional source_url.

Each save returns gates; ask only gates.next. The server computes them in this order:

| Gate | Passes when |
| --- | --- |
| motion | primary_motion.name is set; other motions are parked |
| market | a lane has company.industries or company.industry_codes, and a lane has company.employees or criteria_inputs.size is set |
| exclusions | disqualifiers has an entry or a lane has company.excluded_industry_codes |
| boundaries | a lane has person_locations, company.locations, company.employees or company.keywords, or broad_search_confirmed is true |
| persona | a criteria_inputs.personas entry has role and tell and names a draft persona |

Filter first: an exclusion a search filter can express (industry codes, employees, locations) goes in the lane before research spends budget on it; disqualifiers hold only exclusions that need evidence. Set broad_search_confirmed only after the founder explicitly accepts a search with no location, employee or keyword limit. An empty parked_motions list is valid. Never invent exclusions or boundaries just to pass a gate. gates.issues are technical; repair them yourself.

Read setup_generation_context for the actual current Scout base, confirmed profile, draft and API schemas/rules. Generate only the criteria, then save the unchanged draft with generated_criteria `{text, research_fields, source_versions: {profile_version, base_version}}` copied from that context; the server binds the resulting draft version. Never translate targeting into a second local artifact or compute versions yourself.

Draft saves accept only published industry labels and 2022 NAICS codes, and submission refuses a saved draft holding any other value: a save returns 422 SETUP_DRAFT_INVALID and a submission 422 SETUP_INVALID, with `/draft/...` paths and close options. Repair it with setup_patch_draft, then submit the version it returns.

Submit setup_post `{expected_draft_version}` once. The transaction creates Targeting and criteria together at version 1, assigns lane and persona ids and returns an imported receipt with setup_ref and exact versions. Same version replays that receipt. Lost response: read status; a failed read means unknown. SETUP_STALE names stale_sources; read fresh context and regenerate. Another setup version cannot overwrite an existing setup.

Discard the draft with DELETE only before submission; after submission it is immutable history. Later edits use each resource's PATCH. Saving/submitting does not activate recurring research, CRM sync or outreach. Use next_step to resume the existing checkpoint ids.

For a new persona, omit `email_requirement` or use `verified`. Use `optional` only when the founder confirms email-unavailable discovery for that persona; it is effective only while LinkedIn is active. Follow references.targeting when preserving an existing persona policy.
