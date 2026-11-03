import { describe, expect, it } from "vitest";
import type { AccountProviderSettings } from "../src/account-provider.js";
import { withConnectionDeadline } from "../src/connection-confirmation.js";
import { createWarmupMailboxIdentifier } from "../src/warmup-mailbox-provider.js";
import type { UnipileTransport } from "../src/unipile-transport.js";

const email = "owner@business.test";
const settings: AccountProviderSettings = {
  v2: { accessToken: "v2-secret", applicationId: "app_test", hostedAuthOrigins: ["https://connect.lifty.test"] },
};
const v1: UnipileTransport = {
  api_version: "v1", connection_ref: "13850000-0000-4000-8000-000000000001",
  canonical_account_id: "legacy_mailbox", account_id: "legacy_mailbox", provider_namespace: "organization-scope",
  application_id: null, account_scope_id: null, user_id: null, owner_profile_id: null, v1_account_id: null,
  generation: 0, hosted_auth_origin: "https://account.unipile.com",
};
const v2: UnipileTransport = { ...v1, api_version: "v2", account_id: "acc_test", application_id: "app_test",
  account_scope_id: "scope_test", user_id: "owner", v1_account_id: "legacy_mailbox", hosted_auth_origin: "https://connect.lifty.test" };
const v2Account = { object: "Account", id: "acc_test", application_id: "app_test", account_scope_id: "scope_test",
  user_id: "owner", provider: "google", status: "running", is_locked: false,
  metadata: { v1_account_id: "legacy_mailbox", products_connection_status: { gmail: "running" } } };
const senders = { data: [{ object: "EmailSender", email, is_primary: true, verification_status: "verified" }] };
const required = { status: 409, code: "WARMUP_CONNECTION_REQUIRED" };
const pending = { status: 503, code: "WARMUP_VERIFICATION_PENDING" };
function harness(options: { account?: unknown; senders?: unknown; settings?: Partial<AccountProviderSettings>;
  fetch?: typeof fetch } = {}) {
  const calls: { url: URL; init: RequestInit | undefined }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push({ url, init });
    if (options.fetch) return options.fetch(input, init);
    return Response.json(url.pathname.endsWith("email-senders") ? options.senders ?? senders
      : options.account ?? v2Account);
  };
  return { calls, identify: createWarmupMailboxIdentifier({ ...settings, ...options.settings, fetchImpl }) };
}

describe("warmup provider identification on the bound V2 account", () => {
  it.each(["google", "outlook"])("uses V2 primary %s proof, with identical domains", async provider => {
    const f = harness({ account: { ...v2Account, provider, oauth_scope: "User.Read,Mail.ReadWrite,Mail.Send",
      metadata: { ...v2Account.metadata, products_connection_status: { [provider === "google" ? "gmail" : "outlook"]: "running" } } } });
    expect(await f.identify(v2, email)).toBe(provider === "outlook" ? "microsoft" : "google");
    expect(f.calls.map(call => call.url.toString())).toEqual([
      "https://api.unipile.com/v2/accounts/acc_test", "https://api.unipile.com/v2/acc_test/email-senders",
    ]);
    expect(f.calls.every(call => (call.init?.headers as Record<string, string>)["X-API-KEY"] === "v2-secret")).toBe(true);
  });
  it("asks for the email connection again for a retired V1 transport, without provider access", async () => {
    const f = harness();
    await expect(f.identify(v1, email)).rejects.toMatchObject(required);
    expect(f.calls).toHaveLength(0);
  });
  it.each([
    { account_scope_id: "scope_foreign" }, { application_id: "app_foreign" }, { user_id: "other-owner" },
    { id: "acc_other" }, { metadata: { v1_account_id: "other-account" } }, { provider: "imap" }, { is_locked: true },
  ])("retains the V2 application/scope/owner and primary policy: %j", async patch => {
    await expect(harness({ account: { ...v2Account, ...patch } }).identify(v2, email)).rejects.toMatchObject(required);
  });
  it("requires Outlook mail grants and a verified primary on V2", async () => {
    await expect(harness({ account: { ...v2Account, provider: "outlook", oauth_scope: "User.Read,Calendars.ReadWrite" } }).identify(v2, email)).rejects.toMatchObject(required);
    await expect(harness({ account: v2Account, senders: { data: [{ ...senders.data[0], verification_status: "unknown" }] } }).identify(v2, email)).rejects.toMatchObject(required);
  });
  it("sanitizes upstream errors and invalid/oversized responses without provider selection", async () => {
    for (const respond of [
      () => new Response("private-provider-body", { status: 503 }),
      () => new Response("private-provider-body", { status: 403 }),
      () => new Response("private-provider-body", { status: 200 }),
      () => new Response("x".repeat(1_048_577)),
    ]) {
      const f = harness({ fetch: async () => respond() });
      await expect(f.identify(v2, email)).rejects.toMatchObject(pending);
      await expect(f.identify(v2, email)).rejects.not.toHaveProperty("message", expect.stringContaining("private-provider-body"));
    }
  });
  it("inherits the shared confirmation deadline for provider requests", async () => {
    let aborted = false;
    const f = harness({ settings: { timeoutMs: 1000 }, fetch: async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("private-provider-body")); }, { once: true });
    }) });
    await expect(withConnectionDeadline(10, () => f.identify(v2, email))).rejects.toMatchObject(pending);
    expect(aborted).toBe(true);
  });
});
