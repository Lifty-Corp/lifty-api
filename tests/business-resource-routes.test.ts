import { campaignSummary as canonicalCampaign } from "./outreach-fixtures.js";
import { describe, it, expect, vi } from "vitest";
import crmSyncControls from "./crm-sync-controls-sql-fixture.json" with { type: "json" };
import { PublicError } from "../src/errors.js";
import { createApp, type AppDependencies } from "../src/app.js";
import {
  getAgentContext,
  STAGE_CLIENT_CONTRACT,
} from "../src/agent-context.js";
import { getStageMcpTools, callStageMcpTool } from "../src/mcp-stage-tools.js";
import { stageOperations } from "../src/stage-contracts.js";
import { confirmRunReview, getRunStatus, startRun } from "../src/workspace-operations.js";
import { createRunProgressReader } from "../src/run-progress.js";
import { DEFAULT_DASHBOARD_ORIGIN } from "../src/config.js";
import {
  profileFixture,
  membershipFixture,
  workspaceRef,
  laneFixture,
  criteriaFixture,
  draftGetFixture,
  draftFixture,
} from "./business-fixtures.js";
const headers = {
  authorization: "Bearer founder",
  "x-lifty-client-contract": STAGE_CLIENT_CONTRACT,
  "content-type": "application/json",
};
const identity = {
  workspace_ref: workspaceRef,
  name: "Example",
  state: "ready_for_connections",
};
const get = { workspace: identity, profile: profileFixture };
const limitFixture = {
  weekly_research_limit: 25,
  source: "free",
  effective_from: "2026-09-01T00:00:00Z",
};
const scheduleFixture = {
  version: 1,
  state: "paused",
  weekly_target: 20,
  limit: limitFixture,
  effective_target: 20,
  updated_at: "2026-10-01T18:00:00Z",
  updated_by: null,
};
const statusFixture = {
  week_start: "2026-09-28",
  resets_at: "2026-10-05T00:00:00Z",
  state: "active",
  policy_version: 1,
  limit: limitFixture,
  effective_target: 20,
  completed: 7,
  qualified: 4,
  reserved: 5,
  remaining: 8,
  daily: [
    { date: "2026-09-28", completed: 2 },
    { date: "2026-09-29", completed: 5 },
    { date: "2026-09-30", completed: 0 },
  ],
  shortfall: null,
};
const leadRef = "55555555-5555-4555-8555-555555555555";
const leadsFixture = {
  items: [
    {
      lead_ref: leadRef,
      name: "Ada",
      title: "CEO",
      company: "Example",
      linkedin_url: "https://www.linkedin.com/in/ada",
      grade: "A",
      fit_rationale: "Owns sales.",
      researched_at: "2026-09-29T10:00:00Z",
    },
  ],
  next_cursor: "MjAyNi0wOS0yOXw1NTU1",
};
const sampleRun = "66666666-6666-4666-8666-666666666666";
const sampleWorkspace = { workspace_ref: workspaceRef, name: "Example" };
const rpcNames: Record<string, unknown> = {
  get_lifty_research_schedule: scheduleFixture,
  patch_lifty_research_schedule: { ...scheduleFixture, version: 2 },
  activate_lifty_research_schedule: { ...scheduleFixture, version: 2, state: "active" },
  pause_lifty_research_schedule: scheduleFixture,
  get_lifty_research_status: statusFixture,
  list_lifty_leads: leadsFixture,
  get_lifty_run_status: { state: "none" },
  start_lifty_run: { state: "queued", run_ref: sampleRun, requested_leads: 5, workspace: sampleWorkspace, created: true, attempt: 0 },
  confirm_lifty_run_review: { state: "succeeded", run_ref: sampleRun, requested_leads: 5, leads_discovered: 5, leads_researched: 5,
    error_code: null, started_at: "2026-10-06T12:00:00Z", completed_at: "2026-10-06T12:05:00Z", reviewed_at: "2026-10-06T12:10:00Z",
    workspace: sampleWorkspace, leads: [] },
  get_lifty_run_progress: { run_ref: sampleRun, attempt: 0, workspace_ref: workspaceRef, state: "queued", requested_leads: 5,
    leads_discovered: 0, leads_researched: 0, error_code: null, leads: [] },
  get_lifty_business_profile: get,
  get_lifty_targeting: {
    workspace_ref: workspaceRef,
    targeting: {
      version: 1,
      updated_at: profileFixture.updated_at,
      lanes: [laneFixture],
    },
  },
  get_lifty_research_criteria: {
    workspace_ref: workspaceRef,
    criteria: criteriaFixture,
  },
  get_lifty_setup_status: { workspace_ref: workspaceRef, state: "none" },
  get_lifty_setup_draft: draftGetFixture,
  get_lifty_commercial_voice: {
    workspace_ref: workspaceRef,
    voice: {
      version: 0,
      updated_at: profileFixture.updated_at,
      tone: null,
      rules: [],
    },
  },
};
function harness(
  reply?: unknown,
  error: unknown = null,
  options: Partial<AppDependencies> = {},
) {
  // Awaitable like a PostgREST builder, including the progress reader's abortSignal.
  const rpc = vi.fn((name: string, _args?: unknown) => {
    const result = Promise.resolve({ data: reply ?? rpcNames[name], error });
    return Object.assign(result, { abortSignal: () => result });
  });
  const authenticate = vi.fn(async () => ({
    ok: true as const,
    session: { userId: "founder", client: { rpc } },
  }));
  const app = createApp({
    authenticate,
    listMemberWorkspaces: async () => ({ workspaces: [membershipFixture] }),
    log: () => {},
    ...options,
  });
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    extra: Record<string, string> = {},
  ) =>
    app.request(path, {
      method,
      headers: { ...headers, ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { app, rpc, authenticate, request };
}
describe("typed Business direct HTTP boundary", () => {
  it("creates explicitly with one authenticated RPC and reports a replay without a second resource", async () => {
    const created = { ...get, created: true, voice: { version: 0 } };
    const h = harness(created);
    expect(
      (
        await h.request("/v1/workspace/business", "POST", {
          name: " Example ",
          website_url: null,
        })
      ).status,
    ).toBe(201);
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith(
      "create_lifty_business_profile",
      { p_payload: { name: "Example", website_url: null } },
    );
    expect(h.authenticate).toHaveBeenCalledOnce();
    const replay = await harness({ ...created, created: false }).request(
      "/v1/workspace/business",
      "POST",
      { name: "Example", website_url: null },
    );
    expect(replay.status).toBe(200);
    expect((await replay.json()).created).toBe(false);
  });
  it.each([
    { expected_version: 1, name: null },
    { expected_version: 1 },
    {
      expected_version: 1,
      offerings: [{ text: " ", provenance: "confirmed" }],
    },
    { expected_version: 1, offerings: [{ text: "X", provenance: "inferred" }] },
    {
      expected_version: 1,
      offerings: [
        { text: "x", provenance: "confirmed" },
        { text: " X ", provenance: "confirmed" },
      ],
    },
    {
      expected_version: 1,
      offerings: Array.from({ length: 11 }, (_, i) => ({
        text: `${i}`,
        provenance: "confirmed",
      })),
    },
    {
      expected_version: 1,
      value_proposition: { text: "x".repeat(501), provenance: "confirmed" },
    },
    {
      expected_version: 1,
      website_url: {
        text: "https://user:secret@example.com",
        provenance: "confirmed",
      },
    },
    {
      expected_version: 1,
      one_liner: { text: "Good", provenance: "confirmed", source: "website" },
    },
    { expected_version: 1, section: "workspace", values: { name: "bad" } },
  ])(
    "returns bounded repair issues and makes no RPC for invalid profile %#",
    async (body) => {
      const h = harness();
      const response = await h.request("/v1/workspace/business", "PATCH", body);
      expect(response.status).toBe(422);
      const output = await response.json();
      expect(output.error).toMatchObject({
        code: "PROFILE_INVALID",
        issues: expect.arrayContaining([
          {
            code: expect.any(String),
            path: expect.any(String),
            message: expect.any(String),
            suggestion: expect.any(String),
          },
        ]),
      });
      expect(JSON.stringify(output)).not.toContain("user:secret");
      expect(h.rpc).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["CRITERIA_REGENERATION_REQUIRED", "PT409", 409],
    ["PROFILE_CONFIRMATION_REQUIRED", "PT409", 409],
    ["SETUP_REQUIRED", "PT409", 409],
    ["TARGETING_LANE_UNKNOWN", "PT422", 422],
    ["VERSION_REQUIRED", "PT422", 422],
  ])(
    "preserves the expected SQL repair state %s",
    async (message, code, status) => {
      const h = harness(null, {
        code,
        message,
        details: JSON.stringify({
          stale_sources: ["profile", "base"],
          private: "Secret upstream detail",
        }),
      });
      const response = await h.request(
        "/v1/workspace/research-criteria",
        "PATCH",
        { expected_version: 1, research_fields: [] },
      );
      expect(response.status).toBe(status);
      const body = await response.json();
      expect(body.error.code).toBe(message);
      expect(body.error.message).not.toContain("could not be verified");
      expect(body.error.stale_sources).toEqual(["profile", "base"]);
      expect(JSON.stringify(body)).not.toContain("Secret");
    },
  );
  it("patches profile values directly without regeneration or receipt transport", async () => {
    const h = harness({ ...get, profile: { ...profileFixture, version: 2 } });
    const body = {
      expected_version: 1,
      one_liner: { text: "Less manual work", provenance: "confirmed" },
      description: null,
    };
    const result = await h.request("/v1/workspace/business", "PATCH", body);
    expect(result.status).toBe(200);
    expect((await result.json()).profile.version).toBe(2);
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith(
      "patch_lifty_business_profile",
      { p_workspace_id: null, p_payload: body },
    );
    expect(h.authenticate).toHaveBeenCalledOnce();
  });
  it("preserves CAS and suspension errors without leaking database detail", async () => {
    const h = harness(null, {
      code: "PT409",
      message: "VERSION_CONFLICT",
      details: JSON.stringify({ current_version: 3, secret: "private" }),
    });
    const response = await h.request("/v1/workspace/business", "PATCH", {
      expected_version: 1,
      name: "Changed",
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatchObject({
      code: "VERSION_CONFLICT",
      current_version: 3,
    });
    const suspended = harness(null, {
      code: "PT409",
      message: "WORKSPACE_SUSPENDED",
      details: "secret database context",
    });
    const blocked = await suspended.request(
      "/v1/workspace/commercial-voice",
      "PATCH",
      { expected_version: 0, tone: "Warm" },
    );
    expect(blocked.status).toBe(409);
    expect(await blocked.text()).not.toContain("secret database");
  });
  it("returns the database selection rule as public codes with the caller's workspaces", async () => {
    const workspaces = [
      { workspace_ref: workspaceRef, name: "Example", slug: "example" },
      { workspace_ref: "11111111-1111-4111-8111-111111111111", name: "Other", slug: "other" },
    ];
    const ambiguous = await harness(null, {
      code: "PT409",
      message: "lifty_workspace_ambiguous",
      details: JSON.stringify({ workspaces }),
    }).request("/v1/workspace/business");
    expect(ambiguous.status).toBe(409);
    expect((await ambiguous.json()).error).toEqual({
      code: "WORKSPACE_SELECTION_REQUIRED",
      message: expect.any(String),
      workspaces,
    });
    const foreign = await harness(null, { code: "PT403", message: "lifty_workspace_forbidden" }).request(
      "/v1/workspace/business",
      "PATCH",
      { expected_version: 1, name: "Changed" },
      { "x-lifty-workspace": "foreign" },
    );
    expect(foreign.status).toBe(403);
    expect((await foreign.json()).error.code).toBe("WORKSPACE_FORBIDDEN");
  });
  it("allows a missing workspace read and refuses storing a setup draft before creation", async () => {
    const h = harness({ workspace: null, profile: null });
    expect(await (await h.request("/v1/workspace/business")).json()).toEqual({
      workspace: null,
      profile: null,
    });
    const draft = await harness(null, { code: "PT409", message: "WORKSPACE_NOT_READY" }).request(
      "/v1/workspace/setup/draft",
      "PATCH",
      { expected_version: 0, draft: draftFixture, generated_criteria: null },
    );
    expect(draft.status).toBe(409);
    expect((await draft.json()).error.code).toBe("WORKSPACE_NOT_READY");
  });
  it("preserves partial lanes and independently required criteria input without provider fields", async () => {
    const h = harness(rpcNames.get_lifty_targeting);
    const body = {
      expected_version: 1,
      lanes: [
        { id: laneFixture.id, company: { excluded_industry_codes: ["5241"] } },
      ],
    };
    expect(
      (await h.request("/v1/workspace/targeting", "PATCH", body)).status,
    ).toBe(200);
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith("patch_lifty_targeting", {
      p_workspace_id: null,
      p_payload: body,
    });
    for (const invalid of [
      { ...body, lanes: [{ id: laneFixture.id, allocation_weight: 10 }] },
      {
        ...body,
        lanes: [
          {
            id: laneFixture.id,
            company: {
              employees: [
                { min: 100, max: 200 },
                { min: 10, max: 20 },
              ],
            },
          },
        ],
      },
    ])
      expect(
        (await h.request("/v1/workspace/targeting", "PATCH", invalid)).status,
      ).toBe(422);
    expect(h.rpc).toHaveBeenCalledOnce();
  });
  it("reads and patches personas whose migrated ids are not RFC 4122 UUIDs", async () => {
    // The Business migration derived persona ids from md5, without version or
    // variant bits; they are opaque server ids and must round-trip.
    const persona = { ...laneFixture.personas[0], id: "a518ff8c-30d3-bafd-cf8f-5a371160e6b2" };
    const lane = { ...laneFixture, personas: [persona] };
    const h = harness({
      workspace_ref: workspaceRef,
      targeting: { version: 1, updated_at: profileFixture.updated_at, lanes: [lane] },
    });
    expect((await h.request("/v1/workspace/targeting")).status).toBe(200);
    const body = { expected_version: 1, lanes: [{ id: lane.id, personas: [persona] }] };
    expect((await h.request("/v1/workspace/targeting", "PATCH", body)).status).toBe(200);
    expect(h.rpc).toHaveBeenLastCalledWith("patch_lifty_targeting", { p_workspace_id: null, p_payload: body });
  });
  it("round-trips optional email policy and rejects invalid enums before RPC writes", async () => {
    const persona = { ...laneFixture.personas[0], email_requirement: "optional" };
    const lane = { ...laneFixture, personas: [persona] };
    const h = harness({ workspace_ref: workspaceRef, targeting: { version: 1, updated_at: profileFixture.updated_at, lanes: [lane] } });
    const read = await h.request("/v1/workspace/targeting");
    expect(read.status).toBe(200);
    expect((await read.json()).targeting.lanes[0].personas[0].email_requirement).toBe("optional");
    const body = { expected_version: 1, lanes: [{ id: lane.id, personas: [persona] }] };
    expect((await h.request("/v1/workspace/targeting", "PATCH", body)).status).toBe(200);
    expect(h.rpc).toHaveBeenLastCalledWith("patch_lifty_targeting", { p_workspace_id: null, p_payload: body });
    h.rpc.mockClear();
    for (const email_requirement of [null, "invalid", "", true]) {
      expect((await h.request("/v1/workspace/targeting", "PATCH", { ...body, lanes: [{ id: lane.id, personas: [{ ...persona, email_requirement }] }] })).status).toBe(422);
    }
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("defaults legacy reads to verified without defaulting an omitted PATCH policy", async () => {
    const h = harness(rpcNames.get_lifty_targeting);
    const read = await h.request("/v1/workspace/targeting");
    expect((await read.json()).targeting.lanes[0].personas[0].email_requirement).toBe("verified");
    const body = { expected_version: 1, lanes: [{ id: laneFixture.id, personas: [laneFixture.personas[0]] }] };
    expect((await h.request("/v1/workspace/targeting", "PATCH", body)).status).toBe(200);
    expect(h.rpc).toHaveBeenLastCalledWith("patch_lifty_targeting", { p_workspace_id: null, p_payload: body });
  });

  it("saves voice version0 directly and rejects unrelated business facts", async () => {
    const h = harness({
      workspace_ref: workspaceRef,
      voice: {
        version: 1,
        updated_at: profileFixture.updated_at,
        tone: "Warm",
        rules: [{ kind: "avoid", text: "Emojis", source: "founder_feedback" }],
      },
    });
    const body = {
      expected_version: 0,
      tone: "Warm",
      rules: [{ kind: "avoid", text: "Emojis", source: "founder_feedback" }],
    };
    expect(
      (await h.request("/v1/workspace/commercial-voice", "PATCH", body)).status,
    ).toBe(200);
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith(
      "patch_lifty_commercial_voice",
      { p_workspace_id: null, p_payload: body },
    );
    expect(
      (
        await h.request("/v1/workspace/commercial-voice", "PATCH", {
          ...body,
          value_prop: "Wrong owner",
        })
      ).status,
    ).toBe(422);
    expect(h.rpc).toHaveBeenCalledOnce();
  });
  it("stores a server draft and refuses client-bound draft versions in generated criteria", async () => {
    const h = harness({ ...draftGetFixture, version: 2 });
    expect(
      (
        await h.request("/v1/workspace/setup/draft", "PATCH", {
          expected_version: 1,
          draft: draftFixture,
          generated_criteria: null,
        })
      ).status,
    ).toBe(200);
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith("save_lifty_setup_draft", {
      p_workspace_id: null,
      p_payload: {
        expected_version: 1,
        draft: draftFixture,
        generated_criteria: null,
      },
    });
    // The server binds generated criteria to the draft version it saves;
    // clients send only the profile and base versions they generated from.
    const { version: _, updated_at: __, ...generated } = criteriaFixture;
    const response = await h.request("/v1/workspace/setup/draft", "PATCH", {
      expected_version: 1,
      draft: draftFixture,
      generated_criteria: {
        ...generated,
        source_versions: { profile_version: 1, base_version: "base-v1", draft_version: 2 },
      },
    });
    expect(response.status).toBe(422);
    expect(h.rpc).toHaveBeenCalledOnce();
  });
  it("publishes real current base plus API guidance only to an authenticated selected member", async () => {
    const h = harness({
      workspace_ref: workspaceRef,
      profile: profileFixture,
      draft: draftGetFixture,
      base: { version: "base-v1", text: "Mandatory Scout base" },
    });
    const response = await h.request("/v1/workspace/setup/context");
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toMatchObject({
      base: { version: "base-v1", text: "Mandatory Scout base" },
      generation_rules: expect.any(Array),
      criteria_schema: { type: "object" },
      draft_schema: { type: "object" },
    });
    expect(JSON.stringify(data.generation_rules)).not.toMatch(
      /Apollo|Unipile|HeyReach|Smartlead|Mailivery/i,
    );
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith("get_lifty_setup_context", {
      p_workspace_id: null,
    });
  });
  it("submits the exact saved draft version and replays its receipt; discard after submission stays forbidden", async () => {
    const receipt = {
      workspace_ref: workspaceRef,
      state: "imported",
      setup_ref: "55555555-5555-4555-8555-555555555555",
      draft_version: 2,
      profile_version: 1,
      targeting_version: 1,
      criteria_version: 1,
      submitted_at: profileFixture.updated_at,
    };
    const h = harness(receipt);
    for (let i = 0; i < 2; i++)
      expect(
        await (
          await h.request("/v1/workspace/setup", "POST", {
            expected_draft_version: 2,
          })
        ).json(),
      ).toEqual(receipt);
    expect(h.rpc.mock.calls[0]).toEqual([
      "submit_lifty_setup",
      { p_workspace_id: null, p_expected_draft_version: 2 },
    ]);
    expect(h.rpc.mock.calls[1]).toEqual(h.rpc.mock.calls[0]);
    const forbidden = harness(null, {
      code: "PT409",
      message: "SETUP_ALREADY_SUBMITTED",
    });
    expect(
      (await forbidden.request("/v1/workspace/setup/draft", "DELETE")).status,
    ).toBe(409);
    expect(forbidden.rpc).toHaveBeenCalledExactlyOnceWith(
      "discard_lifty_setup_draft",
      { p_workspace_id: null },
    );
  });
  it("rejects hostile output instead of serializing it and retains stale source conflicts", async () => {
    const h = harness({ ...get, private_token: "secret" });
    const response = await h.request("/v1/workspace/business");
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("private_token");
    const stale = harness(null, {
      code: "PT409",
      message: "SETUP_STALE",
      details: JSON.stringify({ stale_sources: ["profile", "base"] }),
    });
    const rejected = await stale.request("/v1/workspace/setup", "POST", {
      expected_draft_version: 1,
    });
    expect(rejected.status).toBe(409);
    expect((await rejected.json()).error.stale_sources).toEqual([
      "profile",
      "base",
    ]);
  });
  it("bounds declared and streamed payloads before business persistence", async () => {
    const h = harness();
    expect(
      (
        await h.app.request("/v1/workspace/business", {
          method: "POST",
          headers: { ...headers, "content-length": String(133 * 1024) },
          body: "{}",
        })
      ).status,
    ).toBe(413);
    let chunks = 0;
    const body = new ReadableStream({
      pull(controller) {
        chunks++;
        controller.enqueue(new Uint8Array(16 * 1024));
        if (chunks > 100) controller.close();
      },
    });
    const streamed = await h.app.request("/v1/workspace/business", {
      method: "POST",
      headers,
      body,
      duplex: "half",
    } as RequestInit);
    expect(streamed.status).toBe(413);
    expect(chunks).toBeLessThan(15);
    expect(h.rpc).not.toHaveBeenCalled();
  });
});
describe("Business catalog, lifecycle and next-step conformance", () => {
  it("keeps public context, HTTP and MCP schemas aligned and retires old routes and aliases", async () => {
    const h = harness();
    for (const task of [
      "business",
      "targeting",
      "research-criteria",
      "commercial-voice",
      "setup",
      "research-schedule",
      "leads",
      "sample-review",
    ]) {
      const context = getAgentContext(task)!;
      expect(context.revision).toMatch(/^sha256:/);
      expect(JSON.stringify(context)).not.toMatch(
        /Apollo|Unipile|HeyReach|Smartlead|Mailivery|lifty-local-submission|onboarding_state|section.*icp/,
      );
      for (const [action, operation] of Object.entries(context.operations!)) {
        if (operation.responses["405"]) {
          expect(
            (await h.request(operation.route, operation.method)).status,
          ).toBe(405);
          continue;
        }
        const name = `${task.replace(/-/g, "_")}_${action}`;
        const tool = getStageMcpTools().find((item) => item.name === name);
        expect(tool).toBeDefined();
        expect(context.instructions).toContain(name);
      }
    }
    for (const path of [
      "/v1/onboarding",
      "/v1/onboarding/state",
      "/v1/config",
      "/v1/config/context",
      "/v1/workspace",
      "/v1/workspaces/22222222-2222-4222-8222-222222222222/integrations/apollo/key-source",
      "/v1/workspace/runs",
      "/v1/workspace/capacity",
      `/v1/workspaces/${workspaceRef}/apollo/recovery/${sampleRun}`,
    ]) {
      const response = await h.request(path, "POST", {});
      expect(response.status, path).toBe(404);
    }
    expect(h.rpc).not.toHaveBeenCalled();
    expect(getStageMcpTools().map((item) => item.name)).toEqual(
      expect.arrayContaining([
        "setup_get_draft",
        "setup_patch_draft",
        "setup_delete_draft",
        "setup_generation_context",
        "account_delete",
      ]),
    );
  });
  it("returns identical repair issues through MCP and forwards selected workspace", async () => {
    const h = harness();
    const request = new Request("https://api.test/mcp", {
      headers: { ...headers, "x-lifty-workspace": "example" },
    });
    const bad = {
      expected_version: 1,
      offerings: [{ text: "x", provenance: "inferred" }],
    };
    const direct = await (
      await h.request("/v1/workspace/business", "PATCH", bad)
    ).json();
    const tool = await callStageMcpTool(
      "business_patch",
      { body: bad },
      request,
      (route, init) => Promise.resolve(h.app.request(route, init)),
    );
    expect(tool.structuredContent).toMatchObject({
      status: 422,
      data: { error: direct.error },
    });
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("uses confirmed profile and resource state to bypass an absent old onboarding receipt", async () => {
    const h = harness(undefined, null, {
      getRunStatus: async () => ({ state: "none" }),
    });
    const response = await h.request("/v1/workspace/next-step");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      step: "sample-review",
      reason: "sample_not_started",
      gates: null,
      saved: null,
    });
    const resumed = await (await h.request("/v1/workspace/next-step")).json();
    expect(resumed.actions[0]).toContain("sample_review_post with body {}");
    expect(resumed.actions.join("\n")).not.toContain(
      "only after the founder asks",
    );
    expect(resumed.guide.task).toBe("step-sample");
    expect(resourceReads(h.rpc).slice(0, 4)).toEqual([
      "get_lifty_business_profile",
      "get_lifty_targeting",
      "get_lifty_research_criteria",
      "get_lifty_setup_status",
    ]);
  });
  it("never interprets a failed resource read as missing setup", async () => {
    const h = harness(undefined, {
      code: "XX000",
      message: "private provider failure",
    });
    const response = await h.request("/v1/workspace/next-step");
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("private provider failure");
    expect(h.rpc).toHaveBeenCalledOnce();
  });
  it("keeps Business checkpoint until confirmation and reports suspended lifecycle without new work", async () => {
    const h = harness({
      ...get,
      profile: {
        ...profileFixture,
        confirmation: { complete: false, missing: ["offerings"] },
      },
    });
    const response = await h.request("/v1/workspace/next-step");
    expect(await response.json()).toMatchObject({
      step: "business",
      reason: "business_confirmation_needed",
    });
    expect(resourceReads(h.rpc)).toEqual(["get_lifty_business_profile"]);
    const retired = harness({
      ...get,
      workspace: { ...identity, state: "suspended" },
    });
    expect(
      await (await retired.request("/v1/workspace/next-step")).json(),
    ).toMatchObject({ state: "blocked", reason: "workspace_suspended" });
    expect(resourceReads(retired.rpc)).toEqual(["get_lifty_business_profile"]);
  });
});

// The resources next_step read, in order. Its context drafts read (LIF-1298)
// runs alongside them for every workspace; tests/context-drafts.test.ts owns it.
function resourceReads(rpc: { mock: { calls: unknown[][] } }) {
  return rpc.mock.calls.map(([name]) => name).filter(name => name !== "get_lifty_context_drafts");
}

// The run reads go through their production RPC adapters so the arguments
// they send are observable.
const runAdapters: Partial<AppDependencies> = {
  getRunStatus: (session) => getRunStatus(session),
  confirmRunReview: (session, runRef) => confirmRunReview(session, runRef),
  startRun,
  getRunProgress: createRunProgressReader(),
  enqueueFirstRun: async () => ({ id: "job" }),
};
const resolvedOperations = [
  ["GET", "/v1/workspace/research-schedule", undefined, "get_lifty_research_schedule"],
  ["PATCH", "/v1/workspace/research-schedule", { expected_version: 1, weekly_target: 20 }, "patch_lifty_research_schedule"],
  ["POST", "/v1/workspace/research-schedule/activate", { expected_version: 1 }, "activate_lifty_research_schedule"],
  ["POST", "/v1/workspace/research-schedule/pause", { expected_version: 1 }, "pause_lifty_research_schedule"],
  ["GET", "/v1/workspace/research-schedule/status?week=2026-09-28", undefined, "get_lifty_research_status"],
  ["GET", "/v1/workspace/leads?grade=A&grade=B&limit=10", undefined, "list_lifty_leads"],
  ["GET", "/v1/workspace/sample-review", undefined, "get_lifty_run_status"],
  ["POST", "/v1/workspace/sample-review", {}, "start_lifty_run"],
  ["POST", "/v1/workspace/sample-review/confirm", { run_ref: sampleRun }, "confirm_lifty_run_review"],
  ["GET", `/v1/workspace/runs/progress?run_ref=${sampleRun}&wait_seconds=0`, undefined, "get_lifty_run_progress"],
] as const;
describe("research schedule, leads and sample share one workspace rule", () => {
  const callerWorkspaces = [
    { workspace_ref: "11111111-1111-4111-8111-111111111111", name: "Other", slug: "other" },
    { workspace_ref: workspaceRef, name: "Example", slug: "example" },
  ];
  it.each(resolvedOperations)(
    "%s %s leaves selection to the database and reports its selection errors",
    async (method, path, body, rpcName) => {
      const ok = harness(undefined, null, runAdapters);
      expect((await ok.request(path, method, body)).status).toBe(200);
      expect(ok.rpc).toHaveBeenCalledOnce();
      expect(ok.rpc.mock.calls[0]![0]).toBe(rpcName);
      expect(ok.rpc.mock.calls[0]![1]).toMatchObject({ p_workspace_id: null });
      const ambiguous = await harness(null, {
        code: "PT409", message: "lifty_workspace_ambiguous",
        details: JSON.stringify({ workspaces: callerWorkspaces, actor: "private" }),
      }, runAdapters).request(path, method, body);
      expect(ambiguous.status).toBe(409);
      expect((await ambiguous.json()).error).toEqual({
        code: "WORKSPACE_SELECTION_REQUIRED",
        message: expect.any(String),
        workspaces: callerWorkspaces,
      });
      const foreign = await harness(null, { code: "PT403", message: "lifty_workspace_forbidden" }, runAdapters)
        .request(path, method, body, { "x-lifty-workspace": "foreign" });
      expect(foreign.status).toBe(403);
      expect((await foreign.json()).error.code).toBe("WORKSPACE_FORBIDDEN");
    },
  );
  it("maps each operation's input to its RPC and builds lead links from the configured dashboard", async () => {
    const h = harness(undefined, null, runAdapters);
    const sent: unknown[] = [];
    for (const [method, path, body] of resolvedOperations.slice(0, 6)) {
      const response = await h.request(path, method, body);
      expect(response.status, path).toBe(200);
      sent.push(await response.json());
    }
    expect(h.rpc.mock.calls.map(([, args]) => args)).toEqual([
      { p_workspace_id: null },
      { p_workspace_id: null, p_payload: { expected_version: 1, weekly_target: 20 } },
      { p_workspace_id: null, p_payload: { expected_version: 1 } },
      { p_workspace_id: null, p_payload: { expected_version: 1 } },
      { p_workspace_id: null, p_week: "2026-09-28" },
      { p_workspace_id: null, p_query: { limit: 10, grade: ["A", "B"] } },
    ]);
    expect(sent[5]).toEqual({
      ...leadsFixture,
      items: [{ ...leadsFixture.items[0], research_url: `${DEFAULT_DASHBOARD_ORIGIN}/protected/leads/${leadRef}` }],
    });
    await h.request("/v1/workspace/research-schedule/status");
    expect(h.rpc.mock.calls.at(-1)![1]).toEqual({ p_workspace_id: null, p_week: null });
    // A null target returns the schedule to the plan's full limit (LIF-1247).
    const followPlan = await h.request("/v1/workspace/research-schedule", "PATCH", { expected_version: 1, weekly_target: null });
    expect(followPlan.status).toBe(200);
    expect(h.rpc.mock.calls.at(-1)![1]).toEqual({ p_workspace_id: null, p_payload: { expected_version: 1, weekly_target: null } });
  });
  it.each([
    ["PATCH", "/v1/workspace/research-schedule", { weekly_target: 20 }, 422, "TARGET_INVALID", "/expected_version"],
    ["PATCH", "/v1/workspace/research-schedule", { expected_version: 1, weekly_target: 0 }, 422, "TARGET_INVALID", "/weekly_target"],
    ["PATCH", "/v1/workspace/research-schedule", { expected_version: 1, weekly_target: 2.5 }, 422, "TARGET_INVALID", "/weekly_target"],
    ["PATCH", "/v1/workspace/research-schedule", { expected_version: 1, weekly_target: 1_000_000_000 }, 422, "TARGET_INVALID", "/weekly_target"],
    ["PATCH", "/v1/workspace/research-schedule", { expected_version: 1, weekly_target: 20, run_days: ["mon"] }, 422, "TARGET_INVALID", "/"],
    ["POST", "/v1/workspace/research-schedule/activate", {}, 400, "INVALID_REQUEST", "/expected_version"],
    ["POST", "/v1/workspace/research-schedule/pause", { expected_version: -1 }, 400, "INVALID_REQUEST", "/expected_version"],
    ["GET", "/v1/workspace/research-schedule/status?week=2026-09-29", undefined, 400, "INVALID_REQUEST", "/week"],
    ["GET", "/v1/workspace/research-schedule/status?week=29-09-2026", undefined, 400, "INVALID_REQUEST", "/week"],
    ["GET", "/v1/workspace/research-schedule?week=2026-09-28", undefined, 400, "INVALID_REQUEST", "/"],
    ["GET", "/v1/workspace/leads?limit=101", undefined, 400, "INVALID_REQUEST", "/limit"],
    ["GET", "/v1/workspace/leads?grade=D", undefined, 400, "INVALID_REQUEST", "/grade/0"],
    ["GET", "/v1/workspace/leads?cursor=not%20opaque", undefined, 400, "INVALID_REQUEST", "/cursor"],
    ["GET", "/v1/workspace/leads?week=2026-10-01", undefined, 400, "INVALID_REQUEST", "/week"],
    ["GET", "/v1/workspace/leads?limit=5&limit=6", undefined, 400, "INVALID_REQUEST", "/limit"],
  ] as const)("%s %s rejects invalid input before any RPC", async (method, path, body, status, code, issuePath) => {
    const h = harness();
    const response = await h.request(path, method, body);
    expect(response.status).toBe(status);
    const { error } = await response.json();
    expect(error.code).toBe(code);
    expect(error.issues.map((issue: { path: string }) => issue.path)).toContain(issuePath);
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it.each([
    [{ code: "PT409", message: "VERSION_CONFLICT", details: JSON.stringify({ current_version: 4, actor: "x" }) }, 409, { code: "VERSION_CONFLICT", current_version: 4 }],
    [{ code: "PT422", message: "TARGET_ABOVE_LIMIT", details: JSON.stringify({ limit: 25 }) }, 422, { code: "TARGET_ABOVE_LIMIT", limit: 25 }],
    [{ code: "PT422", message: "TARGET_INVALID" }, 422, { code: "TARGET_INVALID" }],
    [{ code: "PT409", message: "RESEARCH_NOT_CONFIGURED" }, 409, { code: "RESEARCH_NOT_CONFIGURED" }],
    [{ code: "PT409", message: "WORKSPACE_SUSPENDED" }, 409, { code: "WORKSPACE_SUSPENDED" }],
    [{ code: "PT403", message: "lifty_workspace_forbidden" }, 403, { code: "WORKSPACE_FORBIDDEN" }],
    [{ code: "PT409", message: "provider_quota_exceeded", details: "{\"provider\":\"secret\"}" }, 502, { code: "RESEARCH_SCHEDULE_UNAVAILABLE" }],
    [{ code: "57014", message: "canceling statement due to statement timeout" }, 502, { code: "RESEARCH_SCHEDULE_UNAVAILABLE" }],
  ] as const)("maps schedule RPC error %j through the shared typed mapping", async (error, status, expected) => {
    const h = harness(null, error);
    const response = await h.request("/v1/workspace/research-schedule", "PATCH", { expected_version: 1, weekly_target: 30 });
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body.error).toEqual({ message: expect.any(String), ...expected });
    expect(JSON.stringify(body)).not.toMatch(/secret|provider|actor|statement/);
  });
  it.each([
    ["/v1/workspace/research-schedule", { ...scheduleFixture, state: "unknown" }, "RESEARCH_SCHEDULE_UNAVAILABLE"],
    ["/v1/workspace/research-schedule/status", { ...statusFixture, completed: 8 }, "RESEARCH_STATUS_UNAVAILABLE"],
    ["/v1/workspace/research-schedule/status", { ...statusFixture, daily: [] }, "RESEARCH_STATUS_UNAVAILABLE"],
    ["/v1/workspace/leads", { items: [{ ...leadsFixture.items[0], grade: "D" }], next_cursor: null }, "LEADS_UNAVAILABLE"],
  ])("reports an unverifiable %s read as unknown, never zero or paused", async (path, reply, code) => {
    const response = await harness(reply).request(path);
    expect(response.status).toBe(502);
    expect((await response.json()).error.code).toBe(code);
  });
  it("starts the sample inside the weekly limit and returns the reset time when it is reached", async () => {
    const enqueue = vi.fn(async () => ({ id: "job" }));
    const h = harness(null, { code: "PT409", message: "RESEARCH_LIMIT_REACHED", details: JSON.stringify({ resets_at: "2026-10-05T00:00:00Z" }) },
      { ...runAdapters, enqueueFirstRun: enqueue });
    const response = await h.request("/v1/workspace/sample-review", "POST", {});
    expect(response.status).toBe(409);
    expect((await response.json()).error).toEqual({ code: "RESEARCH_LIMIT_REACHED", message: expect.any(String), resets_at: "2026-10-05T00:00:00Z" });
    expect(enqueue).not.toHaveBeenCalled();
    expect((await h.request("/v1/workspace/sample-review", "PATCH", {})).status).toBe(404);
  });
  it("publishes route, MCP and CLI nouns from one catalog and transports grade lists through MCP", async () => {
    const commands = Object.entries({ "research-schedule": stageOperations["research-schedule"]!, leads: stageOperations.leads! })
      .flatMap(([resource, operations]) => Object.entries(operations)
        .filter(([, operation]) => !operation.responses["405"])
        .map(([key, operation]) => [`${operation.method} ${resource} ${operation.cli?.operation ?? key}`, `${operation.method} ${operation.route}`, operationTool(resource, key)]));
    expect(commands).toEqual([
      ["GET research-schedule get", "GET /v1/workspace/research-schedule", "research_schedule_get"],
      ["PATCH research-schedule patch", "PATCH /v1/workspace/research-schedule", "research_schedule_patch"],
      ["POST research-schedule activate", "POST /v1/workspace/research-schedule/activate", "research_schedule_activate"],
      ["POST research-schedule pause", "POST /v1/workspace/research-schedule/pause", "research_schedule_pause"],
      ["GET research-schedule status", "GET /v1/workspace/research-schedule/status", "research_schedule_status"],
      ["GET leads get", "GET /v1/workspace/leads", "leads_list"],
    ]);
    const guide = getAgentContext("research-schedule")!.instructions + getAgentContext("leads")!.instructions;
    for (const line of ["lifty get research-schedule →", "lifty patch research-schedule →", "lifty post research-schedule activate →",
      "lifty post research-schedule pause →", "lifty get research-schedule status →", "lifty get leads →"]) expect(guide).toContain(line);
    expect(getStageMcpTools().find((tool) => tool.name === "research_schedule_activate")!.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    const h = harness(undefined, null, runAdapters);
    const tool = await callStageMcpTool("leads_list", { query: { grade: ["A", "B"], week: "2026-09-28" } },
      new Request("https://api.example.test/mcp", { headers: { authorization: "Bearer founder" } }),
      (route, init) => Promise.resolve(h.app.request(route, init)));
    expect(tool.structuredContent).toMatchObject({ status: 200, data: { next_cursor: leadsFixture.next_cursor } });
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith("list_lifty_leads", { p_workspace_id: null, p_query: { limit: 25, grade: ["A", "B"], week: "2026-09-28" } });
  });
});
const operationTool = (resource: string, key: string) =>
  getStageMcpTools().find((tool) => tool.name === `${resource.replace(/-/g, "_")}_${key}`)?.name;

const runFixture = {
  state: "succeeded" as const,
  run_ref: "run-1",
  requested_leads: 5,
  leads_discovered: 5,
  leads_researched: 4,
  error_code: null,
  started_at: profileFixture.updated_at,
  completed_at: profileFixture.updated_at,
  // Confirmed, so Parts 2-4 follow the saved accounts and campaigns (LIF-1303).
  reviewed_at: profileFixture.updated_at,
  workspace: { workspace_ref: workspaceRef, name: "Example" },
  leads: [],
};
const emptyOutreach = (key: string) => ({ workspace: { workspace_ref: workspaceRef, name: "Example", state: "ready_for_connections" },
  [key === "journeys.get" ? "journeys" : "campaigns"]: [], next_cursor: null });
const crmConnected = {
  provider: "hubspot" as const,
  status: "connected" as const,
  portal_id: "123",
  hub_domain: null,
  granted_scopes: [],
  connected_at: null,
  reconnect_required: false,
};
const syncFixture = {
  state: "running" as const,
  run_ref: "sync-1",
  requested_leads: 4,
  leads_synced: 1,
  error_code: null,
  portal_id: "123",
  started_at: profileFixture.updated_at,
  completed_at: null,
  workspace: runFixture.workspace,
};
const sendersFixture = {
  workspace: { workspace_ref: workspaceRef, name: "Example", state: "ready_for_connections" },
  senders: [{ id: laneFixture.id, version: 1, name: "Ana Pérez", signature: null, booking_url: null, accounts: [{
    id: laneFixture.personas[0]!.id, sender_id: laneFixture.id, channel: "email" as const, identity: "ana@example.test",
    status: "connected" as const, state: "active" as const, checked_at: profileFixture.updated_at, observation: { state: "verified" as const },
    connected_at: profileFixture.updated_at, disconnected_at: null, access_revoked_at: null,
    declaration: { mailbox_use: "habitual" as const, declared_by: null, declared_at: profileFixture.updated_at },
    sends: { today: 1, last_7_days: 3 } }] }],
};
const summaryReads: Partial<AppDependencies> = {
  getWorkspace: async () => ({
    state: "ready_for_connections",
    workspace: runFixture.workspace,
    next_action: null,
  }),
  getRunStatus: async () => runFixture,
  outreachOperation: async (_session, key) => emptyOutreach(key),
  getHubspotConnection: async () => crmConnected,
  getCrmSyncStatus: async () => syncFixture,
  identityOperation: async () => ({ status: 200, body: sendersFixture }),
};

describe("resource resumption preserves research, campaign and CRM decisions", () => {
  it.each(["queued", "running", "failed"] as const)(
    "resumes a %s research receipt without starting a run or reading a campaign",
    async (state) => {
      const campaign = vi.fn(async (_session, key: string) => emptyOutreach(key));
      const start = vi.fn();
      const h = harness(undefined, null, {
        getRunStatus: async () => ({
          ...runFixture,
          state,
          completed_at: state === "failed" ? profileFixture.updated_at : null,
          reviewed_at: null,
          error_code: state === "failed" ? "research_failed" : null,
        }),
        outreachOperation: campaign,
        startRun: start,
      });
      const result = await (await h.request("/v1/workspace/next-step")).json();
      expect(result).toMatchObject({
        step: "sample-review",
        state: state === "failed" ? "blocked" : "pending",
        receipt: { run_ref: "run-1" },
      });
      if (state !== "failed")
        expect(result.actions[0]).toContain("run_ref run-1");
      expect(campaign).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["research_limit_reached", "research_schedule_status", "resets_at"],
    ["search_exhausted", "targeting_patch", "wider targeting"],
    ["research_failed", "sample_review_post", "Retry once"],
    ["calibration_sample_incomplete", "sample_review_post", "Retry once"],
    ["calibration_review_required", "sample_review_post", "same saved people"],
  ] as const)(
    "explains a failed sample's %s reason with catalog tools and no recovery path",
    async (reason, tool, guidance) => {
      const h = harness(undefined, null, {
        getRunStatus: async () => ({
          ...runFixture,
          state: "failed" as const,
          error_code: reason,
        }),
      });
      const result = await (await h.request("/v1/workspace/next-step")).json();
      expect(result).toMatchObject({
        state: "blocked",
        reason: "sample_failed",
        receipt: { error_code: reason },
      });
      expect(result.recommended_tools).toContain(tool);
      const tools = new Set(getStageMcpTools().map((item) => item.name));
      for (const name of result.recommended_tools)
        expect(tools.has(name), name).toBe(true);
      expect(result.actions.join(" ").toLowerCase()).toContain(guidance.toLowerCase());
      expect(JSON.stringify(result.actions)).not.toMatch(
        /recovery|apollo|allowance|capacity/i,
      );
    },
  );
  it.each([
    ["paused", { step: "campaign", state: "action_required", reason: "campaigns_saved" }, "activate separately"],
    ["active", { step: "linkedin", state: "complete", reason: "linkedin_outreach_active" }, "only when the founder asks"],
  ] as const)("resumes canonical campaign %s without activating or inferring readiness", async (state, position, guidance) => {
    const campaign = vi.fn(async () => ({ ...emptyOutreach("campaigns.get"), campaigns: [{ ...canonicalCampaign, state }] }));
    const h = harness(undefined, null, { getRunStatus: async () => runFixture, outreachOperation: campaign });
    const result = await (await h.request("/v1/workspace/next-step")).json();
    expect(result).toMatchObject({ ...position, section: "outreach" });
    expect(campaign).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ userId: "founder" }), "campaigns.get", { path: {}, query: {}, body: undefined });
    expect(result.actions.join(" ")).toContain(guidance);
  });
  // Part 2 resumes from the saved LinkedIn account and campaigns (LIF-1302).
  const linkedinRoster = (status: "connected" | "needs_reconnect" | "disconnected") => ({ ...sendersFixture,
    senders: [{ ...sendersFixture.senders[0]!, accounts: [{ ...sendersFixture.senders[0]!.accounts[0]!, channel: "linkedin" as const,
      identity: "https://www.linkedin.com/in/ana", declaration: null, status }] }] });
  it.each([
    ["connected", [], "linkedin_connected"],
    ["connected", ["inactive"], "campaigns_saved"],
    ["connected", ["active"], "linkedin_outreach_active"],
    // A lost LinkedIn account stops its outreach, so it comes first even with an active campaign.
    ["needs_reconnect", ["active"], "linkedin_reconnect_needed"],
    // A removed account is history, not a connection.
    ["disconnected", [], "sample_ready_for_founder_review"],
  ] as const)("resumes Part 2 from a %s LinkedIn account and campaigns %j at %s", async (status, states, reason) => {
    const h = harness(undefined, null, { getRunStatus: async () => runFixture,
      outreachOperation: async (_session, key) => ({ ...emptyOutreach(key), campaigns: states.map(state => ({ ...canonicalCampaign, state })) }),
      identityOperation: async () => ({ status: 200, body: linkedinRoster(status) }) });
    const result = await (await h.request("/v1/workspace/next-step")).json();
    expect(result.reason).toBe(reason);
    // The agent acts on the exact account: templates permit its sender, a reconnect needs its id.
    if (reason === "linkedin_connected" || reason === "linkedin_reconnect_needed") {
      const account = sendersFixture.senders[0]!.accounts[0]!;
      expect(result.receipt).toEqual({ account: { id: account.id, sender_id: account.sender_id, sender: "Ana Pérez", status } });
      expect(result.actions.join(" ")).toContain(reason === "linkedin_connected" ? "permitting Ana Pérez" : `path.id ${account.id}`);
    }
  });
  // Parts 3 and 4 resume from the founder's mailbox, warmup, placement and plan (LIF-1260).
  const mailbox = { ...sendersFixture.senders[0]!.accounts[0]! };
  const linkedinAccount = { ...mailbox, id: laneFixture.personas[0]!.id.replace(/.$/, "f"), channel: "linkedin" as const,
    identity: "https://www.linkedin.com/in/ana", declaration: null };
  const roster = (accounts: unknown[]) => ({ ...sendersFixture, senders: [{ ...sendersFixture.senders[0]!, accounts }] });
  const warmupRead = (state: string, extra: Record<string, unknown> = {}) => ({ state, warmup_ready: false, spam: null,
    recommended_go_live: { kind: "projected", date: "2026-10-27", remaining_active_days: 21, message: "About three weeks of warmup." }, ...extra });
  const passing = { passing_until: "2099-01-01T00:00:00Z", test: { state: "passed" } };
  const scheduleRead = (source: string) => ({ version: 1, state: "paused", weekly_target: 25,
    limit: { weekly_research_limit: 25, source, effective_from: profileFixture.updated_at }, effective_target: 25,
    updated_at: profileFixture.updated_at, updated_by: null });
  const emailHarness = (state: { accounts?: unknown[]; warmup?: unknown; placement?: unknown; plan?: string; campaigns?: string[]; run?: unknown }) => harness(undefined, null, {
    getRunStatus: async () => (state.run ?? runFixture) as never,
    outreachOperation: async (_session, key) => ({ ...emptyOutreach(key), campaigns: (state.campaigns ?? []).map(value => ({ ...canonicalCampaign, state: value })) }),
    identityOperation: async () => ({ status: 200, body: roster(state.accounts ?? [mailbox]) }),
    getEmailWarmup: async () => {
      if (state.warmup === "unavailable") throw new PublicError({ status: 502, code: "EMAIL_WARMUP_UNAVAILABLE", message: "Unavailable." });
      return (state.warmup ?? warmupRead("not_started")) as never;
    },
    getEmailPlacement: async () => (state.placement ?? { passing_until: null, test: null }) as never,
    researchOperation: async () => scheduleRead(state.plan ?? "free"),
  });
  it.each([
    [{}, "email_connected", "email"],
    [{ warmup: warmupRead("warming") }, "email_preparing", "email"],
    [{ placement: { passing_until: null, test: { state: "running" } } }, "email_preparing", "email"],
    [{ warmup: warmupRead("warming", { spam: { holds_sending: true } }) }, "email_held", "email"],
    [{ warmup: warmupRead("warming"), placement: { passing_until: null, test: { state: "failed" } } }, "email_held", "email"],
    [{ accounts: [{ ...mailbox, status: "needs_reconnect" }] }, "email_held", "email"],
    [{ warmup: warmupRead("warming", { warmup_ready: true }), placement: passing }, "paid_plan_needed", "kickoff"],
    [{ warmup: warmupRead("warming", { warmup_ready: true }), placement: passing, plan: "paid" }, "email_ready", "kickoff"],
    // A founder workspace has no passing_until (placement is advisory there):
    // its latest completed test decides (LIF-1223).
    [{ warmup: warmupRead("warming", { warmup_ready: true }), placement: { gates_sending: false, last_passed_at: "2026-10-07T12:00:00Z",
      passing_until: null, test: { state: "passed" } } }, "paid_plan_needed", "kickoff"],
    [{ warmup: warmupRead("warming", { warmup_ready: true }), placement: { gates_sending: false, last_passed_at: "2026-10-07T12:00:00Z",
      passing_until: null, test: { state: "failed" } } }, "email_held", "email"],
    // Ready needs a passing placement test, not warmup alone.
    [{ warmup: warmupRead("warming", { warmup_ready: true }) }, "email_preparing", "email"],
    // Part 2 comes first while a connected LinkedIn account has no active campaign.
    [{ accounts: [linkedinAccount, mailbox], warmup: warmupRead("warming", { warmup_ready: true }), placement: passing }, "linkedin_connected", "outreach"],
    [{ accounts: [linkedinAccount, mailbox], campaigns: ["active"] }, "email_connected", "email"],
    // An unreadable status is unknown: never ready or held.
    [{ warmup: "unavailable", placement: passing }, "email_connected", "email"],
  ] as const)("resumes Parts 3 and 4 from %j at %s", async (state, reason, section) => {
    const result = await (await emailHarness(state as never).request("/v1/workspace/next-step")).json();
    expect(result).toMatchObject({ reason, section });
  });
  // LIF-1223: the first placement test is automatic and its result is a notice,
  // so Part 3 offers Slack whenever it is not connected, after LinkedIn too.
  it("offers Slack for the placement result in Part 3 and never requests the first test itself", async () => {
    for (const state of [{}, { accounts: [linkedinAccount, mailbox], campaigns: ["active"] }]) {
      const result = await (await emailHarness(state as never).request("/v1/workspace/next-step")).json();
      expect(result.reason).toBe("email_connected");
      const actions = result.actions.join(" ");
      expect(actions).toContain("offer to connect it now so the test result reaches them there");
      expect(actions).toContain("Lifty will notify them with the placement test result");
      expect(actions).toContain("Lifty tests where its email lands as soon as setup is done");
      // Every mailbox gets its warmup link at once; connecting alone is not setup.
      expect(actions).toContain("right away, whatever the mailbox's use, and show the returned setup link in the same reply");
      expect(result.recommended_tools).not.toContain("sending_accounts_placement_start");
    }
  });
  it("hands a free workspace with a ready mailbox to David without activating anything", async () => {
    const result = await (await emailHarness({ warmup: warmupRead("warming", { warmup_ready: true }), placement: passing }).request("/v1/workspace/next-step")).json();
    expect(result).toMatchObject({ reason: "paid_plan_needed", step: "plan", receipt: { plan: "free", mailbox: { id: mailbox.id } } });
    expect(result.actions.join(" ")).toContain("David from LIFT");
    expect(result.actions.join(" ")).toContain("never activates outreach");
    expect(result.recommended_tools).not.toContain("campaigns_activate");
  });
  // Several senders: the agent asks whose account or campaign it is instead of
  // acting on the first one; one sender is assumed.
  it.each(["connected", "needs_reconnect", "email_ready"] as const)("names every sender for a %s step and asks which one", async position => {
    const ana = { ...sendersFixture.senders[0]!, accounts: [position === "email_ready" ? mailbox
      : { ...linkedinAccount, status: position === "needs_reconnect" ? "needs_reconnect" as const : "connected" as const }] };
    const luisId = "44444444-4444-4444-8444-444444444444";
    const luis = { ...ana, id: luisId, name: "Luis Gómez",
      accounts: [{ ...ana.accounts[0]!, id: "33333333-3333-4333-8333-333333333333", sender_id: luisId }] };
    const h = harness(undefined, null, { getRunStatus: async () => runFixture,
      outreachOperation: async (_session, key) => emptyOutreach(key),
      identityOperation: async () => ({ status: 200, body: { ...sendersFixture, senders: [ana, luis] } }),
      getEmailWarmup: async () => warmupRead("warming", { warmup_ready: true }) as never,
      getEmailPlacement: async () => passing as never,
      researchOperation: async () => scheduleRead("paid") });
    const result = await (await h.request("/v1/workspace/next-step")).json();
    const actions = result.actions.join(" ");
    expect(result.reason).toBe(position === "connected" ? "linkedin_connected" : position === "needs_reconnect" ? "linkedin_reconnect_needed" : "email_ready");
    if (position === "needs_reconnect") {
      expect(actions).toContain("ask which to reconnect now");
      expect(actions).toContain(`${ana.accounts[0]!.id} (Ana Pérez), ${luis.accounts[0]!.id} (Luis Gómez)`);
    } else {
      if (position === "connected") expect(actions).toContain("LinkedIn is connected for Ana Pérez, Luis Gómez");
      expect(actions).toContain("ask which of them this campaign sends from");
      expect(actions).not.toContain("permitting Ana Pérez");
    }
  });
  // Accounts or campaigns set up while the sample ran never skip its review:
  // Parts 2-4 wait for the founder's confirmation (LIF-1303).
  it.each([
    ["mailbox", { accounts: [mailbox] }, "email_connected"],
    ["LinkedIn account", { accounts: [linkedinAccount] }, "linkedin_connected"],
    ["saved campaign", { accounts: [], campaigns: ["inactive"] }, "campaigns_saved"],
  ] as const)("keeps the sample review ahead of a %s set up while the sample ran until the founder confirms it", async (_label, state, after) => {
    const review = await (await emailHarness({ ...state, run: { ...runFixture, reviewed_at: null } } as never).request("/v1/workspace/next-step")).json();
    expect(review).toMatchObject({ reason: "sample_ready_for_founder_review", section: "leads" });
    expect(review.recommended_tools).toContain("sample_review_confirm");
    expect(review.actions.join(" ")).toContain("sample_review_confirm and run_ref run-1");
    // What the founder already set up is not offered again.
    expect(review.actions.join(" ")).toContain("do not offer it again");
    expect(review.actions.join(" ")).not.toContain("set up LinkedIn outreach");
    const confirmed = await (await emailHarness(state as never).request("/v1/workspace/next-step")).json();
    expect(confirmed.reason).toBe(after);
  });
  it("does not ask a confirmed leads-only founder to review the sample again", async () => {
    const result = await (await emailHarness({ accounts: [] }).request("/v1/workspace/next-step")).json();
    expect(result.reason).toBe("sample_ready_for_founder_review");
    expect(result.recommended_tools).not.toContain("sample_review_confirm");
    expect(result.actions.join(" ")).toContain("already confirmed this sample");
    expect(result.actions.join(" ")).toContain("set up LinkedIn outreach");
  });
  it("confirms the exact run and reports a sample that cannot be confirmed yet", async () => {
    const h = harness(undefined, null, runAdapters);
    const response = await h.request("/v1/workspace/sample-review/confirm", "POST", { run_ref: sampleRun });
    expect(await response.json()).toMatchObject({ run_ref: sampleRun, reviewed_at: "2026-10-06T12:10:00Z" });
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith("confirm_lifty_run_review", { p_run_ref: sampleRun, p_workspace_id: null });
    expect((await h.request("/v1/workspace/sample-review/confirm", "POST", {})).status).toBe(400);
    const running = await harness(null, { code: "PT409", message: "RUN_NOT_REVIEWABLE" }, runAdapters)
      .request("/v1/workspace/sample-review/confirm", "POST", { run_ref: sampleRun });
    expect(running.status).toBe(409);
    expect((await running.json()).error.code).toBe("RUN_NOT_REVIEWABLE");
  });
  it("treats an unreadable sender roster as unknown, not as LinkedIn unconnected", async () => {
    const h = harness(undefined, null, { getRunStatus: async () => runFixture,
      outreachOperation: async (_session, key) => emptyOutreach(key),
      identityOperation: async () => { throw new PublicError({ status: 502, code: "IDENTITY_UNAVAILABLE", message: "Unavailable." }); } });
    const result = await (await h.request("/v1/workspace/next-step")).json();
    expect(result.reason).toBe("sample_ready_for_founder_review");
    expect(result.actions.join(" ")).toContain("sender roster could not be read");
  });
  it.each(["campaign", "run"])(
    "fails closed for a foreign %s instead of inferring missing configuration",
    async (component) => {
      const foreign = "55555555-5555-4555-8555-555555555555";
      const h = harness(undefined, null, {
        getRunStatus: async () =>
          component === "run"
            ? {
                ...runFixture,
                workspace: { ...runFixture.workspace, workspace_ref: foreign },
              }
            : runFixture,
        outreachOperation: async () => ({ ...emptyOutreach("campaigns.get"), workspace: { workspace_ref: foreign, name: "Other", state: "ready_for_connections" } }),
      });
      const response = await h.request("/v1/workspace/next-step");
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain(foreign);
    },
  );
  it("keeps unreadable campaign state unavailable instead of calling it unconfigured", async () => {
    const h = harness(undefined, null, {
      getRunStatus: async () => runFixture,
      outreachOperation: async () => {
        throw new PublicError({
          status: 502,
          code: "OUTREACH_UNAVAILABLE",
          message: "Campaign status unavailable.",
        });
      },
    });
    const response = await h.request("/v1/workspace/next-step");
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(
      "sample_ready_for_founder_review",
    );
  });
  it.each([
    [
      { status: "not_connected", provider: "hubspot" },
      { state: "none" },
      "Ask once whether",
    ],
    // A CRM connection and customer-list authorization are separate choices.
    [
      { status: "not_connected", provider: "hubspot" },
      { state: "none" },
      "customer_exclusions_status first for saved protections",
    ],
    [
      { status: "not_connected", provider: "hubspot" },
      { state: "none" },
      "Neither allows setup to continue",
    ],
    [
      { status: "not_connected", provider: "hubspot" },
      { state: "none" },
      "Connecting does not authorize reading their customer list",
    ],
    [
      { ...crmConnected, reconnect_required: true },
      { state: "none" },
      "needs reconnecting",
    ],
    [crmConnected, { state: "none" }, "nothing is synced yet"],
    [crmConnected, syncFixture, "in progress (run_ref sync-1)"],
    [
      crmConnected,
      {
        ...syncFixture,
        state: "succeeded",
        completed_at: profileFixture.updated_at,
        leads_synced: 4,
      },
      "finished (4 leads)",
    ],
    [
      crmConnected,
      {
        ...syncFixture,
        state: "failed",
        completed_at: profileFixture.updated_at,
        error_code: "portal_scope_missing",
      },
      "failed (portal_scope_missing)",
    ],
  ] as const)(
    "offers a CRM action from saved evidence without blocking leads-only review",
    async (connection, sync, message) => {
      const write = vi.fn();
      const h = harness(undefined, null, {
        getRunStatus: async () => runFixture,
        outreachOperation: async (_session, key) => emptyOutreach(key),
        getHubspotConnection: async () => connection as never,
        getCrmSyncStatus: async () => sync as never,
        customerExclusionsOperation: async () => ({ workspace_ref: workspaceRef, mode: "unselected", provider: null, sources: [], version: 0, updated_at: null, refresh_pending: false }),
        // LIF-1622: a CRM that writes today keeps automatic sync on.
        crmSyncControlsOperation: async () => ({ ...crmSyncControls.status_paused, automatic_sync: "on", next_step: "none" }),
        startCrmSyncRun: write,
        // No outreach account yet: the founder is still closing Part 1.
        identityOperation: async () => ({ status: 200, body: { ...sendersFixture, senders: [] } }),
      });
      const result = await (await h.request("/v1/workspace/next-step")).json();
      expect(result).toMatchObject({
        state: "review",
        reason: "sample_ready_for_founder_review",
        section: "leads",
      });
      expect(result.actions[2]).toContain(message);
      expect(result.actions[3]).toContain(
        "Close Section 1 in at most six lines",
      );
      expect(result.actions[3]).toContain("set up LinkedIn outreach for these leads now");
      expect(result.guide).toMatchObject({ task: "step-review" });
      expect(result.guide.instructions).toContain('If "not now", accept');
      expect(write).not.toHaveBeenCalled();
    },
  );
  it.each([
    { mode: "none", provider: null, sources: [] },
    { mode: "file", provider: null, sources: [] },
    { mode: "crm", provider: "hubspot", sources: ["crm_customer"] },
  ])("does not repeat the customer offer after a saved $mode choice", async choice => {
    const write = vi.fn();
    const h = harness(undefined, null, {
      getRunStatus: async () => runFixture,
      outreachOperation: async (_session, key) => emptyOutreach(key),
      getHubspotConnection: async () => crmConnected,
      getCrmSyncStatus: async () => ({ state: "none" }),
      customerExclusionsOperation: async () => ({ ...choice, workspace_ref: workspaceRef, version: 1, updated_at: "2026-10-07T12:00:00Z", refresh_pending: false }),
      startCrmSyncRun: write,
      identityOperation: async () => ({ status: 200, body: { ...sendersFixture, senders: [] } }),
    });
    const result = await (await h.request("/v1/workspace/next-step")).json();
    expect(result).toMatchObject({ state: "review", reason: "sample_ready_for_founder_review" });
    expect(result.actions[2]).toContain(`saved ${choice.mode} choice`);
    expect(result.actions[2]).not.toContain("Separately offer customer exclusions");
    expect(result.recommended_tools).not.toContain("customer_exclusions_source_choice_post");
    expect(write).not.toHaveBeenCalled();
  });
  it("preserves leads-only review through optional CRM failures and never claims a new connection is needed", async () => {
    const h = harness(undefined, null, {
      getRunStatus: async () => runFixture,
      outreachOperation: async (_session, key) => emptyOutreach(key),
      getHubspotConnection: async () => {
        throw Error("secret credential");
      },
    });
    const result = await (await h.request("/v1/workspace/next-step")).json();
    expect(result.state).toBe("review");
    expect(result.actions[2]).toContain("currently unavailable");
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});

describe("summary keeps independent tenant-scoped state", () => {
  it("reports resource versions, research and CRM receipts without full lead or message content", async () => {
    const h = harness(undefined, null, summaryReads);
    const response = await h.request("/v1/workspace/summary");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const result = await response.json();
    expect(result).toMatchObject({
      setup: {
        status: "available",
        value: {
          targeting_version: 1,
          criteria_version: 1,
          profile_version: 1,
          voice_version: 0,
        },
      },
      run: {
        status: "available",
        value: { state: "succeeded", leads_researched: 4 },
      },
      research_schedule: {
        status: "available",
        value: { state: "paused", weekly_target: 20, effective_target: 20 },
      },
      crm: {
        status: "available",
        value: {
          connected: true,
          sync_pending: true,
          last_sync: { state: "running", leads_synced: 1 },
        },
      },
      senders: { status: "available", value: sendersFixture.senders },
      detail_operations: { senders: "senders.get", sending_accounts: "sending-accounts.get" },
    });
    for (const retired of ["self_service", "mailboxes", "email", "linkedin"]) expect(result).not.toHaveProperty(retired);
    expect(result).not.toHaveProperty("config_update");
    expect(result).not.toHaveProperty("onboarding");
    expect(result.run.value).not.toHaveProperty("leads");
  });
  it("keeps unrelated reads available when research, schedule, email ownership or voice cannot be read", async () => {
    const h = harness(undefined, null, {
      ...summaryReads,
      getRunStatus: async () => {
        throw Error("secret research error");
      },
      researchOperation: async () => {
        throw new PublicError({ status: 502, code: "RESEARCH_SCHEDULE_UNAVAILABLE", message: "secret schedule" });
      },
      identityOperation: async () => {
        throw new PublicError({ status: 502, code: "IDENTITY_UNAVAILABLE", message: "Secret identity detail" });
      },
    });
    const result = await (await h.request("/v1/workspace/summary")).json();
    expect(result.run).toEqual({
      status: "unavailable",
      next_action: "retry_read",
    });
    expect(result.senders).toEqual({
      status: "unavailable",
      next_action: "retry_read",
    });
    expect(result.research_schedule).toEqual({
      status: "unavailable",
      next_action: "retry_read",
    });
    expect(result.crm.status).toBe("available");
    expect(result.business.status).toBe("available");
    expect(JSON.stringify(result)).not.toMatch(/Secret|secret/);
  });
  it.each([401, 403])(
    "does not hide authorization %s inside a partial summary",
    async (status) => {
      const h = harness(undefined, null, {
        ...summaryReads,
        getRunStatus: async () => {
          throw new PublicError({ status, code: "DENIED", message: "Denied" });
        },
      });
      expect((await h.request("/v1/workspace/summary")).status).toBe(status);
    },
  );
  it.each([
    "WORKSPACE_CHANGED",
    "WORKSPACE_UNAVAILABLE",
    "WORKSPACE_MISSING",
    "WORKSPACE_SELECTION_REQUIRED",
    "WORKSPACE_SUSPENDED",
  ])("does not hide scope conflict %s", async (code) => {
    const h = harness(undefined, null, {
      ...summaryReads,
      getRunStatus: async () => {
        throw new PublicError({
          status: 409,
          code,
          message: "Refresh workspace state.",
        });
      },
    });
    expect((await h.request("/v1/workspace/summary")).status).toBe(409);
  });
  it.each(["run", "crm", "senders"])(
    "rejects foreign %s state while summarizing a selected workspace",
    async (component) => {
      const foreign = "55555555-5555-4555-8555-555555555555";
      const h = harness(undefined, null, {
        ...summaryReads,
        ...(component === "run"
          ? {
              getRunStatus: async () => ({
                ...runFixture,
                workspace: { ...runFixture.workspace, workspace_ref: foreign },
              }),
            }
          : component === "crm"
            ? {
                getCrmSyncStatus: async () => ({
                  ...syncFixture,
                  workspace: {
                    ...runFixture.workspace,
                    workspace_ref: foreign,
                  },
                }),
              }
            : {
                identityOperation: async () => ({ status: 200 as const, body: {
                  ...sendersFixture, workspace: { ...sendersFixture.workspace, workspace_ref: foreign } } }),
              }),
      });
      expect((await h.request("/v1/workspace/summary")).status).toBe(403);
    },
  );
  it("rejects membership changes between aggregate reads", async () => {
    const getWorkspace = vi
      .fn()
      .mockResolvedValueOnce({
        state: "ready_for_connections",
        workspace: runFixture.workspace,
        next_action: null,
      })
      .mockResolvedValue({
        state: "ready_for_connections",
        workspace: {
          workspace_ref: "55555555-5555-4555-8555-555555555555",
          name: "Foreign",
        },
        next_action: null,
      });
    const h = harness(undefined, null, { ...summaryReads, getWorkspace });
    expect((await h.request("/v1/workspace/summary")).status).toBe(409);
  });
  it("reads senders once through the shared pure roster read, the same for every workspace", async () => {
    const identity = vi.fn(async () => ({ status: 200 as const, body: sendersFixture }));
    const h = harness(undefined, null, { ...summaryReads, identityOperation: identity });
    const result = await (await h.request("/v1/workspace/summary", "GET", undefined, { "x-lifty-workspace": "example" })).json();
    expect(result.senders).toEqual({ status: "available", value: sendersFixture.senders });
    expect(identity).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ userId: "founder" }), "senders.get", { path: {}, query: {}, body: undefined });
  });
  it("rejects aggregate writes and missing authorization", async () => {
    const h = harness(undefined, null, summaryReads);
    for (const method of ["POST", "PATCH"])
      expect(
        (await h.request("/v1/workspace/summary", method, {})).status,
      ).toBe(405);
    expect((await createApp().request("/v1/workspace/summary")).status).toBe(
      401,
    );
  });
});
