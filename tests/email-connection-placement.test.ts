import { describe, expect, it } from "vitest";
import { createEmailConnectionPlacementOperations, presentConnectionPlacement } from "../src/email-connection-placement.js";
import { createCurrentClient as createApp } from "./current-client.js";

const workspace = "10630000-0000-4000-8000-0000000000a1";
const connection = "10630000-0000-4000-8000-0000000000b1";
const stored = (test: Record<string, unknown> | null = null, extra: Record<string, unknown> = {}) => ({
  workspace_ref: workspace, connection_ref: connection, email: "david@liftygtm.com", provider: "mailivery", method: "connected_mailbox",
  can_request: test === null, blocked_reason: test === null ? null : "email_placement_in_progress",
  last_passed_at: null, passing_until: null, test, ...extra });
const test = (extra: Record<string, unknown>) => ({ placement_ref: "10630000-0000-4000-8000-000000000001", status: "queued", origin: "member", test_ref: null,
  total_seeds: null, requested_at: "2026-10-17T12:00:00.000000+00:00", completed_at: null, passed: null, failure_code: null,
  policy_version: null, samples: null, ...extra });
const samples = { gmail: { total: 10, inbox: 8, spam: 2, missing: 0 }, microsoft: { total: 10, inbox: 3, spam: 5, missing: 2 },
  overall: { total: 30, inbox: 20, spam: 7, missing: 2 } };

describe("connection placement presentation", () => {
  it("reports the measured verdict with counts and never infers one before completion", () => {
    const passed = presentConnectionPlacement(stored(test({ status: "completed", passed: true, test_ref: "9001", total_seeds: 30,
      completed_at: "2026-10-17T12:15:00+00:00", samples, policy_version: "mailivery.connected-mailbox.2026-09-30.v1" }), {
      can_request: false, blocked_reason: "email_placement_recent", last_passed_at: "2026-10-17T12:15:00+00:00", passing_until: "2026-10-27T12:15:00+00:00" }) as never);
    expect(passed.test?.state).toBe("passed");
    expect(passed.test?.label).toBe("Passed. Gmail inbox 80%, Microsoft inbox 30%, spam 23%.");
    expect(passed.blocked_reason?.code).toBe("placement_recent");
    expect(passed.rule).toMatch(/passing placement test from the last 10 days/);
    const running = presentConnectionPlacement(stored(test({ status: "creating" })) as never);
    expect(running.test).toMatchObject({ state: "running", counts: null });
    expect(presentConnectionPlacement(stored(test({ status: "ambiguous" })) as never).test?.state).toBe("uncertain");
    const failed = presentConnectionPlacement(stored(test({ status: "failed", failure_code: "insufficient_credits" })) as never);
    expect(failed.test).toMatchObject({ state: "did_not_run", failure: { code: "insufficient_credits" } });
  });

  it("says when Lifty started the test after warmup and when it tries again", () => {
    const queued = presentConnectionPlacement(stored(test({ origin: "warmup_complete" })) as never);
    expect(queued.test).toMatchObject({ state: "pending", automatic: true,
      label: "Queued automatically because warmup finished. Lifty creates the test in Mailivery within about 5 minutes." });
    const noCredits = presentConnectionPlacement(stored(test({ origin: "warmup_complete", status: "failed", failure_code: "insufficient_credits" })) as never);
    expect(noCredits.test?.failure?.message).toMatch(/Lifty tries the automatic test again within a day\.$/);
    // A test Mailivery may have run is never retried automatically.
    const timedOut = presentConnectionPlacement(stored(test({ origin: "warmup_complete", status: "failed", failure_code: "provider_timeout" })) as never);
    expect(timedOut.test?.failure?.message).not.toMatch(/again within a day/);
    expect(presentConnectionPlacement(stored(test({})) as never).test?.automatic).toBe(false);
  });

  it("reads the test Lifty starts when a habitual mailbox connects (LIF-1223)", async () => {
    const session = { userId: "u", client: { rpc: async () => ({ data: stored(test({ origin: "connected" })), error: null }) } };
    const status = await createEmailConnectionPlacementOperations().status(session as never, { workspace: "lift", connection_ref: connection });
    expect(status.test).toMatchObject({ state: "pending", automatic: true,
      label: "Queued automatically because the mailbox was connected. Lifty creates the test in Mailivery within about 5 minutes." });
  });

  it("reads a weekly refresh through the real RPC boundary", async () => {
    const session = { userId: "u", client: { rpc: async () => ({ data: stored(test({ origin: "recurring" })), error: null }) } };
    const status = await createEmailConnectionPlacementOperations().status(session as never, { workspace: "lift", connection_ref: connection });
    expect(status.test).toMatchObject({ state: "pending", automatic: true,
      label: "Queued automatically for the weekly placement refresh. Lifty creates the test in Mailivery within about 5 minutes." });
  });

  it("maps database refusals to safe public errors and checks the returned connection", async () => {
    const session = (response: { data: unknown; error: unknown }) => ({ userId: "u", client: { rpc: async () => response } });
    const ops = createEmailConnectionPlacementOperations();
    await expect(ops.start(session({ data: null, error: { message: "email_placement_recent" } }) as never,
      { workspace: "lift", connection_ref: connection, subject: "Hi", body: "A short test body", confirm: true }))
      .rejects.toMatchObject({ status: 409, code: "EMAIL_PLACEMENT_RECENT" });
    await expect(ops.status(session({ data: null, error: { message: "raw provider detail" } }) as never, { workspace: "lift" }))
      .rejects.toMatchObject({ status: 502, code: "EMAIL_PLACEMENT_UNAVAILABLE" });
    await expect(ops.status(session({ data: stored(), error: null }) as never, { workspace: "lift", connection_ref: "10630000-0000-4000-8000-0000000000b2" }))
      .rejects.toMatchObject({ code: "EMAIL_PLACEMENT_UNAVAILABLE" });
    expect((await ops.start(session({ data: stored(test({})), error: null }) as never,
      { workspace: "lift", connection_ref: connection, subject: "Hi", body: "A short test body", confirm: true })).test?.state).toBe("pending");
  });
});

describe("connection placement routes", () => {
  it("requires explicit consent before queueing and passes the member's request through", async () => {
    const calls: unknown[][] = [];
    const client = createApp({ authenticate: async () => ({ ok: true, session: { userId: "u", client: {} } }), log: () => {},
      getEmailPlacement: async (...args) => { calls.push(["status", args[1]]); return presentConnectionPlacement(stored() as never); },
      startEmailPlacement: async (...args) => { calls.push(["start", args[1]]); return presentConnectionPlacement(stored(test({})) as never); } });
    const post = (body: unknown) => client.request("/v1/email/placement/start", { method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test" }, body: JSON.stringify(body) });
    const body = { workspace: "lift", connection_ref: connection, subject: "Quick question", body: "Hi David, a short test." };
    expect((await post(body)).status).toBe(400);
    expect((await post({ ...body, confirm: true })).status).toBe(200);
    const read = await client.request(`/v1/email/placement?workspace=lift&connection_ref=${connection}`, { headers: { authorization: "Bearer test" } });
    expect(read.status).toBe(200);
    expect(calls).toEqual([["start", { ...body, confirm: true }], ["status", { workspace: "lift", connection_ref: connection }]]);
  });
});
