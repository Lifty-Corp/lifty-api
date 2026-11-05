import { readFileSync } from "node:fs";

/** One authentic SQL receipt from the Functions CI artifact (LIF-1771). Never hand-edited. */
export const receipt = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/senders/${name}.json`, import.meta.url), "utf8"));
