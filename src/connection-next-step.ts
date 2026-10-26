import type { AppDependencies, AuthSession } from "./app.js";
import { BusinessGetSchema } from "./business-contracts.js";
import { SendersGetSchema } from "./identity-contracts.js";
import { NextStepSchema, type NextStep } from "./next-step-contracts.js";
import { PublicError } from "./errors.js";

/** A connection rehearsal never requires Scout, campaign approval or warmup. */
export async function getConnectionNextStep(
  dependencies: Pick<AppDependencies, "businessOperation" | "identityOperation">,
  session: AuthSession,
): Promise<NextStep> {
  const business = BusinessGetSchema.parse(await dependencies.businessOperation(session, "business.get"));
  const workspace = business.workspace;
  const result = (state: NextStep["state"], step: "business" | "email", reason: string, actions: string[], tools: string[], saved: Record<string, unknown> | null = null) =>
    NextStepSchema.parse({ state, step, reason, section: step === "business" ? "leads" : "email",
      actions, gates: null, workspace_ref: workspace?.workspace_ref ?? null, recommended_tools: tools,
      guide: { purpose: "Create your workspace and connect your email. Campaigns, sending and warmup are unavailable in this environment." },
      context_task: step === "business" ? "business" : "senders", related_contexts: step === "business" ? ["senders"] : ["sending-accounts"],
      saved, receipt: null });
  if (!workspace || !business.profile) return result("action_required", "business", "workspace_missing",
    ["Confirm the business name and create the workspace with business_post."], ["business_post", "business_get"]);
  if (workspace.state === "suspended") return result("blocked", "business", "workspace_suspended",
    ["This workspace is suspended. Ask the workspace operator to restore access."], ["business_get"]);
  const roster = SendersGetSchema.parse((await dependencies.identityOperation(session, "senders.get", { path: {}, query: {}, body: undefined })).body);
  if (roster.workspace?.workspace_ref !== workspace.workspace_ref) throw new PublicError({
    status: 403, code: "WORKSPACE_FORBIDDEN", message: "Workspace state changed. Read the current workspace again.",
  });
  const account = roster.senders.flatMap(sender => sender.accounts).find(account => account.channel === "email" && account.status === "connected");
  if (account) return result("complete", "email", "email_connected",
    ["The mailbox connection is recorded. Sending and warmup remain unavailable."], ["senders_get", "sending_accounts_get"],
    { account_id: account.id, identity: account.identity, observation: account.observation.state,
      checked_at: account.checked_at, sending_available: false, sends: null });
  if (!roster.senders.length) return result("action_required", "email", "sender_missing",
    ["Ask who owns the mailbox and create that person with senders_post."], ["senders_post", "senders_get"]);
  return result("action_required", "email", "email_connection_needed",
    ["Connect the person's email with sending_accounts_connect. Open Lifty's returned link, complete consent, and read the same durable attempt until Lifty confirms the mailbox identity."],
    ["sending_accounts_connect", "sending_accounts_attempt", "senders_get"], { sender_id: roster.senders[0]!.id });
}
