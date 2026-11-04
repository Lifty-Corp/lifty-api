import { z } from "zod";
import type { AuthSession } from "../app.js";
import type { NotificationConfig } from "../contracts.js";
import { PublicError } from "../errors.js";
import type { NotificationProvider } from "./provider.js";

type RpcClient = { rpc<T>(name: string): PromiseLike<{ data: T; error: unknown }> };
const StoredSlackConnectionSchema = z.union([
  z.object({ status: z.literal("not_connected") }),
  z.object({ status: z.literal("connected"), team_id: z.string().min(1), team_name: z.string().min(1), reconnect_required: z.boolean() }),
]);
type SlackStatus = NotificationConfig["slack"];

export function createSlackNotificationProvider(errors: {
  invalidResponse(cause: unknown): Error; rpcError(cause: unknown, operation: string): Error;
}): NotificationProvider {
  async function readSlackStatus(session: AuthSession): Promise<SlackStatus> {
    const { data, error } = await (session.client as RpcClient).rpc<unknown>("get_lifty_slack_connection");
    if (error) throw errors.rpcError(error, "get_lifty_slack_connection");
    const parsed = StoredSlackConnectionSchema.safeParse(data);
    if (!parsed.success) throw errors.invalidResponse(parsed.error);
    return parsed.data.status === "connected"
      ? { status: "connected", team_id: parsed.data.team_id, team_name: parsed.data.team_name, reconnect_required: parsed.data.reconnect_required }
      : { status: "not_connected" };
  }

  // The configuration functions do not check the Slack grant, so writes and tests
  // that need Slack refuse here, with the same codes the channel list uses.
  function requireUsableSlack(slack: SlackStatus): void {
    if (slack.status !== "connected") {
      throw new PublicError({ status: 409, code: "SLACK_NOT_CONNECTED", message: "Slack is not connected to this workspace. Connect Slack first." });
    }
    if (slack.reconnect_required) {
      throw new PublicError({ status: 409, code: "SLACK_RECONNECT_REQUIRED", message: "Reconnect Slack before configuring or testing a Slack notification channel." });
    }
  }

  return {
    status: async session => {
      const status = await readSlackStatus(session);
      return status.status === "connected" ? { status: status.status, tenant_id: status.team_id, tenant_name: status.team_name, reconnect_required: status.reconnect_required } : status;
    },
    requireConnected: async session => requireUsableSlack(await readSlackStatus(session)),
    address: z.string().regex(/^[CG][A-Z0-9]{2,31}$/),
  };
}
