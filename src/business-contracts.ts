import { z } from "zod";

export const RepairIssueSchema = z
  .object({
    code: z.string().max(100),
    path: z.string().max(1000),
    message: z.string().max(500),
    suggestion: z.string().max(1000),
  })
  .strict();
const text = (max: number) => z.string().trim().min(1).max(max);
export const WebsiteUrlSchema = z
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  }, "Use an HTTP(S) URL without credentials.");
export const valueSchema = (max: number) =>
  z.discriminatedUnion("provenance", [
    z.object({ text: text(max), provenance: z.literal("confirmed") }).strict(),
    z
      .object({
        text: text(max),
        provenance: z.literal("inferred"),
        source: z.enum(["website", "public_research"]),
      })
      .strict(),
  ]);
const unique = <T extends z.ZodType>(
  item: T,
  max: number,
  key: (item: z.output<T>) => string,
) =>
  z
    .array(item)
    .max(max)
    .superRefine((items, context) => {
      const seen = new Set<string>();
      items.forEach((item, index) => {
        const normalized = key(item).trim().toLowerCase();
        if (seen.has(normalized))
          context.addIssue({
            code: "custom",
            path: [index],
            message: "Remove duplicate values.",
          });
        seen.add(normalized);
      });
    });
export const WorkspaceIdentitySchema = z
  .object({
    workspace_ref: z.uuid(),
    name: text(200),
    state: z.string().min(1),
  })
  .strict();
const ProfileValues = z
  .object({
    name: text(200),
    website_url: valueSchema(2048)
      .refine((value) => WebsiteUrlSchema.safeParse(value.text).success)
      .nullable(),
    one_liner: valueSchema(300).nullable(),
    description: valueSchema(4000).nullable(),
    value_proposition: valueSchema(500).nullable(),
    offerings: unique(valueSchema(200), 10, (value) => value.text),
    problems_solved: unique(valueSchema(300), 10, (value) => value.text),
  })
  .strict();
export const BusinessProfileSchema = ProfileValues.extend({
  version: z.number().int().positive(),
  updated_at: z.iso.datetime({ offset: true }),
  confirmation: z
    .object({
      complete: z.boolean(),
      missing: z.array(
        z.enum(["value_proposition", "offerings", "problems_solved"]),
      ),
    })
    .strict(),
}).strict();
export const BusinessGetSchema = z
  .object({
    workspace: WorkspaceIdentitySchema.nullable(),
    profile: BusinessProfileSchema.nullable(),
  })
  .strict();
export const BusinessPostSchema = z
  .object({ name: text(200), website_url: WebsiteUrlSchema.nullable() })
  .strict();
export const BusinessPostResultSchema = BusinessGetSchema.extend({
  created: z.boolean(),
  voice: z.object({ version: z.number().int().nonnegative() }).strict(),
}).strict();
const changed = <T extends z.ZodRawShape>(shape: T) =>
  z
    .object(shape)
    .strict()
    .refine(
      (value) => Object.keys(value).some((key) => key !== "expected_version"),
      "Supply at least one changed field.",
    );
export const BusinessPatchSchema = changed({
  expected_version: z.number().int().positive(),
  ...ProfileValues.partial().shape,
});
export const VoiceRuleSchema = z
  .object({
    kind: z.enum(["do", "avoid"]),
    text: text(200),
    source: z.enum(["founder", "founder_feedback", "migration"]),
  })
  .strict();
export const VoiceValuesSchema = z
  .object({
    tone: text(300).nullable(),
    rules: unique(
      VoiceRuleSchema,
      20,
      (value) => `${value.kind}:${value.text}`,
    ),
  })
  .strict();
export const VoicePatchSchema = changed({
  expected_version: z.number().int().nonnegative(),
  ...VoiceValuesSchema.partial().shape,
});
export const VoiceSchema = VoiceValuesSchema.extend({
  version: z.number().int().nonnegative(),
  updated_at: z.iso.datetime({ offset: true }),
}).strict();
export const VoiceGetSchema = z
  .object({ workspace_ref: z.uuid(), voice: VoiceSchema })
  .strict();
const list = (max = 50) => unique(text(200), max, (value) => value).nullable();
export const SenioritySchema = z.enum([
  "owner",
  "founder",
  "c_suite",
  "partner",
  "vp",
  "head",
  "director",
  "manager",
  "senior",
  "entry",
  "intern",
]);
const naicsCodes = unique(z.string().regex(/^[0-9]{2,6}$/), 100, (value) => value).nullable();
// One shape for every lane: an ordered list of non-overlapping ranges.
export const EmployeeRangesSchema = z
  .array(
    z
      .object({
        min: z.number().int().min(1).max(10000000),
        max: z.number().int().min(1).max(10000000).nullable(),
      })
      .strict()
      .refine((range) => range.max === null || range.max >= range.min, "max must not be below min."),
  )
  .min(1)
  .max(20)
  .superRefine((ranges, context) => {
    ranges.forEach((range, index) => {
      const prior = ranges[index - 1];
      if (prior && (prior.max === null || range.min <= prior.max))
        context.addIssue({ code: "custom", path: [index], message: "Use ordered, non-overlapping employee ranges." });
    });
  });
export const CompanyTargetingSchema = z
  .object({
    locations: list(),
    industries: list(),
    industry_codes: naicsCodes,
    excluded_industry_codes: naicsCodes,
    domains: unique(
      z
        .string()
        .trim()
        .max(253)
        .regex(/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/),
      100,
      (value) => value,
    ).nullable(),
    employees: EmployeeRangesSchema.nullable(),
    // Comma-separated employer keyword tags; discovery matches the company, not the person (LIF-1589).
    keywords: text(1000).nullable(),
  })
  .strict();
export const PersonaEmailRequirementSchema = z.enum(["verified", "optional"]);
const PersonaValues = {
  name: text(120),
  titles: unique(text(200), 100, (value) => value).min(1),
  persona_type: text(100).nullable(),
  email_requirement: PersonaEmailRequirementSchema.default("verified"),
};
const LaneFilters = {
  seniorities: unique(SenioritySchema, 11, (value) => value).nullable(),
  person_locations: list(),
  company: CompanyTargetingSchema,
};
// Persona ids are opaque server ids. Migrated personas carry md5-derived ids
// without RFC 4122 version/variant bits, so accept any GUID shape.
export const PersonaSchema = z.object({ id: z.guid(), ...PersonaValues }).strict();
export const TargetingLaneSchema = z
  .object({ id: z.uuid(), personas: unique(PersonaSchema, 30, (value) => value.id).min(1), ...LaneFilters })
  .strict();
export const TargetingSchema = z
  .object({
    version: z.number().int().positive(),
    updated_at: z.iso.datetime({ offset: true }),
    lanes: TargetingLaneSchema.array().min(1).max(20),
  })
  .strict();
export const TargetingGetSchema = z
  .object({ workspace_ref: z.uuid(), targeting: TargetingSchema.nullable() })
  .strict();

// Research fields: what Scout must find for every lead (custom_fields.<key>).
export const ResearchFieldSchema = z
  .object({
    key: z
      .string()
      .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){0,4}$/, "Use lowercase snake_case segments separated by dots."),
    description: text(2000),
    type: z.enum(["text", "number", "boolean", "list", "object"]),
  })
  .strict();
export const ResearchFieldsSchema = unique(ResearchFieldSchema, 100, (value) => value.key);
const CriteriaValues = {
  text: z.string().trim().min(200).max(64000).nullable(),
  research_fields: ResearchFieldsSchema,
};
export const SourceVersionsSchema = z
  .object({
    profile_version: z.number().int().positive(),
    targeting_version: z.number().int().positive().optional(),
    draft_version: z.number().int().positive().optional(),
    base_version: text(200),
  })
  .strict();
export const CriteriaSchema = z
  .object({
    version: z.number().int().nonnegative(),
    updated_at: z.iso.datetime({ offset: true }),
    ...CriteriaValues,
    source_versions: SourceVersionsSchema,
  })
  .strict();
export const CriteriaGetSchema = z
  .object({ workspace_ref: z.uuid(), criteria: CriteriaSchema.nullable() })
  .strict();
// The server records source versions; clients send only the criteria values.
export const CriteriaPatchSchema = changed({
  expected_version: z.number().int().positive(),
  ...z.object(CriteriaValues).partial().shape,
});

// Lane changes: {id, ...} patches a lane (omitted fields stay), {id, remove:
// true} removes it, and a lane without id is added. Personas without id are new.
// PATCH omission must reach the database unchanged so a rename preserves policy.
const PersonaInputSchema = z.object({ id: z.guid().optional(), ...PersonaValues,
  email_requirement: PersonaEmailRequirementSchema.optional(),
}).strict();
const LanePersonas = unique(PersonaInputSchema, 30, (value) => value.id ?? `name:${value.name}`).min(1);
export const TargetingLaneChangeSchema = z.union([
  z.object({ id: z.uuid(), remove: z.literal(true) }).strict(),
  z
    .object({
      id: z.uuid(),
      personas: LanePersonas.optional(),
      seniorities: LaneFilters.seniorities.optional(),
      person_locations: LaneFilters.person_locations.optional(),
      company: CompanyTargetingSchema.partial().optional(),
    })
    .strict()
    .refine((value) => Object.keys(value).some((key) => key !== "id"), "Supply a changed lane field."),
  z.object({ personas: LanePersonas, ...LaneFilters, company: CompanyTargetingSchema.partial() }).strict(),
]);
export const TargetingPatchSchema = z
  .object({
    expected_version: z.number().int().positive(),
    lanes: z
      .array(TargetingLaneChangeSchema)
      .min(1)
      .max(20)
      .superRefine((lanes, context) => {
        const ids = lanes.flatMap((lane) => ("id" in lane ? [lane.id] : []));
        if (new Set(ids).size !== ids.length)
          context.addIssue({ code: "custom", message: "Change each lane at most once." });
      }),
    regenerated_criteria: CriteriaPatchSchema.optional(),
  })
  .strict();

// Setup draft: Targeting without ids (the server assigns them on submit), the
// inputs the criteria are written from, and the evidence behind them.
const DraftLaneSchema = z
  .object({ personas: unique(z.object({ ...PersonaValues, email_requirement: PersonaEmailRequirementSchema.optional() }).strict(), 30, (value) => value.name).min(1), ...LaneFilters })
  .strict();
export const CriteriaInputsSchema = z
  .object({
    primary_motion: z.object({ name: text(200) }).strict().nullable(),
    disqualifiers: unique(text(1000), 30, (value) => value),
    size: z.object({ floor: z.number().positive(), unit: text(100) }).strict().nullable(),
    broad_search_confirmed: z.boolean(),
    operating_state: text(1000).nullable(),
    parked_motions: unique(text(500), 20, (value) => value),
    personas: unique(
      z
        .object({ name: text(120), role: z.enum(["decision_maker", "influencer"]), tell: text(1000) })
        .strict(),
      100,
      (value) => value.name,
    ),
  })
  .strict();
export const SetupDraftSchema = z
  .object({
    targeting: z.object({ lanes: DraftLaneSchema.array().min(1).max(20) }).strict(),
    criteria_inputs: CriteriaInputsSchema,
    evidence: z
      .array(
        z
          .object({
            kind: z.enum(["website", "public_research", "founder_statement"]),
            text: text(4000),
            source_url: WebsiteUrlSchema.optional(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict()
  .superRefine((draft, context) => {
    const names = draft.targeting.lanes.flatMap((lane) => lane.personas.map((persona) => persona.name.toLowerCase()));
    if (new Set(names).size !== names.length)
      context.addIssue({ code: "custom", path: ["targeting", "lanes"], message: "Use a distinct name for every persona." });
    draft.criteria_inputs.personas.forEach((persona, index) => {
      if (!names.includes(persona.name.toLowerCase()))
        context.addIssue({
          code: "custom",
          path: ["criteria_inputs", "personas", index, "name"],
          message: "Name a persona from the draft targeting.",
        });
    });
  });
const SETUP_GATES = ["motion", "market", "exclusions", "boundaries", "persona"] as const;
export const SetupGatesSchema = z
  .object({
    next: z.enum(SETUP_GATES).nullable(),
    missing: z.array(z.enum(SETUP_GATES)),
    issues: z.array(z.object({ path: z.string(), message: z.string() }).strict()).max(20),
  })
  .strict();
export const GeneratedCriteriaSchema = z
  .object({
    ...CriteriaValues,
    text: CriteriaValues.text.unwrap(),
    source_versions: z.object({ profile_version: z.number().int().positive(), base_version: text(200) }).strict(),
  })
  .strict();
export const SetupDraftGetSchema = z
  .object({
    workspace_ref: z.uuid(),
    version: z.number().int().nonnegative(),
    draft: SetupDraftSchema.nullable(),
    generated_criteria: GeneratedCriteriaSchema.extend({
      source_versions: GeneratedCriteriaSchema.shape.source_versions.extend({
        draft_version: z.number().int().positive(),
      }),
    })
      .strict()
      .nullable(),
    gates: SetupGatesSchema,
    submitted: z.boolean(),
    updated_at: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict();
export const SetupDraftPatchSchema = z
  .object({
    expected_version: z.number().int().nonnegative(),
    draft: SetupDraftSchema,
    generated_criteria: GeneratedCriteriaSchema.nullable(),
  })
  .strict();
export const SetupPostSchema = z
  .object({ expected_draft_version: z.number().int().positive() })
  .strict();
export const SetupStatusSchema = z.discriminatedUnion("state", [
  z.object({ workspace_ref: z.uuid(), state: z.literal("none") }).strict(),
  z
    .object({
      workspace_ref: z.uuid(),
      state: z.literal("imported"),
      setup_ref: z.uuid(),
      draft_version: z.number().int().positive(),
      profile_version: z.number().int().positive(),
      targeting_version: z.number().int().positive(),
      criteria_version: z.number().int().positive(),
      submitted_at: z.iso.datetime({ offset: true }),
    })
    .strict(),
]);
export const SetupDiscardSchema = z
  .object({ workspace_ref: z.uuid(), discarded: z.literal(true) })
  .strict();
export const SetupContextDataSchema = z
  .object({
    workspace_ref: z.uuid(),
    profile: BusinessProfileSchema,
    draft: SetupDraftGetSchema,
    base: z
      .object({ version: text(200), text: z.string().min(1).max(200000) })
      .strict(),
  })
  .strict();
export const SetupContextSchema = SetupContextDataSchema.extend({
  generation_rules: z.array(z.string()),
  criteria_schema: z.record(z.string(), z.unknown()),
  draft_schema: z.record(z.string(), z.unknown()),
}).strict();
export const SETUP_GENERATION_RULES = [
  "Use only confirmed profile facts. Keep business facts out of the criteria text: Scout receives the versioned profile at run time.",
  "Generate only Scout criteria from the server draft. Structured Targeting filters run before research; never duplicate filterable exclusions as research rules.",
  "Include ICP gate, evidence-based hard disqualifiers, operating-state split and A/B/C tier definitions. Preserve primary and parked motions and each persona role and tell.",
  "List the custom facts Scout must return as research_fields {key, description, type}.",
  "Use the current base text returned here; do not invent or request a hidden base. Preserve its mandatory output requirements and platform rules.",
  "Save generated criteria with profile_version and base_version from this context; the server binds them to the saved draft version. Changed sources require fresh generation.",
  "Setup writes Targeting and criteria once. Saving or submitting setup does not activate recurring research or outreach.",
];
