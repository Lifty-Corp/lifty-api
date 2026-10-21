import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { STAGE_CLIENT_CONTRACT } from "../src/agent-context.js";
import { CampaignMessageResultSchema, CampaignReviewsSchema } from "../src/outreach-contracts.js";
import fixtures from "./outreach-message-sql-fixtures.json" with { type: "json" };
import reviewFixtures from "./campaign-review-sql-fixtures.json" with { type: "json" };
const source = fixtures.message_original.message;
const body = { request_ref: source.message_ref, source_digest: source.source_digest, expected_review_status: "pending",
  changes: { text: "Corrected saved draft" } };
function harness(receipt: unknown, messageRef = source.message_ref) {
  const rpc = vi.fn(async () => ({ data: receipt, error: null }));
  const app = createApp({ authenticate: async () => ({ ok: true, session: { userId: "founder", client: { rpc } } }), log: () => {} });
  return { rpc, request: (method: string, suffix = "", payload?: unknown) => app.request(`/v1/workspace/campaign-messages/${messageRef}${suffix}`, { method,
    headers: { authorization: "Bearer test", "x-lifty-client-contract": STAGE_CLIENT_CONTRACT, "content-type": "application/json" },
    ...(payload ? { body: JSON.stringify(payload) } : {}), }) };
}
describe("actual unapproved campaign message corrections", () => {
  it("routes exact saved source read and immutable pending replacement through shared RPC", async () => {
    const get = harness(fixtures.message_original);
    expect((await get.request("GET")).status).toBe(200);
    expect(get.rpc).toHaveBeenLastCalledWith("get_lifty_campaign_message", { p_workspace_id: null, p_message_id: source.message_ref });
    const post = harness(fixtures.message_revision);
    expect((await post.request("POST", "/revisions", body)).status).toBe(201);
    expect(post.rpc).toHaveBeenLastCalledWith("revise_lifty_campaign_message", { p_workspace_id: null, p_message_id: source.message_ref, p_payload: body });
  });
  it("cannot confirm unchanged source, foreign parent or missing exact person pin", async () => {
    for (const changes of [{ message_ref: source.message_ref }, { source_message_ref: null }, { sender_version: null }]) {
      const h = harness({ ...fixtures.message_revision, message: { ...fixtures.message_revision.message, ...changes } });
      expect((await h.request("POST", "/revisions", body)).status).toBe(502);
    }
  });
  it("accepts one atomic historical six-step email correction and rejects duplicate positions", async () => {
    const email = fixtures.email_original.message;
    const rpc = vi.fn(async () => ({ data: fixtures.email_revision, error: null }));
    const app = createApp({ authenticate: async () => ({ ok: true, session: { userId: "founder", client: { rpc } } }), log: () => {} });
    const request = (changes: unknown) => app.request(`/v1/workspace/campaign-messages/${email.message_ref}/revisions`, {
      method: "POST", headers: { authorization: "Bearer test", "x-lifty-client-contract": STAGE_CLIENT_CONTRACT, "content-type": "application/json" },
      body: JSON.stringify({ request_ref: email.message_ref, source_digest: email.source_digest, expected_review_status: "pending", changes }),
    });
    expect((await request({ steps: [{ position: 1, text: "Corrected body" }, { position: 6, text: "Corrected final body" }] })).status).toBe(201);
    expect((await request({ steps: [{ position: 6, text: "A" }, { position: 6, text: "B" }] })).status).toBe(422);
    expect(rpc).toHaveBeenCalledOnce();
  });
  it("reads and corrects an email whose later steps reply in the thread without a subject", async () => {
    const thread = <T extends { message: { steps: { position: number; subject: string }[] } }>(receipt: T) => ({ ...receipt, message: { ...receipt.message,
      steps: receipt.message.steps.map(step => step.position === 1 ? step : { ...step, subject: null }) } });
    const email = fixtures.email_original.message;
    const get = harness(thread(fixtures.email_original), email.message_ref);
    const read = await get.request("GET");
    expect(read.status).toBe(200);
    expect((await read.json()).message.steps.map((step: { subject: string | null }) => step.subject).slice(1)).toEqual([null, null, null, null, null]);
    const post = harness(thread(fixtures.email_revision), email.message_ref);
    expect((await post.request("POST", "/revisions", { request_ref: email.message_ref, source_digest: email.source_digest,
      expected_review_status: "pending", changes: { steps: [{ position: 2, text: "Corrected follow-up" }] } })).status).toBe(201);
  });
  it("parses actual SQL LinkedIn and email source/replacement receipts", () => {
    for (const receipt of Object.values(fixtures)) expect(CampaignMessageResultSchema.safeParse(receipt)).toMatchObject({ success: true });
    expect(CampaignReviewsSchema.safeParse(reviewFixtures.queue)).toMatchObject({ success: true });
    for (const receipt of [reviewFixtures.approve, reviewFixtures.skip, reviewFixtures.retry])
      expect(CampaignMessageResultSchema.safeParse(receipt)).toMatchObject({ success: true });
  });
  it("lists saved reviews and records each exact CAS decision through the same Campaign owner", async () => {
    const rpc = vi.fn(async () => ({ data: reviewFixtures.queue, error: null }));
    const app = createApp({ authenticate: async () => ({ ok: true, session: { userId: "founder", client: { rpc } } }), log: () => {} });
    const read = await app.request("/v1/workspace/campaign-reviews?channel=linkedin&limit=10", {
      headers: { authorization: "Bearer test", "x-lifty-client-contract": STAGE_CLIENT_CONTRACT },
    });
    expect(read.status).toBe(200);
    expect(read.headers.get("cache-control")).toBe("no-store");
    expect(rpc).toHaveBeenLastCalledWith("get_lifty_campaign_reviews", { p_workspace_id: null,
      p_query: { channel: "linkedin", limit: 10 } });
    for (const action of ["approve", "retry", "skip"] as const) {
      const receipt = reviewFixtures[action];
      // The SQL skip case creates its draft after the initial queue capture.
      // This is a transport test: SQL proves the actual digest/CAS guard.
      const before = reviewFixtures.queue.messages.find(message => message.message_ref === receipt.message.message_ref)
        ?? { ...receipt.message, review_status: "pending" };
      const decision = { action, source_digest: before.source_digest, expected_review_status: before.review_status,
        ...(action === "skip" ? { reason: "Skip only this action." } : {}) };
      const h = harness(receipt, before.message_ref);
      expect((await h.request("POST", "/review", decision)).status).toBe(200);
      expect(h.rpc).toHaveBeenLastCalledWith("review_lifty_campaign_message", { p_workspace_id: null, p_message_id: before.message_ref, p_payload: decision });
    }
  });
  it("rejects unsafe retry, duplicate selectors and malformed decisions before any database mutation", async () => {
    const h = harness(fixtures.message_original);
    const decision = { action: "approve", source_digest: source.source_digest, expected_review_status: "pending" };
    for (const value of [ { ...decision, action: "retry" }, { ...decision, source_digest: "missing" },
      { ...decision, expected_review_status: "approved" }, { ...decision, action: "skip" }, { ...decision, send: true } ])
      expect((await h.request("POST", "/review", value)).status).toBe(422);
    expect(h.rpc).not.toHaveBeenCalled();
    const app = createApp({ authenticate: async () => ({ ok: true, session: { userId: "founder", client: { rpc: h.rpc } } }), log: () => {} });
    for (const query of ["channel=linkedin&channel=email", "limit=101", "after=not-an-id", "workspace=foreign"]) {
      const response = await app.request(`/v1/workspace/campaign-reviews?${query}`, {
        headers: { authorization: "Bearer test", "x-lifty-client-contract": STAGE_CLIENT_CONTRACT },
      });
      expect(response.status).toBe(400);
    }
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("does not confirm another message, an unrecorded decision or a conversation from another account", async () => {
    const approved = reviewFixtures.approve;
    const before = reviewFixtures.queue.messages.find(message => message.message_ref === approved.message.message_ref)!;
    const decision = { action: "approve", source_digest: before.source_digest, expected_review_status: "pending" };
    for (const changed of [{ message_ref: approved.message.lead_ref }, { review_status: "pending" },
      { account_id: null }, { sender_id: null }, { sender_name: null }]) {
      const h = harness({ ...approved, message: { ...approved.message, ...changed } }, before.message_ref);
      expect((await h.request("POST", "/review", decision)).status).toBe(502);
    }
    const foreignHistory = { ...approved.message, account_id: approved.message.lead_ref, sender_id: approved.message.lead_ref };
    const h = harness({ ...approved, history: [foreignHistory] }, approved.message.message_ref);
    expect((await h.request("GET")).status).toBe(502);
    // The same person's earlier account (before a provider cutover) is the same conversation.
    const earlierAccount = { ...approved.message, account_id: approved.message.lead_ref };
    expect((await harness({ ...approved, history: [earlierAccount] }, approved.message.message_ref).request("GET")).status).toBe(200);
    for (const code of ["OUTREACH_MESSAGE_MOVED", "OUTREACH_SEND_UNCONFIRMED", "OUTREACH_TARGET_STOPPED", "OUTREACH_APPROACH_UNAVAILABLE", "OUTREACH_SENDER_UNAVAILABLE", "OUTREACH_TEMPLATE_UNAVAILABLE"]) {
      const error = Object.assign(new Error(code), { code: "PT409" });
      const rpc = vi.fn(async () => ({ data: null, error }));
      const app = createApp({ authenticate: async () => ({ ok: true, session: { userId: "founder", client: { rpc } } }), log: () => {} });
      const stale = await app.request(`/v1/workspace/campaign-messages/${before.message_ref}/review`, {
        method: "POST", headers: { authorization: "Bearer test", "x-lifty-client-contract": STAGE_CLIENT_CONTRACT, "content-type": "application/json" }, body: JSON.stringify(decision),
      });
      expect(stale.status).toBe(409);
      expect((await stale.json()).error.code).toBe(code);
      expect(rpc).toHaveBeenCalledOnce();
    }
  });
  it("reads both pre-retirement and additive retirement receipts without weakening strict response validation", async () => {
    const oldReceipt = { ...fixtures.message_original, message: { ...source } };
    delete (oldReceipt.message as typeof source & { action_blocked_reason?: string | null }).action_blocked_reason;
    const old = await harness(oldReceipt).request("GET");
    expect(old.status).toBe(200);
    expect((await old.json()).message).not.toHaveProperty("action_blocked_reason");
    for (const reason of [null, "historical_engine_retired"]) {
      const receipt = { ...fixtures.message_original, message: { ...source, action_blocked_reason: reason } };
      const response = await harness(receipt).request("GET");
      expect(response.status).toBe(200);
      expect((await response.json()).message.action_blocked_reason).toBe(reason);
    }
    for (const reason of ["sender_missing", true, {}]) {
      const receipt = { ...fixtures.message_original, message: { ...source, action_blocked_reason: reason } };
      expect((await harness(receipt).request("GET")).status).toBe(502);
    }
  });
  it("reads conversations before and after the database adds copy_source and relays a hand-typed LinkedIn message", async () => {
    const approved = reviewFixtures.approve;
    const typed = { ...approved.message, message_ref: "6f1c2a8e-3b4d-4c5e-9f60-718293a4b5c6", status: "sent", review_status: null,
      is_draft: false, content: "Typed directly in LinkedIn", source_message_ref: null, sender_version: null, review_reason: null,
      action_ref: null, run_ref: null, campaign_ref: null, delivery_state: "confirmed", sent_at: "2026-10-20T10:00:00+00:00",
      copy_source: "manual" };
    const { copy_source: _absent, ...legacy } = typed;
    for (const [item, expected] of [[legacy, undefined], [{ ...typed, copy_source: null }, null], [typed, "manual"]] as const) {
      const response = await harness({ ...approved, history: [item] }, approved.message.message_ref).request("GET");
      expect(response.status).toBe(200);
      const [read] = (await response.json()).history;
      if (expected === undefined) expect(read).not.toHaveProperty("copy_source");
      else expect(read.copy_source).toBe(expected);
    }
    for (const value of ["", 42, {}]) {
      const response = await harness({ ...approved, history: [{ ...typed, copy_source: value }] }, approved.message.message_ref).request("GET");
      expect(response.status).toBe(502);
    }
  });
  it("forwards explicit approval feedback unchanged, including a down rating for edited copy", async () => {
    for (const action of ["approve", "retry"] as const) {
      const receipt = reviewFixtures[action];
      const before = reviewFixtures.queue.messages.find(message => message.message_ref === receipt.message.message_ref)!;
      for (const rating of ["up", "down"]) {
        const decision = { action, source_digest: before.source_digest, expected_review_status: before.review_status,
          feedback: { rating, note: "I changed the opening sentence." } };
        const h = harness(receipt, before.message_ref);
        expect((await h.request("POST", "/review", decision)).status).toBe(200);
        expect(h.rpc).toHaveBeenLastCalledWith("review_lifty_campaign_message", {
          p_workspace_id: null, p_message_id: before.message_ref, p_payload: decision,
        });
      }
    }
    const h = harness(reviewFixtures.approve);
    const decision = { action: "approve", source_digest: source.source_digest, expected_review_status: "pending" };
    for (const feedback of [{ rating: "up" }, { rating: "up", note: "" }, { rating: "up", note: "x".repeat(2001) },
      { rating: "other", note: "Comment" }, { rating: "down", note: "Comment", extra: true }]) {
      expect((await h.request("POST", "/review", { ...decision, feedback })).status).toBe(422);
    }
    expect((await h.request("POST", "/review", { ...decision, action: "skip", reason: "Skip", feedback: { rating: "down", note: "Comment" } })).status).toBe(422);
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("returns a safe retirement conflict for every stale write without exposing provider detail", async () => {
    const error = { code: "PT409", message: "OUTREACH_HISTORICAL_RETIRED", details: "secret provider response" };
    const rpc = vi.fn(async () => ({ data: null, error }));
    const app = createApp({ authenticate: async () => ({ ok: true, session: { userId: "founder", client: { rpc } } }), log: () => {} });
    const write = (suffix: string, payload: unknown) => app.request(`/v1/workspace/campaign-messages/${source.message_ref}${suffix}`, {
      method: "POST", headers: { authorization: "Bearer test", "x-lifty-client-contract": STAGE_CLIENT_CONTRACT, "content-type": "application/json" }, body: JSON.stringify(payload),
    });
    const decision = { source_digest: source.source_digest, expected_review_status: "pending" };
    for (const [suffix, value] of [["/revisions", body], ["/rewrite", { request_ref: source.message_ref, ...decision }],
      ["/review", { action: "approve", ...decision }], ["/review", { action: "retry", ...decision, expected_review_status: "enroll_failed" }],
      ["/review", { action: "skip", reason: "Skip", ...decision }]] as const) {
      const result = await write(suffix, value);
      expect(result.status).toBe(409);
      const response = await result.json();
      expect(response.error.code).toBe("OUTREACH_HISTORICAL_RETIRED");
      expect(response.error.message).toContain("history remains available");
      expect(JSON.stringify(response)).not.toContain(error.details);
    }
    expect(rpc).toHaveBeenCalledTimes(5);
  });

});
