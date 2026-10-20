import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { STAGE_CLIENT_CONTRACT } from "../src/agent-context.js";
import { getStageMcpTools } from "../src/mcp-stage-tools.js";
import { memberReviewOperationDefinitions } from "../src/member-review-operations.js";
import captures from "./campaign-review-sql-fixtures.json" with { type: "json" };
import sql from "./member-review-sql-fixtures.json" with { type: "json" };
import * as contracts from "../src/outreach-contracts.js";
import { memberReviewReceiptMatches } from "../src/member-review-operations.js";

// Transport boundaries are tested independently of the SQL behavioral suites.
// Start with a captured SQL identity; altered receipts exercise fail-closed
// response validation, not simulated database authorization or provider sends.
const message = captures.approve.message;
const workspace = captures.approve.workspace;
const time = "2026-10-06T12:00:00Z";
const settings = { version: 2, linkedin: { mode: "send_and_sample", sample_rate: 20 },
  email: { mode: "approve_each", sample_rate: 10 } };
const settingsBody = { expected_version: 1, linkedin: settings.linkedin };
const rating = { source_digest: message.source_digest, rating: "down", note: "Use a shorter opening.", learning_scope: "voice" };
const sample = { ...message, delivery_state: "confirmed", sent_at: time };
const view = { turnId: message.message_ref, channel: message.channel, version: 1, status: "queued",
  label: "SQL owns this label", cause: null, detail: "SQL owns this detail", actions: [],
  draft: "Happy to help.", approvedText: "Happy to help.", decidedAt: time, sentAt: null, nextAttemptAt: null, overdueAt: time };
const turn = { view, turn_ref: message.message_ref, version: 1, lead_ref: message.lead_ref, channel: message.channel,
  state: "queued", source_digest: message.source_digest, draft: "Happy to help.", account_id: message.account_id,
  sender_id: message.sender_id, sender_name: message.sender_name, lead_name: message.lead_name,
  lead_email: message.lead_email, lead_linkedin_url: message.lead_linkedin_url, campaign_ref: message.campaign_ref,
  inbound_text: "Can you send details?", inbound_at: time, follow_up_due_at: null, created_at: time, sent_at: null,
  history: [{ ...message, account_id: workspace.workspace_ref, sender_id: workspace.workspace_ref }], history_complete: true };
const replyBody = { decision_id: message.message_ref, expected_version: 0, action: "send", text: "Happy to help." };
const decisionReceipt = { workspace, turn, view, outcome: "accepted", dispatch: replyBody.decision_id };
const rewriteBody = { request_ref: message.message_ref, source_digest: message.source_digest, expected_review_status: "pending" };
const rewrite = { ...captures.approve, message: { ...message, review_status: "pending" }, rewrite_work: {
  work_ref: message.message_ref, message_ref: message.message_ref, source_digest: message.source_digest, state: "queued",
  replacement_message_ref: null, error_code: null } };
type Case = { action: keyof typeof memberReviewOperationDefinitions; receipt: unknown; body?: unknown; ref?: string };
const cases: Case[] = [
  { action: "review_settings_get", receipt: { workspace, settings } },
  { action: "review_settings_patch", receipt: { workspace, settings }, body: settingsBody },
  { action: "samples_get", receipt: { workspace, messages: [sample], next_after: null } },
  { action: "message_rating_post", ref: message.message_ref, body: rating,
    receipt: { workspace, feedback: { message_ref: message.message_ref, ...rating, rated_at: time } } },
  { action: "review_count_get", receipt: { workspace, count: 3 } },
  { action: "replies_get", receipt: { workspace, turns: [turn], next_after: null } },
  { action: "reply_get", ref: turn.turn_ref, receipt: { workspace, turn } },
  { action: "reply_review_post", ref: turn.turn_ref, receipt: decisionReceipt, body: replyBody },
  { action: "message_rewrite_post", ref: message.message_ref, receipt: rewrite, body: rewriteBody },
  { action: "lead_stop_post", ref: message.lead_ref, body: { request_ref: message.message_ref, confirm: true },
    receipt: { workspace, lead_ref: message.lead_ref, stopped_at: time, provider_stops_pending: true } },
];
function harness(receipt: unknown) {
  const rpc = vi.fn(async () => ({ data: receipt, error: null }));
  const app = createApp({ authenticate: async () => ({ ok: true, session: { userId: "member", client: { rpc } } }), log: () => {} });
  return { rpc, request: (value: Case, body = value.body) => {
    const definition = memberReviewOperationDefinitions[value.action];
    return app.request(definition.route.replace(/\{[^}]+\}/g, value.ref ?? ""), { method: definition.method,
      headers: { authorization: "Bearer test", "x-lifty-client-contract": STAGE_CLIENT_CONTRACT, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } };
}
describe("member Review transport", () => {
  it("accepts real SQL receipts and their exact recorded write selectors", () => {
    for (const receipt of [sql.settings, sql.settings_changed]) contracts.ReviewSettingsResultSchema.parse(receipt);
    contracts.CampaignReviewsSchema.parse(sql.samples);
    contracts.MessageRatingResultSchema.parse(sql.rating);
    contracts.ReviewCountSchema.parse(sql.count);
    // Historical SQL captures predate the required shared view and must fail closed.
    expect(contracts.ReplyTurnsSchema.safeParse(sql.reply_list).success).toBe(false);
    for (const receipt of [sql.reply, sql.reply_before_send, sql.reply_send, sql.reply_skipped])
      expect(contracts.ReplyTurnResultSchema.safeParse(receipt).success).toBe(false);
    for (const receipt of [sql.email_approve, sql.email_uncertain, sql.rewrite, sql.rewrite_done]) contracts.CampaignMessageResultSchema.parse(receipt);
    contracts.StopLeadOutreachResultSchema.parse(sql.stop);
    for (const [action, request, receipt] of [
      ["review_settings_patch", sql.requests.settings_update, sql.settings_changed],
      ["message_rating_post", sql.requests.rating, sql.rating],
      ["message_rewrite_post", sql.requests.rewrite, sql.rewrite],
      ["lead_stop_post", sql.requests.stop, sql.stop],
    ] as const) {
      const path = request.path as { message_id?: string; turn_id?: string; lead_id?: string };
      expect(memberReviewReceiptMatches(action, { path: {
        ...(path.message_id ? { message_ref: path.message_id } : {}),
        ...(path.turn_id ? { turn_ref: path.turn_id } : {}),
        ...(path.lead_id ? { lead_ref: path.lead_id } : {}),
      }, body: request.body, query: {} }, receipt), action).toBe(true);
    }
    expect(sql.retry.message.review_status).toBe("approved");
    expect(sql.reply_send.turn.draft).toBe(sql.requests.reply_send.body.text);
    expect(sql.reply_skipped.turn.state).toBe("suppressed");
    expect(sql.rewrite_done.rewrite_work.replacement_message_ref).toBeTruthy();
  });
  it("uses the member session and forwards exact selectors through every catalog operation", async () => {
    for (const value of cases) {
      const definition = memberReviewOperationDefinitions[value.action];
      const h = harness(value.receipt);
      const response = await h.request(value);
      expect(response.status, value.action).toBe(definition.success);
      expect(response.headers.get("cache-control"), value.action).toBe("no-store");
      const selector = value.action.startsWith("reply_") ? { p_turn_id: value.ref }
        : value.action.startsWith("message_") ? { p_message_id: value.ref }
          : value.action === "lead_stop_post" ? { p_lead_id: value.ref } : {};
      expect(h.rpc).toHaveBeenCalledExactlyOnceWith(definition.rpc, { p_workspace_id: null, ...selector,
        ...(value.action === "samples_get" || value.action === "replies_get" ? { p_query: {} } : {}),
        ...(value.action === "reply_review_post" ? { p_decision: { decisionId: replyBody.decision_id,
          expectedVersion: replyBody.expected_version, action: "edit", text: replyBody.text, surface: "api" } }
          : value.body ? { p_payload: value.body } : {}) });
    }
  });
  it("reads and saves a channel that sends without a post-send sample (rate 0)", async () => {
    const unsampled = { ...settings, email: { mode: "send_and_sample", sample_rate: 0 } };
    const read = await harness({ workspace, settings: unsampled }).request(cases[0]!);
    expect(read.status).toBe(200);
    expect((await read.json()).settings.email).toEqual(unsampled.email);
    const h = harness({ workspace, settings: unsampled });
    expect((await h.request(cases[1]!, { expected_version: 1, email: unsampled.email })).status).toBe(200);
    expect(h.rpc).toHaveBeenCalledOnce();
  });
  it("keeps pending provider work pending and rejects wrong identities or unsupported confirmations", async () => {
    const changed: Array<[Case["action"], unknown]> = [
      ["review_settings_patch", { workspace, settings: { ...settings, version: 1 } }],
      ["samples_get", { workspace, messages: [{ ...sample, delivery_state: "scheduled" }], next_after: null }],
      ["message_rating_post", { workspace, feedback: { message_ref: message.lead_ref, ...rating, rated_at: time } }],
      ["reply_get", { workspace, turn: { ...turn, turn_ref: message.lead_ref } }],
      ["reply_review_post", { ...decisionReceipt, turn: { ...turn, state: "sent", sent_at: null } }],
      ["reply_review_post", { ...decisionReceipt, dispatch: message.lead_ref }],
      ["reply_review_post", { ...decisionReceipt, view: { ...view, label: "a different view" } }],
      ["reply_review_post", { ...decisionReceipt, outcome: "stale" }],
      ["reply_review_post", { ...decisionReceipt, turn: { ...turn, extra: true } }],
      ["replies_get", { workspace, turns: [{ ...turn, history: [{ ...sample, message_ref: "invalid" }] }], next_after: null }],
      ["message_rewrite_post", { ...rewrite, rewrite_work: { ...rewrite.rewrite_work, message_ref: message.lead_ref } }],
      ["message_rewrite_post", { ...rewrite, history: [{ ...sample, account_id: message.lead_ref, sender_id: message.lead_ref }] }],
      ["message_rewrite_post", { ...rewrite, revisions: [{ ...sample, account_id: message.lead_ref }] }],
      ["message_rewrite_post", { ...rewrite, rewrite_work: { ...rewrite.rewrite_work, state: "done", replacement_message_ref: null } }],
      ["lead_stop_post", { workspace, lead_ref: message.message_ref, stopped_at: time, provider_stops_pending: false }],
    ];
    for (const [action, receipt] of changed) {
      const value = cases.find(value => value.action === action)!;
      expect((await harness(receipt).request(value)).status, action).toBe(502);
    }
    for (const state of ["processing", "sending", "queued", "uncertain"]) {
      const h = harness({ ...decisionReceipt, turn: { ...turn, state } });
      const response = await h.request(cases.find(value => value.action === "reply_review_post")!);
      expect(response.status, state).toBe(202);
      expect((await response.json()).turn).toMatchObject({ state, sent_at: null });
      expect(h.rpc).toHaveBeenCalledOnce();
    }
  });
  it("reports settings and message version conflicts to re-read", async () => {
    for (const [action, code] of [
      ["review_settings_patch", "OUTREACH_SETTINGS_MOVED"],
      ["message_rewrite_post", "OUTREACH_MESSAGE_MOVED"],
    ] as const) {
      const rpc = vi.fn(async () => ({ data: null, error: { code: "PT409", message: code, details: null } }));
      const app = createApp({ authenticate: async () => ({ ok: true, session: { userId: "member", client: { rpc } } }), log: () => {} });
      const value = cases.find(value => value.action === action)!;
      const definition = memberReviewOperationDefinitions[action];
      const response = await app.request(definition.route.replace(/\{[^}]+\}/g, value.ref ?? ""), { method: definition.method,
        headers: { authorization: "Bearer test", "x-lifty-client-contract": STAGE_CLIENT_CONTRACT, "content-type": "application/json" },
        body: JSON.stringify(value.body) });
      expect(response.status, code).toBe(409);
      expect((await response.json()).error.code, code).toBe(code);
    }
  });
  it("rejects invalid consent and revision selectors before any RPC", async () => {
    for (const [action, body] of [
      ["lead_stop_post", { request_ref: message.message_ref, confirm: false }],
      ["message_rewrite_post", { ...rewriteBody, expected_review_status: "approved" }],
      ["reply_review_post", { ...replyBody, expected_version: -1 }],
      ["reply_review_post", { ...replyBody, action: "skip" }],
      ["review_settings_patch", { expected_version: 1, linkedin: { mode: "send_and_sample", sample_rate: 100 } }],
      ["message_rating_post", { ...rating, source_digest: "unverified" }],
    ] as const) {
      const h = harness(null);
      expect((await h.request(cases.find(value => value.action === action)!, body)).status, action).toBe(422);
      expect(h.rpc).not.toHaveBeenCalled();
    }
  });
  it("maps decisions, preserves retry identity, and renders the returned SQL view without digest staleness", async () => {
    const value = cases.find(value => value.action === "reply_review_post")!;
    for (const [action, text, command] of [
      ["send", undefined, "approve"], ["send", "  Updated answer.  ", "edit"], ["skip", undefined, "suppress"],
      ["recover", undefined, "recover"], ["retry", undefined, "retry"],
    ] as const) {
      const body = { decision_id: replyBody.decision_id, expected_version: 1, action, ...(text ? { text } : {}) };
      // Stale can return the same version (the offered action changed) or a newer view.
      for (const outcome of ["accepted", "replayed", "stale"] as const) {
        const receipt = { ...decisionReceipt, outcome, dispatch: null };
        const h = harness(receipt);
        for (let attempt = 0; attempt < 2; attempt++) {
          const response = await h.request(value, body);
          expect(response.status).toBe(202);
          expect(await response.json()).toEqual(receipt);
        }
        expect(h.rpc.mock.calls).toHaveLength(2);
        expect(h.rpc).toHaveBeenLastCalledWith("decide_reply_turn", { p_workspace_id: null, p_turn_id: turn.turn_ref,
          p_decision: { decisionId: body.decision_id, expectedVersion: 1, action: command, surface: "api",
            ...(text ? { text: text.trim() } : {}) } });
        expect(h.rpc.mock.calls[0]).toEqual(h.rpc.mock.calls[1]);
      }
    }
  });
  it("requires the complete strict view and trimmed API edit limits without Slack's editor cap", async () => {
    const value = cases.find(value => value.action === "reply_review_post")!;
    for (const field of Object.keys(view)) {
      const incomplete: Record<string, unknown> = { ...view };
      delete incomplete[field];
      expect(contracts.ReplyViewSchema.safeParse(incomplete).success, field).toBe(false);
    }
    expect(contracts.ReplyViewSchema.safeParse({ ...view, extra: true }).success).toBe(false);
    expect(contracts.ReplyViewSchema.safeParse({ ...view, label: " " }).success).toBe(false);
    for (const body of [
      { expected_version: 1, action: "send" }, { ...replyBody, source_digest: turn.source_digest },
      { ...replyBody, text: " " }, { ...replyBody, text: "x".repeat(20001) }, { ...replyBody, text: "bad\u0000text" },
      { ...replyBody, action: "recover" }, { ...replyBody, action: "retry" },
    ]) {
      const h = harness(decisionReceipt);
      expect((await h.request(value, body)).status).toBe(422);
      expect(h.rpc).not.toHaveBeenCalled();
    }
    const h = harness(decisionReceipt);
    const text = "x".repeat(20000);
    expect((await h.request(value, { ...replyBody, text: `  ${text}  ` })).status).toBe(202);
    expect(h.rpc).toHaveBeenCalledWith("decide_reply_turn", expect.objectContaining({ p_decision: expect.objectContaining({ text }) }));
  });
  it("describes deferred sends and cancellation as pending for installed agent tools", () => {
    const tools = getStageMcpTools();
    for (const name of ["campaigns_reply_review_post", "campaigns_message_rewrite_post", "campaigns_lead_stop_post"]) {
      const tool = tools.find(tool => tool.name === name)!;
      expect(tool.description, name).toContain("a pending receipt does not confirm completion");
      expect(tool.description, name).not.toContain("Writes commit synchronously");
    }
    for (const name of ["campaigns_message_review_post", "campaigns_reply_review_post", "campaigns_lead_stop_post"])
      expect(tools.find(tool => tool.name === name)!.annotations.openWorldHint, name).toBe(true);
  });
});
