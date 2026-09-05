// ─── Derived intelligence: merge target ──────────────────────────────────────
// Where a run's approved diff should integrate FIRST (agent-hierarchy brief §5,
// generalizing the VCS brief §7 "a fork merges into its parent's branch first"
// rule one tier up: a worker merges into its manager's branch first).
//
// Deliberately narrow: it only redirects the target when the run's DIRECT
// parent was executed by a manager-role fleet agent (see Orchestrator.spawnWorker
// and Agent.role in contracts.ts) — a plain fork (parent run, but a worker-role
// or unknown runner) keeps merging straight to the project's base branch
// exactly as it always has.
//
// Only resolves ONE tier (the run's own direct parent), not the family root:
// each run in a chain integrates into whatever is immediately above it, so a
// multi-level delegation chain still merges tier-by-tier rather than every
// descendant skipping ahead to some assumed top-level manager.

import type { Agent, TaskRun } from "@skynet/shared";

/**
 * Is `run` a worker `spawnWorker` delegated under `parent` (a manager-role
 * agent)? The one condition both merge paths key off: the GitHub PR flow via
 * {@link resolveMergeTarget} below, and the local merge queue's own routing in
 * orchestrator.ts's `integrateRun` — pulled out here so the two can't drift.
 */
export function isManagerDelegated(
  run: TaskRun,
  parent: TaskRun | undefined,
  parentRunner: Pick<Agent, "role"> | undefined,
): boolean {
  return !!run.parentId && !!parent && parentRunner?.role === "manager";
}

/**
 * @param run The run whose merge target is being resolved.
 * @param parent The run's direct parent (`byId.get(run.parentId)`), or
 *   undefined if it has no parent or the parent couldn't be resolved.
 * @param parentRunner The fleet agent that executed `parent`
 *   (`parent && parent.agentId ? byId.get(parent.agentId) : undefined`), or
 *   undefined if unresolvable.
 * @param projectBaseBranch The project's normal integration/base branch —
 *   returned whenever the manager-parent condition doesn't hold.
 */
export function resolveMergeTarget(
  run: TaskRun,
  parent: TaskRun | undefined,
  parentRunner: Pick<Agent, "role"> | undefined,
  projectBaseBranch: string,
): string {
  if (isManagerDelegated(run, parent, parentRunner)) return (parent as TaskRun).branch;
  return projectBaseBranch;
}
