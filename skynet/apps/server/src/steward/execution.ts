// ─── Execution intents: the feasibility resolver ───────────────────────────
// The server-side seam a "start this feature" / "process the backlog" style
// composite executes through. A composite doesn't just start N tasks — it has
// to decide WHICH of them are actually startable right now, honestly, before
// anything runs: some are already finished or in flight (re-issuing the same
// directive must never double-start), some (under `feasibleOnly`) were never
// triaged clear, and some don't fit what's left of today's budget. This is
// that decision, factored out as ONE pure function so a dry-run preview and
// the real execute-time filter can never compute a different answer — see
// operations.ts's `executeStewardAction`, which calls this for both.

import type { Project, Task, TaskRun } from "@skynet/shared";
import { computeDailySpend, costBandFor, pacedAvailableUsd } from "@skynet/shared";

/** Why a candidate task was left out of `eligible`. `"unclear"` — the task's
 *  triage assessment never came out clear (it's still parked in `triage`
 *  state; see the doc comment on `resolveExecutable` for why that's the only
 *  observable signal). `"already-running"` — `ongoing` or `review`: it has a
 *  live or just-finished run, so (re)starting it would spawn a duplicate.
 *  `"done"` — nothing left to do. `"over-budget"` — fits the scope and is
 *  ready, but today's paced budget ran out first (still QUEUEABLE — the tick
 *  picks it up once budget frees; see executeStewardAction). `"not-in-scope"`
 *  — archived, or otherwise structurally not something this action can touch
 *  (kept as its own reason rather than silently dropping it, so a caller's
 *  count always adds up: eligible.length + excluded.length === tasks.length). */
export type ExecutableExcludeReason = "unclear" | "already-running" | "done" | "over-budget" | "not-in-scope";

export interface ExecutableExclusion {
  taskId: string;
  reason: ExecutableExcludeReason;
}

export interface ResolveExecutableOpts {
  /** Exclude tasks that were never triaged clear (still parked in `triage`).
   *  Off (default) leaves them in the candidate pool — an operator/composite
   *  that explicitly names tasks (queue_tasks) already decided they're wanted;
   *  a scope-driven composite (start_feature/process_backlog) opts in. */
  feasibleOnly?: boolean;
  /** Injected "now" — kept out of Date.now() so this stays pure/deterministic
   *  for a dry-run preview and its later real execution to agree, and so
   *  tests don't race the clock. */
  atMs: number;
  /** Overrides the server's SKYNET_BUDGET_PACING_WINDOW_MS default — see
   *  pacedAvailableUsd. Only a caller with the real config needs to pass this. */
  budgetPacingWindowMs?: number;
}

export interface ResolveExecutableResult {
  /** Priority-ordered (same rank field + tiebreak as the autonomy tick's
   *  auto-pick sort — see orchestrator.ts's tickAutonomy) — a caller queuing
   *  or start-now'ing this list preserves the operator's own priority. */
  eligible: Task[];
  excluded: ExecutableExclusion[];
}

/**
 * PURE: from a candidate task list (the caller already scoped it — a
 * feature's tasks, or the project's backlog+triage+todo — see
 * operations.ts's executeStewardAction), decide which are actually
 * executable right now and which aren't, and why.
 *
 * "Unclear" has no persisted boolean on Task — the autonomy tick's own triage
 * step (orchestrator.ts) auto-promotes triage→todo the moment its clarity
 * read comes back "clear", and parks an unclear (or un-signalled) task in
 * `triage` otherwise. A task still sitting in `triage`, by construction, IS
 * "never came out clear" — there is no second field to check.
 */
export function resolveExecutable(
  project: Project,
  tasks: Task[],
  runs: TaskRun[],
  opts: ResolveExecutableOpts,
): ResolveExecutableResult {
  const excluded: ExecutableExclusion[] = [];
  const candidates: Task[] = [];
  for (const t of tasks) {
    if (t.archived) {
      excluded.push({ taskId: t.id, reason: "not-in-scope" });
    } else if (t.state === "done") {
      excluded.push({ taskId: t.id, reason: "done" });
    } else if (t.state === "ongoing" || t.state === "review") {
      // Idempotency: re-issuing the same directive must never double-start a
      // task that already has a live run in flight, or a just-finished one
      // still sitting in review — both already "ran", nothing to (re)queue.
      excluded.push({ taskId: t.id, reason: "already-running" });
    } else if (opts.feasibleOnly && t.state === "triage") {
      excluded.push({ taskId: t.id, reason: "unclear" });
    } else {
      candidates.push(t);
    }
  }

  // Priority order — identical rank field + tiebreak to the autonomy tick's
  // own auto-pick sort, so a dry-run preview lists work in the same order
  // the tick would actually start it in.
  candidates.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));

  const spend = computeDailySpend(runs, project.id, opts.atMs);
  let available = pacedAvailableUsd(project, spend.spentUsd, opts.atMs, opts.budgetPacingWindowMs);
  const eligible: Task[] = [];
  for (const t of candidates) {
    const band = costBandFor(t.assessmentEffort);
    if (band <= available) {
      eligible.push(t);
      available -= band;
    } else {
      // Still QUEUEABLE, not dropped — see the type doc. Walk continues (not
      // break) past it, same as selectAffordable, so a cheaper lower-priority
      // task can still fit the remaining allowance.
      excluded.push({ taskId: t.id, reason: "over-budget" });
    }
  }
  return { eligible, excluded };
}
