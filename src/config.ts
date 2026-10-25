import { emailConnectSetup } from "./email-connect-setup.js";
import type { SupabaseEnv } from "@supabase/server";
import { parseHostedAuthOrigin } from "./hosted-auth-branding.js";

import type { SupabaseAuthenticationConfig } from "./supabase-auth.js";
import type { HubspotConnectSettings } from "./hubspot-connect.js";
import type { SlackConnectSettings } from "./slack-connect.js";
import type { AttioConnectSettings } from "./attio-connect.js";

import type { AccountConnectionSettings } from "./account-connection.js";
import type { MailiverySettings } from "./email-warmup.js";
import type { WarmupSetupSettings } from "./warmup-setup.js";
import type { McpSettings } from "./mcp.js";

/** Dashboard origin used for research links unless LIFTY_DASHBOARD_ORIGIN overrides it. */
export const DEFAULT_DASHBOARD_ORIGIN = "https://liftygtm.com";

type Environment = Record<string, string | undefined>;

export interface ServiceConfig {
  runtimeProfile?: "full" | "connections";
  publicBaseUrl: string;
  openAiAppsChallenge?: string;
  mcp?: McpSettings | null;
  crm?: { serverKey: string; readOnly: boolean } | null;
  dashboardOrigin?: string;
  host: string;
  port: number;
  supabase: SupabaseAuthenticationConfig;
  hubspot: Omit<HubspotConnectSettings, "fetchImpl"> | null;
  slack: Omit<SlackConnectSettings, "fetchImpl"> | null;
  /** LIFT's Attio OAuth app; Attio connection is unavailable without it. */
  attio?: Omit<AttioConnectSettings, "fetchImpl"> | null;
  /** Email server capability for the historical campaign and warmup RPCs; connections use `accounts`. */
  serverKeys?: { email: string | null };
  /** Sending-account connections (LIF-1182). Null keeps connect links closed; reads still work. */
  accounts?: Omit<AccountConnectionSettings, "fetchImpl"> | null;
  /** Mailivery warmup (LIF-989). Null keeps warmup start closed. */
  mailivery?: MailiverySettings | null;
  warmupSetup?: WarmupSetupSettings | null;
  trigger: {
    apiUrl: string;
    secretKey: string;
  } | null;
  /** The notifications service's own Trigger.dev project (test sends, LIF-1464). */
  notificationsTrigger: {
    apiUrl: string;
    secretKey: string;
  } | null;
}

const FORBIDDEN_SECRET_NAMES = [
  "SUPABASE_SECRET_KEY",
  "SUPABASE_SECRET_KEYS",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

function required(environment: Environment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost"
    || hostname === "[::1]"
    || /^127(?:\.[0-9]{1,3}){3}$/.test(hostname);
}

function secureUrl(value: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL.`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new Error(`${name} must use HTTPS, except on a loopback host.`);
  }
  return url;
}

function parseJwks(environment: Environment): Exclude<SupabaseEnv["jwks"], null> {
  const inline = environment.SUPABASE_JWKS?.trim();
  if (inline) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(inline);
    } catch {
      throw new Error("SUPABASE_JWKS must be valid JSON.");
    }
    const keys = Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" && parsed !== null && "keys" in parsed
        ? (parsed as { keys: unknown }).keys
        : null;
    if (!Array.isArray(keys) || keys.length === 0) {
      throw new Error("SUPABASE_JWKS must contain a non-empty keys array.");
    }
    return { keys } as Exclude<SupabaseEnv["jwks"], URL | null>;
  }

  return secureUrl(
    required(environment, "SUPABASE_JWKS_URL"),
    "SUPABASE_JWKS_URL",
  );
}

function parsePort(value: string | undefined): number {
  const port = value === undefined || value.trim() === "" ? 3000 : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  return port;
}

export function loadConfig(environment: Environment = process.env): ServiceConfig {
  const runtimeProfile = environment.LIFTY_RUNTIME_PROFILE?.trim() || "full";
  if (runtimeProfile !== "full" && runtimeProfile !== "connections") {
    throw new Error("LIFTY_RUNTIME_PROFILE must be full or connections.");
  }
  if (runtimeProfile === "connections") {
    // An isolated connection rehearsal has no job, CRM or warmup credentials.
    // Refuse accidental production configuration rather than merely ignoring it.
    for (const name of ["TRIGGER_SECRET_KEY", "NOTIFICATIONS_TRIGGER_SECRET_KEY", "HUBSPOT_CLIENT_ID",
      "HUBSPOT_CLIENT_SECRET", "SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "ATTIO_CLIENT_ID", "ATTIO_CLIENT_SECRET",
      "MAILIVERY_API_KEY", "LIFTY_CRM_SERVER_KEY", "LIFTY_LINKEDIN_SERVER_KEY", "UNIPILE_DSN", "UNIPILE_ACCESS_TOKEN",
      "LIFTY_WARMUP_GOOGLE_CLIENT_ID", "LIFTY_WARMUP_GOOGLE_CLIENT_SECRET"]) {
      if (environment[name]?.trim()) throw new Error(`${name} is unavailable in the connections profile.`);
    }
    if (environment.LIFTY_WARMUP_SETUP_ENABLED === "true" || environment.LIFTY_MCP_ENABLED === "true") {
      throw new Error("Warmup and MCP are unavailable in the connections profile.");
    }
  }
  for (const name of FORBIDDEN_SECRET_NAMES) {
    if (environment[name]?.trim()) {
      throw new Error(
        "Secret Supabase credentials are forbidden in the LIFTY control plane.",
      );
    }
  }

  const supabaseUrl = secureUrl(
    required(environment, "SUPABASE_URL"),
    "SUPABASE_URL",
  );
  const publishableKey = required(environment, "SUPABASE_PUBLISHABLE_KEY");
  const publicBaseUrl = secureUrl(
    required(environment, "PUBLIC_BASE_URL"),
    "PUBLIC_BASE_URL",
  );
  const mcpEnabled = environment.LIFTY_MCP_ENABLED === "true";
  const openAiAppsChallenge = environment.LIFTY_OPENAI_APPS_CHALLENGE;
  if (openAiAppsChallenge !== undefined && !/^[\x21-\x7e]{1,4096}$/.test(openAiAppsChallenge)) {
    throw new Error("LIFTY_OPENAI_APPS_CHALLENGE must be the single exact printable verification token.");
  }
  if (environment.LIFTY_MCP_ENABLED && !["true", "false"].includes(environment.LIFTY_MCP_ENABLED)) {
    throw new Error("LIFTY_MCP_ENABLED must be true or false.");
  }
  let mcp: McpSettings | null = null;
  if (mcpEnabled) {
    if (publicBaseUrl.protocol !== "https:" || publicBaseUrl.username || publicBaseUrl.password
      || publicBaseUrl.pathname !== "/" || publicBaseUrl.search || publicBaseUrl.hash) {
      throw new Error("MCP requires PUBLIC_BASE_URL to be an HTTPS origin.");
    }
    const allowedOrigins = [publicBaseUrl.origin, ...(environment.LIFTY_MCP_ALLOWED_ORIGINS?.split(",") ?? [])]
      .map(value => {
        const url = secureUrl(value.trim(), "LIFTY_MCP_ALLOWED_ORIGINS");
        if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
          throw new Error("LIFTY_MCP_ALLOWED_ORIGINS must contain HTTPS origins.");
        }
        return url.origin;
      });
    mcp = { resourceUrl: new URL("/mcp", publicBaseUrl).href,
      authorizationServer: new URL("/auth/v1", supabaseUrl).href, allowedOrigins: [...new Set(allowedOrigins)] };
  }
  const warmupBaseUrl = environment.LIFTY_WARMUP_PUBLIC_BASE_URL?.trim()
    ? secureUrl(environment.LIFTY_WARMUP_PUBLIC_BASE_URL.trim(), "LIFTY_WARMUP_PUBLIC_BASE_URL")
    : publicBaseUrl;
  const dashboardUrl = secureUrl(environment.LIFTY_DASHBOARD_ORIGIN?.trim() || DEFAULT_DASHBOARD_ORIGIN, "LIFTY_DASHBOARD_ORIGIN");
  if (dashboardUrl.protocol !== "https:" || dashboardUrl.username || dashboardUrl.password || dashboardUrl.port || dashboardUrl.pathname !== "/" || dashboardUrl.search || dashboardUrl.hash) {
    throw new Error("LIFTY_DASHBOARD_ORIGIN must be an HTTPS origin without credentials, port or path.");
  }
  const slackClientId = environment.SLACK_CLIENT_ID?.trim();
  const slackClientSecret = environment.SLACK_CLIENT_SECRET?.trim();
  const attioClientId = environment.ATTIO_CLIENT_ID?.trim();
  const attioClientSecret = environment.ATTIO_CLIENT_SECRET?.trim();
  if (Boolean(attioClientId) !== Boolean(attioClientSecret)) throw new Error("Attio connection requires both ATTIO_CLIENT_ID and ATTIO_CLIENT_SECRET.");

  // Earlier accounts retain access removal and authenticated warmup identity.
  const v1Values = [environment.UNIPILE_DSN?.trim(), environment.UNIPILE_ACCESS_TOKEN?.trim()];
  if (v1Values.some(Boolean) && !v1Values.every(Boolean)) throw new Error("Unipile access removal requires both UNIPILE_DSN and UNIPILE_ACCESS_TOKEN.");
  const providerNamespace=environment.UNIPILE_PROVIDER_NAMESPACE?.trim();
  const v1 = v1Values.every(Boolean) ? { dsn: v1Values[0]!, accessToken: v1Values[1]!,
    ...(providerNamespace?{providerNamespace}:{}) } : null;
  const v2Token=environment.UNIPILE_V2_ACCESS_TOKEN?.trim(), v2Application=environment.UNIPILE_V2_APPLICATION_ID?.trim();
  const v2Origins=environment.UNIPILE_V2_HOSTED_AUTH_ORIGINS?.trim();
  if(Boolean(v2Token)!==Boolean(v2Application) || (v2Origins && !v2Token))throw new Error("Unipile V2 requires UNIPILE_V2_ACCESS_TOKEN and UNIPILE_V2_APPLICATION_ID.");
  if(v2Application && !/^app_[A-Za-z0-9_-]+$/.test(v2Application))throw new Error("Invalid UNIPILE_V2_APPLICATION_ID.");
  const v2=v2Token && v2Application ? {accessToken:v2Token,applicationId:v2Application,
    hostedAuthOrigins:[...new Set((v2Origins ? v2Origins.split(",") : []).map(value=>parseHostedAuthOrigin(value)))]} : undefined;
  // People sign in on Lifty's own hosted page; the provider's default pages are never offered.
  if(v2 && (!v2.hostedAuthOrigins.length || v2.hostedAuthOrigins.some(origin => ["https://auth.unipile.com", "https://account.unipile.com"].includes(origin))))
    throw new Error("UNIPILE_V2_HOSTED_AUTH_ORIGINS must list Lifty's hosted sign-in origins only.");
  const crmKey = environment.LIFTY_CRM_SERVER_KEY?.trim();
  if (crmKey && (crmKey.length < 32 || crmKey.length > 256)) throw new Error("LIFTY_CRM_SERVER_KEY must contain 32 to 256 characters.");
  const emailKey = environment.LIFTY_EMAIL_SERVER_KEY?.trim();
  const linkedinKey = environment.LIFTY_LINKEDIN_SERVER_KEY?.trim();
  const emailEnabled = Boolean(emailKey);
  const linkedinEnabled = Boolean(linkedinKey);
  if((v2 || v1) && !emailEnabled && !linkedinEnabled)throw new Error("Unipile requires a dedicated email or LinkedIn service key.");
  if (emailKey && emailKey.length < 32) throw new Error("LIFTY_EMAIL_SERVER_KEY must contain at least 32 characters.");
  if (linkedinKey && linkedinKey.length < 32) throw new Error("LIFTY_LINKEDIN_SERVER_KEY must contain at least 32 characters.");
  if (linkedinKey && linkedinKey === emailKey) throw new Error("LinkedIn requires a server key distinct from email.");
  const mailiveryKey = environment.MAILIVERY_API_KEY?.trim();
  if (mailiveryKey && (mailiveryKey.length < 16 || mailiveryKey.length > 512 || /\s/.test(mailiveryKey))) throw new Error("MAILIVERY_API_KEY must be a single token of 16 to 512 characters.");
  if (mailiveryKey && [emailKey, linkedinKey, crmKey, publishableKey].includes(mailiveryKey)) throw new Error("MAILIVERY_API_KEY must be distinct from LIFTY service keys.");
  const setupEnabled = environment.LIFTY_WARMUP_SETUP_ENABLED === "true";
  const googleClientId = environment.LIFTY_WARMUP_GOOGLE_CLIENT_ID?.trim();
  const googleClientSecret = environment.LIFTY_WARMUP_GOOGLE_CLIENT_SECRET?.trim();
  if (environment.LIFTY_WARMUP_SETUP_ENABLED && !["true", "false"].includes(environment.LIFTY_WARMUP_SETUP_ENABLED)) throw new Error("LIFTY_WARMUP_SETUP_ENABLED must be true or false.");
  if (setupEnabled && (!emailKey || !mailiveryKey || !googleClientId || !googleClientSecret)) {
    throw new Error("Google warmup setup requires email and Mailivery keys and both Google client credentials.");
  }
  if (setupEnabled && (warmupBaseUrl.username || warmupBaseUrl.password || warmupBaseUrl.port || warmupBaseUrl.search || warmupBaseUrl.hash || warmupBaseUrl.pathname !== "/")) {
    throw new Error("Google warmup setup public base URL must be an HTTPS origin without credentials, port, path, query or fragment.");
  }
  if (crmKey && [emailKey, linkedinKey, publishableKey, environment.HUBSPOT_CLIENT_SECRET, attioClientSecret, environment.TRIGGER_SECRET_KEY].includes(crmKey)) throw new Error("CRM requires a distinct dedicated server key.");
  // Notifications is its own Trigger.dev project; the Jobs key must never reach it.
  const triggerKey = runtimeProfile === "full" ? required(environment, "TRIGGER_SECRET_KEY") : null;
  const notificationsTriggerKey = runtimeProfile === "full" ? required(environment, "NOTIFICATIONS_TRIGGER_SECRET_KEY") : null;
  if (triggerKey && notificationsTriggerKey === triggerKey) throw new Error("NOTIFICATIONS_TRIGGER_SECRET_KEY must be distinct from TRIGGER_SECRET_KEY.");
  return {
    runtimeProfile,
    publicBaseUrl: publicBaseUrl.toString().replace(/\/$/, ""),
    mcp,
    ...(openAiAppsChallenge === undefined ? {} : { openAiAppsChallenge }),
    crm: crmKey ? { serverKey: crmKey, readOnly: [environment.DASHBOARD_READ_ONLY_MODE, environment.CONSUMER_READ_ONLY_MODE].some(value => value === "1" || value?.toLowerCase() === "true") } : null,
    dashboardOrigin: dashboardUrl.origin,
    mailivery: mailiveryKey ? { apiKey: mailiveryKey } : null,
    warmupSetup: setupEnabled && emailKey && mailiveryKey && googleClientId && googleClientSecret ? {
      serverKey:emailKey, publicBaseUrl:warmupBaseUrl.origin, supabaseUrl:supabaseUrl.toString().replace(/\/$/, ""), publishableKey,
      googleClientId, googleClientSecret, mailivery:{apiKey:mailiveryKey},
    } : null,
    serverKeys: { email: emailKey || null },
    accounts: v2 && (emailKey || linkedinKey) ? {
      connectionOnly: runtimeProfile === "connections",
      emailSetup: emailConnectSetup(runtimeProfile, v2.applicationId),
      dashboardOrigin: dashboardUrl.origin,
      publicBaseUrl: publicBaseUrl.toString().replace(/\/$/, ""),
      supabaseUrl: supabaseUrl.toString().replace(/\/$/, ""), publishableKey,
      serverKeys: { ...(emailKey ? { email: emailKey } : {}), ...(linkedinKey ? { linkedin: linkedinKey } : {}) },
      provider: { v2, v1 },
    } : null,
    host: environment.HOST?.trim() || "0.0.0.0",
    port: parsePort(environment.PORT),
    supabase: {
      supabaseUrl: supabaseUrl.toString().replace(/\/$/, ""),
      publishableKey,
      jwks: parseJwks(environment),
    },
    hubspot: runtimeProfile === "full" ? {
      clientId: required(environment, "HUBSPOT_CLIENT_ID"),
      clientSecret: required(environment, "HUBSPOT_CLIENT_SECRET"),
      publicBaseUrl: publicBaseUrl.toString().replace(/\/$/, ""),
      supabaseUrl: supabaseUrl.toString().replace(/\/$/, ""),
      publishableKey,
    } : null,
    attio: attioClientId && attioClientSecret
      ? {
          clientId: attioClientId,
          clientSecret: attioClientSecret,
          publicBaseUrl: publicBaseUrl.toString().replace(/\/$/, ""),
          supabaseUrl: supabaseUrl.toString().replace(/\/$/, ""),
          publishableKey,
        }
      : null,
    slack: slackClientId && slackClientSecret
      ? {
          clientId: slackClientId,
          clientSecret: slackClientSecret,
          publicBaseUrl: publicBaseUrl.toString().replace(/\/$/, ""),
          supabaseUrl: supabaseUrl.toString().replace(/\/$/, ""),
          publishableKey,
        }
      : null,
    trigger: triggerKey ? {
      apiUrl: secureUrl(
        environment.TRIGGER_API_URL?.trim() || "https://api.trigger.dev",
        "TRIGGER_API_URL",
      )
        .toString()
        .replace(/\/$/, ""),
      secretKey: triggerKey,
    } : null,
    notificationsTrigger: notificationsTriggerKey ? {
      apiUrl: secureUrl(
        environment.NOTIFICATIONS_TRIGGER_API_URL?.trim() || "https://api.trigger.dev",
        "NOTIFICATIONS_TRIGGER_API_URL",
      )
        .toString()
        .replace(/\/$/, ""),
      secretKey: notificationsTriggerKey,
    } : null,
  };
}
