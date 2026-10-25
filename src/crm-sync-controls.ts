import { z } from "zod";
import { crmOperationEntries, crmOperationExecutor } from "./crm-operations.js";
import type { IdentityDefinition } from "./identity-operations.js";

// LIF-1622 CRM page controls: automatic sync (on or paused) and the bounded
// test sync. The database owns both per selected CRM integration and resolves
// the workspace from the session's x-lifty-workspace header, like CRM
// preferences. Jobs enforces the switch in every CRM writer; this API only
// reads, saves and starts runs, and wakes lifty-crm-sync for the runs the
// database created (stage routes enqueue them by run_ref).
const Empty = z.object({}).strict();
const RunRef = z.uuid();
const Timestamp = z.iso.datetime({ offset: true });
const LeadRefs = z.array(z.uuid()).min(1).max(5);

export const CrmAutomaticSyncSchema = z.object({
  version: z.number().int().positive().describe("Send as expected_version to change automatic sync."),
  provider: z.enum(["hubspot", "attio"]),
  connected: z.boolean().describe("The CRM is connected and needs no reconnection."),
  automatic_sync: z.enum(["on", "paused"])
    .describe("on: Lifty writes qualified leads, research, notes and activity to the CRM as they happen. paused: nothing is written on its own; leads wait. New connections start paused."),
  updated_at: Timestamp.nullable(),
  updated_by: z.uuid().nullable().describe("Who last changed it; null for the rollout default or a new connection."),
  waiting_leads: z.number().int().nonnegative().describe("Qualified leads not yet in the CRM: what turning automatic sync on writes first."),
  sync_run: z.object({ run_ref: RunRef, state: z.enum(["queued", "running"]), requested_leads: z.number().int().positive() }).strict().nullable()
    .describe("The CRM sync that is writing leads right now; read crm_sync_status for its receipt."),
  next_step: z.enum(["reconnect_crm", "run_test_sync", "turn_on_automatic_sync", "none"]),
}).strict();

export const CrmAutomaticSyncPatchSchema = z.object({
  expected_version: z.number().int().positive(),
  automatic_sync: z.enum(["on", "paused"]),
}).strict();

const CatchUp = z.union([
  z.object({ state: z.enum(["queued", "running"]), run_ref: RunRef, requested_leads: z.number().int().positive(), created: z.boolean() }).strict(),
  z.object({ state: z.enum(["none", "busy", "not_connected"]) }).strict(),
]).nullable().describe("Turning automatic sync on starts the sync of the waiting leads: its run_ref, or none (nothing waits), busy (another run must finish; the redrive writes them later) or not_connected.");

export const CrmAutomaticSyncChangeSchema = CrmAutomaticSyncSchema.extend({
  changed: z.boolean().describe("false when the saved state already matched; no version was added."),
  catch_up: CatchUp,
}).strict();

export const CrmTestSyncStartRequestSchema = z.object({
  // Omitted: Lifty picks qualified leads, preferring leads not yet in the CRM.
  lead_refs: LeadRefs.refine(refs => new Set(refs).size === refs.length, "List each lead once.").optional(),
}).strict();

export const CrmTestSyncStartSchema = z.object({
  state: z.enum(["queued", "running"]),
  run_ref: RunRef,
  lead_refs: LeadRefs,
  created: z.boolean().describe("false when the same test was already running and was reattached."),
}).strict();

export const CrmTestSyncQuerySchema = z.object({ run_ref: RunRef.optional() }).strict();

export const CrmTestFieldReasonSchema = z.enum([
  "research_found_nothing", "no_value", "research_unavailable", "set_by_outreach",
  "field_missing_in_crm", "record_missing", "record_unreadable", "not_written",
  "only_if_empty", "create_only", "managed_enum_transition",
]);

const CrmTestRecordSchema = z.object({
  record_id: z.string().min(1).max(200).nullable(),
  url: z.url().nullable(),
  found: z.boolean(),
}).strict();

export const CrmTestReceiptSchema = z.object({
  version: z.literal(1),
  provider: z.enum(["hubspot", "attio"]),
  leads: z.array(z.object({
    lead_ref: z.uuid(),
    name: z.string(),
    company: z.string().nullable(),
    contact: CrmTestRecordSchema,
    company_record: CrmTestRecordSchema,
    fields: z.array(z.object({
      object: z.enum(["contact", "company"]),
      field: z.string().min(1).max(200),
      label: z.string().max(300).nullable(),
      mapping_ref: z.string().min(1).max(100),
      source: z.string().max(1000),
      result: z.enum(["written", "kept", "skipped"]),
      reason: CrmTestFieldReasonSchema.nullable(),
      value: z.string().nullable(),
      crm_value: z.string().nullable(),
    }).strict()).max(400),
  }).strict()).max(5),
}).strict().describe("Per lead and mapped field, read back from the CRM after the test: written (the CRM holds Lifty's value), kept (the field's write rule kept the CRM value; reason is the rule) or skipped (reason says why).");

export const CrmTestSyncStatusSchema = z.union([
  z.object({ state: z.literal("none") }).strict(),
  z.object({
    run_ref: RunRef,
    state: z.enum(["queued", "running", "succeeded", "failed"]),
    lead_refs: LeadRefs,
    created_at: Timestamp,
    started_at: Timestamp.nullable(),
    completed_at: Timestamp.nullable(),
    error_code: z.string().nullable(),
    settings_changed: z.boolean().describe("The CRM settings changed since this test ran; offer to rerun the same lead_refs."),
    results: CrmTestReceiptSchema.nullable(),
  }).strict(),
]);

const automaticRoute = "/v1/workspace/crm/automatic-sync";
const testRoute = "/v1/workspace/crm/test-sync";
const unavailable = {
  code: "CRM_SYNC_CONTROLS_UNAVAILABLE",
  message: "The CRM sync settings could not be verified. Read them again; an unknown read is not a default.",
};
export const crmSyncControlsOperationDefinitions = {
  crm: {
    automatic_sync_get: {
      method: "GET", route: automaticRoute, cli: { operation: "automatic_sync" }, rpc: "get_lifty_crm_automatic_sync",
      path: Empty, query: Empty, request: null, invalid: { status: 400, code: "INVALID_REQUEST" },
      response: CrmAutomaticSyncSchema, success: 200, args: () => ({}),
      description: "Read whether Lifty writes to the CRM on its own (automatic sync on or paused; new connections start paused), the waiting leads, the sync writing now and the next step. Read test_sync_status for the latest test.",
    },
    automatic_sync_patch: {
      method: "PATCH", route: automaticRoute, cli: { operation: "automatic_sync" }, rpc: "set_lifty_crm_automatic_sync",
      path: Empty, query: Empty, request: CrmAutomaticSyncPatchSchema, invalid: { status: 422, code: "CRM_AUTOMATIC_SYNC_INVALID" },
      response: CrmAutomaticSyncChangeSchema, success: 200, args: input => ({ p_payload: input.body }),
      description: "Turn automatic sync on (writes the waiting leads first; catch_up is that sync) or pause every CRM write Lifty makes on its own, with expected_version.",
    },
    test_sync_start: {
      method: "POST", route: testRoute, cli: { operation: "test_sync" }, rpc: "start_lifty_crm_test_sync",
      path: Empty, query: Empty, request: CrmTestSyncStartRequestSchema, invalid: { status: 422, code: "CRM_TEST_SYNC_LEADS_INVALID" },
      response: CrmTestSyncStartSchema, success: 200, args: input => ({ p_payload: input.body }),
      description: "Write up to five leads (omit lead_refs to let Lifty pick) to the CRM with the current settings, even while automatic sync is paused. Never turns it on.",
    },
    test_sync_status: {
      method: "GET", route: testRoute, cli: { operation: "test_sync" }, rpc: "get_lifty_crm_test_sync",
      path: Empty, query: CrmTestSyncQuerySchema, request: null, invalid: { status: 400, code: "INVALID_REQUEST" },
      response: CrmTestSyncStatusSchema, success: 200, args: input => ({ p_run_ref: (input.query as { run_ref?: string }).run_ref ?? null }),
      description: "Read a test sync by run_ref (or the latest): each lead's CRM records and every mapped field as written, kept or skipped with the reason.",
    },
  },
} satisfies Record<string, Record<string, IdentityDefinition>>;

export const crmSyncControlsEntries = () => crmOperationEntries(crmSyncControlsOperationDefinitions);
export const executeCrmSyncControlsOperation = crmOperationExecutor(crmSyncControlsOperationDefinitions, unavailable);

/** The CRM run a response asks lifty-crm-sync to execute, if any. */
export function crmSyncControlsRunRef(key: string, result: unknown): string | null {
  if (key === "crm.test_sync_start") return (result as z.infer<typeof CrmTestSyncStartSchema>).run_ref;
  if (key === "crm.automatic_sync_patch") {
    const catchUp = (result as z.infer<typeof CrmAutomaticSyncChangeSchema>).catch_up;
    return catchUp && "run_ref" in catchUp ? catchUp.run_ref : null;
  }
  return null;
}
