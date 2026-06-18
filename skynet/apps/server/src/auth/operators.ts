// ─── Operator directory ───────────────────────────────────────────────────
// The workspace/operator store behind real login (W6). Maps credentials to a
// Principal { workspaceId, operatorId }. Passwords are scrypt-hashed with a
// per-record salt and compared in constant time. In-memory + dev-seeded here;
// a Postgres-backed directory implements the same interface.
//
// SSO/OIDC seam: an OidcDirectory would implement the same `verify`-shaped
// contract by mapping a verified IdP subject/claims to a Principal, then the
// session layer issues a token identically. Password auth is the default so the
// flow is demonstrable without an external IdP.

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { Principal } from "../auth.js";

export interface OperatorRecord {
  operatorId: string;
  workspaceId: string;
  email: string; // lowercased login id
  salt: string; // hex
  hash: string; // hex scrypt(password, salt)
}

export interface OperatorDirectory {
  /** Verify credentials; returns the Principal on success, undefined otherwise. */
  verify(email: string, password: string): Principal | undefined;
}

const SCRYPT_KEYLEN = 64;

function hashPassword(password: string, salt: string): Buffer {
  return scryptSync(password, salt, SCRYPT_KEYLEN);
}

/** Build a record with a fresh salt — used by the dev seed and future admin tools. */
export function makeOperator(
  operatorId: string,
  workspaceId: string,
  email: string,
  password: string,
): OperatorRecord {
  const salt = randomBytes(16).toString("hex");
  return {
    operatorId,
    workspaceId,
    email: email.toLowerCase(),
    salt,
    hash: hashPassword(password, salt).toString("hex"),
  };
}

export class MemoryOperatorDirectory implements OperatorDirectory {
  private byEmail = new Map<string, OperatorRecord>();

  constructor(records: OperatorRecord[]) {
    for (const r of records) this.byEmail.set(r.email.toLowerCase(), r);
  }

  verify(email: string, password: string): Principal | undefined {
    const r = this.byEmail.get(email.toLowerCase());
    if (!r) return undefined;
    const candidate = hashPassword(password, r.salt);
    const expected = Buffer.from(r.hash, "hex");
    if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
      return undefined;
    }
    return { workspaceId: r.workspaceId, operatorId: r.operatorId };
  }
}

/**
 * Dev seed — mirrors the dev token operators so login is demoable end-to-end.
 * Two workspaces keep isolation visible. Replace with a real directory in prod.
 * Credentials: jordan@cyberdyne.dev / kyle@resistance.dev, password "skynet".
 */
export function seedOperators(): OperatorRecord[] {
  return [
    makeOperator("jordan", DEFAULT_WORKSPACE, "jordan@cyberdyne.dev", "skynet"),
    makeOperator("kyle", "resistance", "kyle@resistance.dev", "skynet"),
  ];
}
