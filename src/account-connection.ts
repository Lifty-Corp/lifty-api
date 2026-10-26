import type { EmailSetup } from "./email-connect-setup.js";
import { z } from "zod";
import { connectionFetch, type ConfirmationAttention, type ConfirmationResult } from "./connection-confirmation.js";
import { openConnectAttempt, openConnectProvider, sealConnectAttempt, type EmailProvider, type ConnectChannel } from "./connect-state.js";
import { createAccountProvider, IdentityMismatch, ProviderTransport, type AccountProviderSettings, type ExpectedIdentity } from "./account-provider.js";
import { HostedReturnError } from "./hosted-return-error.js";
import { parseHostedAuthOrigin } from "./hosted-auth-branding.js";
import { unipileV2AuthState } from "./unipile-v2-state.js";
import { PublicError } from "./errors.js";
import { AccountConnectionProgress, type Account } from "./identity-contracts.js";

// One controller for every sending-account connection: the browser connect
// page, the shared confirmation shell, the attempt read's reconciliation and
// access revocation all converge on the same durable attempt/account through
// the trusted provider RPC. Member authorization happens before any call here.
export interface AccountConnectionSettings {
  publicBaseUrl: string;
  dashboardOrigin?: string;
  connectionOnly?: boolean;
  emailSetup?: EmailSetup;
  supabaseUrl: string;
  publishableKey: string;
  /** Existing per-channel server keys; the database checks them per attempt/account channel. */
  serverKeys: Partial<Record<ConnectChannel, string>>;
  provider: AccountProviderSettings;
  fetchImpl?: typeof fetch;
}
const Uuid = z.uuid();
const Snapshot = z.object({
  attempt: z.object({
    id: Uuid, channel: z.enum(["email", "linkedin"]), reconnect: z.boolean(),
    sender: z.object({ id: Uuid, name: z.string() }).strip(),
    expected_identity: z.union([z.object({ email: z.email() }).strict(), z.object({ profile_id: z.string().min(1) }).strict()]).nullable(),
    internal_state: z.enum(["pending", "ready", "completed", "failed"]),
    state: z.enum(["pending", "connected", "failed", "expired"]),
    reason: z.enum(["canceled", "account_in_use", "identity_mismatch", "provider_rejected"]).nullable(),
    declaration: z.record(z.string(), z.unknown()).nullable(),
    expires_at: z.iso.datetime({ offset: true }),
    hosted_url: z.string().nullable(),
    progress: AccountConnectionProgress,
  }).strip(),
  transport: ProviderTransport,
  authorization: z.object({ received: z.boolean(), account_id: z.string().nullable(), return_error: HostedReturnError.nullable() }).strip(),
}).strip();
type Snapshot = z.infer<typeof Snapshot>;
const RevocationContext = z.object({ revocable: z.boolean(), transport: ProviderTransport.nullable() }).strip();
const Conflict = z.discriminatedUnion("conflict", [
  z.object({ conflict: z.enum(["none", "live_here", "live_elsewhere", "released", "kept"]) }).strip(),
  z.object({ conflict: z.literal("retained"), account_id: Uuid }).strip(),
]);
export type ConnectOutcome =
  | { kind: "declare"; senderName: string }
  | { kind: "redirect"; url: string }
  | { kind: "checking" }
  | { kind: "preparing" };
export type EmailDeclaration = { mailbox_use: "habitual" | "dedicated" };
export type LinkedinDeclaration = { habitual_personal_account: true; no_other_automation: true };

// Database tokens become vendor-neutral browser errors. 4xx are final for the
// page; anything else is unknown and may be retried by reading again.
const tokens: Record<string, [number, string, string]> = {
  account_attempt_expired: [410, "CONNECT_LINK_EXPIRED", "This link expired. Ask Lifty for a new connection link."],
  account_attempt_unavailable: [409, "CONNECT_LINK_ENDED", "This connection attempt has ended. Return to Lifty to check it."],
  account_declaration_required: [409, "CONNECT_DECLARATION_REQUIRED", "Answer the questions on the connection page first."],
  account_declaration_conflict: [409, "CONNECT_DECLARATION_CONFLICT", "This link already has an answer. Continue with it, or ask Lifty for a new link."],
  account_provider_forbidden: [400, "CONNECT_LINK_INVALID", "Open the connection link from Lifty."],
  account_provider_invalid_request: [400, "CONNECT_LINK_INVALID", "Open the connection link from Lifty."],
  connection_attempt_not_found: [400, "CONNECT_LINK_INVALID", "Open the connection link from Lifty."],
  account_not_found: [404, "ACCOUNT_NOT_FOUND", "This account is not available."],
};
function rpcError(body: unknown): PublicError {
  const message = z.object({ message: z.string() }).safeParse(body);
  const known = message.success ? tokens[message.data.message.trim().toLowerCase()] : undefined;
  return known ? new PublicError({ status: known[0], code: known[1], message: known[2] })
    : new PublicError({ status: 502, code: "CONNECT_UNAVAILABLE", message: "Lifty could not reach its connection service. Try again shortly." });
}
const linkInvalid = () => new PublicError({ status: 400, code: "CONNECT_LINK_INVALID", message: "Open the connection link from Lifty." });
const failureReason = { canceled: "canceled", account_in_use: "exists", identity_mismatch: "verification", provider_rejected: "provider" } as const;

export function createAccountConnection(settings: AccountConnectionSettings) {
  for (const key of Object.values(settings.serverKeys)) if (key && key.length < 32) throw new Error("Invalid connection server key.");
  const provider = createAccountProvider(settings.provider);
  const hostedOrigins = settings.provider.v2.hostedAuthOrigins.map(origin => parseHostedAuthOrigin(origin));
  const fetchImpl = connectionFetch(settings.fetchImpl ?? fetch);
  const key = (channel: ConnectChannel) => {
    const value = settings.serverKeys[channel];
    if (!value) throw new PublicError({ status: 503, code: "CONNECT_UNAVAILABLE", message: "This connection type is not available." });
    return value;
  };

  async function call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(15_000);
    let response: Response;
    try {
      response = await fetchImpl(`${settings.supabaseUrl}/rest/v1/rpc/${name}`, {
        method: "POST", redirect: "error", signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
        headers: { apikey: settings.publishableKey, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(args),
      });
    } catch { throw rpcError(null); }
    let body: unknown;
    try { body = await response.json(); } catch { throw rpcError(null); }
    if (!response.ok) throw rpcError(body);
    return body;
  }
  const rpc = (channel: ConnectChannel, operation: string, payload: Record<string, unknown>, signal?: AbortSignal) =>
    call("lifty_sending_account_provider", { p_server_key: key(channel), p_operation: operation, p_payload: payload }, signal);
  const snapshot = async (channel: ConnectChannel, operation: string, payload: Record<string, unknown>) => {
    const parsed = Snapshot.safeParse(await rpc(channel, operation, payload));
    if (!parsed.success || parsed.data.attempt.channel !== channel) throw rpcError(null);
    return parsed.data;
  };
  const open = (channel: ConnectChannel, intent: string) => {
    try { return openConnectAttempt(channel, intent, key(channel)); } catch (error) {
      if (error instanceof PublicError) throw error;
      throw linkInvalid();
    }
  };
  const hosted = (target: string) => {
    let url: URL;
    try { url = new URL(target); } catch { throw rpcError(null); }
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash || !hostedOrigins.includes(url.origin)) throw rpcError(null);
    return url.toString();
  };

  // Entry documents only read local durable state. Provider work starts after
  // the shared shell is visible, through its bounded process request.
  function handoff(current: Snapshot): ConnectOutcome {
    const attempt = current.attempt;
    if (attempt.internal_state === "completed" || current.authorization.received) return { kind: "checking" };
    if (attempt.state === "expired") throw rpcError({ message: "account_attempt_expired" });
    if (attempt.state === "failed") throw rpcError({ message: "account_attempt_unavailable" });
    if (!attempt.declaration) return { kind: "declare", senderName: attempt.sender.name };
    if (attempt.hosted_url) return { kind: "redirect", url: hosted(attempt.hosted_url) };
    return { kind: "preparing" };
  }

  // A hosted link connects nothing: an account exists only after someone signs
  // in through a link Lifty showed them, and every link of an attempt carries
  // its deterministic auth state. So whenever no link is stored, ask for one;
  // the first one saved wins. A failure leaves nothing to recover: the page's
  // next status check simply asks again.
  async function signIn(channel: ConnectChannel, intent: string, current: Snapshot): Promise<ConfirmationResult> {
    const { attempt } = current;
    if (attempt.state !== "pending" || !attempt.declaration || attempt.hosted_url || current.authorization.received) return result(current);
    try {
      const state = unipileV2AuthState(channel, attempt.id, key(channel));
      const url = hosted(await provider.createLink({ channel, state, transport: current.transport, expiresAt: attempt.expires_at,
        emailProvider: openConnectProvider(channel, intent, key(channel)),
        redirectUri: `${settings.publicBaseUrl}/connect/${channel}/return?intent=${encodeURIComponent(intent)}` }));
      return result(await snapshot(channel, "link", { attempt_id: attempt.id, state, url }));
    } catch (error) {
      // The attempt stays open and the next check asks again, but a refusal
      // is not shown as a sign-in that is still being prepared.
      const pending = result(current);
      return error instanceof PublicError && error.code === "UNIPILE_HOSTED_REJECTED" && pending.status === "pending"
        ? { ...pending, attention: "sign_in_unavailable" } : pending;
    }
  }

  /** Open the sign-in for a declared attempt, or finish one already authorized. */
  async function prepare(channel: ConnectChannel, intent: string): Promise<ConfirmationResult> {
    const current = await snapshot(channel, "context", { attempt_id: open(channel, intent) });
    return signIn(channel, intent, await reconcile(channel, current));
  }

  // Finish an authorization the provider signed for this attempt. Only verified
  // identity completes it; an unready provider leaves it pending.
  async function reconcile(channel: ConnectChannel, current: Snapshot): Promise<Snapshot> {
    const { attempt, authorization } = current;
    if (!authorization.received || !authorization.account_id || attempt.internal_state === "completed" || attempt.internal_state === "failed") return current;
    let verified;
    try {
      verified = await provider.verify({ channel, accountId: authorization.account_id, transport: current.transport,
        expected: attempt.expected_identity as ExpectedIdentity });
    } catch (error) {
      if (!(error instanceof IdentityMismatch)) throw error;
      return snapshot(channel, "fail", { attempt_id: attempt.id, reason: "identity_mismatch" });
    }
    if (!verified) return current;
    return snapshot(channel, "complete", { attempt_id: attempt.id, verified });
  }
  // Remove Lifty's access to one disconnected account; true only with provider evidence.
  async function release(account: Pick<Account, "id" | "channel">, signal: AbortSignal): Promise<boolean> {
    try {
      const context = RevocationContext.parse(await rpc(account.channel, "revocation_context", { account_id: account.id }, signal));
      const providerAccountId = context.transport?.account_id;
      if (!context.revocable || !context.transport || !providerAccountId) return false;
      const evidence = await provider.revoke({ transport: context.transport, providerAccountId, signal });
      await rpc(account.channel, "revocation_confirmed", { account_id: account.id, provider_account_id: providerAccountId, evidence }, signal);
      return true;
    } catch { return false; }
  }
  // Why the provider refused the sign-in. Unipile names the existing account
  // only for api/already_exists; a retained account Lifty no longer uses is
  // removed now so the same attempt can be retried. Any failure here only
  // makes the explanation less specific.
  async function explain(channel: ConnectChannel, attemptId: string, hint: HostedReturnError, accountRef?: string): Promise<ConfirmationAttention> {
    if (hint === "authorization_cancelled") return "canceled";
    if (hint !== "account_exists") return "provider";
    if (!accountRef) return "exists";
    let conflict: z.infer<typeof Conflict>;
    try {
      conflict = Conflict.parse(await call(settings.connectionOnly ? "lifty_connection_account_conflict" : "lifty_sending_account_conflict",
        { p_server_key: key(channel), p_attempt_id: attemptId, p_account_id: accountRef }));
    } catch { return "exists"; }
    switch (conflict.conflict) {
      case "live_here": return "already_connected";
      case "live_elsewhere": return "in_use";
      case "released": return "released";
      case "retained": return await release({ id: conflict.account_id, channel }, AbortSignal.timeout(6_000)) ? "released" : "exists";
      default: return "exists";
    }
  }
  function result(current: Snapshot): ConfirmationResult {
    const { attempt } = current;
    if (attempt.internal_state === "completed" || attempt.state === "connected") return { status: "connected", account: null, reference: attempt.id };
    if (attempt.state === "failed") return { status: "failed", reason: attempt.reason ? failureReason[attempt.reason] : "ended", reference: attempt.id };
    if (attempt.state === "expired") return { status: "failed", reason: "ended", reference: attempt.id };
    if (attempt.progress.stage === "sign_in_required") {
      if (!attempt.hosted_url) throw rpcError(null);
      hosted(attempt.hosted_url);
    }
    return { status: "pending", progress: attempt.progress, reference: attempt.id };
  }

  return {
    emailSetup: settings.emailSetup ?? {},
    dashboardOrigin: settings.dashboardOrigin,
    selectEmailProvider: (intent: string, provider: EmailProvider) => sealConnectAttempt("email", open("email", intent), key("email"), provider),
    connectionUrl: (channel: ConnectChannel, attemptId: string) =>
      `${settings.publicBaseUrl}/connect/${channel}?intent=${encodeURIComponent(sealConnectAttempt(channel, attemptId, key(channel)))}`,
    validate: (channel: ConnectChannel, intent: string) => { open(channel, intent); },
    /** GET connect page: declaration form, provider handoff, or receipt. */
    async page(channel: ConnectChannel, intent: string): Promise<ConnectOutcome> {
      const id = open(channel, intent);
      return handoff(await snapshot(channel, "context", { attempt_id: id }));
    },
    /** POST connect page: record the person's declaration, then hand off. */
    async declare(channel: ConnectChannel, intent: string, declaration: EmailDeclaration | LinkedinDeclaration): Promise<ConnectOutcome> {
      const id = open(channel, intent);
      return handoff(await snapshot(channel, "declare", { attempt_id: id, declaration }));
    },
    prepare,
    /** Confirmation shell status: the same evidence as the attempt read. */
    async confirm(channel: ConnectChannel, intent: string, returnError: HostedReturnError | null, accountRef?: string): Promise<ConfirmationResult> {
      const id = open(channel, intent);
      let current = await snapshot(channel, "context", { attempt_id: id });
      // A provider-reported error explains a missing authorization; it never
      // overrides a signed one and leaves the attempt open.
      const hint = returnError ?? current.authorization.return_error;
      if (hint && !current.authorization.received && current.attempt.internal_state !== "completed") {
        if (current.attempt.internal_state === "ready" && current.authorization.return_error !== hint) {
          await rpc(channel, "return_error", { attempt_id: id, return_error: hint });
        }
        // Browser hints are not terminal evidence. Keep polling so a delayed
        // authorization can still establish the authoritative outcome.
        const pending = result(current);
        return pending.status === "pending" ? { ...pending, attention: await explain(channel, id, hint, accountRef) } : pending;
      }
      return signIn(channel, intent, await reconcile(channel, current));
    },
    async reconcileAttempt(channel: ConnectChannel, attemptId: string): Promise<void> {
      await reconcile(channel, await snapshot(channel, "context", { attempt_id: attemptId }));
    },
    /**
     * Remove Lifty's access to locally blocked accounts, one at a time, until
     * the shared deadline. Only provider evidence confirms; everything else
     * stays unconfirmed for a retry of the same request.
     */
    async revoke(accounts: Account[], signal: AbortSignal): Promise<void> {
      for (const account of accounts) {
        if (signal.aborted) return;
        await release(account, signal); // unconfirmed releases continue with the remaining budget
      }
    },
  };
}
export type AccountConnection = ReturnType<typeof createAccountConnection>;
