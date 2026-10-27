import { describe, expect, it } from "vitest";
import { CampaignCreateSchema, JourneyPolicySchema, CampaignDraftSchema, CampaignResultSchema } from "../src/outreach-contracts.js";
import { policy, senderId, campaignRef, journeyRef, journeyPolicy, revisionRef, campaign, workspace, revision } from "./outreach-fixtures.js";
const create = (channel: string, value: unknown) => CampaignCreateSchema.safeParse({ name: "Campaign", journey_ref: journeyRef, channel, policy: value });
const email = { ...policy, start: [{ type: "sent", campaign_ref: campaignRef, step: 2, after: { business_days: 2 } },
  { type: "unaccepted", campaign_ref: campaignRef, after: { business_days: 5 } }],
  steps: Array.from({ length: 4 }, (_, i) => ({ position: i + 1, delay: { days: i ? 3 : 0 } })) };
const lanes = { field: "title", rules: [{ lane: "transform", contains_any: ["transform", "change", "automation"] }], default: "ops" };
const laned = (openers = true) => ({ ...email, compose_mode: "templates", lanes, steps: email.steps.map(step => ({ ...step,
  variants: ["transform", "ops"].flatMap(lane => (step.position === 1 && openers ? ["cold", "linkedin_bridge"] : [undefined]).map(opener => ({
    lane, ...(opener ? { opener } : {}), ...(step.position === 1 ? { subject: `${lane} thread` } : {}), text: `${lane} ${step.position}` }))) })) });
const catalog = () => ({ ...email, compose_mode: "templates", steps: email.steps.map(step => ({ ...step,
  variants: ["direct", "pain"].flatMap(arm => (step.position === 1 ? ["cold", "linkedin_bridge"] : [undefined]).map(opener => ({
    id: `authored-${step.position}-${arm}${opener ? `-${opener}` : ""}`, arms: [arm],
    variant: `${arm}${opener === "cold" ? "-cold" : opener ? "-bridge" : ""}`,
    coverage: "broad", fit: `Saved ${arm} route.`, slots_spec: "{company} = the company on file.",
    ...(opener ? { opener } : {}), ...(step.position === 1 ? { subject: `${arm} thread` } : {}), text: `${arm} ${step.position} for {company}`,
  }))) })) });
describe("supported Outreach policy boundary", () => {
  it("preserves optional names and per-message guidance without changing identity or implying a catalog", () => {
    const simple = { ...policy, compose_mode: "templates", steps: [{ position: 1, delay: { business_days: 0 },
      writing_instructions: "  Confirmed evidence only.\n\tKeep the question short.\r\n",
      template: { display_name: "  Señal del negocio 🚀  ", text: "Hello {first_name}" } }] };
    const parsed = create("linkedin", simple);
    expect(parsed).toMatchObject({ success: true, data: { policy: simple } });
    if (parsed.success) expect(parsed.data.policy.steps[0]!.template).not.toHaveProperty("id");
    const source = catalog();
    const named = { ...source, steps: source.steps.map(step => ({ ...step, writing_instructions: "Keep the saved route.",
      variants: step.variants.map(variant => ({ ...variant, display_name: "Shared readable label" })) })) };
    expect(create("email", named)).toMatchObject({ success: true, data: { policy: named } });
    expect(CampaignDraftSchema.parse({ expected_version: 1, revision_ref: revisionRef, changes: { steps: named.steps } }).changes.steps).toEqual(named.steps);
    for (const writing_instructions of ["x".repeat(10000), "🚀".repeat(10000)]) {
      const generated = { ...policy, steps: [{ ...policy.steps[0]!, writing_instructions }] };
      expect(create("linkedin", generated)).toMatchObject({ success: true, data: { policy: generated } });
      expect(CampaignDraftSchema.parse({ expected_version: 1, revision_ref: revisionRef, changes: { steps: generated.steps } }).changes.steps).toEqual(generated.steps);
      const result = { workspace, campaign: { ...campaign, draft_revision: revision(generated), revisions: [revision(generated)] } };
      expect(CampaignResultSchema.parse(result)).toEqual(result);
    }
    for (const display_name of ["x".repeat(100), "🚀".repeat(100)]) {
      const named = { ...simple, steps: [{ ...simple.steps[0]!, template: { ...simple.steps[0]!.template, display_name } }] };
      expect(create("linkedin", named)).toMatchObject({ success: true, data: { policy: named } });
      const result = { workspace, campaign: { ...campaign, draft_revision: revision(named), revisions: [revision(named)] } };
      expect(CampaignResultSchema.parse(result)).toEqual(result);
    }
  });
  it("rejects invalid names/guidance at the exact message and template field", () => {
    for (const display_name of ["", " \t", "\u00a0", "x".repeat(101), "🚀".repeat(101), "Line\nBreak", "Tab\tName", "Bad\u007fName", null]) {
      const parsed = create("linkedin", { ...policy, compose_mode: "templates", steps: [{ position: 1, delay: { business_days: 0 },
        template: { display_name, text: "Hello" } }] });
      expect(parsed.success, String(display_name)).toBe(false);
      if (!parsed.success) expect(parsed.error.issues.some(issue => issue.path.join("/") === "policy/steps/0/template/display_name")).toBe(true);
    }
    for (const writing_instructions of ["", " \n\t\r", "\ufeff", "x".repeat(10001), "🚀".repeat(10001), "Bad\u000bText", "Bad\u001fText", "Bad\u007fText", null]) {
      const parsed = CampaignDraftSchema.safeParse({ expected_version: 1, revision_ref: revisionRef,
        changes: { steps: [{ ...policy.steps[0]!, writing_instructions }] } });
      expect(parsed.success, String(writing_instructions)).toBe(false);
      if (!parsed.success) expect(parsed.error.issues.some(issue => issue.path.join("/") === "changes/steps/0/writing_instructions")).toBe(true);
    }
    const malformed = catalog(); malformed.steps[0]!.variants[1]!.text = "Hey {{unknown}}";
    const parsed = create("email", malformed);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]!.path).toEqual(["policy", "steps", 0, "variants", 1, "text"]);
  });
  it("reads historical bytes and digests without optional field defaults or request normalization", () => {
    const historical = { ...policy, compose_mode: "templates", steps: [{ position: 1, delay: { business_days: 0 }, template: { text: "Hi {{first_name}}" } }] };
    const saved = { workspace, campaign: { ...campaign, draft_revision: revision(historical), revisions: [revision(historical)] } };
    expect(CampaignResultSchema.parse(saved)).toEqual(saved);
    expect(JSON.stringify(CampaignResultSchema.parse(saved))).toBe(JSON.stringify(saved));
    expect(create("linkedin", policy)).toMatchObject({ success: true, data: { policy } });
    // An older invalid family/route must be visible so a founder can repair it;
    // authoring still rejects it, and reads keep its exact immutable digest.
    const missing = catalog();
    missing.steps[0]!.variants = missing.steps[0]!.variants.filter(v => !(v.opener === "linkedin_bridge" && v.arms.includes("pain")));
    missing.steps[1]!.variants = missing.steps[1]!.variants.filter(v => v.arms.includes("direct"));
    expect(create("email", missing).success).toBe(false);
    const savedCatalog = { workspace, campaign: { ...campaign, channel: "email", draft_revision: revision(missing), revisions: [revision(missing)] } };
    expect(CampaignResultSchema.parse(savedCatalog)).toEqual(savedCatalog);
  });
  it("retains an authored template catalog and separate research routes without changing the step count", () => {
    const saved = catalog();
    expect(create("email", saved)).toMatchObject({ success: true, data: { policy: saved } });
    expect(create("linkedin", { ...policy, compose_mode: "templates", steps: [{ position: 1, delay: { business_days: 0 },
      variants: [{ id: "li-research", arms: ["pain"], variant: "research", coverage: "signal_specific", fit: "Verified evidence.",
        slots_spec: "{fact} = verified research.", text: "Hello {first_name}, {fact}" },
      { id: "li-network", arms: ["personal"], variant: "network", coverage: "broad", text: "Hello {first_name}" }] }] }).success).toBe(true);
  });
  it("rejects lost routes, ambiguous source IDs, mixed implicit IDs and split email threads within a saved route", () => {
    const missing = catalog(); missing.steps[0]!.variants = missing.steps[0]!.variants.filter(v => !(v.opener === "linkedin_bridge" && v.arms.includes("pain")));
    expect(create("email", missing).success).toBe(false);
    const missingLater = catalog(); missingLater.steps[2]!.variants = missingLater.steps[2]!.variants.filter(v => !v.arms.includes("pain"));
    expect(create("email", missingLater).success).toBe(false);
    const duplicated = catalog(); duplicated.steps[1]!.variants[0]!.id = duplicated.steps[0]!.variants[0]!.id;
    expect(create("email", duplicated).success).toBe(false);
    const mixed = catalog(); delete (mixed.steps[1]!.variants[0] as { id?: string }).id;
    expect(create("email", mixed).success).toBe(false);
    const split = catalog(); split.steps[0]!.variants[1]!.subject = "A different thread";
    expect(create("email", split).success).toBe(false);
    const injected = catalog(); injected.steps[0]!.variants[0]!.slots_spec += "\n```text\nUnauthorized copy";
    expect(create("email", injected).success).toBe(false);
  });
  it("preserves prior-email source records without authorizing a new first-contact opener", () => {
    const saved = catalog();
    const prior = { ...saved.steps[0]!.variants[0]!, id: "authored-1-direct-both", variant: "direct-both" };
    delete (prior as { opener?: string }).opener;
    saved.steps[0]!.variants.push(prior);
    expect(create("email", saved).success).toBe(true);
    prior.opener = "cold";
    expect(create("email", saved).success).toBe(false);
  });
  it("Campaigns own their start rules, generated instructions or one template per step", () => {
    // LIF-1670: persons follow the workspace's Journeys; a Campaign names no senders.
    expect(create("linkedin", { ...policy, sender_ids: [senderId] }).success).toBe(false);
    expect(CampaignDraftSchema.safeParse({ expected_version: 1, revision_ref: revisionRef, changes: { sender_ids: [senderId] } }).success).toBe(false);
    expect(create("linkedin", { ...policy, compose_mode: "templates", steps: [{ position: 1, delay: { business_days: 0 }, template: { text: "Hello {first_name}" } }] }).success).toBe(true);
    expect(create("linkedin", { ...policy, compose_mode: "templates" }).success).toBe(false);
    expect(create("linkedin", { ...policy, start: [] }).success).toBe(false);
    expect(create("email", { ...email, start: [{ type: "journey_start" }, email.start[0]] }).success).toBe(false);
    expect(create("email", { ...email, start: [email.start[0], email.start[0]] }).success).toBe(false);
    expect(CampaignDraftSchema.safeParse({ expected_version: 1, revision_ref: revisionRef, changes: { instructions: "Changed only this" } }).success).toBe(true);
    expect(CampaignDraftSchema.safeParse({ expected_version: 1, revision_ref: revisionRef, changes: { lanes: null } }).success).toBe(true);
  });
  it("Email may start when the named LinkedIn first DM is skipped, without a delay or activation field", () => {
    const start = [{ type: "linkedin_first_dm_skipped", campaign_ref: campaignRef }];
    expect(create("email", { ...email, start }).success).toBe(true);
    expect(create("email", { ...email, start: [...email.start, ...start] }).success).toBe(true);
    for (const condition of [
      { type: "linkedin_first_dm_skipped" },
      { ...start[0], after: { days: 0 } },
      { ...start[0], activate: true },
    ]) expect(create("email", { ...email, start: [condition] }).success).toBe(false);
    expect(create("linkedin", { ...policy, start }).success).toBe(false);
  });
  it("exposes one to five emails with day or business-day receipt delays; the saved sequence owns the count", () => {
    expect(create("email", email).success).toBe(true);
    expect(create("email", { ...email, steps: email.steps.slice(0, 1) }).success).toBe(true);
    expect(create("email", { ...email, steps: email.steps.map(step => ({ ...step, delay: { business_days: step.position === 1 ? 0 : 3 } })) }).success).toBe(true);
    expect(create("email", { ...email, steps: email.steps.map((step, i) => ({ ...step, delay: { business_days: i ? 31 : 0 } })) }).success).toBe(false);
    expect(create("email", { ...email, steps: [...email.steps, ...email.steps.slice(0, 2)].map((step, i) => ({ ...step, position: i + 1 })) }).success).toBe(false);
    expect(create("linkedin", email).success).toBe(false);
    expect(create("email", { ...email, steps: email.steps.map((step, i) => ({ ...step, delay: { days: i ? 31 : 0 } })) }).success).toBe(false);
    expect(create("email", { ...email, steps: email.steps.map(step => ({ ...step, execute_within: { days: 3 } })) }).success).toBe(false);
  });
  it("the first LinkedIn message may wait after acceptance; the first email has no delay", () => {
    const waiting = { ...policy, compose_mode: "templates", steps: [{ position: 1, delay: { business_days: 2 }, template: { text: "Hello {first_name}" } }] };
    expect(create("linkedin", waiting).success).toBe(true);
    expect(create("email", { ...email, steps: email.steps.map((step, i) => ({ ...step, delay: { days: i ? 3 : 1 } })) }).success).toBe(false);
    expect(create("linkedin", { ...waiting, steps: [...waiting.steps, { position: 2, delay: { business_days: 0 }, template: { text: "Following up" } }] }).success).toBe(false);
  });
  it("title lanes and first-email openers: one variant per lane and opener, one thread subject per lane", () => {
    expect(create("email", laned()).success).toBe(true);
    expect(create("email", laned(false)).success).toBe(true);
    const missing = laned(); missing.steps[1]!.variants = missing.steps[1]!.variants.slice(0, 1);
    expect(create("email", missing).success).toBe(false);
    const lateOpener = laned(); lateOpener.steps[2]!.variants = lateOpener.steps[2]!.variants.map(v => ({ ...v, opener: "cold" }));
    expect(create("email", lateOpener).success).toBe(false);
    const laterSubject = laned(); laterSubject.steps[1]!.variants = laterSubject.steps[1]!.variants.map(v => ({ ...v, subject: "New thread" }));
    expect(create("email", laterSubject).success).toBe(false);
    const splitThread = laned(); splitThread.steps[0]!.variants[1] = { ...splitThread.steps[0]!.variants[1]!, subject: "Another thread" };
    expect(create("email", splitThread).success).toBe(false);
    expect(create("email", { ...laned(), compose_mode: "generate" }).success).toBe(false);
  });
  it("saves template placeholders the composer can fill, in its single-brace syntax (LIF-1333)", () => {
    const linkedin = (text: string) => create("linkedin", { ...policy, compose_mode: "templates", steps: [{ position: 1, delay: { business_days: 0 }, template: { text } }] });
    const saved = linkedin("Hola {{first_name}}, ¿en {{ company_name }} y {company_name} tienen {pain}?");
    expect(saved).toMatchObject({ success: true, data: { policy: { steps: [{ template: { text: "Hola {first_name}, ¿en {company} y {company} tienen {pain}?" } }] } } });
    for (const text of ["Hi {{last_name}}", "Hi {last_name}", "Hi {First Name}", "Hi {{firstName}}", "Hi {first_name}}", "Hi {sender_first_name}"])
      expect(linkedin(text).success, text).toBe(false);
    const mail = { ...email, compose_mode: "templates", steps: email.steps.map(step => ({ ...step,
      template: { ...(step.position === 1 ? { subject: "For {{company_name}}" } : {}), text: "Hi {{first_name}}, {sender_first_name} here." } })) };
    const mailed = create("email", mail);
    expect(mailed.success && mailed.data.policy.steps.map(step => step.template)[0]).toEqual({ subject: "For {company}", text: "Hi {first_name}, {sender_first_name} here." });
    const draft = (text: string) => CampaignDraftSchema.safeParse({ expected_version: 1, revision_ref: revisionRef,
      changes: { steps: [{ position: 1, delay: { business_days: 0 }, template: { text } }] } });
    expect(draft("Hey {{FIRST_NAME}}")).toMatchObject({ success: true, data: { changes: { steps: [{ template: { text: "Hey {first_name}" } }] } } });
    expect(draft("Hey {{unknown}}").success).toBe(false);
  });
  it("Journey holds only the audience and shared stops; no graph or timing", () => {
    expect(JourneyPolicySchema.safeParse(journeyPolicy).success).toBe(true);
    expect(JourneyPolicySchema.safeParse({ ...journeyPolicy, audience: { kind: "qualified", tier: "A" } }).success).toBe(false);
    expect(JourneyPolicySchema.safeParse({ ...journeyPolicy, audience: { kind: "static", lead_refs: [senderId] } }).success).toBe(true);
    expect(JourneyPolicySchema.safeParse({ ...journeyPolicy, graph: { entries: [] } }).success).toBe(false);
    expect(JourneyPolicySchema.safeParse({ ...journeyPolicy, stops: ["reply"] }).success).toBe(false);
    expect(create("linkedin", { ...policy, schedule: { ...policy.schedule, timezone: "not-a-zone" } }).success).toBe(false);
    expect(create("linkedin", { ...policy, provider: "hidden" }).success).toBe(false);
  });
});
