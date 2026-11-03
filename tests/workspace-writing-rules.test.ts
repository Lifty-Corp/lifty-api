import { describe, expect, it, vi } from "vitest";
import { createApp, type AppDependencies } from "../src/app.js";
import { STAGE_CLIENT_CONTRACT } from "../src/agent-context.js";
import { campaign, campaignRef, policy, revision, revisionRef, workspace as outreachWorkspace } from "./outreach-fixtures.js";
import { criteriaFixture, laneFixture, profileFixture, workspaceRef } from "./business-fixtures.js";

// LIF-1724: each workspace owns one copy of its writing rules, saved in its
// commercial voice. Drafting context serves that copy, never LIFT's global
// list, and nothing checks saved copy against it.

const workspaceRules = "# Anti-Slop Rules\n\n## Global\n\n- synergy deep dive // says nothing\n\n## LinkedIn\n\n- ping you later\n";
// In LIFT's default list but not in this workspace's copy.
const defaultOnly = /i'm guessing/i;
const voice = (writing_rules?: string) => ({
  workspace_ref: workspaceRef,
  voice: { version: 3, updated_at: profileFixture.updated_at, tone: "Warm", rules: [],
    ...(writing_rules === undefined ? {} : { writing_rules }) },
});
const identity = { workspace_ref: workspaceRef, name: "Example", state: "ready_for_connections" };
const businessReads: Record<string, unknown> = {
  get_lifty_business_profile: { workspace: identity, profile: profileFixture },
  get_lifty_targeting: { workspace_ref: workspaceRef, targeting: { version: 1, updated_at: profileFixture.updated_at, lanes: [laneFixture] } },
  get_lifty_research_criteria: { workspace_ref: workspaceRef, criteria: criteriaFixture },
  get_lifty_setup_status: { workspace_ref: workspaceRef, state: "none" },
};
const reviewedRun = { state: "succeeded" as const, run_ref: "run-1", requested_leads: 5, leads_discovered: 5, leads_researched: 5,
  error_code: null, started_at: profileFixture.updated_at, completed_at: profileFixture.updated_at,
  reviewed_at: profileFixture.updated_at, workspace: { workspace_ref: workspaceRef, name: "Example" }, leads: [] };
const linkedinRoster = { workspace: identity, senders: [{ id: laneFixture.id, version: 1, name: "Ana Pérez", signature: null, booking_url: null,
  accounts: [{ id: laneFixture.personas[0]!.id, sender_id: laneFixture.id, channel: "linkedin" as const, identity: "https://www.linkedin.com/in/ana",
    status: "connected" as const, state: "active" as const, sending: { allowed: true, reason: null, scope: null }, limits: null,
    checked_at: profileFixture.updated_at, observation: { state: "verified" as const }, connected_at: profileFixture.updated_at,
    disconnected_at: null, access_revoked_at: null, access_removal: null, declaration: null, sends: { today: 0, last_7_days: 0 } }] }] };

type Reply = { data: unknown; error: unknown };
function harness(replies: Record<string, Reply | unknown>, options: Partial<AppDependencies> = {}) {
  const rpc = vi.fn(async (name: string, _args?: unknown): Promise<Reply> => {
    const reply = replies[name];
    if (reply && typeof reply === "object" && "error" in reply) return reply as Reply;
    return reply === undefined ? { data: null, error: { code: "PGRST202", message: "missing" } } : { data: reply, error: null };
  });
  const app = createApp({ authenticate: async () => ({ ok: true, session: { userId: "founder", client: { rpc } } }), log: () => {}, ...options });
  const request = (path: string, method = "GET", body?: unknown) => app.request(path, { method,
    headers: { authorization: "Bearer founder", "x-lifty-client-contract": STAGE_CLIENT_CONTRACT, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { rpc, request };
}
const contextFor = async (h: ReturnType<typeof harness>, task: string) =>
  (await h.request(`/v1/context/${task}?client_contract=${STAGE_CLIENT_CONTRACT}`)).json();

describe("commercial voice writing rules", () => {
  it("reads the voice with and without the writing_rules key, so both database shapes work", async () => {
    const saved = await harness({ get_lifty_commercial_voice: voice(workspaceRules) }).request("/v1/workspace/commercial-voice");
    expect(saved.status).toBe(200);
    expect((await saved.json()).voice.writing_rules).toBe(workspaceRules);
    const before = await harness({ get_lifty_commercial_voice: voice() }).request("/v1/workspace/commercial-voice");
    expect(before.status).toBe(200);
    expect((await before.json()).voice).not.toHaveProperty("writing_rules");
  });

  it("saves writing_rules within the database limits and refuses the rest before the RPC", async () => {
    const accepted = ["", workspaceRules, "x".repeat(20_000), "😀".repeat(20_000), "- one\r\n- two\t// tab"];
    for (const writing_rules of accepted) {
      const h = harness({ patch_lifty_commercial_voice: voice(writing_rules) });
      const response = await h.request("/v1/workspace/commercial-voice", "PATCH", { expected_version: 3, writing_rules });
      expect(response.status, JSON.stringify(writing_rules.slice(0, 12))).toBe(200);
      expect((await response.json()).voice.writing_rules).toBe(writing_rules);
      expect(h.rpc).toHaveBeenCalledExactlyOnceWith("patch_lifty_commercial_voice",
        { p_workspace_id: null, p_payload: { expected_version: 3, writing_rules } });
    }
    const refused = ["x".repeat(20_001), "😀".repeat(20_001), null, 7,
      ...["\u0000", "\u0001", "\u0008", "\u000b", "\u000c", "\u000e", "\u001f", "\u007f", "\u0080", "\u009f"].map(code => `- one${code}`)];
    for (const writing_rules of refused) {
      const h = harness({ patch_lifty_commercial_voice: voice("unused") });
      const response = await h.request("/v1/workspace/commercial-voice", "PATCH", { expected_version: 3, writing_rules });
      expect(response.status, JSON.stringify(writing_rules).slice(0, 12)).toBe(422);
      expect((await response.json()).error).toMatchObject({ code: "VOICE_INVALID", issues: [expect.objectContaining({ path: "/writing_rules" })] });
      expect(h.rpc).not.toHaveBeenCalled();
    }
  });
});

describe("drafting context serves the workspace's own writing rules", () => {
  it.each(["campaigns", "journeys"])("serves the caller workspace's copy in %s, never the default list", async task => {
    const h = harness({ get_lifty_commercial_voice: voice(workspaceRules) });
    const context = await contextFor(h, task);
    expect(context.references.anti_slop).toContain("- synergy deep dive // says nothing");
    expect(context.references.anti_slop).toContain("- ping you later");
    expect(context.references.anti_slop).not.toMatch(defaultOnly);
    expect(h.rpc).toHaveBeenCalledWith("get_lifty_commercial_voice", { p_workspace_id: null });
  });

  it.each([["absent", voice()], ["empty", voice("")], ["blank", voice(" \n\t")]])(
    "says a workspace whose copy is %s has no writing rules saved, with no fallback list", async (_case, saved) => {
      const context = await contextFor(harness({ get_lifty_commercial_voice: saved }), "campaigns");
      expect(context.references.anti_slop).toContain("This workspace has no writing rules saved.");
      expect(context.references.anti_slop).not.toMatch(defaultOnly);
    });

  it("does not call a failed read empty", async () => {
    const failed = await contextFor(harness({ get_lifty_commercial_voice: { data: null, error: { code: "XX000", message: "down" } } }), "campaigns");
    expect(failed.references.anti_slop).toContain("could not be read");
    expect(failed.references.anti_slop).not.toContain("no writing rules saved");
    expect(failed.references.anti_slop).not.toMatch(defaultOnly);
  });

  it("does not read tenant data for an anonymous read and points the agent to commercial voice", async () => {
    const never = vi.fn(async () => { throw new Error("anonymous context must not read tenant data"); });
    const app = createApp({ authenticate: never, businessOperation: never, log: () => {} });
    const context = await (await app.request(`/v1/context/campaigns?client_contract=${STAGE_CLIENT_CONTRACT}`)).json();
    expect(context.references.anti_slop).toContain("commercial_voice_get");
    expect(context.references.anti_slop).not.toMatch(defaultOnly);
    expect(never).not.toHaveBeenCalled();
  });

  const nextStep = async (saved: unknown) => (await harness({ ...businessReads, get_lifty_commercial_voice: saved }, {
    getRunStatus: async () => reviewedRun,
    outreachOperation: async () => ({ workspace: identity, campaigns: [], next_cursor: null }),
    identityOperation: async () => ({ status: 200, body: linkedinRoster }),
  }).request("/v1/workspace/next-step")).json();

  it("inlines the workspace's copy in next_step's drafting guide", async () => {
    const result = await nextStep(voice(workspaceRules));
    expect(result.reason).toBe("linkedin_connected");
    expect(result.guide.references.anti_slop).toContain("- synergy deep dive // says nothing");
    expect(result.guide.references.anti_slop).not.toMatch(defaultOnly);
    const none = await nextStep(voice());
    expect(none.guide.references.anti_slop).toContain("This workspace has no writing rules saved.");
    expect(none.guide.references.anti_slop).not.toMatch(defaultOnly);
    // A voice of another workspace is never served as this workspace's copy.
    const foreign = await nextStep({ ...voice(workspaceRules), workspace_ref: "99999999-9999-4999-8999-999999999999" });
    expect(foreign.reason).toBe("linkedin_connected");
    expect(foreign.guide.references.anti_slop).toContain("could not be read");
    expect(foreign.guide.references.anti_slop).not.toContain("synergy deep dive");
  });
});

describe("campaign saves", () => {
  it("return no writing recommendations for template text a default rule lists", async () => {
    const templates = { ...policy, compose_mode: "templates",
      steps: [{ position: 1, delay: { business_days: 0 }, template: { text: "Hi {first_name}, I'm guessing the timing is off." } }] };
    const saved = { ...campaign, draft_revision: revision(templates), revisions: [revision(templates)] };
    const h = harness({ patch_lifty_campaign_draft: { workspace: outreachWorkspace, campaign: saved },
      get_lifty_campaign: { workspace: outreachWorkspace, campaign: saved } });
    const response = await h.request(`/v1/workspace/campaigns/${campaignRef}/draft`, "PATCH",
      { expected_version: 1, revision_ref: revisionRef, changes: { compose_mode: "templates", steps: templates.steps } });
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty("writing_recommendations");
  });
});
