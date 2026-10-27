import type { AppDependencies, AuthSession } from "./app.js";
import { getAgentContext, getStepGuide, type ContextDraft } from "./agent-context.js";
import {
  BusinessGetSchema,
  TargetingGetSchema,
  CriteriaGetSchema,
  SetupDraftGetSchema,
  SetupStatusSchema,
  type SetupGatesSchema,
} from "./business-contracts.js";
import { NextStepSchema, type NextStep } from "./next-step-contracts.js";
import {
  RunStatusSchema,
  CrmSyncStatusSchema,
} from "./contracts.js";
import { readComponent } from "./workspace-summary.js";
import { readCrmConnection } from "./crm-connection.js";
import { CrmAutomaticSyncSchema } from "./crm-sync-controls.js";
import { CampaignsSchema } from "./outreach-contracts.js";
import { SendersGetSchema } from "./identity-contracts.js";
import { ResearchScheduleSchema } from "./research-operations.js";
import { PublicError } from "./errors.js";
import { CustomerSourceChoice } from "./customer-exclusions.js";
import { z } from "zod";
import { stageOperations } from "./stage-contracts.js";
import { operationToolNames } from "./operation-names.js";
import type { RunErrorCodeSchema } from "./contracts.js";
// Tool ids are derived from the operation catalog used by HTTP and MCP; a
// retired operation fails here instead of being recommended.
const tool = (resource: string, operation: string) => {
  if (!stageOperations[resource]?.[operation]) throw new Error(`Unknown catalog operation ${resource}.${operation}`);
  return operationToolNames(resource, operation)[0]!;
};
// Every next_step reason in journey order: where it sits, when it is returned,
// and the guide it inlines with only the references it
// needs. A guide without references is a short playbook sent as is. `context`
// is the stage whose full guide summary_context serves for the step, and
// `related` the stages its actions lead to, so the agent knows where to look
// when the founder asks for something else there. The ops onboarding view
// reads this catalog, and next_step builds its responses from it (LIF-1297, LIF-1301).
export interface NextStepEntry {
  step: NextStep["step"]; state: NextStep["state"]; section: NextStep["section"];
  when: string[]; guide: { task: string; references?: string[] };
  context: string; related: string[];
}
export const NEXT_STEP_CATALOG: Record<string, NextStepEntry> = {
  workspace_missing: { step: "business", state: "action_required", section: "leads",
    when: ["The caller has no workspace or no commercial profile"],
    guide: { task: "business", references: ["common", "interview"] }, context: "business", related: [] },
  workspace_suspended: { step: "business", state: "blocked", section: "leads",
    when: ["The workspace is suspended"],
    guide: { task: "business", references: ["common"] }, context: "business", related: [] },
  business_confirmation_needed: { step: "business", state: "action_required", section: "leads",
    when: ["The commercial profile still has unconfirmed values"],
    guide: { task: "business", references: ["common", "interview"] }, context: "business", related: [] },
  setup_resource_unavailable: { step: "import", state: "blocked", section: "leads",
    when: ["Targeting or research criteria are missing", "Setup is already imported, so a resource is unreadable"],
    guide: { task: "setup", references: ["common"] }, context: "setup", related: ["targeting", "research-criteria"] },
  confirmed_interview_needed: { step: "interview", state: "action_required", section: "leads",
    when: ["Targeting or research criteria are missing", "The setup draft is missing, or its gates are missing or have issues"],
    guide: { task: "setup", references: ["common", "interview"] }, context: "setup", related: [] },
  configuration_needed: { step: "configuration", state: "action_required", section: "leads",
    when: ["Targeting or research criteria are missing", "Draft gates are complete", "No generated Scout criteria are saved"],
    guide: { task: "setup", references: ["common", "configuration"] }, context: "setup", related: [] },
  configuration_saved: { step: "submission", state: "action_required", section: "leads",
    when: ["Targeting or research criteria are missing", "Generated criteria are saved", "Setup has not been submitted"],
    guide: { task: "setup", references: ["common"] }, context: "setup", related: [] },
  sample_not_started: { step: "sample-review", state: "action_required", section: "leads",
    when: ["Targeting and research criteria exist", "No first research run yet"],
    guide: { task: "step-sample" }, context: "sample-review", related: [] },
  sample_pending: { step: "sample-review", state: "pending", section: "leads",
    when: ["The first research run is queued or running"],
    guide: { task: "step-sample" }, context: "sample-review", related: [] },
  sample_failed: { step: "sample-review", state: "blocked", section: "leads",
    when: ["The first research run failed; its error_code picks the action"],
    guide: { task: "step-sample" }, context: "sample-review", related: ["research-schedule", "targeting"] },
  // Calibration is a targeting or research-criteria change followed by a new
  // sample; a yes to LinkedIn connects the founder's sender (LIF-1302). The
  // founder's confirmation of the sample opens Parts 2-4 (LIF-1303).
  sample_ready_for_founder_review: { step: "sample-review", state: "review", section: "leads",
    when: ["The first research run succeeded", "The founder has not confirmed the sample, or no campaign, LinkedIn account or mailbox exists yet"],
    guide: { task: "step-review" }, context: "sample-review", related: ["targeting", "research-criteria", "crm", "customer-exclusions", "senders", "sending-accounts"] },
  // Part 2: alerts once, then voice before the first draft, then templates.
  linkedin_connected: { step: "campaign", state: "action_required", section: "outreach",
    when: ["The founder confirmed the first sample", "A LinkedIn account is connected", "No campaign is saved"],
    guide: { task: "campaigns", references: ["common", "writing", "anti_slop"] }, context: "campaigns",
    related: ["notifications", "commercial-voice", "journeys", "senders"] },
  campaigns_saved: { step: "campaign", state: "action_required", section: "outreach",
    when: ["The founder confirmed the first sample", "At least one campaign is saved", "No LinkedIn campaign is active"],
    guide: { task: "campaigns", references: ["common", "writing", "anti_slop"] }, context: "campaigns", related: ["journeys", "commercial-voice", "linkedin"] },
  linkedin_outreach_active: { step: "linkedin", state: "complete", section: "outreach",
    when: ["The founder confirmed the first sample", "A LinkedIn campaign is active"],
    guide: { task: "linkedin", references: ["common"] }, context: "linkedin", related: ["campaigns", "leads", "senders", "sending-accounts"] },
  linkedin_reconnect_needed: { step: "linkedin", state: "blocked", section: "outreach",
    when: ["The founder confirmed the first sample", "A LinkedIn account needs reconnecting"],
    guide: { task: "sending-accounts", references: ["common"] }, context: "sending-accounts", related: ["senders", "linkedin"] },
  // Part 3: prepare the founder's mailbox; "ready" is warmup ready plus a
  // passing placement test until LIF-1223 replaces that check (LIF-1260).
  email_connected: { step: "email", state: "action_required", section: "email",
    when: ["The founder confirmed the first sample", "No connected LinkedIn account is waiting for its first active campaign",
      "An email account is connected", "Its warmup and placement test have not started",
      "With no active campaign, it also asks to draft, preview and approve one now"],
    guide: { task: "sending-accounts", references: ["common"] }, context: "sending-accounts",
    related: ["notifications", "research-schedule", "senders", "campaigns", "journeys"] },
  email_preparing: { step: "email", state: "pending", section: "email",
    when: ["The founder confirmed the first sample", "No connected LinkedIn account is waiting for its first active campaign",
      "A mailbox's warmup or placement test is running",
      "With no active campaign, it also asks to draft, preview and approve one now"],
    guide: { task: "sending-accounts", references: ["common"] }, context: "sending-accounts",
    related: ["notifications", "research-schedule", "campaigns", "journeys"] },
  email_held: { step: "email", state: "blocked", section: "email",
    when: ["The founder confirmed the first sample", "No connected LinkedIn account is waiting for its first active campaign",
      "A mailbox needs reconnecting, its warmup has a problem or lands in spam, or its placement test failed"],
    guide: { task: "sending-accounts", references: ["common"] }, context: "sending-accounts", related: ["senders"] },
  // Part 4: a ready mailbox; a free workspace is handed to David for a paid
  // plan until checkout exists (LIF-1262). The plan never gates activation here.
  paid_plan_needed: { step: "plan", state: "action_required", section: "kickoff",
    when: ["The founder confirmed the first sample", "A mailbox's warmup is ready and its placement test passed", "The workspace is on the free plan"],
    guide: { task: "campaigns", references: ["common", "writing", "anti_slop"] }, context: "campaigns",
    related: ["research-schedule", "sending-accounts", "journeys"] },
  email_ready: { step: "email", state: "action_required", section: "kickoff",
    when: ["The founder confirmed the first sample", "A mailbox's warmup is ready and its placement test passed", "The workspace plan allows outreach"],
    guide: { task: "campaigns", references: ["common", "writing", "anti_slop"] }, context: "campaigns",
    related: ["journeys", "commercial-voice", "senders", "sending-accounts", "research-schedule"] },
};
// Stage contexts no next_step reason links, each with how the agent reaches it.
// A stage is linked by a step, the base of every step, or read on request:
// exactly one of the three (LIF-1301, LIF-1304).
// The base: every step reads its links and the workspace summary through it.
export const BASE_CONTEXTS: Record<string, string> = {
  summary: "Holds next_step and summary_context; every step reads its linked contexts through it, and agents read the workspace summary to resume or report status.",
};
export const ON_REQUEST_CONTEXTS: Record<string, string> = {
  account: "Deleting the signed-in login, only when the founder asks.",
};
// A marked test workspace's drafts replace the published files they name (LIF-1298).
export function nextStepGuide(reason: string, drafts: readonly ContextDraft[] = []) {
  const entry = NEXT_STEP_CATALOG[reason];
  if (!entry) return null;
  return entry.guide.references
    ? getStepGuide(entry.guide.task, entry.guide.references, drafts)
    : getAgentContext(entry.guide.task, drafts);
}
// Customer reasons for a failed sample and the one next move for each.
const sampleFailures: Record<z.infer<typeof RunErrorCodeSchema>, { action: string; tools: string[] }> = {
  research_limit_reached: {
    action: `This week's research limit was reached. Read ${tool("research-schedule", "status")} and give the founder its resets_at; start the sample again with ${tool("sample-review", "post")} after that time. Volume does not carry over and the limit is not raised by retrying.`,
    tools: [tool("research-schedule", "status"), tool("sample-review", "post")],
  },
  search_exhausted: {
    action: `The search ran out of new matching people. Propose one specific wider targeting change; after the founder agrees, save it with ${tool("targeting", "patch")} and its expected_version, then start a new sample with ${tool("sample-review", "post")}.`,
    tools: [tool("targeting", "get"), tool("targeting", "patch"), tool("sample-review", "post")],
  },
  research_failed: {
    action: `Research failed for a technical reason. Retry once with ${tool("sample-review", "post")}; it reuses the saved people and completed research. If it fails again, tell the founder LIFT is looking into it.`,
    tools: [tool("sample-review", "post")],
  },
  calibration_sample_incomplete: {
    action: `Some people lack current research, a valid profile URL or a fit rationale. Explain the gap, then retry once with ${tool("sample-review", "post")}; it reuses the saved people.`,
    tools: [tool("sample-review", "post")],
  },
  calibration_review_required: {
    action: `This older sample stopped for a grade check that no longer applies. ${tool("sample-review", "post")} reviews the same saved people under the current policy without new research.`,
    tools: [tool("sample-review", "post")],
  },
};
// Parts 3 and 4 classify the founder's mailboxes from today's reads (LIF-1260):
// "ready" is warmup ready and a passing placement test until LIF-1223 replaces
// that check. An unreadable status is unknown, never ready or held.
type Mailbox = { id: string; sender_id: string; sender: string; email: string | null; status: "connected" | "needs_reconnect" | "disconnected" };
type EmailKind = "held" | "ready" | "preparing" | "connected";
async function emailPosition(deps: Reads, session: AuthSession, workspace: string, mailboxes: Mailbox[]) {
  const now = Date.now();
  const [checked, schedule] = await Promise.all([
    Promise.all(mailboxes.slice(0, 5).map(async mailbox => {
      if (mailbox.status !== "connected") return { mailbox, warmup: null, placement: null };
      const [warmup, placement] = await Promise.all([
        readComponent(() => deps.getEmailWarmup(session, workspace, mailbox.id)),
        readComponent(() => deps.getEmailPlacement(session, { workspace, connection_ref: mailbox.id })),
      ]);
      return { mailbox, warmup: warmup.status === "available" ? warmup.value : null,
        placement: placement.status === "available" ? placement.value : null };
    })),
    readComponent(async () => ResearchScheduleSchema.parse(
      await deps.researchOperation(session, "research-schedule.get", { query: {}, body: undefined }))),
  ]);
  const positions = checked.map(({ mailbox, warmup, placement }) => {
    const test = placement?.test?.state ?? null;
    // A client mailbox needs a pass inside its validity window. A founder
    // workspace has no passing_until (placement is advisory there), so its
    // latest completed test decides (LIF-1223).
    const passing = placement?.gates_sending === false
      ? !!placement.last_passed_at && test !== "failed"
      : !!placement?.passing_until && Date.parse(placement.passing_until) > now;
    let kind: EmailKind = "connected";
    let cause: "reconnect" | "spam" | "problem" | "placement" | null = null;
    if (mailbox.status === "needs_reconnect") [kind, cause] = ["held", "reconnect"];
    else if (warmup?.spam?.holds_sending) [kind, cause] = ["held", "spam"];
    else if (warmup?.state === "problem") [kind, cause] = ["held", "problem"];
    else if (test === "failed" && !passing) [kind, cause] = ["held", "placement"];
    else if (warmup?.warmup_ready && passing) kind = "ready";
    else if ((warmup && !["not_started", "removed"].includes(warmup.state)) || ["pending", "running", "uncertain"].includes(test ?? "")) kind = "preparing";
    return { mailbox, kind, cause, unknown: mailbox.status === "connected" && (!warmup || !placement),
      receipt: { mailbox, warmup: warmup ? { state: warmup.state, go_live: warmup.recommended_go_live } : null,
        placement: placement ? { test, passing_until: placement.passing_until } : null } };
  });
  // An actionable problem first, then the furthest-along mailbox.
  const chosen = (["held", "ready", "preparing", "connected"] as const)
    .map(kind => positions.find(item => item.kind === kind)).find(item => item !== undefined)!;
  const plan = schedule.status === "available" ? schedule.value.limit.source : null;
  return { ...chosen, plan, receipt: { ...chosen.receipt, plan } };
}
type Reads = Pick<
  AppDependencies,
  | "businessOperation"
  | "getRunStatus"
  | "outreachOperation"
  | "getHubspotConnection"
  | "getAttioConnection"
  | "getCrmSyncStatus"
  | "identityOperation"
  | "readContextDrafts"
  | "getEmailWarmup"
  | "getEmailPlacement"
  | "researchOperation"
  | "customerExclusionsOperation"
  | "crmSyncControlsOperation"
>;
// The session forwards the caller's workspace selection; every read below
// resolves the same workspace through the shared database rule.
export async function getNextStep(
  deps: Reads,
  session: AuthSession,
): Promise<NextStep> {
  const read = (key: string) => deps.businessOperation(session, key);
  const business = BusinessGetSchema.parse(await read("business.get"));
  const ref = business.workspace?.workspace_ref ?? null;
  // Read alongside the remaining resources; only a marked test workspace has any.
  const drafts = ref ? deps.readContextDrafts(session, ref).catch(() => []) : Promise.resolve([]);
  let saved: Record<string, unknown> | null = null;
  // State, step, section and context links come from the catalog, so the ops
  // view and the response cannot disagree.
  const response = async (
    reason: string,
    actions: string[],
    tools: string[],
    receipt: Record<string, unknown> | null = null,
    gates: z.infer<typeof SetupGatesSchema> | null = null,
  ) => {
    const entry = NEXT_STEP_CATALOG[reason];
    const guide = nextStepGuide(reason, await drafts);
    if (!entry || !guide) throw new Error("Missing next-step guide");
    return NextStepSchema.parse({
      state: entry.state,
      step: entry.step,
      reason,
      section: entry.section,
      actions,
      gates,
      workspace_ref: ref,
      recommended_tools: tools,
      guide,
      context_task: entry.context,
      related_contexts: entry.related,
      saved,
      receipt,
    });
  };
  if (!business.workspace || !business.profile)
    return response(
      "workspace_missing",
      [
        "Research the supplied website once and present one concise business hypothesis. Ask the founder to confirm or correct it, then create the workspace with business_post. Login alone creates nothing.",
      ],
      [tool("business", "post"), tool("business", "get")],
    );
  if (business.workspace.workspace_ref !== ref)
    throw new PublicError({
      status: 403,
      code: "WORKSPACE_FORBIDDEN",
      message: "The resource does not belong to the selected workspace.",
    });
  if (business.workspace.state === "suspended")
    return response(
      "workspace_suspended",
      ["Explain that the workspace is suspended and stop changes."],
      [tool("business", "get")],
    );
  if (!business.profile.confirmation.complete)
    return response(
      "business_confirmation_needed",
      [
        `Confirm or correct the missing commercial profile values: ${business.profile.confirmation.missing.join(", ")}. Save confirmed values with business_patch and its expected_version. Do not ask again for already confirmed values.`,
      ],
      [tool("business", "get"), tool("business", "patch")],
    );
  const [targeting, criteria, status] = await Promise.all([
    read("targeting.get").then((value) => TargetingGetSchema.parse(value)),
    read("research-criteria.get").then((value) =>
      CriteriaGetSchema.parse(value),
    ),
    read("setup.status").then((value) => SetupStatusSchema.parse(value)),
  ]);
  for (const value of [targeting, criteria, status])
    if (value.workspace_ref !== ref)
      throw new PublicError({
        status: 403,
        code: "WORKSPACE_FORBIDDEN",
        message: "The resource does not belong to the selected workspace.",
      });
  if (!targeting.targeting || !criteria.criteria || !criteria.criteria.text) {
    if (status.state === "imported")
      return response(
        "setup_resource_unavailable",
        [
          "The saved setup receipt exists but a required resource is unavailable. Retry setup_status and resource reads; do not submit another setup.",
        ],
        [
          tool("setup", "status"),
          tool("targeting", "get"),
          tool("research-criteria", "get"),
        ],
        status,
      );
    const draft = SetupDraftGetSchema.parse(await read("setup.get_draft"));
    if (draft.workspace_ref !== ref)
      throw new PublicError({
        status: 403,
        code: "WORKSPACE_FORBIDDEN",
        message: "The draft does not belong to the selected workspace.",
      });
    saved = draft;
    if (!draft.draft || draft.gates.missing.length || draft.gates.issues.length)
      return response(
        "confirmed_interview_needed",
        [
          "Resume the workspace server draft. Ask only its next missing gate, leading with a hypothesis; save every confirmed block with setup_patch_draft and the returned expected_version. Exclusions need at least one evidence-based disqualifier or an excluded industry code filter; an empty parked-motions list is a valid decision.",
          "When gates are complete, call next_step.",
        ],
        [tool("setup", "get_draft"), tool("setup", "patch_draft")],
        null,
        draft.gates,
      );
    if (!draft.generated_criteria)
      return response(
        "configuration_needed",
        [
          "Read setup_generation_context, generate only Scout criteria from the saved draft and current base, then save them with setup_patch_draft. Bind source_versions to the profile, resulting draft version and base version.",
        ],
        [tool("setup", "generation_context"), tool("setup", "patch_draft")],
      );
    return response(
      "configuration_saved",
      [
        `Submit once with setup_post {expected_draft_version:${draft.version}}. After a lost response use setup_status; a saved receipt proves both resources were created. This does not activate research or outreach.`,
      ],
      [tool("setup", "post"), tool("setup", "status")],
    );
  }
  // Resource heads are authoritative even when configured outside setup.
  const run = RunStatusSchema.parse(
    await deps.getRunStatus(session),
  );
  if (run.state !== "none" && run.workspace.workspace_ref !== ref)
    throw new PublicError({
      status: 403,
      code: "WORKSPACE_FORBIDDEN",
      message: "The research run does not belong to the selected workspace.",
    });
  if (run.state === "none")
    return response(
      "sample_not_started",
      [
        `${tool("sample-review", "post")} with body {} and keep its run_ref. The sample uses five people of this week's research volume; with fewer than five left it returns RESEARCH_LIMIT_REACHED and resets_at: give the founder that reset time.`,
        "Tell the founder you are finding and researching five matching people, that it takes a few minutes, and that you will share each one as it lands.",
        `${tool("sample-review", "progress")} with run_ref, then the returned cursor and wait_seconds 25 until terminal. Keep one request open and narrate each new lead in one line.`,
        "When terminal, call next_step. This bounded initial sample does not activate weekly research or outreach.",
      ],
      [tool("sample-review", "post"), tool("sample-review", "progress")],
    );
  if (["queued", "running"].includes(run.state))
    return response(
      "sample_pending",
      [
        `${tool("sample-review", "progress")} with run_ref ${run.run_ref}, then the returned cursor and wait_seconds 25 until terminal. Narrate each newly researched lead in one line.`,
        "One request at a time: no sleeps and never POST again to check progress.",
        "When terminal, call next_step.",
      ],
      [tool("sample-review", "progress")],
      run,
    );
  if (run.state === "failed") {
    const failure = sampleFailures[run.error_code ?? "research_failed"];
    return response(
      "sample_failed",
      [
        `The sample stopped with reason ${run.error_code ?? "research_failed"}. Read ${tool("sample-review", "get")} for the saved people and explain the reason plainly.`,
        failure.action,
        "Saved leads stay usable; outreach setup does not have to wait for the sample.",
      ],
      [tool("sample-review", "get"), ...failure.tools],
      run,
    );
  }
  // Part 2 reads campaigns and the sender roster together. An unreadable
  // roster is unknown, never "LinkedIn not connected" (LIF-1302).
  const [campaigns, roster] = await Promise.all([
    deps.outreachOperation(session, "campaigns.get", { path: {}, query: {}, body: undefined }).then(value => CampaignsSchema.parse(value)),
    readComponent(async () => {
      const value = SendersGetSchema.parse((await deps.identityOperation(session, "senders.get", { path: {}, query: {}, body: undefined })).body);
      if (value.workspace.workspace_ref !== ref)
        throw new PublicError({ status: 403, code: "WORKSPACE_FORBIDDEN", message: "Identity state changed workspace." });
      return value.senders;
    }),
  ]);
  if (campaigns.workspace.workspace_ref !== ref)
    throw new PublicError({ status: 403, code: "WORKSPACE_FORBIDDEN", message: "Outreach state changed workspace." });
  const linkedin = roster.status === "available"
    ? roster.value.flatMap(sender => sender.accounts
      .filter(account => account.channel === "linkedin" && account.status !== "disconnected")
      .map(account => ({ id: account.id, sender_id: sender.id, sender: sender.name, status: account.status })))
    : [];
  // With one sender the agent assumes it; with several it reads the roster and
  // asks which person a connection or campaign belongs to (Juan, 2026-10-06).
  const names = (accounts: Array<{ sender: string }>) => accounts.map(account => account.sender).join(", ");
  // The founder's mailboxes, for Parts 3 and 4 (LIF-1260).
  const mailboxes = roster.status === "available"
    ? roster.value.flatMap(sender => sender.accounts
      .filter(account => account.channel === "email" && account.status !== "disconnected")
      .map(account => ({ id: account.id, sender_id: sender.id, sender: sender.name, email: account.identity, status: account.status })))
    : [];
  // What the founder set up while the sample ran, so the review does not offer it again.
  const started = [
    ...(linkedin.length ? [`LinkedIn (${names(linkedin)})`] : []),
    ...(mailboxes.length ? [`email (${mailboxes.map(mailbox => mailbox.email ?? mailbox.sender).join(", ")})`] : []),
    ...(campaigns.campaigns.length ? ["a saved campaign"] : []),
  ];
  // The sample review: until the founder confirms this sample, and afterwards
  // while nothing is connected or saved (a leads-only founder rests here).
  const sampleReview = async () => {
    const crm = await readComponent(() => readCrmConnection(deps, session));
    let crmPaused = false;
    let crmAction =
      "Read crm_get before offering CRM sync; its saved connection is currently unavailable. A leads-only workspace can remain here.";
    if (crm.status === "available") {
      if (crm.value.status !== "connected")
        crmAction =
          "Ask once whether the founder wants these leads and their research in their CRM (HubSpot or Attio). Connect only after a separate explicit request, with crm_post for the CRM they use. Connecting does not authorize reading their customer list. A leads-only workspace can remain here.";
      else if (crm.value.reconnect_required)
        crmAction =
          "The saved CRM connection needs reconnecting. Reconnect only after a separate explicit request; a leads-only workspace can remain here.";
      else {
        const sync = await readComponent(async () => {
          const value = CrmSyncStatusSchema.parse(
            await deps.getCrmSyncStatus(session),
          );
          if (value.state !== "none" && value.workspace.workspace_ref !== ref)
            throw new PublicError({
              status: 403,
              code: "WORKSPACE_FORBIDDEN",
              message:
                "The CRM sync does not belong to the selected workspace.",
            });
          return value;
        });
        // LIF-1622: a new connection starts with automatic sync paused, so the
        // bulk sync waits; a test sync shows what Lifty writes first.
        const automatic = sync.status === "available" && sync.value.state === "none"
          ? await readComponent(async () => CrmAutomaticSyncSchema.parse(
            await deps.crmSyncControlsOperation(session, "crm.automatic_sync_get", { path: {}, query: {}, body: undefined })))
          : null;
        if (sync.status === "unavailable")
          crmAction =
            "The CRM connection is saved; read crm_sync_status before offering a sync because its previous receipt is unavailable.";
        else if (automatic?.status === "unavailable")
          crmAction =
            "The CRM connection is saved; read crm_automatic_sync_get before offering a sync because whether automatic sync is on is unavailable.";
        else if (automatic?.status === "available" && automatic.value.automatic_sync === "paused") {
          crmPaused = true;
          crmAction = `${crm.value.provider === "attio" ? "Attio" : "HubSpot"} is connected with automatic sync paused, so Lifty writes nothing on its own (${automatic.value.waiting_leads} qualified leads wait). Offer a test sync only after a separate explicit request: ${crm.value.provider === "attio" ? "" : "crm_mapping_context (company setup with crm_patch if not ready), "}crm_preferences_get and the founder's research-note and conversation choices (crm_preferences_patch only for what they change), crm_test_sync_start, then crm_test_sync_status with its run_ref to show what was written, kept or skipped per field. Turn automatic sync on with crm_automatic_sync_patch only when the founder decides; it writes the waiting leads first.`;
        } else if (sync.value.state === "none")
          crmAction =
            crm.value.provider === "attio"
              ? "Attio is connected and nothing is synced yet. Offer to sync these leads only after a separate explicit request: crm_preferences_get and the founder's research-note and conversation choices (crm_preferences_patch only for what they change), crm_sync_start, then crm_sync_status."
              : "HubSpot is connected and nothing is synced yet. Offer to sync these leads only after a separate explicit request: crm_mapping_context (company setup with crm_patch if not ready), crm_preferences_get and the founder's research-note and conversation choices (crm_preferences_patch only for what they change), crm_sync_start, then crm_sync_status.";
        else if (["queued", "running"].includes(sync.value.state))
          crmAction = `The CRM sync is in progress (run_ref ${sync.value.run_ref}). Read crm_sync_status; do not start another sync.`;
        else if (sync.value.state === "succeeded")
          crmAction = `The CRM sync finished (${sync.value.leads_synced ?? 0} leads). Do not repeat it just to check status.`;
        else
          crmAction = `The CRM sync failed (${sync.value.error_code ?? "unknown"}). Read crm_sync_status and resolve its blocker before offering a retry.`;
      }
    }
    const customerChoice = await readComponent(async () => {
      const choice = CustomerSourceChoice.parse(await deps.customerExclusionsOperation(session, "customer-exclusions.source_choice_get", { path: {}, query: {}, body: undefined }));
      if (choice.workspace_ref !== ref)
        throw new PublicError({ status: 403, code: "WORKSPACE_FORBIDDEN", message: "The customer-source choice changed workspace." });
      return choice;
    });
    if (customerChoice.status === "unavailable")
      crmAction += ` Read ${tool("customer-exclusions", "source_choice_get")} before offering customer exclusions because the saved choice is unavailable; continue setup without treating that as consent or asking the founder to choose again.`;
    else if (customerChoice.value.mode === "unselected")
      crmAction += ` Separately offer customer exclusions once: authorize selected CRM sources, use a customer file, or choose neither. Read ${tool("customer-exclusions", "status")} first for saved protections, then save their explicit choice with ${tool("customer-exclusions", "source_choice_post")} using version ${customerChoice.value.version}; a customer file uses ${tool("customer-exclusions", "import")} (summary_context task customer-exclusions). Neither allows setup to continue; explain that unknown existing customers will not be excluded. Do not read CRM customers without their separate authorization.`;
    else
      crmAction += ` Customer exclusions already have the founder's saved ${customerChoice.value.mode} choice. Keep it and do not offer the choice again; they can explicitly change it later. Every saved exclusion remains enforced.`;
    return response(
      "sample_ready_for_founder_review",
      [
        "Show the researched leads from receipt.leads (sample_review_get only if you need more): your read first, then person, company, grade, LinkedIn URL, fit rationale and evidence gaps. Include lower-fit profiles and explain their mismatch.",
        run.reviewed_at
          ? "The founder already confirmed this sample: do not ask for the review again. A targeting change still follows summary_context task targeting or research-criteria, its synchronous PATCH/readback, then a new sample."
          : `Ask one question: does this confirm the targeting, or what should change? A change follows summary_context task targeting or research-criteria, its synchronous PATCH/readback, then a new sample. When the founder confirms the sample or moves on without changes, record it once with ${tool("sample-review", "confirm")} and run_ref ${run.run_ref}; a new sample needs its own confirmation.`,
        crmAction,
        ...(roster.status === "unavailable" ? ["The sender roster could not be read: read senders_get before offering LinkedIn, because an account may already be connected."] : []),
        started.length
          ? `Close Section 1 in at most six lines: target, leads and grade mix, and CRM result. The founder already set up ${started.join(" and ")} while the sample ran: do not offer it again. After the confirmation, call next_step; it continues from there.`
          : `Close Section 1 in at most six lines: target, leads and grade mix, and CRM result. Then ask whether to set up LinkedIn outreach for these leads now. Yes: read ${tool("senders", "get")} for who the senders are and which accounts each has connected. With one sender, use it; with several, ask whose LinkedIn to connect (senders_post only when that person is absent). Then ${tool("sending-accounts", "connect")} with that sender_id and channel linkedin. Show the returned connection_url right away and confirm it with sending_accounts_attempt; the templates follow once it connects. A founder who would rather start with email connects a mailbox the same way, with channel email: with one sender use it, with several ask whose mailbox it is. A leads-only founder can stop here. If not now, accept it and do not ask again this session.`,
      ],
      [
        tool("sample-review", "get"),
        ...(run.reviewed_at ? [] : [tool("sample-review", "confirm")]),
        tool("crm", "get"),
        tool("crm", "post"),
        tool("crm", "mapping_context"),
        tool("crm", "patch"),
        ...(crmPaused
          ? [tool("crm", "test_sync_start"), tool("crm", "test_sync_status")]
          : [tool("crm", "sync_start"), tool("crm", "sync_status")]),
        tool("customer-exclusions", "source_choice_get"),
        tool("senders", "get"),
        tool("sending-accounts", "connect"),
        tool("summary", "context"),
      ],
      run,
    );
  };
  // An account connected or a campaign saved while the sample ran never skips
  // the review: Parts 2-4 wait for the founder's confirmation (LIF-1303).
  if (!run.reviewed_at) return sampleReview();
  const reconnects = linkedin.filter(account => account.status === "needs_reconnect");
  const reconnect = reconnects[0];
  if (reconnect)
    return response(
      "linkedin_reconnect_needed",
      [
        reconnects.length === 1
          ? `${reconnect.sender}'s LinkedIn account needs reconnecting, so its LinkedIn work waits. Explain this plainly and reconnect only after the founder agrees.`
          : `LinkedIn accounts of several senders need reconnecting (${names(reconnects)}), so their LinkedIn work waits. Explain this plainly, ask which to reconnect now, and reconnect each one the founder agrees to, one at a time.`,
        `${tool("sending-accounts", "reconnect")} with path.id ${reconnects.map(account => reconnects.length === 1 ? account.id : `${account.id} (${account.sender})`).join(", ")}, then show the returned connection_url right away as a clickable link. The same LinkedIn profile must sign in.`,
        `${tool("sending-accounts", "attempt")} with the returned attempt id and query.wait_seconds 25 until it is connected, following its next_step. A failed read is unknown, not a failure.`,
        "Reconnecting never resumes or activates a campaign. When it is connected, call next_step.",
      ],
      [tool("sending-accounts", "get"), tool("sending-accounts", "reconnect"), tool("sending-accounts", "attempt"), tool("linkedin", "get")],
      { account: reconnect },
    );
  const outreach = { campaigns: campaigns.campaigns.map(value => ({ campaign_ref: value.campaign_ref, journey_ref: value.journey_ref, version: value.version, state: value.state, channel: value.channel })) };
  const linkedinActive = campaigns.campaigns.some(value => value.channel === "linkedin" && value.state === "active");
  // How a preview is shown before the approval question, wherever it runs.
  const previewSteps = `While ${tool("campaigns", "tests_post")} runs, tell the founder it takes a few minutes and report progress from ${tool("campaigns", "test_detail")} as "3 of 5 ready", never how you check. Show every step for at least one lead, explain differences from each sample's changes instead of guessing, and flag research that leaves a lead's company or fit unverified. Describe sending as ${tool("campaigns", "review_settings_get")} says: with approve_each, every message waits for the founder's approval. If an operation refuses the founder's choice, say so before saving; never call it changeable later.`;
  const campaignsSaved = () => response(
    "campaigns_saved",
    [
      "Read campaigns_get and journeys_get for the exact saved drafts, approvals, selected revisions, executable version and intent. Publish only the chosen exact revision; activate separately with explicit founder authorization. Before asking, say who starts: the Journey's audience (in qualified mode every eligible qualified lead not yet contacted, now and later), never only the tested leads. Paused intent and account/readiness/incident holds remain independent.",
      previewSteps,
      "When a LinkedIn campaign is active, call next_step.",
    ],
    [tool("campaigns", "get"), tool("journeys", "get"), tool("campaigns", "tests_post"), tool("campaigns", "test_detail"), tool("campaigns", "review_settings_get"), tool("summary", "context")],
    outreach,
  );
  const connectedAll = linkedin.filter(account => account.status === "connected");
  const connected = connectedAll[0];
  // Part 2 comes first while a connected LinkedIn account has no active campaign.
  if (connected && !linkedinActive) {
    if (campaigns.campaigns.length) return campaignsSaved();
    return response(
      "linkedin_connected",
      [
        `${connectedAll.length === 1 ? `${connected.sender}'s LinkedIn is connected` : `LinkedIn is connected for ${names(connectedAll)}`}. Read ${tool("notifications", "get")}; unless Slack is already connected, ask once where alerts should go: Slack or email. Email needs no setup. Slack: ${tool("notifications", "post")}, show its link, verify that attempt, then choose a channel. Declining never blocks.`,
        `Read ${tool("commercial-voice", "get")}. If tone and rules are empty, ask how the founder writes before the first draft and save it with ${tool("commercial-voice", "patch")}; voice is shared by every channel and campaign.`,
        `Build the LinkedIn templates: read ${tool("journeys", "get")}, create the Journey for qualified (Tier A and B) leads with ${tool("journeys", "post")} and its LinkedIn Campaign with ${tool("campaigns", "post")}. Every person with a connected account takes part, so ask no sender question. Preview real leads with ${tool("campaigns", "tests_post")} before asking for approval.`,
        previewSteps,
        "Saving, publishing or a connected account never activates outreach. When a campaign is saved, call next_step.",
      ],
      [tool("notifications", "get"), tool("notifications", "post"), tool("commercial-voice", "get"), tool("commercial-voice", "patch"), tool("senders", "get"),
        tool("journeys", "get"), tool("journeys", "post"), tool("campaigns", "post"), tool("campaigns", "tests_post"), tool("campaigns", "test_detail"),
        tool("campaigns", "review_settings_get"), tool("summary", "context")],
      { account: connected },
    );
  }
  // Parts 3 and 4 follow the founder's mailbox (LIF-1260).
  if (mailboxes.length) {
    const email = await emailPosition(deps, session, ref!, mailboxes);
    const { mailbox } = email;
    const name = mailbox.email ?? `${mailbox.sender}'s mailbox`;
    if (email.kind === "held")
      return response(
        "email_held",
        [
          email.cause === "reconnect"
            ? `${name} needs reconnecting, so it cannot warm up or send. Reconnect only after the founder agrees: ${tool("sending-accounts", "reconnect")} with path.id ${mailbox.id}, show the returned connection_url right away, then ${tool("sending-accounts", "attempt")} until it is connected. The same mailbox must sign in.`
            : email.cause === "spam"
              ? `Warmup emails from ${name} are landing in spam, so the mailbox is held. Read ${tool("sending-accounts", "warmup_status")} and say how many landed in spam; only a later measurement below the limit clears the hold. Do not request a placement test or start email outreach from it meanwhile.`
              : email.cause === "placement"
                ? `The latest placement test for ${name} failed, so it does not send. Read ${tool("sending-accounts", "placement_status")} and explain the result; request a new test only when it says can_request and the founder agrees.`
                : `Warmup for ${name} has a problem. Read ${tool("sending-accounts", "warmup_status")} and follow its blocking_reason; if it lasts, contact LIFT support. Never connect a different mailbox to work around it.`,
          "Email preparation never starts outreach. When it is resolved, call next_step.",
        ],
        [tool("sending-accounts", "get"), tool("sending-accounts", "warmup_status"), tool("sending-accounts", "placement_status"),
          tool("sending-accounts", "placement_start"), tool("sending-accounts", "reconnect"), tool("sending-accounts", "attempt"), tool("summary", "context")],
        email.receipt,
      );
    if (email.kind === "ready" && email.plan === "free")
      return response(
        "paid_plan_needed",
        [
          `${name} is ready to send: warmup is ready and its placement test passed. Tell the founder; ${tool("sending-accounts", "warmup_status")} has the detail if they ask.`,
          `Show the email campaign before the plan question: read ${tool("campaigns", "get")} and ${tool("journeys", "get")}, and preview real leads with ${tool("campaigns", "tests_post")}. Draft the Email Campaign first if none exists (summary_context task campaigns).`,
          "Then ask the founder to choose a paid plan: it starts email campaigns and recurring weekly leads (100 researched people a week instead of 25). Paid plans are set up with David from LIFT for now: tell the founder David will contact them to choose one. Do not quote prices or promise a checkout link.",
          "A paid plan, a ready mailbox or an approved campaign never activates outreach; activation stays the founder's explicit yes.",
        ],
        [tool("sending-accounts", "warmup_status"), tool("campaigns", "get"), tool("journeys", "get"), tool("campaigns", "tests_post"),
          tool("research-schedule", "get"), tool("summary", "context")],
        email.receipt,
      );
    if (email.kind === "ready")
      return response(
        "email_ready",
        [
          `${name} is ready to send: warmup is ready and its placement test passed. Tell the founder.`,
          ...(email.plan === null ? [`The plan could not be read; read ${tool("research-schedule", "get")} before discussing plans.`] : []),
          `Finish the email campaign: read ${tool("campaigns", "get")} and ${tool("journeys", "get")}, add or update the Journey's Email Campaign with ${tool("campaigns", "post")} or ${tool("campaigns", "draft_patch")}, and preview real leads with ${tool("campaigns", "tests_post")}. Every person with a mailbox and a signature takes part, so ask no sender question. Voice and the sender's signature come first (summary_context task commercial-voice, then senders).`,
          "Publish only the exact revision the founder approves, and activate it only on their explicit yes. A ready mailbox never activates outreach.",
        ],
        [tool("campaigns", "get"), tool("journeys", "get"), tool("campaigns", "post"), tool("campaigns", "draft_patch"),
          tool("campaigns", "tests_post"), tool("senders", "get"), tool("research-schedule", "get"), tool("summary", "context")],
        email.receipt,
      );
    // LIF-1223: the placement result reaches the founder in Slack, or by email
    // at each member's login address, so Slack is offered once more here.
    const alerts = [`Unless Slack is already connected (${tool("notifications", "get")}) or the founder declined it in this conversation, offer to connect it now so the test result reaches them there; without Slack it arrives by email at their Lifty login address. Slack: ${tool("notifications", "post")}, show its link, verify that attempt, then choose a channel. Declining never blocks.`];
    const notice = "Tell the founder Lifty will notify them with the placement test result when it finishes. Do not request a placement test yourself for this first one.";
    const weekly = `Ask roughly how many leads they want to reach each week, unless already answered, and save it as the weekly target with ${tool("research-schedule", "patch")} (up to the plan's limit; ${tool("research-schedule", "get")} shows it).`;
    const close = "Close Part 3: tell the founder when Lifty will follow up, using recommended_go_live from warmup_status. Never compute dates yourself. Connecting or warming a mailbox never starts email outreach.";
    // LIF-1670: a mailbox that is still preparing already takes part, so with
    // no active campaign the founder approves one now instead of waiting.
    const anyActive = campaigns.campaigns.some(value => value.state === "active");
    const draftNow = anyActive ? [] : [
      `No campaign is active yet, so do not wait for the mailbox: draft the Journey's Email Campaign now with ${tool("journeys", "post")} and ${tool("campaigns", "post")} (summary_context task campaigns), preview real leads with ${tool("campaigns", "tests_post")} and ask the founder to approve it in this conversation. Every person with a mailbox and a signature takes part, so ask no sender question; save the signature first if it is missing (summary_context task senders). Email waits until the mailbox is ready; activation stays the founder's explicit yes.`,
    ];
    const draftTools = anyActive ? [] : [tool("journeys", "post"), tool("campaigns", "post"), tool("campaigns", "tests_post")];
    if (email.kind === "preparing")
      return response(
        "email_preparing",
        [
          `${name} is being prepared. Report where it stands from ${tool("sending-accounts", "warmup_status")} (state, active days and recommended_go_live) and ${tool("sending-accounts", "placement_status")} for a test in progress.`,
          notice,
          ...alerts,
          weekly,
          ...(anyActive ? ["Meanwhile, offer to prepare the email campaign copy (summary_context task campaigns); it stays unapproved and inactive."] : draftNow),
          close,
        ],
        [tool("sending-accounts", "warmup_status"), tool("sending-accounts", "placement_status"), tool("notifications", "get"), tool("notifications", "post"),
          tool("research-schedule", "get"), tool("research-schedule", "patch"), ...draftTools, tool("summary", "context")],
        email.receipt,
      );
    return response(
      "email_connected",
      [
        ...(email.unknown ? [`${name}'s warmup or placement status could not be read: read both before offering anything, because preparation may already be running.`] : []),
        `${name} is connected, but warmup and its placement test need its owner's second sign-in. Call ${tool("sending-accounts", "warmup_start")} with connection_ref ${mailbox.id} right away, whatever the mailbox's use, and show the returned setup link in the same reply. If it reports an SPF, DMARC or MX record not valid, say which one to publish first. The link asks the owner to authorize that same mailbox, Google or Microsoft, for Mailivery and covers both warmup and the placement test, so ask for no other consent.`,
        `A dedicated sending mailbox (outreach) needs 21 active warmup days, then Lifty runs one placement test by itself; give the date from recommended_go_live. A mailbox they already use (personal) needs no initial period, but warmup protects inbox placement and reply rates, and Lifty tests where its email lands as soon as setup is done. If the founder declines, do not push it; say Lifty cannot warm up or test the mailbox without that setup.`,
        notice,
        ...alerts,
        weekly,
        ...draftNow,
        close,
      ],
      [tool("sending-accounts", "warmup_status"), tool("sending-accounts", "warmup_start"), tool("sending-accounts", "placement_status"),
        tool("notifications", "get"), tool("notifications", "post"),
        tool("research-schedule", "get"), tool("research-schedule", "patch"), ...draftTools, tool("summary", "context")],
      email.receipt,
    );
  }
  if (linkedinActive)
    return response(
      "linkedin_outreach_active",
      [
        `Report LinkedIn activity from ${tool("linkedin", "get")}: today, the last 7 days and any account's waiting_reason. A first message to someone already connected waits for the founder's review in ${tool("campaigns", "reviews_get")}.`,
        `Close Part 2 in a few lines: who Lifty contacts on LinkedIn and what happens next. Then ask whether to set up email so Lifty can test their domain and inboxes. Yes: read ${tool("senders", "get")} for who the senders are and which accounts each has; with one sender, connect the mailbox to it, with several ask whose mailbox it is. Then ${tool("sending-accounts", "connect")} with that sender_id and channel email (summary_context task sending-accounts). If not now, accept it and do not ask again this session.`,
        "Pause, edit or activate another campaign only when the founder asks.",
      ],
      [tool("linkedin", "get"), tool("campaigns", "reviews_get"), tool("campaigns", "get"), tool("senders", "get"), tool("sending-accounts", "connect"), tool("summary", "context")],
      outreach,
    );
  if (campaigns.campaigns.length) return campaignsSaved();
  return sampleReview();
}
