import { z } from "zod";
import type { AuthSession } from "./app.js";
import { PublicError } from "./errors.js";
import { rpcFailure } from "./rpc-errors.js";
import * as contracts from "./business-contracts.js";
import { targetingVocabularyIssues } from "./targeting-vocabulary.js";
const Empty = z.object({}).strict();
export const businessOperationDefinitions = {
  business: {
    get: {
      method: "GET",
      route: "/v1/workspace/business",
      response: contracts.BusinessGetSchema,
      request: Empty,
      rpc: "get_lifty_business_profile",
      code: "PROFILE_INVALID",
      description:
        "Read the versioned commercial profile and confirmed-value checkpoint. No workspace returns workspace:null and profile:null.",
    },
    post: {
      method: "POST",
      route: "/v1/workspace/business",
      response: contracts.BusinessPostResultSchema,
      request: contracts.BusinessPostSchema,
      rpc: "create_lifty_business_profile",
      code: "PROFILE_INVALID",
      description:
        "Create a workspace with profile version 1 and empty voice. When you already have a workspace (selected by the workspace rule) it is returned unchanged with created:false. Creates no setup draft and activates no work.",
    },
    patch: {
      method: "PATCH",
      route: "/v1/workspace/business",
      response: contracts.BusinessGetSchema,
      request: contracts.BusinessPatchSchema,
      rpc: "patch_lifty_business_profile",
      code: "PROFILE_INVALID",
      description:
        "Synchronously edit supplied profile fields using expected_version. Omitted fields stay unchanged; null clears optional fields; arrays replace. Append a revision without regenerating criteria or changing approved campaigns.",
    },
  },
  targeting: {
    get: {
      method: "GET",
      route: "/v1/workspace/targeting",
      response: contracts.TargetingGetSchema,
      request: Empty,
      rpc: "get_lifty_targeting",
      code: "TARGETING_INVALID",
      description:
        "Read the versioned neutral targeting resource, including every existing search lane. Search allocation is platform policy.",
    },
    patch: {
      method: "PATCH",
      route: "/v1/workspace/targeting",
      response: contracts.TargetingGetSchema,
      request: contracts.TargetingPatchSchema,
      rpc: "patch_lifty_targeting",
      code: "TARGETING_INVALID",
      description:
        "Synchronously change lanes: {id,...} patches a lane and keeps omitted filters, {id, remove:true} removes it, a lane without id is added; personas without id are new (the server assigns ids). Filter edits affect the next discovery. Any persona change needs regenerated_criteria (with its expected_version) in the same request; both commit together.",
    },
  },
  "research-criteria": {
    get: {
      method: "GET",
      route: "/v1/workspace/research-criteria",
      response: contracts.CriteriaGetSchema,
      request: Empty,
      rpc: "get_lifty_research_criteria",
      code: "CRITERIA_INVALID",
      description:
        "Read the current versioned Scout criteria: text, research fields and the source versions the server recorded.",
    },
    patch: {
      method: "PATCH",
      route: "/v1/workspace/research-criteria",
      response: contracts.CriteriaGetSchema,
      request: contracts.CriteriaPatchSchema,
      rpc: "patch_lifty_research_criteria",
      code: "CRITERIA_INVALID",
      description:
        "Synchronously append a criteria revision with expected_version and text and/or research_fields. The server records source versions. New research uses the new version; saved history keeps its version.",
    },
  },
  "commercial-voice": {
    get: {
      method: "GET",
      route: "/v1/workspace/commercial-voice",
      response: contracts.VoiceGetSchema,
      request: Empty,
      rpc: "get_lifty_commercial_voice",
      code: "VOICE_INVALID",
      description:
        "Read general commercial tone and do/avoid rules. Empty voice exists at version 0.",
    },
    patch: {
      method: "PATCH",
      route: "/v1/workspace/commercial-voice",
      response: contracts.VoiceGetSchema,
      request: contracts.VoicePatchSchema,
      rpc: "patch_lifty_commercial_voice",
      code: "VOICE_INVALID",
      description:
        "Synchronously edit general voice with expected_version (0 for the first edit). Arrays replace; null clears tone. New drafts use it, approved campaign pins remain, and Scout never receives voice.",
    },
  },
  setup: {
    get_draft: {
      method: "GET",
      route: "/v1/workspace/setup/draft",
      cli: { operation: "draft" },
      response: contracts.SetupDraftGetSchema,
      request: Empty,
      rpc: "get_lifty_setup_draft",
      code: "SETUP_DRAFT_INVALID",
      description:
        "Read the workspace-owned server draft, generated criteria, gates and immutable submission state. The server draft is the only setup source.",
    },
    patch_draft: {
      method: "PATCH",
      route: "/v1/workspace/setup/draft",
      cli: { operation: "draft" },
      response: contracts.SetupDraftGetSchema,
      request: contracts.SetupDraftPatchSchema,
      rpc: "save_lifty_setup_draft",
      code: "SETUP_DRAFT_INVALID",
      description:
        "Replace the current workspace draft with the supplied complete draft and generated_criteria, or null to clear generated criteria. Uses expected_version and retains prior revisions. The server binds generated criteria to the draft version this save creates. Submitted drafts are immutable. Does not submit or activate work.",
    },
    delete_draft: {
      method: "DELETE",
      route: "/v1/workspace/setup/draft",
      cli: { operation: "draft" },
      response: contracts.SetupDiscardSchema,
      request: Empty,
      rpc: "discard_lifty_setup_draft",
      code: "SETUP_DRAFT_INVALID",
      description:
        "Discard setup only before submission. The database refuses discarding a submitted draft. Does not delete Business resources or history.",
    },
    generation_context: {
      method: "GET",
      route: "/v1/workspace/setup/context",
      cli: { operation: "context" },
      response: contracts.SetupContextSchema,
      request: Empty,
      rpc: "get_lifty_setup_context",
      code: "SETUP_DRAFT_INVALID",
      description:
        "Read the confirmed profile, saved server draft, current Scout base text/version and API-owned generation guidance. Generate only Scout criteria.",
    },
    post: {
      method: "POST",
      route: "/v1/workspace/setup",
      response: contracts.SetupStatusSchema,
      request: contracts.SetupPostSchema,
      rpc: "submit_lifty_setup",
      code: "SETUP_INVALID",
      description:
        "Submit expected_draft_version once: atomically create targeting and criteria at version 1. The same version replays the exact receipt. Changed profile, draft or base returns a conflict; an existing different setup cannot be replaced. Never activates research or outreach.",
    },
    status: {
      method: "GET",
      route: "/v1/workspace/setup/status",
      cli: { operation: "status" },
      response: contracts.SetupStatusSchema,
      request: Empty,
      rpc: "get_lifty_setup_status",
      code: "SETUP_INVALID",
      description:
        "Read the persisted setup_ref and exact source/resource versions. Imported confirms both resources exist; a lost submit response is resolved by this read.",
    },
  },
} as const;
export type BusinessOperationKey =
  `${keyof typeof businessOperationDefinitions}.${string}`;
export const businessEntries = () =>
  Object.entries(businessOperationDefinitions).flatMap(
    ([resource, operations]) =>
      Object.entries(operations).map(([action, definition]) => ({
        key: `${resource}.${action}`,
        resource,
        action,
        definition,
      })),
  );
export function validateBusinessRequest(
  schema: z.ZodType,
  input: unknown,
  code: string,
) {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.slice(0, 20).map((issue) => ({
    code: `schema_${issue.code}`,
    path: `/${issue.path.map((part) => String(part).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`,
    message: "This field does not match the current resource contract.",
    suggestion:
      issue.code === "unrecognized_keys"
        ? "Remove fields absent from the published operation schema."
        : "Use the field type, bounds and provenance shown in the current operation schema.",
  }));
  throw new PublicError({
    status: 422,
    code,
    message: "Repair these fields using the current resource schema.",
    issues,
  });
}
type Rpc = { rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> };
const businessUnavailable = (operation: string) => ({
  operation,
  code: "BUSINESS_UNAVAILABLE",
  message: "Business state could not be verified. Read the resource before retrying a write.",
});
// LIF-1694: search finds nobody for an industry label or NAICS code outside the
// published lists, so a write that sets one is refused before the database,
// with the route's own validation code. The check is in memory against the
// embedded lists.
function refuseUnsearchable(issues: ReturnType<typeof targetingVocabularyIssues>, code: string, message: string) {
  if (issues.length) throw new PublicError({ status: 422, code, message, issues });
}
const REPAIR_MESSAGE = "Replace these industry labels or NAICS codes; search finds nobody with them.";
// Setup submits the saved draft, which may predate the check: read it first.
async function refuseUnsearchableDraft(session: AuthSession, expectedVersion: number, code: string) {
  let result: { data: unknown; error: unknown };
  try {
    result = await (session.client as Rpc).rpc("get_lifty_setup_draft", { p_workspace_id: session.workspaceRef ?? null });
  } catch (cause) {
    throw rpcFailure(cause, businessUnavailable("get_lifty_setup_draft"));
  }
  if (result.error) throw rpcFailure(result.error, businessUnavailable("get_lifty_setup_draft"));
  const saved = contracts.SetupDraftGetSchema.safeParse(result.data);
  if (!saved.success)
    throw new PublicError({ status: 502, code: "BUSINESS_UNAVAILABLE", message: "The setup draft could not be verified. Read it before submitting." });
  // A submitted draft replays its receipt and another version is the database's conflict.
  if (saved.data.submitted || saved.data.version !== expectedVersion) return;
  refuseUnsearchable(
    targetingVocabularyIssues(saved.data.draft?.targeting.lanes, ["draft", "targeting", "lanes"]),
    code,
    "The saved setup draft has industry labels or NAICS codes search cannot use. Replace them with setup_patch_draft, then submit the version it returns.",
  );
}
// The workspace is resolved in the database by the shared selection rule from
// the x-lifty-workspace header the session client forwards. Typed database
// errors map through the one table in rpc-errors.ts.
export async function executeBusinessOperation(
  session: AuthSession,
  key: string,
  payload?: unknown,
): Promise<unknown> {
  const entry = businessEntries().find((entry) => entry.key === key);
  if (!entry) throw new Error("Unknown Business operation");
  const { code } = entry.definition;
  if (key === "targeting.patch")
    refuseUnsearchable(targetingVocabularyIssues((payload as { lanes: unknown }).lanes, ["lanes"]), code, REPAIR_MESSAGE);
  if (key === "setup.patch_draft")
    refuseUnsearchable(
      targetingVocabularyIssues((payload as { draft: { targeting: { lanes: unknown } } }).draft.targeting.lanes, ["draft", "targeting", "lanes"]),
      code,
      REPAIR_MESSAGE,
    );
  if (key === "setup.post")
    await refuseUnsearchableDraft(session, (payload as { expected_draft_version: number }).expected_draft_version, code);
  const args =
    key === "business.post"
      ? { p_payload: payload }
      : key === "setup.post"
        ? { p_workspace_id: session.workspaceRef ?? null, p_expected_draft_version: (payload as { expected_draft_version: number }).expected_draft_version }
        : { p_workspace_id: session.workspaceRef ?? null, ...(entry.definition.method === "PATCH" ? { p_payload: payload } : {}) };
  const unavailable = businessUnavailable(entry.definition.rpc);
  let result: { data: unknown; error: unknown };
  try {
    result = await (session.client as Rpc).rpc(entry.definition.rpc, args);
  } catch (cause) {
    throw rpcFailure(cause, unavailable);
  }
  if (result.error) throw rpcFailure(result.error, unavailable);
  const context =
    key === "setup.generation_context"
      ? contracts.SetupContextDataSchema.safeParse(result.data)
      : null;
  if (context && !context.success)
    throw new PublicError({
      status: 502,
      code: "BUSINESS_UNAVAILABLE",
      message: "The setup context could not be verified.",
    });
  const data = context?.success
    ? {
        ...context.data,
        generation_rules: contracts.SETUP_GENERATION_RULES,
        criteria_schema: z.toJSONSchema(contracts.GeneratedCriteriaSchema, { io: "input" }),
        draft_schema: z.toJSONSchema(contracts.SetupDraftWriteSchema, { io: "input" }),
      }
    : result.data;
  const parsed = entry.definition.response.safeParse(data);
  if (!parsed.success)
    throw new PublicError({
      status: 502,
      code: "BUSINESS_UNAVAILABLE",
      message: "The resource response could not be verified. Retry its read.",
    });
  if (key === "targeting.get" || key === "targeting.patch") {
    const targeting = parsed.data as z.infer<typeof contracts.TargetingGetSchema>;
    const warnings = targetingVocabularyIssues(targeting.targeting?.lanes, ["targeting", "lanes"]);
    if (warnings.length) return { ...targeting, filter_warnings: warnings };
  }
  return parsed.data;
}

