// ─── MFA: Telegram OTP + recovery codes ─────────────────────────────────────
// Second factor for the public login (public_ui deploy): after a correct
// password we send a one-time code to the owner's Telegram and require it before
// issuing a session. Two ways to never get locked out: recovery codes (generated
// once, retrieved over SSH) and a break-glass env flag (SKYNET_MFA_DISABLE).
// Single-node: in-memory challenges + a small 0600 file for the hashed recovery
// codes next to the file store. Off unless SKYNET_MFA=true.

import { randomBytes, randomInt, createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Principal } from "../auth.js";
import { config, now } from "../config.js";

const CODE_TTL_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;
const RECOVERY_COUNT = 10;

function sha256hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// Constant-time compare of two short strings (hash first so lengths always match).
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * MFA is active for a login when EITHER the server-wide env flag
 * (`SKYNET_MFA=true`, an infra-level override for a hosted deploy that wants
 * it non-negotiable) OR the logging-in operator's own workspace has the live
 * Settings toggle on (`WorkspaceSettings.requireLoginVerification` — the
 * day-to-day control, flippable with no restart) — but NEVER while the SSH
 * break-glass (`SKYNET_MFA_DISABLE`) is set, which always wins over both.
 * `workspaceRequiresIt` defaults false so every existing call site (and every
 * test) that doesn't pass it keeps today's env-var-only behavior unchanged.
 */
export function mfaEnabled(workspaceRequiresIt = false): boolean {
  return (config.mfa || workspaceRequiresIt) && !config.mfaBreakGlass;
}

interface Challenge {
  principal: Principal;
  code: string;
  expiresAt: number;
  attempts: number;
}

const challenges = new Map<string, Challenge>();

/** Issue a login challenge (after a correct password). Returns the id + the OTP
 *  to deliver out-of-band (Telegram). The code never leaves the server otherwise. */
export function createChallenge(principal: Principal): { challengeId: string; code: string } {
  const challengeId = randomBytes(18).toString("base64url");
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  challenges.set(challengeId, { principal, code, expiresAt: now() + CODE_TTL_MS, attempts: 0 });
  return { challengeId, code };
}

/** Verify an OTP or a recovery code for a challenge; returns the Principal on
 *  success (and consumes the challenge). Bounded attempts + TTL. */
export function verifyChallenge(challengeId: string, code: string): Principal | undefined {
  const ch = challenges.get(challengeId);
  if (!ch) return undefined;
  if (now() > ch.expiresAt || ch.attempts >= MAX_ATTEMPTS) {
    challenges.delete(challengeId);
    return undefined;
  }
  ch.attempts += 1;
  const entered = code.trim();
  if (safeEqual(entered, ch.code) || consumeRecoveryCode(entered)) {
    challenges.delete(challengeId);
    return ch.principal;
  }
  return undefined;
}

// ── Recovery codes (on-disk, hashed) ─────────────────────────────────────────
function recoveryDir(): string {
  return dirname(config.dbPath && config.dbPath.length > 0 ? config.dbPath : "./skynet-data.json");
}
const recoveryHashFile = () => join(recoveryDir(), "mfa-recovery.json");
const recoveryPlaintextFile = () => join(recoveryDir(), "mfa-recovery-codes.txt");

let recoveryHashes: string[] | null = null;

function loadRecovery(): string[] {
  if (recoveryHashes) return recoveryHashes;
  try {
    if (existsSync(recoveryHashFile())) {
      recoveryHashes = JSON.parse(readFileSync(recoveryHashFile(), "utf8")) as string[];
      return recoveryHashes;
    }
  } catch {
    /* fall through to empty */
  }
  recoveryHashes = [];
  return recoveryHashes;
}

function saveRecovery(): void {
  try {
    writeFileSync(recoveryHashFile(), JSON.stringify(recoveryHashes ?? []), { mode: 0o600 });
  } catch {
    /* best effort */
  }
}

/** Generate recovery codes once (first boot with MFA on). Hashes are persisted;
 *  the plaintext is written ONCE to a 0600 file the operator retrieves over SSH
 *  and then deletes. No-op if already generated. */
export function ensureRecoveryCodes(log?: (msg: string) => void): void {
  if (existsSync(recoveryHashFile())) return;
  const codes = Array.from({ length: RECOVERY_COUNT }, () => randomBytes(5).toString("hex"));
  recoveryHashes = codes.map(sha256hex);
  saveRecovery();
  try {
    writeFileSync(recoveryPlaintextFile(), codes.join("\n") + "\n", { mode: 0o600 });
    log?.(
      `[mfa] ${codes.length} recovery codes written to ${recoveryPlaintextFile()} — retrieve over SSH, store safely, then delete the file.`,
    );
  } catch {
    log?.("[mfa] recovery codes generated but the plaintext file could not be written — use SSH break-glass if needed.");
  }
}

function consumeRecoveryCode(code: string): boolean {
  const hashes = loadRecovery();
  const i = hashes.indexOf(sha256hex(code));
  if (i < 0) return false;
  hashes.splice(i, 1); // one-time use
  saveRecovery();
  return true;
}
