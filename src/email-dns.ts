import { z } from "zod";
import type { AuthSession } from "./app.js";
import { EmailDnsStatus, StoredDnsStatus, type EmailDnsInput } from "./email-dns-contracts.js";
import { PublicError } from "./errors.js";

type RpcClient = { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> };

const rpcMessages: Record<string, { status: number; message: string }> = {
  unauthenticated: { status: 401, message: "Sign in again to continue." },
  email_invalid_request: { status: 400, message: "Choose a workspace and an email account." },
  email_workspace_forbidden: { status: 403, message: "Choose a workspace you belong to." },
  email_workspace_suspended: { status: 409, message: "This workspace is paused. Resume it before checking DNS again." },
  email_connection_required: { status: 409, message: "Connect this workspace's email account before checking DNS." },
};
const unavailable = () => new PublicError({ status: 502, code: "EMAIL_DNS_UNAVAILABLE", message: "LIFTY could not read or change this DNS check. Retry shortly." });

function mapRpcError(error: unknown): never {
  const parsed = z.object({ message: z.string().optional() }).safeParse(error);
  const message = parsed.success ? parsed.data.message ?? "" : "";
  const known = Object.hasOwn(rpcMessages, message) ? rpcMessages[message] : undefined;
  if (!known) throw unavailable();
  throw new PublicError({ status: known.status, code: message.toUpperCase(), message: known.message });
}

function present({ fixes, ...stored }: StoredDnsStatus): EmailDnsStatus {
  return EmailDnsStatus.parse({ ...stored, fixes: fixes.map(({ adminUrl, adminLabel, ...fix }) => ({ ...fix,
    ...(adminUrl ? { admin_url: adminUrl } : {}), ...(adminLabel ? { admin_label: adminLabel } : {}) })) });
}

/** The session-scoped RPC authorizes the member, workspace and exact account. */
export function createEmailDnsOperations() {
  async function call(session: AuthSession, operation: "status" | "recheck", input: EmailDnsInput): Promise<EmailDnsStatus> {
    const client = session.client as RpcClient;
    let response: { data: unknown; error: unknown };
    try { response = await client.rpc("lifty_email_dns", { p_operation: operation, p_payload: input }); }
    catch { throw unavailable(); }
    if (response.error) mapRpcError(response.error);
    const parsed = StoredDnsStatus.safeParse(response.data);
    if (!parsed.success || parsed.data.connection_ref !== input.connection_ref) throw unavailable();
    return present(parsed.data);
  }
  return {
    status: (session: AuthSession, input: EmailDnsInput) => call(session, "status", input),
    recheck: (session: AuthSession, input: EmailDnsInput) => call(session, "recheck", input),
  };
}
export type EmailDnsOperations = ReturnType<typeof createEmailDnsOperations>;
