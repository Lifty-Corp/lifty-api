import { describe, expect, it, vi } from "vitest";

import {
  ALLOWED_EVENT_PROPERTIES, MILESTONES, analyticsSurface, createAnalytics, isCapturedOperation, matchOperation, noopAnalytics,
  operationCatalog, safeEventProperties, safeGroupProperties,
  type AnalyticsCapture, type AnalyticsGroupIdentify, type AnalyticsReads, type AnalyticsSink, type OperationObservation,
} from "../src/analytics.js";
import { stageOperations } from "../src/stage-contracts.js";

const workspaceRef = "22222222-2222-4222-8222-222222222222";
const session = { userId: "founder-1", client: {} };

function recorder() {
  const captures: AnalyticsCapture[] = [];
  const groups: AnalyticsGroupIdentify[] = [];
  const sink: AnalyticsSink = {
    capture: message => { captures.push(message); },
    groupIdentify: message => { groups.push(message); },
    shutdown: vi.fn(async () => {}),
  };
  return { sink, captures, groups };
}
const reads = (facts: Awaited<ReturnType<AnalyticsReads["facts"]>> = { name: "Example", slug: "example", plan_key: "free", plan_kind: "self_serve" }): AnalyticsReads => ({
  workspace: vi.fn(async () => workspaceRef),
  facts: vi.fn(async () => facts),
});
const observation = (overrides: Partial<OperationObservation> & { body?: unknown } = {}): OperationObservation => {
  const { body, ...rest } = overrides;
  return {
    session, method: "POST", path: "/v1/workspace/crm/sync", query: {}, surface: "http",
    requestId: "11111111-1111-4111-8111-111111111111", selection: null, status: 200, durationMs: 42, errorCode: null,
    response: Response.json(body ?? { ok: true }, { status: rest.status ?? 200 }),
    ...rest,
  };
};
const settled = () => new Promise(resolve => setTimeout(resolve, 0));

describe("operation analytics", () => {
  it("maps every founder-performable catalog route to one resource.action", () => {
    const seen = new Map<string, string>();
    for (const entry of operationCatalog) {
      const key = `${entry.method} ${entry.pattern.source}`;
      expect(seen.get(key) ?? entry.operation, `duplicate route for ${entry.operation}`).toBe(entry.operation);
      seen.set(key, entry.operation);
    }
    expect(matchOperation("POST", "/v1/workspace/crm/sync")?.operation).toBe("crm.sync_start");
    expect(matchOperation("GET", "/v1/workspace/next-step")?.operation).toBe("summary.next_step");
    expect(matchOperation("GET", "/v1/workspace/sending-accounts/attempts/55555555-5555-4555-8555-555555555555")?.operation).toBe("sending-accounts.attempt");
    expect(matchOperation("DELETE", "/v1/integrations/hubspot")).toBeNull();
    expect(matchOperation("POST", "/v1/workspace/summary")).toBeNull();
    for (const operation of Object.keys(MILESTONES)) expect(operationCatalog.some(entry => entry.operation === operation), operation).toBe(true);
  });

  it("captures mutations and the next_step heartbeat, never polling or other reads", () => {
    const captured = operationCatalog.filter(isCapturedOperation).map(entry => entry.operation);
    expect(captured).toContain("summary.next_step");
    expect(captured).toContain("setup.post");
    expect(captured).toContain("campaigns.activate");
    expect(captured).not.toContain("sample-review.progress");
    expect(captured).not.toContain("summary.get");
    expect(captured).not.toContain("crm.mapping_sources");
    expect(stageOperations.crm!.mapping_sources!.method).toBe("POST");
  });

  it("allows only named, token-shaped properties, so prospect fields cannot leak", () => {
    const leak = {
      operation: "campaigns.activate", request_id: "11111111-1111-4111-8111-111111111111", duration_ms: 12, http_status: 200,
      email: "ana@example.com", name: "Ana Prospect", company: "Acme", message: "Hi Ana, saw your post", token: "v2.1234567890.abc",
      provider: "hubspot", channel: "email", error_code: "RATE_LIMITED", outcome: "ok", surface: "mcp",
      // Allowed keys with free text or addresses are dropped too.
      operation_note: "x", provider_body: "{}",
    };
    const safe = safeEventProperties({ ...leak, operation: "Hi Ana, saw your post", channel: "ana@example.com" });
    expect(Object.keys(safe).every(key => ALLOWED_EVENT_PROPERTIES.has(key))).toBe(true);
    expect(safe).toEqual({ request_id: leak.request_id, duration_ms: 12, http_status: 200, provider: "hubspot",
      error_code: "RATE_LIMITED", outcome: "ok", surface: "mcp" });
    expect(JSON.stringify(safe)).not.toMatch(/Ana|example\.com|Acme|v2\./);
    expect(safeGroupProperties({ name: "Tom Foolery & Co.", slug: "tom-foolery", analytics_class: "customer", plan_key: "growth",
      plan_kind: "managed", assignment_authority: "lift", created_at: "2026-10-01T00:00:00Z",
      ...({ owner_email: "tom@example.com", name_with_mail: "x" } as object) }))
      .toEqual({ name: "Tom Foolery & Co.", slug: "tom-foolery", analytics_class: "customer", plan_key: "growth",
        plan_kind: "managed", assignment_authority: "lift", created_at: "2026-10-01T00:00:00Z" });
    expect(safeGroupProperties({ name: "ana@example.com", slug: "https://evil.example" })).toEqual({});
  });

  it("sends api_operation_completed with the workspace group and identifies the group once per change", async () => {
    const { sink, captures, groups } = recorder();
    let now = 1_000_000;
    const facts = vi.fn(async () => ({ name: "Example", slug: "example", plan_key: "free", plan_kind: "self_serve" }));
    const analytics = createAnalytics({ sink, reads: { workspace: async () => workspaceRef, facts }, now: () => now });
    analytics.observe(observation({ surface: "mcp" }));
    analytics.observe(observation({ method: "GET", path: "/v1/workspace/next-step", durationMs: 7 }));
    analytics.observe(observation({ method: "GET", path: "/v1/workspace/runs/progress" }));
    await settled(); await settled();

    expect(captures.map(c => c.event)).toEqual(["api_operation_completed", "crm_sync_started", "api_operation_completed"]);
    expect(captures[0]).toMatchObject({ distinctId: "founder-1", groups: { workspace: workspaceRef },
      properties: { operation: "crm.sync_start", surface: "mcp", outcome: "ok", duration_ms: 42, http_status: 200, request_id: "11111111-1111-4111-8111-111111111111" } });
    expect(captures[0]!.timestamp).toBeInstanceOf(Date);
    expect(captures[2]!.properties).toMatchObject({ operation: "summary.next_step", duration_ms: 7 });
    expect(groups).toEqual([{ groupType: "workspace", groupKey: workspaceRef,
      properties: { name: "Example", slug: "example", plan_key: "free", plan_kind: "self_serve" } }]);
    expect(facts).toHaveBeenCalledTimes(1);

    // Within the refresh window nothing is re-read; after it, only a change re-identifies.
    analytics.observe(observation());
    await settled(); await settled();
    expect(facts).toHaveBeenCalledTimes(1);
    now += 16 * 60_000;
    analytics.observe(observation());
    await settled(); await settled();
    expect(facts).toHaveBeenCalledTimes(2);
    expect(groups).toHaveLength(1);
    facts.mockResolvedValueOnce({ name: "Example", slug: "example", plan_key: "growth", plan_kind: "managed" });
    now += 16 * 60_000;
    analytics.observe(observation());
    await settled(); await settled();
    expect(groups).toHaveLength(2);
    expect(groups[1]!.properties.plan_key).toBe("growth");
  });

  it("sends api_operation_failed with the public error code and no milestone", async () => {
    const { sink, captures } = recorder();
    const analytics = createAnalytics({ sink, reads: reads() });
    analytics.observe(observation({ status: 409, errorCode: "CRM_AUTOMATIC_SYNC_PAUSED" }));
    analytics.observe(observation({ status: 429, body: { error: { code: "RATE_LIMITED", message: "Too many requests. Try again in a minute." } } }));
    analytics.observe(observation({ path: "/v1/workspace/campaigns/55555555-5555-4555-8555-555555555555/activate", status: 500 }));
    await settled(); await settled();
    expect(captures.map(c => [c.event, c.properties.error_code, c.properties.outcome])).toEqual([
      ["api_operation_failed", "CRM_AUTOMATIC_SYNC_PAUSED", "failed"],
      ["api_operation_failed", "RATE_LIMITED", "failed"],
      ["api_operation_failed", "HTTP_500", "failed"],
    ]);
    expect(JSON.stringify(captures)).not.toContain("Too many requests");
  });

  it("emits each milestone on success with the workspace group and bounded facts", async () => {
    const { sink, captures } = recorder();
    const analytics = createAnalytics({ sink, reads: reads() });
    const attempt = "55555555-5555-4555-8555-555555555555";
    analytics.observe(observation({ path: "/v1/workspace/setup" }));
    analytics.observe(observation({ path: "/v1/workspace/sample-review", body: { state: "queued", created: true } }));
    analytics.observe(observation({ path: "/v1/workspace/sample-review", body: { state: "running", created: false } }));
    analytics.observe(observation({ method: "GET", path: "/v1/workspace/crm", query: { attempt_ref: attempt }, facts: { provider: "attio" },
      body: { status: "connected", attempt_ref: attempt, verified: true } }));
    analytics.observe(observation({ method: "GET", path: "/v1/workspace/crm", query: { attempt_ref: attempt }, facts: { provider: "attio" },
      body: { status: "connected", attempt_ref: attempt, verified: true } }));
    analytics.observe(observation({ method: "GET", path: "/v1/workspace/crm", query: {}, body: { provider: "attio", status: "connected" } }));
    analytics.observe(observation({ method: "GET", path: `/v1/workspace/sending-accounts/attempts/${attempt}`,
      body: { id: attempt, state: "connected", channel: "linkedin", account_id: "acc", declaration: { email: "ana@example.com" } } }));
    analytics.observe(observation({ method: "GET", path: `/v1/workspace/sending-accounts/attempts/${attempt}`, body: { id: attempt, state: "pending", channel: "linkedin" } }));
    analytics.observe(observation({ method: "GET", path: "/v1/workspace/notifications", query: { attempt_ref: attempt },
      body: { status: "connected", attempt_ref: attempt, verified: true } }));
    analytics.observe(observation({ path: "/v1/workspace/campaigns/55555555-5555-4555-8555-555555555555/publish", status: 422, errorCode: "INVALID_REQUEST" }));
    await settled(); await settled();

    const milestones = captures.filter(c => !c.event.startsWith("api_operation_"));
    expect(milestones.map(c => [c.event, c.properties.provider, c.properties.channel])).toEqual([
      ["setup_submitted", undefined, undefined],
      ["sample_review_started", undefined, undefined],
      ["crm_connected", "attio", undefined],
      ["sending_account_connected", "unipile", "linkedin"],
      ["slack_connected", "slack", undefined],
    ]);
    for (const capture of milestones) {
      expect(capture.groups).toEqual({ workspace: workspaceRef });
      expect(Object.keys(capture.properties).every(key => ALLOWED_EVENT_PROPERTIES.has(key))).toBe(true);
    }
    expect(JSON.stringify(captures)).not.toMatch(/example\.com|acc"/);
    // Reads that are not mutations carry no api_operation_* event, only the milestone.
    expect(captures.filter(c => c.event === "api_operation_completed").map(c => c.properties.operation))
      .toEqual(["setup.post", "sample-review.post", "sample-review.post"]);
  });

  it("captures without a group when the session resolves no workspace and survives read failures", async () => {
    const { sink, captures, groups } = recorder();
    const log = vi.fn();
    const workspace = vi.fn<AnalyticsReads["workspace"]>().mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("db down")).mockResolvedValue(workspaceRef);
    const analytics = createAnalytics({ sink, reads: { workspace, facts: async () => { throw new Error("billing down"); } }, log });
    analytics.observe(observation({ path: "/v1/workspace/business" }));
    await settled(); await settled();
    analytics.observe(observation());
    await settled(); await settled();
    analytics.observe(observation());
    await settled(); await settled();
    expect(captures.filter(c => c.event === "api_operation_completed").map(c => c.groups)).toEqual([undefined, undefined, { workspace: workspaceRef }]);
    expect(groups).toEqual([]);
    expect(workspace).toHaveBeenCalledTimes(3);
    expect(log.mock.calls.map(([event]) => event.stage)).toEqual(["workspace", "facts"]);
    expect(JSON.stringify(log.mock.calls)).not.toContain("db down");
  });

  it("is a no-op without a sink and never throws from a broken sink", async () => {
    expect(createAnalytics({ sink: null, reads: reads() })).toBe(noopAnalytics);
    expect(noopAnalytics.enabled).toBe(false);
    const log = vi.fn();
    const analytics = createAnalytics({ sink: { capture: () => { throw new Error("boom"); }, groupIdentify: () => {}, shutdown: async () => { throw new Error("stuck"); } }, reads: reads(), log });
    expect(() => analytics.observe(observation())).not.toThrow();
    await settled(); await settled();
    await expect(analytics.shutdown()).resolves.toBeUndefined();
    expect(log.mock.calls.map(([event]) => event.stage)).toEqual(["capture", "shutdown"]);
  });

  it("names the surface from the MCP fence and the installed CLI's user agent", () => {
    expect(analyticsSurface(true, "lifty-cli/1.2.0")).toBe("mcp");
    expect(analyticsSurface(false, "lifty-cli/1.2.0 node/22")).toBe("cli");
    expect(analyticsSurface(false, "node")).toBe("http");
    expect(analyticsSurface(false, undefined)).toBe("http");
  });
});
