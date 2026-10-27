import { z } from "zod";
import { WorkspaceIdentitySchema } from "./business-contracts.js";
import { WritingRecommendationsSchema, templateRef } from "./writing-rules.js";
import { TEST_FAILURE_CODES, TEST_FAILURE_STAGES } from "./campaign-test-failure.js";

const Ref = z.uuid();
const Version = z.number().int().positive();
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Timestamp = z.iso.datetime({ offset: true });
const Name = z.string().trim().min(1).max(200);
const text = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value));
const uniqueRefs = z.array(Ref).min(1).max(500).refine(values => new Set(values).size === values.length);
const DayCount = z.number().int().min(0).max(365);
export const DelaySchema = z.union([z.object({ days: DayCount }).strict(), z.object({ business_days: DayCount }).strict()]);
export const AudienceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("qualified") }).strict(),
  z.object({ kind: z.literal("static"), lead_refs: uniqueRefs }).strict(),
]);
export const StopsSchema = z.array(z.enum(["reply", "meeting_booked", "suppression", "manual_stop"])).length(4)
  .refine(values => new Set(values).size === values.length, "Keep all four shared stops.");
export const JourneyPolicySchema = z.object({ audience: AudienceSchema, stops: StopsSchema }).strict();
// Alternatives: the first condition due starts the Campaign once.
const StartCondition = z.discriminatedUnion("type", [
  z.object({ type: z.literal("journey_start") }).strict(),
  z.object({ type: z.literal("sent"), campaign_ref: Ref, step: z.number().int().min(1).max(10), after: DelaySchema }).strict(),
  z.object({ type: z.literal("unaccepted"), campaign_ref: Ref, after: z.object({ business_days: DayCount }).strict() }).strict(),
  z.object({ type: z.literal("linkedin_first_dm_skipped"), campaign_ref: Ref }).strict(),
]);
export const StartSchema = z.array(StartCondition).min(1).max(3).superRefine((conditions, context) => {
  if (new Set(conditions.map(condition => JSON.stringify(condition))).size !== conditions.length)
    context.addIssue({ code: "custom", message: "Use distinct start conditions." });
  if (conditions.some(condition => condition.type === "journey_start") && conditions.length !== 1)
    context.addIssue({ code: "custom", message: "journey_start is the only condition of a Campaign that starts the Journey." });
});
const Schedule = z.object({ timezone: z.string().min(1).max(100).refine(value => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
}), weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).refine(values => new Set(values).size === values.length),
start: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), end: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
}).strict().refine(value => value.start < value.end, "The local sending window must end after it starts.");
const LaneName = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
const Subject = text(300).refine(value => !/[\r\n]/.test(value));
const CatalogId = z.string().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/);
const Arm = z.enum(["direct", "pain", "personal", "strategic"]);
const line = (max: number) => text(max).refine(value => !/[\r\n]/.test(value));
const DisplayName = text(100).refine(value => !/[\u0000-\u001f\u007f]/.test(value), "Use a nonblank single-line template name of at most 100 characters.");
const Template = z.object({ subject: Subject.optional(), text: text(20000), display_name: DisplayName.optional(),
  id: CatalogId.optional(), arms: z.array(Arm).min(1).max(4).refine(values => new Set(values).size === values.length).optional(),
  variant: CatalogId.optional(), coverage: z.enum(["broad", "signal_specific"]).optional(),
  fit: line(2000).optional(),
  slots_spec: line(4000).optional().describe("Free-form guidance the writer reads about the slots this template's subject and text use. The text defines the slots; this spec never adds or removes one."),
}).strict();
const Variant = Template.extend({ lane: LaneName.optional(), opener: z.enum(["cold", "linkedin_bridge"]).optional() }).strict();
const Step = z.object({ position: z.number().int().min(1).max(5), delay: DelaySchema,
  template: Template.optional(), variants: z.array(Variant).min(1).max(40).optional(),
  writing_instructions: text(10000).optional().describe("Optional guidance for this message in generate mode; preserves campaign-wide instructions and Business voice."),
}).strict();
// Deterministic content lanes: the lead's title picks the first rule whose
// terms it contains, otherwise (including a missing title) the default lane.
export const LanesSchema = z.object({ field: z.literal("title"), default: LaneName,
  rules: z.array(z.object({ lane: LaneName, contains_any: z.array(z.string().trim().min(1).max(60)).min(1).max(20) }).strict()).min(1).max(10),
}).strict().superRefine((lanes, context) => {
  const names = lanes.rules.map(rule => rule.lane);
  if (new Set(names).size !== names.length || names.includes(lanes.default))
    context.addIssue({ code: "custom", message: "Use each lane in one rule and a different default lane." });
});
const CampaignPolicyFields = z.object({
  start: StartSchema,
  steps: z.array(Step).min(1).max(5).describe("The saved sequence owns its count. Executable adapter: LinkedIn invitation then 1–3 messages, the first waiting its delay after acceptance; email 1–5 steps with delays up to 30 days or business days."),
  compose_mode: z.enum(["generate", "templates"]), instructions: z.string().max(30000), lanes: LanesSchema.optional(),
  schedule: Schedule, profile_version: Version, voice_version: z.number().int().nonnegative(),
}).strict();
function laneNames(lanes: z.infer<typeof LanesSchema> | undefined): Array<string | undefined> {
  return lanes ? [...new Set([...lanes.rules.map(rule => rule.lane), lanes.default])] : [undefined];
}
function catalogOpener(variant: z.infer<typeof Variant>) {
  return variant.opener ?? (variant.variant?.endsWith("-cold") ? "cold"
    : variant.variant?.endsWith("-bridge") ? "linkedin_bridge" : undefined);
}
function templateFamily(variant: z.infer<typeof Variant>) {
  return variant.variant?.replace(/-(cold|bridge|both)$/, "") ?? "";
}
export const CampaignPolicySchema = CampaignPolicyFields.superRefine((policy, context) => {
  const templates = policy.steps.flatMap(step => step.template ? [step.template] : step.variants ?? []);
  const catalog = templates.some(template => [template.id, template.arms, template.variant, template.coverage, template.fit, template.slots_spec].some(value => value !== undefined));
  if (catalog && (!templates.every(template => template.id && template.arms) || new Set(templates.map(template => template.id)).size !== templates.length))
    context.addIssue({ code: "custom", path: ["steps"], message: "An authored catalog retains distinct source IDs and permitted arms for every template." });
  if (policy.lanes && policy.compose_mode !== "templates")
    context.addIssue({ code: "custom", path: ["lanes"], message: "Content lanes route saved templates." });
  policy.steps.forEach((step, index) => {
    const days = "days" in step.delay ? step.delay.days : step.delay.business_days;
    if (step.position !== index + 1 || (index > 0 && days < 1))
      context.addIssue({ code: "custom", path: ["steps", index], message: "Use contiguous positions; later delays are positive." });
    const templated = step.template !== undefined || step.variants !== undefined;
    if ((policy.compose_mode === "templates") !== templated || (step.template !== undefined && step.variants !== undefined))
      context.addIssue({ code: "custom", path: ["steps", index], message: "Templates mode saves one template or its variants per step; generate mode uses instructions." });
    if (step.template && policy.lanes)
      context.addIssue({ code: "custom", path: ["steps", index, "template"], message: "Campaigns with content lanes save one variant per lane." });
    if (step.variants) {
      if (catalog && step.variants.some(variant => variant.variant?.endsWith("-both") && (index !== 0 || variant.opener)))
        context.addIssue({ code: "custom", path: ["steps", index, "variants"], message: "Prior-email templates are retained only as dormant first-step source records." });
      const routes = catalog && index === 0 ? step.variants.filter(variant => !variant.variant?.endsWith("-both")) : step.variants;
      const openerFor = (variant: z.infer<typeof Variant>) => catalog && index === 0 ? catalogOpener(variant) : variant.opener;
      const openers = routes.some(variant => openerFor(variant)) ? ["cold", "linkedin_bridge"] : [undefined];
      if (openers[0] && index !== 0)
        context.addIssue({ code: "custom", path: ["steps", index, "variants"], message: "Only the first email has cold and linkedin_bridge openers." });
      if (!catalog && !policy.lanes && !openers[0])
        context.addIssue({ code: "custom", path: ["steps", index, "variants"], message: "Variants require content lanes or first-email openers." });
      const expected = laneNames(policy.lanes).flatMap(lane => openers.map(opener => `${lane ?? ""}|${opener ?? ""}`));
      const keys = routes.map(variant => `${variant.lane ?? ""}|${openerFor(variant) ?? ""}`);
      if (catalog ? expected.some(key => !keys.includes(key)) || keys.some(key => !expected.includes(key))
        : keys.length !== expected.length || new Set(keys).size !== keys.length || keys.some(key => !expected.includes(key)))
        context.addIssue({ code: "custom", path: ["steps", index, "variants"], message: "Keep every required lane and opener; implicit templates have exactly one variant per route." });
      if (catalog && index === 0 && openers[0]) {
        const families = new Set(routes.flatMap(variant => variant.arms?.map(arm => `${variant.lane ?? ""}|${templateFamily(variant)}|${arm}`) ?? []));
        for (const family of families) {
          if (openers.some(opener => !routes.some(variant => openerFor(variant) === opener
            && variant.arms?.some(arm => `${variant.lane ?? ""}|${templateFamily(variant)}|${arm}` === family))))
            context.addIssue({ code: "custom", path: ["steps", index, "variants"], message: "Keep both openers for each authored research route." });
        }
      }
    }
  });
});
export function campaignChannelIssues(policy: z.infer<typeof CampaignPolicySchema>, channel: "email" | "linkedin") {
  const issues: string[] = [];
  if (channel !== "email" && policy.start.some(condition => condition.type === "linkedin_first_dm_skipped"))
    issues.push("Only an Email Campaign may start after a LinkedIn first DM is skipped.");
  if (channel === "email" && policy.steps.length > 5) issues.push("The executable adapter supports one to five saved emails.");
  if (channel === "linkedin" && policy.steps.length > 3) issues.push("The executable adapter supports one to three saved LinkedIn messages after the invitation.");
  // LinkedIn's first delay waits after the invitation is accepted; an email
  // sequence starts with its Campaign.
  const firstDelay = policy.steps[0]?.delay;
  if (channel === "email" && firstDelay && ("days" in firstDelay ? firstDelay.days : firstDelay.business_days) !== 0) issues.push("The first email has no delay: the sequence starts with its Campaign.");
  for (const step of policy.steps) {
    if (channel === "email" && ("days" in step.delay ? step.delay.days : step.delay.business_days) > 30) issues.push("Email delays are up to 30 days or business days.");
    for (const template of [step.template, ...(step.variants ?? [])]) {
      if (!template) continue;
      if (channel === "email" && (step.position === 1) !== (template.subject !== undefined))
        issues.push("An email thread has one subject: the first email's. Later emails reply in the thread.");
      if (channel === "linkedin" && (template.subject !== undefined || template.text.length > 3000))
        issues.push("LinkedIn templates have text only, at most 3000 characters.");
    }
    if (channel === "email" && step.position === 1 && step.variants) {
      const subjects = new Map<string, Set<string | undefined>>();
      for (const variant of step.variants) {
        const routes = variant.id ? variant.arms?.map(arm => `${variant.lane ?? ""}|${templateFamily(variant)}|${arm}`) ?? [] : [variant.lane ?? ""];
        for (const route of routes) {
          const saved = subjects.get(route) ?? new Set(); saved.add(variant.subject); subjects.set(route, saved);
        }
      }
      if ([...subjects.values()].some(values => values.size > 1))
        issues.push("Both openers of a saved route start the same thread: use one subject per route.");
    }
    if (channel === "linkedin" && step.variants?.some(variant => variant.opener || catalogOpener(variant)))
      issues.push("Only Email templates have cold and linkedin_bridge openers.");
  }
  const first = policy.steps[0];
  const firstTemplates = first?.template ? [{ ...first.template, lane: undefined }] : first?.variants ?? [];
  if (firstTemplates.some(template => template.id)) {
    const routes = firstTemplates.filter(template => !template.variant?.endsWith("-both"))
      .flatMap(template => template.arms?.map(arm => ({ arm, lane: template.lane, family: templateFamily(template) })) ?? []);
    for (const step of policy.steps.slice(1)) {
      const choices = step.template ? [{ ...step.template, lane: undefined }] : step.variants ?? [];
      if (routes.some(route => !choices.some(template => template.arms?.includes(route.arm)
        && template.lane === route.lane && (channel === "linkedin" || templateFamily(template) === route.family))))
        issues.push("Every authored first-step route must retain a compatible template in each later step.");
    }
  }
  return [...new Set(issues)];
}
// Jobs renders single-brace slots: {first_name} and {company} from the lead,
// {sender_first_name} from the email mailbox, and any other lower-case slot
// from the writer. A request's mail-merge spelling of those fields is saved in
// that syntax; any other brace would reach the composer unrendered and fail
// every preview (LIF-1333). Saved revisions are read as stored.
const MERGE_FIELDS: Record<string, string> = { first_name: "first_name", company: "company", company_name: "company", sender_first_name: "sender_first_name" };
export function canonicalTemplateText(value: string): string {
  return value.replace(/\{\{\s*([A-Za-z_]+)\s*\}\}|\{(company_name)\}/g, (match, double?: string, single?: string) => {
    const field = MERGE_FIELDS[(double ?? single)!.toLowerCase()];
    return field ? `{${field}}` : match;
  });
}
// LIF-1454: a template's subject and text define its slots; slots_spec is
// prose the writer reads. A spec naming a placeholder its own template never
// uses is reported, never enforced: prose may mention one on purpose
// ("No {main_focus}"), and saved bytes are never changed.
const PLACEHOLDER = /\{[a-z][a-z0-9_]*\}/g;
export const SlotsSpecWarningsSchema = z.object({ revision_ref: Ref,
  unused_placeholders: z.array(z.object({ position: z.number().int().positive(), template: z.string().nullable(),
    placeholder: z.string() }).strict()).min(1),
}).strict();
export type SlotsSpecWarnings = z.infer<typeof SlotsSpecWarningsSchema>;
interface SpecTemplate { id?: string | undefined; lane?: string | undefined; opener?: string | undefined;
  subject?: string | undefined; text: string; slots_spec?: string | undefined }
/** Placeholders each template's slots_spec names that its own subject and
 * text do not use. Null when there are none. */
export function slotsSpecWarnings(revision: { revision_ref: string;
  content: { steps: Array<{ position: number; template?: SpecTemplate | undefined; variants?: SpecTemplate[] | undefined }> } }): SlotsSpecWarnings | null {
  const unused = revision.content.steps.flatMap(step => [...(step.template ? [step.template] : []), ...(step.variants ?? [])].flatMap(template => {
    if (!template.slots_spec) return [];
    const used = new Set(canonicalTemplateText(`${template.subject ?? ""}\n${template.text}`).match(PLACEHOLDER));
    const named = new Set(canonicalTemplateText(template.slots_spec).match(PLACEHOLDER));
    return [...named].filter(placeholder => !used.has(placeholder))
      .map(placeholder => ({ position: step.position, template: templateRef(template), placeholder }));
  }));
  return unused.length ? { revision_ref: revision.revision_ref, unused_placeholders: unused } : null;
}
const canonicalTemplate = <T extends { text: string; subject?: string | undefined }>(template: T): T =>
  ({ ...template, text: canonicalTemplateText(template.text), ...(template.subject === undefined ? {} : { subject: canonicalTemplateText(template.subject) }) });
const canonicalSteps = (steps: z.infer<typeof Step>[]) => steps.map(step => ({ ...step,
  ...(step.template ? { template: canonicalTemplate(step.template) } : {}), ...(step.variants ? { variants: step.variants.map(canonicalTemplate) } : {}) }));
function placeholderIssues(steps: z.infer<typeof Step>[] | undefined, context: z.RefinementCtx, path: Array<string | number>, channel?: "email" | "linkedin") {
  steps?.forEach((step, index) => {
    const choices = step.template ? [{ template: step.template, path: ["template"] as Array<string | number> }]
      : (step.variants ?? []).map((template, variantIndex) => ({ template, path: ["variants", variantIndex] as Array<string | number> }));
    choices.forEach(({ template, path: templatePath }) => {
      for (const field of ["subject", "text"] as const) {
        const saved = template[field];
        if (saved === undefined) continue;
        const value = canonicalTemplateText(saved);
        const message = /\{\{?\s*last_name\s*\}?\}/.test(value)
          ? "Lifty fills only {first_name} and {company} from the lead; leave the last name out."
          : /[{}]/.test(value.replace(/\{[a-z][a-z0-9_]*\}/g, ""))
            ? "Write placeholders with single braces and a lower-case name: {first_name}, {company}, or a writer slot such as {pain}."
            : channel === "linkedin" && value.includes("{sender_first_name}")
              ? "{sender_first_name} is filled only in email; a LinkedIn message already comes from its sender."
              : undefined;
        if (message) context.addIssue({ code: "custom", path: [...path, index, ...templatePath, field], message });
      }
    });
  });
}
export const JourneyPathSchema = z.object({ journey_ref: Ref }).strict();
export const CampaignPathSchema = z.object({ campaign_ref: Ref }).strict();
export const PageQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).optional(), cursor: Ref.optional() }).strict();
export const CampaignQuerySchema = PageQuerySchema.extend({ journey_ref: Ref.optional(), channel: z.enum(["linkedin", "email"]).optional() }).strict();
export const JourneyCreateSchema = z.object({ name: Name, policy: JourneyPolicySchema }).strict();
export const CampaignCreateSchema = z.object({ name: Name, journey_ref: Ref, channel: z.enum(["linkedin", "email"]), policy: CampaignPolicySchema }).strict()
  .superRefine((value, context) => {
    campaignChannelIssues(value.policy, value.channel).forEach(message => context.addIssue({ code: "custom", path: ["policy"], message }));
    placeholderIssues(value.policy.steps, context, ["policy", "steps"], value.channel);
  }).transform(value => ({ ...value, policy: { ...value.policy, steps: canonicalSteps(value.policy.steps) } }));
export const JourneyDraftSchema = z.object({ expected_version: Version, revision_ref: Ref,
  changes: JourneyPolicySchema.partial().strict().refine(value => Object.keys(value).length > 0),
}).strict();
export const CampaignDraftSchema = z.object({ expected_version: Version, revision_ref: Ref,
  changes: CampaignPolicyFields.extend({ lanes: LanesSchema.nullable() }).partial().strict().refine(value => Object.keys(value).length > 0),
}).strict().superRefine((value, context) => placeholderIssues(value.changes.steps, context, ["changes", "steps"]))
  .transform(value => value.changes.steps ? { ...value, changes: { ...value.changes, steps: canonicalSteps(value.changes.steps) } } : value);
export const ExactRevisionSchema = z.object({ revision_ref: Ref, digest: Digest }).strict();
export const PublishSchema = ExactRevisionSchema.extend({ expected_version: Version }).strict();
export const ActivateSchema = PublishSchema;
export const CampaignPauseSchema = z.object({ expected_version: Version }).strict();
const Approval = z.object({ actor_ref: Ref, approved_at: Timestamp }).strict();
const revision = <T extends z.ZodType>(content: T) => ExactRevisionSchema.extend({ content, created_at: Timestamp, approval: Approval.nullable() }).strict();
export const JourneyRevisionSchema = revision(JourneyPolicySchema);
// Stored history remains readable when a newer authoring/readiness rule rejects
// it. Writes and exact publication are validated authoritatively in Functions;
// response parsing checks source shape without reinterpreting saved policy.
// LIF-1670: persons follow the workspace's Journeys, so new revisions name no
// senders. Historical revisions may still carry the persons they permitted.
export const CampaignRevisionSchema = revision(CampaignPolicyFields.extend({
  sender_ids: uniqueRefs.optional().describe("Historical revisions only: the persons the Campaign permitted before persons followed Journeys."),
}).strict());
export const RevisionSummarySchema = ExactRevisionSchema.extend({ approval: Approval.nullable() }).strict();
// One executable Journey version: the exact sources selected for new Journey
// starts and whether its automatically derived graph is installed.
export const ExecutableVersionSchema = z.object({ executable_version_ref: Ref, digest: Digest, created_at: Timestamp,
  journey: ExactRevisionSchema,
  campaigns: z.array(z.object({ campaign_ref: Ref, channel: z.enum(["email", "linkedin"]), revision: ExactRevisionSchema }).strict()).min(1).max(2)
    .refine(values => new Set(values.map(value => value.campaign_ref)).size === values.length),
  graph: z.object({ status: z.enum(["compiling", "compiled"]) }).strict(),
}).strict();
const CampaignState = z.enum(["inactive", "active", "paused"]);
export const CampaignSummarySchema = z.object({ campaign_ref: Ref, journey_ref: Ref, channel: z.enum(["email", "linkedin"]), version: Version, name: Name,
  state: CampaignState, active_revision: RevisionSummarySchema.nullable(), draft_revision: RevisionSummarySchema }).strict();
export const JourneySchema = z.object({ journey_ref: Ref, version: Version, name: Name,
  active_revision: JourneyRevisionSchema.nullable(), draft_revision: JourneyRevisionSchema, revisions: z.array(JourneyRevisionSchema).max(100),
  campaigns: z.array(CampaignSummarySchema).max(100), executable_version: ExecutableVersionSchema.nullable(),
}).strict();
export const CampaignSchema = z.object({ campaign_ref: Ref, journey_ref: Ref, channel: z.enum(["email", "linkedin"]), version: Version, name: Name,
  state: CampaignState, active_revision: CampaignRevisionSchema.nullable(),
  draft_revision: CampaignRevisionSchema, revisions: z.array(CampaignRevisionSchema).max(100),
}).strict().superRefine((value, context) => {
  if (value.state !== "inactive" && !value.active_revision) context.addIssue({ code: "custom", message: "An activated Campaign has a selected revision." });
});
const Workspace = { workspace: WorkspaceIdentitySchema };
export const JourneyResultSchema = z.object({ ...Workspace, journey: JourneySchema }).strict();
// Banned phrases in the draft's saved templates. Recommendations only: they
// never block a save, preview or approval. Absent when the list is unknown.
// slots_spec_warnings: the API adds it (never the database); absent when the
// revision has none.
export const CampaignResultSchema = z.object({ ...Workspace, campaign: CampaignSchema,
  writing_recommendations: WritingRecommendationsSchema.optional(),
  slots_spec_warnings: SlotsSpecWarningsSchema.optional().describe("Placeholders a template's slots_spec names that its own subject and text do not use, in the published revision for publish and the draft otherwise. Warnings only; absent when there are none."),
}).strict();
export const JourneySummarySchema = z.object({ journey_ref: Ref, version: Version, name: Name, active_revision: RevisionSummarySchema.nullable(),
  draft_revision: RevisionSummarySchema, executable_version: ExecutableVersionSchema.nullable() }).strict();
export const JourneysSchema = z.object({ ...Workspace, journeys: z.array(JourneySummarySchema).max(100), next_cursor: Ref.nullable() }).strict();
export const CampaignsSchema = z.object({ ...Workspace, campaigns: z.array(CampaignSummarySchema).max(100), next_cursor: Ref.nullable() }).strict();
// LIF-1128: the CRM customer-list decision the activation was accepted under.
// Optional so the API can deploy before the database adds it.
const CustomerListReceiptSchema = z.object({
  state: z.enum(["fresh", "stale", "missing", "not_required"]), reason: z.string().max(100).nullable(), checked_at: z.iso.datetime({ offset: true }),
}).strict();
export const CampaignActivationResultSchema = CampaignResultSchema.extend({ journey: JourneySchema, customer_list: CustomerListReceiptSchema.optional() }).strict();
export type JourneyPolicy = z.infer<typeof JourneyPolicySchema>;
export type CampaignPolicy = z.infer<typeof CampaignPolicySchema>;

export const CampaignTestCreateSchema = PublishSchema.extend({ request_ref: Ref,
  sample: z.union([z.object({ lead_refs: z.array(Ref).min(1).max(20).refine(values => new Set(values).size === values.length),
    opener: z.enum(["cold", "linkedin_bridge"]).optional() }).strict(),
    z.object({ baseline_test_ref: Ref, opener: z.enum(["cold", "linkedin_bridge"]).optional() }).strict()]),
}).strict();
export const CampaignTestPathSchema = CampaignPathSchema.extend({ test_ref: Ref }).strict();
const TestSummary = z.object({ test_ref: Ref, request_ref: Ref, campaign_ref: Ref, revision_ref: Ref, digest: Digest,
  baseline_test_ref: Ref.nullable(), status: z.enum(["queued", "running", "completed", "failed"]), created_at: Timestamp,
}).strict();
const Selection = z.object({ lane: z.string().nullable(), opener: z.enum(["cold", "linkedin_bridge"]).nullable(),
  template_ids: z.array(z.string().min(1).max(100)).min(1).max(5).optional(), approach_type: Arm.optional() }).strict();
const TestOutput = z.object({ output_ref: Ref, digest: Digest, created_at: Timestamp,
  content: z.union([z.object({ linkedin_messages: z.array(z.object({ text: text(3000) }).strict()).min(1).max(3) }).strict(),
    z.object({ email_steps: z.array(z.object({ subject: text(300), text: text(20000), delay_minutes: z.number().int().min(0).max(43200) }).strict()).min(1).max(5) }).strict()]),
  selection: Selection,
  context: z.object({ revision_ref: Ref, digest: Digest, profile_version: Version, voice_version: z.number().int().nonnegative(),
    sender_id: Ref, sender_version: Version, prompt_digest: Digest }).strict(),
}).strict();
export const TestChangeSchema = z.enum(["research_changed", "lead_facts_changed", "sender_changed", "business_changed", "composition_context_changed"]);
// A failed sample names its coded cause; the API adds the founder-facing message.
const TestFailure = z.object({ code: z.enum(TEST_FAILURE_CODES), stage: z.enum(TEST_FAILURE_STAGES).optional(),
  position: z.number().int().min(1).max(5).optional().describe("The Campaign step involved, when known."),
  cause: z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{0,63}$/).optional(), http_status: z.number().int().min(100).max(599).optional(),
  message: z.string().min(1).max(400).optional().describe("Founder-facing reason to relay; the API adds it."),
}).strict();
export const CampaignTestSchema = TestSummary.extend({ samples: z.array(z.object({ lead_ref: Ref, lab_run_ref: Ref,
  status: z.enum(["queued", "running", "succeeded", "failed", "canceled"]), lane: z.string().nullable(), opener: z.enum(["cold", "linkedin_bridge"]).nullable(),
  output: TestOutput.nullable(), baseline_output: TestOutput.nullable(), changes: z.array(TestChangeSchema),
  failure: TestFailure.nullable().optional(),
}).strict()).min(1).max(20) }).strict();
export const CampaignTestResultSchema = z.object({ ...Workspace, test: CampaignTestSchema }).strict();
export const CampaignTestsSchema = z.object({ ...Workspace, tests: z.array(TestSummary).max(100), next_cursor: Ref.nullable() }).strict();

export const CampaignMessagePathSchema = z.object({ message_ref: Ref }).strict();
export const CampaignMessageReviseSchema = z.object({ request_ref: Ref, source_digest: Digest,
  expected_review_status: z.enum(["pending", "enroll_failed"]), changes: z.union([
    z.object({ text: text(3000) }).strict(),
    z.object({ steps: z.array(z.object({ position: z.number().int().min(1).max(6), subject: text(300).refine(value => !/[\r\n]/.test(value)).optional(), text: text(20000) }).strict()).min(1).max(6).refine(steps => new Set(steps.map(step => step.position)).size === steps.length) }).strict(),
  ]),
}).strict();
export const CampaignMessageSchema = z.object({ message_ref: Ref, lead_ref: Ref, channel: z.enum(["email", "linkedin"]),
  status: z.string().nullable(), review_status: z.string().nullable(), is_draft: z.boolean().nullable(), content: z.string(),
  // A null subject is a later email that replies in the first email's thread.
  steps: z.array(z.object({ position: z.number().int().positive(), subject: z.string().nullable(), text: z.string() }).strict()).nullable(),
  source_message_ref: Ref.nullable(), sender_id: Ref.nullable(), sender_version: Version.nullable(), source_digest: Digest, created_at: Timestamp,
  account_id: Ref.nullable(), sender_name: z.string().nullable(), lead_name: z.string().nullable(), lead_email: z.string().nullable(),
  lead_linkedin_url: z.string().nullable(), review_reason: z.string().nullable(), action_ref: Ref.nullable(), run_ref: Ref.nullable(),
  campaign_ref: Ref.nullable(), direction: z.enum(["inbound", "outbound"]),
  delivery_state: z.enum(["confirmed", "scheduled", "planned", "unknown"]), sent_at: Timestamp.nullable(),
  not_sent_cause: z.enum(["account_disconnected", "sender_unavailable", "provider_rejected", "unknown"]).nullable().optional(),
  action_blocked_reason: z.literal("historical_engine_retired").nullable().optional(),
  // LIF-1582: optional so this API deploys before the database adds the key.
  // Any saved value is relayed; the database owns the value set.
  copy_source: z.string().min(1).max(100).nullable().optional()
    .describe("Where the saved copy came from. `manual`: the person typed it directly in LinkedIn; Lifty recorded it but did not write or send it."),
}).strict().refine(message => message.direction !== "outbound" || message.delivery_state !== "confirmed" || message.sent_at !== null,
  "Confirmed outbound delivery requires its saved receipt time.");
type ConversationOwner = Pick<z.infer<typeof CampaignMessageSchema>, "lead_ref" | "channel" | "account_id" | "sender_id">;
/** History is one person's conversation with the lead on this channel, from any of their accounts (LIF-1361). */
export function inConversation(message: z.infer<typeof CampaignMessageSchema>, owner: ConversationOwner): boolean {
  return message.lead_ref === owner.lead_ref && message.channel === owner.channel && message.account_id !== null
    && (message.account_id === owner.account_id || (message.sender_id !== null && message.sender_id === owner.sender_id));
}
export const CampaignMessageResultSchema = z.object({ ...Workspace, message: CampaignMessageSchema,
  history: z.array(CampaignMessageSchema).max(100), history_complete: z.boolean(),
  revisions: z.array(CampaignMessageSchema).max(100), revisions_complete: z.boolean(),
  rewrite_work: z.object({ work_ref: Ref, message_ref: Ref, source_digest: Digest,
    state: z.enum(["queued", "running", "done", "failed", "uncertain"]), replacement_message_ref: Ref.nullable(),
    error_code: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/).nullable(),
  }).strict().refine(work => work.state !== "done" || work.replacement_message_ref !== null,
    "A completed rewrite requires its exact replacement.").nullable().optional(),
}).strict();
export const CampaignReviewsQuerySchema = z.object({ channel: z.enum(["linkedin", "email"]).optional(),
  review_status: z.enum(["pending", "enroll_failed", "approved", "suppressed"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(), after: Ref.optional(),
}).strict();
export const CampaignReviewsSchema = z.object({ ...Workspace, messages: z.array(CampaignMessageSchema).max(100), next_after: Ref.nullable() }).strict();
export const ReviewPageQuerySchema = CampaignReviewsQuerySchema.omit({ review_status: true });
const ChannelReviewPolicy = z.object({ mode: z.enum(["approve_each", "send_and_sample"]),
  sample_rate: z.union([z.literal(0), z.literal(10), z.literal(20), z.literal(50)]),
}).strict();
export const ReviewSettingsSchema = z.object({ version: Version, linkedin: ChannelReviewPolicy, email: ChannelReviewPolicy }).strict();
export const ReviewSettingsResultSchema = z.object({ ...Workspace, settings: ReviewSettingsSchema }).strict();
export const ReviewSettingsUpdateSchema = z.object({ expected_version: Version,
  linkedin: ChannelReviewPolicy.optional(), email: ChannelReviewPolicy.optional(),
}).strict().refine(value => value.linkedin !== undefined || value.email !== undefined, "Choose at least one channel.");
export const MessageRatingSchema = z.object({ source_digest: Digest, rating: z.enum(["up", "down"]),
  note: text(200).optional(), learning_scope: z.enum(["message", "template", "voice"]).optional(),
}).strict();
export const MessageRatingResultSchema = z.object({ ...Workspace, feedback: z.object({ message_ref: Ref,
  source_digest: Digest, rating: z.enum(["up", "down"]), note: z.string().nullable(),
  learning_scope: z.enum(["message", "template", "voice"]), rated_at: Timestamp,
}).strict() }).strict();
export const ReviewCountSchema = z.object({ ...Workspace, count: z.number().int().nonnegative() }).strict();
export const ReplyTurnPathSchema = z.object({ turn_ref: Ref }).strict();
export const ReplyViewSchema = z.object({
  turnId: Ref, channel: z.enum(["email", "linkedin"]), version: z.number().int().nonnegative(),
  status: z.enum(["received", "awaiting_action", "queued", "processing", "sent", "suppressed", "superseded", "uncertain", "recovery"]),
  label: z.string().refine(value => value.trim().length > 0), cause: z.string().nullable(), detail: z.string().nullable(),
  actions: z.array(z.enum(["approve", "edit", "suppress", "recover", "retry"])),
  draft: z.string().nullable(), approvedText: z.string().nullable(),
  decidedAt: Timestamp.nullable(), sentAt: Timestamp.nullable(), nextAttemptAt: Timestamp.nullable(), overdueAt: Timestamp.nullable(),
}).strict();
export const ReplyTurnSchema = z.object({ turn_ref: Ref, version: z.number().int().nonnegative(), lead_ref: Ref,
  channel: z.enum(["email", "linkedin"]), state: z.enum(["pending", "processing", "sending", "queued", "sent", "suppressed", "uncertain", "failed", "superseded"]),
  source_digest: Digest, draft: z.string(), account_id: Ref.nullable(), sender_id: Ref.nullable(),
  sender_name: z.string().nullable(), lead_name: z.string().nullable(), lead_email: z.string().nullable(),
  lead_linkedin_url: z.string().nullable(), campaign_ref: Ref.nullable(), inbound_text: z.string(), inbound_at: Timestamp,
  follow_up_due_at: Timestamp.nullable(), created_at: Timestamp, sent_at: Timestamp.nullable(),
  history: z.array(CampaignMessageSchema).max(100), history_complete: z.boolean(), view: ReplyViewSchema,
}).strict().refine(turn => turn.view.turnId === turn.turn_ref && turn.view.channel === turn.channel && turn.view.version === turn.version,
  "The reply view must describe this turn.")
  .refine(turn => turn.state !== "sent" || turn.sent_at !== null, "A sent reply requires a confirmed receipt.");
export const ReplyTurnsSchema = z.object({ ...Workspace, turns: z.array(ReplyTurnSchema).max(100), next_after: Ref.nullable() }).strict();
export const ReplyTurnResultSchema = z.object({ ...Workspace, turn: ReplyTurnSchema }).strict();
export const ReplyDecisionResultSchema = z.object({ ...Workspace, turn: ReplyTurnSchema,
  outcome: z.enum(["accepted", "replayed", "stale"]), dispatch: Ref.nullable(), view: ReplyViewSchema,
}).strict().refine(receipt => receipt.outcome !== "stale" || receipt.dispatch === null,
  "A stale decision never dispatches.");
export const ReplyTurnReviewSchema = z.object({ decision_id: Ref, expected_version: z.number().int().nonnegative(),
  action: z.enum(["send", "skip", "recover", "retry"]), text: z.string().trim().pipe(text(20000)).optional(),
}).strict().refine(value => value.action === "send" || value.text === undefined, "Only send accepts edited text.");
export const CampaignMessageRewriteSchema = z.object({ request_ref: Ref, source_digest: Digest,
  expected_review_status: z.literal("pending"),
}).strict();
export const LeadOutreachPathSchema = z.object({ lead_ref: Ref }).strict();
export const StopLeadOutreachSchema = z.object({ request_ref: Ref, confirm: z.literal(true) }).strict();
export const StopLeadOutreachResultSchema = z.object({ ...Workspace, lead_ref: Ref, stopped_at: Timestamp,
  provider_stops_pending: z.boolean(),
}).strict();
export const CampaignMessageReviewSchema = z.object({ action: z.enum(["approve", "skip", "retry"]), source_digest: Digest,
  expected_review_status: z.enum(["pending", "enroll_failed"]), reason: text(2000).optional(),
  feedback: z.object({ rating: z.enum(["up", "down"]), note: text(2000) }).strict().optional(),
}).strict().refine(value => value.action !== "retry" || value.expected_review_status === "enroll_failed", "Retry requires a saved review failure.")
  .refine(value => value.action !== "skip" || value.reason !== undefined, "Explain why this message is being skipped.")
  .refine(value => value.action !== "skip" || value.feedback === undefined, "Decision feedback is only available for approve or retry.");
export const CampaignRuntimeSchema = z.object({ ...Workspace, campaign_ref: Ref, intent_active: z.boolean(),
  executable_versions: z.array(z.object({ executable_version_ref: Ref, revision_ref: Ref, started_journeys: z.number().int().nonnegative(),
    continuing_journeys: z.number().int().nonnegative(), prepared_journeys: z.number().int().nonnegative(), pending_journeys: z.number().int().nonnegative(),
    recorded_gate_reasons: z.array(z.object({ reason: z.enum(["delay_pending", "schedule_pending", "delivery_slot_pending", "intent_paused", "recorded_gate_pending", "composition_held"]), count: z.number().int().positive() }).strict()),
  }).strict()),
}).strict();
