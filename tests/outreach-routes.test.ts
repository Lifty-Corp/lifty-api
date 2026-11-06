import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { STAGE_CLIENT_CONTRACT, getAgentContext } from "../src/agent-context.js";
import { executeOutreachOperation, outreachEntries } from "../src/outreach-operations.js";
import { memberReviewOperationDefinitions } from "../src/member-review-operations.js";
import { getStageMcpTools, callStageMcpTool } from "../src/mcp-stage-tools.js";

import { receipt as sql } from "./senders-fixtures.js";
import { journeyRef, campaignRef, revisionRef, senderId, workspace, digest, policy, journeyPolicy, revision, executableVersion, journey, campaign, journeySummary, campaignSummary } from "./outreach-fixtures.js";
import slack from "./outreach-slack-approval-sql-fixtures.json" with { type: "json" };
function harness(result: (name: string, args: Record<string, unknown>) => unknown) {
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    try { return { data: result(name, args), error: null }; } catch (error) { return { data: null, error }; }
  });
  const app = createApp({ authenticate: async () => ({ ok: true, session: { userId: "founder", client: { rpc } } }), log: () => {} });
  const request = (method: string, path: string, body?: unknown) => app.request(path, { method,
    headers: { authorization: "Bearer test", "x-lifty-client-contract": STAGE_CLIENT_CONTRACT, "x-lifty-workspace": "example", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { app, request, rpc };
}

// LIF-1771 AC-V3: activation names who cannot send yet, and still proceeds.
describe("blocked people on activation", () => {
  const roster = (senders: unknown[]) => ({ workspace, senders });
  const mailbox = (sender: string, identity: string, participation: unknown, extra: Record<string, unknown> = {}) => ({ id: crypto.randomUUID(), sender_id: sender, channel: "email", identity, status: "connected", state: "active",
    sending: { allowed: false, reason: "mailbox_not_ready", scope: null }, limits: { emails_per_day: 10 }, checked_at: null, observation: { state: "verified" }, connected_at: null, disconnected_at: null,
    access_revoked_at: null, access_removal: null, declaration: null, sends: null, participation, ...extra });
  const person = (id: string, name: string, accounts: unknown[], extra: Record<string, unknown> = {}) => ({ id, version: 1, name, signature: null, booking_url: null, accounts, ...extra });
  const lee = "11111111-1111-4111-8111-111111111111"; const mia = "22222222-2222-4222-8222-222222222223";
  const warming = { status: "email_not_ready", cause: "warming" };
  const inbox = (address: string, ready_on: string | null) => ({ mailbox: address, status: "warming", cap: 10, planned: 0, ready_on, safety_check_stale: false });
  const capacity = (inboxes: unknown[]) => ({ workspace_ref: workspace.workspace_ref, assessed_at: "2026-11-05T12:00:00Z", window_days: 14, business_days: 10,
    email: { operating: true, short: false, on_deck_total: 0, inboxes_to_connect: 0, inboxes_short: 0, plan: { leads_per_week: 0, valid_email_share: 1, emails_per_lead: 0, emails_per_week: 0, people: 1 }, people: [{ sender_ref: lee, sender_name: "Lee", inboxes, sendable_inboxes: 0, warming_inboxes: 1, capacity_per_day: 0, capacity_at_caps_per_day: 0, capacity_at_full_pace_per_day: 0,
      target_rate: 0, committed_rate: 0, rate: 0, backlog: { overdue_steps: 0, waiting_journeys: 0, steps: 0 }, days_to_clear: null, clears: false, inboxes_needed: 0, on_deck: 0, inboxes_to_connect: 0, inboxes_short: 0 }] },
    linkedin: { operating: false, short: false, sendable_accounts: 0, invitations_per_week: 0, planned_messages_per_day: 0, invitations_needed_per_week: 0, messages_needed_per_day: 0, senders_needed: 0, senders_to_add: 0,
      backlog: { invitations: 0 }, days_to_clear: null, clears: false, limits: { reply_share: 0.2, new_sender: { invitations_per_7_days: 0, messages_per_day: 0, planned_messages_per_day: 0 } } } });
  const activated = (channel = "email") => ({ workspace, campaign: { ...campaign, channel, state: "active", active_revision: revision(policy, true) }, journey: { ...journey, executable_version: executableVersion } });
  const activate = (reads: Record<string, unknown>, channel?: string) => {
    const h = harness(name => {
      if (name === "activate_lifty_campaign") return activated(channel);
      if (!(name in reads)) throw new Error("unavailable");
      return reads[name];
    });
    return { h, result: h.request("POST", `/v1/workspace/campaigns/${campaignRef}/activate`, { expected_version: 1, revision_ref: revisionRef, digest }) };
  };

  it("names the person, the cause and when it clears, and the campaign activates", async () => {
    const { result } = activate({ get_lifty_senders: roster([person(lee, "Lee", [mailbox(lee, "lee@meetbramble.test", warming)]),
      person(mia, "Mia", [mailbox(mia, "mia@meetbramble.test", { status: "waiting_for_first_lead", cause: "no_lead_yet" })])]),
      get_lifty_outreach_capacity_readout: capacity([inbox("LEE@meetbramble.test", "2026-11-14")]) });
    const response = await result;
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.campaign.state).toBe("active");
    expect(body.blocked_people).toEqual([{ sender_id: lee, name: "Lee", cause: "warming", label: "Lee · Warming up until Nov 14", clears_on: "2026-11-14", owner: "lifty", action: "wait",
      since: null, review_by: null, waiting_journeys: null }]);
  });

  it("reads one cause per person: any mailbox that can send clears them, and the soonest date speaks", async () => {
    const { result } = activate({ get_lifty_senders: roster([
      person(lee, "Lee", [mailbox(lee, "late@a.test", warming), mailbox(lee, "soon@a.test", warming)]),
      person(mia, "Mia", [mailbox(mia, "one@a.test", warming), mailbox(mia, "two@a.test", { status: "sending", cause: "active_journeys" })]),
      person("33333333-3333-4333-8333-333333333334", "Off", [mailbox("33333333-3333-4333-8333-333333333334", "off@a.test", { status: "paused", cause: "sender_off" })],
        { sending: { state: "off", off_at: "2026-11-05T12:00:00Z", reason: "Left", drain_to_sender_id: mia, drain_mode: "continue", leads_remaining: 0 } }),
      person("44444444-4444-4444-8444-444444444445", "No mailbox", []),
      person("55555555-5555-4555-8555-555555555556", "Stopped", [mailbox("55555555-5555-4555-8555-555555555556", "stop@a.test", { status: "paused", cause: "paused_by_lift" })]),
    ]), get_lifty_outreach_capacity_readout: capacity([inbox("late@a.test", "2026-11-20"), inbox("soon@a.test", "2026-11-14")]) });
    const body = await (await result).json();
    expect(body.blocked_people.map((item: { label: string }) => item.label)).toEqual(["Lee · Warming up until Nov 14", "Stopped · Paused by Lifty"]);
    expect(body.blocked_people[1]).toMatchObject({ owner: "lifty", action: "lifty_review", clears_on: null });
  });

  describe("the same facts as Senders", () => {
    afterEach(() => { vi.useRealTimers(); });
    const stop = { ...sql("participation.stop"), waiting_journeys: 3 };
    const entry = async (participation: unknown) => (await (await activate({ get_lifty_senders: roster([person(lee, "Lee", [mailbox(lee, "lee@a.test", participation)])]) }).result).json()).blocked_people[0];

    it("carries since, the review date and the waiting count of the chosen account", async () => {
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-05T18:00:00Z") });
      expect(await entry(stop)).toMatchObject({ cause: "paused_by_lift", label: "Lee · Paused by Lifty · deliverability review · we review it by Nov 13", clears_on: null,
        since: stop.since, review_by: stop.stop.review_by, waiting_journeys: 3 });
    });

    it("keeps the review date null past its day, as elsewhere", async () => {
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-12-01T00:00:00Z") });
      expect(await entry(stop)).toMatchObject({ label: "Lee · Paused by Lifty · deliverability review · under review", review_by: null, waiting_journeys: 3 });
    });
  });

  it("leaves a warming date unknown when the capacity read fails, and says nothing about who when the roster fails", async () => {
    const dateless = await (await activate({ get_lifty_senders: roster([person(lee, "Lee", [mailbox(lee, "lee@a.test", warming)])]) }).result).json();
    expect(dateless.blocked_people[0]).toMatchObject({ label: "Lee · Warming up", clears_on: null });
    const { result, h } = activate({});
    const response = await result;
    expect(response.status).toBe(200);
    expect((await response.json()).blocked_people).toBeNull();
    expect(h.rpc.mock.calls[0]![0]).toBe("activate_lifty_campaign");
  });

  it("reads nothing more for a LinkedIn campaign", async () => {
    const { result, h } = activate({}, "linkedin");
    expect((await (await result).json()).blocked_people).toEqual([]);
    expect(h.rpc).toHaveBeenCalledOnce();
  });
});

describe("canonical Outreach member transport", () => {
  it("routes every catalog operation to its exact RPC without a second workspace selector", async () => {
    const h = harness(name => name === "get_lifty_journeys" ? { workspace, journeys: [journeySummary], next_cursor: null }
      : name === "get_lifty_campaigns" ? { workspace, campaigns: [campaignSummary], next_cursor: null }
        : name === "activate_lifty_journey" ? { workspace, journey: { ...journey, active_revision: revision(journeyPolicy, true), executable_version: executableVersion } }
          : name.includes("journey") ? { workspace, journey: name === "publish_lifty_journey" ? { ...journey, draft_revision: revision(journeyPolicy, true), revisions: [revision(journeyPolicy, true)] } : journey }
            : name === "activate_lifty_campaign" ? { workspace, campaign: { ...campaign, state: "active", active_revision: revision(policy, true) }, journey: { ...journey, executable_version: executableVersion } }
              : { workspace, campaign: name === "publish_lifty_campaign" ? { ...campaign, draft_revision: revision(policy, true), revisions: [revision(policy, true)] } : campaign });
    for (const { action, resource, definition } of outreachEntries().filter(entry => !(entry.action in memberReviewOperationDefinitions) && entry.action !== "runtime" && entry.action !== "reviews_get" && !entry.action.startsWith("tests_") && !entry.action.startsWith("message_") && entry.action !== "test_detail")) {
      const ref = resource === "journeys" ? journeyRef : campaignRef;
      const body = action === "post" ? resource === "journeys" ? { name: "Journey", policy: journeyPolicy } : { name: "LinkedIn", journey_ref: journeyRef, channel: "linkedin", policy }
        : action === "draft_patch" ? { expected_version: 1, revision_ref: revisionRef, changes: resource === "journeys" ? { audience: { kind: "qualified" } } : { instructions: "New instructions" } }
          : action === "pause" ? { expected_version: 1 }
            : action === "publish" || action === "activate" ? { expected_version: 1, revision_ref: revisionRef, digest } : undefined;
      const response = await h.request(definition.method, definition.route.replace(/\{[^}]+\}/g, ref), body);
      expect(response.status, `${resource}.${action}`).toBe(definition.success);
      expect(h.rpc).toHaveBeenLastCalledWith(definition.rpc, { p_workspace_id: null,
        ...definition.args({ path: action === "get" || action === "post" ? {} : { [`${resource === "journeys" ? "journey" : "campaign"}_ref`]: ref }, query: {}, body }) });
    }
  });
  it("rejects stale CAS through shared errors and never falls back after foreign selection", async () => {
    const h = harness(() => { throw { code: "PT409", message: "VERSION_CONFLICT", details: JSON.stringify({ current_version: 2 }) }; });
    const response = await h.request("POST", `/v1/workspace/campaigns/${campaignRef}/publish`, { expected_version: 1, revision_ref: revisionRef, digest });
    expect(response.status).toBe(409); expect((await response.json()).error).toMatchObject({ code: "VERSION_CONFLICT", current_version: 2 });
    const foreign = harness(() => { throw { code: "PT403", message: "WORKSPACE_FORBIDDEN" }; });
    expect((await foreign.request("GET", "/v1/workspace/campaigns")).status).toBe(403);
    expect(foreign.rpc).toHaveBeenCalledOnce();
  });
  it.each([null, { workspace, campaigns: [], next_cursor: null, active: false }, { workspace, campaign: { ...campaign, campaign_ref: senderId } }])(
    "unverifiable reads stay unavailable instead of becoming empty/inactive", async value => {
      const h = harness(() => value);
      const response = await h.request("GET", `/v1/workspace/campaigns/${campaignRef}`);
      expect(response.status).toBe(502); expect((await response.json()).error.code).toBe("OUTREACH_UNAVAILABLE");
    });
  it("rejects provider fields, duplicate pins, noninteger CAS and unknown path before mutation", async () => {
    const h = harness(() => { throw new Error("must not call"); });
    for (const body of [{ expected_version: 0, revision_ref: revisionRef, digest }, { expected_version: 1.5, revision_ref: revisionRef, digest },
      { expected_version: 1, revision_ref: revisionRef, digest, provider: "vendor" }])
      expect((await h.request("POST", `/v1/workspace/campaigns/${campaignRef}/publish`, body)).status).toBe(422);
    // No customer-supplied binding: activation names only the exact revision.
    expect((await h.request("POST", `/v1/workspace/journeys/${journeyRef}/activate`, { expected_version: 1, revision_ref: revisionRef, digest,
      campaigns: [{ campaign_ref: campaignRef, revision_ref: revisionRef, digest }] })).status).toBe(422);
    expect((await h.request("POST", `/v1/workspace/campaigns/${campaignRef}/activate`, { expected_version: 1, expected_journey_version: 1, revision_ref: revisionRef, digest })).status).toBe(422);
    expect((await h.request("GET", "/v1/workspace/campaigns/not-an-id")).status).toBe(400);
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("publication and activation use different exact contracts; approval alone selects nothing and grants no intent", async () => {
    const published = { ...campaign, version: 2, draft_revision: revision(policy, true), revisions: [revision(policy, true)] };
    const h = harness(name => name === "publish_lifty_campaign" ? { workspace, campaign: published }
      : { workspace, campaign: { ...published, version: 3, state: "active", active_revision: revision(policy, true) }, journey: { ...journey, executable_version: executableVersion },
        customer_list: { state: "fresh", reason: null, checked_at: "2026-10-07T04:05:00.123+00:00" } });
    const pub = await (await h.request("POST", `/v1/workspace/campaigns/${campaignRef}/publish`, { expected_version: 1, revision_ref: revisionRef, digest })).json();
    expect(pub.campaign).toMatchObject({ state: "inactive", active_revision: null, draft_revision: { approval: { actor_ref: senderId } } });
    const activated = await (await h.request("POST", `/v1/workspace/campaigns/${campaignRef}/activate`, { expected_version: 2, revision_ref: revisionRef, digest })).json();
    expect(activated.journey.executable_version).toEqual(executableVersion); expect(activated.campaign.state).toBe("active");
    expect(activated.customer_list).toEqual({ state: "fresh", reason: null, checked_at: "2026-10-07T04:05:00.123+00:00" });
    expect(h.rpc.mock.calls.map(call => call[0])).toEqual(["publish_lifty_campaign", "activate_lifty_campaign"]);
  });
  it("LIF-1454: warns when slots_spec names a placeholder its template's subject and text do not use, without blocking or changing the save", async () => {
    const consistent = "{company} = the spoken company name. {pain} = one verified pain.";
    const stale = `${consistent} No {main_focus}.`;
    const templated = (slots_spec: string) => ({ ...policy, compose_mode: "templates", steps: [{ position: 1, delay: { business_days: 0 },
      template: { id: "pain-1", arms: ["pain"], subject: "{company} and month-end", text: "Hi {first_name}, {pain}", slots_spec } }] });
    const email = { ...campaign, channel: "email" };
    const draft = { ...revision(templated(consistent)), revision_ref: senderId };
    const h = harness(name => name === "get_lifty_senders" ? { workspace, senders: [] }
      : ({ workspace, campaign: name === "create_lifty_campaign" ? { ...email, draft_revision: revision(templated(stale)), revisions: [revision(templated(stale))] }
        : name === "publish_lifty_campaign" ? { ...email, draft_revision: draft, revisions: [draft, revision(templated(stale), true)] }
          : { ...email, draft_revision: draft, revisions: [draft] } }));
    const warning = { revision_ref: revisionRef, unused_placeholders: [{ position: 1, template: "pain-1", placeholder: "{main_focus}" }] };

    const saved = await h.request("POST", "/v1/workspace/campaigns", { name: "Email", journey_ref: journeyRef, channel: "email", policy: templated(stale) });
    expect(saved.status).toBe(201);
    expect((await saved.json()).slots_spec_warnings).toEqual(warning);
    expect(h.rpc).toHaveBeenLastCalledWith("create_lifty_campaign", expect.objectContaining({ p_payload: expect.objectContaining({ policy: templated(stale) }) }));
    // Publishing an older revision warns about the revision it approved, not the newer draft.
    const published = await h.request("POST", `/v1/workspace/campaigns/${campaignRef}/publish`, { expected_version: 1, revision_ref: revisionRef, digest });
    expect(published.status).toBe(200);
    expect((await published.json()).slots_spec_warnings).toEqual(warning);
    const fixed = await h.request("PATCH", `/v1/workspace/campaigns/${campaignRef}/draft`, { expected_version: 2, revision_ref: revisionRef, changes: { steps: templated(consistent).steps } });
    expect(fixed.status).toBe(200);
    expect(await fixed.json()).not.toHaveProperty("slots_spec_warnings");
  });
  it("LIF-1659: refuses a template that types a saved sender's name, on both channels, before saving", async () => {
    // get_lifty_senders lists the workspace's senders that were not deleted;
    // Jeff was deleted, so only Anna and A.J. are listed.
    const anna = { id: senderId, version: 1, name: "Anna Easton", signature: null, booking_url: null, accounts: [] };
    const h = harness(name => name === "get_lifty_senders" ? { workspace, senders: [anna, { ...anna, id: revisionRef, name: "A.J. Brown" }] }
      : { workspace, campaign });
    const templated = (steps: unknown[], extra: object = {}) => ({ ...policy, compose_mode: "templates", ...extra, steps });
    const one = (template: object) => templated([{ position: 1, delay: { days: 0 }, template }]);
    const create = (channel: "email" | "linkedin", value: unknown) =>
      h.request("POST", "/v1/workspace/campaigns", { name: "Campaign", journey_ref: journeyRef, channel, policy: value });
    const draft = (steps: unknown[]) => h.request("PATCH", `/v1/workspace/campaigns/${campaignRef}/draft`,
      { expected_version: 1, revision_ref: revisionRef, changes: { steps } });
    const refused = async (response: Response, path: string, name: string) => {
      expect(response.status, path).toBe(422);
      expect((await response.json()).error).toEqual({ code: "OUTREACH_INVALID", message: "Repair these fields using the current operation schema.",
        issues: [{ code: "invalid_value", path, message: "This field does not match the current operation contract.",
          suggestion: `"${name}" is a saved sender's name. Write {sender_first_name} instead: Lifty fills it with the first name of the sender each lead is assigned to.` }] });
    };
    const writes = () => h.rpc.mock.calls.map(call => call[0]).filter(name => name !== "get_lifty_senders");

    await refused(await create("email", one({ subject: "I'm Anna", text: "Hi {first_name}, a quick question." })), "/policy/steps/0/template/subject", "Anna");
    await refused(await create("email", one({ subject: "A quick question", text: "Hi {first_name}, Anna Easton here." })), "/policy/steps/0/template/text", "Anna");
    await refused(await create("linkedin", one({ text: "Hi {first_name}, I'm Anna, I run Example." })), "/policy/steps/0/template/text", "Anna");
    await refused(await create("linkedin", one({ text: "Hi {first_name}, A.J. here." })), "/policy/steps/0/template/text", "A.J.");
    await refused(await draft([{ position: 1, delay: { days: 0 }, variants: [{ lane: "ops", text: "Hi {first_name}, I'm {sender_first_name}." },
      { lane: "transform", text: "Hi {first_name}, I'm Anna." }] }]), "/changes/steps/0/variants/1/text", "Anna");
    await refused(await draft([{ position: 1, delay: { days: 0 }, template: { subject: "Hello {first_name}", text: "Hi {first_name}, I'm {sender_first_name}." } },
      { position: 2, delay: { days: 3 }, template: { subject: "From Anna Easton", text: "Following up." } }]), "/changes/steps/1/template/subject", "Anna");
    expect(writes()).toEqual([]);
    expect(h.rpc).toHaveBeenCalledWith("get_lifty_senders", { p_workspace_id: null });

    const accepted = [
      ["linkedin", one({ text: "Hi {first_name}, I'm {sender_first_name} from Example." })],
      ["linkedin", one({ text: "Hi {{first_name}}, {{sender_first_name}} here." })],
      // Instructions may name several senders; only template subjects and text are checked.
      ["linkedin", templated([{ position: 1, delay: { days: 0 }, writing_instructions: "Anna Easton prefers short notes.",
        template: { text: "Hi {first_name}, I'm {sender_first_name}." } }], { instructions: "Anna and Jeff both send for Example." })],
      ["email", one({ subject: "Annapolis and {company}", text: "Hi {first_name}, the Savannah and Annapolis teams, ANNA reviews." })],
      ["linkedin", one({ text: "Hi {first_name}, I'm Jeff, I run Example." })],
    ] as const;
    for (const [channel, value] of accepted) expect((await create(channel, value)).status, JSON.stringify(value.steps)).toBe(201);
    expect((await draft([{ position: 1, delay: { days: 0 }, template: { text: "Hi {first_name}, I'm {sender_first_name}." } }])).status).toBe(200);
    expect(writes()).toEqual([...accepted.map(() => "create_lifty_campaign"), "patch_lifty_campaign_draft"]);
    expect(h.rpc).toHaveBeenLastCalledWith("patch_lifty_campaign_draft", expect.objectContaining({ p_payload: expect.objectContaining({
      changes: { steps: [{ position: 1, delay: { days: 0 }, template: { text: "Hi {first_name}, I'm {sender_first_name}." } }] } }) }));

    // MCP tools save through the same route.
    const settings = { resourceUrl: "https://api.lifty.test/mcp", authorizationServer: "https://project.supabase.test/auth/v1", allowedOrigins: [] };
    const authenticate = async () => ({ ok: true as const, session: { userId: "founder", client: { rpc: h.rpc } } });
    const mcp = createApp({ mcp: { ...settings, authenticate }, authenticate, log: () => {} });
    const tool = await (await mcp.request(new Request(settings.resourceUrl, { method: "POST",
      headers: { authorization: "Bearer founder", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "campaigns_post", arguments: { workspace: "example",
        body: { name: "Campaign", journey_ref: journeyRef, channel: "linkedin", policy: one({ text: "I'm Anna Easton, I run Example." }) } } } }),
    }))).json();
    expect(tool.result).toMatchObject({ isError: true, structuredContent: { status: 422, data: { error: { code: "OUTREACH_INVALID",
      issues: [{ path: "/policy/steps/0/template/text", suggestion: expect.stringContaining("{sender_first_name}") }] } } } });
    expect(writes()).toHaveLength(accepted.length + 1);
  });
  it("LIF-1128: refuses activation while the CRM customer list is not current and says where to read why", async () => {
    const h = harness(() => { throw { code: "PT409", message: "OUTREACH_CUSTOMER_LIST_NOT_CURRENT" }; });
    const response = await h.request("POST", `/v1/workspace/campaigns/${campaignRef}/activate`, { expected_version: 2, revision_ref: revisionRef, digest });
    const { error } = await response.json();
    expect([response.status, error.code]).toEqual([409, "OUTREACH_CUSTOMER_LIST_NOT_CURRENT"]);
    expect(error.message).toContain("crm_refresh");
  });
  it("never confirms a wrong approval digest, an unselected or paused activation, or a version pinning another revision", async () => {
    const other = { ...executableVersion, campaigns: [{ ...executableVersion.campaigns[0]!, revision: { revision_ref: senderId, digest } }] };
    for (const receipt of [
      { workspace, campaign },
      { workspace, campaign: { ...campaign, state: "active", active_revision: revision(policy, false) }, journey },
      { workspace, campaign: { ...campaign, state: "paused", active_revision: revision(policy, true) }, journey },
      { workspace, campaign: { ...campaign, state: "active", active_revision: revision(policy, true) }, journey: { ...journey, executable_version: other } },
    ]) {
      const h = harness(() => receipt);
      const result = await h.request("POST", `/v1/workspace/campaigns/${campaignRef}/activate`, { expected_version: 1, revision_ref: revisionRef, digest });
      expect(result.status).toBe(502);
    }
    // A dependent Campaign may be selected while it waits outside the version.
    const waiting = harness(() => ({ workspace, campaign: { ...campaign, state: "active", active_revision: revision(policy, true) }, journey }));
    expect((await waiting.request("POST", `/v1/workspace/campaigns/${campaignRef}/activate`, { expected_version: 1, revision_ref: revisionRef, digest })).status).toBe(200);
    const h = harness(() => ({ workspace, campaign: { ...campaign, revisions: [{ ...revision(policy, true), digest: "b".repeat(64) }] } }));
    expect((await h.request("POST", `/v1/workspace/campaigns/${campaignRef}/publish`, { expected_version: 1, revision_ref: revisionRef, digest })).status).toBe(502);
    const journeyActivation = harness(() => ({ workspace, journey: { ...journey, active_revision: revision(journeyPolicy, false) } }));
    expect((await journeyActivation.request("POST", `/v1/workspace/journeys/${journeyRef}/activate`, { expected_version: 1, revision_ref: revisionRef, digest })).status).toBe(502);
  });
  it("catalog and MCP expose implemented routes; old aliases and pending editor routes are unavailable", async () => {
    const tools = getStageMcpTools();
    for (const { key, resource, action, definition } of outreachEntries()) {
      const context = getAgentContext(resource);
      expect(context?.operations?.[action]?.route, key).toBe(definition.route);
      expect(tools.find(tool => tool.name === key.replaceAll(".", "_"))).toBeDefined();
    }
    for (const name of ["campaigns_post_read", "campaigns_post_write", "campaigns_client_email_write", "campaigns_resume", "campaigns_test", "campaigns_revise"]) {
      expect(tools.find(tool => tool.name === name)).toBeUndefined();
      const dispatch = vi.fn(); expect((await callStageMcpTool(name, {}, new Request("https://api.test"), dispatch)).isError).toBe(true); expect(dispatch).not.toHaveBeenCalled();
    }
    const h = harness(() => ({ workspace, campaigns: [], next_cursor: null }));
    expect((await h.request("PATCH", "/v1/workspace/campaigns", { scope: "workspace", request: {} })).status).toBe(404);
  });
});

// LIF-1760: a real Slack approval from the Functions proof. actor_ref is null
// because no member approved it; the revision is approved all the same.
describe("Campaign revisions approved through Slack", () => {
  const { campaign: read } = slack.campaign_slack;
  const exact = { revision_ref: read.active_revision.revision_ref, digest: read.active_revision.digest };
  const slackApproval = read.active_revision.approval;
  const activation = { expected_version: slack.campaign_pause_slack.campaign.version, ...exact };
  const activated = slack.campaign_activate_slack;
  const readWith = (approval: unknown) => ({ ...slack.campaign_slack, campaign: { ...read, active_revision: { ...read.active_revision, approval } } });

  it.each([
    ["detail", "get_lifty_campaign", `/v1/workspace/campaigns/${read.campaign_ref}`, slack.campaign_slack],
    ["list", "get_lifty_campaigns", "/v1/workspace/campaigns", slack.campaigns_slack],
    ["Journey detail", "get_lifty_journey", `/v1/workspace/journeys/${read.journey_ref}`, slack.journey_slack],
    ["Journey list", "get_lifty_journeys", "/v1/workspace/journeys", slack.journeys_slack],
  ])("reads the %s unchanged, naming no member", async (_label, rpc, path, receipt) => {
    const h = harness(name => { expect(name).toBe(rpc); return receipt; });
    const response = await h.request("GET", path);
    expect([response.status, await response.json()]).toEqual([200, receipt]);
  });

  it("confirms publication and activation of the exact Slack-approved revision", async () => {
    const h = harness(name => name === "activate_lifty_campaign" ? activated : slack.campaign_slack);
    expect((await h.request("POST", `/v1/workspace/campaigns/${read.campaign_ref}/publish`, { expected_version: read.version, ...exact })).status).toBe(200);
    const response = await h.request("POST", `/v1/workspace/campaigns/${read.campaign_ref}/activate`, activation);
    expect(response.status).toBe(200);
    expect(((await response.json()) as typeof activated).campaign.active_revision.approval).toEqual(slackApproval);
  });

  it.each([
    ["another revision", { ...activated, campaign: { ...activated.campaign, active_revision: { ...activated.campaign.active_revision, revision_ref: revisionRef } } }],
    ["another digest", { ...activated, campaign: { ...activated.campaign, active_revision: { ...activated.campaign.active_revision, digest } } }],
    ["no approval", { ...activated, campaign: { ...activated.campaign, active_revision: { ...activated.campaign.active_revision, approval: null } } }],
  ])("never confirms activation of %s", async (_label, receipt) => {
    const response = await harness(() => receipt).request("POST", `/v1/workspace/campaigns/${read.campaign_ref}/activate`, activation);
    expect([response.status, ((await response.json()) as { error: { code: string } }).error.code]).toEqual([502, "OUTREACH_UNAVAILABLE"]);
  });

  it.each([
    ["an extra field", { ...slackApproval, member: "invented" }],
    ["a member and a Slack identity", { ...slackApproval, actor_ref: senderId }],
    ["another origin", { ...slackApproval, origin: "dashboard" }],
    ["no Slack identity", (({ slack: _slack, ...approval }) => approval)(slackApproval)],
    ["a blank Slack user", { ...slackApproval, slack: { ...slackApproval.slack, user_id: "" } }],
    ["an extra Slack field", { ...slackApproval, slack: { ...slackApproval.slack, email: "person@example.test" } }],
    ["no decision link", (({ decision_ref: _decision, ...approval }) => approval)(slackApproval)],
    ["a decision link that is no UUID", { ...slackApproval, proposal_ref: "proposal" }],
    ["a null actor with nothing else", { actor_ref: null, approved_at: slackApproval.approved_at }],
  ])("refuses an approval with %s", async (_label, approval) => {
    const response = await harness(() => readWith(approval)).request("GET", `/v1/workspace/campaigns/${read.campaign_ref}`);
    expect([response.status, ((await response.json()) as { error: { code: string } }).error.code]).toEqual([502, "OUTREACH_UNAVAILABLE"]);
  });

  it("keeps a member's approval and an unapproved revision exactly as they were", async () => {
    const receipt = { workspace, campaign: { ...campaign, revisions: [revision(policy, true), revision(policy)] } };
    const response = await harness(() => receipt).request("GET", `/v1/workspace/campaigns/${campaignRef}`);
    expect([response.status, await response.json()]).toEqual([200, receipt]);
  });

  it("keeps Journey authoring member-only while its Campaign summaries carry Slack approvals", async () => {
    const own = { ...slack.journey_slack.journey.active_revision, approval: slackApproval };
    const response = await harness(() => ({ ...slack.journey_slack, journey: { ...slack.journey_slack.journey, active_revision: own } })).request("GET", `/v1/workspace/journeys/${read.journey_ref}`);
    expect(response.status).toBe(502);
  });
});
