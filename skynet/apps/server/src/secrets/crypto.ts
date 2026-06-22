// ─── Secret crypto (envelope, AES-256-GCM) ────────────────────────────────
// App-level encryption at rest for provider API keys. Each secret is sealed
// under a single master key (SKYNET_MASTER_KEY, 32 bytes base64) with a fresh
// random IV and an authentication tag — so ciphertext is tamper-evident and
// two stores of the same key differ. The master key never touches the database;
// rotating it re-keys everything (out of scope here). This is deliberately
// pluggable: a KMS/Vault backend can replace the master-key source without
// changing callers.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12; // 96-bit nonce, standard for GCM
const KEY_LEN = 32; // 256-bit key

let cached: Buffer | null | undefined;

/** The master key, or null when unconfigured (secrets feature disabled). */
export function masterKey(): Buffer | null {
  if (cached !== undefined) return cached;
  const raw = process.env.SKYNET_MASTER_KEY;
  if (!raw) return (cached = null);
  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    throw new Error("SKYNET_MASTER_KEY is not valid base64");
  }
  if (key.length !== KEY_LEN) {
    throw new Error(`SKYNET_MASTER_KEY must decode to ${KEY_LEN} bytes (got ${key.length})`);
  }
  return (cached = key);
}

/** Seal plaintext → base64(iv | tag | ciphertext). */
export function seal(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

/** Open base64(iv | tag | ciphertext) → plaintext. Throws on tamper/wrong key. */
export function open(blob: string, key: Buffer): string {
  const buf = Buffer.from(blob, "base64");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + 16);
  const ct = buf.subarray(IV_LEN + 16);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** Last 4 chars of a key, for recognition in the UI (never the whole key). */
export function fingerprint(plaintext: string): string {
  return plaintext.length <= 4 ? "•".repeat(plaintext.length) : plaintext.slice(-4);
}

/** Test seam: reset the cached master key (after changing the env in a test). */
export function resetMasterKeyCache(): void {
  cached = undefined;
}
