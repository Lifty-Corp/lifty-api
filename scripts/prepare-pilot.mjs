// Prepare a private App Platform spec. This command never creates or updates an app.
import { readFile, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, relative, isAbsolute } from "node:path";
import { parseArgs } from "node:util";

const pins = {
  LIFTY_RUNTIME_PROFILE: "connections",
  SUPABASE_URL: "https://csyhcwpcojbjlwwxdmhc.supabase.co",
  SUPABASE_JWKS_URL: "https://csyhcwpcojbjlwwxdmhc.supabase.co/auth/v1/.well-known/jwks.json",
  PUBLIC_BASE_URL: "https://api.pilot.liftygtm.com",
  LIFTY_DASHBOARD_ORIGIN: "https://pilot.liftygtm.com",
  UNIPILE_V2_APPLICATION_ID: "app_01m5fr5mgdfzx8ftceq7y7z0h4",
  UNIPILE_V2_HOSTED_AUTH_ORIGINS: "https://auth.pilot.liftygtm.com",
};
const credentials = ["SUPABASE_PUBLISHABLE_KEY", "LIFTY_EMAIL_SERVER_KEY", "UNIPILE_V2_ACCESS_TOKEN"];

export function pilotEnvironment(environment) {
  for (const [name, expected] of Object.entries(pins)) {
    if (environment[name] && environment[name] !== expected) throw new Error(`${name} does not match the isolated pilot.`);
  }
  for (const name of credentials) {
    if (!environment[name]?.trim()) throw new Error(`${name} is required.`);
  }
  if (!environment.SUPABASE_PUBLISHABLE_KEY.startsWith("sb_publishable_")) throw new Error("Use staging's publishable key.");
  const allowed = new Set([...Object.keys(pins), ...credentials]);
  // Runtime config rejects unrelated credentials. Do not silently discard them
  // here and allow the review artifact to hide a mixed environment.
  for (const [name, value] of Object.entries(environment)) {
    if (value && !allowed.has(name) && /^(SUPABASE_|UNIPILE_|MAILIVERY_|HUBSPOT_|SLACK_|ATTIO_|TRIGGER_|NOTIFICATIONS_TRIGGER_|LIFTY_.*(?:KEY|SECRET|ENABLED)$)/.test(name)) {
      throw new Error(`${name} is not a pilot setting.`);
    }
  }
  return { ...pins, ...Object.fromEntries(credentials.map(name => [name, environment[name].trim()])) };
}

async function secretFile(path) {
  const info = await stat(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error("Credential files must be private regular files.");
  return (await readFile(path, "utf8")).trim();
}

async function main() {
  const { values } = parseArgs({ options: {
    output: { type: "string" }, "unipile-key-file": { type: "string" }, "email-key-file": { type: "string" },
  } });
  if (!values.output) throw new Error("--output is required; use a private path outside the checkout.");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const output = resolve(values.output), inside = relative(root, output);
  if (!inside.startsWith("..") && !isAbsolute(inside)) throw new Error("The private spec must be outside the checkout.");
  const environment = { ...process.env };
  if (values["unipile-key-file"]) environment.UNIPILE_V2_ACCESS_TOKEN = await secretFile(values["unipile-key-file"]);
  if (values["email-key-file"]) environment.LIFTY_EMAIL_SERVER_KEY = await secretFile(values["email-key-file"]);
  const config = pilotEnvironment(environment);
  const { loadConfig } = await import("../dist/config.js");
  loadConfig(config);
  const spec = JSON.parse(await readFile(new URL("../.do/pilot-app.json", import.meta.url), "utf8"));
  spec.services[0].envs = Object.entries(config).map(([key, value]) => ({
    key, value, scope: "RUN_TIME", type: key === "LIFTY_EMAIL_SERVER_KEY" || key === "UNIPILE_V2_ACCESS_TOKEN" ? "SECRET" : "GENERAL",
  }));
  await writeFile(output, JSON.stringify(spec, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  process.stdout.write("Prepared lifty-api-pilot for the staging database and pilot Unipile application. No resource was created.\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { process.stderr.write("Pilot spec preparation failed. Check the target pins, required settings, private key files and output path.\n"); process.exitCode = 1; });
}
