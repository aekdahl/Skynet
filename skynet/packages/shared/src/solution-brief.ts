// ─── Solution Brief: task resolution ────────────────────────────────────────
// The one place "which brief is this task scoped under" is decided — shared
// by the server (threading a brief into an agent's context, driving its
// approved→building/building→done status transitions) and the web client
// (the brief chip on a task card), so both sides agree on the same task.
// Pure (no I/O) — callers pass an already-fetched brief list.

import type { SolutionBrief, Task } from "./contracts.js";

/** Resolve the SolutionBrief a task is scoped under: a direct
 *  `task.source.briefId` reference when the task was spawned straight from a
 *  brief, else the brief that rolls up into the task's Feature (a brief's own
 *  `featureId` is the only link Feature itself carries back to a brief).
 *  undefined when the task has neither a brief source nor a brief-linked
 *  feature. */
export function resolveTaskBrief(task: Task, briefs: SolutionBrief[]): SolutionBrief | undefined {
  const source = task.source;
  if (source && source.kind === "brief") {
    return briefs.find((b) => b.id === source.briefId);
  }
  if (!task.featureId) return undefined;
  return briefs.find((b) => b.featureId === task.featureId);
}
