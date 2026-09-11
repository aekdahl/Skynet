// ─── Autonomy telemetry dashboard (roadmap: "Autonomy telemetry dashboard —
// ZTMR, HITL volume, resolution time") ──────────────────────────────────────
// A read-only rollup over data that already exists: HitlItem raise/resolve
// (store.listQueue), the audit trail's breaker trip/lift records
// (store.listAudit, action "autonomy-breaker-tripped"/"-lifted"), and
// TaskRun.mergedAt. No new write path — see Operations.getAutonomyTelemetryRollup
// for the actual computation; this file is just the response shape, following
// the same "one server rollup, one typed payload" template as
// RoadmapWorkspaceRollup (roadmap-doc.ts).

import { z } from "zod";
import { AutonomyDetent } from "./autonomy.js";
import { Timestamp } from "./contracts.js";

/** One day-bucket of workspace-wide gate activity — the "HITL gate volume
 *  over time" chart's raw series. `bucketStart` is that day's midnight (local
 *  server time), so a caller renders `windowDays` consecutive bars/points. */
export const AutonomyTelemetryBucket = z.object({
  bucketStart: Timestamp,
  raised: z.number().int().nonnegative(),
  resolved: z.number().int().nonnegative(),
});
export type AutonomyTelemetryBucket = z.infer<typeof AutonomyTelemetryBucket>;

/** Shared shape for a rollup slice — one project row, one detent row, or the
 *  workspace-wide totals row all carry the same fields, so the UI renders
 *  them with one component. `ztmr`/`avgResolutionMs` are null (not 0) when
 *  their denominator is empty — "no data yet" must never render as "0%". */
export const AutonomyTelemetryStats = z.object({
  mergedCount: z.number().int().nonnegative(),
  // A merged run counts as zero-touch when no HUMAN resolution on any of its
  // HITL gates was anything other than a plain "approve" — see the roadmap
  // brief's own wording ("no operator action beyond an Approve click"). A
  // run with zero gates raised at all is trivially zero-touch too.
  zeroTouchCount: z.number().int().nonnegative(),
  ztmr: z.number().min(0).max(1).nullable(),
  gateRaisedCount: z.number().int().nonnegative(),
  gateResolvedCount: z.number().int().nonnegative(),
  avgResolutionMs: z.number().nonnegative().nullable(),
  breakerTrips: z.number().int().nonnegative(),
  breakerLifts: z.number().int().nonnegative(),
});
export type AutonomyTelemetryStats = z.infer<typeof AutonomyTelemetryStats>;

export const AutonomyTelemetryProjectRow = AutonomyTelemetryStats.extend({
  projectId: z.string(),
  projectName: z.string(),
  // The project's CURRENT detent only — the dial has no change history (see
  // Operations.updateProject), so a gate raised last week under a different
  // detent is still attributed to today's. Documented gap, not a bug.
  detent: AutonomyDetent,
});
export type AutonomyTelemetryProjectRow = z.infer<typeof AutonomyTelemetryProjectRow>;

export const AutonomyTelemetryDetentRow = AutonomyTelemetryStats.extend({
  detent: AutonomyDetent,
  projectCount: z.number().int().nonnegative(),
});
export type AutonomyTelemetryDetentRow = z.infer<typeof AutonomyTelemetryDetentRow>;

export const AutonomyTelemetryRollup = z.object({
  windowDays: z.number().int().positive(),
  since: Timestamp,
  generatedAt: Timestamp,
  totals: AutonomyTelemetryStats,
  byProject: z.array(AutonomyTelemetryProjectRow),
  byDetent: z.array(AutonomyTelemetryDetentRow),
  gateVolumeSeries: z.array(AutonomyTelemetryBucket),
});
export type AutonomyTelemetryRollup = z.infer<typeof AutonomyTelemetryRollup>;
