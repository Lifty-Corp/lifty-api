// Generated from lift-gtm-dashboard/lib/dashboard-errors/policy.ts; regenerate with scripts/sync-crm-contract.mjs.
export type ExpectedFailureReason = "validation" | "authorization" | "not-found" | "conflict" | "cancelled";
export type RecoveryReason = "invalid-input" | "optional-browser-storage" | "clipboard-denied" | "cookie-write-during-render" | "analytics-best-effort" | "telemetry-fallback" | "retry-before-final-failure" | "abort-superseded";
const expectedResults = new WeakMap<object, ExpectedFailureReason>();
export class ExpectedDashboardError extends Error {
  readonly reason: ExpectedFailureReason;
  readonly digest: string;
  constructor(message: string, reason: ExpectedFailureReason) { super(message); this.name = "ExpectedDashboardError"; this.reason = reason; this.digest = `dashboard_expected_${reason}`; }
}
/** Next preserves Error.digest while removing private server messages/metadata. */
export function dashboardFailureDisposition(value: unknown): "expected" | "retained" | "observed" | undefined {
  if (!value || typeof value !== "object" || !("digest" in value) || typeof value.digest !== "string") return;
  if (/^dashboard_expected_(validation|authorization|not-found|conflict|cancelled)$/.test(value.digest)) return "expected";
  if (/^dashboard_retained_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.digest)) return "retained";
  if (/^dashboard_observed_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.digest)) return "observed";
}
export function markDashboardFailureRetained(error: Error, id: string, impact: DashboardImpact = "action"): void {
  try { Object.defineProperty(error,"digest",{value:`dashboard_${impact === "unconfirmed" ? "observed" : "retained"}_${id}`,configurable:true,writable:true}); }
  catch { /* A frozen error must still propagate; a second observation is preferable to losing it. */ }
}
/** Server-only metadata: the original result remains serializable and unchanged. */
export function expectedDashboardFailure<T>(value: T, reason: ExpectedFailureReason): T {
  if (value !== null && (typeof value === "object" || typeof value === "function")) expectedResults.set(value, reason);
  return value;
}
export function expectedFailureReason(value: unknown): ExpectedFailureReason | undefined {
  return value instanceof ExpectedDashboardError ? value.reason
    : value !== null && typeof value === "object" ? expectedResults.get(value) : undefined;
}
/** Explicit, audited non-fault fallback. No reporting or side effects. */
export function expectedDashboardRecovery<T>(_reason: RecoveryReason, value: T): T { return value; }
export type DashboardImpact = "action" | "load" | "unconfirmed";
export function safeOperation(operation: string): string {
  return /^[a-zA-Z0-9_./#:[\]-]{4,240}$/.test(operation) ? operation : "dashboard.unknown";
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
/** Read data can legitimately describe historical failures; inspect only the result envelope. */
export function failedOperationResult(value: unknown, impact: DashboardImpact): boolean {
  if (expectedFailureReason(value)) return false;
  if (value instanceof Response) return value.status >= 400;
  if (!record(value)) return false;
  if (value.ok === false || value.success === false || (typeof value.error === "string" && value.error.length > 0)) return true;
  return impact === "action" && record(value.report) && Array.isArray(value.report.failed) && value.report.failed.some(item => !expectedFailureReason(item));
}
export function safeFailureCode(error: unknown): string {
  if (record(error) && typeof error.code === "string" && (/^(?:[0-9A-Z]{5}|PGRST\d{3})$/.test(error.code)
    || ["CONTEXT_CLIENT_UNSUPPORTED", "SUPABASE_REQUEST_FAILED", "SUPABASE_INVALID_RESPONSE", "HTTP_REQUEST_FAILED", "NETWORK_REQUEST_FAILED"].includes(error.code))) return error.code;
  if (error instanceof Error && error.name === "TimeoutError") return "REQUEST_TIMEOUT";
  return "OPERATION_FAILED";
}
