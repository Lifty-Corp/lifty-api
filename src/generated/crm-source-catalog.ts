// Generated from lift-gtm-dashboard/lib/crm-source-catalog.ts; regenerate with scripts/sync-crm-contract.mjs.
/**
 * CRM Sync Map — source-field catalog (P03).
 *
 * Produces the two source lists a mapping author picks FROM when wiring a
 * `Lead` (or research) field to a CRM field:
 *
 *  1. DISCOVERY sources — a CURATED allowlist of mappable `public.leads`
 *     columns. Deliberately hand-picked: only the columns that describe the
 *     person/company and are safe to push to a CRM. IDs, funnel state,
 *     timestamps, and internal pipeline bookkeeping columns are excluded — they
 *     are either workspace-internal, machine-managed, or meaningless in the CRM.
 *
 *  2. RESEARCH sources — candidate dot-paths discovered by flattening the
 *     `custom_fields` JSON blob of the last N `lead_ai_research` rows for the
 *     active workspace, each annotated with a `seen_in: n/N` count. A low (or
 *     zero) count is a drift hint: a path the author mapped once but the agent
 *     has stopped emitting, or a brand-new key worth mapping.
 *
 * Source paths use the same custom_fields.<dot.path> namespace as the CRM
 * mapping evaluator and the Scout input contract.
 *
 * Every DB-touching function takes `workspaceId` and filters `workspace_id` — workspace
 * scoping is non-negotiable.
 *
 * This file is PURE (no DB, no `@/` imports) so `node --test` can load it
 * directly. The workspace-scoped fetch that resolves `getResearchSources` against
 * Supabase lives in the sibling `crm-source-catalog-query.ts`.
 */

// ---------------------------------------------------------------------------
// Discovery sources — curated `leads` column allowlist
// ---------------------------------------------------------------------------

export type LeadSourceDataType = "string" | "number";

export type DiscoverySource = {
  /** Real `public.leads` column name. */
  column: string;
  /** Human label for the Studio source-field row. */
  label: string;
  data_type: LeadSourceDataType;
};

/**
 * The mappable `leads` columns, in display order. Each entry is a REAL column on
 * `public.leads` (verified against the live schema). This is an allowlist by
 * design: adding a column here is a deliberate decision, not a schema reflection.
 *
 * Excluded on purpose (do NOT add):
 *  - ids / FKs: id, workspace_id, sender_id, apollo_id, crm_*_id —
 *    workspace-internal or CRM-side keys.
 *  - funnel state: funnel_stage, suppression_reason,
 *    email_status, phone_status — machine-managed pipeline state.
 *  - retired columns: qualification_status stays denied for stale mappings.
 *  - timestamps: *_at columns (discovered_at, synced_at, qualified_at, …) and
 *    created_at / updated_at — bookkeeping, not contact attributes.
 *  - internal bookkeeping: tag, tags, apollo_action, sequence_name,
 *    soft_bounce_count, icp_score,
 *    phone*, email — channel/ops internals or PII handled elsewhere.
 */
export const DISCOVERY_SOURCES: readonly DiscoverySource[] = [
  { column: "first_name", label: "First name", data_type: "string" },
  { column: "last_name", label: "Last name", data_type: "string" },
  { column: "title", label: "Title", data_type: "string" },
  { column: "company_name", label: "Company name", data_type: "string" },
  { column: "company_domain", label: "Company domain", data_type: "string" },
  { column: "linkedin_url", label: "LinkedIn URL", data_type: "string" },
  { column: "persona_type", label: "Persona type", data_type: "string" },
  { column: "industry", label: "Industry", data_type: "string" },
  { column: "employee_count", label: "Employee count", data_type: "number" },
  { column: "icp_tier", label: "ICP tier", data_type: "string" },
] as const;

/**
 * Columns explicitly kept OUT of the discovery allowlist. Exported so a test (or
 * a future schema-drift check) can assert none of them ever leak into
 * `DISCOVERY_SOURCES`. Not exhaustive of the table — it names the forbidden
 * categories the deliverable calls out plus the obvious internal columns.
 */
export const EXCLUDED_LEAD_COLUMNS: readonly string[] = [
  // ids / FKs
  "id",
  "workspace_id",
  "company_id",
  "sender_id",
  "apollo_id",
  "crm_contact_id",
  // funnel / state
  "funnel_stage",
  "qualification_status",
  "suppression_reason",
  "email_status",
  "phone_status",
  // timestamps
  "discovered_at",
  "synced_at",
  "qualified_at",
  "enrolled_at",
  "first_opened_at",
  "first_clicked_at",
  "replied_at",
  "meeting_booked_at",
  "suppressed_at",
  "last_touch_at",
  "contacted_at",
  "phone_revealed_at",
  "created_at",
  "updated_at",
  // internal bookkeeping
  "tag",
  "tags",
  "apollo_action",
  "sequence_name",
  "soft_bounce_count",
  "icp_score",
  "email",
  "phone",
  "phone_source",
  "phone_type",
] as const;

/**
 * Returns the curated discovery source list. Pure (no DB) — the allowlist is
 * static. Takes no `workspaceId` because it describes the schema, not a workspace's
 * rows; included as a function for symmetry with `getResearchSources` and so the
 * Studio UI consumes one catalog surface.
 */
export function getDiscoverySources(): DiscoverySource[] {
  return [...DISCOVERY_SOURCES];
}

// ---------------------------------------------------------------------------
// Research sources — flattened `custom_fields` candidate paths
// ---------------------------------------------------------------------------

/**
 * Prefix every flattened key with this so the namespace matches how research
 * map paths address the blob (`custom_fields.foo.bar`). MUST equal the jobs-side
 * drift detector's `CUSTOM_FIELDS_PREFIX` so the two stay apples-to-apples.
 */
export const CUSTOM_FIELDS_PREFIX = "custom_fields";

export type CustomFieldsBlob = Record<string, unknown> | null | undefined;

/**
 * Flattens a `custom_fields` blob to dot-keyed LEAF paths, namespaced under
 * `custom_fields.`.
 *
 * `{ a: { b: 1 } }` → `["custom_fields.a.b"]`. Only leaves are emitted — a map
 * entry reads a leaf value, not an intermediate object. Arrays are treated as
 * leaves: the path stops at the array (the sync coerces the whole array, e.g.
 * to CSV), so descending into indices would invent per-index keys no map entry
 * ever targets. An EMPTY nested object has no children to descend into, so it is
 * emitted as a leaf key itself (e.g. `{ a: {} }` → `["custom_fields.a"]`); a
 * top-level empty/null/non-object blob emits nothing.
 *
 * DUPLICATE of jobs `flattenCustomFields` by constitution — see file header.
 */
export function flattenCustomFields(
  blob: CustomFieldsBlob,
  prefix: string = CUSTOM_FIELDS_PREFIX,
  acc: Set<string> = new Set(),
): Set<string> {
  if (!blob || typeof blob !== "object" || Array.isArray(blob)) return acc;
  for (const [key, value] of Object.entries(blob)) {
    const dotKey = `${prefix}.${key}`;
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length > 0
    ) {
      flattenCustomFields(value as Record<string, unknown>, dotKey, acc);
    } else {
      acc.add(dotKey);
    }
  }
  return acc;
}

export type ResearchSource = {
  /** Dot-path namespaced under `custom_fields.` (e.g. `custom_fields.active_initiative.name`). */
  path: string;
  /** Rows (of the N sampled) whose blob contained this leaf path. */
  seen_in: number;
  /** Total rows sampled (the denominator of the drift hint). */
  sampled: number;
};

/**
 * Pure aggregation: given the `custom_fields` blobs of the N most-recent
 * research rows, flatten each to leaf dot-paths and count, per path, how many
 * rows contained it. Returns one `ResearchSource` per distinct path with a
 * `seen_in: n / sampled` count.
 *
 * Sorted by descending `seen_in` then path, so stable/common paths surface
 * first and the drift-suspect (low-count) ones sink to the bottom. With zero
 * sampled rows the result is empty (`sampled: 0`, no paths to hint about).
 */
export function aggregateResearchSources(
  blobs: readonly CustomFieldsBlob[],
): ResearchSource[] {
  const sampled = blobs.length;
  const counts = new Map<string, number>();
  for (const blob of blobs) {
    // Flatten with a fresh accumulator per row so duplicate leaf paths across
    // rows are counted once-per-row (a Set dedupes within a single blob).
    const leaves = flattenCustomFields(blob, CUSTOM_FIELDS_PREFIX, new Set());
    for (const path of leaves) {
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([path, seen_in]) => ({ path, seen_in, sampled }))
    .sort((a, b) => b.seen_in - a.seen_in || a.path.localeCompare(b.path));
}

/** Default sample size for the research source scan. */
export const DEFAULT_RESEARCH_SAMPLE = 50;
