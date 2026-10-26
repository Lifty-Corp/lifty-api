import { serve } from "@hono/node-server";

import { createAccountConnection, startConnectionRecovery } from "./account-connection.js";
import type { ServiceConfig } from "./config.js";
import { createProductionApp } from "./service.js";
import { startWritingRulesRefresh } from "./writing-rules.js";

interface ServeOptions {
  fetch(request: Request, environment?: unknown): Promise<unknown> | unknown;
  hostname: string;
  port: number;
}

type ServeImplementation<Server> = (options: ServeOptions) => Server;

export function startService(config: ServiceConfig): ReturnType<typeof serve>;
export function startService<Server>(
  config: ServiceConfig,
  serveImplementation: ServeImplementation<Server>,
): Server;
export function startService<Server>(
  config: ServiceConfig,
  serveImplementation?: ServeImplementation<Server>,
): Server {
  const app = createProductionApp(config);
  startWritingRulesRefresh(config.supabase);
  // LIF-1629: received authorizations finish here even with every page closed.
  if (config.accounts) {
    startConnectionRecovery(createAccountConnection(config.accounts), event =>
      process.stderr.write(`${JSON.stringify({ level: event.outcome === "connected" ? "info" : "warn", ...event })}\n`));
  }
  const start = (serveImplementation ?? serve) as ServeImplementation<Server>;
  return start({
    fetch: app.fetch,
    hostname: config.host,
    port: config.port,
  });
}
