import { PublicError } from "./errors.js";
import { connectionFetch } from "./connection-confirmation.js";

// Port of the monorepo's canonical Trigger.dev REST shim
// (lift-supabase-functions/_shared/trigger-task.ts): the ingress passes only
// the payload and an idempotency key — queue, retry, and version selection
// belong to the deployed lift-gtm-jobs task.
const FIRST_RUN_TASK_ID = "lifty-first-run";
const CRM_SYNC_TASK_ID = "lifty-crm-sync";
const CRM_MAPPING_TASK_ID = "lifty-crm-mapping-sync";
const INTEGRATION_REVOKE_TASK_ID = "lifty-integration-revoke";
// Owned by the notifications service's own Trigger project, reached with its
// own key (NOTIFICATIONS_TRIGGER_SECRET_KEY), never the Jobs project's.
const NOTIFICATIONS_TEST_TASK_ID = "notifications-test";
const WARMUP_VERIFY_TASK_ID = "lifty-email-warmup-verify";
const WARMUP_VERIFY_TIMEOUT_MS = 5000;
const IDEMPOTENCY_TTL = "1h";

export interface TriggerClientSettings {
  apiUrl: string;
  secretKey: string;
  fetchImpl?: typeof fetch;
}

async function triggerTask(
  settings: TriggerClientSettings,
  taskId: string,
  payload: unknown,
  idempotencyKey: string,
): Promise<{ id: string }> {
  const fetchImpl = settings.fetchImpl ?? fetch;
  const baseUrl = settings.apiUrl.replace(/\/$/, "");

  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/api/v1/tasks/${taskId}/trigger`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        payload,
        options: { idempotencyKey, idempotencyKeyTTL: IDEMPOTENCY_TTL },
      }),
    });
  } catch (error) {
    throw enqueueFailed(error);
  }
  if (!response.ok) {
    throw enqueueFailed(new Error(`Trigger.dev responded ${response.status}`));
  }

  const body = (await response.json().catch(() => null)) as
    | { id?: unknown }
    | null;
  if (!body || typeof body.id !== "string" || body.id.length === 0) {
    throw enqueueFailed(new Error("Trigger.dev returned no run id"));
  }
  return { id: body.id };
}

export type EnqueueFirstRun = (runId: string, attempt?: number) => Promise<{ id: string }>;

export function createFirstRunTrigger(
  settings: TriggerClientSettings,
): EnqueueFirstRun {
  // Reattachment reuses the attempt key; resuming a failed ledger run must
  // get a fresh wakeup instead of deduping against its finished Trigger run.
  return async (runId, attempt = 0) => {
    if (!Number.isSafeInteger(attempt) || attempt < 0) throw enqueueFailed(new Error("Invalid run attempt"));
    return triggerTask(settings, FIRST_RUN_TASK_ID, { runId, attempt }, `${FIRST_RUN_TASK_ID}:${runId}:${attempt}`);
  };
}

export type EnqueueCrmSync = (runId: string) => Promise<{ id: string }>;

export function createCrmSyncTrigger(
  settings: TriggerClientSettings,
): EnqueueCrmSync {
  // Same key per ledger run as the first-run trigger: a re-attached
  // `lifty sync` re-triggers idempotently and self-heals a lost enqueue.
  return async (runId) =>
    triggerTask(settings, CRM_SYNC_TASK_ID, { runId }, `${CRM_SYNC_TASK_ID}:${runId}`);
}

export type EnqueueCrmMapping = (runRef: string, workspaceRef: string) => Promise<void>;

export function createCrmMappingTrigger(settings: TriggerClientSettings): EnqueueCrmMapping {
  // The saved ledger owns the immutable cohort and proposed values. Reattaching
  // wakes that same run; no mapping payload or provider credential reaches ingress.
  return async runRef => {
    await triggerTask(settings, CRM_MAPPING_TASK_ID, { runRef },
      `${CRM_MAPPING_TASK_ID}:${runRef}`);
  };
}

export type EnqueueIntegrationRevocation = (revocationId: string) => Promise<{ id: string }>;

/** LIF-681: one revoke job per detached grant; the revocation row id is the key. */
export function createIntegrationRevocationTrigger(
  settings: TriggerClientSettings,
): EnqueueIntegrationRevocation {
  return async (revocationId) =>
    triggerTask(
      settings,
      INTEGRATION_REVOKE_TASK_ID,
      { revocationId },
      `${INTEGRATION_REVOKE_TASK_ID}:${revocationId}`,
    );
}

export interface NotificationTestRequest {
  workspaceId: string;
  destinationId: string;
  /** The caller's operation ID: retrying the same ID never posts twice. */
  requestId: string;
}
export type EnqueueNotificationTest = (request: NotificationTestRequest) => Promise<{ id: string }>;

/** One test message to one Slack destination. A 2xx is acceptance, not delivery. */
export function createNotificationTestTrigger(
  settings: TriggerClientSettings,
): EnqueueNotificationTest {
  return async ({ workspaceId, destinationId, requestId }) =>
    triggerTask(
      settings,
      NOTIFICATIONS_TEST_TASK_ID,
      { workspaceId, destinationId, requestId },
      `${NOTIFICATIONS_TEST_TASK_ID}:${workspaceId}:${requestId}`,
    );
}

export type EnqueueWarmupVerify = (senderRef: string, attempt: string) => Promise<{ id: string }>;

/** Mailivery accepted a founder's warmup handoff: Jobs verifies and starts that
 * binding now instead of at its next scheduled pass. One run per OAuth attempt.
 * Bounded, because it runs inside the founder's confirmation request. */
export function createWarmupVerifyTrigger(settings: TriggerClientSettings): EnqueueWarmupVerify {
  const fetchImpl = connectionFetch(settings.fetchImpl ?? fetch);
  const bounded: TriggerClientSettings = { ...settings,
    fetchImpl: (input, init) => fetchImpl(input, { ...init, signal: AbortSignal.timeout(WARMUP_VERIFY_TIMEOUT_MS) }) };
  return async (senderRef, attempt) =>
    triggerTask(bounded, WARMUP_VERIFY_TASK_ID, { senderRef }, `${WARMUP_VERIFY_TASK_ID}:${attempt}`);
}

function enqueueFailed(cause: unknown): PublicError {
  return new PublicError({
    status: 502,
    code: "IMPORT_ENQUEUE_FAILED",
    message:
      "LIFTY accepted the request but could not start the background run. Try the command again.",
    cause,
  });
}

export function createAcquisitionVerificationTrigger(settings: TriggerClientSettings) {
  return async (recoveryRef: string) => {
    const validReference = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(recoveryRef);
    if (!validReference) {
      throw enqueueFailed(new Error("Invalid acquisition recovery reference"));
    }
    return triggerTask(
      settings,
      "lifty-discovery-reconcile",
      { recoveryRef },
      `lifty-discovery-reconcile:${recoveryRef}`,
    );
  };
}
