import type { AuthSession } from "./app.js";
import { PublicError } from "./errors.js";
import { rpcFailure } from "./rpc-errors.js";
import type { IdentityDefinition, IdentityInput } from "./identity-operations.js";

// CRM page resources (preferences, automatic sync and test sync): each
// operation is one database RPC that resolves the workspace and its selected
// CRM, like Identity. Founder sessions send no workspace, so the database reads
// x-lifty-workspace; an admin next_step read names it (AuthSession.workspaceRef).
type Definitions = Record<string, Record<string, IdentityDefinition>>;

export const crmOperationEntries = (definitions: Definitions) => Object.entries(definitions).flatMap(([resource, operations]) =>
  Object.entries(operations).map(([action, definition]) => ({ key: `${resource}.${action}`, definition })));

/** An unknown or unverifiable response is unavailable, never a default. */
export function crmOperationExecutor(definitions: Definitions, unavailable: { code: string; message: string }) {
  return async (session: AuthSession, key: string, input: IdentityInput): Promise<unknown> => {
    const entry = crmOperationEntries(definitions).find(item => item.key === key);
    if (!entry) throw new Error(`Unknown CRM operation ${key}`);
    const { definition } = entry;
    let result: { data: unknown; error: unknown };
    try { result = await (session.client as { rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> })
      .rpc(definition.rpc, { p_workspace_id: session.workspaceRef ?? null, ...definition.args(input) }); }
    catch (cause) { throw rpcFailure(cause, { operation: definition.rpc, ...unavailable }); }
    if (result.error) throw rpcFailure(result.error, { operation: definition.rpc, ...unavailable });
    const parsed = definition.response.safeParse(result.data);
    if (!parsed.success) throw new PublicError({ status: 502, ...unavailable });
    return parsed.data;
  };
}
