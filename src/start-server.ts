import { serve } from "@hono/node-server";

import { createAccountConnection, startConnectionRecovery } from "./account-connection.js";
import type { ServiceConfig } from "./config.js";
import { createProductionApp } from "./service.js";

export function startService(config: ServiceConfig): ReturnType<typeof serve> {
  const app = createProductionApp(config);
  // LIF-1629: received authorizations finish here even with every page closed.
  if (config.accounts) {
    startConnectionRecovery(createAccountConnection(config.accounts), event =>
      process.stderr.write(`${JSON.stringify({ level: event.outcome === "connected" ? "info" : "warn", ...event })}\n`));
  }
  return serve({
    fetch: app.fetch,
    hostname: config.host,
    port: config.port,
  });
}
