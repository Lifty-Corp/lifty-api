import { PostHog } from "posthog-node";

import type { AuthSession } from "./app.js";
import { stageOperations } from "./stage-contracts.js";

/**
 * LIF-1663: product analytics at the operation boundary. One PostHog event per
 * founder mutation (and the next_step heartbeat), tied to the acting user and
 * the `workspace` group, plus the activation milestones. Everything here is
 * fire-and-forget: a slow or failing PostHog never changes a response.
 *
 * Property values are allow-listed by name and shape, so prospect names,
 * emails, message bodies, tokens and provider bodies cannot reach PostHog
 * through this module even by mistake.
 */

export type AnalyticsSurface = "mcp" | "http" | "cli";

export interface AnalyticsCapture {
  distinctId: string;
  event: string;
  properties: Record<string, string | number>;
  groups?: { workspace: string };
  timestamp: Date;
}

export interface AnalyticsGroupIdentify {
  groupType: "workspace";
  groupKey: string;
  properties: Record<string, string>;
}

/** The posthog-node surface this module uses; tests substitute a recorder. */
export interface AnalyticsSink {
  capture(message: AnalyticsCapture): void;
  groupIdentify(message: AnalyticsGroupIdentify): void;
  shutdown(timeoutMs?: number): Promise<void>;
}

/** Group properties the database can report for a workspace. Unknown fields stay absent. */
export interface WorkspaceGroupFacts {
  name?: string | null;
  slug?: string | null;
  analytics_class?: string | null;
  plan_key?: string | null;
  plan_kind?: string | null;
  assignment_authority?: string | null;
  created_at?: string | null;
}

export interface AnalyticsReads {
  /** The workspace the database selects for this session's request, or null when it has none. */
  workspace(session: AuthSession): Promise<string | null>;
  /** Group properties for a resolved workspace, read with the caller's own session. */
  facts(session: AuthSession, workspaceRef: string): Promise<WorkspaceGroupFacts>;
}

export interface AnalyticsLogEvent {
  level: "warn";
  event: "analytics_failed";
  stage: "workspace" | "facts" | "capture" | "sink" | "shutdown";
  operation?: string;
  request_id?: string;
  error_code: string;
}

export interface AnalyticsOptions {
  sink: AnalyticsSink | null;
  reads: AnalyticsReads;
  log?: (event: AnalyticsLogEvent) => void;
  now?: () => number;
  /** How long a resolved workspace stays cached per user and selection. */
  workspaceTtlMs?: number;
  /** How often a workspace's group properties are re-read and compared. */
  groupRefreshMs?: number;
}

/** What the `/v1/*` middleware knows once the response is decided. */
export interface OperationObservation {
  session: AuthSession;
  method: string;
  path: string;
  /** Only `attempt_ref` is read, to tell a verification read from a status read. */
  query: { attempt_ref?: string | undefined };
  surface: AnalyticsSurface;
  requestId: string;
  /** The caller's `x-lifty-workspace` selection, part of the resolution cache key. */
  selection: string | null;
  status: number;
  durationMs: number;
  /** The public code of a thrown PublicError; null when the handler returned normally. */
  errorCode: string | null;
  /** Non-secret facts a handler learned that the response does not carry (the CRM provider of an attempt). */
  facts?: { provider?: string } | undefined;
  /** The decided response; cloned synchronously only when a milestone needs its body. */
  response: Response;
}

export interface Analytics {
  readonly enabled: boolean;
  observe(observation: OperationObservation): void;
  shutdown(): Promise<void>;
}

export const noopAnalytics: Analytics = { enabled: false, observe: () => {}, shutdown: async () => {} };

// ---------------------------------------------------------------- catalog

interface CatalogEntry { operation: string; method: string; pattern: RegExp; readOnly: boolean }

const escape = (value: string) => value.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
/** Every operation a founder can perform, in catalog order, keyed by its route. */
export const operationCatalog: readonly CatalogEntry[] = Object.entries(stageOperations).flatMap(([stage, operations]) =>
  Object.entries(operations).flatMap(([action, operation]) => {
    if (!Object.keys(operation.responses).some(status => status.startsWith("2"))) return [];
    const pattern = new RegExp(`^${escape(operation.route).replace(/\\\{[^}]+\\\}/g, "[^/]+").replace(/\{[^}]+\}/g, "[^/]+")}$`);
    return [{ operation: `${stage}.${action}`, method: operation.method, pattern, readOnly: operation.readOnly }];
  }));

export function matchOperation(method: string, path: string): CatalogEntry | null {
  return operationCatalog.find(entry => entry.method === method && entry.pattern.test(path)) ?? null;
}

/** Mutations and the next_step heartbeat; polling and other reads are not captured. */
export function isCapturedOperation(entry: CatalogEntry): boolean {
  if (entry.operation === "summary.next_step") return true;
  return !entry.readOnly && ["POST", "PATCH", "DELETE"].includes(entry.method);
}

// ---------------------------------------------------------------- properties

/** Every event property this module may send. Anything else is dropped. */
export const ALLOWED_EVENT_PROPERTIES = new Set([
  "operation", "surface", "request_id", "duration_ms", "outcome", "http_status", "error_code", "provider", "channel",
]);
/** Group properties come from the database's own workspace record, never from a request. */
export const ALLOWED_GROUP_PROPERTIES = new Set([
  "name", "slug", "analytics_class", "plan_key", "plan_kind", "assignment_authority", "created_at",
]);
// Identifiers, codes and enum values only: no spaces, no `@`, no `://`.
const TOKEN = /^[A-Za-z0-9_.:-]{1,80}$/;
// Workspace names may carry spaces and punctuation; addresses and links never belong here.
const LABEL = /^(?!.*(?:@|:\/\/))[^\u0000-\u001f]{1,200}$/;

export function safeEventProperties(input: Record<string, unknown>): Record<string, string | number> {
  const result: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!ALLOWED_EVENT_PROPERTIES.has(key)) continue;
    if (typeof value === "number" && Number.isFinite(value)) result[key] = value;
    else if (typeof value === "string" && TOKEN.test(value)) result[key] = value;
  }
  return result;
}

export function safeGroupProperties(input: WorkspaceGroupFacts): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!ALLOWED_GROUP_PROPERTIES.has(key) || typeof value !== "string") continue;
    const trimmed = value.trim();
    if (key === "name" ? LABEL.test(trimmed) : TOKEN.test(trimmed)) result[key] = trimmed;
  }
  return result;
}

// ---------------------------------------------------------------- milestones

type Body = Record<string, unknown>;
interface MilestoneRule {
  event: string;
  /** Read the response body (cloned before it is sent) to decide and to dedupe. */
  needsBody?: boolean;
  when?: (observation: OperationObservation, body: Body | null) => boolean;
  /** A stable key so repeated reads of one verified attempt emit the milestone once per process. */
  once?: (observation: OperationObservation, body: Body | null) => string | null;
  facts?: (observation: OperationObservation, body: Body | null) => Record<string, unknown>;
}

const text = (value: unknown) => typeof value === "string" ? value : null;
const verifiedAttempt = (observation: OperationObservation, body: Body | null) =>
  Boolean(observation.query.attempt_ref) && body?.status === "connected" && body.verified === true;

/**
 * Operation to milestone. Connection milestones fire on the read that reports
 * the attempt verified, never on the consent link (connection confirmation
 * contract); a workspace whose agent never reads the attempt again records no
 * milestone here.
 */
export const MILESTONES: Record<string, MilestoneRule> = {
  "setup.post": { event: "setup_submitted" },
  "sample-review.post": { event: "sample_review_started", needsBody: true, when: (_, body) => body?.created === true },
  "sample-review.confirm": { event: "sample_review_confirmed" },
  "research-schedule.activate": { event: "research_schedule_activated" },
  "research-schedule.pause": { event: "research_schedule_paused" },
  "crm.get": { event: "crm_connected", needsBody: true, when: verifiedAttempt,
    once: observation => observation.query.attempt_ref ?? null, facts: observation => ({ provider: observation.facts?.provider }) },
  "crm.sync_start": { event: "crm_sync_started" },
  "sending-accounts.attempt": { event: "sending_account_connected", needsBody: true, when: (_, body) => body?.state === "connected",
    once: (_, body) => text(body?.id), facts: (_, body) => ({ provider: "unipile", channel: body?.channel }) },
  "sending-accounts.warmup_start": { event: "warmup_started" },
  "sending-accounts.placement_start": { event: "placement_test_started" },
  "campaigns.publish": { event: "campaign_published" },
  "campaigns.activate": { event: "campaign_activated" },
  "campaigns.pause": { event: "campaign_paused" },
  "notifications.get": { event: "slack_connected", needsBody: true, when: verifiedAttempt,
    once: observation => observation.query.attempt_ref ?? null, facts: () => ({ provider: "slack" }) },
};

// ---------------------------------------------------------------- internal requests

// Stage adapters dispatch into their owning routes with app.request; the
// outer operation is the founder action, so the inner request is not counted.
const internalRequests = new WeakSet<Request>();
export function markInternalRequest<T extends Request>(request: T): T {
  internalRequests.add(request);
  return request;
}
export const isInternalRequest = (request: Request): boolean => internalRequests.has(request);

/** mcp for trusted MCP dispatches; cli once the installed CLI names itself; http otherwise. */
export function analyticsSurface(trustedMcp: boolean, userAgent: string | undefined): AnalyticsSurface {
  if (trustedMcp) return "mcp";
  return /^lifty-cli\b/i.test(userAgent ?? "") ? "cli" : "http";
}

// ---------------------------------------------------------------- runtime

const BODY_LIMIT = 256 * 1024;
const ONCE_LIMIT = 2_000;

async function readJson(response: Response | null): Promise<Body | null> {
  if (!response) return null;
  try {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_LIMIT) return null;
    const parsed: unknown = JSON.parse(new TextDecoder().decode(buffer));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Body : null;
  } catch {
    return null;
  }
}

const errorName = (error: unknown) => error instanceof Error && error.name ? error.name : "unknown";

export function createAnalytics(options: AnalyticsOptions): Analytics {
  const { sink, reads } = options;
  if (!sink) return noopAnalytics;
  const log = options.log ?? (() => {});
  const now = options.now ?? Date.now;
  const workspaceTtl = options.workspaceTtlMs ?? 10 * 60_000;
  const groupRefresh = options.groupRefreshMs ?? 15 * 60_000;
  const workspaces = new Map<string, { promise: Promise<string | null>; expiresAt: number }>();
  const groups = new Map<string, { fingerprint: string; refreshedAt: number; pending: Promise<void> | null }>();
  const emitted = new Set<string>();

  const resolveWorkspace = (observation: OperationObservation): Promise<string | null> => {
    const key = `${observation.session.userId}\u0000${observation.selection ?? ""}`;
    const cached = workspaces.get(key);
    if (cached && cached.expiresAt > now()) return cached.promise;
    const promise = reads.workspace(observation.session).then(ref => {
      // A session without a workspace yet (business.post creates one) is not cached.
      if (!ref) workspaces.delete(key);
      return ref;
    }, error => {
      workspaces.delete(key);
      log({ level: "warn", event: "analytics_failed", stage: "workspace", operation: observation.path, request_id: observation.requestId, error_code: errorName(error) });
      return null;
    });
    if (workspaces.size >= 5_000) workspaces.delete(workspaces.keys().next().value!);
    workspaces.set(key, { promise, expiresAt: now() + workspaceTtl });
    return promise;
  };

  // First sight of a workspace in this process, and every refresh whose
  // name, slug, class or plan changed, identifies the group again.
  const identifyGroup = (observation: OperationObservation, workspaceRef: string): Promise<void> => {
    const current = groups.get(workspaceRef);
    if (current?.pending) return current.pending;
    if (current && current.refreshedAt + groupRefresh > now()) return Promise.resolve();
    const pending = reads.facts(observation.session, workspaceRef).then(facts => {
      const properties = safeGroupProperties(facts);
      const fingerprint = JSON.stringify(properties);
      if (fingerprint !== current?.fingerprint) sink.groupIdentify({ groupType: "workspace", groupKey: workspaceRef, properties });
      groups.set(workspaceRef, { fingerprint, refreshedAt: now(), pending: null });
    }, error => {
      groups.set(workspaceRef, { fingerprint: current?.fingerprint ?? "", refreshedAt: now(), pending: null });
      log({ level: "warn", event: "analytics_failed", stage: "facts", request_id: observation.requestId, error_code: errorName(error) });
    });
    groups.set(workspaceRef, { fingerprint: current?.fingerprint ?? "", refreshedAt: current?.refreshedAt ?? 0, pending });
    return pending;
  };

  const once = (key: string | null): boolean => {
    if (!key) return true;
    if (emitted.has(key)) return false;
    if (emitted.size >= ONCE_LIMIT) emitted.delete(emitted.values().next().value!);
    emitted.add(key);
    return true;
  };

  const observe = (observation: OperationObservation): void => {
    const entry = matchOperation(observation.method, observation.path);
    if (!entry) return;
    const ok = observation.status < 400;
    const captured = isCapturedOperation(entry);
    const rule = ok ? MILESTONES[entry.operation] : undefined;
    if (!captured && !rule) return;
    // Clone now: once the middleware returns, the body streams to the client.
    const needsBody = Boolean(rule?.needsBody) || (captured && !ok && !observation.errorCode);
    let copy: Response | null = null;
    try { copy = needsBody ? observation.response.clone() : null; } catch { copy = null; }
    const observedAt = new Date(now());
    const base = { operation: entry.operation, surface: observation.surface, request_id: observation.requestId };

    void (async () => {
      const body = copy ? await readJson(copy) : null;
      const workspaceRef = await resolveWorkspace(observation);
      const groups = workspaceRef ? { workspace: workspaceRef } : undefined;
      const send = (event: string, properties: Record<string, unknown>) => sink.capture({
        distinctId: observation.session.userId, event, properties: safeEventProperties(properties), timestamp: observedAt,
        ...(groups ? { groups } : {}),
      });
      if (captured) {
        const errorCode = ok ? null : observation.errorCode
          ?? text((body?.error as Body | undefined)?.code) ?? `HTTP_${observation.status}`;
        send(ok ? "api_operation_completed" : "api_operation_failed", {
          ...base, outcome: ok ? "ok" : "failed", duration_ms: observation.durationMs, http_status: observation.status,
          ...(errorCode ? { error_code: errorCode } : {}),
        });
      }
      if (rule && (!rule.when || rule.when(observation, body)) && once(rule.once ? `${entry.operation}:${rule.once(observation, body) ?? ""}` : null)) {
        send(rule.event, { ...base, ...(rule.facts?.(observation, body) ?? {}) });
      }
      if (workspaceRef) await identifyGroup(observation, workspaceRef);
    })().catch(error => {
      log({ level: "warn", event: "analytics_failed", stage: "capture", operation: entry.operation, request_id: observation.requestId, error_code: errorName(error) });
    });
  };

  return {
    enabled: true,
    observe: observation => {
      try { observe(observation); } catch (error) {
        log({ level: "warn", event: "analytics_failed", stage: "capture", request_id: observation.requestId, error_code: errorName(error) });
      }
    },
    shutdown: async () => {
      try { await sink.shutdown(3_000); } catch (error) {
        log({ level: "warn", event: "analytics_failed", stage: "shutdown", error_code: errorName(error) });
      }
    },
  };
}

// ---------------------------------------------------------------- posthog

export interface PostHogSettings { apiKey: string; host: string }

/** The production sink: small batches, short timeouts, no geo lookup, errors logged and swallowed. */
export function createPostHogSink(settings: PostHogSettings, log: (event: AnalyticsLogEvent) => void): AnalyticsSink {
  const client = new PostHog(settings.apiKey, {
    host: settings.host, flushAt: 10, flushInterval: 5_000, requestTimeout: 5_000, fetchRetryCount: 2, disableGeoip: true,
  });
  client.on("error", error => log({ level: "warn", event: "analytics_failed", stage: "sink", error_code: errorName(error) }));
  return {
    capture: message => client.capture(message),
    groupIdentify: message => client.groupIdentify(message),
    shutdown: timeoutMs => client.shutdown(timeoutMs),
  };
}
