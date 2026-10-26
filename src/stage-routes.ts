import { outreachEntries, validateOutreachInput } from "./outreach-operations.js";
import { businessEntries, validateBusinessRequest } from "./business-operations.js";
import { researchEntries, validateResearchInput } from "./research-operations.js";
import { identityEntries, validateIdentityInput } from "./identity-operations.js";
import { linkedinEntries } from "./linkedin-operations.js";
import { crmPreferencesEntries } from "./crm-preferences.js";
import { crmSyncControlsEntries, crmSyncControlsRunRef } from "./crm-sync-controls.js";
import type { crmOperationEntries } from "./crm-operations.js";
import { customerExclusionsEntries, validateCustomerExclusionsInput } from "./customer-exclusions.js";
import { getWorkspaceSummary } from "./workspace-summary.js";
import { getNextStep } from "./next-step.js";
import { getConnectionNextStep } from "./connection-next-step.js";
import { readAdminOnboarding } from "./admin-onboarding.js";
import { readAdminContext } from "./context-drafts.js";
import { RunProgressQuerySchema, RunProgressSchema } from "./run-progress.js";
import { NextStepSchema } from "./next-step-contracts.js";
import { CrmRecordsQuerySchema, CrmRecordsSchema } from "./crm-records.js";
import {
  CrmCapabilitiesReadSchema, CrmMappingCatalogSchema, CrmMappingSourcesRequestSchema, CrmMappingSourcesSchema,
  CrmMappingPreviewRequestSchema, CrmMappingPreviewSchema, CrmMappingApplyRequestSchema,
  CrmMappingApplySchema, CrmMappingPropertyCreateRequestSchema, CrmMappingPropertyCreateSchema,
  CrmMappingSyncRequestSchema, CrmMappingSyncSchema, CrmMappingStatusQuerySchema, CrmMappingStatusSchema,
  type CrmMappingAction,
} from "./crm-mapping/contracts.js";
import { z } from "zod";
import type { Context } from "hono";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppDependencies, AppEnvironment } from "./app.js";
import type { ConnectionProvider } from "./connection-attempt.js";
import { PublicError } from "./errors.js";
import { CompanyPlanSchema } from "./company-mapping/contract.js";
import { ConfirmRunReviewRequestSchema, CrmConnectionStatusSchema, CrmSyncStatusSchema, NotificationConfigSchema, RunStatusSchema, StartCrmSyncResultSchema, StartRunResultSchema, WorkspaceStatusSchema } from "./contracts.js";
import { readCrmConnection } from "./crm-connection.js";
import {
  AuthorizationRequiredSchema,
  ConnectionAttemptQuerySchema, ConnectionAttemptStatusSchema, CrmConnectRequestSchema,
  NotificationStagePatchSchema, StageErrorSchema, stageOperations,
} from "./stage-contracts.js";

const Empty = z.object({}).strict();
const MAX_STAGE_BYTES = 132 * 1024;
const invalid = () => new PublicError({ status: 400, code: "INVALID_REQUEST", message: "Use the current stage request schema and supported fields." });
const forbidden = () => new PublicError({ status: 403, code: "WORKSPACE_FORBIDDEN", message: "This operation belongs to the current Lifty workspace." });

async function readBody(context: Context<AppEnvironment>, invalidCode?: string, maxBytes = MAX_STAGE_BYTES): Promise<unknown> {
  const length = Number(context.req.header("content-length"));
  if (Number.isFinite(length) && length > maxBytes) throw new PublicError({ status: 413, code: "PAYLOAD_TOO_LARGE", message: `The request exceeds ${maxBytes / 1024} KiB.` });
  const reader = context.req.raw.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new PublicError({ status: 413, code: "PAYLOAD_TOO_LARGE", message: `The stage request exceeds ${maxBytes / 1024} KiB.` });
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { if (invalidCode) throw new PublicError({ status: 422, code: invalidCode, message: "Supply JSON using the current resource schema.", issues: [{code:"invalid_json",path:"/",message:"The request body is not JSON.",suggestion:"Send one JSON object matching the operation schema."}] }); throw invalid(); }
}
// Repeated query keys arrive as arrays; a field declared as an array accepts
// one or more values (grade=A&grade=B), any other field exactly one.
function readQuery(context: Context<AppEnvironment>, schema: z.ZodType): Record<string, unknown> {
  const fields = schema instanceof z.ZodObject ? schema.shape as Record<string, z.ZodType> : {};
  const isArray = (key: string) => {
    const field = fields[key];
    return (field instanceof z.ZodOptional ? field.unwrap() : field) instanceof z.ZodArray;
  };
  return Object.fromEntries(Object.entries(context.req.queries()).map(([key, values]) =>
    [key, isArray(key) || values.length > 1 ? values : values[0]]));
}
function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw invalid();
  return parsed.data;
}

export function registerStageRoutes(app: OpenAPIHono<AppEnvironment>, dependencies: AppDependencies): void {
  app.openAPIRegistry.registerPath({ method: "get", path: "/v1/workspace/next-step", security: [{ bearerAuth: [] }],
    responses: { 200: { description: "Next step observed from Business resources and saved run receipts", content: { "application/json": { schema: NextStepSchema } } } } });
  app.get("/v1/workspace/next-step", async context => {
    parse(Empty, context.req.query());
    context.header("cache-control", "no-store");
    return context.json(await (dependencies.runtimeProfile === "connections" ? getConnectionNextStep : getNextStep)(dependencies, context.get("authSession")));
  });
  // LIF-1297: where every workspace sits in next_step, for LIFT admins only.
  app.openAPIRegistry.registerPath({ method: "get", path: "/v1/admin/onboarding", security: [{ bearerAuth: [] }],
    responses: { 200: { description: "The next_step catalog and each workspace's current reason, computed with the admin's session" },
      403: { description: "Caller is not a LIFT admin" } } });
  app.get("/v1/admin/onboarding", async context => {
    parse(Empty, context.req.query());
    context.header("cache-control", "no-store");
    return context.json(await readAdminOnboarding(dependencies, context.get("authSession")));
  });
  // LIF-1298: published context files, drafts and test workspaces for the ops editor.
  app.openAPIRegistry.registerPath({ method: "get", path: "/v1/admin/context", security: [{ bearerAuth: [] }],
    responses: { 200: { description: "Every published context file with its SHA-256 and uses, the context drafts and the marked test workspaces" },
      403: { description: "Caller is not a LIFT admin" } } });
  app.get("/v1/admin/context", async context => {
    parse(Empty, context.req.query());
    context.header("cache-control", "no-store");
    return context.json(await readAdminContext(context.get("authSession")));
  });
  // The operation catalog is also the route inventory: request/response and RPC
  // owners are identical across HTTP, MCP and API-owned guidance.
  for (const { key, definition } of businessEntries()) {
    const handler = async (context: Context<AppEnvironment>) => {
      context.header("cache-control", "no-store");
      validateBusinessRequest(Empty, context.req.query(), definition.code);
      const session = context.get("authSession");
      const body = ["POST", "PATCH"].includes(definition.method) ? validateBusinessRequest(definition.request, await readBody(context, definition.code), definition.code) : undefined;
      const result = definition.response.parse(await dependencies.businessOperation(session, key, body));
      return context.json(result, key === "business.post" && "created" in result && result.created ? 201 : 200);
    };
    app.on(definition.method, definition.route, handler);
    app.openAPIRegistry.registerPath({ method: definition.method.toLowerCase() as "get" | "post" | "patch" | "delete", path: definition.route, security: [{ bearerAuth: [] }],
      request: { headers: z.object({"x-lifty-workspace":z.string().max(100).optional()}), ...(["POST", "PATCH"].includes(definition.method) ? {body:{required:true,content:{"application/json":{schema:definition.request}}}} : {}) },
      responses: { 200: { description: definition.description, content: { "application/json": { schema: definition.response } } }, ...(key === "business.post" ? {201:{description:"Workspace created",content:{"application/json":{schema:definition.response}}}} : {}), ...Object.fromEntries([401,403,409,413,422,429,502].map(code=>[code,{description:"Typed resource error",content:{"application/json":{schema:StageErrorSchema}}}])) }
    });
  }
  // Research schedule and leads (LIF-1174). As for Business, the database
  // selects the workspace from the session's x-lifty-workspace header.
  for (const { key, definition } of researchEntries()) {
    app.on(definition.method, definition.route, async (context: Context<AppEnvironment>) => {
      context.header("cache-control", "no-store");
      const query = validateResearchInput(definition.query, readQuery(context, definition.query), { status: 400, code: "INVALID_REQUEST" }) as Record<string, unknown>;
      const body = definition.request
        ? validateResearchInput(definition.request, await readBody(context, definition.invalid.status === 422 ? definition.invalid.code : undefined), definition.invalid)
        : undefined;
      return context.json(definition.response.parse(await dependencies.researchOperation(context.get("authSession"), key, { query, body })));
    });
    app.openAPIRegistry.registerPath({ method: definition.method.toLowerCase() as "get" | "post" | "patch", path: definition.route, security: [{ bearerAuth: [] }],
      request: { headers: z.object({ "x-lifty-workspace": z.string().max(100).optional() }), ...(definition.method === "GET" ? { query: definition.query as z.ZodObject } : {}),
        ...(definition.request ? { body: { required: true, content: { "application/json": { schema: definition.request } } } } : {}) },
      responses: { 200: { description: definition.description, content: { "application/json": { schema: definition.response } } },
        ...Object.fromEntries([400, 401, 403, 409, 413, 422, 429, 502].map(code => [code, { description: "Typed resource error", content: { "application/json": { schema: StageErrorSchema } } }])) },
    });
  }
  // Senders and sending accounts (LIF-1182): catalog-defined routes resolved by
  // the database from x-lifty-workspace, like Business and Research.
  for (const { key, definition } of identityEntries()) {
    app.on(definition.method, definition.route.replace(/\{(\w+)\}/g, ":$1"), async (context: Context<AppEnvironment>) => {
      context.header("cache-control", "no-store");
      const path = validateIdentityInput(definition.path, context.req.param(), { status: 400, code: "INVALID_REQUEST" }) as Record<string, string>;
      const query = validateIdentityInput(definition.query, readQuery(context, definition.query), { status: 400, code: "INVALID_REQUEST" }) as Record<string, unknown>;
      const body = definition.request
        ? validateIdentityInput(definition.request, await readBody(context, definition.invalid.status === 422 ? definition.invalid.code : undefined), definition.invalid)
        : undefined;
      const result = await dependencies.identityOperation(context.get("authSession"), key, { path, query, body }, context.req.raw.signal);
      return context.json(result.body as Record<string, unknown>, result.status);
    });
    app.openAPIRegistry.registerPath({ method: definition.method.toLowerCase() as "get" | "post" | "patch", path: definition.route, security: [{ bearerAuth: [] }],
      request: { headers: z.object({ "x-lifty-workspace": z.string().max(100).optional() }), ...(definition.path instanceof z.ZodObject && Object.keys(definition.path.shape).length ? { params: definition.path } : {}),
        ...(definition.method === "GET" ? { query: definition.query as z.ZodObject } : {}),
        ...(definition.request ? { body: { required: true, content: { "application/json": { schema: definition.request } } } } : {}) },
      responses: { [definition.success === 201 ? 201 : 200]: { description: definition.description, content: { "application/json": { schema: definition.response } } },
        ...(definition.success === 202 ? { 202: { description: "Accounts blocked; access removal at the provider is not yet confirmed. Repeat the request to finish it.", content: { "application/json": { schema: definition.response } } } } : {}),
        ...Object.fromEntries([400, 401, 403, 404, 409, 413, 422, 429, 502, 503].map(code => [code, { description: "Typed resource error", content: { "application/json": { schema: StageErrorSchema } } }])) },
    });
  }
  // LinkedIn activity (LIF-1190): one read, its workspace resolved by the
  // database like Identity.
  for (const { key, definition } of linkedinEntries()) {
    app.get(definition.route, async context => {
      context.header("cache-control", "no-store");
      const query = validateIdentityInput(definition.query, readQuery(context, definition.query), definition.invalid) as Record<string, unknown>;
      return context.json(definition.response.parse(await dependencies.linkedinOperation(context.get("authSession"), key, { path: {}, query, body: undefined })));
    });
    app.openAPIRegistry.registerPath({ method: "get", path: definition.route, security: [{ bearerAuth: [] }],
      request: { headers: z.object({ "x-lifty-workspace": z.string().max(100).optional() }), query: definition.query as z.ZodObject },
      responses: { 200: { description: definition.description, content: { "application/json": { schema: definition.response } } },
        ...Object.fromEntries([400, 401, 403, 404, 409, 429, 502].map(code => [code, { description: "Typed resource error", content: { "application/json": { schema: StageErrorSchema } } }])) } });
  }
  // CRM page resources (crm-operations.ts): the database resolves the
  // workspace and its selected CRM, like Identity. `after` runs once the
  // response is verified.
  const crmRoutes = (entries: ReturnType<typeof crmOperationEntries>, operation: "crmPreferencesOperation" | "crmSyncControlsOperation",
    errors: number[], after?: (key: string, result: unknown) => Promise<void>) => {
    for (const { key, definition } of entries) {
      app.on(definition.method, definition.route, async (context: Context<AppEnvironment>) => {
        context.header("cache-control", "no-store");
        const query = validateIdentityInput(definition.query, readQuery(context, definition.query), { status: 400, code: "INVALID_REQUEST" }) as Record<string, unknown>;
        const body = definition.request
          ? validateIdentityInput(definition.request, await readBody(context, definition.invalid.code), definition.invalid)
          : undefined;
        const result = definition.response.parse(await dependencies[operation](context.get("authSession"), key, { path: {}, query, body }));
        await after?.(key, result);
        return context.json(result);
      });
      app.openAPIRegistry.registerPath({ method: definition.method.toLowerCase() as "get" | "post" | "patch", path: definition.route, security: [{ bearerAuth: [] }],
        request: { headers: z.object({ "x-lifty-workspace": z.string().max(100).optional() }), query: definition.query as z.ZodObject,
          ...(definition.request ? { body: { required: true, content: { "application/json": { schema: definition.request } } } } : {}) },
        responses: { 200: { description: definition.description, content: { "application/json": { schema: definition.response } } },
          ...Object.fromEntries(errors.map(code => [code, { description: "Typed resource error", content: { "application/json": { schema: StageErrorSchema } } }])) } });
    }
  };
  // CRM preferences (LIF-1239).
  crmRoutes(crmPreferencesEntries(), "crmPreferencesOperation", [400, 401, 403, 409, 413, 422, 429, 502]);
  // CRM automatic sync and test sync (LIF-1622): the database creates the CRM
  // run; this route wakes lifty-crm-sync for it. The run-scoped key is
  // idempotent, so a reattached run is enqueued again.
  crmRoutes(crmSyncControlsEntries(), "crmSyncControlsOperation", [400, 401, 403, 404, 409, 413, 422, 429, 502, 503], async (key, result) => {
    const runRef = crmSyncControlsRunRef(key, result);
    if (runRef) await dependencies.enqueueCrmSync(runRef);
  });
  for (const { key, definition } of customerExclusionsEntries()) {
    app.on(definition.method, definition.route, async (context: Context<AppEnvironment>) => {
      context.header("cache-control", "no-store");
      const query = validateCustomerExclusionsInput(definition.query, readQuery(context, definition.query), false) as Record<string, unknown>;
      // JSON escaping can expand one decoded CSV byte to six wire bytes.
      // The importer still bounds the decoded UTF-8 file to 128 KiB.
      const body = definition.request
        ? validateCustomerExclusionsInput(definition.request, await readBody(context, definition.invalid.code, key === "customer-exclusions.import" ? 769 * 1024 : undefined), true, definition.invalid.code)
        : undefined;
      return context.json(definition.response.parse(await dependencies.customerExclusionsOperation(context.get("authSession"), key, { path: {}, query, body })));
    });
    app.openAPIRegistry.registerPath({ method: definition.method.toLowerCase() as "get" | "post", path: definition.route, security: [{ bearerAuth: [] }],
      request: { headers: z.object({ "x-lifty-workspace": z.string().max(100).optional() }), query: definition.query as z.ZodObject,
        ...(definition.request ? { body: { required: true, content: { "application/json": { schema: definition.request } } } } : {}) },
      responses: { 200: { description: definition.description, content: { "application/json": { schema: definition.response } } },
        ...Object.fromEntries([400, 401, 403, 409, 413, 422, 429, 502].map(code => [code, { description: "Typed resource error", content: { "application/json": { schema: StageErrorSchema } } }])) } });
  }
  for (const { key, definition } of outreachEntries()) {
    app.on(definition.method, definition.route.replace(/\{([^}]+)\}/g, ":$1"), async context => {
      context.header("cache-control", "no-store");
      const path = validateOutreachInput(definition.path, context.req.param(), { status: 400, code: "INVALID_REQUEST" }) as Record<string, string>;
      const query = validateOutreachInput(definition.query, readQuery(context, definition.query), { status: 400, code: "INVALID_REQUEST" }) as Record<string, unknown>;
      const body = definition.request ? validateOutreachInput(definition.request, await readBody(context, definition.invalid.code), definition.invalid) : undefined;
      const result = definition.response.parse(await dependencies.outreachOperation(context.get("authSession"), key, { path, query, body }));
      return context.json(result, definition.success);
    });
    app.openAPIRegistry.registerPath({ method: definition.method.toLowerCase() as "get" | "post" | "patch", path: definition.route,
      security: [{ bearerAuth: [] }], request: { headers: z.object({ "x-lifty-workspace": z.string().max(100).optional() }),
        ...(definition.path instanceof z.ZodObject && Object.keys(definition.path.shape).length ? { params: definition.path } : {}), query: definition.query as z.ZodObject, ...(definition.request ? { body: { required: true, content: { "application/json": { schema: definition.request } } } } : {}) },
      responses: { [definition.success]: { description: definition.description, content: { "application/json": { schema: definition.response } } },
        ...Object.fromEntries([400,401,403,404,409,413,422,429,502].map(code => [code, { description: "Typed resource error", content: { "application/json": { schema: StageErrorSchema } } }])) } });
  }
  // Calibration sample: the run RPCs select the workspace like every stage.
  app.get("/v1/workspace/sample-review", async context => {
    context.header("cache-control", "no-store");
    parse(Empty, context.req.query());
    return context.json(RunStatusSchema.parse(await dependencies.getRunStatus(context.get("authSession"))));
  });
  app.post("/v1/workspace/sample-review", async context => {
    context.header("cache-control", "no-store");
    parse(Empty, context.req.query());
    parse(Empty, await readBody(context));
    const result = StartRunResultSchema.parse(await dependencies.startRun(context.get("authSession")));
    // A quality checkpoint is terminal until targeting changes. Reattaching
    // returns its saved cohort without starting another acquisition job.
    if (result.state === "failed") return context.json(result);
    // Enqueue active starts, including re-attachments: the run-and-attempt-scoped
    // idempotency key makes it a no-op when the run is already enqueued and
    // self-heals an enqueue lost after the ledger insert.
    await dependencies.enqueueFirstRun(result.run_ref, result.attempt ?? 0);
    return context.json(result);
  });
  // The founder's confirmation of the sample they reviewed (LIF-1303).
  app.post("/v1/workspace/sample-review/confirm", async context => {
    context.header("cache-control", "no-store");
    parse(Empty, context.req.query());
    const body = parse(ConfirmRunReviewRequestSchema, await readBody(context));
    return context.json(RunStatusSchema.parse(await dependencies.confirmRunReview(context.get("authSession"), body.run_ref)));
  });
  app.get("/v1/workspace/runs/progress", async context => {
    context.header("cache-control", "no-store");
    const query = RunProgressQuerySchema.safeParse(context.req.query());
    if (!query.success) throw new PublicError({ status: 400, code: "INVALID_REQUEST", message: "Supply a run_ref, optional cursor and wait_seconds from 0 to 25." });
    return context.json(RunProgressSchema.parse(await dependencies.getRunProgress(context.get("authSession"), query.data, context.req.raw.signal)));
  });
  for (const [method, route, response] of [["get", "/v1/workspace/sample-review", RunStatusSchema], ["post", "/v1/workspace/sample-review", StartRunResultSchema],
    ["get", "/v1/workspace/runs/progress", RunProgressSchema], ["post", "/v1/workspace/sample-review/confirm", RunStatusSchema]] as const) {
    app.openAPIRegistry.registerPath({ method, path: route, security: [{ bearerAuth: [] }],
      request: { headers: z.object({ "x-lifty-workspace": z.string().max(100).optional() }), ...(route.endsWith("progress") ? { query: RunProgressQuerySchema } : {}),
        ...(route.endsWith("confirm") ? { body: { required: true, content: { "application/json": { schema: ConfirmRunReviewRequestSchema } } } } : {}) },
      responses: { 200: { description: "Calibration sample", content: { "application/json": { schema: response } } },
        ...Object.fromEntries([400, 401, 403, 404, 409, 429, 502, 504].map(code => [code, { description: "Typed error", content: { "application/json": { schema: StageErrorSchema } } }])) },
    });
  }
  for (const resource of ["business", "targeting", "research-criteria", "commercial-voice", "research-schedule", "leads"]) {
    for (const operation of Object.values(stageOperations[resource]!)) {
      if (!operation.responses["405"]) continue;
      app.on(operation.method, operation.route, () => { throw new PublicError({ status: 405, code: "STAGE_OPERATION_UNSUPPORTED", message: operation.description }); });
    }
  }
  // Dispatch locally into the existing route: its authentication, rate limit,
  // body limit, business validation, jobs and receipt projection run unchanged.
  function forward(context: Context<AppEnvironment>, method: string, route: string, body?: unknown) {
    const headers = new Headers();
    // x-lifty-workspace keeps a multi-workspace member's selection (LIF-1223).
    for (const name of ["authorization", "x-lifty-client-contract", "x-request-id", "x-lifty-workspace"]) {
      const value = context.req.header(name);
      if (value) headers.set(name, value);
    }
    headers.set("accept", "application/json");
    if (body !== undefined) headers.set("content-type", "application/json");
    return app.request(route, { method, headers, signal: context.req.raw.signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function workspace(context: Context<AppEnvironment>) {
    const state = WorkspaceStatusSchema.parse(await dependencies.getWorkspace(context.get("authSession")));
    if (state.state === "needs_workspace") throw new PublicError({ status: 409, code: "WORKSPACE_NOT_READY", message: "Create the Lifty workspace before configuring this stage." });
    if (state.state === "suspended") throw new PublicError({ status: 409, code: "WORKSPACE_SUSPENDED", message: "This workspace is suspended. Contact LIFT support." });
    return state.workspace.workspace_ref;
  }
  async function attempt(context: Context<AppEnvironment>, provider: ConnectionProvider | "crm", ref: string, workspaceRef: string) {
    parse(z.uuid(), ref);
    const session = context.get("authSession");
    // A CRM attempt UUID belongs to exactly one provider ledger; an unknown one
    // still reads as not found for both.
    const result = provider !== "crm" ? await dependencies.getConnectionAttempt(session, provider, ref, workspaceRef)
      : await dependencies.getConnectionAttempt(session, "hubspot", ref, workspaceRef).catch(error => {
        if (error instanceof PublicError && error.status === 404) return dependencies.getConnectionAttempt(session, "attio", ref, workspaceRef);
        throw error;
      });
    if (result.attempt_ref !== ref) throw new PublicError({ status: 502, code: "CONNECTION_ATTEMPT_UNAVAILABLE", message: "The authorization could not be verified. Retry the same attempt." });
    return context.json(ConnectionAttemptStatusSchema.parse(result));
  }
  const authorization = (value: { attempt_ref?: string | undefined; intent_ref?: string | undefined; connect_url: string; expires_at?: string | undefined }) => {
    const ref = value.attempt_ref ?? value.intent_ref;
    if (!z.uuid().safeParse(ref).success || !value.expires_at) {
      throw new PublicError({ status: 503, code: "CONNECTION_ATTEMPT_UNAVAILABLE", message: "The connection service cannot yet verify this authorization attempt. Retry after the service update." });
    }
    return AuthorizationRequiredSchema.parse({ status: "authorization_required", attempt_ref: ref,
      connection_url: value.connect_url, expires_at: value.expires_at });
  };

  app.get("/v1/workspace/crm/records", async context => {
    context.header("cache-control", "no-store");
    const query = parse(CrmRecordsQuerySchema, context.req.query());
    const current = await workspace(context);
    const result = CrmRecordsSchema.parse(await dependencies.runCrmMapping(context.get("authSession"), "records", query, {
      workspaceRef: current, signal: context.req.raw.signal,
    }));
    if (result.workspace_ref !== current) throw forbidden();
    return context.json(result);
  });

  async function mapping(context: Context<AppEnvironment>, action: CrmMappingAction, input: unknown, responseSchema: z.ZodType) {
    context.header("cache-control", "no-store");
    const current = await workspace(context);
    // Input schemas may carry the catalog's immutable scope for optimistic
    // checks. It must still refer to this authenticated current workspace.
    if (input && typeof input === "object" && "workspace_ref" in input && input.workspace_ref !== current) throw forbidden();
    const result = responseSchema.parse(await dependencies.runCrmMapping(context.get("authSession"), action, input, {
      workspaceRef: current, signal: context.req.raw.signal,
    }));
    if (!result || typeof result !== "object" || !("workspace_ref" in result) || result.workspace_ref !== current) throw forbidden();
    return context.json(result);
  }
  // LIF-1584: the connection's state and what it can do, for the CRM page.
  app.get("/v1/workspace/crm/capabilities", context =>
    mapping(context, "capabilities", parse(Empty, context.req.query()), CrmCapabilitiesReadSchema));
  app.get("/v1/workspace/crm/mapping/catalog", context =>
    mapping(context, "catalog", parse(Empty, context.req.query()), CrmMappingCatalogSchema));
  app.get("/v1/workspace/crm/mapping/status", context =>
    mapping(context, "status", parse(CrmMappingStatusQuerySchema, context.req.query()), CrmMappingStatusSchema));
  for (const [action, requestSchema, responseSchema] of [
    ["sources", CrmMappingSourcesRequestSchema, CrmMappingSourcesSchema],
    ["preview", CrmMappingPreviewRequestSchema, CrmMappingPreviewSchema],
    ["apply", CrmMappingApplyRequestSchema, CrmMappingApplySchema],
    ["property_create", CrmMappingPropertyCreateRequestSchema, CrmMappingPropertyCreateSchema],
    ["sync", CrmMappingSyncRequestSchema, CrmMappingSyncSchema],
  ] as const) {
    app.post(`/v1/workspace/crm/mapping/${action}`, async context => {
      parse(Empty, context.req.query());
      return mapping(context, action, parse(requestSchema, await readBody(context)), responseSchema);
    });
  }

  // Current-workspace mapping context keeps arbitrary member-workspace selection
  // out of the generic stage flow; the legacy admin route remains separate.
  // The five-property company setup exists for HubSpot's company reconciler.
  // Attio matches companies on their domains; its fields use the general mapper.
  async function requireHubspotCompanySetup(context: Context<AppEnvironment>) {
    const attio = await dependencies.getAttioConnection(context.get("authSession"));
    if (attio.status === "connected") throw new PublicError({ status: 409, code: "COMPANY_SETUP_NOT_REQUIRED",
      message: "Attio needs no separate company setup: companies are matched on their domain and the baseline maps the company name. Use mapping_catalog to map other company fields." });
  }
  app.get("/v1/workspace/crm/mapping-context", async context => {
    parse(Empty, context.req.query());
    const current = await workspace(context);
    await requireHubspotCompanySetup(context);
    return forward(context, "GET", `/v1/integrations/hubspot/company-mapping/context?workspace_ref=${encodeURIComponent(current)}`);
  });

  // Disconnection stays in the existing handlers. These POST adapters exist
  // because stage operations cannot express DELETE, and they pin the current
  // workspace instead of accepting one from the caller.
  for (const stage of ["crm", "notifications"] as const) {
    app.post(`/v1/workspace/${stage}/disconnect`, async context => {
      parse(Empty, context.req.query());
      parse(Empty, await readBody(context));
      await workspace(context);
      const provider = stage === "notifications" ? "slack"
        : (await dependencies.getAttioConnection(context.get("authSession"))).status === "connected" ? "attio" : "hubspot";
      return forward(context, "DELETE", `/v1/integrations/${provider}`);
    });
  }

  // The review sync follows the selected CRM; the database refuses a workspace
  // without a usable connection and never falls back to another provider.
  app.post("/v1/workspace/crm/sync", async context => {
    context.header("cache-control", "no-store");
    parse(Empty, context.req.query());
    parse(Empty, await readBody(context));
    await workspace(context);
    const result = StartCrmSyncResultSchema.parse(await dependencies.startCrmSyncRun(context.get("authSession")));
    // Enqueue every start, including a re-attach: the run-scoped key is idempotent.
    await dependencies.enqueueCrmSync(result.run_ref);
    return context.json(result);
  });
  app.get("/v1/workspace/crm/sync", async context => {
    context.header("cache-control", "no-store");
    parse(Empty, context.req.query());
    await workspace(context);
    return context.json(CrmSyncStatusSchema.parse(await dependencies.getCrmSyncStatus(context.get("authSession"))));
  });

  for (const stage of Object.keys(stageOperations).filter(stage => !["business", "targeting", "research-criteria", "commercial-voice", "setup", "account", "sample-review", "research-schedule", "leads", "senders", "sending-accounts", "journeys", "campaigns", "linkedin"].includes(stage))) {
    app.get(`/v1/workspace/${stage}`, async context => {
      context.header("cache-control", "no-store");
      const session = context.get("authSession");
      if (stage === "summary") {
        parse(Empty, context.req.query());
        return context.json(await getWorkspaceSummary(dependencies, session));
      }
      const current = await workspace(context);
      if (stage === "crm" || stage === "notifications") {
        const query = parse(ConnectionAttemptQuerySchema, context.req.query());
        if (query.attempt_ref) return attempt(context, stage === "crm" ? "crm" : "slack", query.attempt_ref, current);
        return stage === "crm" ? context.json(CrmConnectionStatusSchema.parse(await readCrmConnection(dependencies, session)))
          : context.json(NotificationConfigSchema.parse(await dependencies.getNotificationConfig(session)));
      }

      parse(Empty, context.req.query());
      throw new PublicError({ status: 405, code: "STAGE_OPERATION_UNSUPPORTED", message: "This operation is not available." });
    });

    app.post(`/v1/workspace/${stage}`, async context => {
      parse(Empty, context.req.query());
      if (stage === "summary") throw new PublicError({ status: 405, code: "STAGE_OPERATION_UNSUPPORTED", message: "This stage is read-only." });
      const body = await readBody(context);

      const current = await workspace(context);
      const session = context.get("authSession");

      if (stage === "crm") {
        const { provider } = parse(CrmConnectRequestSchema, body);
        return context.json(authorization(provider === "attio" ? await dependencies.startAttioConnect(session) : await dependencies.startHubspotConnect(session)));
      }
      parse(Empty, body);
      if (stage === "notifications") return context.json(authorization(await dependencies.startSlackConnect(session)));
      throw new PublicError({ status: 405, code: "STAGE_OPERATION_UNSUPPORTED", message: "This operation is not available." });
    });

    app.patch(`/v1/workspace/${stage}`, async context => {
      parse(Empty, context.req.query());
      if (stage === "summary") {
        throw new PublicError({ status: 405, code: "STAGE_OPERATION_UNSUPPORTED", message: "This stage has no supported configuration changes through PATCH." });
      }
      const current = await workspace(context);
      const body = await readBody(context);
      if (stage === "crm") {
        const plan = parse(CompanyPlanSchema, body);
        if (plan.workspace_ref !== current) throw forbidden();
        await requireHubspotCompanySetup(context);
        return forward(context, "POST", "/v1/integrations/hubspot/company-mapping", plan);
      }

      if (stage === "notifications") {
        const input = parse(NotificationStagePatchSchema, body);
        return forward(context, "PUT", input.operation === "destination" ? "/v1/notifications/destinations/slack" : "/v1/notifications/routes", input.values);
      }
      throw new PublicError({ status: 405, code: "STAGE_OPERATION_UNSUPPORTED", message: "This operation is not available." });
    });
  }
}
