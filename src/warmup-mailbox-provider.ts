import { z } from "zod";
import type { AccountProviderSettings } from "./account-provider.js";
import { PublicError } from "./errors.js";
import { UnipileTransport } from "./unipile-transport.js";
import { createUnipileV2Provider } from "./unipile-v2-provider.js";

function connectionRequired(): never {
  throw new PublicError({ status: 409, code: "WARMUP_CONNECTION_REQUIRED",
    message: "Lifty could not verify this mailbox. Check the email connection before setting up warmup." });
}
function verificationPending(): never {
  throw new PublicError({ status: 503, code: "WARMUP_VERIFICATION_PENDING",
    message: "Lifty could not check this mailbox yet. Try the warmup setup link again shortly." });
}

/** Selects a provider from authenticated mailbox evidence, never its domain:
 * the bound Unipile V2 account and its verified primary sender. A transport
 * still on the retired V1 API asks for the email connection again. */
export function createWarmupMailboxIdentifier(settings: AccountProviderSettings) {
  const v2 = createUnipileV2Provider({ ...settings.v2,
    ...(settings.fetchImpl ? { fetchImpl: settings.fetchImpl } : {}),
    ...(settings.timeoutMs !== undefined ? { timeoutMs: settings.timeoutMs } : {}),
  });

  return async (value: UnipileTransport, email: string): Promise<"google" | "microsoft"> => {
    const parsed = UnipileTransport.safeParse(value);
    if (!parsed.success || !z.email().safeParse(email).success) connectionRequired();
    const transport = parsed.data, expected = email.toLowerCase();
    if (!transport.account_id || !transport.canonical_account_id) connectionRequired();
    try {
      if (transport.api_version === "v2") {
        const identity = await v2.readEmailIdentity(transport.account_id, transport, expected);
        if (!identity.healthy || identity.email !== expected) connectionRequired();
        return identity.type === "OUTLOOK" ? "microsoft" : "google";
      }
      connectionRequired();
    } catch (error) {
      if (error instanceof PublicError) {
        if (["WARMUP_CONNECTION_REQUIRED", "WARMUP_VERIFICATION_PENDING"].includes(error.code)) throw error;
        if (["UNIPILE_IDENTITY_MISMATCH", "UNIPILE_ACCOUNT_NOT_FOUND", "UNIPILE_MAILBOX_UNVERIFIABLE"].includes(error.code)) connectionRequired();
      }
      verificationPending();
    }
  };
}
