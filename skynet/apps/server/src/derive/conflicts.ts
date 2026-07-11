// ─── Derived intelligence: conflicts & dependencies ──────────────────────────
// Computes the "no double work" signal server-side (Backend Brief §09), so it's
// authoritative for non-UI consumers (capacity, merge gating) rather than only
// derived in the client. Fork-aware: a fork and its parent are one family and
// never flag each other (`parentId`). VCS brief §4.

import type { TaskRun, Dependency } from "@skynet/shared";

/** Family root — a fork collapses onto its parent so they share a family. */
export const familyOf = (a: TaskRun): string => a.parentId ?? a.id;

export interface Conflict {
  moduleId: string;
  runIds: string[];
}

/**
 * A module is contested when two *different active families* both touch it.
 * Returns one entry per contested module with all involved agent ids.
 */
export function computeConflicts(runs: TaskRun[]): Conflict[] {
  const active = runs.filter((a) => a.status !== "done");
  const byModule = new Map<string, TaskRun[]>();
  for (const a of active) {
    for (const m of a.modules) {
      const list = byModule.get(m) ?? [];
      list.push(a);
      byModule.set(m, list);
    }
  }
  const out: Conflict[] = [];
  for (const [moduleId, list] of byModule) {
    const families = new Set(list.map(familyOf));
    if (families.size > 1) out.push({ moduleId, runIds: list.map((a) => a.id) });
  }
  return out;
}

/**
 * Dependency edges derived from explicit `dependsOn` (upstream → downstream).
 * Only edges to known active runs are kept.
 */
export function computeDeps(runs: TaskRun[]): Dependency[] {
  const ids = new Set(runs.map((a) => a.id));
  const edges: Dependency[] = [];
  for (const a of runs) {
    for (const upstream of a.dependsOn) {
      if (ids.has(upstream)) edges.push({ fromAgentId: upstream, toAgentId: a.id });
    }
  }
  return edges;
}
