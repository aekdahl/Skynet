// ─── Derived intelligence: conflicts & dependencies ──────────────────────────
// Computes the "no double work" signal server-side (Backend Brief §09), so it's
// authoritative for non-UI consumers (capacity, merge gating) rather than only
// derived in the client. Fork-aware: a fork and its parent are one family and
// never flag each other (`parentId`). VCS brief §4.

import type { TaskRun, Dependency } from "@skynet/shared";

/**
 * Family root — walks `parentId` all the way up, not just one hop, so a fork
 * of a fork (already reachable today: the Fork action has no depth limit) and
 * a delegation chain (agent-hierarchy brief §1: worker → manager) collapse
 * onto the SAME root family instead of only the fork-of-a-fork's immediate
 * parent. `byId` is optional and defaults to today's single-hop behavior when
 * omitted (callers with no full run list — e.g. a lone run in isolation —
 * can't walk further than one hop anyway). Guards a broken/cyclic chain (a
 * missing parent, or a parent id that loops back on itself) by stopping at
 * the last resolvable link rather than looping forever.
 */
export function familyOf(a: TaskRun, byId?: ReadonlyMap<string, TaskRun>): string {
  if (!byId) return a.parentId ?? a.id;
  let cur = a;
  const seen = new Set([a.id]);
  while (cur.parentId) {
    if (seen.has(cur.parentId)) return cur.parentId; // cycle — stop here
    const parent = byId.get(cur.parentId);
    if (!parent) return cur.parentId; // parent unknown (e.g. deleted) — stop here
    seen.add(parent.id);
    cur = parent;
  }
  return cur.id;
}

export interface Conflict {
  moduleId: string;
  runIds: string[];
}

/**
 * A module is contested when two *different active families* both touch it.
 * Returns one entry per contested module with all involved agent ids.
 */
export function computeConflicts(runs: TaskRun[]): Conflict[] {
  // Built from ALL runs (not just active) so a chain still walks correctly
  // through a parent that has itself already finished.
  const byId = new Map(runs.map((r) => [r.id, r]));
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
    const families = new Set(list.map((a) => familyOf(a, byId)));
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
