// ─── Roadmap drift & health metrics (Phase 28 — TASK 31) ────────────────────
// Promise vs. measured delivery, per roadmap line. Pure, dependency-free math
// over TASK 27's parsed RoadmapDoc + existing Task/Transition data — kept
// separate from roadmap-drift.tsx (the rendering layer), same split
// health-metrics.ts/health.tsx already established: `now` is always an
// explicit param, never `Date.now()` inside, so a hand-computed expected
// value always matches (this task's own acceptance bar).
//
// "Measured delivery" is read from the roadmap line's LINKED TASKS
// (`RoadmapLine.taskIds`), never from the line's own markdown checkbox
// (`RoadmapLine.state`) — the checkbox is whatever a human or agent last
// typed into ROADMAP.md, exactly the kind of thing this feature exists to
// audit against reality, so trusting it here would defeat the point.
import type { RoadmapChecklistItemNode, RoadmapDoc, Task, Transition } from "@skynet/shared";

const DAY_MS = 24 * 60 * 60 * 1000;

// ─── 1. Per-line forecast (extends health-metrics.ts's forecastBacklogClear
//        approach — trailing-7d landing rate projected forward — scoped to
//        just one line's own linked tasks) ─────────────────────────────────
export interface LineForecast {
  /** false only when the line has zero linked tasks — nothing to measure at
   *  all, an explicit state rather than a fake 0%/date (this task's own
   *  instruction). A line WITH tasks but no recent landings is still
   *  `forecastable: true` (delivered/in-flight % are real data); only its
   *  `etaAt` goes null in that case. */
  forecastable: boolean;
  totalTasks: number;
  doneTasks: number;
  inFlightTasks: number;
  /** 0–100, or null when unforecastable. */
  deliveredPct: number | null;
  inFlightPct: number | null;
  /** Trailing-7d landing rate among this line's own tasks — the point
   *  estimate forecastBacklogClear itself uses (its own comment: "the most
   *  recent week's landing rate"). */
  recentRatePerDay: number | null;
  /** Projected completion date (epoch ms) — `now` itself when every linked
   *  task is already done, a forward projection when some remain and the
   *  recent rate is positive, or null when nothing can be projected (no
   *  tasks, or tasks but zero recent landings to extrapolate from). */
  etaAt: number | null;
  /** The latest `to:"done"` transition among this line's tasks, only set
   *  once EVERY linked task is done — when the line actually finished. */
  completedAt: number | null;
}

export function forecastRoadmapLine(line: RoadmapChecklistItemNode, tasks: Task[], transitions: Transition[], now: number): LineForecast {
  const lineTaskIds = new Set(line.taskIds);
  const lineTasks = tasks.filter((t) => lineTaskIds.has(t.id));
  if (lineTasks.length === 0) {
    return { forecastable: false, totalTasks: 0, doneTasks: 0, inFlightTasks: 0, deliveredPct: null, inFlightPct: null, recentRatePerDay: null, etaAt: null, completedAt: null };
  }

  const doneTasks = lineTasks.filter((t) => t.state === "done").length;
  const inFlightTasks = lineTasks.filter((t) => t.state === "ongoing" || t.state === "review").length;
  const remaining = lineTasks.length - doneTasks;

  const landed = transitions.filter((t) => t.to === "done" && lineTaskIds.has(t.taskId));
  // (fromExclusive, toInclusive] — same window convention forecastBacklogClear uses.
  const recentRatePerDay = landed.filter((t) => t.at > now - 7 * DAY_MS && t.at <= now).length / 7;

  let etaAt: number | null;
  let completedAt: number | null = null;
  if (remaining <= 0) {
    etaAt = now;
    completedAt = landed.length > 0 ? Math.max(...landed.map((t) => t.at)) : now;
  } else {
    etaAt = recentRatePerDay > 0 ? now + (remaining / recentRatePerDay) * DAY_MS : null;
  }

  return {
    forecastable: true,
    totalTasks: lineTasks.length,
    doneTasks,
    inFlightTasks,
    deliveredPct: Math.round((doneTasks / lineTasks.length) * 100),
    inFlightPct: Math.round((inFlightTasks / lineTasks.length) * 100),
    recentRatePerDay,
    etaAt,
    completedAt,
  };
}

// ─── 2. Roadmap health metrics — pure derivations over the parsed doc ──────
export interface RoadmapHealthMetrics {
  totalLines: number;
  linesWithTasks: number;
  linesWithCriteria: number;
  /** Tasks with no roadmap line linking to them — the reverse join. */
  orphanTasks: Task[];
  staleLines: StaleLine[];
}

export interface StaleLine {
  line: RoadmapChecklistItemNode;
  /** The last relevant transition among the line's linked tasks, or the
   *  line's own `addedAt` when it has no tasks — whichever this staleness
   *  reading is actually anchored to. */
  lastActivityAt: number;
  staleMs: number;
}

export const STALE_LINE_THRESHOLD_MS = 30 * DAY_MS;

function allChecklistItems(doc: RoadmapDoc): RoadmapChecklistItemNode[] {
  return doc.ast.filter((n): n is RoadmapChecklistItemNode => n.type === "checklistItem");
}

export function roadmapHealthMetrics(doc: RoadmapDoc, tasks: Task[], transitions: Transition[], now: number): RoadmapHealthMetrics {
  const lines = allChecklistItems(doc);
  const linkedTaskIds = new Set(lines.flatMap((l) => l.taskIds));

  const linesWithTasks = lines.filter((l) => l.taskIds.length > 0).length;
  const linesWithCriteria = lines.filter((l) => !!l.acceptanceCriteria).length;
  const orphanTasks = tasks.filter((t) => !t.archived && !linkedTaskIds.has(t.id));

  const lastTransitionByTask = new Map<string, number>();
  for (const t of transitions) {
    const prev = lastTransitionByTask.get(t.taskId);
    if (prev == null || t.at > prev) lastTransitionByTask.set(t.taskId, t.at);
  }

  const staleLines: StaleLine[] = [];
  for (const line of lines) {
    let lastActivityAt: number | null;
    if (line.taskIds.length === 0) {
      lastActivityAt = line.addedAt;
    } else {
      const activityTimes = line.taskIds.map((id) => lastTransitionByTask.get(id)).filter((t): t is number => t != null);
      lastActivityAt = activityTimes.length > 0 ? Math.max(...activityTimes) : null;
    }
    if (lastActivityAt == null) continue; // nothing to judge staleness from — excluded, not assumed stale
    const staleMs = now - lastActivityAt;
    if (staleMs > STALE_LINE_THRESHOLD_MS) staleLines.push({ line, lastActivityAt, staleMs });
  }
  staleLines.sort((a, b) => b.staleMs - a.staleMs);

  return { totalLines: lines.length, linesWithTasks, linesWithCriteria, orphanTasks, staleLines };
}

// ─── 3. Verdict — the spec's exact 5 words ─────────────────────────────────
export type DriftVerdict = "landed early" | "on the date" | "cut or re-date" | "write the brief" | "no date yet";

export function verdictForLine(line: RoadmapChecklistItemNode, forecast: LineForecast): DriftVerdict {
  if (line.promisedDate == null) return "no date yet";
  if (!forecast.forecastable) return "write the brief"; // a promise with no linked tasks — nothing to plan against yet
  const delivered = forecast.doneTasks === forecast.totalTasks;
  if (delivered) {
    return forecast.completedAt != null && forecast.completedAt <= line.promisedDate ? "landed early" : "on the date";
  }
  if (forecast.etaAt != null && forecast.etaAt <= line.promisedDate) return "on the date";
  return "cut or re-date"; // still in flight and either projected late, or too stalled to project at all
}

// ─── 4. One drift row — everything a row of the table needs, computed once ─
export interface DriftRow {
  line: RoadmapChecklistItemNode;
  forecast: LineForecast;
  verdict: DriftVerdict;
  /** Whole days late the forecast eta sits beyond the promised date — only
   *  set for a "cut or re-date" row with a real (non-null) eta; null for a
   *  stalled row with no eta to compare (still late, just not a number). */
  lateDays: number | null;
}

export function driftRows(doc: RoadmapDoc, tasks: Task[], transitions: Transition[], now: number): DriftRow[] {
  return allChecklistItems(doc).map((line) => {
    const forecast = forecastRoadmapLine(line, tasks, transitions, now);
    const verdict = verdictForLine(line, forecast);
    const lateDays =
      verdict === "cut or re-date" && forecast.etaAt != null && line.promisedDate != null
        ? Math.ceil((forecast.etaAt - line.promisedDate) / DAY_MS)
        : null;
    return { line, forecast, verdict, lateDays };
  });
}

// ─── 5. "One decision would fix the quarter" ───────────────────────────────
// The single highest-leverage call: among every "cut or re-date" row (the
// only verdict with a concrete, actionable lateness), the one combining the
// most lateness with the most downstream blocking — tasks elsewhere in the
// project that name one of this line's own tasks in their own
// `dependsOnTaskIds` (the reverse of that field, same "reverse join" idiom
// `roadmapHealthMetrics`'s orphanTasks already uses).
export interface OneDecision {
  row: DriftRow;
  lateDays: number;
  blockingTaskCount: number;
  score: number;
}

// A stalled "cut or re-date" row (no eta to measure lateness from at all) is
// treated as maximally late — it's worse news than any row still producing a
// concrete (if late) projection, not better.
const UNFORECASTABLE_LATE_DAYS = 3650;

function downstreamBlockingCount(line: RoadmapChecklistItemNode, tasks: Task[]): number {
  const lineTaskIds = new Set(line.taskIds);
  if (lineTaskIds.size === 0) return 0;
  return tasks.filter((t) => t.dependsOnTaskIds.some((id) => lineTaskIds.has(id))).length;
}

export function oneDecision(rows: DriftRow[], tasks: Task[]): OneDecision | null {
  const candidates = rows.filter((r) => r.verdict === "cut or re-date");
  if (candidates.length === 0) return null;
  const scored = candidates.map((row) => {
    const lateDays = row.lateDays ?? UNFORECASTABLE_LATE_DAYS;
    const blockingTaskCount = downstreamBlockingCount(row.line, tasks);
    return { row, lateDays, blockingTaskCount, score: lateDays + blockingTaskCount };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]!;
}
