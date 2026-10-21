import { z } from "zod";
import type { AuthSession } from "./app.js";
import { PublicError } from "./errors.js";

export const RetireWorkspaceRequest = z
  .object({
    workspace_ref: z.uuid(),
    confirm_slug: z.string().regex(/^[a-z0-9_-]{1,100}$/),
    confirm_name: z.string().min(1).max(200),
  })
  .strict();
export const RetireWorkspaceConfirmation = RetireWorkspaceRequest.omit({
  workspace_ref: true,
});
export const RetireWorkspaceResult = z.object({
  workspace_ref: z.uuid(),
  slug: z.string().min(1),
  name: z.string().min(1),
  state: z.literal("deleted"),
  budget_preserved: z.literal(true),
});
export type RetireWorkspaceInput = z.infer<typeof RetireWorkspaceRequest>;
export type RetireWorkspaceOutput = z.infer<typeof RetireWorkspaceResult>;
const messages: Record<string, string> = {
  workspace_forbidden: "Only a workspace member or LIFT admin can retire this workspace. Sign in with an authorized account.",
  workspace_history_retained:
    "This workspace has business history and cannot be retired. Preserve its records and disconnect integrations to stop provider access.",
  workspace_identity_mismatch:
    "The workspace ID, slug and name do not match. Read its current identity before retiring it.",
  workspace_cross_tenant_reference:
    "This workspace has shared references that prevent safe retirement. Contact LIFT support.",
  workspace_retirement_blocked:
    "The workspace cannot be safely retired yet. Contact LIFT support.",

  workspace_linkedin_retention_required:
    "LinkedIn v1 cannot retire a workspace with a bound account or LinkedIn history. Disconnect LinkedIn to stop sending; historical sending limits and account records must be retained.",
  workspace_email_disconnect_required:
    "Disconnect email through LIFTY before retiring this workspace.",
  workspace_integration_disconnect_required:
    "Disconnect every integration through Lifty before retiring this workspace.",
  workspace_integration_revocation_pending:
    "Integration authorization revocation is still pending. Wait for it to finish before retrying retirement.",
  email_service_forbidden:
    "The workspace retirement service is unavailable. Contact LIFT support.",
  unauthenticated: "Sign in to LIFTY before retiring a workspace.",
};
function failed(error: unknown): never {
  const parsed = z
    .object({ code: z.string().optional(), message: z.string().optional() })
    .safeParse(error);
  const code = parsed.success ? (parsed.data.message ?? "") : "";
  const known = Object.hasOwn(messages, code);
  const status =
    known &&
    parsed.success &&
    /^PT(400|401|403|409)$/.test(parsed.data.code ?? "")
      ? Number(parsed.data.code!.slice(2))
      : 502;
  throw new PublicError({
    status,
    code: known ? code.toUpperCase() : "WORKSPACE_RETIREMENT_UNAVAILABLE",
    message: known
      ? messages[code]!
      : "LIFTY could not confirm workspace retirement. Retry the same exact identity; do not choose a different workspace.",
  });
}
export function createWorkspaceRetirement() {
  return async (
    session: AuthSession,
    input: RetireWorkspaceInput,
  ): Promise<RetireWorkspaceOutput> => {
    const payload = RetireWorkspaceRequest.parse(input);
    const client = session.client as {
      rpc(
        name: string,
        args: Record<string, unknown>,
      ): Promise<{ data: unknown; error: unknown }>;
    };
    let result;
    try {
      result = await client.rpc("retire_lifty_workspace", {
        p_payload: payload,
      });
    } catch {
      failed(null);
    }
    if (result.error) failed(result.error);
    const parsed = RetireWorkspaceResult.safeParse(result.data);
    if (
      !parsed.success ||
      parsed.data.workspace_ref !== payload.workspace_ref ||
      parsed.data.slug !== payload.confirm_slug ||
      parsed.data.name !== payload.confirm_name
    )
      failed(null);
    return parsed.data;
  };
}
