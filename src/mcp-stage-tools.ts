import { canonicalMcpToolName, notificationPatchToolNames, operationToolNames } from "./operation-names.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { AgentContextSchema, STAGE_CLIENT_CONTRACT } from "./agent-context.js";
import { NotificationStagePatchSchema, stageOperations, type StageOperation } from "./stage-contracts.js";

type JsonSchema = Record<string, unknown>;
export interface StageMcpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, object>; required: string[]; additionalProperties: false };
  annotations: { title: string; readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
}
const notificationWriteDescriptions = {
  destination: "Save a Slack channel as a notification destination in the current workspace, or rename or reactivate the saved one, and return the saved destination with the types it receives. Needs connected Slack. A new destination receives every default-on type Slack can show; a type that falls back to email stops reaching the owner's email while an active Slack channel receives it. Does not post a message or start outreach.",
  route: "Subscribe or unsubscribe one saved destination (a Slack channel or the owner email destination) to one notification type in the current workspace and return the updated destination. Controls whether future notifications of that type reach it. Does not authorize Slack, post a message or start outreach.",
};
// Reuse each branch's existing strict input schema. Only the adapter selects
// the HTTP discriminator; a model cannot switch operations through the body.
const notificationWrites = NotificationStagePatchSchema.options.map(schema => ({
  operation: schema.shape.operation.value,
  schema: schema.shape.values,
}));
type NotificationWrite = typeof notificationWrites[number];
interface Entry { stage: string; action: string; operation: StageOperation; tool: StageMcpTool; notificationWrite?: NotificationWrite }
export type McpRouteDispatch = (route: string, init: RequestInit) => Promise<Response>;
// Writes whose effect leaves the user's Lifty workspace and private accounts.
const openWorld = new Set(["sample-review.post", "research-schedule.activate", "campaigns.activate", "journeys.activate",
  "campaigns.review_settings_patch", "campaigns.message_review_post", "campaigns.reply_review_post", "campaigns.lead_stop_post",
  "sending-accounts.resume", "sending-accounts.resume_campaigns", "sending-accounts.warmup_start", "sending-accounts.warmup_resume", "sending-accounts.placement_start", "notifications.test",
  // Removing Lifty's access at the account provider.
  "sending-accounts.disconnect", "senders.delete"]);
// Creating a resource changes nothing that exists.
const nonDestructive = new Set(["business.post", "senders.post", "journeys.post", "campaigns.post"]);
// Writes that commit synchronously, with no authorization link or receipt.
const synchronousStages = new Set(["business", "targeting", "research-criteria", "commercial-voice", "setup", "research-schedule", "journeys", "campaigns"]);
const synchronousOperations = new Set(["sending-accounts.resume_campaigns", "crm.preferences_patch", "crm.rules_patch", "customer-exclusions.import", "notifications.patch"]);
const pendingOperations = new Set(["campaigns.reply_review_post", "campaigns.message_rewrite_post", "campaigns.lead_stop_post"]);
// Live CRM reads can replace credentials or connection health synchronously
// under the existing authorization; they do not start a new business write.
const crmMaintenanceOperations = new Set(["crm.mapping_catalog", "crm.mapping_preview", "crm.records", "crm.mapping_context", "crm.client_mapping_context"]);
const plainObject = (value: unknown): value is JsonSchema => !!value && typeof value === "object" && !Array.isArray(value);
// Clients load every tool definition on every turn; the dialect marker adds
// nothing to an input schema a client already treats as JSON Schema.
function withoutDialect(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDialect);
  if (!plainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$schema").map(([key, item]) => [key, withoutDialect(item)]));
}
const title = (value: string) => value.replace(/[-_]/g, " ").replace(/\b\w/g, letter => letter.toUpperCase());
// Transport metadata shared by every tool, never a resource field. The stateless
// adapter forwards it as x-lifty-workspace; the database resolves membership.
const WorkspaceKey = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const WorkspaceProperty = { type: "string", pattern: "^[A-Za-z0-9_-]{1,100}$", description: "The user's chosen workspace; send on every call." };

function entries(): Entry[] {
  return Object.entries(stageOperations).flatMap(([stage, operations]) => Object.entries(operations).flatMap(([action, operation]) => {
    // Published unsupported REST verbs are not actions a founder can perform.
    if (!Object.keys(operation.responses).some(status => status.startsWith("2"))) return [];
    const read = operation.readOnly;
    // This status check can persist provider verification, but continues the
    // connection the user already requested rather than requesting a new action.
    const reconcilesConnection = stage === "sending-accounts" && action === "attempt";
    const maintainsCrmConnection = crmMaintenanceOperations.has(`${stage}.${action}`);
    const variants: { name: string; description: string; body: JsonSchema | null; notificationWrite?: NotificationWrite }[] =
      stage === "notifications" && action === "patch"
        ? notificationWrites.map(write => ({ name: notificationPatchToolNames[write.operation],
          description: notificationWriteDescriptions[write.operation], body: z.toJSONSchema(write.schema, { io: "input" }), notificationWrite: write }))
        : [{ name: operationToolNames(stage, action)[0]!, description: operation.description, body: operation.request.body }];
    return variants.map(({ name, description: operationDescription, body, notificationWrite }) => {
      const label = title(name);
      const properties: Record<string, object> = { workspace: WorkspaceProperty,
        path: withoutDialect(operation.request.path) as object, query: withoutDialect(operation.request.query) as object };
      const required: string[] = [];
      if (Array.isArray(operation.request.path.required) && operation.request.path.required.length) required.push("path");
      if (Array.isArray(operation.request.query.required) && operation.request.query.required.length) required.push("query");
      if (body) { properties.body = withoutDialect(body) as object; required.push("body"); }
      const description = `${operationDescription}${read || reconcilesConnection || maintainsCrmConnection ? "" : !pendingOperations.has(`${stage}.${action}`) && (synchronousStages.has(stage) || synchronousOperations.has(`${stage}.${action}`)) ? " Requires the founder's approval. Writes commit synchronously; read back the saved resource or setup receipt after an uncertain response." : " Requires the founder's approval; a pending receipt does not confirm completion. Check its status or read back the saved resource."}`;
      return { stage, action, operation, ...(notificationWrite ? { notificationWrite } : {}),
        tool: { name, title: label, description,
          inputSchema: { type: "object" as const, properties, required, additionalProperties: false as const },
          annotations: { title: label, readOnlyHint: read, destructiveHint: !read && !nonDestructive.has(`${stage}.${action}`),
            openWorldHint: !read && openWorld.has(`${stage}.${action}`) } } };
    });
  }));
}

// Shared operation routes are listed once under their first stage. Every
// callable name is derived from a current catalog entry.
export const getStageMcpTools = (): StageMcpTool[] => {
  const all = entries();
  const key = (entry: Entry) => `${entry.operation.method} ${entry.operation.route} ${entry.notificationWrite?.operation ?? ""}`;
  const stages = new Map<string, string[]>();
  for (const entry of all) stages.set(key(entry), [...(stages.get(key(entry)) ?? []), entry.stage]);
  const listed = new Set<string>();
  return all.filter(entry => !listed.has(key(entry)) && listed.add(key(entry))).map(entry => {
    const shared = stages.get(key(entry))!;
    return shared.length === 1 ? entry.tool
      : { ...entry.tool, description: `${entry.tool.description} One tool serves the ${shared.join(", ")} stages.` };
  });
};

const QueryScalar = z.union([z.string(), z.number().finite(), z.boolean()]);
const Envelope = z.object({
  workspace: WorkspaceKey.optional(),
  path: z.record(z.string(), z.string().regex(/^[A-Za-z0-9_-]+$/)).default({}),
  // Array values become repeated parameters, as the CLI sends them.
  query: z.record(z.string(), z.union([QueryScalar, z.array(QueryScalar).min(1).max(20)])).default({}),
  body: z.unknown().optional(),
}).strict();
function propertyNames(schema: JsonSchema): Set<string> {
  const names = new Set(plainObject(schema.properties) ? Object.keys(schema.properties) : []);
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(schema[key])) for (const branch of schema[key].filter(plainObject)) {
      for (const name of propertyNames(branch)) names.add(name);
    }
  }
  return names;
}
function result(data: Record<string, unknown>, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: data, isError };
}
const invalid = () => result({ error: { code: "INVALID_REQUEST", message: "Use this tool's current path, query and body schema." } }, true);

// MCP clients already load the operation input schemas through tools/list.
// Keep all guidance, references and draft provenance, without returning the
// same catalog a second time. HTTP/CLI contexts retain their complete schemas.
function contextGuide(data: unknown) {
  const parsed = AgentContextSchema.safeParse(data);
  if (!parsed.success) return data;
  const { operations: _operations, schemas: _schemas, revision: _revision, ...guide } = parsed.data;
  const content = {
    ...guide,
    instructions: `${guide.instructions}\n\nMCP tools publish their current input schemas in tools/list. Use each tool's inputSchema for path, query and body; this document supplies the current guidance and references.`,
    schemas: {},
  };
  return { ...content, revision: `sha256:${createHash("sha256").update(JSON.stringify(content)).digest("hex")}` };
}

export async function callStageMcpTool(name: string, args: unknown, request: Request, dispatch: McpRouteDispatch) {
  // Cached connector catalogs can still call the previous connection name.
  // Both names use the same owning route, schema and authorization checks.
  const canonicalName = canonicalMcpToolName(name);
  const entry = entries().find(item => item.tool.name === canonicalName);
  if (!entry) return result({ error: { code: "UNKNOWN_TOOL", message: "Refresh the tools list and use an available Lifty tool." } }, true);
  const parsed = Envelope.safeParse(args ?? {});
  if (!parsed.success) return invalid();
  const input = parsed.data;
  const { operation } = entry;
  const pathNames = propertyNames(operation.request.path);
  const queryNames = propertyNames(operation.request.query);
  if (Object.keys(input.path).some(key => !pathNames.has(key)) || Object.keys(input.query).some(key => !queryNames.has(key))) return invalid();
  if (!operation.request.body && input.body !== undefined) return invalid();
  let missingPath = false;
  const route = operation.route.replace(/\{([^}]+)\}/g, (_, key: string) => {
    const value = input.path[key];
    if (!value) missingPath = true;
    return value ? encodeURIComponent(value) : "";
  });
  if (missingPath) return invalid();
  const query = new URLSearchParams(Object.entries(input.query).flatMap(([key, value]) =>
    (Array.isArray(value) ? value : [value]).map(item => [key, String(item)])));
  const headers = new Headers({ accept: "application/json", "x-lifty-client-contract": STAGE_CLIENT_CONTRACT });
  // The MCP adapter is a current API client. The caller cannot override its
  // contract, impersonate another principal, or supply a route/origin.
  for (const key of ["authorization", "x-request-id", "x-lifty-workspace"]) {
    const value = request.headers.get(key);
    if (value) headers.set(key, value);
  }
  // One selection per call: a different connection-level header never silently wins.
  const connectionWorkspace = request.headers.get("x-lifty-workspace")?.trim();
  if (input.workspace) {
    if (connectionWorkspace && connectionWorkspace !== input.workspace) return invalid();
    headers.set("x-lifty-workspace", input.workspace);
  }
  const clientContract = request.headers.get("x-lifty-client-contract");
  if (clientContract && clientContract !== STAGE_CLIENT_CONTRACT) return result({ error: { code: "CONTEXT_CLIENT_UNSUPPORTED", message: "Reconnect Lifty to refresh the client contract." } }, true);
  let requestBody = input.body;
  if (entry.notificationWrite) {
    const values = entry.notificationWrite.schema.safeParse(requestBody);
    if (!values.success) return invalid();
    requestBody = { operation: entry.notificationWrite.operation, values: values.data };
  }
  const body = operation.request.body ? JSON.stringify(requestBody ?? {}) : undefined;
  if (body && Buffer.byteLength(body) > 132 * 1024) return result({ error: { code: "PAYLOAD_TOO_LARGE", message: "The request exceeds 132 KiB." } }, true);
  if (body !== undefined) headers.set("content-type", "application/json");
  const response = await dispatch(`${route}${query.size ? `?${query}` : ""}`, {
    method: operation.method, headers, signal: request.signal, ...(body === undefined ? {} : { body }),
  });
  let data: unknown;
  try { data = await response.json(); } catch { return result({ error: { code: "INVALID_RESPONSE", message: "Lifty could not verify the response. Read status before retrying a write." } }, true); }
  if (response.ok && operation.method === "GET" && route.startsWith("/v1/context/")) data = contextGuide(data);
  return result({ status: response.status, data,
    ...(response.headers.has("retry-after") ? { retry_after_seconds: Number(response.headers.get("retry-after")) } : {}) }, !response.ok);
}
