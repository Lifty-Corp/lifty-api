import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { AuthSession } from "./app.js";
import { PublicError } from "./errors.js";
import { rpcFailure } from "./rpc-errors.js";
import * as contracts from "./identity-contracts.js";

// LIF-1182 Identity: senders and their sending accounts. Every definition is a
// catalog operation (HTTP route, MCP tool, CLI noun, public context). Member
// RPCs resolve the workspace from the session's x-lifty-workspace header with
// the shared database rule (p_workspace_id null); the admin onboarding read
// names the workspace instead (AuthSession.workspaceRef, LIF-1302). Provider work (links,
// verifying an authorization, revoking access) is delegated to the account
// connector; reads never call it except the attempt read, which may finish a
// binding the person already authorized.
const Empty = z.object({}).strict();
export type IdentityInput = { path: Record<string, string>; query: Record<string, unknown>; body: unknown };
export interface IdentityDefinition {
  method: "GET" | "POST" | "PATCH";
  /** Override the method default when a GET can persist provider reconciliation. */
  readOnly?: boolean;
  route: string;
  cli?: { operation: string };
  rpc: string;
  connectionRpc?: string;
  path: z.ZodType;
  query: z.ZodType;
  request: z.ZodType | null;
  invalid: { status: 400 | 422; code: string };
  response: z.ZodType;
  /** 201 for creation; 202 when the local block committed but provider revocation is unconfirmed. */
  success: 200 | 201 | 202;
  args(input: IdentityInput): Record<string, unknown>;
  description: string;
}
const invalidRequest = { status: 400, code: "INVALID_REQUEST" } as const;
const senderInvalid = { status: 422, code: "SENDER_INVALID" } as const;
const path = (input: IdentityInput) => input.path.id;
const sendersRoute = "/v1/workspace/senders";
const accountsRoute = "/v1/workspace/sending-accounts";
const accountAction = (action: "pause" | "resume", description: string): IdentityDefinition => ({
  method: "POST", route: `${accountsRoute}/{id}/${action}`, cli: { operation: action },
  rpc: `${action}_lifty_sending_account`, path: contracts.IdPath, query: Empty, request: null,
  invalid: invalidRequest, response: contracts.AccountResultSchema, success: 200,
  args: input => ({ p_account_id: path(input) }), description,
});

export const identityOperationDefinitions = {
  senders: {
    get: {
      method: "GET", route: sendersRoute, rpc: "get_lifty_senders", connectionRpc: "get_lifty_connection_senders", path: Empty, query: Empty, request: null,
      invalid: invalidRequest, response: contracts.SendersGetSchema, success: 200, args: () => ({}),
      description: "Read the selected workspace's senders (named people) with their name, signature, booking link, version and every account they own, including disconnected history. Find a known person here and use the returned id; names are not identifiers. Deleted senders are not listed. Read-only.",
    },
    post: {
      method: "POST", route: sendersRoute, rpc: "create_lifty_sender", connectionRpc: "create_lifty_connection_sender", path: Empty, query: Empty,
      request: contracts.SenderCreateSchema, invalid: senderInvalid, response: contracts.SenderResultSchema, success: 201,
      args: input => ({ p_payload: input.body }),
      description: "Create a new person at version 1 with no accounts. Only for someone absent from the senders roster: it never looks up or reuses a person by name, and two people may share a name. Signature is the founder's own words (plain text, at most 500 characters, links only with https). Never connects, activates or sends. After a lost response read the roster before retrying.",
    },
    patch: {
      method: "PATCH", route: `${sendersRoute}/{id}`, rpc: "patch_lifty_sender", path: contracts.IdPath, query: Empty,
      request: contracts.SenderPatchSchema, invalid: senderInvalid, response: contracts.SenderPatchResultSchema, success: 200,
      args: input => ({ p_sender_id: path(input), p_payload: input.body }),
      description: "Change name, signature and/or booking_url with expected_version. Omitted fields stay; null clears signature or booking_url. A new signature signs newly prepared emails and recomposes still-unapproved previews (recomposing counts them); approved emails keep their exact text. Never sends.",
    },
    delete: {
      method: "POST", route: `${sendersRoute}/{id}/delete`, cli: { operation: "delete" }, rpc: "delete_lifty_sender",
      path: contracts.IdPath, query: Empty, request: contracts.SenderDeleteSchema, invalid: invalidRequest,
      response: contracts.SenderDeleteResultSchema, success: 202,
      args: input => ({ p_sender_id: path(input), p_payload: input.body }),
      description: "Soft-delete a person with expected_version and confirm:true. The person leaves the roster and every account they own is disconnected exactly as sending-accounts disconnect; history stays. 200 when Lifty's access was confirmed removed for every account (or not applicable), 202 when the accounts are blocked and removal at the provider continues on its own: do not repeat the request. Not reversible.",
    },
  },
  "sending-accounts": {
    get: {
      method: "GET", route: accountsRoute, rpc: "get_lifty_sending_accounts", connectionRpc: "get_lifty_connection_accounts", path: Empty,
      query: contracts.AccountsQuerySchema, request: null, invalid: invalidRequest,
      response: contracts.AccountsGetSchema, success: 200, args: input => ({ p_query: input.query }),
      description: "Read sending accounts, optionally filtered by sender_id and channel, including disconnected history: connection status, usage state (active/paused), sending (allowed now, else reason), daily limits, last verified check, observation (verified/unverified), access removal, declaration and sends. Read-only; never checks or changes a provider. Unverified means the last known facts are older than the freshness window, not a disconnection.",
    },
    connect: {
      method: "POST", route: `${accountsRoute}/connect`, cli: { operation: "connect" }, rpc: "connect_lifty_sending_account", connectionRpc: "connect_lifty_connection_account",
      path: Empty, query: Empty, request: contracts.ConnectSchema, invalid: invalidRequest,
      response: contracts.ConnectResultSchema, success: 200, args: input => ({ p_payload: input.body }),
      description: "Start connecting a LinkedIn account or mailbox for an existing sender_id (from the senders roster). Returns connection_url and durable progress: declaration_required, preparing, sign_in_required, verifying or complete. Until verifying, show connection_url: the connect page asks the declaration and opens the sign-in. A live attempt for the same sender and channel is reused (created:false), even when its link text changes; an expired one never blocks a new connect. The account exists only after verified authorization. Connecting never activates a campaign or sends.",
    },
    attempt: {
      method: "GET", route: `${accountsRoute}/attempts/{id}`, cli: { operation: "attempt" }, rpc: "get_lifty_sending_account_attempt",
      readOnly: false,
      path: contracts.IdPath, query: contracts.AttemptQuerySchema, request: null, invalid: invalidRequest,
      response: contracts.AttemptReadSchema, success: 200, args: input => ({ p_attempt_id: path(input) }),
      description: "Read one connection attempt with who acts next (action_owner), what is permitted (actions) and next_step. state: pending, connected (account_id), failed (reason) or expired. While the account owner still has to sign in, connection_url is the link to show. verifying means Lifty received the sign-in and finishes the connection/reconnection the user already requested on its own, even with every page closed; nobody signs in again. With wait_seconds (up to 25) the read returns as soon as the attempt changes. A failed or timed-out read is unknown, not a failed connection. Never creates a link or starts outreach. A connected mailbox's next_step is its warmup setup, a second sign-in by its owner.",
    },
    close_attempt: {
      method: "POST", route: `${accountsRoute}/attempts/{id}/close`, cli: { operation: "close-attempt" }, rpc: "close_lifty_sending_account_attempt",
      path: contracts.IdPath, query: Empty, request: null, invalid: invalidRequest,
      response: contracts.AttemptCloseResultSchema, success: 200, args: input => ({ p_attempt_id: path(input) }),
      description: "Close a connection attempt the person no longer wants: its link stops working at once. Idempotent. Never disconnects an account: a connected attempt stays connected (disposition connected). A sign-in Lifty already received is verified first; while Lifty can still verify it the attempt stays open (disposition recovering, retry_after). No confirmation needed.",
    },
    replace_attempt: {
      method: "POST", route: `${accountsRoute}/attempts/{id}/replace`, cli: { operation: "replace-attempt" }, rpc: "replace_lifty_sending_account_attempt",
      path: contracts.IdPath, query: Empty, request: null, invalid: invalidRequest,
      response: contracts.AttemptCloseResultSchema, success: 200, args: input => ({ p_attempt_id: path(input) }),
      description: "Close a stuck, failed or expired connection attempt and open one fresh attempt for the same person, channel and account: show successor.connection_url instead of the old link. Repeating it returns the same successor. A connected attempt or a sign-in Lifty can still verify gets no successor (disposition connected or recovering). Never disconnects an account or starts outreach. No confirmation needed.",
    },
    reconnect: {
      method: "POST", route: `${accountsRoute}/{id}/reconnect`, cli: { operation: "reconnect" }, rpc: "reconnect_lifty_sending_account",
      path: contracts.IdPath, query: Empty, request: null, invalid: invalidRequest,
      response: contracts.ConnectResultSchema, success: 200, args: input => ({ p_account_id: path(input) }),
      description: "Start a new authorization of this same account (same mailbox or LinkedIn profile); returns connection_url like connect and reuses its open reconnect attempt. Another identity fails with identity_mismatch. After needs_reconnect the usage state is kept; after disconnect the account returns paused until resumed. Never activates a campaign.",
    },
    pause: accountAction("pause", "Pause this account: nothing new is done with it until resumed; in-flight sends settle and its connection stays. Idempotent. Other accounts and campaigns are unchanged."),
    resume: accountAction("resume", "Resume this account (state active). An already active approved campaign may automatically send to external recipients through it, including pending work, when its connection and all existing readiness, schedule and incident gates allow. Does not approve or activate a campaign or release separate sending holds. Refused with ACCOUNT_DISCONNECTED when disconnected: reconnect first. Idempotent."),
    resume_campaigns: {
      method: "POST", route: `${accountsRoute}/{id}/resume-campaigns`, cli: { operation: "resume-campaigns" },
      rpc: "resume_lifty_disconnected_campaigns", path: contracts.IdPath, query: Empty,
      request: contracts.DisconnectSchema, invalid: invalidRequest,
      response: contracts.CampaignResumeResultSchema, success: 200,
      args: input => ({ p_account_id: path(input), p_payload: input.body }),
      description: "Explicitly resume LinkedIn campaigns recorded as paused by disconnect, with confirm:true. Requires the same verified identity, active account and no hold. Rechecks approval and safety per campaign; returns resumed/blocked results. Other pauses stay. Retries reuse actions. First pending steps become due now; follow-ups keep receipt-relative timing. Read disconnect_pause first. This permits sends.",
    },
    declare: {
      method: "POST", route: `${accountsRoute}/{id}/declare`, cli: { operation: "declare" }, rpc: "declare_lifty_sending_account_use",
      path: contracts.IdPath, query: Empty, request: contracts.DeclareUseSchema, invalid: invalidRequest,
      response: contracts.AccountResultSchema, success: 200,
      args: input => ({ p_account_id: path(input), p_payload: input.body }),
      description: "With the user's yes, switch a mailbox between habitual and dedicated. Dedicated waits for 21 active warmup days.",
    },
    disconnect: {
      method: "POST", route: `${accountsRoute}/{id}/disconnect`, cli: { operation: "disconnect" }, rpc: "disconnect_lifty_sending_account",
      path: contracts.IdPath, query: Empty, request: contracts.DisconnectSchema, invalid: invalidRequest,
      response: contracts.AccountResultSchema, success: 202,
      args: input => ({ p_account_id: path(input), p_payload: input.body }),
      description: "Disconnect this account with confirm:true: it is paused and disconnected at once (new sends stop; submitted sends keep their history), then Lifty requests removal of its access at the provider. 200 when removal is confirmed (access_revoked_at set) or not applicable, 202 when it is still unconfirmed: Lifty keeps removing it on its own, so do not repeat the request. Other accounts are unaffected.",
    },
  },
} satisfies Record<string, Record<string, IdentityDefinition>>;

export const identityEntries = () =>
  Object.entries(identityOperationDefinitions).flatMap(([resource, operations]) =>
    Object.entries(operations).map(([action, definition]) => ({
      key: `${resource}.${action}`, resource, action, definition: definition as IdentityDefinition,
    })));

/** Zod at the boundary; repair issues carry the failing path and a suggestion. */
export function validateIdentityInput(schema: z.ZodType, input: unknown, invalid: IdentityDefinition["invalid"]) {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new PublicError({
    status: invalid.status, code: invalid.code, message: "Repair these fields using the current operation schema.",
    issues: parsed.error.issues.slice(0, 20).map(issue => ({
      code: issue.code === "custom" ? "invalid_value" : `schema_${issue.code}`,
      path: `/${issue.path.map(part => String(part).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`,
      message: "This field does not match the current operation contract.",
      suggestion: issue.code === "custom" ? issue.message
        : issue.code === "unrecognized_keys" ? "Remove fields absent from the published operation schema."
          : "Use the field type and bounds shown in the current operation schema.",
    })),
  });
}

/** Provider orchestration owned by account-connection.ts. */
export interface AccountConnector {
  /** Lifty's connect page for this durable attempt. */
  connectionUrl(channel: contracts.Attempt["channel"], attemptId: string): string;
  /** Finish an authorization the person already gave; unknown outcomes stay pending. */
  reconcileAttempt(channel: contracts.Attempt["channel"], attemptId: string): Promise<void>;
  /** Request provider access removal for locally blocked accounts within one shared deadline. */
  revoke(accounts: contracts.Account[], signal: AbortSignal): Promise<void>;
}
/** Without a configured connection service: reads work, no link is issued, nothing is revoked. */
export const connectorUnavailable: AccountConnector = {
  connectionUrl: () => { throw new PublicError({ status: 503, code: "CONNECT_UNAVAILABLE", message: "Account connection is not available on this Lifty server." }); },
  reconcileAttempt: async () => {},
  revoke: async () => {},
};
export interface IdentityResult { status: 200 | 201 | 202; body: unknown }
// One total budget for provider revocation per request, however many accounts.
export const REVOCATION_BUDGET_MS = 20_000;
const unavailable = {
  code: "IDENTITY_UNAVAILABLE",
  message: "Identity state could not be verified. Read the senders or accounts again before retrying a change.",
};
type RpcClient = { rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> };
// The database also returns the channel of a started attempt so the link can
// name its connect page; it is not part of the public response.
const StartedAttempt = contracts.ConnectStartSchema.extend({ channel: contracts.Channel }).strip();

const REPLACE_MESSAGES: Partial<Record<contracts.Attempt["reason"] & string, string>> = {
  canceled: "The sign-in was canceled before it finished. When the person is ready, replace this attempt and show the successor's link.",
  identity_mismatch: "The person signed in with a different account than the one being reconnected. Replace this attempt and ask them to sign in with the intended profile or mailbox.",
  provider_rejected: "The provider declined this sign-in. Offer one new attempt by replacing this one; if it fails again, ask LIFT to review.",
  unverified: "Lifty received a sign-in but could not verify the account before its window ended. Replace this attempt so the person can sign in again.",
  closed: "This attempt was closed. Replace it only if the person wants to connect this account again.",
};

/**
 * The one outcome every client reads: who acts next, what is permitted and
 * the next step. The agent and the dashboard use this projection of the
 * durable attempt; the browser page shows the same state through its own
 * confirmation result. The connection profile closes close/replace.
 */
export function presentAttempt(attempt: contracts.Attempt, connector: AccountConnector,
  profile: "full" | "connections"): contracts.AttemptRead {
  const recoverable = profile === "full";
  // Close and replace are closed in the connection profile: never suggest them there.
  const orReplace = (text: string, replaceText: string) => recoverable ? `${text} ${replaceText}` : text;
  const read = (id: string, message: string, wait: boolean) => ({ operation: "sending_accounts_attempt" as const,
    path: { id }, ...(wait ? { query: { wait_seconds: 25 } } : {}), message });
  const replace = (message: string) => recoverable
    ? { next_step: { operation: "sending_accounts_replace_attempt" as const, path: { id: attempt.id }, message } } : {};
  const view = (owner: contracts.AttemptRead["action_owner"], actions: contracts.AttemptRead["actions"], extra: object = {}) =>
    contracts.AttemptReadSchema.parse({ ...attempt, action_owner: owner,
      actions: recoverable ? actions : actions.filter(action => action !== "close" && action !== "replace"), ...extra });

  if (attempt.state === "connected") {
    // Connecting a mailbox is only half of its setup: warmup and the placement
    // test need the owner's second consent, which an agent would otherwise miss
    // right where it reports success. warmup_start issues no link for a mailbox
    // whose warmup is already set up. The connection profile has no warmup.
    if (profile !== "full" || attempt.channel !== "email" || !attempt.account_id) return view("none", []);
    return view("agent", [], { next_step: {
      operation: "sending_accounts_warmup_start",
      body: { workspace: attempt.workspace.workspace_ref, connection_ref: attempt.account_id },
      message: "The mailbox is connected, but it cannot warm up or get its placement test until its owner signs in to it once more. Call sending_accounts_warmup_start once with this body now and, in the same reply, show its setup link as that second sign-in. Reuse the link while it is valid: another call replaces it. A null connect_url means this mailbox's warmup is already set up.",
    } });
  }
  if (attempt.state === "pending" && attempt.recovery) {
    if (attempt.recovery.state === "active") return view("lifty", ["wait"], { next_step: read(attempt.id,
      "Lifty received the sign-in and is verifying the account on its own, even if every page is closed. Nobody signs in again. Read this attempt again with this query until it changes.", true) });
    return view("lifty", ["wait", "close", "replace"], { next_step: read(attempt.id,
      orReplace("Lifty could not verify this sign-in for 30 minutes and LIFT has been alerted; Lifty keeps checking until the sign-in window ends.",
        "Keep waiting, or replace this attempt only if the person wants to sign in again."), true) });
  }
  if (attempt.state === "pending") {
    let url: string | undefined;
    try { url = connector.connectionUrl(attempt.channel, attempt.id); } catch { url = undefined; }
    return view("account_owner", ["open_link", "wait", "close", "replace"], { ...(url ? { connection_url: url } : {}),
      next_step: read(attempt.id, orReplace("Show connection_url to the account owner once, as a clickable link naming them; they answer the connect page and sign in. Then read this attempt again with this query until it changes.",
        "If the link does not open or they want a fresh one, replace this attempt."), true) });
  }
  if (attempt.state === "expired") {
    return view("agent", ["replace"], replace("This link expired before anyone signed in. Replace this attempt and show the successor's link."));
  }
  if (attempt.reason === "replaced" && attempt.replaced_by) {
    return view("agent", [], { next_step: read(attempt.replaced_by,
      "This attempt was replaced. Read its successor and show only the successor's link.", false) });
  }
  // Another workspace owns the account: no new link can fix it.
  if (attempt.reason === "account_in_use") return view("account_owner", []);
  return view("agent", ["replace"], replace(REPLACE_MESSAGES[attempt.reason ?? "closed"] ?? REPLACE_MESSAGES.closed!));
}

// Waiting reads poll the database only; recovery runs on the server either way.
const WAIT_POLL_MS = 2_000;
const MAX_WAITING_READS = 64;
let waitingReads = 0;
const fingerprint = (attempt: contracts.Attempt) =>
  [attempt.state, attempt.reason, attempt.progress.stage, attempt.recovery?.state, attempt.replaced_by].join("|");

export async function executeIdentityOperation(session: AuthSession, key: string, input: IdentityInput,
  connector: AccountConnector, signal?: AbortSignal, profile: "full" | "connections" = "full"): Promise<IdentityResult> {
  const entry = identityEntries().find(item => item.key === key);
  if (!entry) throw new Error("Unknown Identity operation");
  const { definition } = entry;
  const call = async (rpc: string, args: Record<string, unknown>) => {
    let result: { data: unknown; error: unknown };
    try { result = await (session.client as RpcClient).rpc(rpc, { p_workspace_id: session.workspaceRef ?? null, ...args }); }
    catch (cause) { throw rpcFailure(cause, { operation: rpc, ...unavailable }); }
    if (result.error) throw rpcFailure(result.error, { operation: rpc, ...unavailable });
    return result.data;
  };
  const verified = <T extends z.ZodType>(schema: T, value: unknown): z.output<T> => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new PublicError({ status: 502, ...unavailable });
    return parsed.data;
  };
  const readAttempt = async (id: string) =>
    verified(contracts.AttemptSchema, await call("get_lifty_sending_account_attempt", { p_attempt_id: id }));
  // Only an authorization the provider signed is reconciled; a provider or
  // verification failure leaves the attempt pending, and the server's
  // recovery keeps trying. The durable attempt decides the outcome.
  const reconcile = async (attempt: contracts.Attempt) => {
    if (attempt.state !== "pending" || attempt.progress.stage !== "verifying") return attempt;
    try { await connector.reconcileAttempt(attempt.channel, attempt.id); } catch { return attempt; }
    return readAttempt(attempt.id);
  };
  const started = (successor: { id: string; channel: contracts.Attempt["channel"]; workspace: unknown; expires_at: string; created: boolean },
    progress: contracts.Attempt["progress"]) => ({ workspace: successor.workspace, id: successor.id, expires_at: successor.expires_at,
    created: successor.created, progress, connection_url: connector.connectionUrl(successor.channel, successor.id) });

  if (key === "sending-accounts.close_attempt" || key === "sending-accounts.replace_attempt") {
    // A received sign-in is verified first, so closing returns verified
    // success instead of asking for another login when it can.
    await reconcile(await readAttempt(contracts.IdPath.parse(input.path).id));
    const receipt = verified(contracts.AttemptCloseReceiptSchema, await call(definition.rpc, definition.args(input)));
    const successor = receipt.successor ? started(receipt.successor, (await readAttempt(receipt.successor.id)).progress) : null;
    return { status: 200, body: verified(contracts.AttemptCloseResultSchema, { ...receipt,
      attempt: presentAttempt(receipt.attempt, connector, profile), successor }) };
  }
  const operationRpc = profile === "connections" && definition.connectionRpc ? definition.connectionRpc : definition.rpc;
  const data = await call(operationRpc, definition.args(input));
  if (key === "sending-accounts.connect" || key === "sending-accounts.reconnect") {
    const { channel, ...attemptStart } = verified(StartedAttempt, data);
    const attempt = await readAttempt(attemptStart.id);
    return { status: 200, body: verified(contracts.ConnectResultSchema, started({ ...attemptStart, channel }, attempt.progress)) };
  }
  if (key === "sending-accounts.attempt") {
    let attempt = await reconcile(verified(contracts.AttemptSchema, data));
    const wait = contracts.AttemptQuerySchema.parse(input.query).wait_seconds ?? 0;
    if (wait > 0) attempt = await waitForChange(attempt, wait);
    return { status: 200, body: presentAttempt(attempt, connector, profile) };
  }
  if (key === "sending-accounts.disconnect") {
    const receipt = verified(contracts.AccountResultSchema, data);
    const accounts = await revokeWithinBudget([receipt.account], receipt.account.sender_id);
    const account = accounts.find(item => item.id === receipt.account.id) ?? receipt.account;
    return { status: contracts.removalPending(account) ? 202 : 200, body: { ...receipt, account } };
  }
  if (key === "senders.delete") {
    const receipt = verified(contracts.SenderDeleteResultSchema, data);
    const latest = await revokeWithinBudget(receipt.accounts, receipt.sender.id);
    const accounts = receipt.accounts.map(account => latest.find(item => item.id === account.id) ?? account);
    return { status: accounts.some(contracts.removalPending) ? 202 : 200, body: { ...receipt, accounts } };
  }
  return { status: definition.success, body: verified(definition.response, data) };

  // Hold a read open while the attempt still waits on someone and has not
  // changed, polling the database only. A failed poll or a closed request
  // returns the last confirmed attempt.
  async function waitForChange(first: contracts.Attempt, seconds: number): Promise<contracts.Attempt> {
    if (first.state !== "pending" || waitingReads >= MAX_WAITING_READS) return first;
    waitingReads += 1;
    const deadline = Date.now() + Math.min(seconds * 1000, 22_000);
    let current = first;
    try {
      while (Date.now() + WAIT_POLL_MS <= deadline && !signal?.aborted) {
        await sleep(WAIT_POLL_MS, undefined, signal ? { signal } : undefined);
        current = await readAttempt(first.id);
        if (fingerprint(current) !== fingerprint(first)) break;
      }
    } catch { /* keep the last confirmed attempt */ } finally { waitingReads -= 1; }
    return current;
  }

  // The local block already committed. Provider work shares one deadline; a
  // failed readback keeps the committed receipt (revocation stays unconfirmed).
  async function revokeWithinBudget(accounts: contracts.Account[], senderId: string): Promise<contracts.Account[]> {
    const pending = accounts.filter(contracts.removalPending);
    if (!pending.length) return accounts;
    const budget = AbortSignal.timeout(REVOCATION_BUDGET_MS);
    try { await connector.revoke(pending, signal ? AbortSignal.any([signal, budget]) : budget); } catch { /* unconfirmed */ }
    try {
      return verified(contracts.AccountsGetSchema, await call("get_lifty_sending_accounts", { p_query: { sender_id: senderId } })).accounts;
    } catch { return accounts; }
  }
}
