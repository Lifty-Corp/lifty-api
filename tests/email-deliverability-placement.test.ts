import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlacementReportReader, storedPlacementDetail } from "../src/email-deliverability-placement.js";
import type { SourceTest } from "../src/email-deliverability-contracts.js";

const test = (overrides: Partial<SourceTest> = {}): SourceTest => ({
  provider: "smartlead", test_ref: "smartlead:900004", provider_test_ref: "900004", source: "smartlead_result",
  execution_status: "completed", passed: true, tested_at: "2026-09-27T19:34:38Z", ...overrides,
});
afterEach(() => vi.unstubAllGlobals());

describe("stored placement detail", () => {
  it("keeps historical references without contacting the retired provider", async () => {
    const fetch = vi.fn(() => { throw new Error("Unexpected provider request"); });
    vi.stubGlobal("fetch", fetch);
    const detail = await createPlacementReportReader()([test()], "sl-only@a.test");
    expect(detail).toEqual([{ test_ref: "smartlead:900004", status: "no_report", message: expect.any(String), providers: [], auth: null, blacklisted: null }]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("normalizes stored samples without inventing zeros or replacing their reference", async () => {
    const sample = test({ provider: "mailivery", test_ref: "mailivery:7001", provider_test_ref: "7001", source: "lifty_request",
      families: { gmail: { inbox: 2, total: 2 }, o365: { inbox: 1, spam: 1, total: 2, missing: 0 } } });
    const [detail] = await createPlacementReportReader()([sample], "uni-only@a.test");
    expect(detail).toMatchObject({ test_ref: "mailivery:7001", status: "ok", auth: null, blacklisted: null, providers: [
      { provider: "gmail", inbox: 2, spam: null, other: null, missing: null, total: 2 },
      { provider: "outlook", inbox: 1, spam: 1, other: null, missing: 0, total: 2 },
    ] });
    expect(storedPlacementDetail(test({ provider: "mailivery", families: null })).status).toBe("no_report");
  });
});
