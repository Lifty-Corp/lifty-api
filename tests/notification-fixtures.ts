// A small stand-in for the session's Supabase client: the public workspace and
// Slack reads plus the customer-edge functions of the notifications schema.
// It keeps their observable behavior (JSON null for empty arrays, new Slack
// destinations subscribed to default-on Slack types) so operations re-read
// what they wrote.

export const workspaceRef = "64300000-0000-4000-a000-000000000001";
export const slackRef = "64300000-0000-4000-a000-000000000010";
export const emailRef = "64300000-0000-4000-a000-000000000020";
export const createdRef = "64300000-0000-4000-a000-000000000030";

export interface StoredType { code: string; name: string; channels: string[]; email_fallback: boolean; default_on: boolean; paused: boolean }
export interface StoredDestination { id: string; channel: string; address: string | null; name: string | null; active: boolean; types: string[] }

export const storedTypes = (): StoredType[] => [
  { code: "meeting.booked", name: "Meeting booked", channels: ["slack"], email_fallback: false, default_on: true, paused: false },
  { code: "prospecting.search_low", name: "Lead supply running low", channels: ["slack", "email"], email_fallback: true, default_on: false, paused: false },
  { code: "sending_account.needs_reconnect", name: "Sending account needs reconnect", channels: ["slack", "email"], email_fallback: true, default_on: true, paused: false },
];
export const ownerEmail = (): StoredDestination => ({ id: emailRef, channel: "email", address: null, name: null, active: true, types: ["sending_account.needs_reconnect"] });
export const slackChannel = (): StoredDestination => ({ id: slackRef, channel: "slack", address: "C643CHANNEL", name: "client-alerts", active: true,
  types: ["meeting.booked", "sending_account.needs_reconnect"] });

export const readyWorkspace = { state: "ready_for_connections", workspace: { workspace_ref: workspaceRef, name: "Example" }, next_action: null };
// The full get_lifty_slack_connection row; the notification read keeps only the status fields.
export const connectedSlack = { provider: "slack", status: "connected", team_id: "T643TEAM", team_name: "Example Robotics", enterprise_id: null,
  bot_user_id: "U643BOT", scopes: ["chat:write"], connected_at: "2026-10-01T00:00:00Z", reconnect_required: false };

export interface NotificationsDatabaseOptions {
  workspace?: unknown;
  controls?: unknown;
  slack?: unknown;
  types?: StoredType[];
  destinations?: StoredDestination[];
  /** Errors by `<schema>.<function>`, returned instead of the result. */
  errors?: Record<string, unknown>;
}

export function notificationsDatabase(options: NotificationsDatabaseOptions = {}) {
  const calls: Array<{ schema: string; name: string; args?: Record<string, unknown> }> = [];
  const types = options.types ?? storedTypes();
  const destinations = options.destinations ?? [ownerEmail(), slackChannel()];
  const rpc = (schema: string) => async (name: string, args?: Record<string, unknown>) => {
    calls.push({ schema, name, ...(args === undefined ? {} : { args }) });
    const error = options.errors?.[`${schema}.${name}`];
    if (error) return { data: null, error };
    const key = `${schema}.${name}`;
    if (key === "public.get_lifty_workspace_status") return { data: options.workspace ?? readyWorkspace, error: null };
    if (key === "public.get_lifty_slack_connection") return { data: options.slack ?? connectedSlack, error: null };
    if (key === "notifications.get_configuration") {
      return { data: { ...(options.controls === undefined ? {} : { controls: options.controls }), types: types.length ? structuredClone(types) : null,
        destinations: destinations.length ? structuredClone(destinations) : null }, error: null };
    }
    if (key === "notifications.save_slack_destination") {
      const existing = destinations.find(item => item.channel === "slack" && item.address === args?.p_channel_id);
      if (existing) {
        Object.assign(existing, { name: args?.p_name ?? null, active: args?.p_active ?? existing.active });
        return { data: existing.id, error: null };
      }
      destinations.push({ id: createdRef, channel: "slack", address: String(args?.p_channel_id), name: (args?.p_name as string | undefined) ?? null,
        active: true, types: types.filter(type => type.default_on && type.channels.includes("slack")).map(type => type.code) });
      return { data: createdRef, error: null };
    }
    if (key === "notifications.set_controls" || key === "notifications.set_preferences") return { data: null, error: null };
    if (key === "notifications.set_subscription") {
      const destination = destinations.find(item => item.id === args?.p_destination_id)!;
      const code = String(args?.p_type_code);
      destination.types = [...new Set(args?.p_subscribed ? [...destination.types, code] : destination.types.filter(item => item !== code))].sort();
      return { data: null, error: null };
    }
    return { data: null, error: { code: "PGRST202", message: `unexpected ${key}` } };
  };
  return { calls, destinations, client: { rpc: rpc("public"), schema: (name: string) => ({ rpc: rpc(name) }) } };
}
