// ─── Time-limited admin promotion (grant + audit) ────────────────────────────
// ROADMAP.md's "Time-limited admin promotion": an existing ADMIN grants a
// VIEWER a bounded, auto-expiring full-authority window (break-glass /
// sudo-style) — never self-service (see auth/routes.ts's POST
// /api/operators/:operatorId/promote, which requires the CALLER's own
// PERSISTED role to be "admin").
//
// Keyed by OPERATOR, not by session token: the granting admin has no access
// to the target's session (they may not even be logged in yet when granted).
// `activeUntil()` is the read side, called from auth.ts's resolvePrincipal()
// on every request for a session-resolved principal (the same "wherever a
// Principal is resolved" seam SessionStore.resolve() already used for its own
// TTL) — an expired grant reverts transparently on the next request, no
// manual step. Deliberately independent of SessionStore: elevation is a fact
// about the OPERATOR, not any particular session, so it needs no backend-
// specific (Postgres/Redis) plumbing at all — one in-memory store covers every
// session backend, same footing as the operator directory itself (also
// memory-only; no durable directory exists yet).
//
// Every grant AND every observed expiry is its own audit entry (list(),
// newest first) — deliberately NOT folded into the HITL audit trail
// (AuditRecord's hitlId/runId are structurally required, and every existing
// consumer is keyed to a resolved HITL decision); a login-privilege event has
// no honest place in that shape. No delete/archive route exists for either
// entry kind — the one property this audit most needs is that a promoted
// operator can't erase their own record.
//
// Expiry is logged LAZILY, the first time `activeUntil` is called after the
// window lapses (sweep-on-access, same idiom as session TTL) — not by a
// background timer. A grant nobody ever checks again (the operator never
// makes another request) never gets its expiry observed either; that's the
// same tradeoff `expiresAt` sweeping already accepts elsewhere in this
// codebase, not a new one.

import { now } from "../config.js";

export interface ElevationGrant {
  kind: "grant";
  workspaceId: string;
  operatorId: string;
  grantedBy: string; // the ADMIN operatorId who granted it
  at: number;
  expiresAt: number;
  ttlMs: number;
}
export interface ElevationExpiry {
  kind: "expiry";
  workspaceId: string;
  operatorId: string;
  at: number; // when the lapse was first OBSERVED (not necessarily expiresAt)
  expiresAt: number; // the boundary that was crossed — ties this back to its grant
}
export type ElevationEvent = ElevationGrant | ElevationExpiry;

export interface ElevationStore {
  /** Admin-granted: replaces any existing active grant for this operator. */
  grant(workspaceId: string, operatorId: string, grantedBy: string, ttlMs: number): Promise<{ expiresAt: number }>;
  /** The live elevation deadline for this operator, or null if none/lapsed.
   *  Sweeps + logs an expiry event on first access past `expiresAt`. */
  activeUntil(workspaceId: string, operatorId: string): Promise<number | null>;
  /** This workspace's grant + expiry history, newest first. */
  list(workspaceId: string): Promise<ElevationEvent[]>;
}

const identityKey = (workspaceId: string, operatorId: string): string => `${workspaceId}:${operatorId}`;

// Same cap as the log this replaces — bounds memory on a long-lived process
// without needing a real retention policy for what's still an in-memory store.
const MAX_EVENTS_PER_WORKSPACE = 200;

export class MemoryElevationStore implements ElevationStore {
  private active = new Map<string, { workspaceId: string; operatorId: string; expiresAt: number }>();
  private events = new Map<string, ElevationEvent[]>();

  private recordEvent(event: ElevationEvent): void {
    const list = this.events.get(event.workspaceId) ?? [];
    list.push(event);
    if (list.length > MAX_EVENTS_PER_WORKSPACE) list.splice(0, list.length - MAX_EVENTS_PER_WORKSPACE);
    this.events.set(event.workspaceId, list);
  }

  async grant(workspaceId: string, operatorId: string, grantedBy: string, ttlMs: number): Promise<{ expiresAt: number }> {
    const at = now();
    const expiresAt = at + ttlMs;
    this.active.set(identityKey(workspaceId, operatorId), { workspaceId, operatorId, expiresAt });
    this.recordEvent({ kind: "grant", workspaceId, operatorId, grantedBy, at, expiresAt, ttlMs });
    return { expiresAt };
  }

  async activeUntil(workspaceId: string, operatorId: string): Promise<number | null> {
    const key = identityKey(workspaceId, operatorId);
    const entry = this.active.get(key);
    if (!entry) return null;
    if (now() >= entry.expiresAt) {
      this.active.delete(key); // sweep on access
      this.recordEvent({ kind: "expiry", workspaceId, operatorId, at: now(), expiresAt: entry.expiresAt });
      return null;
    }
    return entry.expiresAt;
  }

  async list(workspaceId: string): Promise<ElevationEvent[]> {
    return [...(this.events.get(workspaceId) ?? [])].reverse();
  }
}
