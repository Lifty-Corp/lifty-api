import { z } from "zod";

import type { AnalyticsReads, WorkspaceGroupFacts } from "./analytics.js";
import type { AuthSession } from "./app.js";
import { listMemberWorkspaces } from "./member-workspaces.js";
import { getWorkspaceStatus } from "./workspace-operations.js";

/**
 * LIF-1663: the `workspace` group's properties, read with the founder's own
 * session through the member RPCs that already exist. The database selects
 * the workspace (`get_lifty_workspace_status`), the membership list names it
 * (`lifty_member_workspaces`) and Billing resolves its plan
 * (`get_billing_state`, the same resolution the dashboard's plan page reads).
 * `analytics_class`, `assignment_authority` and `created_at` have no member
 * read yet; they stay absent until the database exposes them.
 */

const BillingPlanSchema = z.object({
  plan: z.object({ plan_key: z.string().min(1), kind: z.string().min(1) }).loose().nullable(),
}).loose();

interface RpcClient {
  rpc(name: string, args?: Record<string, unknown>): Promise<{ data: unknown; error: unknown }>;
}

async function readPlan(session: AuthSession, workspaceRef: string): Promise<Pick<WorkspaceGroupFacts, "plan_key" | "plan_kind">> {
  const { data, error } = await (session.client as RpcClient).rpc("get_billing_state", { p_workspace_id: workspaceRef, p_livemode: true });
  if (error) throw new Error("billing state unavailable");
  const plan = BillingPlanSchema.parse(data).plan;
  return plan ? { plan_key: plan.plan_key, plan_kind: plan.kind } : {};
}

export function createWorkspaceAnalyticsReads(): AnalyticsReads {
  return {
    workspace: async session => (await getWorkspaceStatus(session)).workspace?.workspace_ref ?? null,
    facts: async (session, workspaceRef) => {
      const [members, plan] = await Promise.allSettled([listMemberWorkspaces(session), readPlan(session, workspaceRef)]);
      if (members.status === "rejected" && plan.status === "rejected") throw members.reason;
      const membership = members.status === "fulfilled"
        ? members.value.workspaces.find(workspace => workspace.workspace_ref === workspaceRef) : undefined;
      return {
        ...(membership ? { name: membership.name, slug: membership.slug } : {}),
        ...(plan.status === "fulfilled" ? plan.value : {}),
      };
    },
  };
}
