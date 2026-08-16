// ─── Elevation audit log ───────────────────────────────────────────────────
// A minimal, append-only record of every time-limited admin promotion
// (ROADMAP.md's "Time-limited admin promotion") — deliberately separate from
// the HITL audit trail (operations.ts/store.ts's recordAudit): that trail's
// AuditRecord is structurally a resolved-HITL-decision (hitlId + runId both
// NOT NULL, every maintenance route keyed by hitlId, the whole view resolves
// runId→agent), and a login-privilege event has no honest place in that shape.
// This log also has no delete/archive route — the one property a promotion
// audit most needs is that a just-promoted operator can't erase their own
// record, unlike the HITL trail's clearAudit/archiveAllAudit.
//
// A single record carries the grant's own `expiresAt`, so it's a complete
// audit statement of both the promotion AND its (eventual) expiry — nothing
// separately observes or logs the expiry moment; a reader compares
// `expiresAt` to now() to know whether a given grant is still live.

export interface ElevationEvent {
  workspaceId: string;
  operatorId: string;
  at: number;
  expiresAt: number;
  ttlMs: number;
}

export interface ElevationLog {
  record(event: ElevationEvent): Promise<void>;
  /** Newest first. */
  list(workspaceId: string): Promise<ElevationEvent[]>;
}

// In-memory only for now — matches OperatorDirectory (also memory-only; no
// Postgres-backed directory exists yet) and mfa.ts's challenge Map. A durable
// backend can drop in behind this same interface later, same pattern as
// SessionStore.
const MAX_EVENTS_PER_WORKSPACE = 200;

export class MemoryElevationLog implements ElevationLog {
  private byWorkspace = new Map<string, ElevationEvent[]>();

  async record(event: ElevationEvent): Promise<void> {
    const list = this.byWorkspace.get(event.workspaceId) ?? [];
    list.push(event);
    if (list.length > MAX_EVENTS_PER_WORKSPACE) list.splice(0, list.length - MAX_EVENTS_PER_WORKSPACE);
    this.byWorkspace.set(event.workspaceId, list);
  }

  async list(workspaceId: string): Promise<ElevationEvent[]> {
    return [...(this.byWorkspace.get(workspaceId) ?? [])].reverse();
  }
}
