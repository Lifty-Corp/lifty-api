import { z } from "zod";
import { crmOperationEntries, crmOperationExecutor } from "./crm-operations.js";
import type { IdentityDefinition } from "./identity-operations.js";

// LIF-1239 CRM preferences: the three founder choices of the strict v1
// artifact policy (research notes, conversations, conversation channels).
// The database owns the policy on the selected CRM integration and resolves
// the workspace from the session's x-lifty-workspace header, like Identity.
// Jobs reads the saved policy on every run; a change applies to future CRM
// writes only.
const Empty = z.object({}).strict();
const Channel = z.enum(["email", "linkedin"]);
const Channels = z.array(Channel).min(1).max(2)
  .refine(channels => new Set(channels).size === channels.length, "List each channel once: email, linkedin or both.")
  .describe("Which conversations go to the CRM: email, linkedin or both, each once.");
const ResearchSchema = z.object({
  mode: z.enum(["none", "on_complete"]).describe("on_complete writes a research note when a lead's research completes; none writes no research notes."),
}).strict();
const ConversationSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }).strict(),
  z.object({ mode: z.enum(["on_reply", "all"]), channels: Channels }).strict(),
]);
export const CrmPreferencesSchema = z.object({
  version: z.number().int().positive(),
  provider: z.enum(["hubspot", "attio"]),
  research: ResearchSchema,
  conversation: ConversationSchema,
  updated_at: z.iso.datetime({ offset: true }).nullable(),
  updated_by: z.uuid().nullable(),
}).strict();
export const CrmPreferencesPatchSchema = z.object({
  expected_version: z.number().int().positive(),
  research: ResearchSchema.optional(),
  conversation: z.object({
    mode: z.enum(["none", "on_reply", "all"]).optional()
      .describe("all writes every sent message and reply; on_reply starts once the lead replies; none writes no conversations."),
    channels: Channels.optional(),
  }).strict()
    .refine(value => value.mode !== undefined || value.channels !== undefined, "Supply the conversation mode, channels or both.")
    .refine(value => !(value.mode === "none" && value.channels), "Channels apply only when conversations are on_reply or all.")
    .optional(),
}).strict().refine(value => value.research || value.conversation, "Supply research, conversation or both.");

const route = "/v1/workspace/crm/preferences";
const invalid = { status: 422, code: "CRM_PREFERENCES_INVALID" } as const;
const unavailable = {
  code: "CRM_PREFERENCES_UNAVAILABLE",
  message: "The CRM preferences could not be verified. Read them again; an unknown read is not a default.",
};
export const crmPreferencesOperationDefinitions = {
  crm: {
    preferences_get: {
      method: "GET", route, cli: { operation: "preferences" }, rpc: "get_lifty_crm_preferences", path: Empty,
      query: Empty, request: null, invalid: { status: 400, code: "INVALID_REQUEST" },
      response: CrmPreferencesSchema, success: 200, args: () => ({}),
      description: "Read what Lifty writes to the selected CRM besides mapped fields: research notes (none or on_complete), conversations (none, on_reply or all) and their channels (email, linkedin), with the version to change them. A disconnected CRM keeps its choices. Without a CRM returns CRM_NOT_SELECTED. Read-only.",
    },
    preferences_patch: {
      method: "PATCH", route, cli: { operation: "preferences" }, rpc: "patch_lifty_crm_preferences", path: Empty,
      query: Empty, request: CrmPreferencesPatchSchema, invalid, response: CrmPreferencesSchema, success: 200,
      args: input => ({ p_payload: input.body }),
      description: "Change research notes, conversations or their channels with expected_version. Omitted choices keep their saved value and channels replaces the list. Turning conversations on from none needs channels. Applies to future CRM writes only: notes and conversations already in the CRM stay. Does not start a CRM sync, outreach or research.",
    },
  },
} satisfies Record<string, Record<string, IdentityDefinition>>;
export const crmPreferencesEntries = () => crmOperationEntries(crmPreferencesOperationDefinitions);
export const executeCrmPreferencesOperation = crmOperationExecutor(crmPreferencesOperationDefinitions, unavailable);
