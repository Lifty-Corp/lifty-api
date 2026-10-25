/** The connection pilot uses the real handlers with every sending/job entry closed. */
export function connectionProfileAllows(method: string, path: string): boolean {
  if (method === "GET" && ["/healthz", "/readyz", "/openapi.json", "/favicon.ico",
    "/brand/lifty-orbit-icon.png", "/cli/auth", "/auth/password-reset", "/auth/password-update"].includes(path)) return true;
  if (method === "GET" && path.startsWith("/v1/context/")) return true;
  if (["GET", "POST"].includes(method) && /^\/connect\/(?:email|linkedin)(?:\/|$)/.test(path)) return true;
  if (method === "GET" && ["/v1/me/workspaces", "/v1/workspace", "/v1/workspace/summary", "/v1/workspace/next-step",
    "/v1/workspace/senders", "/v1/workspace/sending-accounts"].includes(path)) return true;
  if (["GET", "POST"].includes(method) && path === "/v1/workspace/business") return true;
  if (method === "POST" && ["/v1/workspace/senders", "/v1/workspace/sending-accounts/connect"].includes(path)) return true;
  return method === "GET" && /^\/v1\/workspace\/sending-accounts\/attempts\/[^/]+$/.test(path);
}
