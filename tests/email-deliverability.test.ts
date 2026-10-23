import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { presentDeliverability } from "../src/email-deliverability.js";
import {
  DeliverabilityQuery, DeliverabilityResponse, DeliverabilitySource,
  type DeliverabilityMailbox, type DeliverabilitySource as Source,
} from "../src/email-deliverability-contracts.js";
import type { Account } from "../src/identity-contracts.js";

// Sources are real deliverability_read output for the LIF-1041 two-tenant
// fixture, captured at this instant (see tests/fixtures/email-deliverability).
const now = new Date("2026-09-29T19:52:59Z");
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/email-deliverability/${name}`, import.meta.url), "utf8"));
const source = (name = "source-member-a.json"): Source => {
  const parsed = DeliverabilitySource.parse(fixture(name));
  // Captured inbox evidence with the new common-gate projection attached.
  for (const mailbox of parsed.mailboxes) for (const connection of mailbox.connections) connection.send_gate_known = true;
  return parsed;
};
const inbox = (response: { mailboxes: DeliverabilityMailbox[] }, email: string, slug = "fixture-a") => {
  const found = response.mailboxes.find(item => item.email === email && item.workspace.slug === slug);
  if (!found) throw new Error(`missing ${slug}/${email}`);
  return found;
};
/** Edits one source inbox; the captured JSON stays untouched. */
function withInbox(email: string, edit: (mailbox: Source["mailboxes"][number]) => void, name?: string): Source {
  const copy = structuredClone(source(name));
  const mailbox = copy.mailboxes.find(item => item.email === email)!;
  edit(mailbox);
  return copy;
}
const present = (value: Source = source()) => presentDeliverability(value, now);

describe("deliverability contract", () => {
  it("validates the versioned response and bounded query", () => {
    expect(DeliverabilityResponse.parse(present()).schema_version).toBe("email-deliverability.v1");
    expect(() => DeliverabilityQuery.parse({ workspace: "lift", history_limit: 9 })).toThrow();
    expect(() => DeliverabilityQuery.parse({ workspace: "lift", history_limit: "9" })).toThrow();
    expect(() => DeliverabilityQuery.parse({ workspace: "lift", limit: "101" })).toThrow();
    expect(() => DeliverabilityQuery.parse({ workspace: "lift", history_limit: "3.5" })).toThrow();
    expect(DeliverabilityQuery.parse({ workspace: "lift", history_limit: "8" })).toMatchObject({ history_limit: 8, limit: 50, scope: "workspace" });
    expect(DeliverabilityQuery.parse({ workspace: "lift", sender: "unassigned" }).history_limit).toBe(3);
  });

  it("requires a workspace unless the fleet is requested, and one mailbox_ref for detail", () => {
    expect(() => DeliverabilityQuery.parse({})).toThrow(/workspace/);
    expect(DeliverabilityQuery.parse({ scope: "fleet" }).scope).toBe("fleet");
    expect(() => DeliverabilityQuery.parse({ workspace: "lift", detail: "placement" })).toThrow(/mailbox_ref/);
    expect(() => DeliverabilityQuery.parse({ workspace: "lift", detail: "placement", mailbox: "a@b.test" })).toThrow(/mailbox_ref/);
    expect(DeliverabilityQuery.parse({ workspace: "lift", detail: "placement", mailbox: "6170c056-3dab-cbb8-9213-9440fa809c62" }).detail).toBe("placement");
    expect(() => DeliverabilityQuery.parse({ workspace: "lift", is_admin: "true" })).toThrow();
    expect(() => DeliverabilityQuery.parse({ workspace: "lift", sender: "someone" })).toThrow();
  });


  it("keeps filters, paging and workspace health from the authorized source", () => {
    const response = present();
    expect(response.filters.senders.map(item => item.name)).toEqual(["Dana Smith", "Lee Park"]);
    expect(response.filters.unassigned_count).toBe(1);
    expect(response.workspace_health).toHaveLength(1);
    expect(response.workspace_health[0]!.scope_note).toMatch(/not a result for any one inbox/);
    expect(response.workspace_health[0]!.status).toMatchObject({ code: "watch", reasons: [{ message: "weekend warmup gap" }] });
    const page = present(source("source-page1.json"));
    expect(page.mailboxes).toHaveLength(2);
    expect(page.next_cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    const unassigned = present(source("source-unassigned.json"));
    expect(unassigned.mailboxes.map(item => item.email)).toEqual(["unassigned@a.test"]);
    expect(unassigned.mailboxes[0]!.identity.code).toBe("unassigned");
  });
});

describe("Unipile and Mailivery inbox", () => {
  const mailbox = inbox(present(), "uni-only@a.test");

  it("keeps a pending newest attempt apart from the latest completed result outside the limit", () => {
    expect(mailbox.placement.recent_tests.map(test => [test.execution_status, test.verdict]))
      .toEqual([["pending", "unknown"], ["running", "unknown"], ["error", "unknown"]]);
    expect(mailbox.placement.recent_tests.map(test => test.test_ref)).not.toContain("mailivery:7001");
    expect(mailbox.placement.latest_completed_test).toMatchObject({ test_ref: "mailivery:7001", verdict: "pass" });
    expect(mailbox.placement.status.code).toBe("stale");
    expect(mailbox.placement.status.reasons).toEqual([expect.objectContaining({ code: "newer_test_in_progress" })]);
  });

  it("reports a technical failure as an execution error, never a placement failure", () => {
    const failed = mailbox.placement.recent_tests[2]!;
    expect(failed).toMatchObject({ test_ref: "mailivery:7002", execution_status: "error", verdict: "unknown", label: "Did not run",
      execution_reason: { code: "provider_error" } });
    expect(failed.execution_reason!.message).toMatch(/not a placement result/);
  });

  it("projects warmup completion as an estimate from verified active days", () => {
    expect(mailbox.warmup.sources[0]).toMatchObject({ provider: "mailivery", active_days: 10, required_days: 21, period_complete: false,
      outreach_unlocked: false, started_at_basis: "provider_evidence", estimated_completion: { on: "2026-10-10", at: null } });
    expect(mailbox.warmup.sources[0]!.estimated_completion!.basis).toMatch(/^Estimated/);
    expect(mailbox.warmup.status.label).toBe("Warming · day 10 of 21");
  });

  it("explains a blocked campaign with the effective control", () => {
    expect(mailbox.campaigns.status.code).toBe("in_campaign_blocked");
    expect(mailbox.campaigns.status.reasons).toEqual([{ code: "hold", message: "A safety hold is active (operator_hold)." }, { code: "send_paused", message: "Sending is paused for all LIFT email." }]);
    expect(mailbox.connections[0]!.holds).toEqual([{ reason: "operator_hold", updated_at: expect.any(String) }]);
    expect(mailbox.status.code).toBe("blocked_in_campaign");
  });
});

describe("mixed providers, identity and missing evidence", () => {

  it("reports today's sends as the send budget counts them, never as an estimate", () => {
    type SourceSending = NonNullable<Source["mailboxes"][number]["sending"]>;
    const sending = (edit: Partial<SourceSending> | null) => inbox(present(withInbox("uni-only@a.test", mailbox => {
      mailbox.sending = edit === null ? null : { ...mailbox.sending!, ...edit };
    })), "uni-only@a.test").sending;
    expect(sending({})).toMatchObject({ limit: 10, used_today: 4, remaining_today: 6, timezone: "America/New_York",
      resets_at: "2026-09-30T04:00:00.000Z", state: { code: "available", tone: "ok", label: "6 of 10 left today" } });
    expect(sending({ used: 10, available: 0 })).toMatchObject({ used_today: 10, remaining_today: 0, state: { code: "limit_reached", tone: "warn" } });
    expect(sending({ ambiguous: true }).state).toMatchObject({ code: "available", tone: "watch", reasons: [{ code: "send_unconfirmed" }] });
    // An older database or an uncounted inbox is unknown, never zero sends.
    expect(sending(null)).toMatchObject({ limit: null, used_today: null, state: { code: "unknown", description: expect.stringMatching(/not zero sends/) } });
    expect(sending({ used: null, available: null })).toMatchObject({ limit: 10, used_today: null, state: { code: "unknown" } });
    // A mailbox shared with another workspace never shows that tenant's sends.
    expect(sending({ shared: true, used: 3, available: 7 })).toMatchObject({ limit: 10, used_today: null, remaining_today: null, state: { code: "unknown" } });
    expect(sending({ limit: null })).toMatchObject({ limit: null, used_today: null, state: { code: "not_set" } });

  });

  it("never merges the same address across tenants", () => {
    const fleet = present(source("source-fleet-fixtures.json"));
    const a = inbox(fleet, "mixed@a.test", "fixture-a");
    const b = inbox(fleet, "mixed@a.test", "fixture-b");
    expect(a.mailbox_ref).not.toBe(b.mailbox_ref);
    expect(b.placement.recent_tests.map(test => test.name)).toEqual(["LIFTY B secret"]);
    expect(a.placement.recent_tests.map(test => test.name)).not.toContain("LIFTY B secret");
  });

  it("marks ambiguous and unassigned owners explicitly", () => {
    const response = present();
    expect(inbox(response, "shared@a.test").identity).toMatchObject({ code: "ambiguous_owner", reasons: [{ code: "claimed_by" }, { code: "claimed_by" }] });
    expect(inbox(response, "unassigned@a.test").identity.code).toBe("unassigned");
  });

  it("never reads missing evidence as healthy", () => {
    const mailbox = inbox(present(), "unassigned@a.test");
    expect(mailbox.warmup.status).toMatchObject({ code: "none", label: "No warmup evidence" });
    expect(mailbox.placement.status).toMatchObject({ code: "no_tests", tone: "muted" });
    expect(mailbox.placement.evidence.freshness).toBe("unknown");
    const empty = present();
    expect(inbox(empty, "unassigned@a.test")).toMatchObject({ status: { code: "no_evidence" }, readiness: { code: "unknown" } });
  });

  it("never presents a completed test without a verdict as passed", () => {
    const response = present(withInbox("sl-only@a.test", item => {
      item.placement.recent_tests[0]!.passed = null;
      item.placement.latest_completed_test!.passed = null;
    }));
    const mailbox = inbox(response, "sl-only@a.test");
    expect(mailbox.placement.latest_completed_test).toMatchObject({ verdict: "unknown", label: "Completed · no verdict" });
    expect(mailbox.placement.status.code).toBe("no_result");
    expect(mailbox.status.code).not.toBe("in_campaign");
  });

});

describe("common strict sender gates", () => {
  it.each(["lift", "lifty", undefined])("uses the same strict placement rule regardless of old classifier %s", by => {
    const value = withInbox("uni-only@a.test", item => Object.assign(item, { workspace_managed_by: by }));
    const mailbox = inbox(present(value), "uni-only@a.test");
    expect(mailbox.placement.evidence).toMatchObject({ max_age_days: 10, freshness: "stale" });
    expect(mailbox.readiness.paths[0]!.gate).toBe("strict_sender_checks");
  });

  it("uses the evaluated database gate without guessing from plan or warmup", () => {
    const allowed = inbox(present(withInbox("uni-only@a.test", item => {
      item.connections[0]!.send_block_reason = null;
      item.connections[0]!.holds = [];
    })), "uni-only@a.test");
    expect(allowed.readiness).toMatchObject({ code: "ready", paths: [{ gate: "strict_sender_checks", state: { code: "allowed" } }] });
    const blocked = inbox(present(withInbox("uni-only@a.test", item => {
      item.connections[0]!.send_block_reason = "email_placement_required";
      item.connections[0]!.holds = [];
    })), "uni-only@a.test");
    expect(blocked.readiness.code).toBe("blocked");
    expect(blocked.readiness.reasons[0]).toMatchObject({ code: "email_placement_required", message: expect.stringContaining("last ten days") });
  });

  it("never treats a missing common-gate projection as all-clear", () => {
    const mailbox = inbox(present(withInbox("uni-only@a.test", item => {
      delete item.connections[0]!.send_gate_known;
      item.connections[0]!.send_block_reason = null;
      item.connections[0]!.holds = [];
    })), "uni-only@a.test");
    expect(mailbox.readiness.code).toBe("unknown");
    expect(mailbox.campaigns.status.code).toBe("unverified");
  });

  it("preserves explicit holds and optional personal warmup independently", () => {
    const mailbox = inbox(present(withInbox("uni-only@a.test", item => {
      item.connections[0]!.mailbox_use = "personal";
      item.connections[0]!.send_block_reason = null;
    })), "uni-only@a.test");
    expect(mailbox.warmup.sources[0]).toMatchObject({ required_days: null, period_complete: null, outreach_unlocked: null, estimated_completion: null });
    expect(mailbox.readiness.code).toBe("blocked");
    expect(mailbox.readiness.reasons.map(item => item.code)).toContain("hold");
  });
});

describe("first placement timing", () => {
  it("defers Mailivery outreach inboxes but does not impose initial warmup on habitual inboxes", () => {
    const value = withInbox("uni-only@a.test", item => {
      item.campaigns = [];
      item.connections[0]!.holds = [];
      item.connections[0]!.send_block_reason = null;
      item.connections[0]!.mailbox_use = "outreach";
      item.placement = { test_count: 0, latest_test_ref: null, latest_completed_test_ref: null, latest_completed_test: null, recent_tests: [] };
    });
    expect(inbox(present(value), "uni-only@a.test").status.code).toBe("warming");
    value.mailboxes.find(item => item.email === "uni-only@a.test")!.connections[0]!.mailbox_use = "personal";
    expect(inbox(present(value), "uni-only@a.test").status.code).toBe("placement_due");
  });
});

describe("warmup states", () => {
  const mailivery = (edit: (item: Source["mailboxes"][number]["warmup"]["mailivery"][number]) => void) =>
    inbox(present(withInbox("uni-only@a.test", item => edit(item.warmup.mailivery[0]!))), "uni-only@a.test").warmup;

  it("distinguishes paused, pending consent, rewarming and stale evidence", () => {
    expect(mailivery(item => { item.binding!.state = "paused"; }).status).toMatchObject({ code: "paused" });
    const consent = mailivery(item => { item.binding!.state = "pending_consent"; });
    expect(consent.status).toMatchObject({ code: "pending", reasons: [{ code: "microsoft_consent_pending" }] });
    const dns = mailivery(item => { item.binding!.state = "pending_consent"; item.binding!.blocking_reason = "dns_invalid_dmarc"; });
    expect(dns.status).toMatchObject({ code: "pending", label: "Waiting for valid DNS records",
      reasons: [{ code: "dns_invalid_dmarc", message: expect.stringMatching(/no valid DMARC record/) }] });
    expect(mailivery(item => { item.binding!.requested_action = "resume"; item.binding!.state = "paused"; }).status.reasons)
      .toEqual([{ code: "resume_requested", message: "Resuming warmup at the next check." }]);
    const stale = mailivery(item => { item.evidence!.observed_at = "2026-09-27T00:00:00Z"; });
    expect(stale.sources[0]!.last_check.freshness).toBe("stale");
    expect(stale.status.reasons.map(item => item.code)).toContain("warmup_check_stale");
  });

  it("keeps a completed period separate from campaign readiness", () => {
    const done = mailivery(item => { item.evidence!.active_duration_days = 25; });
    expect(done.sources[0]).toMatchObject({ period_complete: true, outreach_unlocked: false, estimated_completion: null });
    expect(done.status.label).toBe("Warming · initial period complete");
    expect(done.status.description).toMatch(/does not enable campaigns/);
  });



});

describe("member verdict and next step (LIF-1603)", () => {
  type Edit = (mailbox: Source["mailboxes"][number]) => void;
  /** uni-only@a.test as its current account sees it: connected, no holds, the given gate reason. */
  function verdict(reason: string | null, edit: Edit = () => {}, account: Partial<Account> = {}) {
    const value = withInbox("uni-only@a.test", item => {
      item.connections[0]!.holds = [];
      item.connections[0]!.controls = [];
      item.connections[0]!.send_block_reason = reason;
      edit(item);
    });
    const mailbox = value.mailboxes.find(item => item.email === "uni-only@a.test")!;
    const current: Account = { id: mailbox.connections[0]!.connection_ref, sender_id: mailbox.connections[0]!.sender_ref!, channel: "email",
      identity: mailbox.email, status: "connected", state: "active", checked_at: now.toISOString(), observation: { state: "verified" },
      connected_at: now.toISOString(), disconnected_at: null, access_revoked_at: null, declaration: null, sends: { today: 0, last_7_days: 0 }, ...account };
    return inbox(presentDeliverability(value, now, { accounts: new Map([[mailbox.workspace_ref, [current]]]) }), "uni-only@a.test");
  }
  const noCampaigns: Edit = item => { item.campaigns = []; };

  it("treats a missing send-time safety check as ready, not blocked", () => {
    const idle = verdict("email_safety_check_required", noCampaigns);
    expect(idle.readiness.code).toBe("ready");
    expect(idle.account?.outreach.code).toBe("idle");
    expect(idle.status).toMatchObject({ code: "ready_idle", label: "Ready · not in a campaign" });
    expect(idle.next_step).toMatchObject({ code: "add_to_campaign", owner: "member" });
    const sending = verdict("email_safety_check_required", item => { item.campaigns[0]!.states = { active: 1 }; });
    expect(sending.status).toMatchObject({ code: "in_campaign", label: "In campaign" });
    expect(sending.next_step.code).toBe("none");
  });

  it("names the action for each sender-gate reason", () => {
    expect(verdict("email_declaration_required")).toMatchObject({ status: { code: "setup_needed" }, next_step: { code: "declare_use", owner: "member" } });
    expect(verdict("email_sender_identity_mismatch")).toMatchObject({ status: { code: "needs_reconnect" }, next_step: { code: "reconnect" } });
    expect(verdict(null, noCampaigns, { status: "needs_reconnect" })).toMatchObject({ status: { code: "needs_reconnect" }, next_step: { code: "reconnect" } });
    expect(verdict(null, noCampaigns, { status: "disconnected" })).toMatchObject({ status: { code: "disconnected" }, next_step: { code: "none" } });
    // An active campaign waiting on a blocked inbox is named in the explanation.
    expect(verdict("email_declaration_required").status.description).toMatch(/active campaign is waiting/);
  });

  it("waits for a running dedicated warmup and asks to connect a missing one", () => {
    const warming = verdict("email_warmup_required", item => { item.connections[0]!.mailbox_use = "outreach"; });
    expect(warming).toMatchObject({ status: { code: "warming", label: "Warming · day 10 of 21" }, next_step: { code: "wait", owner: "lifty" } });
    expect(warming.next_step.description).toMatch(/2026-10-10/);
    const missing = verdict("email_warmup_required", item => { item.connections[0]!.mailbox_use = "outreach"; item.warmup.mailivery = []; });
    expect(missing).toMatchObject({ status: { code: "setup_needed" }, next_step: { code: "connect_warmup", owner: "member" } });
  });

  it("sends a missing placement test to the domain records when they fail", () => {
    const dns = verdict("email_placement_required", item => {
      item.warmup.mailivery[0]!.binding!.snapshot = { spf: "valid", dmarc: "not_valid", mx: "valid" };
    });
    expect(dns).toMatchObject({ status: { code: "placement_due" }, next_step: { code: "fix_dns", owner: "member" } });
  });
});
