export interface EmailSetup {
  google?: { url: string; clientId: string };
  outlook?: { url: string };
}

// Public app identity from the isolated LIF-1594 Trusted pilot. It must never
// be offered for another Unipile app or the production runtime.
export function emailConnectSetup(profile: "full" | "connections", applicationId: string): EmailSetup {
  if (profile !== "connections" || applicationId !== "app_01m5fr5mgdfzx8ftceq7y7z0h4") return {};
  return { google: {
    url: "https://admin.google.com/ac/owl",
    clientId: "755267746293-dtk3bl2tpfdcrtoc18t2j7mq6e5mvjir.apps.googleusercontent.com",
  } };
}

