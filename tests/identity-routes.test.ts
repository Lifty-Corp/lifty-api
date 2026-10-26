import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { STAGE_CLIENT_CONTRACT } from "../src/agent-context.js";
import { executeIdentityOperation, type AccountConnector } from "../src/identity-operations.js";
import { operationToolNames } from "../src/operation-names.js";

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
  checked_at: now, observation: { state: "verified" }, connected_at: now, disconnected_at: null, access_revoked_at: null,
  declaration: { mailbox_use: "habitual", declared_by: null, declared_at: now }, sends: { today: 0, last_7_days: 2 }, ...overrides });
const blocked = (id = accountId) => account(id, { status: "disconnected", state: "paused", disconnected_at: now });
const sender = { id: senderId, version: 2, name: "Ana Pérez", signature: null, booking_url: null, accounts: [account()] };
const attempt = (state: string, extra: Record<string, unknown> = {}) => ({ workspace, id: attemptId, sender_id: senderId, channel: "email",
  state, reason: null, account_id: null, declaration: null, expires_at: "2099-01-01T00:00:00Z",
  progress: {stage: state === "pending" ? "verifying" : "complete"}, ...extra });

type Rpc = (name: string, args: Record<string, unknown>) => unknown;
function harness(rpc: Rpc, connector: Partial<AccountConnector> = {}, profile: "full" | "connections" = "full") {
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
  const app = createApp({ runtimeProfile: profile, authenticate: async () => ({ ok: true, session: { userId: "founder", client } }),
    identityOperation: (session, key, input, signal) => executeIdentityOperation(session, key, input, effects, signal, profile), log: () => {} });
  const request = (method: string, path: string, body?: unknown) => app.request(path, { method,
    headers: { authorization: "Bearer session", "x-lifty-client-contract": STAGE_CLIENT_CONTRACT, "x-lifty-workspace": "example", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { request, calls, effects };
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
    expect(await response.json()).toEqual(result);
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
    expect(await response.json()).toEqual(result);
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

  it("publishes sending state, limits and access removal, and still accepts reads without them", async () => {
    const held = account(accountId, { sending: { allowed: false, reason: "paused_by_lift", scope: "account" }, limits: { emails_per_day: 10 }, access_removal: null });
    const linkedin = account(otherAccount, { channel: "linkedin", identity: "https://www.linkedin.com/in/ana", declaration: null,
      sending: { allowed: true, reason: null, scope: null }, limits: { invitations_per_day: 30, messages_per_day: 30, invitations_per_7_days: 25 } });
    for (const accounts of [[held, linkedin], [account()]]) {
      const h = harness(() => ({ workspace, accounts }));
      const response = await h.request("GET", "/v1/workspace/sending-accounts");
      expect(response.status).toBe(200);
      expect((await response.json()).accounts).toEqual(accounts);
    }
    // An unknown reason or a mixed limit shape is not the published contract.
    for (const invalid of [{ sending: { allowed: false, reason: "lift_hold", scope: null } }, { limits: { emails_per_day: 10, messages_per_day: 5 } }]) {
      const h = harness(() => ({ workspace, accounts: [account(accountId, invalid)] }));
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
  // second consent here: warmup and placement never start without it.
  it("points a connected mailbox at its warmup setup, never LinkedIn or the connection profile", async () => {
    const read = async (h: ReturnType<typeof harness>) => (await h.request("GET", `/v1/workspace/sending-accounts/attempts/${attemptId}`)).json();
    const mailbox = await read(harness(() => attempt("connected", { account_id: accountId })));
    expect(mailbox.next_step).toMatchObject({ operation: operationToolNames("sending-accounts", "warmup_start")[0],
      body: { workspace: workspace.workspace_ref, connection_ref: accountId } });
    expect(mailbox.next_step.message).toContain("in the same reply");
    expect(await read(harness(() => attempt("connected", { channel: "linkedin", account_id: accountId })))).not.toHaveProperty("next_step");
    expect(await read(harness(() => attempt("connected", { account_id: accountId }), {}, "connections"))).not.toHaveProperty("next_step");
    expect(await read(harness(() => attempt("failed", { reason: "canceled" })))).not.toHaveProperty("next_step");
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
