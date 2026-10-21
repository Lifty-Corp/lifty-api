import { z } from "zod";
import type { AuthSession } from "./app.js";
import { PublicError } from "./errors.js";
import { EmailCampaignRequest, campaignResultFor, type EmailCampaignInput, type EmailCampaignOutput } from "./email-campaign-contracts.js";

const messages: Record<string, string> = {
  email_service_forbidden: "The email campaign service is unavailable. Contact LIFT support.",
  email_user_required: "Sign in to LIFTY before operating this campaign.",
  email_placement_campaign_stale: "The campaign changed. Preview its current digest before requesting or confirming placement.",
  email_placement_campaign_unavailable: "Placement is available only while this campaign is a draft or approved.",
  email_mailbox_unbound: "Connect and verify the exact sending account before requesting placement.",
  email_placement_not_started: "No placement test exists for this campaign version. Request one first.",
  email_placement_forbidden: "Choose a placement request from this workspace and campaign.",
  email_placement_confirmation_mismatch: "The placement reference, provider test or seed count changed. Read status and review the exact batch again.",
  email_placement_not_confirmable: "This placement test cannot be confirmed in its current state. Read status before continuing.",
  email_placement_unavailable: "Placement checks are not available yet. Sending remains blocked.",
  email_placement_confirmation_required: "Review the placement recipients and explicitly authorize the test before any seed messages are sent.",
  email_placement_ambiguous: "The placement request has an uncertain result. Check status; do not create another test.",
  email_placement_blocked: "The placement test cannot send until its safety checks pass.",
  email_workspace_forbidden: "Choose a workspace you belong to.",
  email_workspace_suspended: "This workspace is paused. Resume it before preparing or activating a campaign.",
  email_target_forbidden: "Choose a recipient from this workspace.",
  email_connection_forbidden: "Choose an email account connected to this workspace.",
  email_campaign_forbidden: "Choose a campaign from this workspace.",
  email_provider_not_selected: "Select this account's email provider for the workspace before preparing a campaign.",
  email_invalid_request: "Check the campaign fields and try again.",
  email_invalid_steps: "Use one to five plain-text emails. Follow-ups must wait at least one minute.",
  email_invalid_schedule: "Choose a start time no more than 90 days in the future.",
  email_approval_stale: "The campaign changed. Preview it again and approve its current digest.",
  email_campaign_not_draft: "Prepare a new campaign version before approving again.",
  email_approval_required: "Preview and explicitly approve this campaign before activating it.",
  email_execution_terminal: "This campaign execution has ended. Prepare and approve a new version.",
  email_sender_unhealthy: "The sending account is disconnected or its health check expired. Reconnect or refresh its health before sending.",
  email_sender_identity_mismatch: "The connected account no longer matches the approved sender.",
  email_principal_unavailable: "The sending mailbox identity could not be verified. Sending is blocked.",
  email_policy_changed: "The email policy changed. Prepare this campaign again, review its new digest, and approve it before activation.",
  email_declaration_required: "A current workspace member must declare the sending mailbox’s use before sending.",
  email_signature_missing: "The sender has no email signature. Save one with the sending-accounts signature_save operation, then prepare the campaign again.",
  email_warmup_required: "This dedicated account needs its initial warmup period (a healthy check after 21 active warmup days) before it can send. Check progress with lifty email warmup status.",
  email_warmup_spam: "Warmup emails from this account are landing in spam, so Lifty holds its sending until a later check is below the limit. Check lifty email warmup status.",
  email_placement_required: "A recent successful placement check is required for this sending account.",
  email_safety_check_required: "A recent successful safety check is required before sending.",
  email_target_mismatch: "The recipient changed. Prepare and approve the campaign again.",
  email_target_suppressed: "This recipient is suppressed. No campaign email will be sent.",
  email_critical_hold: "The sending account has a safety hold. Resolve the reported health or complaint issue before sending.",
  email_placement_request_required: "Request a placement test through LIFTY before authorizing any test recipients.",
  email_placement_unauthorized: "This placement request is not authorized to send. Check its current status and exact seed confirmation.",
  email_placement_replay_conflict: "The placement test details changed. Check the existing test; do not create another send request.",
  email_channel_inactive: "Email sending is paused for this workspace or sending account.",
  email_campaign_inactive: "This campaign is paused, replaced or no longer active.",
  email_recovery_required: "This execution needs delivery or reply verification before another email can send. Check status; do not resend an unconfirmed email.",
  email_cancel_confirmation_required: "Cancel using the exact campaign digest and explicit cancellation confirmation.",
  email_step_not_due: "The next campaign message is not due yet.",
  email_immutable_record: "Prepare a new campaign version instead of changing an existing execution.",
};
function mapError(error: unknown): never {
  const parsed = z.object({ code: z.string().optional(), message: z.string().optional() }).safeParse(error);
  const message = parsed.success ? parsed.data.message ?? "" : "";
  const publicMessage = Object.hasOwn(messages, message) ? messages[message] : undefined;
  const status = parsed.success && publicMessage && /^PT(400|401|403|409)$/.test(parsed.data.code ?? "") ? Number(parsed.data.code!.slice(2)) : 502;
  throw new PublicError({ status, code: publicMessage ? message.toUpperCase() : "EMAIL_CAMPAIGN_UNAVAILABLE", message: publicMessage ?? "LIFTY could not complete the campaign request. Retry the same request shortly." });
}
export function createEmailCampaignOperations(serverKey: string) {
  if (serverKey.length < 32) throw new Error("Invalid email server key.");
  return async (session: AuthSession, input: EmailCampaignInput): Promise<EmailCampaignOutput> => {
    const parsed = EmailCampaignRequest.parse(input);
    // The authenticated caller's client preserves their JWT; the dedicated
    // server key grants this RPC capability, never unrestricted table access.
    const client = session.client as { rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> };
    let response;
    const placement = parsed.operation === "placement" || parsed.operation === "placement-status" || parsed.operation === "placement-confirm";
    try { response = parsed.operation === "placement-preview" ? await client.rpc("lifty_email_placement_preview", {p_server_key:serverKey,p_payload:parsed.payload}) : await client.rpc(parsed.operation === "cancel" ? "lifty_email_campaign_recovery" : placement ? "lifty_email_placement" : "lifty_email_campaign", { p_server_key: serverKey, p_operation: placement ? (parsed.operation === "placement" ? "start" : parsed.operation === "placement-confirm" ? "confirm" : "status") : parsed.operation, p_payload: parsed.payload }); }
    catch { mapError(null); }
    if (response.error) mapError(response.error);
    try {
      const result = campaignResultFor(parsed.operation, response.data);
      if (("campaign_ref" in parsed.payload && parsed.payload.campaign_ref && "campaign_ref" in result && parsed.payload.campaign_ref !== result.campaign_ref)
        || ("digest" in parsed.payload && "digest" in result && parsed.payload.digest !== result.digest)
        || (parsed.operation === "placement-confirm" && "placement_ref" in result && (result.placement_ref !== parsed.payload.placement_ref || result.test_ref !== parsed.payload.test_ref || result.seed_count !== parsed.payload.seed_count))
        || ("workspace_ref" in result && /^[a-f0-9-]{36}$/i.test(parsed.payload.workspace) && result.workspace_ref !== parsed.payload.workspace)) throw new Error("Campaign response identity mismatch.");
      return result;
    }
    catch { throw new PublicError({ status: 502, code: "EMAIL_CAMPAIGN_UNAVAILABLE", message: "LIFTY returned an invalid campaign result. Check status before retrying." }); }
  };
}
