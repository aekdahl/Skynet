// ─── Compliance evidence pack — signing ────────────────────────────────────
// Cryptographically signs an exported compliance report so an auditor can
// prove it wasn't altered after export. Deliberately the simplest credible
// mechanism for a local, single-operator desktop app — NOT a PKI:
//
//  - One Ed25519 keypair per installation, generated on first use and kept in
//    a plain file next to the data store (mode 0600). Node's built-in `crypto`
//    only — no new dependency, no native module, matching the file-store's
//    own "zero-dependency" philosophy.
//  - The private key never leaves this file / this host — only the PUBLIC key
//    is embedded in an exported report, so a verifier can check the
//    signature completely offline (no server round-trip, no shared secret).
//  - This proves the exported DOCUMENT is unaltered and was signed by
//    whoever holds this install's private key (trust-on-first-use by
//    default). It does NOT hash-chain the live audit trail itself — that
//    would be a bigger, separate feature (continuous tamper-evidence of the
//    store), out of scope for a one-click export. `signingKeyFingerprint()`
//    below lets an operator publish a fingerprint out-of-band for stronger
//    assurance than TOFU, if they want it.
//
// A real PKI (CA-issued certs, revocation, HSM-backed keys) is exactly the
// over-engineering the brief warned against for a v1 local desktop feature —
// this can be layered on later without changing the report SHAPE, only how
// the key is obtained.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  KeyObject,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ComplianceReport, SignedComplianceReport } from "@skynet/shared";
import { config } from "../config.js";

interface StoredKeypair {
  publicKey: string; // base64 SPKI (DER)
  privateKey: string; // base64 PKCS8 (DER)
}

function defaultKeyPath(): string {
  // Same directory as the data file — consistent with the file-store's own
  // "just a file next to the data" convention, no new directory invented.
  const dbDir = dirname(config.dbPath || "skynet-data.json");
  return join(dbDir, ".skynet-compliance-key.json");
}

function keyPath(): string {
  const configured = config.complianceKeyPath;
  if (!configured) return resolve(defaultKeyPath());
  return isAbsolute(configured) ? configured : resolve(configured);
}

let cached: { publicKey: KeyObject; privateKey: KeyObject; publicKeyB64: string } | undefined;

/** Load this installation's signing keypair, generating + persisting one on
 *  first use. Cached in-process after the first call. */
export function getSigningKeypair(): { publicKey: KeyObject; privateKey: KeyObject; publicKeyB64: string } {
  if (cached) return cached;
  const path = keyPath();
  if (existsSync(path)) {
    const stored = JSON.parse(readFileSync(path, "utf8")) as StoredKeypair;
    const publicKey = createPublicKeyFromDer(Buffer.from(stored.publicKey, "base64"));
    const privateKey = createPrivateKeyFromDer(Buffer.from(stored.privateKey, "base64"));
    cached = { publicKey, privateKey, publicKeyB64: stored.publicKey };
    return cached;
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const privateKeyB64 = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ publicKey: publicKeyB64, privateKey: privateKeyB64 } satisfies StoredKeypair), {
    mode: 0o600,
  });
  cached = { publicKey, privateKey, publicKeyB64 };
  return cached;
}

function createPublicKeyFromDer(der: Buffer): KeyObject {
  return createPublicKey({ key: der, format: "der", type: "spki" });
}
function createPrivateKeyFromDer(der: Buffer): KeyObject {
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

/** A short, publishable fingerprint of this install's public key (sha256,
 *  first 16 hex chars) — an operator can post this somewhere out-of-band
 *  (their own site, a README) so a verifier has something stronger than
 *  trust-on-first-use to check an exported report's embedded key against. */
export function signingKeyFingerprint(): string {
  const { publicKeyB64 } = getSigningKeypair();
  return createHash("sha256").update(Buffer.from(publicKeyB64, "base64")).digest("hex").slice(0, 16);
}

/** Deterministic JSON stringify: object keys sorted recursively so the same
 *  logical content always hashes the same way regardless of construction
 *  order. Arrays keep their (semantically meaningful) order as-is. */
export function canonicalJson(value: unknown): string {
  const sorted = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sorted);
    if (v && typeof v === "object") {
      const obj = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(obj).sort()) out[k] = sorted(obj[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sorted(value));
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Sign an unsigned report: hash its canonical JSON, sign the hash, and embed
 *  everything a verifier needs (hash, signature, public key) into the result. */
export function signComplianceReport(report: ComplianceReport): SignedComplianceReport {
  const { privateKey, publicKeyB64 } = getSigningKeypair();
  const contentHash = sha256Hex(canonicalJson(report));
  const signature = cryptoSign(null, Buffer.from(contentHash, "utf8"), privateKey).toString("base64");
  return { report, contentHash, algorithm: "ed25519", signature, publicKey: publicKeyB64 };
}

/** Verify a signed report is self-consistent: the embedded content hash
 *  actually matches the report content, AND the signature actually validates
 *  against the embedded public key. Both must hold for `valid: true` — either
 *  one failing means the document was altered (or never validly signed) after
 *  export. Uses ONLY the document itself — no server/store access. */
export function verifyComplianceReport(signed: SignedComplianceReport): { valid: boolean; reason?: string } {
  const recomputedHash = sha256Hex(canonicalJson(signed.report));
  if (recomputedHash !== signed.contentHash) {
    return { valid: false, reason: "content hash mismatch — the report content was altered after signing" };
  }
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKeyFromDer(Buffer.from(signed.publicKey, "base64"));
  } catch {
    return { valid: false, reason: "embedded public key is malformed" };
  }
  const ok = cryptoVerify(null, Buffer.from(signed.contentHash, "utf8"), publicKey, Buffer.from(signed.signature, "base64"));
  if (!ok) return { valid: false, reason: "signature does not match — the content hash or signature was altered" };
  return { valid: true };
}
