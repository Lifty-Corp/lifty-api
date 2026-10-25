import { z } from "zod";
import { createSupabaseReadinessCheck, createTimeoutFetch, type SupabaseAuthenticationConfig } from "./supabase-auth.js";

/** A healthy Auth service alone does not establish the pilot's database contract. */
export function createConnectionReadinessCheck(
  config: SupabaseAuthenticationConfig,
  serverKeys: { email?: string; linkedin?: string },
  fetchImplementation: typeof fetch = globalThis.fetch.bind(globalThis),
): () => Promise<boolean> {
  const auth = createSupabaseReadinessCheck(config, { fetch: fetchImplementation });
  const boundedFetch = createTimeoutFetch(fetchImplementation, 1500);
  return async () => {
    if (!serverKeys.email || !serverKeys.linkedin) return false;
    try {
      const [authReady, response] = await Promise.all([
        auth(),
        boundedFetch(`${config.supabaseUrl}/rest/v1/rpc/lifty_connection_profile_ready`, {
          method: "POST",
          headers: { apikey: config.publishableKey, "content-type": "application/json" },
          body: JSON.stringify({ p_server_key: serverKeys.email, p_linkedin_server_key: serverKeys.linkedin }),
        }),
      ]);
      return authReady && response.ok && z.object({
        version: z.literal("lifty.connection-profile.v1"),
        artifact_sha256: z.string().regex(/^[0-9a-f]{64}$/),
        sending_available: z.literal(false),
      }).strict().safeParse(await response.json()).success;
    } catch { return false; }
  };
}
