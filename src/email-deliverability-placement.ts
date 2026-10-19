import type { PlacementDetail, SourceTest } from "./email-deliverability-contracts.js";

// Placement detail is projected only from retained database evidence. Retired
// providers are never contacted to enrich an existing test.
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nullableCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/** Stored per-family samples preserve missing counts as unknown, never zero. */
export function storedPlacementDetail(test: SourceTest): PlacementDetail {
  const families = test.families ?? null;
  const breakdown = (provider: "gmail" | "outlook", sample: unknown) => {
    const counts = record(sample);
    return counts ? [{ provider, inbox: nullableCount(counts.inbox), spam: nullableCount(counts.spam), other: nullableCount(counts.other),
      missing: nullableCount(counts.missing), total: nullableCount(counts.total) }] : [];
  };
  const providers = families ? [...breakdown("gmail", families.gmail), ...breakdown("outlook", families.o365)] : [];
  return providers.length === 0
    ? { test_ref: test.test_ref, status: "no_report", message: "This test stored no per-provider placement.", providers: [], auth: null, blacklisted: null }
    : { test_ref: test.test_ref, status: "ok", message: "Per-provider placement stored with the test. Authentication and blacklist results are not recorded for this provider.",
      providers, auth: null, blacklisted: null };
}


export function createPlacementReportReader() {
  return async function readPlacementDetails(tests: SourceTest[], _mailboxEmail: string): Promise<PlacementDetail[]> {
    return tests.map(storedPlacementDetail);
  };
}
export type PlacementReportReader = ReturnType<typeof createPlacementReportReader>;
