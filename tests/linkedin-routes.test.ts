import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { STAGE_CLIENT_CONTRACT } from "../src/agent-context.js";
// Captured from public.get_lifty_linkedin in the real local Identity SQL suite.
// It includes two distinct senders and confirmed, attributable event counts.
import receipt from "./linkedin-sql-fixture.json" with { type: "json" };

// LIF-1190 `get linkedin`: the catalog route calls the member RPC with the
// database-resolved workspace, validates the query before any read, and never
// turns an unknown or malformed read into zero activity.
const senderId = receipt.accounts[0]!.sender_id;
const otherSender = "77777777-7777-4777-8777-777777777777";
type Rpc = (name: string, args: Record<string, unknown>) => unknown;
function harness(rpc: Rpc) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const client = { rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    try { return { data: await rpc(name, args), error: null }; } catch (error) { return { data: null, error }; }
  }) };
  const app = createApp({ authenticate: async () => ({ ok: true, session: { userId: "founder", client } }), log: () => {} });
  const read = (query = "") => app.request(`/v1/workspace/linkedin${query}`, {
    headers: { authorization: "Bearer session", "x-lifty-client-contract": STAGE_CLIENT_CONTRACT, "x-lifty-workspace": "example" } });
  return { read, calls };
}
const dbError = (code: string, message: string) => Object.assign(new Error(message), { code, message, details: null });

describe("LinkedIn activity route", () => {
  it("reads every LinkedIn account of the selected workspace, or one sender's, through the documented RPC", async () => {
    const { today, last_7_days } = receipt.accounts[0]!;
    const one = { ...receipt, today, last_7_days, accounts: [receipt.accounts[0]] };
    // A known sender without a LinkedIn account: true zeros, not an unknown read.
    const zero = { invitations_sent: 0, invitations_accepted: 0, messages_sent: 0, replies_received: 0 };
    const none = { ...receipt, today: zero, last_7_days: zero, accounts: [] };
    const h = harness((_name, args) => {
      const sender = (args.p_query as { sender_id?: string }).sender_id;
      return sender === senderId ? one : sender === otherSender ? none : receipt;
    });
    const all = await h.read();
    expect(all.status).toBe(200);
    expect(all.headers.get("cache-control")).toBe("no-store");
    expect(await all.json()).toEqual(receipt);
    expect(await (await h.read(`?sender_id=${senderId}`)).json()).toEqual(one);
    const empty = await h.read(`?sender_id=${otherSender}`);
    expect([empty.status, await empty.json()]).toEqual([200, none]);
    expect(h.calls).toEqual([
      { name: "get_lifty_linkedin", args: { p_workspace_id: null, p_query: {} } },
      { name: "get_lifty_linkedin", args: { p_workspace_id: null, p_query: { sender_id: senderId } } },
      { name: "get_lifty_linkedin", args: { p_workspace_id: null, p_query: { sender_id: otherSender } } },
    ]);
  });

  it.each(["?sender_id=not-an-id", "?channel=linkedin", `?sender_id=${senderId}&sender_id=${senderId}`])(
    "rejects the query %s with repair issues before any read", async query => {
      const h = harness(() => { throw new Error("must not be called"); });
      const response = await h.read(query);
      expect(response.status).toBe(400);
      const { error } = await response.json();
      expect(error.code).toBe("INVALID_REQUEST");
      expect(error.issues.length).toBeGreaterThan(0);
      expect(h.calls).toEqual([]);
    });

  // LIF-1771: each reads as its own reason, so the guide can name the right action.
  it.each(["paused_by_lift", "sender_paused"])("reports %s as its own waiting reason", async reason => {
    const stopped = { ...receipt, accounts: [{ ...receipt.accounts[0], waiting_reason: reason }] };
    const response = await harness(() => stopped).read("");
    expect(response.status).toBe(200);
    expect((await response.json()).accounts[0].waiting_reason).toBe(reason);
  });

  it("returns a generic not-found for an unknown, foreign or deleted sender", async () => {
    const h = harness(() => { throw dbError("PT404", "SENDER_NOT_FOUND"); });
    const response = await h.read(`?sender_id=${senderId}`);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("SENDER_NOT_FOUND");
  });

  it.each<[string, Rpc]>([
    ["a database failure", () => { throw dbError("XX000", "private database detail"); }],
    ["a missing receipt", () => null],
    ["an unpublished field", () => ({ ...receipt, accounts: [{ ...receipt.accounts[0], next_eligible_at: receipt.observed_at }] })],
    ["an unpublished waiting reason", () => ({ ...receipt, accounts: [{ ...receipt.accounts[0], waiting_reason: "send_paused" }] })],
    ["another sender's account", () => receipt],
  ])("reports %s as unavailable, never as zero activity", async (_case, rpc) => {
    const h = harness(rpc);
    const response = await h.read(`?sender_id=${senderId}`);
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(JSON.parse(text).error.code).toBe("LINKEDIN_STATUS_UNAVAILABLE");
    expect(text).not.toMatch(/private database detail|invitations_sent/);
  });
});
