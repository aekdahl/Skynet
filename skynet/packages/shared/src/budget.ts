// ─── Daily budget: spend rollup ─────────────────────────────────────────────
// The one place "how much has this project spent today" is computed — shared
// by the server's autonomy gate (orchestrator.ts tickAutonomy) and the web
// project header, so the number the operator sees is exactly the number the
// gate acted on, never a second re-derivation. Pure (no I/O, no Date.now())
// so both sides can call it with an already-fetched run list.

import type { Project, Task, TaskRun } from "./contracts.js";

export interface DailySpend {
  /** Sum of `usage.costUsd` for the project's runs started in the window —
   *  only the KNOWN costs; treat this as a floor, not the true total. */
  spentUsd: number;
  /** Runs in the window with no reported cost (no `usage`, or `costUsd` null)
   *  — real spend that isn't captured in `spentUsd` above. */
  unknownCostRuns: number;
  /** The local-day window actually used (epoch ms, start inclusive / end exclusive). */
  windowStart: number;
  windowEnd: number;
}

/** The local-day window (start inclusive, end exclusive, epoch ms) containing
 *  `at`. "Local" = whatever timezone the process is running in — correct for
 *  a single-operator desktop app where the server and the operator are the
 *  same machine; there's no per-workspace timezone concept to honor instead. */
export function dayWindow(at: number): { start: number; end: number } {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  const start = d.getTime();
  return { start, end: start + 24 * 60 * 60 * 1000 };
}

/** Known spend for `projectId`'s runs whose `startedAt` falls in the local day
 *  containing `at`. Deliberately does NOT exclude archived runs (unlike the
 *  all-time UI usage rollup, `computeUsageRollup` in the web app) — archiving
 *  a run is a soft-hide, not an undo, and a budget gate that money already
 *  spent could be hidden from by archiving would defeat the point. */
export function computeDailySpend(runs: TaskRun[], projectId: string, at: number): DailySpend {
  const { start, end } = dayWindow(at);
  let spentUsd = 0;
  let unknownCostRuns = 0;
  for (const r of runs) {
    if (r.projectId !== projectId) continue;
    if (r.startedAt < start || r.startedAt >= end) continue;
    const cost = r.usage?.costUsd;
    if (cost != null) spentUsd += cost;
    else unknownCostRuns++;
  }
  return { spentUsd, unknownCostRuns, windowStart: start, windowEnd: end };
}

/** Default pacing window (8h) — mirrors config.ts's SKYNET_BUDGET_PACING_WINDOW_MS
 *  default, duplicated here (not imported) so this module has no dependency on
 *  server config and stays usable from a pure/test context. A caller that reads
 *  the real env override (the server) should pass it explicitly. */
export const DEFAULT_BUDGET_PACING_WINDOW_MS = 8 * 60 * 60 * 1000;

/**
 * Budget-as-allocation, pacing half: how much of the daily budget is
 * "available to commit right now"? With `budgetPacing` off (default), the
 * whole remaining budget is available immediately. With it on, availability
 * grows linearly from $0 at local midnight to the full budget at
 * `pacingWindowMs` later, so a $20 budget doesn't get committed to the very
 * first task seen. Never exceeds the true remaining headroom (spend already
 * made today) — pacing can only make a caller MORE conservative, never let it
 * overspend a budget that's already tight. Returns Infinity for an unset
 * budget (no ceiling — callers checking against it will just always fit).
 *
 * The single source of truth for this calculation — used by both the
 * autonomy tick's picker (orchestrator.ts) and the execution-intents
 * feasibility resolver (steward/execution.ts), so a dry-run preview's
 * "N over budget" split is never a different number than what the tick
 * actually does moments later.
 */
export function pacedAvailableUsd(
  project: Project,
  spentUsd: number,
  atMs: number,
  pacingWindowMs: number = DEFAULT_BUDGET_PACING_WINDOW_MS,
): number {
  if (project.dailyBudgetUsd == null) return Infinity;
  const headroom = Math.max(0, project.dailyBudgetUsd - spentUsd);
  if (!project.budgetPacing) return headroom;
  const { start } = dayWindow(atMs);
  const elapsed = Math.min(1, Math.max(0, (atMs - start) / pacingWindowMs));
  const pacedCeiling = project.dailyBudgetUsd * elapsed;
  const pacedHeadroom = Math.max(0, pacedCeiling - spentUsd);
  return Math.min(headroom, pacedHeadroom);
}

// ─── Cost-aware picking: rough $ bands from triage's existing effort call ───
// Budget-as-allocation (ROADMAP: "$20 today" plans what fits, not just a stop-
// gate). tickAutonomy's triage step already produces `Task.assessmentEffort`
// (small/medium/large) via a real LLM call — this maps that FREE signal to a
// static $ band. Deliberately not a second estimation call, and deliberately
// not calibrated against actual spend by any automatic process (no ML here) —
// callers that want to tune the table do it by hand from real cost data.

/** Rough USD cost per triage effort bucket. */
export const EFFORT_COST_BAND_USD: Record<"small" | "medium" | "large", number> = {
  small: 0.5,
  medium: 2,
  large: 8,
};

/** Unknown effort (triage never ran, or produced no signal) assumes the
 *  MIDDLE band, not zero — an un-triaged task must never look free to a
 *  budget-aware picker, or unclassified work would always win a tight budget. */
export const DEFAULT_COST_BAND_USD = EFFORT_COST_BAND_USD.medium;

export function costBandFor(effort: Task["assessmentEffort"]): number {
  return effort ? EFFORT_COST_BAND_USD[effort] : DEFAULT_COST_BAND_USD;
}

/** Rough USD "committed" to the project's currently in-flight (`ongoing`)
 *  tasks — their cost bands, summed. Distinct from `computeDailySpend`'s
 *  `spentUsd` (real, vendor-reported, only for FINISHED cost reporting): this
 *  is a forward-looking estimate of what's already been started but hasn't
 *  settled yet, so an operator sees "spent + committed" as the fuller picture
 *  of where today's budget is actually headed. */
export function committedUsd(tasks: Task[], projectId: string): number {
  let total = 0;
  for (const t of tasks) {
    if (t.projectId !== projectId || t.state !== "ongoing") continue;
    total += costBandFor(t.assessmentEffort);
  }
  return total;
}
