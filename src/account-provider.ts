import type { EmailProvider } from "./connect-state.js";
import { z } from "zod";
import { PublicError } from "./errors.js";
import { ProviderIdentifier, type UnipileTransport } from "./unipile-transport.js";
import { createUnipileV2Provider, type UnipileV2Settings } from "./unipile-v2-provider.js";

// The single provider adapter behind Lifty's sending-account connections.
// Provider names, account ids and transports never leave this module and the
// trusted database RPC; customers only see Lifty routes and canonical ids.
export const ProviderTransport = z.object({
  api_version: z.enum(["v1", "v2"]),
  application_id: ProviderIdentifier.nullable(),
  account_scope_id: ProviderIdentifier.nullable(),
  provider_namespace: z.string().min(1),
  hosted_auth_origin: z.url().nullable().optional(),
  account_id: ProviderIdentifier.nullable(),
  generation: z.number().int().nonnegative(),
}).strip();
export type ProviderTransport = z.infer<typeof ProviderTransport>;
export type ExpectedIdentity = { email: string } | { profile_id: string } | null;
/** Proof for the provider RPC `complete` operation. */
export type VerifiedAuthorization =
  | { api_version: "v2"; application_id: string; account_scope_id: string | null; account_id: string; user_id: string; email: string; mailbox_provider: "google" | "microsoft" }
  | { api_version: "v2"; application_id: string; account_scope_id: string | null; account_id: string; user_id: string; profile_id: string; profile_url?: string };
/** The authorization proves a different mailbox/profile or binding. */
export class IdentityMismatch extends Error {}

export interface AccountProviderSettings {
  v2: UnipileV2Settings;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createAccountProvider(settings: AccountProviderSettings) {
  const v2 = createUnipileV2Provider({ ...settings.v2, ...(settings.fetchImpl ? { fetchImpl: settings.fetchImpl } : {}),
    ...(settings.timeoutMs ? { timeoutMs: settings.timeoutMs } : {}) });

  // Only database-returned transports reach the provider; unknown fields stay null.
  function transport(value: ProviderTransport, origin?: string | null): UnipileTransport {
    return { api_version: value.api_version, connection_ref: null, canonical_account_id: null,
      provider_namespace: value.provider_namespace, account_id: value.account_id, application_id: value.application_id,
      account_scope_id: value.account_scope_id, user_id: null, owner_profile_id: null, v1_account_id: null,
      generation: value.generation, hosted_auth_origin: origin ?? value.hosted_auth_origin ?? "" };
  }
  const identityError = (error: unknown) => error instanceof PublicError
    && error.code === "UNIPILE_IDENTITY_MISMATCH";

  return {
    async createLink(input: { channel: "email" | "linkedin"; emailProvider?: EmailProvider | undefined; state: string; redirectUri: string; expiresAt: string; transport: ProviderTransport }) {
      if (input.transport.api_version !== "v2" || !input.transport.hosted_auth_origin) throw new PublicError({ status: 503, code: "CONNECT_UNAVAILABLE", message: "Lifty cannot open a sign-in link for this account." });
      return v2.createLink({ channel: input.channel, emailProvider: input.emailProvider, state: input.state, redirectUri: input.redirectUri,
        expiresAt: input.expiresAt, transport: transport(input.transport) });
    },
    /**
     * Verify the signed authorization's account. Returns null while the
     * provider is not ready (still pending); throws IdentityMismatch when it
     * proves another identity; provider outages throw and leave the attempt open.
     */
    async verify(input: { channel: "email" | "linkedin"; accountId: string; transport: ProviderTransport; expected: ExpectedIdentity }): Promise<VerifiedAuthorization | null> {
      const bound = transport(input.transport);
      try {
        if (input.channel === "email") {
          const expected = input.expected && "email" in input.expected ? input.expected.email : null;
          const identity = await v2.readEmailIdentity(input.accountId, bound, expected);
          if (!identity.healthy) return null;
          const t = identity.verifiedTransport;
          return { api_version: "v2", application_id: t.application_id, account_scope_id: t.account_scope_id,
            account_id: t.account_id, user_id: t.user_id, email: identity.email,
            // Authenticated evidence; customer DNS guidance never reads it from the domain.
            mailbox_provider: identity.type === "OUTLOOK" ? "microsoft" : "google" };
        }
        const expected = input.expected && "profile_id" in input.expected ? input.expected.profile_id : null;
        const identity = await v2.readLinkedinIdentity(input.accountId, bound, expected);
        if (!identity.healthy) return null;
        const t = identity.verifiedTransport;
        return { api_version: "v2", application_id: t.application_id, account_scope_id: t.account_scope_id,
          account_id: t.account_id, user_id: t.user_id, profile_id: identity.profileId,
          ...(identity.profileUrl ? { profile_url: identity.profileUrl } : {}) };
      } catch (error) {
        if (identityError(error)) throw new IdentityMismatch();
        if (error instanceof PublicError && ["UNIPILE_ACCOUNT_NOT_FOUND", "UNIPILE_MAILBOX_UNVERIFIABLE"].includes(error.code)) return null;
        throw error;
      }
    },
    /** Remove Lifty's access to exactly this provider account within the caller's deadline.
     * Only Unipile V2 accounts can be removed; the V1 API is retired (LIF-1617). */
    async revoke(input: { transport: ProviderTransport; providerAccountId: string; signal: AbortSignal }): Promise<"deleted" | "not_found"> {
      if (input.transport.api_version !== "v2") throw new PublicError({ status: 503, code: "REVOCATION_UNAVAILABLE", message: "Access removal is not configured." });
      return v2.deleteAccount(input.providerAccountId, input.signal);
    },
  };
}
export type AccountProvider = ReturnType<typeof createAccountProvider>;
