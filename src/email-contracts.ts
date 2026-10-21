import { z } from "zod";

// Shared by the retained Email operations (warmup, placement, campaign). The
// Identity connect/status contracts live in identity-contracts.ts.
export const EmailWorkspace = z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/);

// This response decoder retains historical immutable campaign policy snapshots.
// Current execution policy is strict.v1 for every workspace, enforced by SQL.
export const EmailPolicy = z.discriminatedUnion("version", [
  z.object({ version: z.literal("strict.v1"), revision: z.uuid().nullable(), placement_required: z.literal(true), habitual_only: z.literal(false) }).strict(),
  z.object({ version: z.literal("lifty.personal-beta.v1"), revision: z.uuid(), placement_required: z.literal(false), habitual_only: z.literal(true) }).strict(),
]);
