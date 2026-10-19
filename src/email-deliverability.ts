import { AccountsGetSchema, type Account } from "./identity-contracts.js";
import { z } from "zod";
import type { AuthSession } from "./app.js";
import { PublicError } from "./errors.js";
import { REQUIRED_WARMUP_ACTIVE_DAYS } from "./email-warmup-contracts.js";
import { addUtcDays, blockingMessage, checkValue, dnsHoldRecords } from "./email-warmup.js";
import {
  DELIVERABILITY_DETAIL_MAX_REPORTS, DELIVERABILITY_SCHEMA_VERSION, DeliverabilityQuery, DeliverabilityResponse, DeliverabilitySource,
  type Campaign, type DeliverabilityMailbox, type DeliverabilityQueryInput, type PlacementDetail, type PlacementTest, type Reason,
  type SourceCampaign, type SourceConnection, type SourceMailbox, type SourceMailivery, type SourceSending, type SourceTest, type State,
  type WarmupSource,
} from "./email-deliverability-contracts.js";
import { createPlacementReportReader, type PlacementReportReader } from "./email-deliverability-placement.js";

// Canonical rules this presentation explains; none of them is decided here.
/** lifty_email_warmup_unlocked / outreach_email_warmup_status: 24-hour evidence. */
const MAILIVERY_EVIDENCE_FRESH_HOURS = 24;
/**
 * Placement evidence is current for 10 days: outreach_email_mailbox_ready /
 * lifty_email_sender_gate for Unipile connections under the strict policy.
 */
const PLACEMENT_FRESH_DAYS = 10;
const LIFTY_BETA_POLICY = /^lifty\.personal-beta\./;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type Tone = State["tone"];
const reason = (code: string, message: string): Reason => ({ code, message: message.slice(0, 400) });
function make<C extends string>(code: C, label: string, tone: Tone, description: string, reasons: Reason[] = []): State<C> {
  return { code, label: label.slice(0, 120), tone, description: description.slice(0, 600), reasons: dedupe(reasons).slice(0, 20) };
}
function dedupe(reasons: Reason[]): Reason[] {
  const seen = new Set<string>();
  return reasons.filter(item => !seen.has(`${item.code}:${item.message}`) && seen.add(`${item.code}:${item.message}`));
}
const ms = (value: string | null | undefined) => value ? Date.parse(value) : Number.NaN;
const iso = (at: number) => new Date(at).toISOString();
const day = (value: string | null | undefined) => value ? value.slice(0, 10) : null;
const n = <T>(value: T | null | undefined): T | null => value ?? null;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

type Evidence = { observed_at: string | null; freshness: "fresh" | "stale" | "unknown" | "not_applicable"; fresh_until: string | null };
/** Missing evidence and an unknown rule are both "unknown"; never fresh by default. */
function freshness(observedAt: string | null | undefined, maxAgeMs: number | null, now: Date): Evidence {
  const observed = ms(observedAt);
  if (!Number.isFinite(observed)) return { observed_at: null, freshness: "unknown", fresh_until: null };
  if (maxAgeMs === null) return { observed_at: iso(observed), freshness: "unknown", fresh_until: null };
  return { observed_at: iso(observed), freshness: now.getTime() <= observed + maxAgeMs ? "fresh" : "stale", fresh_until: iso(observed + maxAgeMs) };
}

// ------------------------------------------------------------- placement

function executionOf(test: SourceTest): Pick<PlacementTest, "execution_status" | "execution_reason"> {
  const failure = test.failure_code ?? null;
  const policy = failure && LIFTY_BETA_POLICY.test(failure)
    ? reason("disabled_by_policy", "Placement tests are disabled by this workspace's beta policy. This request will not run.") : null;
  switch (test.execution_status) {
    case "completed": return { execution_status: "completed", execution_reason: null };
    case "running": return { execution_status: "running", execution_reason: policy };
    case "queued": case "ready":
      return { execution_status: "pending", execution_reason: policy };
    case "awaiting_confirmation":
      return { execution_status: "pending", execution_reason: policy ?? reason("awaiting_confirmation", "Waiting for someone to review the seed recipients and authorize the test. No seed email is sent before that.") };
    case "failed":
      return { execution_status: "error", execution_reason: policy ?? reason(failure && /^[a-z][a-z0-9_]{0,63}$/.test(failure) ? failure : "execution_failed",
        failure ? `The test did not complete (${failure}). This is not a placement result.` : "The test did not complete. This is not a placement result.") };
    case "blocked":
      return { execution_status: "error", execution_reason: policy ?? reason("blocked", "Safety checks stopped this test before it sent. This is not a placement result.") };
    case "ambiguous":
      return { execution_status: "unknown", execution_reason: reason("ambiguous", "The provider's result is uncertain. Check the existing test before creating another.") };
    default:
      return { execution_status: "unknown", execution_reason: reason("unknown_execution_state", "The test's execution state is not recognized.") };
  }
}

function counts(source: SourceTest["counts"]): PlacementTest["counts"] {
  if (!source) return null;
  return { inbox: n(source.inbox), spam: n(source.spam), other: n(source.other), missing: n(source.missing), total: n(source.total) };
}

function presentTest(test: SourceTest, now: Date): PlacementTest {
  const execution = executionOf(test);
  const verdict = execution.execution_status === "completed" && typeof test.passed === "boolean" ? (test.passed ? "pass" : "fail") : "unknown";
  const tally = test.counts?.inbox != null && test.counts?.total != null ? ` · ${test.counts.inbox}/${test.counts.total} inbox` : "";
  const label = execution.execution_status === "completed"
    ? verdict === "pass" ? `Passed${tally}` : verdict === "fail" ? `Failed${tally}` : "Completed · no verdict"
    : execution.execution_status === "pending" ? (execution.execution_reason?.code === "awaiting_confirmation" ? "Waiting for authorization"
      : execution.execution_reason?.code === "disabled_by_policy" ? "Not run · disabled by policy" : "Pending")
    : execution.execution_status === "running" ? "Running" : execution.execution_status === "error" ? "Did not run" : "Uncertain";
  const families = test.families ? {
    gmail: test.families.gmail ? counts(test.families.gmail) : null,
    outlook: test.families.o365 ? counts(test.families.o365) : null,
  } : null;
  return {
    test_ref: test.test_ref,
    provider: /^[a-z][a-z0-9_-]{0,39}$/.test(test.provider) ? test.provider : "other",
    source: test.source, name: n(test.name), ...execution, verdict, label,
    tested_at: iso(ms(test.tested_at)), completed_at: test.completed_at ? iso(ms(test.completed_at)) : null,
    age_days: Math.max(0, Math.floor((now.getTime() - ms(test.completed_at ?? test.tested_at)) / DAY)),
    policy_version: n(test.policy_version), counts: counts(test.counts), families,
    detail_available: execution.execution_status === "completed" && Boolean(families?.gmail || families?.outlook),
  };
}

function placementRule(mailbox: SourceMailbox): { maxAgeDays: number | null; rule: string; applies: boolean; disabled: boolean } {
  // outreach_email_mailbox_ready governs LIFT-managed Unipile inboxes only;
  // Lifty workspaces follow their own email policy, which the source doesn't carry.
  if (mailbox.workspace_managed_by !== "lifty" && mailbox.warmup.mailivery.some(item => item.binding)) return { maxAgeDays: PLACEMENT_FRESH_DAYS, applies: true, disabled: false,
    rule: `This inbox's send check needs a passing placement test from the last ${PLACEMENT_FRESH_DAYS} days.` };
  const beta = [...mailbox.placement.recent_tests, mailbox.placement.latest_completed_test]
    .some(test => test?.failure_code && LIFTY_BETA_POLICY.test(test.failure_code));
  if (beta) return { maxAgeDays: null, applies: false, disabled: true, rule: "Placement tests are disabled by this workspace's beta policy." };
  return { maxAgeDays: null, applies: false, disabled: false, rule: "No placement freshness rule is known for this inbox, so its age is shown without a verdict on currency." };
}

function initialWarmupPending(warmup: DeliverabilityMailbox["warmup"]): boolean {
  return (warmup.status.code === "active" || warmup.status.code === "pending")
    && (warmup.current ? [warmup.current] : warmup.sources).some(source => source.period_complete === false);
}

function presentPlacement(mailbox: SourceMailbox, warmup: DeliverabilityMailbox["warmup"], now: Date, detail: PlacementDetail[] | null): DeliverabilityMailbox["placement"] {
  const source = mailbox.placement;
  const recent = source.recent_tests.map(test => presentTest(test, now));
  const latestCompleted = source.latest_completed_test ? presentTest(source.latest_completed_test, now) : null;
  const rule = placementRule(mailbox);
  const measured = freshness(source.latest_completed_test?.completed_at ?? source.latest_completed_test?.tested_at,
    rule.maxAgeDays === null ? null : rule.maxAgeDays * DAY, now);
  const evidence = { ...measured, freshness: rule.disabled ? "not_applicable" as const : measured.freshness, max_age_days: rule.maxAgeDays, rule: rule.rule };
  const reasons: Reason[] = [];
  const latestAttempt = recent.find(test => test.test_ref === source.latest_test_ref) ?? null;
  if (source.latest_test_ref && source.latest_test_ref !== source.latest_completed_test_ref) {
    const attempt = latestAttempt;
    if (!attempt) reasons.push(reason("newer_attempt", "A newer test attempt exists without a result."));
    else if (attempt.execution_status === "pending" || attempt.execution_status === "running")
      reasons.push(reason("newer_test_in_progress", `A newer test from ${day(attempt.tested_at)} is ${attempt.execution_status === "running" ? "running" : "pending"}; the result below is the latest completed one.`));
    else if (attempt.execution_status === "error")
      reasons.push(reason("newer_test_did_not_run", `The newest test from ${day(attempt.tested_at)} did not run${attempt.execution_reason ? `: ${attempt.execution_reason.message}` : "."}`));
    else if (attempt.execution_status === "unknown") reasons.push(reason("newer_test_uncertain", `The newest test from ${day(attempt.tested_at)} has an uncertain result.`));
    else if (attempt.verdict === "unknown") reasons.push(reason("newer_test_no_verdict", `The newest test from ${day(attempt.tested_at)} completed without a verdict.`));
  }
  if (latestAttempt?.execution_reason?.code === "disabled_by_policy") reasons.push(latestAttempt.execution_reason);
  let status: DeliverabilityMailbox["placement"]["status"];
  if (source.test_count === 0) {
    const afterWarmup = rule.applies && initialWarmupPending(warmup);
    status = make("no_tests", "No placement test yet", rule.applies && !afterWarmup ? "warn" : "muted",
      afterWarmup ? "The first placement test is due after the initial warmup period finishes. No test has been recorded yet."
        : rule.applies ? "No placement test has been recorded for this inbox. Missing evidence is not a passing result." : `No placement test has been recorded for this inbox. ${rule.rule}`, reasons);
  } else if (!latestCompleted) {
    status = make("no_result", "No placement result yet", "warn",
      "Tests were attempted, but none has completed with a result. A pending or failed run is not a placement verdict.", reasons);
  } else if (latestCompleted.verdict === "fail") {
    status = make("failed", `Failed placement · ${day(latestCompleted.completed_at ?? latestCompleted.tested_at)}`, "bad",
      `The latest completed test failed: ${latestCompleted.label}.${evidence.freshness === "stale" ? ` It is older than ${rule.maxAgeDays} days.` : ""}`, reasons);
  } else if (latestCompleted.verdict === "unknown") {
    status = make("no_result", "Latest test has no verdict", "warn", "The latest completed test was stored without a pass or fail verdict. It is not treated as passed.", reasons);
  } else if (evidence.freshness === "stale") {
    status = make("stale", `Passed ${day(latestCompleted.completed_at ?? latestCompleted.tested_at)} · out of date`, "warn",
      `The latest completed test passed, but it is older than ${rule.maxAgeDays} days, so it no longer counts as current evidence.`, reasons);
  } else {
    status = make("passed", `Passed · ${day(latestCompleted.completed_at ?? latestCompleted.tested_at)}`, "ok",
      `The latest completed test passed: ${latestCompleted.label}. ${rule.rule}`, reasons);
  }
  return {
    status, evidence, test_count: source.test_count,
    latest_test_ref: n(source.latest_test_ref), latest_completed_test_ref: n(source.latest_completed_test_ref),
    latest_completed_test: latestCompleted, recent_tests: recent, detail,
  };
}

// ---------------------------------------------------------------- warmup

function mailiveryWarmup(item: SourceMailivery, connection: SourceConnection | undefined, now: Date): WarmupSource {
  const binding = item.binding ?? null;
  const evidence = item.evidence ?? null;
  const reasons: Reason[] = [];
  const blocking = binding?.blocking_reason && /^[a-z][a-z0-9_]{0,63}$/.test(binding.blocking_reason) ? binding.blocking_reason
    : binding?.state === "pending_consent" ? "microsoft_consent_pending" : null;
  if (blocking) reasons.push(reason(blocking, blockingMessage(blocking) ?? "Warmup has a problem Lifty can't describe yet."));
  if (binding?.requested_action === "pause") reasons.push(reason("pause_requested", "Pausing warmup at the next check."));
  if (binding?.requested_action === "resume") reasons.push(reason("resume_requested", "Resuming warmup at the next check."));
  if (binding?.requested_action === "remove") reasons.push(reason("remove_requested", "Removing warmup at the next check."));
  if (evidence?.healthy === false) reasons.push(reason("warmup_unhealthy", "The latest warmup check was not healthy. Days with a problem don't count."));
  const check = freshness(evidence?.observed_at, MAILIVERY_EVIDENCE_FRESH_HOURS * HOUR, now);
  if (check.freshness === "stale") reasons.push(reason("warmup_check_stale", `The latest warmup check is older than ${MAILIVERY_EVIDENCE_FRESH_HOURS} hours.`));
  let state: WarmupSource["state"];
  switch (binding?.state) {
    case "warming": state = make("active", "Warming", blocking || evidence?.healthy === false ? "warn" : "ok", "Lifty is warming this inbox.", reasons); break;
    case "link_issued": state = make("pending", "Waiting for mailbox connection", "watch", "Warmup starts after the mailbox is authorized for warmup.", reasons); break;
    case "pending_consent": state = dnsHoldRecords(blocking)
      ? make("pending", "Waiting for valid DNS records", "warn", "Warmup starts on its own once the mailbox domain has valid SPF, DMARC and MX records.", reasons)
      : make("pending", "Waiting for Microsoft consent", "watch", "Warmup starts after Microsoft consent is finished for warmup.", reasons); break;
    case "paused": state = make("paused", "Paused", "warn", "Warmup is paused. Paused days don't count toward the warmup period.", reasons); break;
    case "problem": state = make("problem", "Needs attention", "bad", "Warmup has a problem. Days with a problem don't count.", reasons); break;
    case "removed": state = make("not_running", "Removed", "muted", "Warmup was removed for this inbox.", reasons); break;
    default: state = make("unknown", "Warmup state unknown", "warn", "Warmup evidence exists, but no current warmup setup is recorded.", reasons);
  }
  const personal = connection?.mailbox_use === "personal";
  const required = personal ? null : REQUIRED_WARMUP_ACTIVE_DAYS;
  const activeDays = evidence?.active_duration_days ?? null;
  const complete = required === null || activeDays === null ? null : activeDays >= required;
  const remaining = required !== null && activeDays !== null ? Math.max(0, required - activeDays) : null;
  const snapshot = binding?.snapshot ?? null;
  return {
    provider: "mailivery", connection_ref: item.connection_ref, state,
    started_at: evidence?.started_at ? iso(ms(evidence.started_at)) : null, started_at_basis: evidence?.started_at ? "provider_evidence" : null,
    active_days: activeDays, required_days: required, period_complete: complete,
    estimated_completion: complete === false && remaining !== null ? { at: null, on: addUtcDays(now, remaining),
      basis: "Estimated if warmup runs every day from today. Paused days and days with a problem don't count, so the date moves later if warmup stops." } : null,
    outreach_unlocked: personal ? null : n(item.outreach_unlocked),
    last_check: { ...check, observed_at: check.observed_at ?? (binding?.last_readback_at ? iso(ms(binding.last_readback_at)) : null) },
    metrics: { warmup_emails_today: n(snapshot?.emails_sent_today), ramp_target: n(snapshot?.email_per_day_target) },
    checks: snapshot ? { spf: checkValue(snapshot.spf), dmarc: checkValue(snapshot.dmarc), mx: checkValue(snapshot.mx) } : null,
    provider_detail: null,
  };
}

const warmupRank: Record<WarmupSource["state"]["code"], number> = { problem: 0, not_running: 1, paused: 2, unknown: 3, pending: 4, active: 5, none: 6 };

function presentWarmup(mailbox: SourceMailbox, now: Date, account?: Account): DeliverabilityMailbox["warmup"] {
  const sources = mailbox.warmup.mailivery.map(item => mailiveryWarmup(item, mailbox.connections.find(c => c.connection_ref === item.connection_ref), now));
  const current = account ? sources.find(item => item.connection_ref === account.id) ?? null : null;
  const effective = account ? (current ? [current] : []) : sources;
  if (effective.length === 0) {
    return { status: make("none", "No warmup evidence", "muted", "No warmup provider has reported on this inbox. Missing evidence is not a healthy result."), sources, current };
  }
  const worst = [...effective].sort((a, b) => warmupRank[a.state.code] - warmupRank[b.state.code])[0]!;
  const progress = effective.find(source => source.required_days !== null && source.active_days !== null) ?? null;
  let label = worst.state.label;
  if (worst.state.code === "active" && progress) {
    label = progress.period_complete ? `${worst.state.label} · initial period complete` : `${worst.state.label} · day ${progress.active_days} of ${progress.required_days}`;
  }
  const names = effective.map(() => "Lifty warmup").join(" and ");
  const period = progress?.period_complete ? " The initial warmup period is complete; warmup can keep running after it, and that alone does not enable campaigns." : "";
  return {
    status: make(worst.state.code, label, worst.state.tone, `${worst.state.description}${effective.length > 1 ? ` Evidence comes from ${names}.` : ""}${period}`,
      effective.flatMap(source => source.state.reasons)),
    sources, current,
  };
}

// ------------------------------------------------------ readiness and gates

const controlReasons: Record<string, string> = {
  workspace_suspended: "This workspace is paused.",
  sender_inactive: "The sender for this connection is inactive.",
  connection_unavailable: "The connection is not connected.",
  channel_paused: "Email is paused for this workspace.",
  sender_mailbox_ineligible: "This inbox hasn't passed its warmup and placement checks for sending.",
  owner_mismatch: "The lead belongs to a different sender.",
};

function controlScope(scopeKey: string): Connection["controls"][number]["scope"] {
  if (scopeKey === "global") return "global";
  const parts = scopeKey.split(":");
  if (parts.includes("connection")) return "connection";
  if (parts.includes("sender")) return "sender";
  if (parts.length === 2) return "channel";
  if (parts.length === 1 && /^[0-9a-f-]{36}$/i.test(scopeKey)) return "workspace";
  return "other";
}
type Connection = DeliverabilityMailbox["connections"][number];

function controlReason(value: string): Reason {
  if (value.startsWith("send_paused:")) {
    const scope = controlScope(value.slice("send_paused:".length));
    return reason("send_paused", scope === "global" ? "Sending is paused for all LIFT email." : `Sending is paused at the ${scope} level.`);
  }
  const code = /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : "send_blocked";
  return reason(code, controlReasons[value] ?? "A send control blocks this connection.");
}

function connectionGate(mailbox: SourceMailbox, connection: SourceConnection): Connection["send_gate"] & { gate: DeliverabilityMailbox["readiness"]["paths"][number]["gate"] } {
  const managedBy = mailbox.workspace_managed_by ?? null;
  if (managedBy === "lift") {
    return connection.send_block_reason
      ? { gate: "lift_send_controls", ...make("blocked", "Blocked", "bad", "LIFT's send controls block this connection.", [controlReason(connection.send_block_reason)]) }
      : { gate: "lift_send_controls", ...make("allowed", "Allowed to send", "ok", "Passes LIFT's send controls, including this inbox's warmup and placement checks.") };
  }
  if (managedBy === "lifty") {
    const reasons: Reason[] = [];
    if (connection.status !== "connected") reasons.push(reason("connection_unavailable", `The connection is ${connection.status}.`));
    for (const hold of connection.holds) reasons.push(reason("hold", `A safety hold is active (${hold.reason}).`));
    if (!connection.mailbox_use) reasons.push(reason("mailbox_use_required", "Say whether this is a mailbox you already use or a new outreach account before sending. Reconnect the email account to answer."));
    const unlocked = mailbox.warmup.mailivery.find(item => item.connection_ref === connection.connection_ref)?.outreach_unlocked === true;
    if (connection.mailbox_use === "outreach" && !unlocked) reasons.push(reason("warmup_required", `Warmup holds this dedicated account: it needs a healthy check after ${REQUIRED_WARMUP_ACTIVE_DAYS} active warmup days, or its warmup emails are landing in spam. Check warmup status for which.`));
    return reasons.length > 0
      ? { gate: "lifty_campaign_checks", ...make("blocked", "Blocked", "bad", "Lifty's send checks block this connection.", reasons) }
      : { gate: "lifty_campaign_checks", ...make("no_known_blocker", "No known blocker", "watch",
        "Nothing recorded blocks this connection. Lifty runs the remaining checks, such as a fresh connection check, when a campaign sends.") };
  }
  return connection.send_block_reason
    ? { gate: "unknown", ...make("blocked", "Blocked", "bad", "A send control blocks this connection.", [controlReason(connection.send_block_reason)]) }
    : { gate: "unknown", ...make("unknown", "Send checks unknown", "warn", "This server's data doesn't say which send checks govern this connection.") };
}

function presentConnection(mailbox: SourceMailbox, connection: SourceConnection): Connection & { gate: DeliverabilityMailbox["readiness"]["paths"][number]["gate"] } {
  const { gate, ...sendGate } = connectionGate(mailbox, connection);
  return {
    gate,
    connection_ref: connection.connection_ref,
    provider: /^[a-z][a-z0-9_-]{0,39}$/.test(connection.provider) ? connection.provider : "other",
    status: connection.status, sender_ref: n(connection.sender_ref), mailbox_use: n(connection.mailbox_use),
    daily_send_limit: n(connection.daily_send_limit), health_checked_at: connection.health_checked_at ? iso(ms(connection.health_checked_at)) : null,
    created_at: iso(ms(connection.created_at)), send_gate: sendGate,
    controls: connection.controls.map(control => ({ scope: controlScope(control.scope_key), send_paused: control.send_paused,
      capture_paused: control.capture_paused, updated_at: control.updated_at ? iso(ms(control.updated_at)) : null })),
    holds: connection.holds.map(hold => ({ reason: hold.reason, updated_at: hold.updated_at ? iso(ms(hold.updated_at)) : null })),
  };
}

function presentReadiness(paths: DeliverabilityMailbox["readiness"]["paths"]): DeliverabilityMailbox["readiness"] {
  const codes = paths.map(path => path.state.code);
  const name = (path: (typeof paths)[number]) => `${path.provider[0]!.toUpperCase()}${path.provider.slice(1)} connection`;
  const blockedReasons = paths.filter(path => path.state.code !== "allowed")
    .flatMap(path => path.state.reasons.map(item => reason(item.code, `${name(path)}: ${item.message}`)));
  let summary: State<DeliverabilityMailbox["readiness"]["code"]>;
  if (paths.length === 0) summary = make("unknown", "No sending path", "muted", "This inbox has no email connection, so nothing can send from it.");
  else if (codes.every(code => code === "allowed")) summary = make("ready", "Ready to send", "ok",
    `Allowed to send through ${paths.map(name).join(" and ")}. Being allowed doesn't mean it is sending; see campaigns.`);
  else if (codes.includes("allowed")) summary = make("partially_ready", "Ready on some paths", "watch",
    `Allowed through ${paths.filter(path => path.state.code === "allowed").map(name).join(" and ")}; other paths are blocked or unknown.`, blockedReasons);
  else if (codes.includes("no_known_blocker")) summary = make("no_known_blocker", "No known blocker", "watch",
    "Nothing recorded blocks sending. The remaining checks run when a campaign sends.", blockedReasons);
  else if (codes.every(code => code === "blocked")) summary = make("blocked", "Not ready to send", "bad", "Every sending path for this inbox is blocked.", blockedReasons);
  else summary = make("unknown", "Readiness unknown", "warn", "At least one sending path couldn't be evaluated from the stored data.", blockedReasons);
  return { ...summary, paths };
}

// ------------------------------------------------------------- campaigns

const campaignLabels: Record<Campaign["status"]["code"], [string, Tone]> = {
  active: ["Active", "ok"], paused: ["Paused", "warn"], draft: ["Draft", "muted"], closed_to_new_leads: ["Closed to new leads", "muted"],
  completed: ["Completed", "muted"], archived: ["Archived", "muted"], error: ["Error", "bad"], unknown: ["Unknown", "warn"],
};

function presentCampaign(source: SourceCampaign, paths: DeliverabilityMailbox["readiness"]["paths"]): Campaign {
  const states = source.states;
  const code = (states.active ?? 0) > 0 ? "active" : (states.paused ?? 0) > 0 ? "paused"
    : (states.draft ?? 0) + (states.approved ?? 0) > 0 ? "draft" : "completed";
  const [label, tone] = campaignLabels[code];
  const status = make(code, label, tone, `${plural(source.campaign_count, "direct Lifty campaign")} use this connection: ${Object.entries(states).map(([key, count]) => `${count} ${key}`).join(", ")}.`);
  const path = paths.find(item => item.connection_ref === source.connection_ref);
  let sending: Campaign["sending"];
  if (code !== "active") sending = make("not_active", "Not active", "muted", "The campaign isn't active, so this inbox doesn't send for it.");
  else if (!path || path.state.code === "unknown") sending = make("unverified", "Unverified", "warn", "Lifty can't tell whether this inbox passes the send checks for this campaign.");
  else if (path.state.code === "blocked") sending = make("blocked", "Blocked", "bad", "The campaign is active, but this inbox is blocked from sending.", path.state.reasons);
  else sending = make("enabled", path.state.code === "allowed" ? "Allowed to send" : "No known blocker", path.state.code === "allowed" ? "ok" : "watch",
    "The campaign is active and this inbox passes its send checks. Lifty has no dated send evidence here, so this doesn't confirm recent sends.");
  return {
    source: source.source,
    connection_ref: source.connection_ref,
    provider: "unipile",
    campaign_count: source.campaign_count,
    states, status, sending,
    created_at: source.latest_created_at ? iso(ms(source.latest_created_at)) : null,
  };
}

function presentCampaigns(items: Campaign[]): DeliverabilityMailbox["campaigns"] {
  const active = items.filter(item => item.status.code === "active");
  const enabled = active.filter(item => item.sending.code === "enabled");
  const blocked = active.filter(item => item.sending.code === "blocked");
  const unverified = active.filter(item => item.sending.code === "unverified");
  const name = (item: Campaign) => "Direct Lifty campaigns";
  let status: DeliverabilityMailbox["campaigns"]["status"];
  if (enabled.length > 0) status = make("in_campaign_enabled", `In ${plural(enabled.length, "active campaign")} · allowed`, "ok",
    "Configured on an active campaign and passing its send checks. Lifty has no dated send evidence here, so this doesn't confirm recent sends.",
    [...blocked, ...unverified].map(item => reason(`campaign_${item.sending.code}`, `${name(item)}: ${item.sending.description}`)));
  else if (blocked.length > 0) status = make("in_campaign_blocked", `In ${plural(blocked.length, "active campaign")} · blocked`, "bad",
    "Configured on an active campaign, but this inbox is blocked from sending.", blocked.flatMap(item => item.sending.reasons));
  else if (unverified.length > 0) status = make("unverified", "Campaign state unverified", "warn",
    "Configured on an active campaign, but whether this inbox may send couldn't be verified.", unverified.flatMap(item => item.sending.reasons));
  else if (items.some(item => item.status.code === "paused")) status = make("campaign_paused", "Campaign paused", "warn", "Every campaign using this inbox is paused.");
  else if (items.length > 0) status = make("no_campaign", "No active campaign", "muted", "This inbox is only on campaigns that are not active.");
  else status = make("no_campaign", "No campaign", "muted", "This inbox isn't configured on any campaign.");
  return { status, items };
}

// ------------------------------------------------ approval, recovery, status

function presentIdentity(mailbox: SourceMailbox): DeliverabilityMailbox["identity"] {
  const names = mailbox.senders.map(sender => sender.name);
  if (mailbox.identity.status === "resolved") return make("resolved", names[0] ?? "Assigned", "ok", `This inbox belongs to ${names[0] ?? "one sender"}.`);
  if (mailbox.identity.status === "ambiguous_owner") return make("ambiguous_owner", "Owner unclear", "warn",
    "More than one sender claims this inbox. Nothing merges them automatically.", mailbox.senders.map(sender => reason("claimed_by", `${sender.name} (${sender.sender_ref})`)));
  return make("unassigned", "No sender", "muted", "No sender is assigned to this inbox.");
}

function presentStatus(parts: {
  placement: DeliverabilityMailbox["placement"]; campaigns: DeliverabilityMailbox["campaigns"];
  account: DeliverabilityMailbox["account"]; warmup: DeliverabilityMailbox["warmup"]; readiness: DeliverabilityMailbox["readiness"]; hasEvidence: boolean;
}): DeliverabilityMailbox["status"] {
  const { account, placement, campaigns, warmup, readiness } = parts;
  if (account?.outreach.code === "paused") return make("paused", account.outreach.label, account.outreach.tone, account.outreach.description, account.outreach.reasons);
  if (account?.outreach.code === "blocked") return make(campaigns.status.code === "in_campaign_blocked" ? "blocked_in_campaign" : "not_ready", account.outreach.label, account.outreach.tone, account.outreach.description, account.outreach.reasons);
  if (placement.status.code === "failed") return make("placement_failed", "Failed placement", "bad", placement.status.description, placement.status.reasons);
  if (campaigns.status.code === "in_campaign_blocked") return make("blocked_in_campaign", "In campaign · blocked", "bad", campaigns.status.description, campaigns.status.reasons);
  if (warmup.status.code === "problem") return make("warmup_problem", warmup.status.label, "warn", warmup.status.description, warmup.status.reasons);
  const ready = readiness.code === "ready" || readiness.code === "partially_ready";
  // A permissive sending path does not make the first test overdue during
  // initial warmup. Actual failures and campaign blocks still win.
  if (placement.status.code === "no_tests" && initialWarmupPending(warmup)) {
    return make("warming", warmup.status.label, "muted", `${warmup.status.description} ${placement.status.description}`, warmup.status.reasons);
  }
  // Missing placement can itself close the send gate. Do not require an open
  // gate to report that first test due once the required period is complete.
  if (placement.status.code === "no_tests" && placement.evidence.max_age_days !== null
    && warmup.sources.some(source => source.period_complete === true)
    && !warmup.sources.some(source => source.period_complete === false)) {
    return make("placement_due", "Placement test due", "warn", placement.status.description, placement.status.reasons);
  }
  if (ready && placement.evidence.max_age_days !== null && (placement.status.code === "stale" || placement.status.code === "no_tests" || placement.status.code === "no_result")) {
    return make("placement_due", "Placement test due", "warn", placement.status.description, placement.status.reasons);
  }
  if ((!account || account.outreach.code === "unknown") && (ready || campaigns.status.code === "in_campaign_enabled")) return make("not_ready", "Unverified", "warn", "A current connection check is needed to confirm whether outreach can send.");
  if (campaigns.status.code === "in_campaign_enabled") return make("in_campaign", "In campaign", "ok", campaigns.status.description, campaigns.status.reasons);
  if (ready) return make("ready_idle", "Ready · no active campaign", "watch", `${readiness.description} It isn't on an active campaign.`, readiness.reasons);
  const warming = warmup.sources.find(source => (source.state.code === "active" || source.state.code === "pending") && source.period_complete === false);
  if (warming) return make("warming", warmup.status.label, "muted", warmup.status.description, warmup.status.reasons);
  if (readiness.code === "no_known_blocker") return make("no_known_blocker", readiness.label, "watch", readiness.description, readiness.reasons);
  if (!parts.hasEvidence) return make("no_evidence", "No evidence yet", "muted", "No warmup or placement evidence is recorded for this inbox yet. Missing evidence is not a healthy result.");
  return make("not_ready", "Not ready yet", "muted", readiness.description, readiness.reasons);
}

/**
 * LIF-1341: today's sends against the inbox's daily limit, as the send budget
 * counts them. Nothing here estimates a count or decides whether a send may go.
 */
function presentSending(source: SourceSending | null | undefined): DeliverabilityMailbox["sending"] {
  const at = (value: string | null | undefined) => Number.isFinite(ms(value)) ? iso(ms(value)) : null;
  const base = { limit: n(source?.limit), used_today: null, remaining_today: null, timezone: n(source?.timezone),
    day_started_at: at(source?.day_started_at), resets_at: at(source?.resets_at) };
  if (!source) {
    return { ...base, state: make("unknown", "Today's sends unknown", "muted",
      "This server doesn't report today's sends for this inbox. A missing count is not zero sends.") };
  }
  if (source.limit === null || source.limit === undefined) {
    return { ...base, state: make("not_set", "No Lifty daily limit", "muted",
      "No email connection in Lifty sends from this inbox, so Lifty sets no daily limit for it. Sends from other tools aren't counted here.") };
  }
  if (source.shared) {
    return { ...base, state: make("unknown", "Today's sends not shown", "muted",
      `Another workspace also uses this inbox, so its sends today aren't shown here. This workspace's limit is ${source.limit} a day.`) };
  }
  if (source.used === null || source.used === undefined || source.available === null || source.available === undefined) {
    return { ...base, state: make("unknown", "Today's sends unknown", "muted", "Lifty couldn't count today's sends for this inbox.") };
  }
  const zone = source.timezone ?? "UTC";
  const reasons = source.ambiguous ? [reason("send_unconfirmed", "A send from this inbox is still being confirmed, so Lifty waits before sending more from it.")] : [];
  const counted = { ...base, used_today: source.used, remaining_today: source.available };
  const used = `Lifty has used ${source.used} of this inbox's ${source.limit} daily sends today, counting replies and sends in progress.`;
  if (source.available === 0) {
    return { ...counted, state: make("limit_reached", "Daily limit reached", "warn", `${used} It can send again after midnight (${zone}).`, reasons) };
  }
  return { ...counted, state: make("available", `${source.available} of ${source.limit} left today`, source.ambiguous ? "watch" : "ok",
    `${used} The count resets at midnight (${zone}). Room left today doesn't mean the inbox is ready; its status says whether campaigns can use it.`, reasons) };
}

function presentAccount(account: Account | undefined, connections: Connection[], campaigns: DeliverabilityMailbox["campaigns"]): DeliverabilityMailbox["account"] {
  if (!account) return null;
  const connection = connections.find(item => item.connection_ref === account.id);
  let outreach: NonNullable<DeliverabilityMailbox["account"]>["outreach"];
  const paused = connection?.controls.filter(item => item.send_paused) ?? [];
  if (account.status !== "connected") outreach = make("blocked", "Blocked", "bad", "Reconnect this inbox before it can send outreach.");
  else if (account.state === "paused" || paused.length) outreach = make("paused", "Paused", "warn",
    paused.some(item => item.scope === "global") ? "Outreach is paused globally."
      : paused.some(item => item.scope === "workspace" || item.scope === "channel") ? "Workspace outreach is paused." : "Account outreach is paused.");
  else if (connection?.holds.length) outreach = make("blocked", "Blocked", "bad", "An outreach safety hold is active.",
    connection.holds.map(item => reason("hold", `A safety hold is active (${item.reason}).`)));
  else if (connection?.send_gate.code === "blocked") outreach = make("blocked", "Blocked", "bad",
    connection.send_gate.description, connection.send_gate.reasons);
  else if (account.observation.state === "unverified" || !connection || connection.send_gate.code === "unknown") outreach = make("unknown", "Unverified", "warn", "A current connection check is needed to confirm whether outreach can send.");
  else {
    const active = campaigns.items.filter(item => item.status.code === "active" &&
      item.connection_ref === account.id);
    if (!active.length) outreach = make("idle", "No active campaign", "muted", "This account is enabled, but no active campaign uses this connection.");
    else if (active.some(item => item.sending.code === "enabled")) outreach = make("enabled", "Enabled", "ok", "An active campaign can use this account when its schedule and send checks allow.");
    else if (active.some(item => item.sending.code === "unverified")) outreach = make("unknown", "Unverified", "warn", "The active campaign's sending state could not be confirmed.");
    else outreach = make("blocked", "Blocked", "warn", "An active campaign cannot currently send from this account.", active.flatMap(item => item.sending.reasons));
  }
  return { connection_ref: account.id, status: account.status, observation: account.observation.state, checked_at: account.checked_at, outreach };
}

function presentMailbox(source: SourceMailbox, workspaces: Map<string, { slug: string; name: string }>, now: Date, detail: PlacementDetail[] | null, accounts?: Account[]): DeliverabilityMailbox {
  const matches = accounts?.filter(item => item.channel === "email" && item.identity?.toLowerCase() === source.email.toLowerCase());
  // The canonical read selects routes and retained identities. Never guess across owners.
  const account = matches?.length === 1 ? matches[0] : undefined;
  const connections = source.connections.map(connection => presentConnection(source, connection));
  const connected = new Set(connections.filter(item => item.status === "connected").map(item => item.provider));
  // A disconnected connection is history when the same provider has a live one.
  const connectionPaths = connections.filter(item => item.status === "connected" || !connected.has(item.provider))
    .map(item => ({ provider: item.provider, connection_ref: item.connection_ref, gate: item.gate, state: item.send_gate }));
  const paths = connectionPaths;
  const readiness = presentReadiness(paths);
  const warmup = presentWarmup(source, now, account);
  const placement = presentPlacement(source, warmup, now, detail);
  const campaigns = presentCampaigns(source.campaigns.map(item => presentCampaign(item, paths)));
  const currentAccount = presentAccount(account, connections, campaigns);
  const workspace = workspaces.get(source.workspace_ref);
  const unique = (values: string[]) => [...new Set(values)].slice(0, 5);
  return {
    mailbox_ref: source.mailbox_ref,
    workspace: { workspace_ref: source.workspace_ref, slug: workspace?.slug ?? null, name: workspace?.name ?? null },
    email: source.email, domain: source.domain,
    senders: source.senders.map(sender => ({ sender_ref: sender.sender_ref, name: sender.name })),
    identity: presentIdentity(source),
    account: currentAccount,
    providers: {
      sending: unique([...connections.filter(item => item.status === "connected").map(item => item.provider)]),
      warmup: unique(warmup.sources.map(item => item.provider)),
      placement: unique([...placement.recent_tests, ...(placement.latest_completed_test ? [placement.latest_completed_test] : [])].map(test => test.provider)),
    },
    status: presentStatus({ account: currentAccount, placement, campaigns, warmup, readiness,
      hasEvidence: warmup.sources.length > 0 || source.placement.test_count > 0 }),
    readiness, warmup, campaigns, placement,
    connections: connections.map(({ gate: _gate, ...connection }) => connection),
    sending: presentSending(source.sending),
    availability: source.availability,
  };
}

// ---------------------------------------------------------- workspace health

const postureStates: Record<string, [string, Tone]> = {
  healthy: ["Healthy", "ok"], watch: ["Needs watching", "watch"], degraded: ["Degraded", "warn"], critical: ["Critical", "bad"],
  insufficient_data: ["Not enough sending data", "muted"],
};
const obj = (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const num = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
const str = (value: unknown) => typeof value === "string" ? value : null;
const pct = (value: unknown) => { const v = num(value); return v !== null && v >= 0 && v <= 100 ? v : null; };

function presentWorkspaceHealth(entry: DeliverabilitySource["workspace_health"][number]): DeliverabilityResponse["workspace_health"][number] {
  const posture = entry.posture ?? null;
  const aggregate = obj(posture?.metrics);
  const components = obj(aggregate?.componentHealth);
  const placement = obj(aggregate?.placement);
  const label = posture?.client_label || entry.name;
  const base = {
    workspace_ref: entry.workspace_ref, slug: entry.slug, name: entry.name,
    scope_note: `${label}-wide. This is workspace context, not a result for any one inbox.`.slice(0, 200),
    captured_at: posture ? iso(ms(posture.captured_at)) : null, source: n(posture?.source),
    components: { placement: str(components?.placement), live: str(components?.live), lifecycle: str(components?.lifecycle) },
    placement: { gmail_inbox_pct: pct(placement?.gmailInboxPct), office365_inbox_pct: pct(placement?.office365InboxPct),
      overall_spam_pct: pct(placement?.overallSpamPct), tested_at: str(placement?.testedAt) && Number.isFinite(ms(str(placement?.testedAt))) ? iso(ms(str(placement?.testedAt))) : null },
    sends: (() => { const v = num(aggregate?.sends); return v !== null && Number.isInteger(v) && v >= 0 ? v : null; })(),
  };
  if (!posture) return { ...base, status: make("none", "No workspace health yet", "muted", "No workspace health snapshot is recorded. Missing evidence is not a healthy result.") };
  const reasons = (Array.isArray(aggregate?.reasons) ? aggregate.reasons : []).filter((item): item is string => typeof item === "string").map(text => {
    const lower = text.toLowerCase();
    if (lower.includes("placement fail")) {
      const metrics = [base.placement.gmail_inbox_pct === null ? null : `Gmail ${base.placement.gmail_inbox_pct}% inbox`,
        base.placement.office365_inbox_pct === null ? null : `Outlook ${base.placement.office365_inbox_pct}% inbox`,
        base.placement.overall_spam_pct === null ? null : `${base.placement.overall_spam_pct}% spam`].filter(Boolean);
      return reason("workspace_placement_failed", `At least one placement test in this workspace failed${metrics.length > 0 ? `. Snapshot averages: ${metrics.join(" · ")}` : ""}.`);
    }
    if (lower.includes("no send volume")) return reason("no_send_volume", "No campaign send volume yet, so live bounce and complaint health is unavailable.");
    if (lower.includes("insufficient sends")) return reason("insufficient_sends", "Not enough campaign send volume yet to judge live bounce and complaint health.");
    return reason("workspace_reason", text);
  });
  const known = postureStates[posture.status];
  const status = known
    ? make(posture.status as "healthy", known[0], known[1], `Workspace health from the ${posture.source ?? "latest"} snapshot of ${day(posture.captured_at)}. It covers the whole workspace, not one inbox.`, reasons)
    : make("unknown", `Unknown workspace health (${posture.status})`.slice(0, 120), "bad", "The workspace health snapshot has an unrecognized status.", reasons);
  return { ...base, status };
}

// -------------------------------------------------------------- assembly

export interface PresentOptions {
  detail?: "placement" | null;
  details?: ReadonlyMap<string, PlacementDetail[]>;
  warnings?: DeliverabilityResponse["warnings"];
  accounts?: ReadonlyMap<string, Account[]>;
}

/** Maps the authorized database source to the public contract. Pure. */
export function presentDeliverability(source: DeliverabilitySource, now: Date, options: PresentOptions = {}): DeliverabilityResponse {
  const workspaces = new Map(source.filters.workspaces.map(item => [item.workspace_ref, { slug: item.slug, name: item.name }]));
  return DeliverabilityResponse.parse({
    schema_version: DELIVERABILITY_SCHEMA_VERSION,
    generated_at: iso(ms(source.generated_at)),
    scope: { kind: source.scope.kind, workspace_ref: n(source.scope.workspace_ref), workspace_slug: n(source.scope.workspace_slug) },
    query: { sender: n(source.query.sender), mailbox: n(source.query.mailbox), history_limit: source.query.history_limit, limit: source.query.limit,
      detail: options.detail ?? null },
    filters: {
      workspaces: source.filters.workspaces.map(({ workspace_ref, slug, name, is_active }) => ({ workspace_ref, slug, name, is_active })),
      senders: source.filters.senders.map(({ sender_ref, workspace_ref, name, mailbox_count }) => ({ sender_ref, workspace_ref, name, mailbox_count })), unassigned_count: source.filters.unassigned_count,
    },
    workspace_health: source.workspace_health.map(presentWorkspaceHealth),
    mailboxes: source.mailboxes.map(mailbox => presentMailbox(mailbox, workspaces, now,
      options.detail === "placement" ? options.details?.get(mailbox.mailbox_ref) ?? [] : null, options.accounts?.get(mailbox.workspace_ref))),
    total_count: source.total_count,
    next_cursor: n(source.next_cursor),
    warnings: options.warnings ?? [],
  });
}

// ------------------------------------------------------------- operation

// Errors raised by public.deliverability_read (LIF-1041).
const rpcErrors: Record<string, { status: number; message: string }> = {
  unauthenticated: { status: 401, message: "Sign in to LIFTY before reading deliverability." },
  deliverability_invalid_request: { status: 400, message: "Check the deliverability filters and try again." },
  deliverability_workspace_required: { status: 400, message: "Choose a workspace, or request the fleet explicitly." },
  deliverability_fleet_forbidden: { status: 403, message: "Only LIFT admins can read the whole fleet." },
  deliverability_workspace_forbidden: { status: 403, message: "Choose a workspace you belong to." },
  deliverability_sender_not_found: { status: 404, message: "That sender isn't in the workspaces you can read." },
  deliverability_mailbox_not_found: { status: 404, message: "That inbox isn't in the workspaces you can read." },
};

function unavailable(message = "LIFTY could not read deliverability. Retry shortly.") {
  return new PublicError({ status: 502, code: "DELIVERABILITY_UNAVAILABLE", message });
}

function mapRpcError(error: unknown): never {
  const parsed = z.object({ message: z.string().optional() }).safeParse(error);
  const message = parsed.success ? parsed.data.message ?? "" : "";
  const known = Object.hasOwn(rpcErrors, message) ? rpcErrors[message] : undefined;
  if (!known) throw unavailable();
  throw new PublicError({ status: known.status, code: message === "unauthenticated" ? "UNAUTHORIZED" : message.toUpperCase(), message: known.message });
}

interface RpcClient { rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> }

export interface EmailDeliverabilityDependencies {
  now?: () => Date;
  /** Projects retained placement samples for authorized tests without provider I/O. */
  readPlacementDetails?: PlacementReportReader;
}

export function createEmailDeliverabilityOperations(dependencies: EmailDeliverabilityDependencies = {}) {
  const now = dependencies.now ?? (() => new Date());
  return {
    async read(session: AuthSession, input: DeliverabilityQueryInput): Promise<DeliverabilityResponse> {
      const query = DeliverabilityQuery.parse(input);
      const { detail, ...rest } = query;
      const pQuery = Object.fromEntries(Object.entries(rest).filter(([key, value]) => value !== undefined && !(key === "scope" && value === "workspace")));
      let response: { data: unknown; error: unknown };
      // The caller's own session: the database authorizes scope, filters and cursor.
      try { response = await (session.client as RpcClient).rpc("deliverability_read", { p_query: pQuery }); }
      catch { throw unavailable(); }
      if (response.error) mapRpcError(response.error);
      const parsed = DeliverabilitySource.safeParse(response.data);
      if (!parsed.success) throw unavailable("LIFTY returned an invalid deliverability read. Retry shortly.");
      const source = parsed.data;
      // Defense in depth: every inbox must belong to the authorized scope the database reported.
      const scope = new Set(source.filters.workspaces.map(item => item.workspace_ref));
      if (source.scope.kind !== query.scope || source.mailboxes.some(mailbox => !scope.has(mailbox.workspace_ref))
        || (query.scope === "workspace" && source.filters.workspaces.length !== 1)) {
        throw unavailable("LIFTY returned an inconsistent deliverability read. Retry shortly.");
      }
      const warnings: DeliverabilityResponse["warnings"] = [];
      const details = new Map<string, PlacementDetail[]>();
      const accounts = new Map<string, Account[]>();
      const workspaces = [...new Set(source.mailboxes.map(item => item.workspace_ref))];
      // Reuse the identity authority with the caller's session, once per represented
      // workspace. Bounded batches avoid a per-inbox read or unbounded fleet fanout.
      for (let offset = 0; offset < workspaces.length; offset += 4) {
        await Promise.all(workspaces.slice(offset, offset + 4).map(async workspace => {
          try {
            const result = await (session.client as RpcClient).rpc("get_lifty_sending_accounts", {
              p_workspace_id: workspace, p_query: { channel: "email" },
            });
            const parsedAccounts = AccountsGetSchema.safeParse(result.data);
            if (!result.error && parsedAccounts.success && parsedAccounts.data.workspace.workspace_ref === workspace) {
              accounts.set(workspace, parsedAccounts.data.accounts);
            }
          } catch { /* Unavailable evidence stays unknown, never disconnected or enabled. */ }
        }));
      }
      if (detail === "placement") {
        if (source.mailboxes.length !== 1) throw unavailable("LIFTY returned an inconsistent deliverability read. Retry shortly.");
        const mailbox = source.mailboxes[0]!;
        // Only authorized, completed tests; the newest few, never caller-chosen ids.
        const tests = mailbox.placement.recent_tests.filter(test => test.execution_status === "completed").slice(0, DELIVERABILITY_DETAIL_MAX_REPORTS);
        const read = dependencies.readPlacementDetails ?? createPlacementReportReader();
        const results = await read(tests, mailbox.email);
        details.set(mailbox.mailbox_ref, results);
        for (const result of results) {
          if (result.status === "unavailable") warnings.push({ code: "placement_detail_unavailable", source: "placement_detail", mailbox_ref: mailbox.mailbox_ref, message: result.message });
        }
        if (results.some(result => result.status === "not_configured")) {
          warnings.push({ code: "placement_detail_not_configured", source: "placement_detail", mailbox_ref: mailbox.mailbox_ref, message: "Provider placement reports are not configured on this server." });
        }
      }
      return presentDeliverability(source, now(), { detail: detail ?? null, details, warnings, accounts });
    },
  };
}
export type EmailDeliverabilityOperations = ReturnType<typeof createEmailDeliverabilityOperations>;
