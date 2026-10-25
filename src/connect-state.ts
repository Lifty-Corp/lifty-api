import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// Opaque browser handle for one durable connection attempt. It reveals no id,
// is bound to its channel (a handle opened under the other channel's page
// fails) and is keyed by that channel's existing server key.
export type ConnectChannel = "email" | "linkedin";
export type EmailProvider = "google" | "outlook";
const pattern = /^(v1|v2)\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,23}\.[A-Za-z0-9_-]{22}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const key = (secret: string) => createHash("sha256").update("lifty:connect:key:v1\0").update(secret).digest();
const aad = (channel: ConnectChannel, version: string) => Buffer.from(`lifty:connect:${channel}:${version}`);

export function sealConnectAttempt(channel: ConnectChannel, attemptId: string, secret: string, provider?: EmailProvider): string {
  if (provider && (channel !== "email" || !["google", "outlook"].includes(provider))) throw new Error("Invalid email provider.");
  const version = provider ? "v2" : "v1";
  if (!uuid.test(attemptId)) throw new Error("Invalid connection attempt.");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(secret), nonce); cipher.setAAD(aad(channel, version));
  const payload = Buffer.concat([Buffer.from(attemptId.replaceAll("-", ""), "hex"), ...(provider ? [Buffer.from([provider === "google" ? 1 : 2])] : [])]);
  const data = Buffer.concat([cipher.update(payload), cipher.final()]);
  return [version, nonce.toString("base64url"), data.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
}

function openConnectSelection(channel: ConnectChannel, state: string, secret: string): { attemptId: string; provider?: EmailProvider } {
  try {
    if (!pattern.test(state)) throw new Error();
    const [version, iv, body, tag] = state.split(".");
    const decipher = createDecipheriv("aes-256-gcm", key(secret), Buffer.from(iv!, "base64url"));
    decipher.setAAD(aad(channel, version!)); decipher.setAuthTag(Buffer.from(tag!, "base64url"));
    const bytes = Buffer.concat([decipher.update(Buffer.from(body!, "base64url")), decipher.final()]);
    if (version === "v1" ? bytes.length !== 16 : channel !== "email" || bytes.length !== 17 || ![1, 2].includes(bytes[16]!)) throw new Error();
    const plain = bytes.subarray(0, 16).toString("hex");
    return { attemptId: `${plain.slice(0, 8)}-${plain.slice(8, 12)}-${plain.slice(12, 16)}-${plain.slice(16, 20)}-${plain.slice(20)}`,
      ...(version === "v2" ? { provider: bytes[16] === 1 ? "google" : "outlook" } : {}) };
  } catch { throw new Error("Invalid connection attempt."); }
}

export function openConnectAttempt(channel: ConnectChannel, state: string, secret: string): string {
  return openConnectSelection(channel, state, secret).attemptId;
}

/** The provider is a signed browser choice, not account identity or authorization. */
export function openConnectProvider(channel: ConnectChannel, state: string, secret: string): EmailProvider | undefined {
  return openConnectSelection(channel, state, secret).provider;
}
