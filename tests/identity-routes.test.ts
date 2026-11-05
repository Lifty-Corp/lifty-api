import { readdirSync } from "node:fs";
import type { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, type AppDependencies, type LogEvent } from "../src/app.js";
import { STAGE_CLIENT_CONTRACT } from "../src/agent-context.js";
import { executeIdentityOperation, identityOperationDefinitions, type AccountConnector } from "../src/identity-operations.js";
import { operationToolNames } from "../src/operation-names.js";
import { receipt } from "./senders-fixtures.js";
import * as identity from "../src/identity-contracts.js";
import { ReplyTurnCountsSchema, ReplyTurnsSchema } from "../src/outreach-contracts.js";
import * as controls from "../src/sender-control-contracts.js";

// LIF-1182 Identity HTTP boundary: catalog routes call the documented member
// RPCs with the database-resolved workspace, validate before any write, and
// report provider access removal truthfully (200 confirmed, 202 pending).
const workspace = { workspace_ref: "22222222-2222-4222-8222-222222222222", name: "Example", state: "ready_for_connections" };
const senderId = "33333333-3333-4333-8333-333333333333";
const accountId = "44444444-4444-4444-8444-444444444444";
const otherAccount = "55555555-5555-4555-8555-555555555555";
const attemptId = "66666666-6666-4666-8666-666666666666";
const now = "2026-10-02T12:00:00Z";
const account = (id = accountId, overrides: Record<string, unknown> = {}) => ({
  id, sender_id: senderId, channel: "email", identity: "ana@example.test", status: "connected", state: "active",
  sending: { allowed: true, reason: null, scope: null }, limits: { emails_per_day: 10 },
  checked_at: now, observation: { state: "verified" }, connected_at: now, disconnected_at: null, access_revoked_at: null, access_removal: null,
  declaration: { mailbox_use: "habitual", declared_by: null, declared_at: now }, sends: { today: 0, last_7_days: 2 },
  participation: { status: "sending", cause: "active_journeys" }, ...overrides });
const blocked = (id = accountId) => account(id, { status: "disconnected", state: "paused", disconnected_at: now,
  participation: { status: "not_connected", cause: "disconnected" } });
const sender = { id: senderId, version: 2, name: "Ana Pérez", signature: null, booking_url: null, accounts: [account()] };
const attempt = (state: string, extra: Record<string, unknown> = {}) => ({ workspace, id: attemptId, sender_id: senderId, channel: "email",
  state, reason: null, account_id: null, declaration: null, expires_at: "2099-01-01T00:00:00Z",
  progress: {stage: state === "pending" ? "verifying" : "complete"}, recovery: null, replaced_by: null, provider_hint: null, ...extra });

type Rpc = (name: string, args: Record<string, unknown>) => unknown;
type AppEnqueue = AppDependencies["enqueueHandoffReplies"];
function harness(rpc: Rpc, connector: Partial<AccountConnector> = {}, profile: "full" | "connections" = "full", enqueueHandoffReplies: AppEnqueue = vi.fn(async () => ({ id: "run" }))) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const client = { rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    try { return { data: await rpc(name, args), error: null }; } catch (error) { return { data: null, error }; }
  }) };
  const effects = {
    connectionUrl: vi.fn((channel: string, id: string) => `https://api.lifty.test/connect/${channel}?intent=sealed-${id}`),
    reconcileAttempt: vi.fn(async () => {}),
    revoke: vi.fn(async () => {}),
    ...connector,
  };
  const logged: LogEvent[] = [];
  const app = createApp({ runtimeProfile: profile, authenticate: async () => ({ ok: true, session: { userId: "founder", client } }), enqueueHandoffReplies,
    identityOperation: (session, key, input, signal) => executeIdentityOperation(session, key, input, effects, signal, profile), log: event => { logged.push(event); } });
  const request = (method: string, path: string, body?: unknown) => app.request(path, { method,
    headers: { authorization: "Bearer session", "x-lifty-client-contract": STAGE_CLIENT_CONTRACT, "x-lifty-workspace": "example", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { request, calls, effects, logged, enqueueHandoffReplies };
}
const dbError = (code: string, message: string, details?: unknown) => Object.assign(new Error(message), { code, message, details: details === undefined ? null : JSON.stringify(details) });

describe("Identity member routes", () => {
  it("uses the portable identity contract and preserves unavailable metrics in the connection profile", async () => {
    const connected = account(accountId, { sends: null, sending: { allowed: false, reason: "blocked", scope: null }, limits: null });
    const h = harness(name => {
      expect(name).toBe("get_lifty_connection_senders");
      return { workspace, senders: [{ ...sender, accounts: [connected] }] };
    }, {}, "connections");
    const response = await h.request("GET", "/v1/workspace/senders");
    expect(response.status).toBe(200);
    expect((await response.json()).senders[0].accounts[0]).toMatchObject({ sends: null, sending: { allowed: false } });
  });

  it.each(["email", "linkedin"] as const)("starts a %s pilot connection through the bounded member RPC", async (channel) => {
    const h = harness(name => {
      if (name === "connect_lifty_connection_account") return { workspace, id: attemptId, channel, expires_at: "2099-01-01T00:00:00Z", created: true };
      if (name === "get_lifty_sending_account_attempt") return attempt("pending", { channel, progress: { stage: "declaration_required" } });
      throw new Error("Unexpected RPC");
    }, {}, "connections");
    const response = await h.request("POST", "/v1/workspace/sending-accounts/connect", { sender_id: senderId, channel });
    expect(response.status).toBe(200);
    expect((await response.json()).connection_url).toBe(`https://api.lifty.test/connect/${channel}?intent=sealed-${attemptId}`);
    expect(h.calls[0]).toEqual({ name: "connect_lifty_connection_account", args: { p_workspace_id: null, p_payload: { sender_id: senderId, channel } } });
    expect(h.effects.revoke).not.toHaveBeenCalled();
  });

  it("requires confirmation and preserves per-campaign resume outcomes without provider work", async () => {
    const result = { workspace, account: account(accountId, { channel: "linkedin",
      disconnect_pause: { count: 1, can_resume: true } }), resumed: 1,
      results: [{ campaign_ref: senderId, outcome: "resumed", reason: null },
        { campaign_ref: otherAccount, outcome: "blocked", reason: "target_stopped" }] };
    const h = harness(() => result);
    const path = `/v1/workspace/sending-accounts/${accountId}/resume-campaigns`;
    expect((await h.request("POST", path, {})).status).toBe(400);
    expect(h.calls).toEqual([]);
    const response = await h.request("POST", path, { confirm: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject(result);
    expect(h.calls).toEqual([{ name: "resume_lifty_disconnected_campaigns",
      args: { p_workspace_id: null, p_account_id: accountId, p_payload: { confirm: true } } }]);
    expect(h.effects.reconcileAttempt).not.toHaveBeenCalled();
    expect(h.effects.revoke).not.toHaveBeenCalled();
  });

  it("changes a mailbox's use only with an explicit use and confirmation", async () => {
    const result = { workspace, account: account(accountId, { declaration: { mailbox_use: "dedicated", declared_by: senderId, declared_at: now } }) };
    const h = harness(() => result);
    const path = `/v1/workspace/sending-accounts/${accountId}/declare`;
    for (const body of [{ mailbox_use: "dedicated" }, { confirm: true }, { mailbox_use: "outreach", confirm: true }]) {
      expect((await h.request("POST", path, body)).status).toBe(400);
    }
    expect(h.calls).toEqual([]);
    const response = await h.request("POST", path, { mailbox_use: "dedicated", confirm: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject(result);
    expect(h.calls).toEqual([{ name: "declare_lifty_sending_account_use",
      args: { p_workspace_id: null, p_account_id: accountId, p_payload: { mailbox_use: "dedicated", confirm: true } } }]);
    expect(h.effects.reconcileAttempt).not.toHaveBeenCalled();
    expect(h.effects.revoke).not.toHaveBeenCalled();
  });

  it("call the documented RPCs with named arguments and the database-resolved workspace", async () => {
    const h = harness(name => ({
      get_lifty_senders: { workspace, senders: [sender] },
      create_lifty_sender: { workspace, sender: { ...sender, version: 1, accounts: [] } },
      patch_lifty_sender: { workspace, sender, recomposing: 2 },
      get_lifty_sending_accounts: { workspace, accounts: [account()] },
      pause_lifty_sending_account: { workspace, account: account(accountId, { state: "paused" }) },
      resume_lifty_sending_account: { workspace, account: account() },
    } as Record<string, unknown>)[name]);
    expect((await h.request("GET", "/v1/workspace/senders")).status).toBe(200);
    const created = await h.request("POST", "/v1/workspace/senders", { name: "Ana Pérez", signature: "Ana" });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ workspace, sender: { id: senderId, version: 1 } });
    expect(await (await h.request("PATCH", `/v1/workspace/senders/${senderId}`, { expected_version: 2, signature: null })).json()).toMatchObject({ recomposing: 2 });
    expect((await h.request("GET", `/v1/workspace/sending-accounts?sender_id=${senderId}&channel=email`)).status).toBe(200);
    expect(await (await h.request("POST", `/v1/workspace/sending-accounts/${accountId}/pause`)).json()).toMatchObject({ account: { state: "paused", status: "connected" } });
    expect((await h.request("POST", `/v1/workspace/sending-accounts/${accountId}/resume`)).status).toBe(200);
    expect(h.calls).toEqual([
      { name: "get_lifty_senders", args: { p_workspace_id: null } },
      { name: "create_lifty_sender", args: { p_workspace_id: null, p_payload: { name: "Ana Pérez", signature: "Ana" } } },
      { name: "patch_lifty_sender", args: { p_workspace_id: null, p_sender_id: senderId, p_payload: { expected_version: 2, signature: null } } },
      { name: "get_lifty_sending_accounts", args: { p_workspace_id: null, p_query: { sender_id: senderId, channel: "email" } } },
      { name: "pause_lifty_sending_account", args: { p_workspace_id: null, p_account_id: accountId } },
      { name: "resume_lifty_sending_account", args: { p_workspace_id: null, p_account_id: accountId } },
    ]);
    // Reads and usage changes never reach the provider.
    expect(h.effects.reconcileAttempt).not.toHaveBeenCalled();
    expect(h.effects.revoke).not.toHaveBeenCalled();
  });

  it("publishes sending state, limits, participation and access removal", async () => {
    const held = account(accountId, { sending: { allowed: false, reason: "paused_by_lift", scope: "account" }, limits: { emails_per_day: 10 }, access_removal: null,
      participation: { status: "paused", cause: "campaign_paused", waiting_journeys: 3 } });
    const linkedin = account(otherAccount, { channel: "linkedin", identity: "https://www.linkedin.com/in/ana", declaration: null,
      sending: { allowed: true, reason: null, scope: null }, limits: { invitations_per_day: 30, messages_per_day: 30, invitations_per_7_days: 25 },
      participation: { status: "waiting_for_first_lead", cause: "no_lead_yet" } });
    const h = harness(() => ({ workspace, accounts: [held, linkedin] }));
    const response = await h.request("GET", "/v1/workspace/sending-accounts");
    expect(response.status).toBe(200);
    expect((await response.json()).accounts).toMatchObject([held, linkedin]);
    // A missing sending state or participation, an unknown reason, a mixed limit shape or a
    // participation cause of another status is not the published contract.
    const { sending: _sending, ...unpublished } = account();
    const { participation: _participation, ...unreported } = account();
    for (const invalid of [unpublished, unreported, account(accountId, { sending: { allowed: false, reason: "lift_hold", scope: null } }),
      account(accountId, { limits: { emails_per_day: 10, messages_per_day: 5 } }),
      account(accountId, { participation: { status: "sending", cause: "no_lead_yet" } }),
      account(accountId, { participation: { status: "sending", cause: "active_journeys", waiting_journeys: 1 } })]) {
      const h = harness(() => ({ workspace, accounts: [invalid] }));
      expect((await h.request("GET", "/v1/workspace/sending-accounts")).status).toBe(502);
    }
  });

  it("preserves signature input for SQL normalization and accepts its 500-character Unicode result", async () => {
    const raw = "  " + "😀".repeat(498) + "\r\nA  ";
    const normalized = "😀".repeat(498) + "\nA";
    const h = harness(() => ({ workspace, sender: { ...sender, signature: normalized } }));
    const response = await h.request("PATCH", `/v1/workspace/senders/${senderId}`, { expected_version: 1, signature: raw });
    expect(response.status).toBe(200);
    expect((await response.json()).sender.signature).toBe(normalized);
    expect(h.calls).toEqual([{ name: "patch_lifty_sender", args: { p_workspace_id: null, p_sender_id: senderId,
      p_payload: { expected_version: 1, signature: raw } } }]);
  });

  it.each([
    ["POST", "/v1/workspace/senders", { name: "ana@example.test" }, 422, "SENDER_INVALID"],
    ["POST", "/v1/workspace/senders", { name: "LinkedIn" }, 422, "SENDER_INVALID"],
    ["POST", "/v1/workspace/senders", { name: "Ana", timezone: "UTC" }, 422, "SENDER_INVALID"],
    ["PATCH", `/v1/workspace/senders/${senderId}`, { expected_version: 1 }, 422, "SENDER_INVALID"],
    ["PATCH", `/v1/workspace/senders/${senderId}`, { expected_version: 1, booking_url: "http://cal.example/ana" }, 422, "SENDER_INVALID"],
    ["PATCH", "/v1/workspace/senders/not-an-id", { expected_version: 1, name: "Ana" }, 400, "INVALID_REQUEST"],
    ["POST", `/v1/workspace/senders/${senderId}/delete`, { expected_version: 1 }, 400, "INVALID_REQUEST"],
    ["POST", "/v1/workspace/sending-accounts/connect", { sender_id: senderId, channel: "email", account_use: "personal" }, 400, "INVALID_REQUEST"],
    ["POST", "/v1/workspace/sending-accounts/connect", { sender_id: senderId, channel: "linkedin", other_automation: false }, 400, "INVALID_REQUEST"],
    ["POST", "/v1/workspace/sending-accounts/connect", { sender_id: senderId, channel: "email", select_account: true }, 400, "INVALID_REQUEST"],
    ["POST", `/v1/workspace/sending-accounts/${accountId}/disconnect`, {}, 400, "INVALID_REQUEST"],
    ["GET", "/v1/workspace/sending-accounts?channel=sms", undefined, 400, "INVALID_REQUEST"],
  ] as const)("rejects %s %s %j before any database call", async (method, path, body, status, code) => {
    const h = harness(() => { throw new Error("must not be called"); });
    const response = await h.request(method, path, body);
    expect(response.status).toBe(status);
    expect((await response.json()).error.code).toBe(code);
    expect(h.calls).toEqual([]);
  });

  it("maps typed database errors and keeps unknown failures private", async () => {
    const errors: Record<string, Error> = {
      patch_lifty_sender: dbError("PT409", "VERSION_CONFLICT", { current_version: 3 }),
      resume_lifty_sending_account: dbError("PT409", "ACCOUNT_DISCONNECTED"),
      connect_lifty_sending_account: dbError("PT409", "LINKEDIN_ALREADY_CONNECTED"),
      get_lifty_sending_account_attempt: dbError("PT404", "CONNECTION_ATTEMPT_NOT_FOUND"),
      get_lifty_senders: dbError("PT409", "lifty_workspace_ambiguous", { workspaces: [{ workspace_ref: workspace.workspace_ref, name: "Example", slug: "example" }] }),
      get_lifty_sending_accounts: dbError("XX000", "private database detail"),
    };
    const h = harness(name => { throw errors[name]!; });
    const conflict = await h.request("PATCH", `/v1/workspace/senders/${senderId}`, { expected_version: 2, name: "Ana" });
    expect([conflict.status, (await conflict.json()).error]).toMatchObject([409, { code: "VERSION_CONFLICT", current_version: 3 }]);
    expect((await (await h.request("POST", `/v1/workspace/sending-accounts/${accountId}/resume`)).json()).error.code).toBe("ACCOUNT_DISCONNECTED");
    expect((await (await h.request("POST", "/v1/workspace/sending-accounts/connect", { sender_id: senderId, channel: "linkedin" })).json()).error.code).toBe("LINKEDIN_ALREADY_CONNECTED");
    expect((await h.request("GET", `/v1/workspace/sending-accounts/attempts/${attemptId}`)).status).toBe(404);
    const ambiguous = await h.request("GET", "/v1/workspace/senders");
    expect([ambiguous.status, (await ambiguous.json()).error]).toMatchObject([409, { code: "WORKSPACE_SELECTION_REQUIRED", workspaces: [{ slug: "example" }] }]);
    const unknown = await h.request("GET", "/v1/workspace/sending-accounts");
    expect(unknown.status).toBe(502);
    const text = await unknown.text();
    expect(JSON.parse(text).error.code).toBe("IDENTITY_UNAVAILABLE");
    expect(text).not.toContain("private database detail");
    expect(h.effects.connectionUrl).not.toHaveBeenCalled();
  });

  it("returns Lifty's connect link for the durable attempt and never exposes internal fields", async () => {
    const progress = {stage: "declaration_required"};
    const h = harness(name => name === "get_lifty_sending_account_attempt" ? attempt("pending", {progress}) : name === "connect_lifty_sending_account"
      ? { workspace, id: attemptId, channel: "linkedin", expires_at: "2099-01-01T00:00:00Z", created: false }
      : { workspace, id: attemptId, channel: "email", expires_at: "2099-01-01T00:00:00Z", created: true });
    const connected = await h.request("POST", "/v1/workspace/sending-accounts/connect", { sender_id: senderId, channel: "linkedin" });
    expect(await connected.json()).toEqual({ workspace, id: attemptId, expires_at: "2099-01-01T00:00:00Z", created: false,
      connection_url: `https://api.lifty.test/connect/linkedin?intent=sealed-${attemptId}`, progress });
    const reconnect = await h.request("POST", `/v1/workspace/sending-accounts/${accountId}/reconnect`);
    expect((await reconnect.json()).connection_url).toBe(`https://api.lifty.test/connect/email?intent=sealed-${attemptId}`);
    expect(h.calls.map(call => call.args)).toEqual([{ p_workspace_id: null, p_payload: { sender_id: senderId, channel: "linkedin" } },
      { p_workspace_id: null, p_attempt_id: attemptId }, { p_workspace_id: null, p_account_id: accountId },
      { p_workspace_id: null, p_attempt_id: attemptId }]);
  });

  it.each([
    {stage:"preparing"},
    {stage:"sign_in_required"},
  ])("returns durable pre-authorization progress without doing provider work: %j", async progress => {
    const h = harness(name => {
      expect(name).toBe("get_lifty_sending_account_attempt");
      return attempt("pending",{progress});
    });
    const response = await h.request("GET", `/v1/workspace/sending-accounts/attempts/${attemptId}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({state:"pending",progress});
    expect(h.effects.reconcileAttempt).not.toHaveBeenCalled();
    expect(h.calls).toHaveLength(1);
  });

  it("lets only the attempt read finish an authorization, and treats a failed provider check as still pending", async () => {
    let state = "pending";
    const h = harness(() => attempt(state, state === "connected" ? { account_id: accountId } : {}),
      { reconcileAttempt: vi.fn(async () => { state = "connected"; }) });
    expect(await (await h.request("GET", `/v1/workspace/sending-accounts/attempts/${attemptId}`)).json()).toMatchObject({ state: "connected", account_id: accountId });
    expect(h.effects.reconcileAttempt).toHaveBeenCalledExactlyOnceWith("email", attemptId);
    expect(h.calls).toHaveLength(2);
    // A completed attempt is read without provider work.
    expect((await (await h.request("GET", `/v1/workspace/sending-accounts/attempts/${attemptId}`)).json()).state).toBe("connected");
    expect(h.effects.reconcileAttempt).toHaveBeenCalledOnce();

    const unavailable = harness(() => attempt("pending"), { reconcileAttempt: vi.fn(async () => { throw new Error("provider timeout"); }) });
    const response = await unavailable.request("GET", `/v1/workspace/sending-accounts/attempts/${attemptId}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: "pending", reason: null });
  });

  // An agent reports success from this read, so a connected mailbox names its
  // second consent here: warmup and placement never start without it. Then
  // next_step leads to Campaign approval in the same conversation (LIF-1670).
  it("points a connected mailbox at its warmup setup and LinkedIn at next_step, never the connection profile", async () => {
    const read = async (h: ReturnType<typeof harness>) => (await h.request("GET", `/v1/workspace/sending-accounts/attempts/${attemptId}`)).json();
    const mailbox = await read(harness(() => attempt("connected", { account_id: accountId })));
    expect(mailbox.next_step).toMatchObject({ operation: operationToolNames("sending-accounts", "warmup_start")[0],
      body: { workspace: workspace.workspace_ref, connection_ref: accountId } });
    expect(mailbox.next_step.message).toContain("in the same reply");
    expect(mailbox.next_step.message).toMatch(/then call next_step\.$/);
    expect(await read(harness(() => attempt("connected", { channel: "linkedin", account_id: accountId })))).toMatchObject({
      action_owner: "agent", next_step: { operation: operationToolNames("summary", "next_step")[0] } });
    expect(await read(harness(() => attempt("connected", { account_id: accountId }), {}, "connections"))).not.toHaveProperty("next_step");
  });

  // LIF-1629: every client reads the same outcome: who acts next and what is permitted.
  it.each([
    ["an unopened link", attempt("pending", { progress: { stage: "declaration_required" } }), "full",
      { action_owner: "account_owner", actions: ["open_link", "wait", "close", "replace"], connection_url: `https://api.lifty.test/connect/email?intent=sealed-${attemptId}`,
        next_step: { operation: "sending_accounts_attempt", path: { id: attemptId }, query: { wait_seconds: 25 } } }],
    ["a sign-in Lifty is verifying", attempt("pending", { recovery: { state: "active", attempts: 1, checked_at: now, next_at: now } }), "full",
      { action_owner: "lifty", actions: ["wait"], next_step: { operation: "sending_accounts_attempt", query: { wait_seconds: 25 } } }],
    ["a sign-in past its recovery budget", attempt("pending", { recovery: { state: "exhausted", attempts: 8, checked_at: now, next_at: now } }), "full",
      { action_owner: "lifty", actions: ["wait", "close", "replace"] }],
    ["an expired link", attempt("expired", { progress: { stage: "sign_in_required" } }), "full",
      { action_owner: "agent", actions: ["replace"], next_step: { operation: "sending_accounts_replace_attempt", path: { id: attemptId } } }],
    ["a canceled sign-in", attempt("failed", { reason: "canceled" }), "full",
      { action_owner: "agent", actions: ["replace"], next_step: { operation: "sending_accounts_replace_attempt", message: expect.stringContaining("canceled") } }],
    ["a replaced attempt", attempt("failed", { reason: "replaced", replaced_by: otherAccount }), "full",
      { action_owner: "agent", actions: [], next_step: { operation: "sending_accounts_attempt", path: { id: otherAccount } } }],
    ["the connection profile", attempt("pending", { progress: { stage: "sign_in_required" } }), "connections",
      { action_owner: "account_owner", actions: ["open_link", "wait"] }],
  ] as const)("tells who acts next for %s", async (_name, row, profile, expected) => {
    const body = await (await harness(() => row, {}, profile).request("GET", `/v1/workspace/sending-accounts/attempts/${attemptId}`)).json();
    expect(body).toMatchObject(expected);
    if (expected.action_owner !== "account_owner") expect(body).not.toHaveProperty("connection_url");
  });

  it("names no next step a new link could not fix, and none for closed operations in the connection profile", async () => {
    const read = async (h: ReturnType<typeof harness>) => (await h.request("GET", `/v1/workspace/sending-accounts/attempts/${attemptId}`)).json();
    expect(await read(harness(() => attempt("failed", { reason: "account_in_use" })))).toMatchObject({ action_owner: "account_owner", actions: [] });
    expect(await read(harness(() => attempt("failed", { reason: "account_in_use" })))).not.toHaveProperty("next_step");
    expect(await read(harness(() => attempt("failed", { reason: "canceled" }), {}, "connections"))).not.toHaveProperty("next_step");
  });

  it("verifies a received sign-in before replacing, then returns the one successor with its own link", async () => {
    const successor = "77777777-7777-4777-8777-777777777777";
    const h = harness((name, args) => {
      if (name === "replace_lifty_sending_account_attempt") return { workspace, disposition: "replaced", retry_after: null,
        attempt: attempt("failed", { reason: "replaced", replaced_by: successor }),
        successor: { workspace, id: successor, channel: "email", expires_at: "2099-01-01T00:00:00Z", created: true } };
      expect(name).toBe("get_lifty_sending_account_attempt");
      return args.p_attempt_id === successor ? attempt("pending", { id: successor, progress: { stage: "declaration_required" } }) : attempt("pending");
    });
    const response = await h.request("POST", `/v1/workspace/sending-accounts/attempts/${attemptId}/replace`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ workspace, disposition: "replaced", retry_after: null,
      attempt: expect.objectContaining({ reason: "replaced", action_owner: "agent", next_step: expect.objectContaining({ path: { id: successor } }) }),
      successor: { workspace, id: successor, expires_at: "2099-01-01T00:00:00Z", created: true, progress: { stage: "declaration_required" },
        connection_url: `https://api.lifty.test/connect/email?intent=sealed-${successor}` } });
    expect(h.effects.reconcileAttempt).toHaveBeenCalledExactlyOnceWith("email", attemptId);
    expect(h.calls.map(call => call.name)).toEqual(["get_lifty_sending_account_attempt", "get_lifty_sending_account_attempt",
      "replace_lifty_sending_account_attempt", "get_lifty_sending_account_attempt"]);
    expect(h.calls[2]!.args).toEqual({ p_workspace_id: null, p_attempt_id: attemptId });
  });

  it("closes without a successor and keeps a sign-in Lifty can still verify open", async () => {
    const retryAfter = "2026-10-26T12:30:00Z";
    const h = harness(name => name === "close_lifty_sending_account_attempt"
      ? { workspace, disposition: "recovering", retry_after: retryAfter, attempt: attempt("pending", { recovery: { state: "active", attempts: 2, checked_at: now, next_at: now } }), successor: null }
      : attempt("pending"), { reconcileAttempt: vi.fn(async () => { throw new Error("provider timeout"); }) });
    const response = await h.request("POST", `/v1/workspace/sending-accounts/attempts/${attemptId}/close`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ disposition: "recovering", retry_after: retryAfter, successor: null, attempt: { action_owner: "lifty" } });
  });

  it("holds a read with wait_seconds until the attempt changes", async () => {
    let reads = 0;
    const h = harness(() => ++reads === 1 ? attempt("pending", { progress: { stage: "sign_in_required" } }) : attempt("pending", { recovery: { state: "active", attempts: 0, checked_at: null, next_at: now } }),
      { reconcileAttempt: vi.fn(async () => {}) });
    const started = Date.now();
    const body = await (await h.request("GET", `/v1/workspace/sending-accounts/attempts/${attemptId}?wait_seconds=10`)).json();
    expect(body).toMatchObject({ progress: { stage: "verifying" }, action_owner: "lifty" });
    expect(reads).toBe(2);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect((await h.request("GET", `/v1/workspace/sending-accounts/attempts/${attemptId}?wait_seconds=26`)).status).toBe(400);
  });
});

// LIF-1764: a person who is off keeps their accounts and drains their admitted
// leads to a target person; turning them on lets them take new leads again.
describe("sender turn-off and turn-on", () => {
  const target = "77777777-7777-4777-8777-777777777777";
  const leadRef = "88888888-8888-4888-8888-888888888888";
  const sending = { state: "off", off_at: "2026-11-02T12:00:00.123456+00:00", reason: "Ana left the company",
    drain_to_sender_id: target, drain_mode: "unused_channels", leads_remaining: 3 };
  const offSender = { ...sender, version: 3, sending,
    accounts: [account(accountId, { participation: { status: "paused", cause: "sender_off", waiting_journeys: 2 } })] };
  const turnOff = { expected_version: 2, confirm: true, reason: "Ana left the company", drain_to_sender_id: target };
  const drainTarget = { sender_id: senderId, drain_to_sender_id: target, mode: "unused_channels" };

  it("calls the documented RPCs, returns the drain receipt and keeps raw database text private", async () => {
    const drain = { ...drainTarget, outcomes: { moved: 2, closed: 1, waiting_send: 1, error: 1 },
      errors: [{ lead_ref: leadRef, sqlstate: "23505", message: "private database detail" }], remaining: 3 };
    const h = harness(name => ({
      turn_off_lifty_sender: { workspace, sender: offSender, drain },
      turn_on_lifty_sender: { workspace, sender: { ...sender, version: 4 } },
    } as Record<string, unknown>)[name]);
    const off = await h.request("POST", `/v1/workspace/senders/${senderId}/turn-off`, turnOff);
    expect(off.status).toBe(200);
    const text = await off.text();
    expect(JSON.parse(text)).toMatchObject({ workspace, sender: offSender, drain: { ...drain, errors: [{ lead_ref: leadRef, sqlstate: "23505" }] } });
    expect(text).not.toContain("private database detail");
    const on = await h.request("POST", `/v1/workspace/senders/${senderId}/turn-on`, { expected_version: 3, confirm: true });
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({ workspace, sender: { ...sender, version: 4 } });
    expect(h.calls).toEqual([
      { name: "turn_off_lifty_sender", args: { p_workspace_id: null, p_sender_id: senderId, p_payload: turnOff } },
      { name: "turn_on_lifty_sender", args: { p_workspace_id: null, p_sender_id: senderId, p_payload: { expected_version: 3, confirm: true } } },
    ]);
    // Neither disconnects an account nor touches the provider.
    expect(h.effects.revoke).not.toHaveBeenCalled();
    expect(h.effects.reconcileAttempt).not.toHaveBeenCalled();
  });

  it("publishes an off person's sending state and sender_off participation, and nothing new for a person who is on", async () => {
    const response = await harness(() => ({ workspace, senders: [sender, offSender] })).request("GET", "/v1/workspace/senders");
    expect(response.status).toBe(200);
    const read = await response.json();
    expect(read.senders).toMatchObject([sender, offSender]);
    expect(read.senders[0]).not.toHaveProperty("sending");
    // A drain that waits as a whole has no outcomes.
    const waiting = { workspace, sender: offSender, drain: { ...drainTarget, state: "target_unavailable" } };
    const off = await harness(() => waiting).request("POST", `/v1/workspace/senders/${senderId}/turn-off`, turnOff);
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject(waiting);
    for (const invalid of [
      { ...sender, sending: null },
      { ...offSender, sending: { ...sending, state: "on" } },
      { ...offSender, sending: { ...sending, drain_mode: "handoff" } },
      { ...offSender, sending: { ...sending, paused_at: now } },
      { ...sender, accounts: [account(accountId, { participation: { status: "not_connected", cause: "sender_off" } })] },
    ]) {
      expect((await harness(() => ({ workspace, senders: [invalid] })).request("GET", "/v1/workspace/senders")).status).toBe(502);
    }
    const unknownOutcome = { workspace, sender: offSender, drain: { ...drainTarget, outcomes: { failed: 1 }, errors: [], remaining: 0 } };
    expect((await harness(() => unknownOutcome).request("POST", `/v1/workspace/senders/${senderId}/turn-off`, turnOff)).status).toBe(502);
  });

  it.each([
    ["turn-off", { ...turnOff, confirm: false }],
    ["turn-off", { expected_version: 2, confirm: true, reason: "Ana left the company" }],
    ["turn-off", { ...turnOff, reason: "   " }],
    ["turn-off", { ...turnOff, reason: "x".repeat(501) }],
    ["turn-off", { ...turnOff, drain_to_sender_id: "Bruno" }],
    ["turn-off", { ...turnOff, drain_mode: "handoff" }],
    ["turn-off", { ...turnOff, disconnect: true }],
    ["turn-on", { expected_version: 3 }],
    ["turn-on", { expected_version: 3, confirm: true, reason: "back" }],
  ] as const)("rejects %s %j before any database call", async (action, body) => {
    const h = harness(() => { throw new Error("must not be called"); });
    const response = await h.request("POST", `/v1/workspace/senders/${senderId}/${action}`, body);
    expect([response.status, (await response.json()).error.code]).toEqual([400, "INVALID_REQUEST"]);
    expect(h.calls).toEqual([]);
  });

  it.each([
    ["turn-off", { ...turnOff, drain_to_sender_id: senderId }, dbError("PT422", "DRAIN_TARGET_INVALID"), 422, {}],
    ["turn-off", { ...turnOff, drain_mode: "continue" }, dbError("PT409", "DRAIN_MODE_UNAVAILABLE"), 409, {}],
    ["turn-off", turnOff, dbError("PT409", "VERSION_CONFLICT", { current_version: 3 }), 409, { current_version: 3 }],
    ["turn-on", { expected_version: 2, confirm: true }, dbError("PT409", "VERSION_CONFLICT", { current_version: 3 }), 409, { current_version: 3 }],
  ] as const)("maps %s %j to its typed error", async (action, body, error, status, detail) => {
    const h = harness(() => { throw error; });
    const response = await h.request("POST", `/v1/workspace/senders/${senderId}/${action}`, body);
    expect([response.status, (await response.json()).error]).toMatchObject([status, { code: error.message, ...detail }]);
    expect(h.calls).toEqual([{ name: `${action.replace("-", "_")}_lifty_sender`, args: { p_workspace_id: null, p_sender_id: senderId, p_payload: body } }]);
  });
});

describe("account disconnect and sender delete receipts", () => {
  it("returns 200 only after provider evidence confirms access removal", async () => {
    let revoked = false;
    const h = harness(name => name === "disconnect_lifty_sending_account" ? { workspace, account: blocked() }
      : { workspace, accounts: [revoked ? account(accountId, { status: "disconnected", state: "paused", disconnected_at: now, access_revoked_at: now }) : blocked()] },
    { revoke: vi.fn(async () => { revoked = true; }) });
    const response = await h.request("POST", `/v1/workspace/sending-accounts/${accountId}/disconnect`, { confirm: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ workspace, account: { id: accountId, status: "disconnected", state: "paused", access_revoked_at: now } });
    expect(h.calls.map(call => call.name)).toEqual(["disconnect_lifty_sending_account", "get_lifty_sending_accounts"]);
    expect(h.calls[0]!.args).toEqual({ p_workspace_id: null, p_account_id: accountId, p_payload: { confirm: true } });
  });

  it("keeps a truthful 202 with the blocked account when removal is unconfirmed or readback fails", async () => {
    for (const readback of ["unconfirmed", "unreadable"] as const) {
      const h = harness(name => {
        if (name === "disconnect_lifty_sending_account") return { workspace, account: blocked() };
        if (readback === "unreadable") throw dbError("XX000", "storage");
        return { workspace, accounts: [blocked()] };
      }, { revoke: vi.fn(async () => { throw new Error("provider unavailable"); }) });
      const response = await h.request("POST", `/v1/workspace/sending-accounts/${accountId}/disconnect`, { confirm: true });
      expect(response.status, readback).toBe(202);
      expect(await response.json()).toMatchObject({ account: { id: accountId, status: "disconnected", state: "paused", access_revoked_at: null } });
    }
  });

  it("returns 200 without provider work for a previous tool's account Lifty never authorized", async () => {
    const legacy = (id = accountId) => account(id, { status: "disconnected", state: "paused", disconnected_at: now, access_removal: "not_applicable" });
    const disconnect = harness(() => ({ workspace, account: legacy() }));
    expect((await disconnect.request("POST", `/v1/workspace/sending-accounts/${accountId}/disconnect`, { confirm: true })).status).toBe(200);
    expect(disconnect.effects.revoke).not.toHaveBeenCalled();
    expect(disconnect.calls).toHaveLength(1);

    // A deleted sender with one legacy and one Lifty account removes only the Lifty access.
    const removed = account(otherAccount, { status: "disconnected", state: "paused", disconnected_at: now, access_revoked_at: now, access_removal: "confirmed" });
    const h = harness(name => name === "delete_lifty_sender"
      ? { workspace, sender: { id: senderId, version: 3, deleted_at: now }, accounts: [legacy(), { ...blocked(otherAccount), access_removal: "pending" }] }
      : { workspace, accounts: [legacy(), removed] });
    const response = await h.request("POST", `/v1/workspace/senders/${senderId}/delete`, { expected_version: 2, confirm: true });
    expect(response.status).toBe(200);
    expect(vi.mocked(h.effects.revoke).mock.calls[0]![0].map(item => item.id)).toEqual([otherAccount]);
  });

  it("skips provider work when access removal is already confirmed", async () => {
    const h = harness(() => ({ workspace, account: account(accountId, { status: "disconnected", state: "paused", disconnected_at: now, access_revoked_at: now }) }));
    expect((await h.request("POST", `/v1/workspace/sending-accounts/${accountId}/disconnect`, { confirm: true })).status).toBe(200);
    expect(h.effects.revoke).not.toHaveBeenCalled();
    expect(h.calls).toHaveLength(1);
  });

  it("removes access for every blocked account of a deleted sender under one shared deadline", async () => {
    const signals: AbortSignal[] = [];
    const h = harness(name => name === "delete_lifty_sender"
      ? { workspace, sender: { id: senderId, version: 3, deleted_at: now }, accounts: [blocked(), blocked(otherAccount)] }
      : { workspace, accounts: [account(accountId, { status: "disconnected", state: "paused", disconnected_at: now, access_revoked_at: now }), blocked(otherAccount)] },
    { revoke: vi.fn(async (_accounts, signal: AbortSignal) => { signals.push(signal); }) });
    const response = await h.request("POST", `/v1/workspace/senders/${senderId}/delete`, { expected_version: 2, confirm: true });
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.accounts.map((item: { id: string; access_revoked_at: string | null }) => [item.id, item.access_revoked_at])).toEqual([[accountId, now], [otherAccount, null]]);
    expect(h.effects.revoke).toHaveBeenCalledOnce();
    expect(vi.mocked(h.effects.revoke).mock.calls[0]![0].map(item => item.id)).toEqual([accountId, otherAccount]);
    expect(signals[0]!.aborted).toBe(false);
    expect(h.calls.map(call => call.name)).toEqual(["delete_lifty_sender", "get_lifty_sending_accounts"]);
    expect(h.calls[1]!.args).toEqual({ p_workspace_id: null, p_query: { sender_id: senderId } });
  });
});

// LIF-1771 S-11/S-12: the words come from one place. Fixtures are the authentic
// SQL receipts; every expected label is the approved copy, written out here.
describe("participation causes", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-05T18:00:00Z") }); });
  afterEach(() => { vi.useRealTimers(); });
  const read = async (participation: unknown) => {
    const response = await harness(() => ({ workspace, accounts: [account(accountId, { participation })] })).request("GET", "/v1/workspace/sending-accounts");
    return { status: response.status, participation: response.status === 200 ? (await response.json()).accounts[0].participation : null };
  };
  const stopped = (stop: Record<string, unknown>) => ({ ...receipt("participation.stop"), stop: { ...receipt("participation.stop").stop, ...stop } });

  it("reads a member's Lifty stop with its plain reason, review date and estimated since", async () => {
    const { participation } = await read(receipt("participation.stop"));
    const { since, stop: { review_by: reviewBy } } = receipt("participation.stop");
    expect(participation.next_step).toEqual({ label: "Paused by Lifty · deliverability review · we review it by Nov 12", owner: "lifty",
      action: "lifty_review", since, since_estimated: false, review_by: reviewBy });
    expect(participation).toMatchObject({ status: "paused", cause: "paused_by_lift", category: "intentional", waiting_journeys: 0 });
    expect((await read({ ...receipt("participation.stop"), since_estimated: true })).participation.next_step.since_estimated).toBe(true);
  });

  it.each([
    ["deliverability_review", "Paused by Lifty · deliverability review · we review it by Nov 12"],
    ["account_safety", "Paused by Lifty · account safety · we review it by Nov 12"],
    ["provider_risk", "Paused by Lifty · account safety · we review it by Nov 12"],
    ["setup", "Paused by Lifty · setup · we review it by Nov 12"],
    ["cutover", "Paused by Lifty · setup · we review it by Nov 12"],
    ["recorded_before_lif1710", "Paused by Lifty · setup · we review it by Nov 12"],
    ["client_request", "Paused by Lifty · at your request · we review it by Nov 12"],
    ["maintenance", "Paused by Lifty · maintenance · we review it by Nov 12"],
    ["other", "Paused by Lifty · we review it by Nov 12"],
  ])("words a stop for %s", async (reason, label) => {
    expect((await read(stopped({ reason }))).participation.next_step.label).toBe(label);
  });

  it("says under review past the date and hides the date of the every-workspace stop", async () => {
    const overdue = (await read(stopped({ review_by: "2026-11-01T00:00:00Z" }))).participation.next_step;
    expect(overdue).toMatchObject({ label: "Paused by Lifty · deliverability review · under review", review_by: null });
    const everywhere = (await read(stopped({ scope: "all_workspaces", reason: "other" }))).participation.next_step;
    expect(everywhere).toMatchObject({ label: "Paused by Lifty · maintenance", review_by: null });
  });

  it("reads a health hold's reason and keeps a secondary cause below the primary one", async () => {
    expect((await read(receipt("participation.health_hold"))).participation.next_step)
      .toMatchObject({ label: "On hold · too many bounces", owner: "lifty", action: "lifty_review" });
    const { participation } = await read(receipt("participation.also"));
    expect(participation.next_step).toMatchObject({ label: "Reconnect needed", owner: "member", action: "reconnect" });
    const { since } = receipt("participation.also").also[0];
    expect(participation.also).toEqual([{ status: "paused", cause: "paused_by_member", category: "intentional", since,
      next_step: { label: "Paused", owner: "member", action: "resume_account", since, since_estimated: null, review_by: null } }]);
  });

  it("gives a workspace complaint its own label, never a bounce", async () => {
    const hold = { ...receipt("participation.health_hold"), health: { reason: "workspace_complaint" } };
    const { label } = (await read(hold)).participation.next_step;
    expect(label).toBe("On hold · spam complaint in this workspace");
    expect(label).not.toBe((await read({ ...hold, health: { reason: "complaint" } })).participation.next_step.label);
  });

  it("names the sender's pause first and a Lifty stop below it, which only Lifty releases", async () => {
    const paused = receipt("sender.pause").sender;
    const linkedin = paused.accounts.find((item: { channel: string }) => item.channel === "linkedin");
    const { participation } = await read(linkedin.participation);
    expect(participation.next_step).toMatchObject({ label: "Sender paused", owner: "member", action: "resume_sender" });
    expect(participation.also[0].next_step).toMatchObject({ label: "Paused by Lifty", owner: "lifty", action: "lifty_review" });
  });

  it("reads a paused sender's own receipt", async () => {
    expect((await read(receipt("participation.paused_sender"))).participation).toMatchObject({ status: "paused", cause: "sender_paused", category: "intentional", waiting_journeys: 0,
      next_step: { label: "Sender paused", owner: "member", action: "resume_sender" } });
  });

  // A stale check never leads: it sits below whatever the account is doing.
  it("keeps a stale check transient and secondary", async () => {
    const { participation } = await read(receipt("participation.sending_stale"));
    expect(participation.next_step).toMatchObject({ label: "Sending", owner: "none", action: "none" });
    const stale = receipt("participation.stale_also");
    expect(participation.also).toEqual([{ ...stale, next_step: { label: "Connection not verified yet", owner: "lifty", action: "wait", since: stale.since, since_estimated: null, review_by: null } }]);
    expect(stale).toEqual({ status: "not_connected", cause: "unverified", category: "transient", since: stale.since });
  });

  it("keeps older participation readable and every other shape refused", async () => {
    expect((await read({ status: "sending", cause: "active_journeys" })).participation.next_step)
      .toEqual({ label: "Sending", owner: "none", action: "none", since: null, since_estimated: false, review_by: null });
    expect((await read({ status: "not_connected", cause: "needs_reconnect", waiting_journeys: 2, category: "fixable_by_client", since: null, since_estimated: false, also: [] })).status).toBe(200);
    for (const invalid of [
      { ...receipt("participation.stop"), status: "email_not_ready" },
      { ...receipt("participation.health_hold"), status: "paused" },
      { ...receipt("participation.also"), cause: "health_hold", stop: receipt("participation.stop").stop },
      { ...receipt("participation.also"), also: [{ status: "sending", cause: "warming", category: null, since: null }] },
      stopped({ reason: "not_a_reason" }),
      { status: "waiting_for_first_lead", cause: "no_lead_yet", waiting_journeys: 1 },
    ]) expect((await read(invalid)).status, JSON.stringify(invalid)).toBe(502);
  });

  it("never lets a setter, a note or a vendor reach a member", async () => {
    for (const leak of [{ note: "Bounce spike" }, { set_by: receipt("stop.set").stop.set_by }]) expect((await read(stopped(leak))).status).toBe(502);
    const { participation } = await read(receipt("participation.stop"));
    expect(JSON.stringify(participation)).not.toMatch(/set_by|note|unipile|mailivery|smartlead/i);
  });

  it("passes the sender's paused state and the pending-transfer fact through senders", async () => {
    const paused = await harness(() => receipt("sender.pause")).request("POST", `/v1/workspace/senders/${senderId}/resume`, { expected_version: 2, confirm: true });
    expect(paused.status).toBe(200);
    expect((await paused.json()).sender.sending).toEqual({ ...receipt("sender.pause").sender.sending, state: "paused", reason: "Leave" });
  });

  it("passes pending_transfer through with its target and the way back to the handoff", async () => {
    const sending = (body: { senders: { sending?: { state: string; pending_transfer?: unknown } }[] }) => body.senders.flatMap(item => item.sending?.pending_transfer ?? []);
    const roster = await (await harness(() => receipt("sender.pending_transfer")).request("GET", "/v1/workspace/senders")).json();
    expect(sending(roster)).toEqual(sending(receipt("sender.pending_transfer")));
    const [closed, open] = sending(roster) as { handoff_ref: string | null; target_sender_id: string; leads_awaiting_transfer: number }[];
    // An unused_channels retire has no handoff; a continue retire names its own.
    expect(closed).toMatchObject({ handoff_ref: null, leads_awaiting_transfer: 0 });
    expect(open).toMatchObject({ handoff_ref: expect.stringMatching(/^[0-9]+$/), leads_awaiting_transfer: 1, target_sender_id: closed!.target_sender_id });
  });

  it("keeps pending_transfer free of any setter or note", async () => {
    const senders = receipt("sender.pending_transfer").senders as { sending?: { pending_transfer?: Record<string, unknown> } }[];
    const withLeak = (leak: Record<string, unknown>) => ({ ...receipt("sender.pending_transfer"), senders: senders.map(item => item.sending ? { ...item, sending: { ...item.sending,
      pending_transfer: { ...item.sending.pending_transfer, ...leak } } } : item) });
    for (const leak of [{ set_by: "someone" }, { note: "Left" }, { handoff_ref: 1978 }, { target_sender_id: null }])
      expect((await harness(() => withLeak(leak)).request("GET", "/v1/workspace/senders")).status, JSON.stringify(leak)).toBe(502);
  });
});

// LIF-1771 S-01, S-02, S-10: member controls, against the authentic receipts.
describe("sender pause and retire", () => {
  const path = `/v1/workspace/senders/${senderId}`;
  it("pauses and resumes with expected_version through the member RPCs", async () => {
    const h = harness(name => name === "pause_lifty_sender" ? receipt("sender.pause") : receipt("sender.resume"));
    const paused = await h.request("POST", `${path}/pause`, { expected_version: 2, confirm: true, reason: "Leave" });
    expect(paused.status).toBe(200);
    expect((await paused.json()).sender.sending.state).toBe("paused");
    const resumed = await h.request("POST", `${path}/resume`, { expected_version: 3, confirm: true });
    const body = await resumed.json();
    expect(body.sender).not.toHaveProperty("sending");
    // Resume clears the pause and nothing else: the Lifty stop on this account stands.
    expect(body.sender.accounts.find((item: { channel: string }) => item.channel === "linkedin").participation.next_step)
      .toMatchObject({ owner: "lifty", action: "lifty_review" });
    expect(h.calls).toEqual([
      { name: "pause_lifty_sender", args: { p_workspace_id: null, p_sender_id: senderId, p_payload: { expected_version: 2, confirm: true, reason: "Leave" } } },
      { name: "resume_lifty_sender", args: { p_workspace_id: null, p_sender_id: senderId, p_payload: { expected_version: 3, confirm: true } } },
    ]);
  });

  it.each([
    ["pause", { confirm: true }], ["pause", { expected_version: 2 }], ["pause", { expected_version: 2, confirm: true, reason: "  " }],
    ["pause", { expected_version: 2, confirm: true, drain_to_sender_id: senderId }], ["resume", { expected_version: 2, confirm: true, reason: "back" }],
  ])("refuses %s %j before any RPC", async (action, body) => {
    const h = harness(() => { throw new Error("must not call"); });
    expect((await h.request("POST", `${path}/${action}`, body)).status).toBe(400);
    expect(h.calls).toEqual([]);
  });

  it.each([
    ["PT409", "SENDER_OFF", 409], ["PT422", "VERSION_REQUIRED", 422], ["PT409", "VERSION_CONFLICT", 409], ["PT404", "SENDER_NOT_FOUND", 404], ["PT403", "lifty_workspace_forbidden", 403],
  ])("surfaces %s %s as a stable public error", async (sqlstate, code, status) => {
    const response = await harness(() => { throw dbError(sqlstate, code); }).request("POST", `${path}/pause`, { expected_version: 2, confirm: true });
    expect(response.status).toBe(status);
    expect((await response.json()).error.code).toBe(code === "lifty_workspace_forbidden" ? "WORKSPACE_FORBIDDEN" : code);
  });

  it("names a missing, foreign, off or paused target truthfully and changes nothing", async () => {
    const h = harness(() => { throw dbError("PT422", "DRAIN_TARGET_INVALID"); });
    const response = await h.request("POST", `${path}/turn-off`, { expected_version: 2, confirm: true, reason: "Left", drain_to_sender_id: otherAccount });
    expect(response.status).toBe(422);
    expect((await response.json()).error).toMatchObject({ code: "DRAIN_TARGET_INVALID", message: expect.stringMatching(/on, not paused and not deleted.*Nothing changed.*pause the person/) });
    expect(h.calls.map(call => call.name)).toEqual(["turn_off_lifty_sender"]);
    expect(h.enqueueHandoffReplies).not.toHaveBeenCalled();
    // The target stays mandatory.
    expect((await h.request("POST", `${path}/turn-off`, { expected_version: 2, confirm: true, reason: "Left" })).status).toBe(400);
  });

  it("requests the handoff's replies after a retire, and a failed request never fails it", async () => {
    const retire = { expected_version: 2, confirm: true, reason: "Left", drain_to_sender_id: otherAccount };
    const h = harness(() => receipt("sender.retired"));
    const response = await h.request("POST", `${path}/turn-off`, retire);
    expect(response.status).toBe(200);
    const { drain: { handoff_ref: handoffRef }, workspace: { workspace_ref: workspaceId } } = receipt("sender.retired");
    expect((await response.json()).drain).toMatchObject({ handoff_ref: handoffRef, outcomes: { waiting_sample_approval: 1 }, remaining: 1 });
    expect(h.enqueueHandoffReplies).toHaveBeenCalledExactlyOnceWith({ workspaceId, handoffRef, settingsRevision: null });
    const failing = harness(() => receipt("sender.retired"), {}, "full", vi.fn(async () => { throw new Error("Trigger is down"); }));
    expect((await failing.request("POST", `${path}/turn-off`, retire)).status).toBe(200);
    expect(failing.logged).toEqual([expect.objectContaining({ event: "handoff_replies_enqueue_failed", error_code: "HANDOFF_REPLIES_ENQUEUE_FAILED" })]);
  });

  it("requests nothing for a retire with no handoff", async () => {
    const { handoff_ref: _ref, ...drain } = receipt("sender.retired").drain;
    const h = harness(() => ({ ...receipt("sender.retired"), drain }));
    expect((await h.request("POST", `${path}/turn-off`, { expected_version: 2, confirm: true, reason: "Left", drain_to_sender_id: otherAccount })).status).toBe(200);
    expect(h.enqueueHandoffReplies).not.toHaveBeenCalled();
  });
});

// LIF-1771 S-12, S-13, S-18: the database refuses members; these prove the API
// relays that refusal, sends the exact payload and adds no write of its own.
describe("LIFT stops", () => {
  const scope = { scope: "account", account_id: receipt("stop.set").stop.account_id };
  const workspaceRef = receipt("stop.set").workspace.workspace_ref;
  it("sets, lists, moves and releases a stop for an admin, who sees who set it and the note", async () => {
    const h = harness(name => receipt({ set_lifty_stop: "stop.set", get_lifty_stops: "stop.list", move_lifty_stop_review: "stop.move", release_lifty_stop: "stop.release" }[name]!));
    const named = `?workspace_id=${workspaceRef}`;
    const set = { ...scope, reason: "deliverability_review", note: "Bounce spike" };
    const review = { ...scope, review_by: receipt("stop.move").stop.review_by };
    const stopped = await (await h.request("POST", `/v1/workspace/stops${named}`, set)).json();
    expect(stopped.stop).toEqual(receipt("stop.set").stop);
    expect(stopped.stop).toMatchObject({ set_by: expect.any(String), note: "Bounce spike" });
    expect((await (await h.request("GET", `/v1/workspace/stops${named}`)).json()).stops).toHaveLength(1);
    expect((await (await h.request("POST", `/v1/workspace/stops/review${named}`, review)).json()).stop.review_by).toBe(review.review_by);
    expect(await (await h.request("POST", `/v1/workspace/stops/release${named}`, scope)).json()).toMatchObject({ stop: null, released: true });
    expect(h.calls).toEqual([
      { name: "set_lifty_stop", args: { p_workspace_id: workspaceRef, p_payload: set } }, { name: "get_lifty_stops", args: { p_workspace_id: workspaceRef } },
      { name: "move_lifty_stop_review", args: { p_workspace_id: workspaceRef, p_payload: review } }, { name: "release_lifty_stop", args: { p_workspace_id: workspaceRef, p_payload: scope } },
    ]);
  });

  it.each([
    ["GET", "/v1/workspace/stops", undefined], ["POST", "/v1/workspace/stops", { ...scope, reason: "setup" }],
    ["POST", "/v1/workspace/stops/release", scope], ["POST", "/v1/workspace/stops/review", { ...scope, review_by: "2026-11-08T16:52:24Z" }],
  ])("gives a member 403 on %s %s and mutates nothing", async (method, route, body) => {
    const h = harness(() => { throw dbError("PT403", "ADMIN_REQUIRED"); });
    const response = await h.request(method, route, body);
    expect(response.status).toBe(403);
    const { error } = await response.json();
    expect(error.code).toBe("ADMIN_REQUIRED");
    expect(JSON.stringify(error)).not.toMatch(/set_by|note/);
    // One refused RPC: no read of stop facts and no second write around it.
    expect(h.calls).toHaveLength(1);
  });

  it.each([
    [{ scope: "account" }], [{ scope: "account", sender_id: senderId, account_id: accountId }], [{ scope: "channel" }], [{ scope: "workspace", channel: "email" }],
    [{ scope: "all_workspaces" }], [{ scope: "account", account_id: "someone" }],
  ])("refuses the target %j before any RPC", async target => {
    const h = harness(() => { throw new Error("must not call"); });
    expect((await h.request("POST", "/v1/workspace/stops", { ...target, reason: "setup" })).status).toBe(400);
    expect(h.calls).toEqual([]);
  });

  it("refuses a system reason, a bad date and a long note, and relays the database's refusals", async () => {
    const h = harness(() => { throw new Error("must not call"); });
    for (const body of [{ ...scope, reason: "provider_risk" }, { ...scope, reason: "setup", review_by: "next week" }, { ...scope, reason: "setup", note: "x".repeat(1001) }])
      expect((await h.request("POST", "/v1/workspace/stops", body)).status).toBe(400);
    expect(h.calls).toEqual([]);
    const refuse = (code: string, sqlstate: string) => harness(() => { throw dbError(sqlstate, code); }).request("POST", "/v1/workspace/stops/review", { ...scope, review_by: "2026-11-08T16:52:24Z" });
    for (const [code, sqlstate, status] of [["STOP_NOT_FOUND", "PT404", 404], ["STOP_REVIEW_INVALID", "PT422", 422], ["ACCOUNT_NOT_FOUND", "PT404", 404], ["WORKSPACE_SUSPENDED", "PT409", 409]] as const) {
      const response = await refuse(code, sqlstate);
      expect([response.status, (await response.json()).error.code]).toEqual([status, code]);
    }
  });
});

// LIF-1771 S-14: one member read and one validated write.
describe("workspace settings", () => {
  it("reads and writes assignment, sample size and review, and nothing else", async () => {
    const h = harness(name => receipt(name === "get_lifty_workspace_settings" ? "settings.defaults" : "settings.update"));
    const read = await h.request("GET", "/v1/workspace/outreach-settings");
    expect((await read.json()).settings).toEqual(receipt("settings.defaults").settings);
    const change = { expected_version: 0, assignment: { mode: "founder_weight", founder_sender_id: receipt("settings.update").settings.assignment.founder_sender_id }, handoff: { sample_size: 3 } };
    const saved = await h.request("PATCH", "/v1/workspace/outreach-settings", change);
    expect(await saved.json()).toEqual(receipt("settings.update"));
    expect(h.calls[1]).toEqual({ name: "update_lifty_workspace_settings", args: { p_workspace_id: null, p_payload: change } });
  });

  it.each([
    [{ expected_version: 0 }], [{ assignment: { mode: "equal" } }], [{ expected_version: 0, assignment: { mode: "round_robin" } }],
    [{ expected_version: 0, handoff: { sample_size: 0 } }], [{ expected_version: 0, handoff: { sample_size: 101 } }],
    [{ expected_version: 0, recovery_mode: "apply" }], [{ expected_version: 0, auto_reply_enabled: true }],
  ])("refuses %j before any RPC", async body => {
    const h = harness(() => { throw new Error("must not call"); });
    expect((await h.request("PATCH", "/v1/workspace/outreach-settings", body)).status).toBe(422);
    expect(h.calls).toEqual([]);
  });

  it("never reports recovery mode or an automatic-reply switch, even if the database did", async () => {
    const { settings } = receipt("settings.defaults");
    for (const extra of [{ recovery_mode: "report" }, { auto_reply_enabled: true }])
      expect((await harness(() => ({ workspace, settings: { ...settings, ...extra } })).request("GET", "/v1/workspace/outreach-settings")).status).toBe(502);
    expect((await harness(() => ({ workspace, accounts: [account(accountId, { assignment: { mode: "equal" } })] })).request("GET", "/v1/workspace/sending-accounts")).status).toBe(502);
  });

  it.each([
    ["OUTREACH_SETTINGS_MOVED", "PT409", 409], ["ASSIGNMENT_FOUNDER_REQUIRED", "PT422", 422], ["ASSIGNMENT_FOUNDER_INVALID", "PT422", 422], ["WORKSPACE_SUSPENDED", "PT409", 409],
  ])("surfaces %s", async (code, sqlstate, status) => {
    const response = await harness(() => { throw dbError(sqlstate, code); }).request("PATCH", "/v1/workspace/outreach-settings", { expected_version: 0, handoff: { sample_size: 3 } });
    expect([response.status, (await response.json()).error.code]).toEqual([status, code]);
  });
});

// LIF-1771 S-03, S-04, S-05, S-07: the database owns the handoff; the API names
// the workspace, relays every refusal and keeps vendor facts private.
describe("sender handoffs", () => {
  const ready = () => receipt("handoff.ready");
  const heldReply = () => receipt("handoff.held").samples[0];
  const hashes = () => ({ scope_sha256: ready().scope_sha256, settings_sha256: ready().settings_sha256, context_sha256: ready().context_sha256, revision: ready().revision });
  const approval = () => ({ action: "approve_sample_and_transfer", confirm: true, source_sender_id: ready().source_sender_id, replacement_sender_id: ready().replacement.sender_id, ...hashes() });
  const selected = "332ede34-3993-453b-867e-4e9f8387bd89";
  const handoffs = (receiptName: string) => harness(name => name === "get_lifty_workspace_settings"
    ? { ...receipt("settings.defaults"), workspace: { workspace_ref: selected, name: "Example", state: "ready_for_connections" } } : receipt(receiptName));
  const route = (ref = "163") => `/v1/workspace/sender-handoffs/${ref}`;

  it("names the selected workspace, which the database requires, and reports the sample", async () => {
    const h = handoffs("handoff.view");
    const response = await h.request("GET", route("132"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: "preparing", sample_complete: false, preparing_count: 1, held_for_human: 0, members: [{ dispatch_reason: "preparation_pending", prepared: false }] });
    expect(h.calls).toEqual([{ name: "get_lifty_workspace_settings", args: { p_workspace_id: null } },
      { name: "get_lifty_sender_handoff", args: { p_workspace_id: selected, p_drain_ref: "132" } }]);
  });

  it("shows what is held for a person and each member's dispatch reason", async () => {
    const body = await (await handoffs("handoff.held").request("GET", route("154"))).json();
    expect(body).toMatchObject({ held_for_human: 1, cohort_count: 6, sample_count: 5, remainder_count: 1, sample_complete: true });
    expect(body.members.map((member: { dispatch_reason: string | null }) => member.dispatch_reason).sort()).toEqual(["held_for_human", null, null, null, null, null]);
    expect(body.samples[0]).toMatchObject({ kind: "current_reply", body: "Happy to help.\n\nTarget, Lifty", draft_event_ref: heldReply().draft_event_ref, turn_version: heldReply().turn_version });
  });

  it.each(["handoff.view", "handoff.ready", "handoff.held", "handoff.approve", "handoff.cancel", "recovery.handoff.reply"])("keeps vendor facts out of %s", async name => {
    expect(JSON.stringify(receipt(name))).toMatch(/"provider|state_token/);
    const text = await (await handoffs(name).request("GET", route(receipt(name).drain_ref))).text();
    expect(text).not.toMatch(/unipile|"provider|account-|state_token|approved_policy/);
  });

  it("approves with the exact hashes and never calls the result sent", async () => {
    const h = handoffs("handoff.approve");
    const response = await h.request("POST", `${route()}/approve`, approval());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ state: "approved", authorization: { state: "authorized" }, transferred_count: 1, queued_count: 0 });
    expect(JSON.stringify(body)).not.toMatch(/"sent|"delivered/);
    expect(h.calls[1]).toEqual({ name: "approve_lifty_sender_handoff", args: { p_workspace_id: selected, p_drain_ref: "163", p_payload: approval() } });
    // Keyed on the revision, so an approval right after a retire is not collapsed into the retire's request.
    const { workspace_id: workspaceId, drain_ref: handoffRef, settings_revision: settingsRevision } = receipt("handoff.approve");
    expect(h.enqueueHandoffReplies).toHaveBeenCalledExactlyOnceWith({ workspaceId, handoffRef, settingsRevision });
  });

  it("requests replies after prepare and after a settings revision, keyed by what changed", async () => {
    const prepare = handoffs("handoff.ready");
    expect((await prepare.request("POST", `${route()}/prepare`, {})).status).toBe(200);
    expect(prepare.calls[1]).toEqual({ name: "prepare_lifty_sender_handoff", args: { p_workspace_id: selected, p_drain_ref: "163" } });
    expect(prepare.enqueueHandoffReplies).toHaveBeenCalledExactlyOnceWith({ workspaceId: ready().workspace_id, handoffRef: ready().drain_ref, settingsRevision: null });
    const revise = handoffs("handoff.ready");
    const body = { revision: ready().revision, generation_settings: { instructions: "Keep it short." } };
    expect((await revise.request("POST", `${route()}/settings`, body)).status).toBe(200);
    expect(revise.calls[1]).toEqual({ name: "revise_lifty_sender_handoff_settings", args: { p_workspace_id: selected, p_drain_ref: "163", p_payload: body } });
    expect(revise.enqueueHandoffReplies).toHaveBeenCalledExactlyOnceWith({ workspaceId: ready().workspace_id, handoffRef: ready().drain_ref, settingsRevision: 1 });
  });

  it.each([["prepare", "handoff.ready", () => ({})], ["approve", "handoff.approve", approval]] as const)("keeps the member's %s when the request for replies fails", async (action, fixture, body) => {
    const h = harness(name => name === "get_lifty_workspace_settings" ? receipt("settings.defaults") : receipt(fixture), {}, "full", vi.fn(async () => { throw new Error("down"); }));
    expect((await h.request("POST", `${route()}/${action}`, body())).status).toBe(200);
    expect(h.logged[0]).toMatchObject({ event: "handoff_replies_enqueue_failed" });
  });

  it("refuses to cancel an approved handoff with a stable 409, and says so in the catalog", async () => {
    const h = harness(name => { if (name === "get_lifty_workspace_settings") return receipt("settings.defaults"); throw dbError("PT409", "HANDOFF_ALREADY_APPROVED"); });
    const response = await h.request("POST", `${route()}/cancel`, { confirm: true, revision: ready().revision });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatchObject({ code: "HANDOFF_ALREADY_APPROVED", message: expect.stringMatching(/already approved.*Nothing changed/) });
    expect(identityOperationDefinitions.senders.handoff_cancel.description).toMatch(/An approved handoff cannot be canceled: 409 HANDOFF_ALREADY_APPROVED/);
  });

  it("cancels with its revision and edits one reply with its turn version", async () => {
    const cancel = handoffs("handoff.cancel");
    const canceled = await (await cancel.request("POST", `${route("164")}/cancel`, { confirm: true, revision: receipt("handoff.cancel").revision })).json();
    expect(canceled).toMatchObject({ state: "canceled", authorization: { state: "canceled" } });
    const edit = { turn_version: heldReply().turn_version, draft_event_ref: heldReply().draft_event_ref, text: "Happy to help." };
    const reply = handoffs("handoff.held");
    const turn = heldReply().turn_ref;
    expect((await reply.request("POST", `${route("154")}/replies/${turn}`, edit)).status).toBe(200);
    expect(reply.calls[1]).toEqual({ name: "revise_lifty_sender_handoff_reply", args: { p_workspace_id: selected, p_drain_ref: "154", p_turn_id: turn, p_payload: edit } });
  });

  it.each([
    ["approve", { ...approval(), confirm: false }], ["approve", { ...approval(), action: "approve" }], ["approve", { ...approval(), revision: "abc" }], ["approve", { ...approval(), extra: 1 }],
    ["cancel", { revision: ready().revision }], ["settings", { revision: ready().revision, generation_settings: { instructions: "x".repeat(6001) } }],
  ])("refuses %s %j before any RPC", async (action, body) => {
    const h = handoffs("handoff.ready");
    expect((await h.request("POST", `${route()}/${action}`, body)).status).toBe(400);
    expect(h.calls).toEqual([]);
  });

  it.each([
    ["HANDOFF_NOT_FOUND", "PT404", 404], ["HANDOFF_SCOPE_STALE", "PT409", 409], ["HANDOFF_REVISION_STALE", "PT409", 409], ["HANDOFF_CONTEXT_STALE", "PT409", 409],
    ["HANDOFF_SAMPLE_INCOMPLETE", "PT409", 409], ["HANDOFF_CONFIRMATION_REQUIRED", "PT422", 422], ["HANDOFF_REPLY_STALE", "PT409", 409], ["DRAIN_TARGET_INVALID", "PT409", 409],
    ["OUTREACH_SEND_UNCONFIRMED", "PT409", 409], ["OUTREACH_RESOURCE_FORBIDDEN", "PT403", 403], ["OUTREACH_COPY_INVALID", "PT422", 422],
  ])("surfaces %s", async (code, sqlstate, status) => {
    const h = harness(name => { if (name === "get_lifty_workspace_settings") return receipt("settings.defaults"); throw dbError(sqlstate, code); });
    const response = await h.request("POST", `${route()}/approve`, approval());
    expect([response.status, (await response.json()).error.code]).toEqual([status, code]);
  });

  it("gives another workspace's handoff no data, and refuses a member the database refuses", async () => {
    const foreign = harness(name => { if (name === "get_lifty_workspace_settings") return receipt("settings.defaults"); throw dbError("PT404", "HANDOFF_NOT_FOUND"); });
    const response = await foreign.request("GET", route("999"));
    expect(response.status).toBe(404);
    expect(await response.text()).not.toMatch(/lead_ref|samples/);
    expect((await harness(() => { throw new Error("must not call"); }).request("GET", route("not-a-ref"))).status).toBe(400);
  });
});

// LIF-1771 S-06, S-07, S-16.
describe("recovery incidents and notification links", () => {
  it("words each incident from the same causes, and reports no mode or plan detail", async () => {
    const response = await harness(() => receipt("recovery.incidents")).request("GET", "/v1/workspace/recovery-incidents");
    expect(response.status).toBe(200);
    const [incident] = receipt("recovery.incidents").incidents;
    expect((await response.json()).incidents).toEqual([{ ...incident, next_step: { label: "Disconnected", owner: "member", action: "reconnect", since: incident.since, since_estimated: null, review_by: null } }]);
    const leak = { ...receipt("recovery.incidents"), incidents: [{ ...incident, mode: "apply" }] };
    expect((await harness(() => leak).request("GET", "/v1/workspace/recovery-incidents")).status).toBe(502);
  });

  // While report-only the plan is null, and the mode never reaches a member, so
  // the words must hold in both modes: they name the cause and promise no move.
  it.each([
    ["disconnected", "Disconnected", "member", "reconnect"], ["needs_reconnect", "Reconnect needed", "member", "reconnect"],
    ["paused_by_lift", "Paused by Lifty", "lifty", "lifty_review"], ["health_hold", "On hold", "lifty", "lifty_review"],
  ])("never promises a move for %s, reported or applied", async (cause, label, owner, action) => {
    const [incident] = receipt("recovery.incidents").incidents;
    const { counts, moved, handoff_ref: ref } = receipt("recovery.wake.apply");
    const reported = { ...incident, cause, state: "open", counts: null, moved: null };
    for (const item of [reported, { ...reported, state: "applied", counts, moved, handoff_ref: ref }]) {
      const body = await (await harness(() => ({ ...receipt("recovery.incidents"), incidents: [item] })).request("GET", "/v1/workspace/recovery-incidents")).json();
      expect(body.incidents[0]).toMatchObject({ counts: item.counts, moved: item.moved });
      expect(body.incidents[0].next_step).toMatchObject({ label, owner, action });
      expect(JSON.stringify(body.incidents[0].next_step)).not.toMatch(/mov|transfer|automatic|recover|inbox/i);
    }
  });

  it("passes handoff_pending through as a fact, never as a mode", async () => {
    const [incident] = receipt("recovery.incidents").incidents;
    const read = async (item: unknown) => harness(() => ({ ...receipt("recovery.incidents"), incidents: [item] })).request("GET", "/v1/workspace/recovery-incidents");
    const waiting = { ...incident, handoff_ref: receipt("sender.pending_transfer.handoff").handoff_ref, handoff_pending: true };
    const open = (await (await read(waiting)).json()).incidents[0];
    expect(open).toMatchObject({ handoff_pending: true, handoff_ref: waiting.handoff_ref, counts: null, moved: null });
    // The words do not change: a waiting sample says nothing about how recovery runs.
    expect(open.next_step).toEqual((await (await read({ ...waiting, handoff_pending: false })).json()).incidents[0].next_step);
    expect((await read({ ...waiting, handoff_pending: "yes" })).status).toBe(502);
  });

  it("stops asking for a reconnect once the inbox recovered, while its handoff still waits", async () => {
    const [incident] = receipt("recovery.incidents").incidents;
    const recovered = { ...incident, cause: "needs_reconnect", state: "recovered", handoff_ref: receipt("sender.pending_transfer.handoff").handoff_ref, handoff_pending: true };
    const response = await harness(() => ({ ...receipt("recovery.incidents"), incidents: [recovered] })).request("GET", "/v1/workspace/recovery-incidents");
    expect(response.status).toBe(200);
    expect((await response.json()).incidents[0]).toMatchObject({ state: "recovered", handoff_pending: true,
      next_step: { label: "Recovered", owner: "none", action: "none", since: incident.since, since_estimated: null, review_by: null } });
  });

  it("resolves a link to the authorized account and action, and opening it mutates nothing", async () => {
    const lost = account(accountId, { status: "needs_reconnect", participation: { status: "not_connected", cause: "needs_reconnect" } });
    const h = harness(() => ({ workspace, accounts: [lost, account(otherAccount)] }));
    const reconnect = await h.request("GET", `/v1/workspace/sending-accounts/${accountId}/action?action=reconnect`);
    expect(await reconnect.json()).toMatchObject({ account_id: accountId, sender_id: senderId, channel: "email", action: "reconnect", available: true,
      operation: "sending_accounts_reconnect", next_step: { action: "reconnect", owner: "member" } });
    expect((await (await h.request("GET", `/v1/workspace/sending-accounts/${otherAccount}/action?action=reconnect`)).json()).available).toBe(false);
    expect(await (await h.request("GET", `/v1/workspace/sending-accounts/${otherAccount}/action?action=warmup`)).json())
      .toMatchObject({ available: true, operation: "sending_accounts_warmup_start" });
    expect(new Set(h.calls.map(call => call.name))).toEqual(new Set(["get_lifty_sending_accounts"]));
    expect(h.effects.connectionUrl).not.toHaveBeenCalled();
    expect(h.effects.reconcileAttempt).not.toHaveBeenCalled();
  });

  it("offers warmup on no LinkedIn account and fails on another workspace's account", async () => {
    const h = harness(() => ({ workspace, accounts: [account(otherAccount, { channel: "linkedin" })] }));
    expect((await (await h.request("GET", `/v1/workspace/sending-accounts/${otherAccount}/action?action=warmup`)).json()).available).toBe(false);
    const foreign = await h.request("GET", `/v1/workspace/sending-accounts/${accountId}/action?action=reconnect`);
    expect(foreign.status).toBe(404);
    expect((await foreign.json()).error.code).toBe("ACCOUNT_NOT_FOUND");
    expect((await h.request("GET", `/v1/workspace/sending-accounts/${accountId}/action?action=disconnect`)).status).toBe(400);
  });
});

// LIF-1771: what the groups mean is the database's. The API refuses to invent a
// total or to answer for another person.
describe("sender transfer scope", () => {
  const scope = receipt("sender.transfer_scope");
  const route = `/v1/workspace/senders/${scope.sender_id}/transfer-scope`;
  it("reads the groups with the member's session, and reports no total", async () => {
    const h = harness(() => scope);
    const response = await h.request("GET", route);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(scope);
    expect(h.calls).toEqual([{ name: "get_lifty_sender_transfer_scope", args: { p_workspace_id: null, p_sender_id: scope.sender_id } }]);
    expect(h.enqueueHandoffReplies).not.toHaveBeenCalled();
  });
  it("refuses a total, a scope for someone else and replies outside the conversations", async () => {
    for (const wrong of [{ ...scope, total: 7 }, { ...scope, sender_id: senderId }, { ...scope, replies: scope.conversations + 1 }])
      expect((await harness(() => wrong).request("GET", route)).status, JSON.stringify(wrong)).toBe(502);
  });
  it("gives a foreign sender 404 and no data", async () => {
    const response = await harness(() => { throw dbError("PT404", "SENDER_NOT_FOUND"); }).request("GET", route);
    expect(response.status).toBe(404);
    const text = await response.text();
    expect(JSON.parse(text).error.code).toBe("SENDER_NOT_FOUND");
    expect(text).not.toMatch(/not_contacted|conversations/);
    expect((await harness(() => { throw new Error("must not call"); }).request("GET", "/v1/workspace/senders/not-an-id/transfer-scope")).status).toBe(400);
  });
  it("promises no exact outcome in the catalog or the guide", () => {
    const { description } = identityOperationDefinitions.senders.transfer_scope;
    expect(description).toMatch(/estimate/);
    expect(description).toMatch(/assumes the replacement can send email/);
    expect(description).toMatch(/in its receipt/);
    expect(description).toMatch(/Never add the groups/);
  });
});

// LIF-1771: every receipt the API reads, through the strict parser that reads it.
describe("authentic receipts", () => {
  const parsers: Record<string, z.ZodType> = {
    "participation.also": identity.ParticipationSchema, "participation.health_hold": identity.ParticipationSchema, "participation.paused_sender": identity.ParticipationSchema,
    "participation.sending_stale": identity.ParticipationSchema, "participation.stale_also": identity.ParticipationSchema, "participation.stop": identity.ParticipationSchema,
    "sender.pause": identity.SenderResultSchema, "sender.resume": identity.SenderResultSchema, "sender.retired": identity.SenderTurnOffReceiptSchema,
    "sender.pending_transfer": identity.SendersGetSchema, "sender.pending_transfer.handoff": identity.PendingTransferSchema, "sender.transfer_scope": controls.TransferScopeSchema,
    "settings.defaults": controls.WorkspaceSettingsResultSchema, "settings.update": controls.WorkspaceSettingsResultSchema,
    "stop.list": controls.StopsResultSchema, "stop.set": controls.StopResultSchema, "stop.move": controls.StopResultSchema, "stop.release": controls.StopReleaseResultSchema,
    "handoff.view": controls.HandoffSchema, "handoff.ready": controls.HandoffSchema, "handoff.held": controls.HandoffSchema, "handoff.approve": controls.HandoffSchema,
    "handoff.cancel": controls.HandoffSchema, "recovery.handoff.reply": controls.HandoffSchema,
    "recovery.incidents": controls.RecoveryIncidentsSchema,
    "review.page": ReplyTurnsSchema, "review.original": ReplyTurnsSchema, "review.counts": ReplyTurnCountsSchema, "review.counts.sender": ReplyTurnCountsSchema,
  };
  it.each(Object.keys(parsers))("%s", name => {
    expect(parsers[name]!.safeParse(receipt(name)).error?.issues).toBeUndefined();
  });
  it("leaves no fixture without a parser, and every fixture from one Functions head", () => {
    // held.outcome is what Jobs reads, and recovery.wake.apply only supplies an applied incident's values.
    const fixtures = readdirSync(new URL("./fixtures/senders/", import.meta.url)).map(name => name.replace(/\.json$/, ""));
    expect(fixtures.filter(name => !["MANIFEST", "held.outcome", "recovery.wake.apply"].includes(name)).sort()).toEqual(Object.keys(parsers).sort());
    const manifest = receipt("MANIFEST");
    expect(manifest.assertions.not_ok).toBe(0);
    expect(fixtures.filter(name => name !== "MANIFEST").every(name => manifest.receipts.includes(name))).toBe(true);
  });
});
