import { z } from "zod";
import type { AuthSession } from "./app.js";
import { PublicError } from "./errors.js";
import { rpcFailure } from "./rpc-errors.js";
import { validateIdentityInput, type IdentityDefinition, type IdentityInput } from "./identity-operations.js";
import * as c from "./outreach-contracts.js";
import { memberReviewOperationDefinitions, memberReviewReceiptMatches } from "./member-review-operations.js";
import { writingRecommendations } from "./writing-rules.js";
import { testFailureMessage, type TestFailure } from "./campaign-test-failure.js";

const Empty = z.object({}).strict();
export type OutreachInput = IdentityInput;
type Definition = IdentityDefinition;
const invalid = { status: 422, code: "OUTREACH_INVALID" } as const;
const unavailable = { code: "OUTREACH_UNAVAILABLE", message: "Outreach state could not be verified. Read the resource before retrying a change." };
function definition(resource: "journeys" | "campaigns", action: string, method: Definition["method"],
  request: z.ZodType | null, response: z.ZodType, description: string): Definition {
  const journey = resource === "journeys";
  const plural = resource;
  const singular = journey ? "journey" : "campaign";
  const detail = !["get", "post"].includes(action);
  const suffix = action === "detail" ? "" : action === "draft_patch" ? "/draft" : `/${action}`;
  const rpc = action === "get" ? `get_lifty_${plural}` : action === "detail" ? `get_lifty_${singular}`
    : action === "post" ? `create_lifty_${singular}` : action === "draft_patch" ? `patch_lifty_${singular}_draft`
      : `${action}_lifty_${singular}`;
  return { method, route: `/v1/workspace/${plural}${detail ? `/{${singular}_ref}${suffix}` : ""}`,
    rpc, path: detail ? journey ? c.JourneyPathSchema : c.CampaignPathSchema : Empty,
    query: action === "get" ? journey ? c.PageQuerySchema : c.CampaignQuerySchema : Empty,
    request, response, invalid, success: action === "post" ? 201 : 200,
    cli: { operation: action === "draft_patch" ? "draft" : action },
    args: input => ({ ...(detail ? { [`p_${singular}_id`]: input.path[`${singular}_ref`] } : {}),
      ...(action === "get" ? { p_query: input.query } : method === "GET" ? {} : { p_payload: input.body }) }),
    description,
  };
}
function testDefinition(action: "tests_get" | "tests_post" | "test_detail"): Definition {
  const read = action !== "tests_post";
  const detail = action === "test_detail";
  return { method: read ? "GET" : "POST", route: `/v1/workspace/campaigns/{campaign_ref}/tests${detail ? "/{test_ref}" : ""}`,
    rpc: detail ? "get_lifty_campaign_test" : read ? "get_lifty_campaign_tests" : "create_lifty_campaign_test",
    path: detail ? c.CampaignTestPathSchema : c.CampaignPathSchema, query: action === "tests_get" ? c.PageQuerySchema : Empty,
    request: read ? null : c.CampaignTestCreateSchema, response: action === "tests_get" ? c.CampaignTestsSchema : c.CampaignTestResultSchema,
    invalid, success: read ? 200 : 202, cli: { operation: action },
    args: input => ({ p_campaign_id: input.path.campaign_ref, ...(detail ? { p_test_id: input.path.test_ref } : {}),
      ...(action === "tests_get" ? { p_query: input.query } : read ? {} : { p_payload: input.body }) }),
    description: action === "tests_post" ? "Queue an isolated saved candidate test with exact revision/digest/CAS and idempotent request_ref. Sample at most 20 explicit leads or reuse a completed baseline's exact leads and saved before outputs. Compose after only; disclose changed context. Preview person is provenance, never lead assignment. Does not enroll, approve, activate or send."
      : detail ? "Read saved signed test outputs and exact provenance. Pending is authoritative; baseline outputs are never regenerated."
        : "Discover durable saved test receipts after a lost response or in a fresh session. Paginated summaries contain no output bodies.",
  };
}
function messageDefinition(revise: boolean): Definition {
  return { method: revise ? "POST" : "GET", route: `/v1/workspace/campaign-messages/{message_ref}${revise ? "/revisions" : ""}`,
    rpc: revise ? "revise_lifty_campaign_message" : "get_lifty_campaign_message", path: c.CampaignMessagePathSchema, query: Empty,
    request: revise ? c.CampaignMessageReviseSchema : null, response: c.CampaignMessageResultSchema, invalid, success: revise ? 201 : 200,
    cli: { operation: revise ? "message_revisions_post" : "message_get" }, args: input => ({ p_message_id: input.path.message_ref,
      ...(revise ? { p_payload: input.body } : {}) }),
    description: revise ? "Correct an actual still-unapproved per-lead saved draft into a new pending revision using exact source_digest/review state and idempotent request_ref. Preserve old bytes, person/signature, source and template/prompt/library provenance. Existing reviewer approval path applies; never approves or sends. Approved/sent/superseded messages and missing signature pins are rejected."
      : "Read an actual saved per-lead message in the selected workspace. No canonical campaign membership is inferred for historical drafts. Does not generate, approve, activate or send.",
  };
}
function reviewDefinition(read: boolean): Definition {
  return { method: read ? "GET" : "POST",
    route: read ? "/v1/workspace/campaign-reviews" : "/v1/workspace/campaign-messages/{message_ref}/review",
    rpc: read ? "get_lifty_campaign_reviews" : "review_lifty_campaign_message",
    path: read ? Empty : c.CampaignMessagePathSchema, query: read ? c.CampaignReviewsQuerySchema : Empty,
    request: read ? null : c.CampaignMessageReviewSchema, response: read ? c.CampaignReviewsSchema : c.CampaignMessageResultSchema,
    invalid, success: 200, cli: { operation: read ? "reviews_get" : "message_review_post" },
    args: input => read ? { p_query: input.query } : { p_message_id: input.path.message_ref, p_payload: input.body },
    description: read ? "Read the selected workspace's saved Campaign review queue, including the exact person, account and action. Paginated, read-only; failed reads stay unavailable. Members and operators use the same workflow."
      : "Review one exact saved LinkedIn or email message using source_digest and expected_review_status. Approve schedules only the reviewed bytes; it never activates a Campaign. Skip closes only this channel's branch, without global suppression. Retry re-checks the account and sender and atomically approves the same bytes only after confirming that no begun, unknown or confirmed send could be replayed.",
  };
}
export const outreachOperationDefinitions = {
  journeys: {
    get: definition("journeys", "get", "GET", null, c.JourneysSchema, "Read saved Journeys in the selected workspace with their selected revision and executable version. Unknown reads are unavailable, not an empty audience."),
    detail: definition("journeys", "detail", "GET", null, c.JourneyResultSchema, "Read one Journey: audience and shared stops, draft and approval history, participating Campaigns and the executable version used for new Journey starts. Does not generate or change work."),
    post: definition("journeys", "post", "POST", c.JourneyCreateSchema, c.JourneyResultSchema, "Save a persistent audience rule and the shared stops as a Journey draft. Qualified audience consumes Searches facts; a static list is an explicit customer choice, never a calibration sample. Does not approve or activate."),
    draft_patch: definition("journeys", "draft_patch", "PATCH", c.JourneyDraftSchema, c.JourneyResultSchema, "Append a Journey draft with expected_version and its exact source revision_ref. Saving never pauses or activates work; started Journeys keep their executable versions."),
    publish: definition("journeys", "publish", "POST", c.PublishSchema, c.JourneyResultSchema, "Approve one exact Journey revision and digest. Records actor and time only; does not activate, start Journeys or authorize sending."),
    activate: definition("journeys", "activate", "POST", c.ActivateSchema, c.JourneyResultSchema, "Select one exact approved Journey revision for new Journey starts. Its executable version is derived from that revision and each activated Campaign's selected revision; started Journeys keep theirs. Campaign intent is unchanged. The existing scheduled runtime may contact external recipients through active Campaigns, subject to account, readiness and safety gates. The receipt confirms saved selection, not compilation or delivery."),
  },
  campaigns: {
    ...memberReviewOperationDefinitions,
    reviews_get: reviewDefinition(true),
    message_review_post: reviewDefinition(false),
    runtime: { ...definition("campaigns", "runtime", "GET", null, c.CampaignRuntimeSchema,
      "Read started Journeys of this Campaign grouped by the executable version and Campaign revision they retain: started, continuing, prepared and pending, plus recorded gate reasons only. Intent is separate from execution and readiness. No recorded reason does not prove ready; failed reads remain unavailable."), rpc: "get_lifty_campaign_runtime" },
    message_get: messageDefinition(false),
    message_revisions_post: messageDefinition(true),
    tests_get: testDefinition("tests_get"),
    tests_post: testDefinition("tests_post"),
    test_detail: testDefinition("test_detail"),
    get: definition("campaigns", "get", "GET", null, c.CampaignsSchema, "Read channel Campaigns, optionally by journey_ref or channel. Uses the selected workspace; no provider selector."),
    detail: definition("campaigns", "detail", "GET", null, c.CampaignResultSchema, "Read one Campaign: start rules, sequence, templates or instructions, delays, schedule, its draft/approval history, the revision selected for new Journey starts and its intent (inactive, active or paused). Account readiness is independent."),
    post: definition("campaigns", "post", "POST", c.CampaignCreateSchema, c.CampaignResultSchema, "Save an inactive unapproved channel Campaign draft in a Journey: start rules (journey_start, sent/unaccepted relative to another Campaign, or Email after linkedin_first_dm_skipped), steps, templates or generated-writing instructions, delays and schedule. It names no senders: new Journeys go round-robin to every person with an account on a Journey channel that was not disconnected (email also needs their signature), and each lead keeps one person. Never sends."),
    draft_patch: definition("campaigns", "draft_patch", "PATCH", c.CampaignDraftSchema, c.CampaignResultSchema, "Save supplied policy changes as a new unapproved immutable draft using expected_version and the current draft revision_ref. Omitted profile_version and voice_version use current confirmed Business revisions. Active approved work continues; pause, readiness and incident holds and started Journeys are unchanged."),
    publish: definition("campaigns", "publish", "POST", c.PublishSchema, c.CampaignResultSchema, "Approve one exact revision/digest; records actor/time. It never activates, resumes or sends."),
    activate: definition("campaigns", "activate", "POST", c.ActivateSchema, c.CampaignActivationResultSchema, "Select one exact approved revision for new Journey starts and set active intent, or resume paused work under its retained revisions. A dependent Campaign joins the executable version once its preceding Campaign is activated. The existing scheduled runtime may contact external recipients, including retained pending work, subject to account, readiness and incident gates. The receipt confirms saved intent and selection, not compilation or delivery. Refused with OUTREACH_CUSTOMER_LIST_NOT_CURRENT when starting or changing intent or revision while the connected CRM's customer list is missing or stale; unchanged active selections are no-ops, and a disconnected CRM retains its saved list. customer_list records the accepted decision."),
    pause: definition("campaigns", "pause", "POST", c.CampaignPauseSchema, c.CampaignResultSchema, "Pause every automatic step of this Campaign in every started Journey, including follow-ups. Pending work and history remain; begun or unknown effects reconcile. Other channels continue where their start rules permit. Does not claim provider stop confirmation."),
  },
};
export const outreachEntries = () => Object.entries(outreachOperationDefinitions).flatMap(([resource, operations]) =>
  Object.entries(operations).map(([action, definition]) => ({ key: `${resource}.${action}`, resource, action, definition })));
export const validateOutreachInput = validateIdentityInput;

export async function executeOutreachOperation(session: AuthSession, key: string, input: OutreachInput): Promise<unknown> {
  const entry = outreachEntries().find(item => item.key === key);
  if (!entry) throw new Error("Unknown Outreach operation");
  const { definition } = entry;
  let result: { data: unknown; error: unknown };
  try { result = await (session.client as { rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> })
    .rpc(definition.rpc, { p_workspace_id: session.workspaceRef ?? null, ...definition.args(input) }); }
  catch (cause) { throw rpcFailure(cause, { operation: definition.rpc, ...unavailable }); }
  if (result.error) throw rpcFailure(result.error, { operation: definition.rpc, ...unavailable });
  const parsed = definition.response.safeParse(result.data);
  if (!parsed.success) throw new PublicError({ status: 502, ...unavailable });
  const reviewMatch = memberReviewReceiptMatches(entry.action, input, parsed.data);
  if (reviewMatch !== undefined) {
    if (!reviewMatch) throw new PublicError({ status: 502, ...unavailable });
    return parsed.data;
  }
  // A response for another resource cannot confirm this operation's outcome.
  const value = parsed.data as { journey?: { journey_ref: string }; campaign?: { campaign_ref: string } };
  if (entry.action === "runtime") {
    if (c.CampaignRuntimeSchema.parse(parsed.data).campaign_ref !== input.path.campaign_ref)
      throw new PublicError({ status: 502, ...unavailable });
    return parsed.data;
  }
  if (["message_get", "message_revisions_post", "message_review_post"].includes(entry.action)) {
    const { message, history, revisions } = c.CampaignMessageResultSchema.parse(parsed.data);
    if (message.direction !== "outbound" || history.some(item => !message.account_id || !c.inConversation(item, message))
      || revisions.some(item => item.lead_ref !== message.lead_ref || item.channel !== message.channel || item.account_id !== message.account_id))
      throw new PublicError({ status: 502, ...unavailable });
  }
  if (entry.action === "message_get" || entry.action === "message_revisions_post") {
    const receipt = c.CampaignMessageResultSchema.parse(parsed.data);
    const message = receipt.message;
    if (entry.action === "message_get" ? message.message_ref !== input.path.message_ref
      : message.message_ref === input.path.message_ref || message.source_message_ref !== input.path.message_ref
        || !message.sender_id || !message.sender_version)
      throw new PublicError({ status: 502, ...unavailable });
    return parsed.data;
  }
  if (entry.action === "reviews_get") {
    const receipt = c.CampaignReviewsSchema.parse(parsed.data);
    const query = input.query as z.infer<typeof c.CampaignReviewsQuerySchema>;
    if (receipt.messages.length > (query.limit ?? 100) || receipt.messages.some(message => message.direction !== "outbound" ||
      (query.channel && message.channel !== query.channel) || (query.review_status && message.review_status !== query.review_status)))
      throw new PublicError({ status: 502, ...unavailable });
    return receipt;
  }
  if (entry.action === "message_review_post") {
    const receipt = c.CampaignMessageResultSchema.parse(parsed.data);
    const request = input.body as z.infer<typeof c.CampaignMessageReviewSchema>;
    const expected = { approve: "approved", skip: "suppressed", retry: "approved" }[request.action];
    if (receipt.message.message_ref !== input.path.message_ref || receipt.message.review_status !== expected
      || (request.action !== "skip" && (!receipt.message.account_id || !receipt.message.sender_id || !receipt.message.sender_name)))
      throw new PublicError({ status: 502, ...unavailable });
    return receipt;
  }
  if (entry.action.startsWith("tests_") || entry.action === "test_detail") {
    const receipt = parsed.data as { test?: { campaign_ref: string; test_ref: string }; tests?: Array<{ campaign_ref: string }> };
    if (receipt.test ? receipt.test.campaign_ref !== input.path.campaign_ref || (input.path.test_ref && receipt.test.test_ref !== input.path.test_ref)
      : receipt.tests?.some(test => test.campaign_ref !== input.path.campaign_ref)) throw new PublicError({ status: 502, ...unavailable });
    if (entry.action === "tests_post") {
      const saved = c.CampaignTestResultSchema.parse(parsed.data).test;
      const requested = input.body as z.infer<typeof c.CampaignTestCreateSchema>;
      if (saved.request_ref !== requested.request_ref || saved.revision_ref !== requested.revision_ref || saved.digest !== requested.digest
        || ("baseline_test_ref" in requested.sample ? saved.baseline_test_ref !== requested.sample.baseline_test_ref
          : saved.baseline_test_ref !== null || saved.samples.length !== requested.sample.lead_refs.length
            || saved.samples.some(sample => !("lead_refs" in requested.sample) || !requested.sample.lead_refs.includes(sample.lead_ref))))
        throw new PublicError({ status: 502, ...unavailable });
    }
    // LIF-1292: relay a failed sample's reason instead of a bare "failed".
    for (const sample of (parsed.data as { test?: { samples: Array<{ failure?: TestFailure | null }> } }).test?.samples ?? [])
      if (sample.failure) sample.failure.message = testFailureMessage(sample.failure);
    return parsed.data;
  }
  if ((input.path.journey_ref && value.journey?.journey_ref !== input.path.journey_ref)
    || (input.path.campaign_ref && value.campaign?.campaign_ref !== input.path.campaign_ref))
    throw new PublicError({ status: 502, ...unavailable });
  const body = input.body as { revision_ref?: string; digest?: string } | undefined;
  if (entry.action === "publish") {
    const resource = entry.resource === "journeys" ? c.JourneyResultSchema.parse(parsed.data).journey : c.CampaignResultSchema.parse(parsed.data).campaign;
    if (!resource.revisions.some(revision => revision.revision_ref === body?.revision_ref && revision.digest === body?.digest && revision.approval))
      throw new PublicError({ status: 502, ...unavailable });
  }
  if (key === "journeys.activate") {
    const journey = c.JourneyResultSchema.parse(parsed.data).journey;
    if (journey.active_revision?.revision_ref !== body?.revision_ref || journey.active_revision?.digest !== body?.digest || !journey.active_revision?.approval
      || (journey.executable_version && journey.executable_version.journey.revision_ref !== body?.revision_ref))
      throw new PublicError({ status: 502, ...unavailable });
  }
  if (key === "campaigns.activate") {
    const receipt = c.CampaignActivationResultSchema.parse(parsed.data);
    const revision = receipt.campaign.active_revision;
    const included = receipt.journey.executable_version?.campaigns.find(pin => pin.campaign_ref === input.path.campaign_ref);
    if (receipt.campaign.state !== "active" || !revision?.approval || revision.revision_ref !== body?.revision_ref || revision.digest !== body?.digest
      || (included && included.revision.revision_ref !== revision.revision_ref) || receipt.journey.journey_ref !== receipt.campaign.journey_ref)
      throw new PublicError({ status: 502, ...unavailable });
  }
  // A paused or never-activated Campaign has no operating intent.
  if (key === "campaigns.pause" && c.CampaignResultSchema.parse(parsed.data).campaign.state === "active")
    throw new PublicError({ status: 502, ...unavailable });
  if (entry.resource === "campaigns" && value.campaign) {
    // The response schema already validated this Campaign (activation adds its Journey).
    const { campaign } = parsed.data as { campaign: z.infer<typeof c.CampaignSchema> };
    const recommendations = writingRecommendations(campaign.draft_revision, campaign.channel);
    // Publish may approve an older revision; warn about the one it approved.
    const published = entry.action === "publish" ? campaign.revisions.find(revision => revision.revision_ref === body?.revision_ref) : undefined;
    const slots = c.slotsSpecWarnings(published ?? campaign.draft_revision);
    if (recommendations || slots) return { ...(parsed.data as object),
      ...(recommendations ? { writing_recommendations: recommendations } : {}), ...(slots ? { slots_spec_warnings: slots } : {}) };
  }
  return parsed.data;
}
