import { createAcquisitionRecoveryOperations } from "./acquisition-recovery.js";
import { createOAuthConfirmation } from "./oauth-confirmation.js";
import { openHubspotConnectIntent } from "./hubspot-state.js";
import { openSlackConnectIntent } from "./slack-state.js";
import { openAttioConnectIntent } from "./attio-state.js";
import { createAttioConnectOperations, getAttioConnection } from "./attio-connect.js";
import { buildAttioAuthorizationUrl } from "./attio-oauth.js";
import { createRunProgressReader } from "./run-progress.js";
import { createCompanyReadinessCheck } from "./company-mapping/readiness.js";
import { createCrmMappingReadinessCheck } from "./crm-mapping/readiness.js";
import { createCompanyMapping } from "./company-mapping.js";
import { createCrmMapping } from "./crm-mapping.js";
import { createWorkspaceRetirement } from "./workspace-retirement.js";
import { deleteOwnLogin } from "./login-deletion.js";
import { listMemberWorkspaces } from "./member-workspaces.js";
import { createEmailCampaignOperations } from "./email-campaign.js";
import { createEmailWarmupOperations } from "./email-warmup.js";
import { createEmailConnectionPlacementOperations } from "./email-connection-placement.js";
import { createEmailDeliverabilityOperations } from "./email-deliverability.js";
import { createPlacementReportReader } from "./email-deliverability-placement.js";
import { createWarmupSetup } from "./warmup-setup.js";

import { randomBytes } from "node:crypto";

import { createApp } from "./app.js";
import { renderCliAuthPage } from "./cli-auth-page.js";
import { renderPasswordRecoveryPage } from "./password-recovery-page.js";
import { DEFAULT_DASHBOARD_ORIGIN, loadConfig, type ServiceConfig } from "./config.js";
import { executeResearchOperation } from "./research-operations.js";
import { connectorUnavailable, executeIdentityOperation } from "./identity-operations.js";
import { createAccountConnection } from "./account-connection.js";
import { createWarmupMailboxIdentifier } from "./warmup-mailbox-provider.js";
import { PublicError } from "./errors.js";
import { createHubspotConnectOperations } from "./hubspot-connect.js";
import { buildAuthorizationUrl } from "./hubspot-oauth.js";
import {
  createSlackConnectOperations,
  SlackCallbackError,
} from "./slack-connect.js";
import { buildSlackAuthorizationUrl } from "./slack-oauth.js";
import {
  createSupabaseAuthenticator,
  createSupabaseReadinessCheck,
} from "./supabase-auth.js";
import { createAcquisitionVerificationTrigger, createCrmSyncTrigger, createCrmMappingTrigger, createFirstRunTrigger, createIntegrationRevocationTrigger, createNotificationTestTrigger, createWarmupVerifyTrigger } from "./trigger-client.js";
import { confirmRunReview, disconnectIntegration, getCrmSyncStatus, getRunStatus, getWorkspaceStatus, getNotificationConfig, listSlackNotificationChannels, upsertNotificationDestination, setNotificationRoute, sendNotificationTest, startCrmSyncRun, startRun } from "./workspace-operations.js";

export function createProductionApp(config: ServiceConfig) {
  const emailKey = config.serverKeys?.email ?? null;
  const accounts = config.accounts ? createAccountConnection(config.accounts) : null;
  const identifyWarmupMailbox=config.accounts?createWarmupMailboxIdentifier(config.accounts.provider):null;
  // Workspace member operations use their session. Browser setup uses a narrow,
  // server-key-protected intent RPC, never a Supabase administrative key.
  const warmupSetup = config.warmupSetup
    ? createWarmupSetup(config.warmupSetup, { verifyWarmup: createWarmupVerifyTrigger(config.trigger),
      ...(identifyWarmupMailbox?{identifyMailbox:identifyWarmupMailbox}:{}) }) : null;
  const placement = createEmailConnectionPlacementOperations();
  const notificationTest = createNotificationTestTrigger(config.notificationsTrigger);
  const warmup = createEmailWarmupOperations({ ...(warmupSetup ? {issueSetupLink:warmupSetup.issue} : {}) });
  // Reads use the caller's session; only report reads for authorized tests use the server-side key.
  const deliverability = createEmailDeliverabilityOperations({
    readPlacementDetails: createPlacementReportReader({ smartleadApiKey: config.smartleadApiKey ?? null }) });
  const hubspot = createHubspotConnectOperations(config.hubspot);
  const attioSettings = config.attio ?? null;
  const attio = attioSettings ? createAttioConnectOperations(attioSettings) : null;
  const slackSettings = config.slack;
  const slack = slackSettings
    ? createSlackConnectOperations(slackSettings)
    : null;
  const slackUnavailable = () => {
    throw new PublicError({
      status: 503,
      code: "INTEGRATION_NOT_CONFIGURED",
      message: "The Slack connection service is not configured.",
    });
  };
  return createApp({
    connectionCallbacks:{
      hubspot:createOAuthConfirmation({provider:"hubspot",origin:new URL(config.hubspot.publicBaseUrl).origin,...config.supabase,
        open:state=>openHubspotConnectIntent(state,config.hubspot.clientSecret),complete:hubspot.completeCallback}),
      ...(attio && attioSettings ? {attio:createOAuthConfirmation({provider:"attio",origin:new URL(attioSettings.publicBaseUrl).origin,...config.supabase,
        open:state=>openAttioConnectIntent(state,attioSettings.clientSecret),complete:attio.completeCallback})} : {}),
      ...(slack && slackSettings ? {slack:createOAuthConfirmation({provider:"slack",origin:new URL(slackSettings.publicBaseUrl).origin,...config.supabase,
        open:state=>openSlackConnectIntent(state,slackSettings.clientSecret),complete:slack.completeCallback})} : {}),
    },
    ...(accounts && config.accounts ? { accounts: { connection: accounts, origin: new URL(config.accounts.publicBaseUrl).origin,
      hostedOrigins: config.accounts.provider.v2.hostedAuthOrigins } } : {}),
    identityOperation: (session, key, input, signal) => executeIdentityOperation(session, key, input, accounts ?? connectorUnavailable, signal),
    ...(config.openAiAppsChallenge === undefined ? {} : { openAiAppsChallenge: config.openAiAppsChallenge }),
    ...(config.mcp ? {
      mcp: { ...config.mcp, authenticate: createSupabaseAuthenticator(config.supabase, { oauthResource: config.mcp.resourceUrl }) },
      renderOAuthConsentPage: (authorizationId: string) => {
        const scriptNonce = randomBytes(18).toString("base64url");
        return { html: renderCliAuthPage({ supabaseUrl: config.supabase.supabaseUrl,
          publishableKey: config.supabase.publishableKey, authorizationId, scriptNonce }),
          scriptNonce, connectOrigin: new URL(config.supabase.supabaseUrl).origin };
      },
    } : {}),
    getEmailDeliverability: deliverability.read,
    getEmailPlacement: placement.status,
    startEmailPlacement: placement.start,
    ...(warmupSetup ? {warmupSetup} : {}),
    ...(emailKey ? {
      emailCampaign: createEmailCampaignOperations(emailKey),
      getEmailWarmup: warmup.status,
      startEmailWarmup: warmup.start,
      changeEmailWarmup: (session, workspace, operation, connectionRef) => warmup[operation](session, workspace, connectionRef),
    } : {}),
    retireWorkspace: createWorkspaceRetirement(),
    deleteOwnLogin,
    authenticate: createSupabaseAuthenticator(config.supabase),
    getWorkspace: getWorkspaceStatus,
    listMemberWorkspaces,
    startRun,
    getRunStatus: session => getRunStatus(session, config.dashboardOrigin),
    confirmRunReview: (session, runRef) => confirmRunReview(session, runRef, config.dashboardOrigin),
    researchOperation: (session, key, input) => executeResearchOperation(session, key, input, config.dashboardOrigin ?? DEFAULT_DASHBOARD_ORIGIN),
    getRunProgress: createRunProgressReader(),
    enqueueFirstRun: createFirstRunTrigger(config.trigger),
    acquisitionRecovery: createAcquisitionRecoveryOperations({enqueueVerification:createAcquisitionVerificationTrigger(config.trigger),enqueueFirstRun:createFirstRunTrigger(config.trigger)}),
    startCrmSyncRun,
    getCrmSyncStatus,
    enqueueCrmSync: createCrmSyncTrigger(config.trigger),
    disconnectIntegration,
    enqueueIntegrationRevocation: createIntegrationRevocationTrigger(config.trigger),
    getNotificationConfig,
    listSlackNotificationChannels,
    companyMapping: createCompanyMapping(config.crm ?? null),
    runCrmMapping: createCrmMapping(config.crm ? { ...config.crm, enqueue: createCrmMappingTrigger(config.trigger) } : null),
    upsertNotificationDestination,
    setNotificationRoute,
    // Test sends reach the notifications service's own Trigger project only.
    sendNotificationTest: (session, destinationRef) =>
      sendNotificationTest(session, destinationRef, notificationTest),
    startHubspotConnect: hubspot.startConnect,
    getHubspotConnection: hubspot.getConnection,
    completeHubspotCallback: hubspot.completeCallback,
    denyHubspotCallback: hubspot.denyCallback,
    buildHubspotAuthorizeUrl: (state) => buildAuthorizationUrl({
      clientId: config.hubspot.clientId,
      redirectUri: `${config.hubspot.publicBaseUrl}/hubspot/callback`,
      state,
    }),
    getAttioConnection,
    ...(attio && attioSettings ? {
      startAttioConnect: attio.startConnect,
      buildAttioAuthorizeUrl: (state: string) => buildAttioAuthorizationUrl({
        clientId: attioSettings.clientId, redirectUri: `${attioSettings.publicBaseUrl}/attio/callback`, state }),
    } : {}),
    createSlackConnectLink: slack?.createConnectLink ?? (async () => slackUnavailable()),
    startSlackConnect: slack?.startConnect ?? (async () => slackUnavailable()),
    getSlackConnection: slack?.getConnection ?? (async () => slackUnavailable()),
    denySlackCallback: slack?.denyCallback ?? (async () => slackUnavailable()),
    completeSlackCallback: slack?.completeCallback ?? (async () => {
      throw new SlackCallbackError(
        "server_misconfigured",
        503,
        "The Slack connection service is not configured.",
      );
    }),
    buildSlackAuthorizeUrl: slackSettings
      ? (state) => buildSlackAuthorizationUrl({
          clientId: slackSettings.clientId,
          redirectUri: `${slackSettings.publicBaseUrl}/slack/callback`,
          state,
        })
      : () => null,
    renderCliAuthPage: (state, port) => {
      const scriptNonce = randomBytes(18).toString("base64url");
      return {
        html: renderCliAuthPage({
          supabaseUrl: config.supabase.supabaseUrl,
          publishableKey: config.supabase.publishableKey,
          state,
          port,
          scriptNonce,
        }),
        scriptNonce,
        connectOrigin: new URL(config.supabase.supabaseUrl).origin,
      };
    },
    renderPasswordRecoveryPage: (page) => {
      const scriptNonce = randomBytes(18).toString("base64url");
      return {
        html: renderPasswordRecoveryPage({
          supabaseUrl: config.supabase.supabaseUrl,
          publishableKey: config.supabase.publishableKey,
          publicBaseUrl: config.hubspot.publicBaseUrl,
          scriptNonce, page,
        }),
        scriptNonce, connectOrigin: new URL(config.supabase.supabaseUrl).origin,
      };
    },
    checkReadiness: createSupabaseReadinessCheck(config.supabase),
    checkCompanyReadiness: createCompanyReadinessCheck(config.supabase, config.crm ?? null),
    checkCrmMappingReadiness: createCrmMappingReadinessCheck(config.supabase, config.crm ?? null),
  });
}

export function createDeploymentApp(
  environment: Record<string, string | undefined> = process.env,
) {
  return createProductionApp(loadConfig(environment));
}
