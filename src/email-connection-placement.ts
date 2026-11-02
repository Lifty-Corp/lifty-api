import { z } from "zod";
import type { AuthSession } from "./app.js";
import { PublicError } from "./errors.js";
import { EmailWorkspace } from "./email-contracts.js";

// LIF-1063: Mailivery placement tests for a mailbox Mailivery already warms.
// Members queue one test through public.lifty_email_connection_placement with
// their own session; the Jobs worker creates it in Mailivery, which sends its
// seeds from that mailbox. Nothing here calls the provider or spends credits.
// Since 2026-10-05 Lifty also queues one test by itself when a mailbox finishes
// warmup; accepting warmup covers it (origin `warmup_complete`). Since LIF-1223
// a mailbox the founder already uses is tested as soon as Lifty warms it
// (origin `connected`). LIF-1186 refreshes measured results weekly (`recurring`).

export const PlacementStatusRequest = z.object({
  workspace: EmailWorkspace,
  connection_ref: z.uuid().optional(),
}).strict();
export type PlacementStatusInput = z.infer<typeof PlacementStatusRequest>;
export const PlacementStartRequest = PlacementStatusRequest.extend({
  subject: z.string().trim().min(1).max(500).describe("Subject of the test email. Use the first email of the real sequence."),
  body: z.string().trim().min(10).max(20_000).describe("Plain-text body of the test email. Use the first email of the real sequence."),
  confirm: z.literal(true).describe("Explicit consent: Mailivery sends this email from the mailbox to roughly 20-40 of its seed inboxes and uses one test credit."),
}).strict();
export type PlacementStartInput = z.infer<typeof PlacementStartRequest>;

const timestamp = z.iso.datetime({ offset: true });
const count = z.number().int().min(0).max(1_000_000);
const Counts = z.object({ total: count, inbox: count, spam: count, missing: count });
const StoredStatus = z.object({
  workspace_ref: z.uuid(), connection_ref: z.uuid(), email: z.email().nullable(),
  provider: z.literal("mailivery"), method: z.literal("connected_mailbox"),
  can_request: z.boolean(), blocked_reason: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).nullable(),
  last_passed_at: timestamp.nullable(), passing_until: timestamp.nullable(),
  test: z.object({
    placement_ref: z.uuid(), status: z.enum(["queued", "creating", "ambiguous", "running", "completed", "failed"]),
    origin: z.enum(["member", "warmup_complete", "connected", "recurring"]), test_ref: z.string().regex(/^[1-9][0-9]{0,17}$/).nullable(), total_seeds: count.nullable(),
    requested_at: timestamp, completed_at: timestamp.nullable(), passed: z.boolean().nullable(),
    failure_code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).nullable(), policy_version: z.string().max(200).nullable(),
    samples: z.object({ gmail: Counts, microsoft: Counts, overall: Counts }).nullable(),
  }).nullable(),
});

const Reason = z.object({ code: z.string(), message: z.string().min(1).max(400) }).strict();
const PublicCounts = Counts.strict();
export const ConnectionPlacementStatus = z.object({
  provider: z.literal("mailivery"),
  method: z.literal("connected_mailbox"),
  workspace_ref: z.uuid(),
  connection_ref: z.uuid(),
  email: z.email().nullable(),
  can_request: z.boolean(),
  blocked_reason: Reason.nullable(),
  rule: z.string().min(1).max(400),
  last_passed_at: timestamp.nullable(),
  passing_until: timestamp.nullable(),
  test: z.object({
    placement_ref: z.uuid(),
    state: z.enum(["pending", "running", "uncertain", "passed", "failed", "did_not_run"]),
    automatic: z.boolean(),
    label: z.string().min(1).max(300),
    test_ref: z.string().nullable(),
    total_seeds: count.nullable(),
    requested_at: timestamp,
    completed_at: timestamp.nullable(),
    failure: Reason.nullable(),
    counts: z.object({ gmail: PublicCounts, microsoft: PublicCounts, overall: PublicCounts }).strict().nullable(),
  }).strict().nullable(),
}).strict();
export type ConnectionPlacementStatus = z.infer<typeof ConnectionPlacementStatus>;

const rpcErrors: Record<string, { status: number; message: string }> = {
  unauthenticated: { status: 401, message: "Sign in to LIFTY before checking or requesting a placement test." },
  email_invalid_request: { status: 400, message: "Choose a workspace, and for a new test give a subject, a body of at least 10 characters and explicit consent." },
  email_workspace_forbidden: { status: 403, message: "Choose a workspace you belong to." },
  email_connection_required: { status: 409, message: "Choose the email connection to test. A workspace with more than one warmed mailbox needs connection_ref." },
  email_workspace_suspended: { status: 409, message: "This workspace is paused. Resume it before requesting a placement test." },
  email_placement_warmup_required: { status: 409, message: "Placement tests run through Mailivery warmup. Start warmup for this mailbox and wait until it is warming, then request the test." },
  email_placement_confirmation_required: { status: 409, message: "Confirm the test explicitly: Mailivery sends this email from the mailbox to roughly 20-40 of its seed inboxes and uses one test credit." },
  email_placement_recent: { status: 409, message: "This mailbox completed a placement test in the last 24 hours. Use that result, or request another test tomorrow." },
};
const blockedMessages: Record<string, string> = {
  email_placement_warmup_required: rpcErrors.email_placement_warmup_required!.message,
  email_workspace_suspended: rpcErrors.email_workspace_suspended!.message,
  email_connection_required: "This email connection is not connected. Reconnect it before requesting a placement test.",
  email_placement_in_progress: "A placement test for this mailbox is already in progress. Check its status instead of requesting another.",
  email_placement_recent: rpcErrors.email_placement_recent!.message,
};
const failureMessages: Record<string, string> = {
  insufficient_credits: "Mailivery has no placement test credits left. No test was created; add credits and request a new test.",
  provider_rejected: "Mailivery rejected the test request. No test was created. Check the mailbox in Mailivery, then request a new test.",
  provider_create_not_found: "Mailivery never confirmed the test and it does not exist there. You can request a new test.",
  provider_test_failed: "Mailivery reported that the test failed to run. This is not a placement result; request a new test.",
  provider_timeout: "The test did not finish within 24 hours. This is not a placement result; request a new test.",
  invalid_result: "Mailivery's result could not be read. This is not a placement result; request a new test.",
  workspace_suspended: "The workspace was paused before the test started. Nothing was sent.",
  connection_required: "The email connection was disconnected before the test started. Nothing was sent.",
  placement_warmup_required: "Mailivery warmup stopped before the test started. Nothing was sent.",
  placement_target_changed: "The mailbox or its requester changed before the test started. Nothing was sent.",
};
// Codes that prove Mailivery created nothing; SQL retries an automatic test after these a day later.
const notCreated = new Set(["insufficient_credits", "workspace_suspended", "connection_required", "placement_warmup_required", "placement_target_changed"]);

function mapRpcError(error: unknown): never {
  const parsed = z.object({ message: z.string().optional() }).safeParse(error);
  const message = parsed.success ? parsed.data.message ?? "" : "";
  const known = Object.hasOwn(rpcErrors, message) ? rpcErrors[message] : undefined;
  if (!known) throw new PublicError({ status: 502, code: "EMAIL_PLACEMENT_UNAVAILABLE", message: "LIFTY could not read or request the placement test. Retry shortly." });
  throw new PublicError({ status: known.status, code: message.toUpperCase(), message: known.message });
}

const pct = (part: number, total: number) => total > 0 ? `${Math.round(part * 100 / total)}%` : "no samples";

/** Maps the SQL view to the public shape. Pure; exported for tests. */
export function presentConnectionPlacement(stored: z.infer<typeof StoredStatus>): ConnectionPlacementStatus {
  const t = stored.test;
  let test: ConnectionPlacementStatus["test"] = null;
  if (t) {
    const automatic = t.origin !== "member";
    const retry = automatic && t.failure_code && notCreated.has(t.failure_code) ? " Lifty tries the automatic test again within a day." : "";
    const failure = t.status === "failed" && t.failure_code ? { code: t.failure_code,
      message: `${failureMessages[t.failure_code] ?? "The test did not complete. This is not a placement result."}${retry}` } : null;
    const state = t.status === "completed" ? (t.passed ? "passed" : "failed") : t.status === "queued" ? "pending"
      : t.status === "ambiguous" ? "uncertain" : t.status === "failed" ? "did_not_run" : "running";
    const summary = t.samples ? ` Gmail inbox ${pct(t.samples.gmail.inbox, t.samples.gmail.total)}, Microsoft inbox ${pct(t.samples.microsoft.inbox, t.samples.microsoft.total)}, spam ${pct(t.samples.overall.spam, t.samples.overall.total)}.` : "";
    const label = state === "passed" ? `Passed.${summary}` : state === "failed" ? `Failed.${summary} Passing needs Gmail inbox of at least 70%, some Microsoft inbox and at most 40% spam.`
      : state === "pending" ? `Queued${t.origin === "warmup_complete" ? " automatically because warmup finished" : t.origin === "connected" ? " automatically because the mailbox was connected" : t.origin === "recurring" ? " automatically for the weekly placement refresh" : ""}. Lifty creates the test in Mailivery within about 5 minutes.`
      : state === "uncertain" ? "Checking whether Mailivery created the test. Lifty will not create a second one; wait for the next check."
      : state === "running" ? "Mailivery is sending the test from this mailbox and measuring placement. This usually takes 10-20 minutes."
      : `Did not run. ${failure?.message ?? ""}`.trim();
    test = { placement_ref: t.placement_ref, state, automatic, label, test_ref: t.test_ref, total_seeds: t.total_seeds, requested_at: t.requested_at,
      completed_at: t.completed_at, failure, counts: t.status === "completed" ? t.samples : null };
  }
  const blocked = stored.blocked_reason ? { code: stored.blocked_reason.replace(/^email_/, ""),
    message: blockedMessages[stored.blocked_reason] ?? "A placement test can't be requested for this mailbox right now." } : null;
  return ConnectionPlacementStatus.parse({
    provider: "mailivery", method: "connected_mailbox", workspace_ref: stored.workspace_ref, connection_ref: stored.connection_ref,
    email: stored.email, can_request: stored.can_request, blocked_reason: blocked,
    rule: "This mailbox can send campaign email only with a passing placement test from the last 10 days, after 21 active warmup days and an explicit release. A test never releases the mailbox by itself.",
    last_passed_at: stored.last_passed_at, passing_until: stored.passing_until, test,
  });
}

export function createEmailConnectionPlacementOperations() {
  async function rpc(session: AuthSession, operation: "status" | "start", payload: Record<string, unknown>) {
    const client = session.client as { rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> };
    let response: { data: unknown; error: unknown };
    try { response = await client.rpc("lifty_email_connection_placement", { p_operation: operation, p_payload: payload }); }
    catch { mapRpcError(null); }
    if (response.error) mapRpcError(response.error);
    const parsed = StoredStatus.safeParse(response.data);
    if (!parsed.success || (payload.connection_ref !== undefined && parsed.data.connection_ref !== payload.connection_ref)) {
      throw new PublicError({ status: 502, code: "EMAIL_PLACEMENT_UNAVAILABLE", message: "LIFTY returned an invalid placement status. Retry shortly." });
    }
    return presentConnectionPlacement(parsed.data);
  }
  return {
    status: (session: AuthSession, input: PlacementStatusInput) => rpc(session, "status", PlacementStatusRequest.parse(input)),
    start: async (session: AuthSession, input: PlacementStartInput) => {
      const result = await rpc(session, "start", PlacementStartRequest.parse(input));
      // Queued, or the already open test after a retried start.
      if (!result.test || !["pending", "running", "uncertain"].includes(result.test.state)) {
        throw new PublicError({ status: 502, code: "EMAIL_PLACEMENT_UNAVAILABLE", message: "LIFTY did not confirm the placement request. Check its status before requesting again." });
      }
      return result;
    },
  };
}
export type EmailConnectionPlacementOperations = ReturnType<typeof createEmailConnectionPlacementOperations>;
