// ─── Autonomy telemetry dashboard — pure rollup (roadmap: "Autonomy telemetry
// dashboard — ZTMR, HITL volume, resolution time") ──────────────────────────
// Pure aggregation over already-fetched collections — no store/live access
// here, so it's unit-testable without a database. See
// packages/shared/src/autonomy-telemetry.ts for the output shapes and
// Operations.getAutonomyTelemetryRollup (operations.ts) for the store reads
// + project-scoping this is wired into.

import type { AuditRecord, AutonomyDetent, AutonomyTelemetryRollup, AutonomyTelemetryStats, HitlItem, Project, TaskRun } from "@skynet/shared";
import { AUTONOMY_DETENTS, detentFor } from "@skynet/shared";

const DAY_MS = 24 * 60 * 60 * 1000;

interface StatsAccum {
  mergedCount: number;
  zeroTouchCount: number;
  gateRaisedCount: number;
  gateResolvedCount: number;
  resolutionMsSum: number;
  resolvedWithTimingCount: number;
  breakerTrips: number;
  breakerLifts: number;
}

function emptyAccum(): StatsAccum {
  return {
    mergedCount: 0,
    zeroTouchCount: 0,
    gateRaisedCount: 0,
    gateResolvedCount: 0,
    resolutionMsSum: 0,
    resolvedWithTimingCount: 0,
    breakerTrips: 0,
    breakerLifts: 0,
  };
}

function mergeAccum(into: StatsAccum, from: StatsAccum): void {
  into.mergedCount += from.mergedCount;
  into.zeroTouchCount += from.zeroTouchCount;
  into.gateRaisedCount += from.gateRaisedCount;
  into.gateResolvedCount += from.gateResolvedCount;
  into.resolutionMsSum += from.resolutionMsSum;
  into.resolvedWithTimingCount += from.resolvedWithTimingCount;
  into.breakerTrips += from.breakerTrips;
  into.breakerLifts += from.breakerLifts;
}

function finalizeAccum(a: StatsAccum): AutonomyTelemetryStats {
  return {
    mergedCount: a.mergedCount,
    zeroTouchCount: a.zeroTouchCount,
    ztmr: a.mergedCount > 0 ? a.zeroTouchCount / a.mergedCount : null,
    gateRaisedCount: a.gateRaisedCount,
    gateResolvedCount: a.gateResolvedCount,
    avgResolutionMs: a.resolvedWithTimingCount > 0 ? Math.round(a.resolutionMsSum / a.resolvedWithTimingCount) : null,
    breakerTrips: a.breakerTrips,
    breakerLifts: a.breakerLifts,
  };
}

/** "No operator action beyond an Approve click" (the roadmap brief's own
 *  wording) — auto-resolutions (policy:*, the "autonomy" agent-review path)
 *  never count as a human touching the run, whatever their action. */
function isHumanOperator(by: string): boolean {
  return !by.startsWith("policy:") && by !== "autonomy" && by !== "system";
}

const dayStart = (t: number) => t - (t % DAY_MS);

export interface AutonomyTelemetryInput {
  /** Already project-scoped (see projectScope in mcp/project-scope.ts) —
   *  this function does no access-control filtering of its own. */
  projects: Pick<Project, "id" | "name" | "autonomy" | "approvalLevel">[];
  runs: Pick<TaskRun, "id" | "projectId" | "mergedAt">[];
  /** Every HitlItem ever raised for a scoped project — NOT pre-filtered to
   *  the window; zero-touch classification needs a merged run's whole gate
   *  history, not just whatever fell inside the reporting window. */
  queue: Pick<HitlItem, "runId" | "raisedAt" | "resolvedAt" | "resolution">[];
  audit: Pick<AuditRecord, "runId" | "action" | "at">[];
  windowDays: number;
  now: number;
}

/** Compute the whole dashboard payload from already-fetched, already-scoped
 *  collections. Every count/average is windowed to `[now - windowDays, now]`
 *  EXCEPT the zero-touch classification (see `queue` doc above). Rows are
 *  attributed to a project by joining `runId → run.projectId` — a gate whose
 *  `runId` isn't in `runs` (a vanished run) is silently dropped, same
 *  best-effort join precedent as `Operations.listDecisions`/the compliance
 *  report. Detent breakdown uses each project's CURRENT detent only — the
 *  dial has no change-history to attribute a past gate to the notch that was
 *  actually active when it was raised (see `detentFor`'s own doc comment). */
export function computeAutonomyTelemetryRollup(input: AutonomyTelemetryInput): AutonomyTelemetryRollup {
  const { projects, runs, queue, audit, now } = input;
  const windowDays = Math.min(Math.max(Math.trunc(input.windowDays) || 30, 1), 90);
  const since = now - windowDays * DAY_MS;

  if (projects.length === 0) {
    return { windowDays, since, generatedAt: now, totals: finalizeAccum(emptyAccum()), byProject: [], byDetent: [], gateVolumeSeries: [] };
  }

  const projectIds = new Set(projects.map((p) => p.id));
  const runById = new Map(runs.map((r) => [r.id, r]));

  const gatesByRunId = new Map<string, AutonomyTelemetryInput["queue"]>();
  for (const item of queue) {
    const run = runById.get(item.runId);
    if (!run || !projectIds.has(run.projectId)) continue;
    const arr = gatesByRunId.get(item.runId);
    if (arr) arr.push(item);
    else gatesByRunId.set(item.runId, [item]);
  }
  const runIsTouched = (runId: string): boolean =>
    (gatesByRunId.get(runId) ?? []).some((g) => g.resolution && g.resolution.action !== "approve" && isHumanOperator(g.resolution.by));

  const accumByProject = new Map(projects.map((p) => [p.id, emptyAccum()]));
  const bucketByDay = new Map<number, { raised: number; resolved: number }>();
  const bumpBucket = (t: number, field: "raised" | "resolved") => {
    const key = dayStart(t);
    const b = bucketByDay.get(key) ?? { raised: 0, resolved: 0 };
    b[field]++;
    bucketByDay.set(key, b);
  };

  for (const run of runs) {
    if (!projectIds.has(run.projectId) || run.mergedAt == null || run.mergedAt < since) continue;
    const proj = accumByProject.get(run.projectId)!;
    proj.mergedCount++;
    if (!runIsTouched(run.id)) proj.zeroTouchCount++;
  }

  for (const item of queue) {
    const run = runById.get(item.runId);
    if (!run || !projectIds.has(run.projectId)) continue;
    const proj = accumByProject.get(run.projectId)!;
    if (item.raisedAt >= since) {
      proj.gateRaisedCount++;
      bumpBucket(item.raisedAt, "raised");
    }
    if (item.resolvedAt != null && item.resolvedAt >= since) {
      proj.gateResolvedCount++;
      bumpBucket(item.resolvedAt, "resolved");
      const ms = item.resolvedAt - item.raisedAt;
      if (ms >= 0) {
        proj.resolutionMsSum += ms;
        proj.resolvedWithTimingCount++;
      }
    }
  }

  for (const rec of audit) {
    if (rec.action !== "autonomy-breaker-tripped" && rec.action !== "autonomy-breaker-lifted") continue;
    if (rec.at < since) continue;
    const run = runById.get(rec.runId);
    if (!run || !projectIds.has(run.projectId)) continue;
    const proj = accumByProject.get(run.projectId)!;
    if (rec.action === "autonomy-breaker-tripped") proj.breakerTrips++;
    else proj.breakerLifts++;
  }

  const totalsAccum = emptyAccum();
  for (const a of accumByProject.values()) mergeAccum(totalsAccum, a);

  const byProject: AutonomyTelemetryRollup["byProject"] = projects
    .map((p) => ({ projectId: p.id, projectName: p.name, detent: detentFor(p), ...finalizeAccum(accumByProject.get(p.id)!) }))
    .sort((a, b) => a.projectName.localeCompare(b.projectName));

  const detentAccum = new Map<AutonomyDetent, { accum: StatsAccum; projectCount: number }>(AUTONOMY_DETENTS.map((d) => [d, { accum: emptyAccum(), projectCount: 0 }]));
  for (const p of projects) {
    const bucket = detentAccum.get(detentFor(p))!;
    bucket.projectCount++;
    mergeAccum(bucket.accum, accumByProject.get(p.id)!);
  }
  const byDetent: AutonomyTelemetryRollup["byDetent"] = AUTONOMY_DETENTS.map((d) => {
    const bucket = detentAccum.get(d)!;
    return { detent: d, projectCount: bucket.projectCount, ...finalizeAccum(bucket.accum) };
  });

  const gateVolumeSeries: AutonomyTelemetryRollup["gateVolumeSeries"] = [...bucketByDay.entries()]
    .sort(([a], [b]) => a - b)
    .map(([bucketStart, v]) => ({ bucketStart, ...v }));

  return { windowDays, since, generatedAt: now, totals: finalizeAccum(totalsAccum), byProject, byDetent, gateVolumeSeries };
}
