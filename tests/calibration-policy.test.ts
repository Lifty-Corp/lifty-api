import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { StartRunResultSchema } from "../src/contracts.js";

const authenticate = async () => ({ ok: true as const, session: { userId: "founder", client: {} } });
const headers = { "x-lifty-client-contract": "lifty-cli-context.v11" };
const checkpoint = {
  state: "failed", run_ref: "22222222-2222-4222-8222-222222222222",
  requested_leads: 5, workspace: { workspace_ref: "33333333-3333-4333-8333-333333333333", name: "Example" },
  created: false, attempt: 0, calibration_policy: "qualified_ab_v1", error_code: "calibration_review_required",
} as const;

const getWorkspace = async () => ({ state: "ready_for_connections" as const, workspace: checkpoint.workspace, next_action: null });

describe("calibration policy rollout", () => {
  it("starts a tier-independent saved-cohort retry", async () => {
    const path = "/v1/workspace/sample-review";
    const queued = {
      state: "queued" as const, run_ref: checkpoint.run_ref, requested_leads: 5,
      workspace: checkpoint.workspace, created: false, attempt: 1,
      calibration_policy: "researched_v1" as const,
    };
    const enqueueFirstRun = vi.fn(async () => ({ id: "retry-job" }));
    const response = await createApp({ authenticate, getWorkspace, startRun: async () => queued, enqueueFirstRun })
      .request(path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(queued);
    expect(enqueueFirstRun).toHaveBeenCalledWith(checkpoint.run_ref, 1);
  });

  it("returns all five researched candidates, including C and a missing LinkedIn profile", async () => {
    const path = "/v1/workspace/sample-review";
    const status = {
      state: "succeeded" as const, run_ref: checkpoint.run_ref, requested_leads: 5,
      calibration_policy: "researched_v1" as const, leads_discovered: 5, leads_researched: 5,
      error_code: null, started_at: "2026-09-17T00:00:00Z", completed_at: "2026-09-17T00:01:00Z", reviewed_at: null,
      workspace: checkpoint.workspace, leads: ["A", "A", "A", "B", "C"].map((tier, i) => ({
        name: `Candidate ${i}`, title: "CEO", company: `Company ${i}`,
        linkedin_url: i === 4 ? null : `https://linkedin.com/in/candidate-${i}`, tier,
        fit_rationale: tier === "C" ? "Confirmed mismatch with the target." : "Evidence supports this fit.", stage: "researched",
      })),
    };
    const response = await createApp({ authenticate, getWorkspace, getRunStatus: async () => status }).request(path, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(status);
  });

  it.each([undefined, "lifty-cli-context.v3", "lifty-cli-context.v6", "unknown"])("rejects an incompatible client before starting or enqueueing (%s)", async version => {
    const startRun = vi.fn(); const enqueueFirstRun = vi.fn();
    const app = createApp({ authenticate, startRun, enqueueFirstRun });
    const response = await app.request("/v1/workspace/sample-review", { method: "POST", headers: version ? { "x-lifty-client-contract": version } : {} });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("CONTEXT_CLIENT_UNSUPPORTED");
    expect(startRun).not.toHaveBeenCalled(); expect(enqueueFirstRun).not.toHaveBeenCalled();
  });

  it("reattaches a saved quality checkpoint without enqueueing any work", async () => {
    const startRun = vi.fn(async () => checkpoint); const enqueueFirstRun = vi.fn();
    const app = createApp({ authenticate, startRun, enqueueFirstRun });
    const response = await app.request("/v1/workspace/sample-review", { method: "POST", headers });
    expect(response.status).toBe(200); expect(await response.json()).toEqual(checkpoint);
    expect(startRun).toHaveBeenCalledOnce(); expect(enqueueFirstRun).not.toHaveBeenCalled();
  });

  it("does not accept a terminal start response for arbitrary failures", () => {
    expect(StartRunResultSchema.safeParse(checkpoint).success).toBe(true);
    for (const invalid of [{ error_code: "research_failed" }, { created: true }, { calibration_policy: "tier_a_v1" }]) {
      expect(StartRunResultSchema.safeParse({ ...checkpoint, ...invalid }).success).toBe(false);
    }
  });

  it("keeps current-client status read-only and preserves the policy and actual grades", async () => {
    const status = {
      state: "succeeded" as const, run_ref: checkpoint.run_ref, requested_leads: 5,
      calibration_policy: "qualified_ab_v1" as const, leads_discovered: 5, leads_researched: 5,
      error_code: null, started_at: "2026-09-16T00:00:00Z", completed_at: "2026-09-16T00:01:00Z", reviewed_at: null,
      workspace: checkpoint.workspace, leads: [{ name: "Founder", title: "CEO", company: "Example",
        linkedin_url: "https://linkedin.com/in/founder", tier: "B", fit_rationale: "Relevant product, weaker buying evidence.", stage: "qualified" }],
    };
    const response = await createApp({ authenticate, getWorkspace, getRunStatus: async () => status }).request("/v1/workspace/sample-review", { headers });
    expect(response.status).toBe(200); expect(await response.json()).toEqual(status);
  });
});
