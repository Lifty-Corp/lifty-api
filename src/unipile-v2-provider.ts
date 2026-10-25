import type { EmailProvider } from "./connect-state.js";
import { connectionFetch, noteProviderError } from "./connection-confirmation.js";
import { z } from "zod";
import { PublicError } from "./errors.js";
import { parseHostedAuthOrigin } from "./hosted-auth-branding.js";
import { ProviderIdentifier, type UnipileTransport, type VerifiedTransport } from "./unipile-transport.js";

export type LinkedinHealth = "running" | "credentials" | "locked" | "disconnected" | "errored" | "unknown";
export interface LinkedinIdentity {
  accountId: string; profileId: string; profileUrl: string | null; displayName: string | null;
  healthy: boolean; healthStatus: LinkedinHealth;
}

export interface UnipileV2Settings {
  accessToken: string;
  applicationId: string;
  /** Include earlier verified domains until every outstanding link has expired. */
  hostedAuthOrigins: string[];
}
const Account = z.object({
  object: z.literal("Account"), id: ProviderIdentifier, application_id: ProviderIdentifier,
  account_scope_id: ProviderIdentifier.nullish(), user_id: z.string().min(1).max(255),
  provider: z.enum(["linkedin", "google", "outlook", "imap"]), oauth_scope: z.string().nullish(),
  status: z.enum(["running", "errored", "disconnected", "degraded", "partial"]), is_locked: z.boolean(),
  metadata: z.object({ v1_account_id: ProviderIdentifier.optional(),
    products_connection_status: z.record(z.string(), z.enum(["running", "disconnected", "errored"])).optional() }),
});
// A refused hosted link names its documented error type; only that code is kept.
// https://developer.unipile.com/v2.0/reference/error-responses
const HostedLinkError = z.object({object: z.literal("Error"), type: z.string().max(100)});
const Senders = z.object({data: z.array(z.object({object: z.literal("EmailSender"), email: z.email(),
  is_primary: z.boolean(), verification_status: z.enum(["verified", "pending", "unknown"])})),
  next_cursor: z.string().nullish(), total_count: z.number().int().nonnegative().optional()});
// Unipile V2 methods-scope: Outlook sending creates a draft, so Mail.Send
// also requires Mail.ReadWrite. Account.oauth_scope lists granted permissions.
const outlookScopes = ["User.Read", "Mail.ReadWrite", "Mail.Send"];
// A hosted link may request only the application's checked Microsoft methods
// scopes; Unipile refuses any other with api/invalid_parameters. Unipile adds
// User.Read itself, so a granted account still carries every scope above.
const outlookRequestedScopes = ["Mail.ReadWrite", "Mail.Send"];
function hasOutlookMailScopes(scope: string | null | undefined) {
  const granted = new Set((scope ?? "").split(/[,\s]+/).map(value => value.replace(/^https:\/\/graph\.microsoft\.com\//, "")));
  return outlookScopes.every(value => granted.has(value));
}
const Profile = z.object({object: z.literal("UserProfile"), provider: z.literal("linkedin"),
  id: ProviderIdentifier, type: z.literal("individual"), display_name: z.string().max(400),
  profile_url: z.string().optional(), public_identifier: z.string().optional(),
  specifics: z.object({network_distance: z.literal("SELF")})});

/** V2 never falls back to V1 credentials or accepts account.name as mailbox evidence. */
export function createUnipileV2Provider(settings: UnipileV2Settings & {fetchImpl?: typeof fetch; timeoutMs?: number}) {
  if (!settings.accessToken.trim() || !ProviderIdentifier.safeParse(settings.applicationId).success) throw new Error("Invalid Unipile V2 configuration.");
  const origins = settings.hostedAuthOrigins.map(origin => parseHostedAuthOrigin(origin));
  if (!origins.length || origins.includes("https://account.unipile.com") || origins.includes("https://auth.unipile.com")) throw new Error("Invalid Unipile V2 hosted origin.");
  const fetchImpl = connectionFetch(settings.fetchImpl ?? fetch);
  const timeoutMs = settings.timeoutMs ?? 15_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) throw new Error("Invalid Unipile V2 timeout.");
  function fail(code = "UNIPILE_UNAVAILABLE", status = 502): never {
    throw new PublicError({code, status, message: "LIFTY could not verify this connection. Check status and reconnect if needed."});
  }
  async function request(path: string, body?: Record<string, unknown>, method: "GET" | "POST" | "DELETE" = body ? "POST" : "GET", deadline?: AbortSignal): Promise<unknown> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    const signal = deadline ? AbortSignal.any([controller.signal, deadline]) : controller.signal;
    try {
      const response = await fetchImpl(`https://api.unipile.com/v2/${path}`, {
        method, redirect: "error", signal,
        headers: {"X-API-KEY": settings.accessToken, accept: "application/json", ...(body ? {"content-type": "application/json"} : {})},
        ...(body ? {body: JSON.stringify(body)} : {}),
      });
      if (!response.ok) {
        // Unipile refused to create the link: asking again gets the same answer.
        if (path === "auth/link" && [400, 401, 403, 422].includes(response.status)) {
          const error = HostedLinkError.safeParse(await json(response, signal, 16_384).catch(() => null));
          if (error.success) noteProviderError(error.data.type);
          fail("UNIPILE_HOSTED_REJECTED");
        }
        void response.body?.cancel().catch(() => {});
        if (response.status === 404) fail("UNIPILE_ACCOUNT_NOT_FOUND", 409);
        fail();
      }
      return await json(response, signal, 1_048_576);
    } catch (error) {
      if (error instanceof PublicError) throw error;
      fail();
    } finally {clearTimeout(timer);}
  }
  async function json(response: Response, signal: AbortSignal, limit: number): Promise<unknown> {
    if (!response.body) fail();
    const chunks: Uint8Array[] = []; let size = 0;
    await response.body.pipeTo(new WritableStream<Uint8Array>({write(chunk) {
      size += chunk.byteLength; if (size > limit) fail(); chunks.push(chunk);
    }}), {signal});
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  }
  function validateTransport(transport: UnipileTransport) {
    if (transport.api_version !== "v2" || transport.application_id !== settings.applicationId
      || !origins.includes(transport.hosted_auth_origin)) fail("UNIPILE_IDENTITY_MISMATCH", 409);
  }
  async function readAccount(accountId: string, transport: UnipileTransport, channel: "email" | "linkedin") {
    validateTransport(transport);
    if (!ProviderIdentifier.safeParse(accountId).success || (transport.account_id && accountId !== transport.account_id)) fail("UNIPILE_IDENTITY_MISMATCH", 409);
    const result = Account.safeParse(await request(`accounts/${encodeURIComponent(accountId)}`));
    if (!result.success) fail();
    const account = result.data;
    if (account.id !== accountId || account.application_id !== transport.application_id
      || (account.account_scope_id ?? null) !== transport.account_scope_id
      || (channel !== "linkedin" && transport.user_id && account.user_id !== transport.user_id)
      || (transport.v1_account_id && account.metadata.v1_account_id !== transport.v1_account_id)
      || (transport.canonical_account_id && transport.provider_namespace !== `unipile:v2:${transport.application_id}`
        && account.metadata.v1_account_id !== transport.canonical_account_id)
      || ((channel === "linkedin") !== (account.provider === "linkedin"))) fail("UNIPILE_IDENTITY_MISMATCH", 409);
    const verifiedTransport: VerifiedTransport = {api_version: "v2", account_id: account.id,
      application_id: account.application_id, account_scope_id: account.account_scope_id ?? null,
      user_id: account.user_id, owner_profile_id: null, v1_account_id: account.metadata.v1_account_id ?? null};
    const products = account.metadata.products_connection_status;
    const gmailStatus = products ? products.gmail : account.status;
    const healthy = !account.is_locked && (account.provider === "outlook"
      ? hasOutlookMailScopes(account.oauth_scope) && account.status === "running"
        && (!products || (Object.keys(products).length > 0 && Object.values(products).every(status => status === "running")))
      : channel === "email"
      ? ["running", "partial", "degraded"].includes(account.status) && gmailStatus === "running"
      : account.status === "running" && (!products || Object.values(products).every(status => status === "running")));
    const healthStatus: LinkedinIdentity["healthStatus"] = account.is_locked ? "locked" : healthy ? "running"
      : account.status === "disconnected" ? "disconnected" : account.status === "errored" || account.status === "degraded" ? "errored" : "unknown";
    return {account, verifiedTransport, healthy, healthStatus};
  }
  async function createLink(input: {channel: "email" | "linkedin"; emailProvider?: EmailProvider | undefined; state: string; redirectUri: string; expiresAt: string; transport: UnipileTransport}) {
    validateTransport(input.transport);
    const origin = input.transport.hosted_auth_origin;
    const raw = await request("auth/link", {
      ...(input.transport.account_id ? {account_id: input.transport.account_id} : {providers: input.channel === "linkedin" ? ["linkedin"] : input.emailProvider ? [input.emailProvider] : ["google", "outlook"]}),
      ...(input.channel === "email" ? {config: {outlook: {oauth_scope: outlookRequestedScopes}}} : {}),
      ...(input.transport.account_scope_id ? {account_scope_id: input.transport.account_scope_id} : {}),
      domain: new URL(origin).hostname,
      expires_on: input.expiresAt, redirect_uri: input.redirectUri, state: input.state,
    });
    const parsed = z.object({object: z.literal("HostedAuthLink"), link: z.url()}).safeParse(raw);
    if (!parsed.success) fail("UNIPILE_HOSTED_RESPONSE_INVALID");
    const link = new URL(parsed.data.link);
    if (link.origin !== origin || link.username || link.password || link.hash || link.port) fail("UNIPILE_HOSTED_URL_INVALID");
    return link.toString();
  }
  async function readEmailIdentity(accountId: string, transport: UnipileTransport, expectedEmail?: string | null) {
    const {account, verifiedTransport, healthy} = await readAccount(accountId, transport, "email");
    // V2 EmailSender.is_primary is documented as the address used to authenticate
    // Google/Outlook. Aliases and delegated addresses cannot replace this proof.
    // IMAP still lacks equivalent authenticated endpoint evidence.
    if (account.provider !== "google" && account.provider !== "outlook") fail("UNIPILE_MAILBOX_UNVERIFIABLE", 409);
    // An unhealthy provider may reject profile calls. A previously verified
    // mailbox can still be reported unhealthy without inventing fresh proof.
    const type = account.provider === "outlook" ? "OUTLOOK" as const : "GOOGLE_OAUTH" as const;
    const gmailStatus = account.provider === "google" ? account.metadata.products_connection_status?.gmail ?? account.status : account.status;
    const healthStatus = account.is_locked ? "locked" : healthy ? "running"
      : account.status === "disconnected" || gmailStatus === "disconnected" ? "disconnected"
      : account.status === "errored" || gmailStatus === "errored" ? "errored" : "unknown";
    if (!healthy && expectedEmail) return {accountId:transport.canonical_account_id ?? accountId,
      email:expectedEmail.toLowerCase(),type,healthy:false,healthStatus,verifiedTransport};
    const parsed = Senders.safeParse(await request(`${encodeURIComponent(accountId)}/email-senders`));
    if (!parsed.success || parsed.data.next_cursor || (parsed.data.total_count !== undefined && parsed.data.total_count !== parsed.data.data.length)) fail();
    const primaries = parsed.data.data.filter(sender => sender.is_primary);
    // is_primary proves the authenticated address. Outlook can report unknown
    // per-address sending readiness even for that primary; pending is never ready.
    // https://developer.unipile.com/v2.0/reference/getemailsenders
    if (primaries.length !== 1 || (primaries[0]!.verification_status !== "verified"
      && !(account.provider === "outlook" && primaries[0]!.verification_status === "unknown"))) fail("UNIPILE_MAILBOX_UNVERIFIABLE", 409);
    const email = primaries[0]!.email.toLowerCase();
    if (expectedEmail && expectedEmail.toLowerCase() !== email) fail("UNIPILE_IDENTITY_MISMATCH", 409);
    return {accountId: transport.canonical_account_id ?? accountId, email, type, healthy, healthStatus, verifiedTransport};
  }
  async function readLinkedinIdentity(accountId: string, transport: UnipileTransport, expectedProfileId?: string | null) {
    const {account, verifiedTransport, healthy, healthStatus} = await readAccount(accountId, transport, "linkedin");
    const retainedOwner = transport.owner_profile_id;
    if ((transport.canonical_account_id && !retainedOwner)
      || (retainedOwner && expectedProfileId && retainedOwner !== expectedProfileId)) fail("UNIPILE_IDENTITY_MISMATCH", 409);
    const canonical = transport.canonical_account_id ?? accountId;
    // A disconnected connection can retain its established owner, but an
    // unverified new connection must never infer ownership from Account.user_id.
    if (!healthy) {
      if (!retainedOwner) fail();
      if (account.user_id === transport.user_id) return {accountId: canonical, profileId: retainedOwner, profileUrl: null, displayName: null, healthy, healthStatus, verifiedTransport};
    }
    // Copied Account.user_id may contain mutable display metadata. Report its
    // current value, but only authenticated SELF proves the LinkedIn owner.
    // Even unhealthy accounts must provide SELF if that metadata has changed.
    const parsed = Profile.safeParse(await request(`${encodeURIComponent(accountId)}/users/me`));
    if (!parsed.success) fail();
    if ((retainedOwner && parsed.data.id !== retainedOwner)
      || (expectedProfileId && parsed.data.id !== expectedProfileId)) fail("UNIPILE_IDENTITY_MISMATCH", 409);
    verifiedTransport.owner_profile_id = parsed.data.id;
    let profileUrl: string | null = null;
    try {
      const url = new URL(parsed.data.profile_url ?? `https://www.linkedin.com/in/${parsed.data.public_identifier ?? ""}/`);
      if (url.protocol === "https:" && ["linkedin.com", "www.linkedin.com"].includes(url.hostname)
        && !url.username && !url.password && !url.port && !url.hash && !url.search && /^\/in\/[A-Za-z0-9_%~-]+\/?$/.test(url.pathname)) profileUrl = url.toString();
    } catch { /* Optional display metadata. */ }
    return {accountId: canonical, profileId: parsed.data.id, profileUrl, displayName: parsed.data.display_name || null, healthy, healthStatus, verifiedTransport};
  }
  /** Removes Lifty's access to exactly this V2 account. A 404 means it is already gone. */
  async function deleteAccount(accountId: string, deadline?: AbortSignal): Promise<"deleted" | "not_found"> {
    if (!/^acc_[A-Za-z0-9_-]{1,251}$/.test(accountId)) fail("UNIPILE_IDENTITY_MISMATCH", 409);
    try { await request(`accounts/${encodeURIComponent(accountId)}`, undefined, "DELETE", deadline); return "deleted"; }
    catch (error) { if (error instanceof PublicError && error.code === "UNIPILE_ACCOUNT_NOT_FOUND") return "not_found"; throw error; }
  }
  return {createLink, readEmailIdentity, readLinkedinIdentity, deleteAccount};
}
