// ─── Session store ────────────────────────────────────────────────────────
// Opaque session tokens issued at login (W6). A token maps to a Principal and
// expires after a TTL; unknown/expired tokens resolve to undefined → the caller
// returns 401. The interface is async so a durable (Postgres) or multi-replica
// (Redis) backend drops in behind it — see sessions.postgres.ts / sessions.redis.ts.
// In-memory is the default, matching the Store/Bus pattern.

import { randomBytes } from "node:crypto";
import { now } from "../config.js";
import type { Principal } from "../auth.js";

export interface Session {
  token: string;
  principal: Principal;
  createdAt: number;
  expiresAt: number;
}

export interface SessionStore {
  /** Issue a session for a freshly authenticated principal. */
  create(principal: Principal, ttlMs: number): Promise<Session>;
  /** Resolve a live session; undefined if missing or expired. */
  resolve(token: string): Promise<Principal | undefined>;
  /** Invalidate a session (logout). */
  destroy(token: string): Promise<void>;
}

/** Mint a fresh opaque token + timestamps. Shared by every adapter. */
export function newSession(principal: Principal, ttlMs: number): Session {
  const createdAt = now();
  return {
    token: `sess_${randomBytes(32).toString("base64url")}`,
    principal,
    createdAt,
    expiresAt: createdAt + ttlMs,
  };
}

export class MemorySessionStore implements SessionStore {
  private sessions = new Map<string, Session>();

  async create(principal: Principal, ttlMs: number): Promise<Session> {
    const session = newSession(principal, ttlMs);
    this.sessions.set(session.token, session);
    return session;
  }

  async resolve(token: string): Promise<Principal | undefined> {
    const s = this.sessions.get(token);
    if (!s) return undefined;
    if (now() >= s.expiresAt) {
      this.sessions.delete(token); // expired — sweep on access
      return undefined;
    }
    return s.principal;
  }

  async destroy(token: string): Promise<void> {
    this.sessions.delete(token);
  }
}
