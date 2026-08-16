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
import { config } from "../config.js";
import type { Principal } from "../auth.js";

/** A human account's authority. "admin" = full authority (today's only
 *  behavior, unchanged). "viewer" = read-only: mapped to `Principal.scopes:
 *  ["observe"]` at login, so it rides the SAME scope-checked call sites a
 *  service token does (auth.ts's `hasScope`) rather than a parallel
 *  permission system — see ROADMAP.md's "Read-only (viewer) role". */
export type OperatorRole = "admin" | "viewer";

export interface OperatorRecord {
  operatorId: string;
  workspaceId: string;
  email: string; // lowercased login id
  salt: string; // hex
  hash: string; // hex scrypt(password, salt)
  role: OperatorRole;
}

export interface OperatorDirectory {
  /** Verify credentials; returns the Principal on success, undefined otherwise. */
  verify(email: string, password: string): Principal | undefined;
  /** The login email for an ALREADY-AUTHENTICATED identity — used by the
   *  elevate flow (auth/routes.ts) to re-verify a password without asking the
   *  browser to remember/re-type the email (Principal itself carries no email,
   *  only operatorId). Keyed by (workspaceId, operatorId): operatorId alone
   *  isn't globally unique (e.g. the dev seed's "viewer" exists in one
   *  workspace, "jordan"/"kyle" in different ones). */
  findEmail(workspaceId: string, operatorId: string): string | undefined;
}

const SCRYPT_KEYLEN = 64;

function hashPassword(password: string, salt: string): Buffer {
  return scryptSync(password, salt, SCRYPT_KEYLEN);
}

/** Build a record with a fresh salt — used by the dev seed and future admin tools.
 *  Defaults to "admin" so every existing call site keeps today's full-authority
 *  behavior unless it opts into "viewer" explicitly. */
export function makeOperator(
  operatorId: string,
  workspaceId: string,
  email: string,
  password: string,
  role: OperatorRole = "admin",
): OperatorRecord {
  const salt = randomBytes(16).toString("hex");
  return {
    operatorId,
    workspaceId,
    email: email.toLowerCase(),
    salt,
    hash: hashPassword(password, salt).toString("hex"),
    role,
  };
}

const identityKey = (workspaceId: string, operatorId: string): string => `${workspaceId}:${operatorId}`;

export class MemoryOperatorDirectory implements OperatorDirectory {
  private byEmail = new Map<string, OperatorRecord>();
  private byIdentity = new Map<string, OperatorRecord>();

  constructor(records: OperatorRecord[]) {
    for (const r of records) {
      this.byEmail.set(r.email.toLowerCase(), r);
      this.byIdentity.set(identityKey(r.workspaceId, r.operatorId), r);
    }
  }

  findEmail(workspaceId: string, operatorId: string): string | undefined {
    return this.byIdentity.get(identityKey(workspaceId, operatorId))?.email;
  }

  verify(email: string, password: string): Principal | undefined {
    const r = this.byEmail.get(email.toLowerCase());
    if (!r) return undefined;
    const candidate = hashPassword(password, r.salt);
    const expected = Buffer.from(r.hash, "hex");
    if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
      return undefined;
    }
    // role → scopes, ONCE, here at login. Nothing downstream of this needs to
    // know "role" exists — every scope-gated call site (REST + MCP) already
    // checks `Principal.scopes` exactly as it does for a service token.
    return {
      workspaceId: r.workspaceId,
      operatorId: r.operatorId,
      ...(r.role === "viewer" ? { scopes: ["observe"] as Principal["scopes"] } : {}),
    };
  }
}

export interface SeedOptions {
  /** Dev/test seeds the demo pair; production never does. */
  devMode: boolean;
  adminEmail?: string;
  adminPassword?: string;
  adminWorkspace?: string;
  // Optional second account, mirroring the admin seed above — a hosted deploy
  // with no invite/user-management UI yet still needs SOME way to stand up a
  // read-only login. Independent of the admin fields (either can be set alone).
  viewerEmail?: string;
  viewerPassword?: string;
  viewerWorkspace?: string;
}

/**
 * Pure seed policy (config-free so it's directly testable):
 *
 * - Dev/test: the demo pair (both admin), plus a demo viewer so the read-only
 *   role is demoable end-to-end without any extra setup. Two workspaces keep
 *   isolation visible. Credentials: jordan@cyberdyne.dev / kyle@resistance.dev
 *   (admin) and viewer@cyberdyne.dev (viewer), pw "skynet".
 * - Production: NEVER the demo accounts — a well-known password on a hosted deploy is
 *   a footgun. Seed a single admin ONLY when both adminEmail + adminPassword are
 *   given, and/or a single viewer ONLY when both viewerEmail + viewerPassword are
 *   given; otherwise that account is absent (UI login disabled — correct for a
 *   headless/MCP deploy that uses service tokens; a UI deploy MUST set them).
 */
export function seedOperatorRecords(opts: SeedOptions): OperatorRecord[] {
  if (opts.devMode) {
    return [
      makeOperator("jordan", DEFAULT_WORKSPACE, "jordan@cyberdyne.dev", "skynet"),
      makeOperator("kyle", "resistance", "kyle@resistance.dev", "skynet"),
      makeOperator("viewer", DEFAULT_WORKSPACE, "viewer@cyberdyne.dev", "skynet", "viewer"),
    ];
  }
  const records: OperatorRecord[] = [];
  if (opts.adminEmail && opts.adminPassword) {
    records.push(makeOperator("admin", opts.adminWorkspace || DEFAULT_WORKSPACE, opts.adminEmail, opts.adminPassword));
  }
  if (opts.viewerEmail && opts.viewerPassword) {
    records.push(
      makeOperator(
        "viewer",
        opts.viewerWorkspace || opts.adminWorkspace || DEFAULT_WORKSPACE,
        opts.viewerEmail,
        opts.viewerPassword,
        "viewer",
      ),
    );
  }
  return records;
}

/** Seed from the live environment config. index.ts warns on an empty prod directory. */
export function seedOperators(): OperatorRecord[] {
  return seedOperatorRecords({
    devMode: config.devMode,
    adminEmail: config.adminEmail,
    adminPassword: config.adminPassword,
    adminWorkspace: config.adminWorkspace,
    viewerEmail: config.viewerEmail,
    viewerPassword: config.viewerPassword,
    viewerWorkspace: config.viewerWorkspace,
  });
}
