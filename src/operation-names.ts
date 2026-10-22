export const notificationPatchToolNames = {
  destination: "notifications_destination_upsert",
  route: "notifications_route_set",
  controls: "notifications_controls_set",
  preferences: "notifications_preferences_set",
} as const;

// Compound HTTP/CLI operations can expose separate, fixed MCP capabilities.
export function operationToolNames(resource: string, action: string): string[] {
  if (resource === "notifications" && action === "patch") return Object.values(notificationPatchToolNames);
  if (resource === "notifications" && action === "post") return ["notifications_connect"];
  return [resource === "summary" && action === "next_step" ? "next_step" : `${resource.replace(/-/g, "_")}_${action}`];
}

// Accept a cached connection name without listing a duplicate capability.
export const canonicalMcpToolName = (name: string): string =>
  name === "notifications_post" ? operationToolNames("notifications", "post")[0]! : name;
