import { profileFixture } from "./business-fixtures.js";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { callStageMcpTool, getStageMcpTools } from "../src/mcp-stage-tools.js";
import { stageOperations } from "../src/stage-contracts.js";
import { STAGE_CLIENT_CONTRACT } from "../src/agent-context.js";

const incoming = () => new Request("https://api.example.test/mcp", { headers: { authorization: "Bearer founder" } });
const workspace = { workspace_ref: "22222222-2222-4222-8222-222222222222", name: "Example" };

const withoutDialect = (value: unknown): unknown => Array.isArray(value) ? value.map(withoutDialect)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$schema")
    .map(([key, item]) => [key, withoutDialect(item)])) : value;

describe("generated MCP stage operations", () => {
  it("covers every supported operation with unique annotated tools and the canonical schema", () => {
    const tools = getStageMcpTools();
    expect(new Set(tools.map(tool => tool.name)).size).toBe(tools.length);
    // An operation several stages share is listed once, under its first stage.
    const firstStage = new Map<string, string>();
    for (const [stage, operations] of Object.entries(stageOperations)) for (const operation of Object.values(operations)) {
      if (!firstStage.has(`${operation.method} ${operation.route}`)) firstStage.set(`${operation.method} ${operation.route}`, stage);
    }
    for (const [stage, operations] of Object.entries(stageOperations)) for (const [action, operation] of Object.entries(operations)) {
      const listedStage = firstStage.get(`${operation.method} ${operation.route}`)!;
      const name = stage === "summary" && action === "next_step" ? "next_step" : `${listedStage.replace(/-/g, "_")}_${action}`;
      const supported = Object.keys(operation.responses).some(status => status.startsWith("2"));
      const notificationWrite = stage === "notifications" && action === "patch";
      const names = notificationWrite ? ["notifications_destination_upsert", "notifications_route_set", "notifications_controls_set", "notifications_preferences_set"]
        : stage === "notifications" && action === "post" ? ["notifications_connect"] : [name];
      const matches = tools.filter(tool => names.includes(tool.name));
      expect(matches.length, name).toBe(supported ? names.length : 0);
      for (const tool of matches) {
        expect(tool.title.length).toBeGreaterThan(0);
        expect(typeof tool.annotations.readOnlyHint).toBe("boolean");
        expect(typeof tool.annotations.destructiveHint).toBe("boolean");
        if (tool.annotations.readOnlyHint) expect(tool.annotations.destructiveHint).toBe(false);
        expect(tool.inputSchema.properties.workspace).toMatchObject({ type: "string" });
        expect(tool.inputSchema.required).not.toContain("workspace");
        expect(tool.inputSchema.properties.path).toEqual(withoutDialect(operation.request.path));
        expect(tool.inputSchema.properties.query).toEqual(withoutDialect(operation.request.query));
        if (!notificationWrite && operation.request.body) expect(tool.inputSchema.properties.body).toEqual(withoutDialect(operation.request.body));
      }
    }
    expect(JSON.stringify(tools)).not.toContain("$schema");
    expect(tools.find(tool => tool.name === "setup_patch_draft")!.description).toContain("workspace draft");
    for (const alias of ["targeting_onboarding_save", "research_criteria_generation_context", "commercial_voice_onboarding_status"]) {
      expect(tools.some(tool => tool.name === alias), alias).toBe(false);
    }
    // Every turn of a connector carries this list; keep it bounded. LIF-1622
    // added the CRM automatic sync and test sync tools (about 4,000 characters).
    // LIF-1694 publishes the industry label enum in targeting_patch (twice) and
    // setup_patch_draft: about 7,900 characters for 122 labels.
    expect(JSON.stringify(tools).length).toBeLessThan(205_000);
    expect(tools.find(tool => tool.name === "crm_mapping_sources")!.annotations.readOnlyHint).toBe(true);
    expect(tools.find(tool => tool.name === "sending_accounts_deliverability")!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(tools.find(tool => tool.name === "sending_accounts_disconnect")!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
    const resumeCampaigns = tools.find(tool => tool.name === "sending_accounts_resume_campaigns")!;
    expect(resumeCampaigns.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
    expect(resumeCampaigns.description).toContain("Writes commit synchronously");
    expect(resumeCampaigns.inputSchema.required).toContain("body");
    // LIF-1603: switching a mailbox to habitual can let campaigns send through it.
    expect(tools.find(tool => tool.name === "sending_accounts_declare")!.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    const resume = tools.find(tool => tool.name === "sending_accounts_resume")!;
    expect(resume.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
    expect(resume.description).toContain("automatically send to external recipients");
    expect(resume.description).toContain("Does not approve or activate a campaign or release separate sending holds");
    const reviewSettings = tools.find(tool => tool.name === "campaigns_review_settings_patch")!;
    expect(reviewSettings.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
    expect(reviewSettings.description).toContain("automatically send to external recipients");
    expect(reviewSettings.description).toContain("existing pending drafts still require a decision");
    expect(tools.some(tool => tool.name === "notifications_post")).toBe(false);
    const slackConnect = tools.find(tool => tool.name === "notifications_connect")!;
    expect(slackConnect.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
    expect(slackConnect.description).toContain("Supersedes earlier unused pending Slack consent links");
    expect(slackConnect.description).toContain("Does not replace the existing Slack grant");
    expect(tools.find(tool => tool.name === "senders_delete")!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
    expect(tools.find(tool => tool.name === "senders_post")!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
    expect(tools.find(tool => tool.name === "campaigns_activate")!.annotations.destructiveHint).toBe(true);
    expect(tools.find(tool => tool.name === "campaigns_activate")!.annotations.openWorldHint).toBe(true);
    // Selecting a Journey revision also enables new runs of its active Campaigns.
    expect(tools.find(tool => tool.name === "journeys_activate")!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
    expect(tools.find(tool => tool.name === "summary_get")!.annotations.openWorldHint).toBe(false);
    expect(tools.find(tool => tool.name === "next_step")!.annotations.openWorldHint).toBe(false);
    expect(tools.find(tool => tool.name === "sending_accounts_reconnect")!.inputSchema.required).toEqual(["path"]);
  });

  it("exposes destination and route writes independently, without a model-selected operation", () => {
    const tools = getStageMcpTools();
    expect(tools.some(tool => tool.name === "notifications_patch")).toBe(false);
    for (const [name, fields] of [
      ["notifications_destination_upsert", ["channel_id", "channel_name"]],
      ["notifications_route_set", ["notification_type", "destination_ref", "enabled"]],
    ] as const) {
      const tool = tools.find(tool => tool.name === name)!;
      expect(tool).toBeDefined();
      expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
      expect(tool.inputSchema.required).toContain("body");
      expect(tool.inputSchema.properties.body).toMatchObject({ type: "object", required: [...fields], additionalProperties: false });
      expect(Object.keys((tool.inputSchema.properties.body as { properties: object }).properties)).toEqual([...fields]);
      expect(tool.description).toContain("Requires the founder's approval");
    }
  });

  it("preserves notification handlers and the CLI PATCH while fixing each MCP write's scope", async () => {
    const destination = { destination_ref: "44444444-4444-4444-8444-444444444444", channel: "slack" as const,
      address: "C123CHANNEL", name: "review-alerts", active: true, types: ["meeting.booked"] };
    const routed = { ...destination, types: ["meeting.booked", "reply.requires_action"] };
    const upsertNotificationDestination = vi.fn(async () => destination);
    const setNotificationRoute = vi.fn(async () => routed);
    const startSlackConnect = vi.fn(); const sendNotificationTest = vi.fn();
    const app = createApp({ authenticate: async request => request.headers.get("authorization") === "Bearer founder"
      ? { ok: true, session: { userId: "founder", client: {} } } : { ok: false, reason: "invalid_session" },
      getWorkspace: async () => ({ state: "ready_for_connections", workspace, next_action: null }),
      upsertNotificationDestination, setNotificationRoute, startSlackConnect, sendNotificationTest, log: () => {} });
    const dispatch = vi.fn((route: string, init: RequestInit) => Promise.resolve(app.request(route, init)));
    const destinationInput = { channel_id: destination.address, channel_name: destination.name };
    const routeInput = { notification_type: "reply.requires_action", destination_ref: destination.destination_ref, enabled: true };
    for (const [name, operation, body] of [
      ["notifications_destination_upsert", "destination", destinationInput],
      ["notifications_route_set", "route", routeInput],
    ] as const) {
      const denied = await callStageMcpTool(name, { body }, new Request("https://example.test/mcp"), dispatch);
      expect(denied.structuredContent.status).toBe(401);
      const result = await callStageMcpTool(name, { workspace: "example", body }, incoming(), dispatch);
      expect(result.structuredContent).toMatchObject({ status: 200, data: operation === "destination" ? destination : routed });
      const [path, init] = dispatch.mock.calls.at(-1)!;
      expect(path).toBe("/v1/workspace/notifications");
      expect(init.method).toBe("PATCH");
      expect(JSON.parse(String(init.body))).toEqual({ operation, values: body });
      expect(new Headers(init.headers).get("x-lifty-workspace")).toBe("example");
      // The installed CLI keeps its original route and discriminated body.
      const legacy = await app.request(path, { ...init, headers: new Headers(init.headers) });
      expect(legacy.status).toBe(200);
    }
    expect(upsertNotificationDestination).toHaveBeenCalledTimes(2);
    expect(setNotificationRoute).toHaveBeenCalledTimes(2);
    const calls = dispatch.mock.calls.length;
    for (const [name, body] of [
      ["notifications_patch", { operation: "destination", values: destinationInput }],
      ["notifications_destination_upsert", routeInput],
      ["notifications_route_set", destinationInput],
      ["notifications_destination_upsert", { ...destinationInput, operation: "route", values: routeInput }],
      ["notifications_route_set", { ...routeInput, enabled: "true" }],
      ["notifications_route_set", { ...routeInput, workspace: "foreign" }],
    ] as const) expect((await callStageMcpTool(name, { body }, incoming(), dispatch)).isError).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(calls);
    expect(startSlackConnect).not.toHaveBeenCalled();
    expect(sendNotificationTest).not.toHaveBeenCalled();
  });

  it("keeps authentication, current contract, validation and the shared mutation limiter in the owning REST route", async () => {
    const create = vi.fn(async () => ({ created:true, workspace:{...workspace,state:"ready_for_connections"},profile:profileFixture,voice:{version:0} }));
    const auth = vi.fn(async (request: Request) => request.headers.get("authorization") === "Bearer founder"
      ? { ok: true as const, session: { userId: "founder", client: {} } } : { ok: false as const, reason: "invalid_session" as const });
    const app = createApp({ authenticate: auth, listMemberWorkspaces: async()=>({workspaces:[{workspace_ref:workspace.workspace_ref,name:"Example",slug:"example",active:true}]}), businessOperation: create, log: () => {} });
    const dispatch = (route: string, init: RequestInit) => Promise.resolve(app.request(route, init));
    const input = { body: { name: "Example",website_url:null } };
    expect((await callStageMcpTool("business_post", input, new Request("https://example.test/mcp"), dispatch)).structuredContent.status).toBe(401);
    const old = incoming(); old.headers.set("x-lifty-client-contract", "lifty-cli-context.v4");
    expect((await callStageMcpTool("business_post", input, old, dispatch)).isError).toBe(true);
    expect(create).not.toHaveBeenCalled();
    for (let i = 0; i < 10; i++) expect((await callStageMcpTool("business_post", input, incoming(), dispatch)).isError).toBe(false);
    const limited = await callStageMcpTool("business_post", input, incoming(), dispatch);
    expect(limited.structuredContent).toMatchObject({ status: 429, retry_after_seconds: 60 });
    expect(create).toHaveBeenCalledTimes(10);
    expect(auth.mock.calls.at(-1)![0].headers.get("x-lifty-client-contract")).toBe(STAGE_CLIENT_CONTRACT);
  });

  it("keeps pure reads read-only and declares connection reconciliation and CRM maintenance as writes", () => {
    const tools = getStageMcpTools();
    for (const name of ["summary_get", "senders_get", "sending_accounts_get", "next_step", "crm_get", "notifications_get"]) {
      expect(tools.find(tool => tool.name === name)!.annotations, name).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    }
    // GET can persist a connection/reconnection after provider verification.
    expect(stageOperations["sending-accounts"]!.attempt!.readOnly).toBe(false);
    const attempt = tools.find(tool => tool.name === "sending_accounts_attempt")!;
    expect(attempt.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
    // Reconciliation continues an authorized connection; polling must not be
    // described as a fresh founder action after each transient status failure.
    expect(attempt.description).toContain("connection/reconnection the user already requested");
    expect(attempt.description).not.toContain("Requires the founder's approval");
    for (const name of ["crm_mapping_catalog", "crm_mapping_preview", "crm_records", "crm_mapping_context", "crm_client_mapping_context"]) {
      const tool = tools.find(tool => tool.name === name)!;
      expect(tool.annotations, name).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
      expect(tool.description, name).toContain("refresh and replace stored CRM credentials");
      expect(tool.description, name).toContain("synchronous maintenance uses the existing authorization");
      expect(tool.description, name).toContain("does not save mappings or write CRM records");
      expect(tool.description, name).not.toContain("pending receipt");
      expect(tool.description, name).not.toContain("Requires the founder's approval");
    }
    for (const name of ["sending_accounts_connect", "sending_accounts_reconnect", "sending_accounts_disconnect", "campaigns_activate"]) {
      expect(tools.find(tool => tool.name === name)!.description, name).toContain("Requires the founder's approval");
    }
    for (const name of ["summary_get", "senders_get", "sending_accounts_get"]) {
      expect(tools.find(tool => tool.name === name)!.description, name).toMatch(/Read-only/);
    }
    for (const retired of ["sending_accounts_senders", "sending_accounts_signature_save", "sending_accounts_post", "sending_accounts_client_accounts",
      "sending_accounts_client_connect", "sending_accounts_client_connect_status", "sending_accounts_client_email_disconnect",
      "sending_accounts_client_linkedin_status", "sending_accounts_client_linkedin_connect", "sending_accounts_client_linkedin_disconnect"]) {
      expect(tools.some(tool => tool.name === retired), retired).toBe(false);
    }
  });

  it("forwards the common workspace input as the selection header on every stage and never overrides a different one", async () => {
    const seen: (string | null)[] = [];
    const dispatch = vi.fn(async (_route: string, init: RequestInit) => { seen.push(new Headers(init.headers).get("x-lifty-workspace")); return Response.json({}); });
    for (const [name, args] of [["business_get", {}], ["research_schedule_get", {}], ["senders_get", {}],
      ["sending_accounts_pause", { path: { id: "11111111-1111-4111-8111-111111111111" } }]] as const) {
      expect((await callStageMcpTool(name, { ...args, workspace: "acme" }, incoming(), dispatch)).isError, name).toBe(false);
    }
    expect(seen).toEqual(["acme", "acme", "acme", "acme"]);
    const pinned = incoming(); pinned.headers.set("x-lifty-workspace", "acme");
    expect((await callStageMcpTool("senders_get", {}, pinned, dispatch)).isError).toBe(false);
    expect((await callStageMcpTool("senders_get", { workspace: "acme" }, pinned, dispatch)).isError).toBe(false);
    expect(seen.slice(4)).toEqual(["acme", "acme"]);
    expect(dispatch).toHaveBeenCalledTimes(6);
    for (const workspace of ["other", "../acme", ""]) {
      expect((await callStageMcpTool("senders_get", { workspace }, workspace === "other" ? pinned : incoming(), dispatch)).isError, workspace).toBe(true);
    }
    expect(dispatch).toHaveBeenCalledTimes(6);
    // Without any selection the database rule decides; nothing is invented.
    expect((await callStageMcpTool("senders_get", {}, incoming(), dispatch)).isError).toBe(false);
    expect(seen.at(-1)).toBeNull();
  });

  it("refuses retired onboarding aliases without dispatching", async () => {
    const dispatch = vi.fn();
    const result = await callStageMcpTool("research_criteria_onboarding_state", {}, incoming(), dispatch);
    expect(result.isError).toBe(true); expect(result.structuredContent).toMatchObject({error:{code:"UNKNOWN_TOOL"}}); expect(dispatch).not.toHaveBeenCalled();
  });

  it("cannot dispatch a campaign write through a read tool or replace the route, query, or identity", async () => {
    const dispatch = vi.fn(async () => Response.json({ state: "read" }));
    expect((await callStageMcpTool("campaigns_post_read", { body: { scope: "workspace", request: { operation: "activate", payload: {} } } }, incoming(), dispatch)).isError).toBe(true);
    for (const input of [{ route: "/v1/admin" }, { path: { submission_ref: "../summary" } }, { query: { workspace: "foreign" } }]) {
      expect((await callStageMcpTool("targeting_update_status", input, incoming(), dispatch)).isError).toBe(true);
    }
    expect(dispatch).not.toHaveBeenCalled();
    expect((await callStageMcpTool("campaigns_post_read", { body: { channel: "email", request: { operation: "placement-preview", payload: {} } } }, incoming(), dispatch)).isError).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("returns a run receipt immediately and makes progress a separate read", async () => {
    const start = vi.fn(async () => ({ state: "queued" as const, run_ref: "11111111-1111-4111-8111-111111111111", requested_leads: 5, workspace, created: true }));
    const enqueue = vi.fn(async () => ({ id: "job" }));
    const read = vi.fn();
    const app = createApp({ authenticate: async () => ({ ok: true, session: { userId: "founder", client: {} } }),
      getWorkspace: async () => ({ state: "ready_for_connections", workspace, next_action: null }),
      startRun: start, enqueueFirstRun: enqueue, getRunStatus: read, log: () => {} });
    const result = await callStageMcpTool("sample_review_post", { body: {} }, incoming(), (route, init) => Promise.resolve(app.request(route, init)));
    expect(result.structuredContent).toMatchObject({ status: 200, data: { state: "queued", run_ref: "11111111-1111-4111-8111-111111111111" } });
    expect(enqueue).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
    expect(getStageMcpTools().find(tool => tool.name === "sample_review_progress")!.annotations.readOnlyHint).toBe(true);
  });

  it("disconnects only the current workspace through the existing handlers", async () => {
    const other = "33333333-3333-4333-8333-333333333333";
    const disconnectIntegration = vi.fn(async (_session: unknown, provider: "hubspot" | "slack") => ({ provider, status: "disconnected" as const,
      portal_id: null, disconnected_at: "2026-09-28T00:00:00Z", workspace, revocation_ref: null }));
    const identity = vi.fn(async (_session: unknown, _key: string, input: { path: Record<string, string> }) => ({ status: 202 as const, body: { workspace: { ...workspace, state: "ready_for_connections" },
      account: { id: input.path.id } } }));
    const app = createApp({ authenticate: async () => ({ ok: true, session: { userId: "founder", client: {} } }),
      getWorkspace: async () => ({ state: "ready_for_connections", workspace, next_action: null }),
      disconnectIntegration, identityOperation: identity, enqueueIntegrationRevocation: vi.fn(), log: () => {} } as never);
    const dispatch = (route: string, init: RequestInit) => Promise.resolve(app.request(route, init));
    const call = (name: string, args: unknown) => callStageMcpTool(name, args, incoming(), dispatch);

    expect((await call("crm_disconnect", { body: {} })).structuredContent).toMatchObject({ status: 200, data: { provider: "hubspot", status: "disconnected" } });
    expect((await call("notifications_disconnect", { body: {} })).structuredContent).toMatchObject({ status: 200, data: { provider: "slack" } });
    expect(disconnectIntegration.mock.calls.map(([, provider]) => provider)).toEqual(["hubspot", "slack"]);
    expect((await call("crm_disconnect", { body: { workspace: other } })).isError).toBe(true);

    const id = "44444444-4444-4444-8444-444444444444";
    expect((await call("sending_accounts_disconnect", { path: { id }, body: { confirm: true } })).structuredContent).toMatchObject({ status: 202, data: { account: { id } } });
    expect(identity).toHaveBeenCalledExactlyOnceWith(expect.anything(), "sending-accounts.disconnect", { path: { id }, query: {}, body: { confirm: true } }, expect.any(AbortSignal));
    for (const args of [{ path: { id }, body: {} }, { path: { id }, body: { confirm: true, channel: "email" } }, { body: { confirm: true } }]) {
      expect((await call("sending_accounts_disconnect", args)).isError).toBe(true);
    }
    expect(identity).toHaveBeenCalledOnce();
  });

  it("retires individual campaign tool aliases without dispatch", async () => {
    const dispatch = vi.fn();
    for (const name of ["campaigns_client_email_read", "campaigns_client_email_write", "campaigns_client_linkedin_write"])
      expect((await callStageMcpTool(name, {}, incoming(), dispatch)).isError).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
