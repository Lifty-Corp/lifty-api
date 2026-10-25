import { connectionFetch } from "./connection-confirmation.js";
import { z } from "zod";
import type { AuthSession } from "./app.js";
import { PublicError } from "./errors.js";
import { ConnectionAttemptStatusSchema } from "./stage-contracts.js";

export type ConnectionProvider = "hubspot" | "slack" | "attio";
export type ConnectionAttemptStatus = z.infer<typeof ConnectionAttemptStatusSchema>;

/** Read the existing durable provider intent through the caller's DB session. */
export async function getConnectionAttempt(session: AuthSession, provider: ConnectionProvider,
  attemptRef: string, workspace: string): Promise<ConnectionAttemptStatus> {
  const client = session.client as { rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> };
  let result;
  try {
    result = await client.rpc("get_lifty_connection_attempt", {
      p_provider: provider, p_attempt_ref: attemptRef, p_workspace: workspace,
    });
  } catch {
    throw new PublicError({ status: 502, code: "CONNECTION_ATTEMPT_UNAVAILABLE", message: "The authorization could not be verified. Retry the same attempt." });
  }
  if (result.error) {
    const error = z.object({ code: z.string().optional() }).safeParse(result.error);
    if (error.success && error.data.code === "PT404") {
      throw new PublicError({ status: 404, code: "CONNECTION_ATTEMPT_NOT_FOUND", message: "This authorization attempt is not available in the current workspace." });
    }
    throw new PublicError({ status: 502, code: "CONNECTION_ATTEMPT_UNAVAILABLE", message: "The authorization could not be verified. Retry the same attempt." });
  }
  const parsed = ConnectionAttemptStatusSchema.safeParse(result.data);
  if (!parsed.success || parsed.data.attempt_ref !== attemptRef) {
    throw new PublicError({ status: 502, code: "CONNECTION_ATTEMPT_UNAVAILABLE", message: "The authorization could not be verified. Retry the same attempt." });
  }
  return parsed.data;
}

// LIF-1282: the code a refused CRM callback records, keyed by its callback
// reason. The attempt read and the browser page show the same code.
export const CRM_REFUSAL_CODES: Readonly<Record<string, string>> = {
  portal_taken: "account_in_use", workspace_taken: "account_in_use", account_mismatch: "account_mismatch",
  scope_mismatch: "permission_missing", crm_provider_conflict: "crm_provider_conflict",
};

/** OAuth callbacks prove the intent with its decrypted token, never a public UUID. */
export async function recordOAuthFailure(input: {
  provider: ConnectionProvider; intentToken: string; status: "denied" | "failed"; code: string;
  supabaseUrl: string; publishableKey: string; fetchImpl: typeof fetch;
}): Promise<void> {
  const response = await connectionFetch(input.fetchImpl)(`${input.supabaseUrl}/rest/v1/rpc/fail_lifty_connect_attempt`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: { apikey: input.publishableKey, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ p_provider: input.provider, p_intent_token: input.intentToken,
      p_status: input.status, p_error_code: input.code }),
  });
  if (!response.ok) throw new Error("Could not record the authorization outcome.");
}
