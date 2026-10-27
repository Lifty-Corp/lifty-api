import { z } from "zod";
import type { IdentityDefinition, IdentityInput } from "./identity-operations.js";
import * as c from "./outreach-contracts.js";

function replyDecision(body: unknown) {
  const request = c.ReplyTurnReviewSchema.parse(body);
  return { decisionId: request.decision_id, expectedVersion: request.expected_version, surface: "api",
    action: request.action === "send" ? request.text === undefined ? "approve" : "edit"
      : request.action === "skip" ? "suppress" : request.action,
    ...(request.text === undefined ? {} : { text: request.text }),
  };
}

const Empty = z.object({}).strict();
function operation(key: string, method: IdentityDefinition["method"], route: string, rpc: string,
  response: z.ZodType, description: string,
  options: { path?: z.ZodType; request?: z.ZodType; query?: z.ZodType; success?: 200 | 202 } = {}): IdentityDefinition {
  return { method, route: `/v1/workspace/${route}`, rpc, path: options.path ?? Empty,
    query: options.query ?? Empty, request: options.request ?? null, response,
    invalid: { status: 422, code: "OUTREACH_INVALID" }, success: options.success ?? 200, cli: { operation: key },
    args: input => ({ ...(input.path.message_ref ? { p_message_id: input.path.message_ref } : {}),
      ...(input.path.turn_ref ? { p_turn_id: input.path.turn_ref } : {}),
      ...(input.path.lead_ref ? { p_lead_id: input.path.lead_ref } : {}),
      ...(options.query ? { p_query: input.query } : {}), ...(options.request ? key === "reply_review_post" ? { p_decision: replyDecision(input.body) } : { p_payload: input.body } : {}) }),
    description,
  };
}

export const memberReviewOperationDefinitions = {
  review_settings_get: operation("review_settings_get", "GET", "review-settings", "get_lifty_review_settings", c.ReviewSettingsResultSchema,
    "Read the selected workspace's versioned LinkedIn and email review choices. Each channel approves every new draft or sends routine drafts with a 0%, 10%, 20% or 50% post-send sample; 0% disables sampling. Flagged drafts, replies and requested follow-ups always wait."),
  review_settings_patch: operation("review_settings_patch", "PATCH", "review-settings", "update_lifty_review_settings", c.ReviewSettingsResultSchema,
    "Save supplied channel review choices with expected_version. send_and_sample lets future unflagged drafts in already active approved Campaigns automatically send to external recipients under existing account, schedule and safety gates. sample_rate selects confirmed sent messages for later rating; 0% disables sampling. Applies to new drafts only; existing pending drafts still require a decision. Never activates a Campaign or releases its pending messages.", { request: c.ReviewSettingsUpdateSchema }),
  samples_get: operation("samples_get", "GET", "campaign-review-samples", "get_lifty_campaign_review_samples", c.CampaignReviewsSchema,
    "Read unrated sampled messages with provider-confirmed delivery only, scoped to the selected workspace. Planned or enrolled work is not a sent sample.", { query: c.ReviewPageQuerySchema }),
  message_rating_post: operation("message_rating_post", "POST", "campaign-messages/{message_ref}/rating", "rate_lifty_campaign_message", c.MessageRatingResultSchema,
    "Rate one exact confirmed sent sample using its source_digest. Save up/down feedback and an optional note/scope; feedback never changes approved copy. A Campaign or Business voice edit is a separate explicit version-checked operation.", { path: c.CampaignMessagePathSchema, request: c.MessageRatingSchema }),
  review_count_get: operation("review_count_get", "GET", "review-count", "get_lifty_member_review_count", c.ReviewCountSchema,
    "Read the selected workspace's waiting Review item count without loading message bodies."),
  replies_get: operation("replies_get", "GET", "reply-turns", "get_lifty_reply_turns", c.ReplyTurnsSchema,
    "Read waiting replies and due requested follow-ups with their exact turn version, saved draft, original account and conversation. Shares the same reply turn as Slack; no duplicate approval store.", { query: c.ReviewPageQuerySchema }),
  reply_get: operation("reply_get", "GET", "reply-turns/{turn_ref}", "get_lifty_reply_turn", c.ReplyTurnResultSchema,
    "Read one exact reply turn and its confirmed, queued or uncertain delivery evidence. Unknown routing is never permission to send.", { path: c.ReplyTurnPathSchema }),
  reply_review_post: operation("reply_review_post", "POST", "reply-turns/{turn_ref}/review", "decide_reply_turn", c.ReplyDecisionResultSchema,
    "Decide a reply with its expected_version and a caller-generated decision_id reused for retries of identical intent. Send approves the saved draft or edits with optional trimmed text; skip suppresses this turn. Recover/retry use the same command only when view.actions permits. Render returned view label/detail/actions verbatim. Stale is a normal receipt with the current view and no dispatch; queued or uncertain is not sent.", { path: c.ReplyTurnPathSchema, request: c.ReplyTurnReviewSchema, success: 202 }),
  message_rewrite_post: operation("message_rewrite_post", "POST", "campaign-messages/{message_ref}/rewrite", "rewrite_lifty_campaign_message", c.CampaignMessageResultSchema,
    "Request a new pending draft from one exact pending source_digest with an idempotent request_ref. Preserves earlier bytes and provenance and never approves. Read the source message's rewrite_work until it supplies the exact replacement or a bounded failure; never restart an uncertain job blindly.", { path: c.CampaignMessagePathSchema, request: c.CampaignMessageRewriteSchema, success: 202 }),
  lead_stop_post: operation("lead_stop_post", "POST", "leads/{lead_ref}/stop-outreach", "stop_lifty_lead_outreach", c.StopLeadOutreachResultSchema,
    "Explicitly stop every proactive LinkedIn and email Campaign for this lead with confirm:true and an idempotent request_ref. Writes the local manual_stop barrier and requests provider cancellation; provider_stops_pending means reconciliation is still required. Inbound replies remain available.", { path: c.LeadOutreachPathSchema, request: c.StopLeadOutreachSchema, success: 202 }),
  lead_reassign_post: operation("lead_reassign_post", "POST", "leads/reassign", "reassign_lifty_leads", c.ReassignLeadsResultSchema,
    "Move admitted leads whose outreach has not started to another person who takes part, with confirm:true, a reason and an idempotent request_ref (repeating it returns the original receipt). Select lead_refs (up to 500) or from_sender_id (that person's not-started leads); target one sender_id or round_robin among the other participating persons whose accounts cover the lead's channels. Not started means no sent, begun or uncertain outbound on any channel; a lead with any contact is refused with outreach_started and never moves. Each result is reassigned, unchanged or refused with its refusal; remaining counts leads left for another request. A moved lead prepares again with its new person's signature. Contacts nobody.", { request: c.ReassignLeadsSchema }),
};

export function memberReviewReceiptMatches(action: string, input: IdentityInput, value: unknown): boolean | undefined {
  if (!(action in memberReviewOperationDefinitions)) return undefined;
  switch (action) {
    case "review_settings_patch": {
      const request = c.ReviewSettingsUpdateSchema.parse(input.body);
      const { settings } = c.ReviewSettingsResultSchema.parse(value);
      return settings.version > request.expected_version && (["linkedin", "email"] as const).every(channel =>
        !request[channel] || settings[channel].mode === request[channel].mode && settings[channel].sample_rate === request[channel].sample_rate);
    }
    case "samples_get": {
      const query = c.ReviewPageQuerySchema.parse(input.query);
      const { messages } = c.CampaignReviewsSchema.parse(value);
      return messages.length <= (query.limit ?? 100) && messages.every(message => message.direction === "outbound"
        && message.delivery_state === "confirmed" && message.sent_at !== null && (!query.channel || message.channel === query.channel));
    }
    case "message_rating_post": {
      const request = c.MessageRatingSchema.parse(input.body);
      const { feedback } = c.MessageRatingResultSchema.parse(value);
      return feedback.message_ref === input.path.message_ref && feedback.source_digest === request.source_digest
        && feedback.rating === request.rating && feedback.note === (request.note ?? null)
        && feedback.learning_scope === (request.learning_scope ?? "message");
    }
    case "replies_get": {
      const query = c.ReviewPageQuerySchema.parse(input.query);
      const { turns } = c.ReplyTurnsSchema.parse(value);
      return turns.length <= (query.limit ?? 100) && turns.every(turn => !query.channel || turn.channel === query.channel);
    }
    case "reply_get": return c.ReplyTurnResultSchema.parse(value).turn.turn_ref === input.path.turn_ref;
    case "reply_review_post": {
      const receipt = c.ReplyDecisionResultSchema.parse(value);
      const request = c.ReplyTurnReviewSchema.parse(input.body);
      // SQL owns the current view, including after a replay or stale click.
      // Recovery may leave the version unchanged; a replay can already be sent.
      return receipt.turn.turn_ref === input.path.turn_ref
        && Object.keys(receipt.view).every(key => JSON.stringify(receipt.view[key as keyof typeof receipt.view])
          === JSON.stringify(receipt.turn.view[key as keyof typeof receipt.view]))
        && (receipt.dispatch === null || (request.action === "send" && receipt.dispatch === request.decision_id));
    }
    case "message_rewrite_post": {
      const receipt = c.CampaignMessageResultSchema.parse(value);
      const request = c.CampaignMessageRewriteSchema.parse(input.body);
      const work = receipt.rewrite_work;
      return receipt.message.message_ref === input.path.message_ref && work != null
        && work.message_ref === input.path.message_ref && work.source_digest === request.source_digest
        && receipt.message.direction === "outbound"
        && receipt.history.every(message => c.inConversation(message, receipt.message))
        && receipt.revisions.every(message => message.lead_ref === receipt.message.lead_ref
          && message.channel === receipt.message.channel && message.account_id === receipt.message.account_id);
    }
    case "lead_stop_post": return c.StopLeadOutreachResultSchema.parse(value).lead_ref === input.path.lead_ref;
    case "lead_reassign_post": {
      const request = c.ReassignLeadsSchema.parse(input.body);
      const receipt = c.ReassignLeadsResultSchema.parse(value);
      const leads = receipt.results.map(result => result.lead_ref);
      const requested = "lead_refs" in request.leads ? request.leads.lead_refs : null;
      const sender = request.to.kind === "sender" ? request.to.sender_id : null;
      return receipt.request_ref === request.request_ref
        && (!requested || (leads.length === requested.length && new Set(leads).size === leads.length && leads.every(lead => requested.includes(lead))))
        && (!sender || receipt.results.every(result => result.outcome !== "reassigned" || result.to_sender_id === sender));
    }
    default: return true;
  }
}
