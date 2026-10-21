import { z } from "zod";
import type { AppDependencies, AuthSession } from "./app.js";
import { PublicError } from "./errors.js";
import { BASE_CONTEXTS, NEXT_STEP_CATALOG, ON_REQUEST_CONTEXTS, getNextStep, nextStepGuide } from "./next-step.js";

// LIF-1297: the ops onboarding view. A LIFT admin's own session lists every
// workspace and computes each one's next_step with the same code founders use,
// reading that workspace explicitly. Read-only; member emails are not returned.
export const AdminWorkspace = z.object({
  workspace_ref: z.uuid(), name: z.string().min(1), slug: z.string().min(1), active: z.boolean(),
  created_at: z.string(),
  plan: z.object({ kind: z.string().nullable() }),
});
export type AdminWorkspace = z.infer<typeof AdminWorkspace>;

function adminFailure(error: unknown): never {
  const parsed = z.object({ code: z.string().optional(), message: z.string().optional() }).safeParse(error);
  if (parsed.success && parsed.data.code === "PT401") throw new PublicError({ status: 401, code: "UNAUTHORIZED", message: "Sign in again." });
  if (parsed.success && parsed.data.code === "PT403") throw new PublicError({ status: 403, code: "ADMIN_REQUIRED", message: "Only LIFT admins can read every workspace." });
  throw new PublicError({ status: 502, code: "ADMIN_UNAVAILABLE", message: "The workspace list could not be read. Try again." });
}

/** Every workspace, through the admin-only list (the database checks is_admin). */
export async function listAdminWorkspaces(session: AuthSession): Promise<AdminWorkspace[]> {
  const client = session.client as { rpc(name: string): Promise<{ data: unknown; error: unknown }> };
  let result;
  try { result = await client.rpc("admin_list_workspaces"); } catch { adminFailure(null); }
  if (result.error) adminFailure(result.error);
  const parsed = z.object({ workspaces: z.array(AdminWorkspace).max(2000) }).safeParse(result.data);
  if (!parsed.success) adminFailure(null);
  return parsed.data.workspaces;
}

type Reads = Parameters<typeof getNextStep>[0] & Pick<AppDependencies, "listAdminWorkspaces">;

export async function readAdminOnboarding(dependencies: Reads, session: AuthSession) {
  const workspaces = await dependencies.listAdminWorkspaces(session);
  const positions: unknown[] = new Array(workspaces.length);
  // A few at a time: each next_step is several reads against the same database.
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, workspaces.length) }, async () => {
    while (next < workspaces.length) {
      const index = next++;
      const workspace = workspaces[index]!;
      try {
        const step = await getNextStep(dependencies, { ...session, workspaceRef: workspace.workspace_ref });
        // guide shows which revision this workspace's agent gets, and the
        // drafts it carries when the workspace is a marked test workspace (LIF-1298).
        positions[index] = { ...workspace, next_step: { reason: step.reason, step: step.step, state: step.state,
          section: step.section, gates: step.gates, response_size: JSON.stringify(step).length,
          guide: { revision: step.guide.revision, drafts: step.guide.drafts ?? [] } }, error: null };
      } catch (error) {
        // One unreadable workspace never hides the others.
        positions[index] = { ...workspace, next_step: null, error: error instanceof PublicError ? error.code : "NEXT_STEP_UNAVAILABLE" };
      }
    }
  }));
  const steps = Object.entries(NEXT_STEP_CATALOG).map(([reason, entry]) => {
    const guide = nextStepGuide(reason)!;
    return { reason, ...entry, guide: { ...entry.guide, revision: guide.revision, size: JSON.stringify(guide).length } };
  });
  // Contexts no step links, each with how the agent reaches it: the base of
  // every step and the ones read on request (LIF-1301, LIF-1304).
  return { generated_at: new Date().toISOString(), steps, base: BASE_CONTEXTS, on_request: ON_REQUEST_CONTEXTS, workspaces: positions };
}
