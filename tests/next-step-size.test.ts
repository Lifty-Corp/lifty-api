import { describe, expect, it } from "vitest";
import { getAgentContext } from "../src/agent-context.js";
import { BASE_CONTEXTS, NEXT_STEP_CATALOG, ON_REQUEST_CONTEXTS, getNextStep } from "../src/next-step.js";
import { operationToolNames } from "../src/operation-names.js";
import { stageOperations } from "../src/stage-contracts.js";
import { campaignSummary } from "./outreach-fixtures.js";
import { criteriaFixture, draftGetFixture, laneFixture, profileFixture, workspaceRef } from "./business-fixtures.js";
// Captured from the real local SQL suite (lift-supabase-functions
// scripts/test-lif1622-crm-automatic-sync.py).
import crmSyncControls from "./crm-sync-controls-sql-fixture.json" with { type: "json" };

// Every next_step response is inlined into the founder's agent on each call;
// large ones stall chat connectors (LIF-1149). Limits per reason, in JSON
// characters, as the next_step test enforced before LIF-1173 (LIF-1295).
const limits: Record<string, number> = {
  workspace_missing: 25_000,
  workspace_suspended: 25_000,
  business_confirmation_needed: 25_000,
  confirmed_interview_needed: 25_000,
  configuration_needed: 40_000,
  configuration_saved: 12_000,
  setup_resource_unavailable: 12_000,
  sample_not_started: 12_000,
  sample_pending: 12_000,
  sample_failed: 12_000,
  sample_ready_for_founder_review: 40_000,
  linkedin_connected: 80_000,
  campaigns_saved: 80_000,
  linkedin_outreach_active: 25_000,
  linkedin_reconnect_needed: 25_000,
  // LIF-1670: Part 3 also asks to draft and approve a campaign while none is active.
  email_connected: 27_000,
  email_preparing: 27_000,
  email_held: 25_000,
  email_ready: 80_000,
};

const identity = { workspace_ref: workspaceRef, name: "Example", state: "ready_for_connections" };
const at = profileFixture.updated_at;
const run = { state: "succeeded", run_ref: "run-1", requested_leads: 5, leads_discovered: 5, leads_researched: 5,
  error_code: null, started_at: at, completed_at: at, reviewed_at: at, workspace: { workspace_ref: workspaceRef, name: "Example" }, leads: [] };
const senderId = "22222222-2222-4222-8222-222222222222";
const linkedinAccount = (status: string) => ({ id: "11111111-1111-4111-8111-111111111111", sender_id: senderId, channel: "linkedin",
  identity: "https://www.linkedin.com/in/ada", status, state: "active", sending: { allowed: true, reason: null, scope: null }, limits: null,
  checked_at: at, observation: { state: "verified" }, connected_at: at, disconnected_at: null, access_revoked_at: null, access_removal: null,
  declaration: null, sends: { today: 0, last_7_days: 0 } });
const founder = (status: string) => ({ id: senderId, version: 1, name: "Ada Founder", signature: null, booking_url: null,
  accounts: [linkedinAccount(status)] });
const activeLinkedin = { ...campaignSummary, state: "active" };
const mailboxOwner = (status: string) => ({ ...founder(status), accounts: [{ ...linkedinAccount(status),
  id: "33333333-3333-4333-8333-333333333333", channel: "email", identity: "ada@example.com" }] });
const warmup = (state: string, extra: Record<string, unknown> = {}) => ({ state, warmup_ready: false, spam: null,
  recommended_go_live: { kind: "projected", date: "2026-10-27", remaining_active_days: 21, message: "About three weeks of warmup." }, ...extra });
const passed = { passing_until: "2099-01-01T00:00:00Z", test: { state: "passed" } };
const unset = { targeting: { workspace_ref: workspaceRef, targeting: null }, criteria: { workspace_ref: workspaceRef, criteria: null } };
const base = {
  business: { workspace: identity, profile: profileFixture } as unknown,
  targeting: { workspace_ref: workspaceRef, targeting: { version: 1, updated_at: at, lanes: [laneFixture] } } as unknown,
  criteria: { workspace_ref: workspaceRef, criteria: criteriaFixture } as unknown,
  setup: { workspace_ref: workspaceRef, state: "none" } as unknown,
  draft: draftGetFixture as unknown,
  run: { state: "none" } as unknown,
  campaigns: [] as unknown[],
  senders: [] as unknown[] | "unavailable",
  warmup: warmup("not_started") as unknown,
  placement: { passing_until: null, test: null } as unknown,
  hubspot: { provider: "hubspot", status: "not_connected" } as unknown,
};
const connectedHubspot = { provider: "hubspot", status: "connected", portal_id: "1622001", hub_domain: null,
  granted_scopes: [], connected_at: at, reconnect_required: false };
const generated = { text: criteriaFixture.text, research_fields: criteriaFixture.research_fields,
  source_versions: { profile_version: 1, draft_version: 1, base_version: "base-v1" } };
const states: Partial<typeof base>[] = [
  { business: { workspace: null, profile: null } },
  { business: { workspace: { ...identity, state: "suspended" }, profile: profileFixture } },
  { business: { workspace: identity, profile: { ...profileFixture, confirmation: { complete: false, missing: ["offerings"] } } } },
  { ...unset, draft: { ...draftGetFixture, gates: { next: "persona", missing: ["persona"], issues: [] } } },
  unset,
  { ...unset, draft: { ...draftGetFixture, generated_criteria: generated } },
  { ...unset, setup: { workspace_ref: workspaceRef, state: "imported", setup_ref: "77777777-7777-4777-8777-777777777777",
    draft_version: 1, profile_version: 1, targeting_version: 1, criteria_version: 1, submitted_at: at } },
  {},
  { run: { ...run, state: "running", completed_at: null, reviewed_at: null } },
  { run: { ...run, state: "failed", error_code: "search_exhausted" } },
  { run },
  { run, campaigns: [campaignSummary] },
  // LIF-1622: a new CRM connection waits with automatic sync paused.
  { run, hubspot: connectedHubspot },
  { run, senders: [founder("connected")] },
  { run, campaigns: [activeLinkedin] },
  { run, senders: [founder("needs_reconnect")] },
  { run, senders: [mailboxOwner("connected")] },
  { run, senders: [mailboxOwner("connected")], warmup: warmup("warming") },
  { run, senders: [mailboxOwner("connected")], warmup: warmup("warming", { spam: { holds_sending: true } }) },
  { run, senders: [mailboxOwner("connected")], warmup: warmup("warming", { warmup_ready: true }), placement: passed },
];

async function nextStep(state: Partial<typeof base>) {
  const current = { ...base, ...state };
  const reads: Record<string, unknown> = { "business.get": current.business, "targeting.get": current.targeting,
    "research-criteria.get": current.criteria, "setup.status": current.setup, "setup.get_draft": current.draft };
  return getNextStep({
    businessOperation: async (_session, key) => reads[key],
    getRunStatus: async () => current.run,
    outreachOperation: async () => ({ workspace: identity, campaigns: current.campaigns, next_cursor: null }),
    getHubspotConnection: async () => current.hubspot,
    getAttioConnection: async () => ({ provider: "attio", status: "not_connected" }),
    getCrmSyncStatus: async () => ({ state: "none" }),
    customerExclusionsOperation: async () => ({ workspace_ref: workspaceRef, mode: "unselected", provider: null, sources: [], version: 0, updated_at: null, refresh_pending: false }),
    getEmailWarmup: async () => current.warmup,
    getEmailPlacement: async () => current.placement,
    identityOperation: async () => {
      if (current.senders === "unavailable") throw new Error("roster unavailable");
      return { status: 200, body: { workspace: identity, senders: current.senders } };
    },
    readContextDrafts: async () => [],
    crmSyncControlsOperation: async () => crmSyncControls.status_paused,
  } as Parameters<typeof getNextStep>[0], { userId: "founder", client: {} } as Parameters<typeof getNextStep>[1]);
}

describe("next_step response size", () => {
  it("keeps every step within its limit and the full stage guide one read away", async () => {
    const seen = new Set<string>();
    for (const state of states) {
      const result = await nextStep(state);
      seen.add(result.reason);
      const size = JSON.stringify(result).length;
      expect(size, `${result.reason} is ${size} characters`).toBeLessThan(limits[result.reason]!);
      expect(getAgentContext(result.context_task!), result.reason).not.toBeNull();
    }
    expect([...seen].sort()).toEqual(Object.keys(limits).sort());
    expect(Object.keys(NEXT_STEP_CATALOG).sort()).toEqual(Object.keys(limits).sort());
  });
});

// The stage that owns each callable tool name.
const toolStage = new Map(Object.entries(stageOperations).flatMap(([stage, operations]) =>
  Object.keys(operations).flatMap(operation => operationToolNames(stage, operation).map(name => [name, stage] as const))));

// Each step tells the agent where to look; a context outside onboarding is
// declared with how the agent reaches it instead (LIF-1301, LIF-1304).
describe("next_step context links", () => {
  it("gives every stage context exactly one role: linked by a step, the base or on request", () => {
    const linked = [...new Set(Object.values(NEXT_STEP_CATALOG).flatMap(entry => [entry.context, ...entry.related]))];
    for (const stage of linked) expect(Object.hasOwn(stageOperations, stage), `${stage} is not a stage`).toBe(true);
    const roles = [...linked, ...Object.keys(BASE_CONTEXTS), ...Object.keys(ON_REQUEST_CONTEXTS)];
    expect(roles.filter((stage, index) => roles.indexOf(stage) !== index), "stages with two roles").toEqual([]);
    expect(roles.sort()).toEqual(Object.keys(stageOperations).sort());
  });

  it("recommends only tools of the stages the step links", async () => {
    for (const state of [...states, { run: { ...run, state: "failed", error_code: "research_limit_reached" } }]) {
      const result = await nextStep(state);
      expect(result.related_contexts, result.reason).toEqual(NEXT_STEP_CATALOG[result.reason]!.related);
      // summary_context is how every step reads its links.
      const stages = new Set(["summary", result.context_task, ...result.related_contexts]);
      for (const name of result.recommended_tools)
        expect(stages.has(toolStage.get(name) ?? ""), `${result.reason} recommends ${name}`).toBe(true);
    }
  });
});

describe("next_step with a paused CRM (LIF-1622)", () => {
  it("offers the test sync instead of the bulk sync the database would refuse", async () => {
    const result = await nextStep({ run, hubspot: connectedHubspot });
    expect(result.recommended_tools).toEqual(expect.arrayContaining(["crm_test_sync_start", "crm_test_sync_status"]));
    expect(result.recommended_tools).not.toContain("crm_sync_start");
    expect(JSON.stringify(result)).toMatch(/automatic sync paused/);
  });
});
