export interface EmailSetup {
  google?: { url: string; clientId: string };
  outlook?: { url: string };
}

// Lifty has one Google OAuth client per runtime: Unipile's hosted Google
// sign-in and warmup both use it, so admins mark that client Trusted once.
// The ID comes from LIFTY_WARMUP_GOOGLE_CLIENT_ID and must be the Google client
// configured in this runtime's Unipile application. The URL opens Manage app
// access, where the admin chooses Configure new app.
export function emailConnectSetup(googleClientId: string | undefined): EmailSetup {
  if (!googleClientId) return {};
  return { google: { url: "https://admin.google.com/ac/owl/list?tab=configuredApps", clientId: googleClientId } };
}
