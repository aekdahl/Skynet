// ─── Service-token store ──────────────────────────────────────────────────
// Long-lived, scoped API tokens for programmatic access — the MCP server and
// other automation authenticate with these instead of a login session. A token
// maps to a Principal that carries an explicit scope set (see auth.ts), so an
// automated caller is narrowed to exactly what it was granted. Unlike sessions,
// these do not expire by default (opt in with a TTL) and are revoked by id.
//
// The interface is async so a durable (Postgres) or multi-replica (Redis)
// backend drops in behind it — same pattern as SessionStore. In-memory is the
// default for dev/tests. The raw token is returned ONLY at creation; every read
// path exposes non-secret metadata (a last-4 fingerprint for recognition).

import { randomBytes } from "node:crypto";
import { now } from "../config.js";
import type { Principal, Scope } from "../auth.js";

export interface ServiceToken {
  id: string; // stable id — used for listing & revocation
  token: string; // the secret; only ever returned at creation
  principal: Principal; // { workspaceId, operatorId, scopes } — scopes always set here
  label: string; // human-readable, e.g. "research-agent"
  createdAt: number;
  expiresAt: number | null; // null = long-lived (the default for automation)
  lastUsedAt: number | null;
}

/** Non-secret view for listing in the UI/CLI — never includes the raw token. */
export interface ServiceTokenMeta {
  id: string;
  label: string;
  workspaceId: string;
  operatorId: string;
  scopes: Scope[];
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  last4: string; // last 4 chars of the token — for recognition, not reuse
}

export interface CreateServiceTokenOptions {
  workspaceId: string;
  operatorId: string; // attribution in the audit trail, e.g. "mcp:research-agent"
  scopes: Scope[];
  label: string;
  ttlMs?: number | null; // omit / null → no expiry
  // Register a caller-provided secret instead of generating one. Only used for
  // the headless bootstrap token (the agent injects the secret via env); the
  // normal mint path always generates a fresh random token.
  token?: string;
}

export interface ServiceTokenStore {
  /** Mint a token and return it once (the only time the secret is exposed). */
  create(opts: CreateServiceTokenOptions): Promise<ServiceToken>;
  /** Resolve a live token to its scoped principal; undefined if unknown/expired. */
  resolve(token: string): Promise<Principal | undefined>;
  /** List a workspace's tokens as non-secret metadata, newest first. */
  list(workspaceId: string): Promise<ServiceTokenMeta[]>;
  /** Revoke a token by id; true if one was removed. */
  revoke(id: string): Promise<boolean>;
}

/** Mint a fresh token record. Shared by every adapter. */
export function newServiceToken(opts: CreateServiceTokenOptions): ServiceToken {
  const createdAt = now();
  return {
    id: `pat_${randomBytes(9).toString("base64url")}`,
    // `skynet_pat_` prefix distinguishes these from `sess_` login tokens on sight.
    // A caller-provided token (bootstrap) is used verbatim; otherwise generate.
    token: opts.token ?? `skynet_pat_${randomBytes(32).toString("base64url")}`,
    principal: { workspaceId: opts.workspaceId, operatorId: opts.operatorId, scopes: opts.scopes },
    label: opts.label,
    createdAt,
    expiresAt: opts.ttlMs != null ? createdAt + opts.ttlMs : null,
    lastUsedAt: null,
  };
}

/** Derive the non-secret metadata view from a stored token. */
export function toMeta(t: ServiceToken): ServiceTokenMeta {
  return {
    id: t.id,
    label: t.label,
    workspaceId: t.principal.workspaceId,
    operatorId: t.principal.operatorId,
    scopes: t.principal.scopes ?? [],
    createdAt: t.createdAt,
    expiresAt: t.expiresAt,
    lastUsedAt: t.lastUsedAt,
    last4: t.token.slice(-4),
  };
}

export class MemoryServiceTokenStore implements ServiceTokenStore {
  private byToken = new Map<string, ServiceToken>();

  async create(opts: CreateServiceTokenOptions): Promise<ServiceToken> {
    const record = newServiceToken(opts);
    this.byToken.set(record.token, record);
    return record;
  }

  async resolve(token: string): Promise<Principal | undefined> {
    const t = this.byToken.get(token);
    if (!t) return undefined;
    if (t.expiresAt != null && now() >= t.expiresAt) {
      this.byToken.delete(token); // expired — sweep on access
      return undefined;
    }
    t.lastUsedAt = now();
    return t.principal;
  }

  async list(workspaceId: string): Promise<ServiceTokenMeta[]> {
    return [...this.byToken.values()]
      .filter((t) => t.principal.workspaceId === workspaceId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(toMeta);
  }

  async revoke(id: string): Promise<boolean> {
    for (const [token, t] of this.byToken) {
      if (t.id === id) {
        this.byToken.delete(token);
        return true;
      }
    }
    return false;
  }
}
