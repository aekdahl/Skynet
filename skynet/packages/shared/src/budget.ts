// ─── Daily budget: spend rollup ─────────────────────────────────────────────
// The one place "how much has this project spent today" is computed — shared
// by the server's autonomy gate (orchestrator.ts tickAutonomy) and the web
// project header, so the number the operator sees is exactly the number the
// gate acted on, never a second re-derivation. Pure (no I/O, no Date.now())
// so both sides can call it with an already-fetched run list.

import type { Task, TaskRun } from "./contracts.js";

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
