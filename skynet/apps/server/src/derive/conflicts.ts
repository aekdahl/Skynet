// ─── Server-side conflict computation (W4) ─────────────────────────────────
// "No double work": a conflict exists when two different agent *families* are
// concurrently active and their *touched* module sets intersect (VCS brief §4).
//
//   • Family — an agent plus its fork-descendants, collapsed via `parentId`.
//     A fork and its parent share context on purpose, so they are ONE family
//     and never flag each other.
//   • Concurrently active — both not `done`.
//   • Touched modules — `Agent.modules` (derived from changed files by W3).
//
// This is the server-side mirror of the client's `conflicts()` in
// `apps/web/src/lib/derive.ts`: same families, same grouping, same threshold —
// so it MATCHES what the UI shows today, then supersedes it once Core triggers
// recomputation from the Hub and publishes `conflict.detected`.
//
// Owned by W4 (Lane D). Pure functions — Core adds the hub trigger and decides
// when to publish (e.g. on agent.started / agent.progress / agent.status).

import type { Agent, ServerEvent } from "@skynet/shared";

/** Collapse an agent to its conflict family: a fork shares its parent's id. */
export const familyOf = (a: Agent): string => a.parentId ?? a.id;

/** A module touched concurrently by more than one active family. */
export interface ModuleConflict {
  moduleId: string;
  /** Ids of the active agents touching the module (≥2 distinct families). */
  agentIds: string[];
}

/**
 * Compute the current module-level conflicts across a set of agents (scope the
 * input to one workspace before calling). Mirrors the client `conflicts()`:
 * group non-done agents by module, keep modules whose touching agents span more
 * than one family. Output is sorted (module id, then agent id) for stable
 * diffing by the caller.
 */
export function computeConflicts(agents: Agent[]): ModuleConflict[] {
  const byModule = new Map<string, Agent[]>();
  for (const a of agents) {
    if (a.status === "done") continue;
    for (const moduleId of a.modules) {
      const list = byModule.get(moduleId) ?? [];
      list.push(a);
      byModule.set(moduleId, list);
    }
  }

  const conflicts: ModuleConflict[] = [];
  for (const [moduleId, list] of byModule) {
    const families = new Set(list.map(familyOf));
    if (families.size > 1) {
      conflicts.push({
        moduleId,
        agentIds: list.map((a) => a.id).sort(),
      });
    }
  }
  return conflicts.sort((a, b) => a.moduleId.localeCompare(b.moduleId));
}

type ConflictEvent = Extract<ServerEvent, { type: "conflict.detected" }>;

/**
 * The current conflicts as ready-to-publish `conflict.detected` events. Core
 * publishes these on the agents' workspace channel from the Hub trigger
 * (typically after diffing against the previously-emitted set so unchanged
 * conflicts don't re-broadcast).
 */
export function conflictEvents(agents: Agent[]): ConflictEvent[] {
  return computeConflicts(agents).map((c) => ({
    type: "conflict.detected",
    moduleId: c.moduleId,
    agentIds: c.agentIds,
  }));
}
