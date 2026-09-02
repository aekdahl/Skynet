// ─── Home dashboard metrics (Momentum Rollout Phase 22) ────────────────────
// Pure, dependency-free math over data already exposed elsewhere in the app
// (Decision/AuditRecord/Task/Transition/TaskRun) — no new backend inputs
// beyond the workspace-wide transitions read (see client.ts's
// fetchTransitions). Kept separate from home.tsx (the rendering layer)
// specifically so it's testable without a DOM, same rationale as
// health-metrics.ts: `now` is always an explicit param, never `Date.now()`
// inside, so the same call gives the same answer every time.
import type { AuditRecordWithActor, Decision, HitlItem, HitlKind, Task, TaskRun, Transition } from "@skynet/shared";
import { stalledTasks } from "./health-metrics";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// ─── 1. Greeting sentence ────────────────────────────────────────────────
// A templating function, NOT an LLM call — every number here is real,
// derived overnight activity. "Overnight" is a trailing rolling window
// (not clock-local-midnight), so it means the same thing regardless of the
// operator's timezone or how late they were actually up.
export const OVERNIGHT_WINDOW_MS = 12 * HOUR_MS;

export interface OvernightActivity {
  agentCount: number;
  questions: number;
  approvals: number;
  /** Still-open escalations raised in the window — an escalation raised
   *  overnight but already resolved (by a human or autonomy) isn't "stuck"
   *  anymore, so it's excluded here even though it WAS raised in the window. */
  escalations: number;
}

/** A run "worked overnight" if it started OR heartbeated inside the window —
 *  covers both a run that kicked off overnight and one that was already in
 *  flight and kept making progress through it. */
export function overnightActivity(
  runs: TaskRun[],
  queue: HitlItem[],
  now: number,
  windowMs: number = OVERNIGHT_WINDOW_MS,
): OvernightActivity {
  const since = now - windowMs;
  const agentCount = runs.filter((r) => r.startedAt >= since || r.lastHeartbeatAt >= since).length;
  const raised = queue.filter((q) => q.raisedAt >= since && q.raisedAt <= now);
  return {
    agentCount,
    questions: raised.filter((q) => q.kind === "question").length,
    approvals: raised.filter((q) => q.kind === "approval").length,
    escalations: raised.filter((q) => q.kind === "escalation" && q.resolvedAt == null).length,
  };
}

export interface GreetingResult {
  /** Everything up to (and not including) the needs-you clause. */
  before: string;
  /** The escalations clause, rendered separately so the caller can wrap it
   *  in the "needs you" color — null when nothing escalated overnight. */
  needsYou: string | null;
  /** The ready-to-merge clause, plain text — trails after needsYou. Empty
   *  string (not null) when there's nothing to merge, so callers can always
   *  just concatenate/render it without a null check. */
  after: string;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Never a static "Good morning" fallback — even the all-zero case gets its
 *  own honest sentence, because "nothing happened" is itself a real,
 *  derived fact, not a missing one. */
export function greetingSentence(activity: OvernightActivity, readyToMergeCount: number): GreetingResult {
  const allZero =
    activity.agentCount === 0 && activity.questions === 0 && activity.approvals === 0 &&
    activity.escalations === 0 && readyToMergeCount === 0;
  if (allZero) {
    return { before: "Quiet night — nothing happened while you were away.", needsYou: null, after: "" };
  }

  let before: string;
  if (activity.agentCount === 0) {
    before = "No agents worked overnight.";
  } else {
    before = `${plural(activity.agentCount, "agent")} worked overnight`;
    const raisedParts: string[] = [];
    if (activity.questions > 0) raisedParts.push(plural(activity.questions, "question"));
    if (activity.approvals > 0) raisedParts.push(plural(activity.approvals, "approval"));
    if (raisedParts.length > 0) before += `, raising ${raisedParts.join(" and ")}`;
    before += ".";
  }

  const needsYou =
    activity.escalations > 0
      ? ` ${plural(activity.escalations, "task")} got stuck and need${activity.escalations === 1 ? "s" : ""} you.`
      : null;

  const after =
    readyToMergeCount > 0
      ? ` ${plural(readyToMergeCount, "run")} ${readyToMergeCount === 1 ? "is" : "are"} ready for you to merge.`
      : "";

  return { before, needsYou, after };
}

// ─── 2a. WAITING ON YOU — breakdown by HITL kind ────────────────────────
// Takes plain HitlItem[] (the live, always-in-the-store `openQueue(queue)`)
// rather than requiring a Decision fetch — Decision is a strict superset
// (HitlItem + projectId/projectName/taskTitle/costOfWaiting), so callers
// that DO have Decisions (e.g. already fetched for topDecisions) can pass
// those straight through too; this only ever reads `kind`.
export interface WaitingOnYou {
  total: number;
  byKind: Partial<Record<HitlKind, number>>;
}
export function waitingOnYou(items: HitlItem[]): WaitingOnYou {
  const byKind: Partial<Record<HitlKind, number>> = {};
  for (const item of items) byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;
  return { total: items.length, byKind };
}

// ─── 2b. HANDLED WITHOUT YOU — % of all gates, from the audit trail ─────
// "Gates" = resolved HITL decisions (the audit trail), not kanban-rule
// transitions — the rule engine is only one of several ways a gate gets
// resolved without a human (auto-review, a standing approval policy), and
// most projects don't use kanban rules at all, so Transition.actor would
// badly undercount this. `actorType` (compliance/report.ts's
// classifyApprover, already computed server-side on every GET /api/audit
// row) is exactly "who/what resolved this" — "policy" or "agent-review"
// both count as handled without a human; missing/undefined actorType is
// treated as human (the safe default: undercounts automation rather than
// overcounts it).
export interface HandledWithoutYou {
  count: number;
  pct: number | null;
  totalGates: number;
}
export function handledWithoutYou(
  audit: AuditRecordWithActor[],
  now: number,
  windowMs: number = 7 * DAY_MS,
): HandledWithoutYou {
  const since = now - windowMs;
  const inWindow = audit.filter((a) => a.at >= since && a.at <= now);
  const count = inWindow.filter((a) => a.actorType != null && a.actorType !== "human").length;
  const totalGates = inWindow.length;
  return { count, pct: totalGates > 0 ? Math.round((count / totalGates) * 100) : null, totalGates };
}

// ─── 2c. MERGED · 7 DAYS — including the reverted count ─────────────────
export interface MergedStats {
  merged: number;
  reverted: number;
}
export function mergedStats(runs: TaskRun[], now: number, windowMs: number = 7 * DAY_MS): MergedStats {
  const since = now - windowMs;
  const mergedInWindow = runs.filter((r) => r.mergedAt != null && r.mergedAt >= since && r.mergedAt <= now);
  const reverted = mergedInWindow.filter((r) => r.merge?.revertedAt != null).length;
  return { merged: mergedInWindow.length, reverted };
}

// ─── 2d. NEEDS A HUMAN LOOK — escalations + stalls ──────────────────────
// Stalls reuse health-metrics.ts's own stalledTasks (>48h since last
// transition, ongoing/review only) verbatim — same definition Board Health
// already uses per-project, just fed the workspace's full task/transition
// set instead of one project's.
export interface NeedsHumanLook {
  escalations: number;
  stalls: number;
  total: number;
}
export function needsHumanLook(queue: HitlItem[], tasks: Task[], transitions: Transition[], now: number): NeedsHumanLook {
  const escalations = queue.filter((q) => q.resolvedAt == null && q.kind === "escalation").length;
  const stalls = stalledTasks(tasks, transitions, now).length;
  return { escalations, stalls, total: escalations + stalls };
}

// ─── 3. Spend-vs-work, 14 days ───────────────────────────────────────────
// Bars = branches merged that (UTC) day — the "work" delivered. Marker =
// cost-per-merge that day, computed from the SAME merged runs' own
// usage.costUsd (not a slice of ambient daily spend from still-in-flight
// runs, which no field here lets us attribute to a specific calendar day
// precisely) — "of what merged today, what did it cost on average" is the
// honest, simple reading this data actually supports.
export interface SpendVsWorkDay {
  dayStart: number; // epoch ms, UTC day boundary
  mergedCount: number;
  costUsd: number;
  costPerMerge: number | null; // null when nothing merged that day
}
export function spendVsWorkSeries(runs: TaskRun[], now: number, days: number = 14): SpendVsWorkDay[] {
  const todayStart = Math.floor(now / DAY_MS) * DAY_MS;
  const out: SpendVsWorkDay[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const dayStart = todayStart - i * DAY_MS;
    const dayEnd = dayStart + DAY_MS;
    const mergedThatDay = runs.filter((r) => r.mergedAt != null && r.mergedAt >= dayStart && r.mergedAt < dayEnd);
    const costUsd = mergedThatDay.reduce((sum, r) => sum + (r.usage?.costUsd ?? 0), 0);
    out.push({
      dayStart,
      mergedCount: mergedThatDay.length,
      costUsd,
      costPerMerge: mergedThatDay.length > 0 ? costUsd / mergedThatDay.length : null,
    });
  }
  return out;
}

export type SpendVsWorkTrend =
  | { kind: "insufficient-data" }
  | { kind: "read"; totalMerges: number; avgCostPerMerge: number; direction: "rising" | "falling" | "steady" };

/** The words underneath the chart — plain data, no formatting (fmtCost lives
 *  in derive.ts; this stays DOM/formatting-free like the rest of this file).
 *  "rising"/"falling" needs >15% drift between the first and last
 *  cost-per-merge day with data, so ordinary day-to-day noise doesn't read
 *  as a trend — only a real, sustained swing does. */
export function spendVsWorkTrend(series: SpendVsWorkDay[]): SpendVsWorkTrend {
  const withData = series.filter((d): d is SpendVsWorkDay & { costPerMerge: number } => d.costPerMerge != null);
  if (withData.length < 2) return { kind: "insufficient-data" };
  const first = withData[0]!.costPerMerge;
  const last = withData[withData.length - 1]!.costPerMerge;
  const direction = last > first * 1.15 ? "rising" : last < first * 0.85 ? "falling" : "steady";
  const totalMerges = series.reduce((sum, d) => sum + d.mergedCount, 0);
  const avgCostPerMerge = withData.reduce((sum, d) => sum + d.costPerMerge, 0) / withData.length;
  return { kind: "read", totalMerges, avgCostPerMerge, direction };
}

// ─── 4. FIRST THREE THINGS — top 3 by cost-of-waiting ───────────────────
// `decisions` is already sorted descending by costOfWaiting server-side
// (Operations.listDecisions) — this is just the documented slice, named so
// call sites read as intent ("the top 3"), not a magic `.slice(0, 3)`.
export function topDecisions(decisions: Decision[], n: number = 3): Decision[] {
  return decisions.slice(0, n);
}
