import { z } from "zod";
import { AccountsGetSchema, IdPath } from "./identity-contracts.js";
import type { IdentityDefinition, IdentityInput } from "./identity-operations.js";
import * as c from "./sender-control-contracts.js";

// LIF-1771: the Senders controls, published in the operation catalog so the
// dashboard, the CLI and the agent run the same operations with the same
// receipts. The database owns every transition and every refusal.
const Empty = z.object({}).strict();
const invalid = { status: 400, code: "INVALID_REQUEST" } as const;
const outreachInvalid = { status: 422, code: "OUTREACH_INVALID" } as const;
const handoffRoute = "/v1/workspace/sender-handoffs/{handoff_ref}";
const stopsRoute = "/v1/workspace/stops";

// The database refuses a handoff without a named workspace, so the operation
// resolves the selected one first (`explicitWorkspace`).
const handoff = (action: string, method: "GET" | "POST", suffix: string, rpc: string, description: string,
  request: z.ZodType | null, args: (input: IdentityInput) => Record<string, unknown>, path: z.ZodType = c.HandoffPath): IdentityDefinition => ({
  method, route: `${handoffRoute}${suffix}`, cli: { operation: action.replace(/_/g, "-") }, rpc, path, query: Empty, request,
  invalid, response: c.HandoffSchema, success: 200, explicitWorkspace: true, description,
  args: input => ({ p_drain_ref: input.path.handoff_ref, ...args(input) }),
});
const stop = (action: "stop-set" | "stop-release" | "stop-review", suffix: string, rpc: string, request: z.ZodType, response: z.ZodType, description: string): IdentityDefinition => ({
  method: "POST", route: `${stopsRoute}${suffix}`, cli: { operation: action }, rpc, path: Empty, query: c.StopQuerySchema, request, invalid, response, success: 200,
  args: input => ({ ...stopWorkspace(input), p_payload: input.body }), description,
});
const stopWorkspace = (input: IdentityInput) => input.query.workspace_id ? { p_workspace_id: input.query.workspace_id } : {};

export const senderControlDefinitions = {
  settings_get: {
    method: "GET", route: "/v1/workspace/outreach-settings", cli: { operation: "settings-get" }, rpc: "get_lifty_workspace_settings",
    path: Empty, query: Empty, request: null, invalid, response: c.WorkspaceSettingsResultSchema, success: 200, args: () => ({}),
    description: "Read how this workspace assigns new leads (equal, founder_weight or tier_a_founder, and its founder), the handoff sample size and the review policy, with their versions. Read-only.",
  },
  settings_patch: {
    method: "PATCH", route: "/v1/workspace/outreach-settings", cli: { operation: "settings-patch" }, rpc: "update_lifty_workspace_settings",
    path: Empty, query: Empty, request: c.WorkspaceSettingsPatchSchema, invalid: outreachInvalid, response: c.WorkspaceSettingsResultSchema, success: 200,
    args: input => ({ p_payload: input.body }),
    description: "Change assignment, handoff sample size and/or review with expected_version (0 until the first save); review carries its own expected_version. All of it commits or refuses together. founder_weight and tier_a_founder need a founder_sender_id who is on. Applies to new leads and new handoffs; leads already assigned stay put. Never sends.",
  },
  transfer_scope: {
    method: "GET", route: "/v1/workspace/senders/{id}/transfer-scope", cli: { operation: "transfer-scope" }, rpc: "get_lifty_sender_transfer_scope",
    path: IdPath, query: Empty, request: null, invalid, response: c.TransferScopeSchema, success: 200, args: input => ({ p_sender_id: input.path.id }),
    description: "Before a retire, read how it is expected to divide this person's leads: not_contacted would move to the replacement, and conversations would wait for a sample; replies are already inside conversations. Never add the groups or call them all of the person's leads: a contacted lead with nothing to continue is in neither. It is an estimate made before a target is chosen, and it assumes the replacement can send email, so show it as what to expect. What a retire actually did is in its receipt. Read-only.",
  },
  handoff_get: handoff("handoff_get", "GET", "", "get_lifty_sender_handoff",
    "Read one handoff by the handoff_ref from retire or recovery: source and replacement, sample with real drafts, cohort and remainder, what is held for a person (held_for_human), and each member's dispatch_reason. sample_complete says whether it can be approved. Approved and queued are not sent. Read-only.", null, () => ({})),
  handoff_prepare: handoff("handoff_prepare", "POST", "/prepare", "prepare_lifty_sender_handoff",
    "Ask Lifty to finish preparing this handoff's sample and remaining members. Prepares drafts only: it approves nothing, moves no contacted lead and sends nothing. Repeat freely; drafts arrive on their own, so read handoff_get.", null, () => ({})),
  handoff_approve: handoff("handoff_approve", "POST", "/approve", "approve_lifty_sender_handoff",
    "With the user's explicit yes, approve this exact sample and transfer the contacted conversations to the replacement, using the current revision and hashes from handoff_get and confirm:true. One approval covers the sample and each remaining first message, never a future reply. Refused when the sample is incomplete or anything changed; read handoff_get again. Only authorization.state authorized means approved. Approved is not sent: messages go out on their schedule under ordinary checks.",
    c.HandoffApproveSchema, input => ({ p_payload: input.body })),
  handoff_cancel: handoff("handoff_cancel", "POST", "/cancel", "cancel_lifty_sender_handoff",
    "Cancel a handoff that is waiting, with its revision and confirm:true. An approved handoff cannot be canceled: 409 HANDOFF_ALREADY_APPROVED, and nothing changes. Untouched leads that already moved stay moved, and the person stays retired. Idempotent.",
    c.HandoffCancelSchema, input => ({ p_payload: input.body })),
  handoff_settings_revise: handoff("handoff_settings_revise", "POST", "/settings", "revise_lifty_sender_handoff_settings",
    "Change the instructions Lifty writes this handoff's first messages with, using its current revision. Every draft is written again, and approval is needed again. Never sends.",
    c.HandoffSettingsSchema, input => ({ p_payload: input.body })),
  handoff_reply_revise: handoff("handoff_reply_revise", "POST", "/replies/{turn_ref}", "revise_lifty_sender_handoff_reply",
    "Edit one current-reply draft in the sample, with its turn_version and draft_event_ref from handoff_get. Text is the unsigned body; Lifty adds the replacement's signature. Approval is needed again. Never sends.",
    c.HandoffReplySchema, input => ({ p_turn_id: input.path.turn_ref, p_payload: input.body }), c.HandoffReplyPath),
  stops_get: {
    method: "GET", route: stopsRoute, cli: { operation: "stops-get" }, rpc: "get_lifty_stops", path: Empty, query: c.StopQuerySchema, request: null, invalid,
    response: c.StopsResultSchema, success: 200, args: stopWorkspace,
    description: "LIFT admins only; members get 403 ADMIN_REQUIRED. List active Lifty stops with who set each one and its note. workspace_id names a workspace you are not a member of. Read-only.",
  },
  stop_set: stop("stop-set", "", "set_lifty_stop", c.StopSetSchema, c.StopResultSchema,
    "LIFT admins only; members get 403 ADMIN_REQUIRED. Stop sends at one scope with a reason. review_by defaults to seven days from the stop. A later write keeps its original since."),
  stop_release: stop("stop-release", "/release", "release_lifty_stop", c.StopReleaseSchema, c.StopReleaseResultSchema,
    "LIFT admins only; members get 403 ADMIN_REQUIRED. Release a stop at this exact scope. Repeating it changes nothing (released false). Other stops and pauses stay."),
  stop_review: stop("stop-review", "/review", "move_lifty_stop_review", c.StopReviewSchema, c.StopResultSchema,
    "LIFT admins only; members get 403 ADMIN_REQUIRED. Move a stop's review date to a future date. 404 STOP_NOT_FOUND when nothing is stopped there."),
} satisfies Record<string, IdentityDefinition>;

export const accountControlDefinitions = {
  incidents_get: {
    method: "GET", route: "/v1/workspace/recovery-incidents", cli: { operation: "incidents-get" }, rpc: "get_lifty_recovery_incidents",
    path: Empty, query: Empty, request: null, invalid, response: c.RecoveryIncidentsSchema, success: 200, args: () => ({}),
    description: "Read open and applied inbox recovery incidents: the account, cause, severity, since, due_at (the earliest Lifty may act), next_step (the words to show), and handoff_ref with handoff_pending when a sample waits, even after the inbox recovered. counts is a plan and may be null; only moved says work moved. Never promise that work will move. Read-only.",
  },
  action: {
    method: "GET", route: "/v1/workspace/sending-accounts/{id}/action", cli: { operation: "action" }, rpc: "get_lifty_sending_accounts",
    path: IdPath, query: c.AccountActionQuery, request: null, invalid, response: c.AccountActionSchema, success: 200, args: () => ({ p_query: {} }),
    description: "Resolve a notification's link to this account: whether the reconnect or warmup action still applies, and the operation that performs it. Opening it changes nothing. An account outside the selected workspace is 404. Read-only.",
  },
} satisfies Record<string, IdentityDefinition>;

/** Whether a notification's action still applies to this account. */
export function accountActionAvailable(account: z.output<typeof AccountsGetSchema>["accounts"][number], action: "reconnect" | "warmup") {
  return action === "reconnect" ? account.status !== "connected" : account.channel === "email" && account.status === "connected";
}
