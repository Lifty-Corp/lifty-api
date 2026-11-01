import { loadConfig } from "./config.js";
import { shutdownAnalytics } from "./service.js";
import { startService } from "./start-server.js";

const config = loadConfig();
const server = startService(config);

process.stdout.write(`${JSON.stringify({
  event: "lifty_api_started",
  host: config.host,
  port: config.port,
})}\n`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    // Flush queued analytics once; a stuck sink cannot hold the process (bounded inside).
    server.close(() => { void shutdownAnalytics().finally(() => process.exit(0)); });
  });
}
