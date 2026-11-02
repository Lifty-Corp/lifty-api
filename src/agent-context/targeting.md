# Targeting

Targeting owns the people and company search filters and the personas. Read every saved lane before editing. Filter first: research costs time and budget, so an exclusion a search filter can express belongs here before any research runs (excluded_industry_codes, company.employees, locations). Explain that to the founder in one sentence. Only exclusions that need evidence go to the research criteria.

A lane has personas, seniorities, person_locations and company `{locations, industries, industry_codes, excluded_industry_codes, domains, employees, keywords}`. Lanes have no names; the server assigns lane and persona ids. NAICS industry_codes and excluded_industry_codes use the public 2–6 digit standard; validate codes against the official NAICS reference at https://www.census.gov/naics/ . company.employees is always a list of ordered, non-overlapping `{min, max}` ranges; max null means no ceiling. A persona is `{id, name, titles, persona_type, email_requirement}`; its role and organizational tell belong to the criteria inputs. Allocation and data-quality settings are platform policy, not targeting. Follow references.configuration for each filter's meaning.

PATCH sends expected_version and lanes:

- `{id, ...fields}` changes that lane; omitted fields, including omitted company keys, stay as they are. Null clears a filter.
- A lane without id is added (personas required); the server assigns its id.
- `{id, remove: true}` removes that lane and carries no other keys. At least one lane must remain.

Lanes you do not list stay unchanged. personas, when given, replaces that lane's list: keep each existing persona's id to preserve its identity; a persona without id is new.

company.industries accepts only the published industry labels (the enum in the PATCH schema), written exactly as listed, and industry codes must exist in 2022 NAICS. Translate the founder's words into labels or codes yourself; never ask the founder for either. Another value returns 422 TARGETING_INVALID with the field path, the rejected value and close valid options; resend the option that keeps the founder's meaning. A read lists saved values search cannot use in filter_warnings: they find nobody, so replace them with a filter-only PATCH that keeps the confirmed meaning and tell the founder in one line.

A persona change (added, removed, renamed, titles, type or email requirement changed) needs regenerated_criteria in the same PATCH, because the criteria describe the personas: both change together or neither does. regenerated_criteria carries the criteria expected_version and the regenerated text and/or research_fields; author it with references.configuration. Without it the server returns CRITERIA_REGENERATION_REQUIRED and writes nothing. Filter-only edits regenerate nothing.

Changed filters affect the next discovery; people already found are not repeated. After calibration, when several people were disqualified for a reason a filter could cover, propose that filter and explain that it keeps research on people who can fit (references.calibration). On VERSION_CONFLICT read the latest targeting and reapply only the intended change. Initial creation belongs to setup; targeting is never deleted or activated here.

`email_requirement` is `verified` (the default for new personas) or `optional`. Optional email admits email-unavailable prospects only while LinkedIn is active; it never permits email outreach to placeholder addresses. Preserve this field and each stable persona id when renaming or changing titles. Omitting it in PATCH preserves the saved persona policy; omitting it for a new persona defaults to verified.

company.keywords restricts the employer, never the person: a company passes when it is tagged with any of the comma-separated terms. Keep each term to one or two words; a long phrase or a company name usually matches nobody, and named companies belong in company.domains (references.configuration).
