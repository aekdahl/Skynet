// ─── Session store ────────────────────────────────────────────────────────
// Opaque session tokens issued at login (W6). A token maps to a Principal and
// expires after a TTL; resolve() sweeps expired entries so unknown/expired
// tokens resolve to undefined → the caller returns 401. In-memory by default,
// matching the Store/Bus pattern; a Redis/Postgres adapter drops in behind this
// same interface for multi-replica or durable sessions.

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
  create(principal: Principal, ttlMs: number): Session;
  /** Resolve a live session; undefined if missing or expired. */
  resolve(token: string): Principal | undefined;
  /** Invalidate a session (logout). */
  destroy(token: string): void;
}

export class MemorySessionStore implements SessionStore {
  private sessions = new Map<string, Session>();

  create(principal: Principal, ttlMs: number): Session {
    const token = `sess_${randomBytes(32).toString("base64url")}`;
    const createdAt = now();
    const session: Session = { token, principal, createdAt, expiresAt: createdAt + ttlMs };
    this.sessions.set(token, session);
    return session;
  }

  resolve(token: string): Principal | undefined {
    const s = this.sessions.get(token);
    if (!s) return undefined;
    if (now() >= s.expiresAt) {
      this.sessions.delete(token); // expired — sweep on access
      return undefined;
    }
    return s.principal;
  }

  destroy(token: string): void {
    this.sessions.delete(token);
  }
}
