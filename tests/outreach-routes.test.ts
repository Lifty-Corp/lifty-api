import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { STAGE_CLIENT_CONTRACT, getAgentContext } from "../src/agent-context.js";
import { executeOutreachOperation, outreachEntries } from "../src/outreach-operations.js";
import { memberReviewOperationDefinitions } from "../src/member-review-operations.js";
import { getStageMcpTools, callStageMcpTool } from "../src/mcp-stage-tools.js";

import { journeyRef, campaignRef, revisionRef, senderId, workspace, digest, policy, journeyPolicy, revision, executableVersion, journey, campaign, journeySummary, campaignSummary } from "./outreach-fixtures.js";
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
