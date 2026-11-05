import { readFileSync } from "node:fs";

/** One authentic SQL receipt (LIF-1771). MANIFEST.json names the Functions head it came from. Never hand-edited. */
export const receipt = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/senders/${name}.json`, import.meta.url), "utf8"));
