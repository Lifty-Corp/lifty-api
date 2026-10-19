import { getCrmSyncStatus, getNotificationConfig, getRunStatus, getWorkspaceStatus, listSlackNotificationChannels, sendNotificationTest, setNotificationRoute, startCrmSyncRun, startRun, upsertNotificationDestination } from "../src/workspace-operations.js";
import type { NotificationTestRequest } from "../src/trigger-client.js";
import { describe, expect, it, vi } from "vitest";
import { connectedSlack, createdRef, emailRef, notificationsDatabase, ownerEmail, readyWorkspace, slackChannel, slackRef, storedTypes, workspaceRef,
  type NotificationsDatabaseOptions, type StoredDestination } from "./notification-fixtures.js";

describe("workspace RPC operations", () => {
  it("reads status through the authenticated request-scoped client", async () => {
    const expected = {
      state: "ready_for_connections" as const,
      workspace: { workspace_ref: "ws_opaque", name: "Example" },
      next_action: null,
    };
    const client = {
      rpc: async (name: string, args?: unknown) => {
        if (name !== "get_lifty_workspace_status" || args !== undefined) {
          return {
            data: null,
            error: { code: "WRONG_RPC", message: "wrong RPC contract" },
          };
        }
        return { data: expected, error: null };
      },
    };

    await expect(
      getWorkspaceStatus({ userId: "founder-123", client }),
    ).resolves.toEqual(expected);
  });

  it("normalizes a PostgREST single-row array before validating the response", async () => {
    const expected = {
      state: "needs_workspace" as const,
      workspace: null,
      next_action: "provision_workspace" as const,
    };
    const client = {
      rpc: async () => ({ data: [expected], error: null }),
    };

    await expect(
      getWorkspaceStatus({ userId: "founder-123", client }),
    ).resolves.toEqual(expected);
  });

  it("rejects malformed database responses at the control-plane boundary", async () => {
    const client = {
      rpc: async () => ({
        data: { state: "ready_for_connections", private_field: "do-not-forward" },
        error: null,
      }),
    };

    await expect(
      getWorkspaceStatus({ userId: "founder-123", client }),
    ).rejects.toMatchObject({
      status: 502,
      code: "SUPABASE_INVALID_RESPONSE",
    });
  });
});

describe("notification configuration operations", () => {
  const session = (database: ReturnType<typeof notificationsDatabase>) => ({ userId: "founder-123", client: database.client });
  const publishedSlack = { status: "connected", team_id: "T643TEAM", team_name: "Example Robotics", reconnect_required: false };

  it("reads the resolved workspace's configuration and Slack state, publishing only the contract fields", async () => {
    const database = notificationsDatabase({ destinations: [
      { ...ownerEmail(), created_at: "2026-10-15T00:00:00Z" } as StoredDestination,
      { ...slackChannel(), name: null },
    ] });

    await expect(getNotificationConfig(session(database))).resolves.toEqual({
      workspace_ref: workspaceRef,
      slack: publishedSlack,
      types: storedTypes().map(({ code, name, channels, default_on, paused, email_fallback }) => ({ code, name, channels, default_on, paused, email_fallback })),
      destinations: [
        { destination_ref: emailRef, channel: "email", address: null, name: null, active: true, types: ["sending_account.needs_reconnect"] },
        { destination_ref: slackRef, channel: "slack", address: "C643CHANNEL", name: null, active: true, types: ["meeting.booked", "sending_account.needs_reconnect"] },
      ],
    });
    // The workspace UUID is resolved through the session's selection; the
    // notifications functions never see the x-lifty-workspace header.
    expect(database.calls).toEqual([
      { schema: "public", name: "get_lifty_workspace_status" },
      { schema: "notifications", name: "get_configuration", args: { p_workspace_id: workspaceRef } },
      { schema: "public", name: "get_lifty_slack_connection" },
    ]);
    // Empty arrays arrive as JSON null.
    await expect(getNotificationConfig(session(notificationsDatabase({ types: [], destinations: [], slack: { provider: "slack", status: "not_connected" } }))))
      .resolves.toEqual({ workspace_ref: workspaceRef, slack: { status: "not_connected" }, types: [], destinations: [] });
  });

  it("keeps the workspace selection errors and refuses an unusable workspace before the notifications functions", async () => {
    const cases: Array<[NotificationsDatabaseOptions, { status: number; code: string }]> = [
      [{ errors: { "public.get_lifty_workspace_status": { code: "PT409", message: "lifty_workspace_ambiguous" } } }, { status: 409, code: "WORKSPACE_SELECTION_REQUIRED" }],
      [{ errors: { "public.get_lifty_workspace_status": { code: "PT403", message: "lifty_workspace_forbidden" } } }, { status: 403, code: "WORKSPACE_FORBIDDEN" }],
      [{ workspace: { state: "needs_workspace", workspace: null, next_action: "provision_workspace" } }, { status: 409, code: "WORKSPACE_MISSING" }],
      [{ workspace: { ...readyWorkspace, workspace: { workspace_ref: "ws_opaque", name: "Example" } } }, { status: 502, code: "SUPABASE_INVALID_RESPONSE" }],
    ];
    for (const [options, expected] of cases) {
      const database = notificationsDatabase(options);
      await expect(getNotificationConfig(session(database))).rejects.toMatchObject(expected);
      expect(database.calls.some(call => call.schema === "notifications")).toBe(false);
    }
    const forbidden = notificationsDatabase({ errors: { "notifications.get_configuration": { code: "42501", message: "Not allowed to configure this workspace" } } });
    await expect(getNotificationConfig(session(forbidden))).rejects.toMatchObject({ status: 403, code: "WORKSPACE_FORBIDDEN",
      diagnostics: { upstream_operation: "notifications.get_configuration", upstream_code: "42501" } });
    const malformedSlack = notificationsDatabase({ slack: { ...connectedSlack, team_name: "" } });
    await expect(getNotificationConfig(session(malformedSlack))).rejects.toMatchObject({ status: 502, code: "SUPABASE_INVALID_RESPONSE" });
  });

  it("saves a Slack channel only while Slack is usable and returns the destination it re-reads", async () => {
    for (const [slack, code] of [
      [{ provider: "slack", status: "not_connected" }, "SLACK_NOT_CONNECTED"],
      [{ ...connectedSlack, reconnect_required: true }, "SLACK_RECONNECT_REQUIRED"],
    ] as const) {
      const database = notificationsDatabase({ slack });
      await expect(upsertNotificationDestination(session(database), { channel_id: "C643CHANNEL", channel_name: "client-alerts" }))
        .rejects.toMatchObject({ status: 409, code });
      expect(database.calls.some(call => call.name === "save_slack_destination")).toBe(false);
    }

    const database = notificationsDatabase();
    await expect(upsertNotificationDestination(session(database), { channel_id: "G643PRIVATE", channel_name: "founders" })).resolves.toEqual({
      destination_ref: createdRef, channel: "slack", address: "G643PRIVATE", name: "founders", active: true,
      types: ["meeting.booked", "sending_account.needs_reconnect"],
    });
    expect(database.calls.find(call => call.name === "save_slack_destination")).toEqual({ schema: "notifications", name: "save_slack_destination",
      args: { p_workspace_id: workspaceRef, p_channel_id: "G643PRIVATE", p_name: "founders", p_active: true } });

    const invalid = notificationsDatabase({ errors: { "notifications.save_slack_destination": { code: "22023", message: "A Slack destination needs a channel ID" } } });
    await expect(upsertNotificationDestination(session(invalid), { channel_id: "C643CHANNEL", channel_name: "client-alerts" }))
      .rejects.toMatchObject({ status: 400, code: "INVALID_REQUEST" });
  });

  it("checks the destination, type and channel against the configuration before subscribing", async () => {
    const route = (notification_type: string, destination_ref: string, enabled = true) => ({ notification_type, destination_ref, enabled });
    for (const [input, expected] of [
      [route("meeting.booked", "64300000-0000-4000-a000-000000000099"), { status: 404, code: "DESTINATION_NOT_FOUND" }],
      [route("pipeline.deal_won", slackRef), { status: 400, code: "NOTIFICATION_TYPE_UNKNOWN" }],
      [route("meeting.booked", emailRef), { status: 409, code: "NOTIFICATION_CHANNEL_UNSUPPORTED" }],
    ] as const) {
      const database = notificationsDatabase();
      await expect(setNotificationRoute(session(database), input)).rejects.toMatchObject(expected);
      expect(database.calls.some(call => call.name === "set_subscription")).toBe(false);
    }

    // The owner email destination is configurable like any other.
    const database = notificationsDatabase();
    await expect(setNotificationRoute(session(database), route("prospecting.search_low", emailRef))).resolves.toEqual({
      destination_ref: emailRef, channel: "email", address: null, name: null, active: true,
      types: ["prospecting.search_low", "sending_account.needs_reconnect"],
    });
    expect(database.calls.find(call => call.name === "set_subscription")).toEqual({ schema: "notifications", name: "set_subscription",
      args: { p_destination_id: emailRef, p_type_code: "prospecting.search_low", p_subscribed: true } });

    // A change between the check and the write gets the same answer as the check.
    for (const [error, expected] of [
      [{ code: "42501", message: "Not allowed to configure this workspace" }, { status: 404, code: "DESTINATION_NOT_FOUND" }],
      [{ code: "23514", message: "type not available on channel" }, { status: 409, code: "NOTIFICATION_CHANNEL_UNSUPPORTED" }],
      [{ code: "23503", message: "Unknown notification type" }, { status: 400, code: "NOTIFICATION_TYPE_UNKNOWN" }],
    ] as const) {
      const raced = notificationsDatabase({ errors: { "notifications.set_subscription": error } });
      await expect(setNotificationRoute(session(raced), route("meeting.booked", slackRef, false))).rejects.toMatchObject(expected);
    }
  });

  it("queues a test only for this workspace's Slack destination while Slack is usable", async () => {
    const refusals: Array<[string, NotificationsDatabaseOptions, { status: number; code: string }]> = [
      ["64300000-0000-4000-a000-000000000099", {}, { status: 404, code: "DESTINATION_NOT_FOUND" }],
      [emailRef, {}, { status: 409, code: "DESTINATION_NOT_TESTABLE" }],
      [slackRef, { slack: { provider: "slack", status: "not_connected" } }, { status: 409, code: "SLACK_NOT_CONNECTED" }],
      [slackRef, { slack: { ...connectedSlack, reconnect_required: true } }, { status: 409, code: "SLACK_RECONNECT_REQUIRED" }],
    ];
    for (const [destinationRef, options, expected] of refusals) {
      const enqueue = vi.fn(async () => ({ id: "run_test" }));
      await expect(sendNotificationTest(session(notificationsDatabase(options)), destinationRef, enqueue)).rejects.toMatchObject(expected);
      expect(enqueue).not.toHaveBeenCalled();
    }

    // Lifty stopped posting to this channel; a test still checks it.
    const enqueue = vi.fn(async (_request: NotificationTestRequest) => ({ id: "run_test" }));
    const result = await sendNotificationTest(session(notificationsDatabase({ destinations: [ownerEmail(), { ...slackChannel(), active: false }] })), slackRef, enqueue);
    expect(enqueue).toHaveBeenCalledExactlyOnceWith({ workspaceId: workspaceRef, destinationId: slackRef, requestId: result.request_ref });
    expect(result).toEqual({ destination_ref: slackRef, request_ref: expect.stringMatching(/^[0-9a-f-]{36}$/), status: "queued" });
  });

  it("reports a missing Slack grant as a setup step, not a transient failure", async () => {
    const failing = (status: number, body: unknown) => ({ functions: { invoke: async () => ({ data: null,
      error: Object.assign(new Error("Edge Function returned a non-2xx status code"), { context: new Response(JSON.stringify(body), { status }) }) }) } });
    const read = (status: number, body: unknown) => listSlackNotificationChannels({ userId: "founder-123", client: failing(status, body) });
    await expect(read(409, { error: "slack_not_connected" })).rejects.toMatchObject({ status: 409, code: "SLACK_NOT_CONNECTED" });
    await expect(read(409, { error: "slack_reconnect_required" })).rejects.toMatchObject({ status: 409, code: "SLACK_RECONNECT_REQUIRED" });
    await expect(read(500, { error: "channel_list_unavailable" })).rejects.toMatchObject({ status: 502, code: "SLACK_CHANNELS_UNAVAILABLE" });
    // A Response-like object from another fetch implementation is read structurally.
    const foreign = (json: () => Promise<unknown>) => ({ functions: { invoke: async () => ({ data: null, error: Object.assign(new Error("non-2xx"), { context: { status: 409, json } }) }) } });
    await expect(listSlackNotificationChannels({ userId: "founder-123", client: foreign(async () => ({ error: "slack_not_connected" })) })).rejects.toMatchObject({ status: 409, code: "SLACK_NOT_CONNECTED" });
  });

  it("does not report a workspace or Lifty failure as a disconnected Slack", async () => {
    const failing = (status: number, body: unknown) => ({ functions: { invoke: async () => ({ data: null,
      error: Object.assign(new Error("Edge Function returned a non-2xx status code"), { context: new Response(JSON.stringify(body), { status }) }) }) } });
    const read = (status: number, body: unknown) => listSlackNotificationChannels({ userId: "founder-123", client: failing(status, body) });
    await expect(read(409, { error: "workspace_selection_required" })).rejects.toMatchObject({ status: 409, code: "WORKSPACE_SELECTION_REQUIRED" });
    await expect(read(403, { error: "workspace_forbidden" })).rejects.toMatchObject({ status: 403, code: "WORKSPACE_FORBIDDEN" });
    // The function's earlier reasons for a failed config read or credential lookup.
    await expect(read(409, { error: "notification_config_unavailable" })).rejects.toMatchObject({ status: 502, code: "SLACK_CHANNELS_UNAVAILABLE",
      diagnostics: { upstream_operation: "lifty-slack-channels", upstream_code: "notification_config_unavailable" } });
    await expect(read(502, { error: "slack_credential_unavailable" })).rejects.toMatchObject({ status: 502, code: "SLACK_CHANNELS_UNAVAILABLE",
      diagnostics: { upstream_code: "slack_credential_unavailable" } });
    // An unreadable body proves nothing about Slack.
    const unreadable = { functions: { invoke: async () => ({ data: null, error: Object.assign(new Error("non-2xx"), { context: { status: 409, json: async () => { throw new Error("consumed"); } } }) }) } };
    await expect(listSlackNotificationChannels({ userId: "founder-123", client: unreadable })).rejects.toMatchObject({ status: 502, code: "SLACK_CHANNELS_UNAVAILABLE" });
  });

  it("lists Slack channels through the session's edge function call", async () => {
    const calls: unknown[] = [];
    const client = { functions: { invoke: async (name: string, args?: unknown) => {
      calls.push({ name, args });
      return { data: { channels: [{ id: "C643CHANNEL", name: "client-alerts", is_private: false },
        { id: "G643PRIVATE", name: "private-alerts", is_private: true }] }, error: null };
    } } };
    await expect(listSlackNotificationChannels({ userId: "founder-123", client })).resolves.toEqual({
      channels: [{ id: "C643CHANNEL", name: "client-alerts", is_private: false },
        { id: "G643PRIVATE", name: "private-alerts", is_private: true }],
    });
    expect(calls).toEqual([{ name: "lifty-slack-channels", args: { method: "POST" } }]);
  });

  it("maps channel lookup failures to a stable secret-free error", async () => {
    const client = {
      functions: {
        invoke: async () => ({ data: null, error: { message: "xoxb-private-upstream-body" } }),
      },
    };

    await expect(
      listSlackNotificationChannels({ userId: "founder-123", client }),
    ).rejects.toMatchObject({
      status: 502,
      code: "SLACK_CHANNELS_UNAVAILABLE",
      message: "LIFTY could not load Slack channels. Try again in a moment.",
    });
  });
});

describe("first run operations", () => {
  it("starts the run through the authenticated client", async () => {
    const expected = {
      state: "queued" as const,
      run_ref: "22222222-2222-4222-8222-222222222222",
      requested_leads: 5,
      workspace: { workspace_ref: "ws_opaque", name: "Example" },
      created: true,
    };
    const calls: Array<{ name: string; args?: unknown }> = [];
    const client = {
      rpc: async (name: string, args?: unknown) => {
        calls.push({ name, args });
        return { data: expected, error: null };
      },
    };

    await expect(startRun({ userId: "founder-123", client })).resolves.toEqual(expected);
    expect(calls).toEqual([{ name: "start_lifty_run", args: { p_workspace_id: null } }]);
  });

  it.each([
    [{ code: "PT409", message: "RUN_NOT_CONFIGURED" }, { status: 409, code: "RUN_NOT_CONFIGURED" }],
    [{ code: "PT409", message: "RUN_IN_PROGRESS" }, { status: 409, code: "RUN_IN_PROGRESS" }],
    [{ code: "PT409", message: "RESEARCH_LIMIT_REACHED", details: JSON.stringify({ resets_at: "2026-10-05T00:00:00+00:00", internal: "x" }) },
      { status: 409, code: "RESEARCH_LIMIT_REACHED", resets_at: "2026-10-05T00:00:00+00:00" }],
    [{ code: "PT409", message: "lifty_apollo_allowance_exhausted", details: "{\"provider\":\"secret\"}" }, { status: 502, code: "SAMPLE_REVIEW_UNAVAILABLE", resets_at: undefined }],
  ])("maps typed start errors to public codes without internal causes: %j", async (error, expected) => {
    const client = { rpc: async () => ({ data: null, error }) };
    const failure = await startRun({ userId: "founder-123", client }).catch(caught => caught);
    expect(failure).toMatchObject(expected);
    expect(JSON.stringify({ code: failure.code, message: failure.message, resets_at: failure.resets_at })).not.toMatch(/apollo|allowance|secret|internal/i);
  });

  it("builds research links only for verified lead IDs with available workspace research", async () => {
    const lead = {name:"Test",title:null,company:null,linkedin_url:"https://www.linkedin.com/in/test",tier:null,fit_rationale:null,stage:null};
    const id="33333333-3333-4333-8333-333333333333";
    const data={state:"succeeded",run_ref:"run",requested_leads:3,leads_discovered:3,leads_researched:1,error_code:null,started_at:"2026-09-14T00:00:00Z",completed_at:null,reviewed_at:null,workspace:{workspace_ref:"ws",name:"Test"},leads:[{...lead,lead_ref:id,research_available:true},{...lead,lead_ref:id,research_available:false,research_url:"https://wrong.example"},{...lead}]};
    const calls:string[]=[];
    const result=await getRunStatus({userId:"founder",client:{rpc:async(name:string)=>{calls.push(name);return {data,error:null};}}},"https://dashboard.example.com");
    expect(result.state).toBe("succeeded");
    if(result.state!=="none") expect(result.leads?.map(lead=>lead.research_url)).toEqual([`https://dashboard.example.com/protected/leads/${id}`,null,null]);
    expect(calls).toEqual(["get_lifty_run_status"]);
  });

  it("returns the run status through the authenticated client", async () => {
    const expected = {
      state: "running" as const,
      run_ref: "22222222-2222-4222-8222-222222222222",
      requested_leads: 5,
      leads_discovered: 5,
      leads_researched: 2,
      error_code: null,
      started_at: "2026-09-01T21:00:00Z",
      completed_at: null,
      reviewed_at: null,
      workspace: { workspace_ref: "ws_opaque", name: "Example" },
      leads: null,
    };
    const calls: string[] = [];
    const client = {
      rpc: async (name: string) => {
        calls.push(name);
        return { data: expected, error: null };
      },
    };

    await expect(getRunStatus({ userId: "founder-123", client })).resolves.toEqual(expected);
    expect(calls).toEqual(["get_lifty_run_status"]);
  });
});

describe("crm sync RPC operations", () => {
  const startFixture = {
    state: "queued" as const,
    run_ref: "33333333-3333-4333-8333-333333333333",
    requested_leads: 4,
    portal_id: "149239526",
    workspace: { workspace_ref: "ws_opaque", name: "Example" },
    created: true,
  };

  it("starts the sync through the authenticated request-scoped client", async () => {
    const calls: Array<{ name: string; args?: unknown }> = [];
    const client = {
      rpc: async (name: string, args?: unknown) => {
        calls.push({ name, args });
        return { data: startFixture, error: null };
      },
    };

    await expect(
      startCrmSyncRun({ userId: "founder-123", client }),
    ).resolves.toEqual(startFixture);
    expect(calls).toEqual([{ name: "start_lifty_crm_sync_run", args: undefined }]);
  });

  it.each([
    ["PT401", "unauthenticated", 401, "UNAUTHORIZED"],
    ["PT409", "lifty_workspace_missing", 409, "WORKSPACE_MISSING"],
    ["PT409", "lifty_sync_not_connected", 409, "HUBSPOT_NOT_CONNECTED"],
    ["PT409", "lifty_sync_nothing_to_sync", 409, "NOTHING_TO_SYNC"],
    ["PT409", "lifty_sync_run_in_progress", 409, "RUN_IN_PROGRESS"],
    ["PT409", "lifty_sync_workspace_suspended", 409, "WORKSPACE_SUSPENDED"],
    ["XX000", "private internal failure", 502, "SUPABASE_REQUEST_FAILED"],
  ])(
    "maps sync-start %s %s failures to a safe response",
    async (databaseCode, databaseMessage, status, publicCode) => {
      const client = {
        rpc: async () => ({
          data: null,
          error: { code: databaseCode, message: databaseMessage },
        }),
      };

      await expect(
        startCrmSyncRun({ userId: "founder-123", client }),
      ).rejects.toMatchObject({ status, code: publicCode });
    },
  );

  it("reads sync status and rejects unexpected fields at the boundary", async () => {
    const status = {
      state: "succeeded" as const,
      run_ref: "33333333-3333-4333-8333-333333333333",
      requested_leads: 4,
      leads_synced: 4,
      error_code: null,
      portal_id: "149239526",
      started_at: "2026-09-02T14:00:00Z",
      completed_at: "2026-09-02T14:05:00Z",
      workspace: { workspace_ref: "ws_opaque", name: "Example" },
    };
    const okClient = {
      rpc: async () => ({ data: status, error: null }),
    };
    await expect(
      getCrmSyncStatus({ userId: "founder-123", client: okClient }),
    ).resolves.toEqual(status);

    const leakyClient = {
      rpc: async () => ({
        data: { ...status, access_token: "never-forward" },
        error: null,
      }),
    };
    await expect(
      getCrmSyncStatus({ userId: "founder-123", client: leakyClient }),
    ).rejects.toMatchObject({ status: 502, code: "SUPABASE_INVALID_RESPONSE" });
  });
});
