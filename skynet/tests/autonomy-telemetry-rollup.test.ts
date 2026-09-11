// Autonomy telemetry dashboard — pure rollup math, checked against
// hand-computed values (same style as home-metrics.test.ts: no store, no I/O,
// just the derivation).
import { describe, it, expect } from "vitest";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { AuditRecord, HitlItem, Project, Resolution, TaskRun } from "@skynet/shared";
import { computeAutonomyTelemetryRollup } from "../apps/server/src/autonomy-telemetry-rollup.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY_MS; // arbitrary fixed epoch, never Date.now()
const PROJECT_ID = "p1";

const mkProject = (over: Partial<Project> = {}): Project =>
  ({
    id: PROJECT_ID, workspaceId: DEFAULT_WORKSPACE, name: "Project One",
    autonomy: true, approvalLevel: "trusted", ...over,
  }) as Project;

const mkRun = (over: Partial<TaskRun> = {}): TaskRun =>
  ({
    id: "r1", workspaceId: DEFAULT_WORKSPACE, projectId: PROJECT_ID, name: "run", status: "done",
    mergedAt: null, ...over,
  }) as TaskRun;

const mkResolution = (over: Partial<Resolution> = {}): Resolution =>
  ({ action: "approve", by: "op-1", at: NOW, optionIndex: null, guidance: null, targetBranch: null, memoryNote: null, resetWork: false, ...over }) as Resolution;

const mkHitl = (over: Partial<HitlItem> = {}): HitlItem =>
  ({
    id: "h1", workspaceId: DEFAULT_WORKSPACE, runId: "r1", kind: "diff", title: "x", why: "x",
    raisedAt: NOW, resolvedAt: null, resolution: null, risk: "low", flags: [], ...over,
  }) as HitlItem;

const mkAudit = (over: Partial<AuditRecord> = {}): AuditRecord =>
  ({ workspaceId: DEFAULT_WORKSPACE, hitlId: "h1", runId: "r1", action: "approve", operatorId: "op-1", at: NOW, payload: null, ...over }) as AuditRecord;

describe("computeAutonomyTelemetryRollup — ZTMR", () => {
  it("a merged run with zero gates raised is trivially zero-touch", () => {
    const rollup = computeAutonomyTelemetryRollup({
      projects: [mkProject()],
      runs: [mkRun({ mergedAt: NOW })],
      queue: [],
      audit: [],
      windowDays: 30,
      now: NOW,
    });
    expect(rollup.totals.mergedCount).toBe(1);
    expect(rollup.totals.zeroTouchCount).toBe(1);
    expect(rollup.totals.ztmr).toBe(1);
  });

  it("a merged run whose only gate a human approved (no other action) is still zero-touch", () => {
    const rollup = computeAutonomyTelemetryRollup({
      projects: [mkProject()],
      runs: [mkRun({ mergedAt: NOW })],
      queue: [mkHitl({ resolvedAt: NOW, resolution: mkResolution({ action: "approve", by: "op-1" }) })],
      audit: [],
      windowDays: 30,
      now: NOW,
    });
    expect(rollup.totals.zeroTouchCount).toBe(1);
  });

  it("a merged run a human modified (not a plain approve) is touched", () => {
    const rollup = computeAutonomyTelemetryRollup({
      projects: [mkProject()],
      runs: [mkRun({ mergedAt: NOW })],
      queue: [mkHitl({ resolvedAt: NOW, resolution: mkResolution({ action: "modify", by: "op-1" }) })],
      audit: [],
      windowDays: 30,
      now: NOW,
    });
    expect(rollup.totals.zeroTouchCount).toBe(0);
    expect(rollup.totals.mergedCount).toBe(1);
    expect(rollup.totals.ztmr).toBe(0);
  });

  it("a policy or agent-review auto-resolution never counts as touching it, even a non-approve action", () => {
    const rollup = computeAutonomyTelemetryRollup({
      projects: [mkProject()],
      runs: [mkRun({ mergedAt: NOW })],
      queue: [
        mkHitl({ id: "h-policy", resolvedAt: NOW, resolution: mkResolution({ action: "dismiss", by: "policy:auto-merge" }) }),
        mkHitl({ id: "h-agent", resolvedAt: NOW, resolution: mkResolution({ action: "reject", by: "autonomy" }) }),
      ],
      audit: [],
      windowDays: 30,
      now: NOW,
    });
    expect(rollup.totals.zeroTouchCount).toBe(1);
  });

  it("zero-touch classification uses the run's WHOLE gate history, not just the reporting window", () => {
    const rollup = computeAutonomyTelemetryRollup({
      projects: [mkProject()],
      runs: [mkRun({ mergedAt: NOW })],
      // Raised/resolved 60 days before `now`, well outside the 30-day window —
      // still must count toward this merged run's touch classification.
      queue: [mkHitl({ raisedAt: NOW - 60 * DAY_MS, resolvedAt: NOW - 60 * DAY_MS, resolution: mkResolution({ action: "modify", by: "op-1" }) })],
      audit: [],
      windowDays: 30,
      now: NOW,
    });
    expect(rollup.totals.zeroTouchCount).toBe(0);
  });

  it("ztmr is null (not 0) when nothing merged in the window", () => {
    const rollup = computeAutonomyTelemetryRollup({ projects: [mkProject()], runs: [], queue: [], audit: [], windowDays: 30, now: NOW });
    expect(rollup.totals.mergedCount).toBe(0);
    expect(rollup.totals.ztmr).toBeNull();
  });

  it("a merge outside the window doesn't count", () => {
    const rollup = computeAutonomyTelemetryRollup({
      projects: [mkProject()],
      runs: [mkRun({ mergedAt: NOW - 40 * DAY_MS })],
      queue: [],
      audit: [],
      windowDays: 30,
      now: NOW,
    });
    expect(rollup.totals.mergedCount).toBe(0);
  });
});

describe("computeAutonomyTelemetryRollup — gate volume & resolution time", () => {
  it("counts raised/resolved within the window and averages resolution time", () => {
    const rollup = computeAutonomyTelemetryRollup({
      projects: [mkProject()],
      runs: [mkRun()],
      queue: [
        mkHitl({ id: "h1", raisedAt: NOW - 2 * DAY_MS, resolvedAt: NOW - DAY_MS, resolution: mkResolution() }), // 1 day
        mkHitl({ id: "h2", raisedAt: NOW - DAY_MS, resolvedAt: NOW, resolution: mkResolution() }), // 1 day
        mkHitl({ id: "h3", raisedAt: NOW, resolvedAt: null, resolution: null }), // still open
      ],
      audit: [],
      windowDays: 30,
      now: NOW,
    });
    expect(rollup.totals.gateRaisedCount).toBe(3);
    expect(rollup.totals.gateResolvedCount).toBe(2);
    expect(rollup.totals.avgResolutionMs).toBe(DAY_MS);
  });

  it("avgResolutionMs is null when nothing resolved in the window", () => {
    const rollup = computeAutonomyTelemetryRollup({
      projects: [mkProject()],
      runs: [mkRun()],
      queue: [mkHitl({ resolvedAt: null, resolution: null })],
      audit: [],
      windowDays: 30,
      now: NOW,
    });
    expect(rollup.totals.avgResolutionMs).toBeNull();
  });

  it("buckets gate volume by day, workspace-wide", () => {
    const rollup = computeAutonomyTelemetryRollup({
      projects: [mkProject()],
      runs: [mkRun()],
      queue: [
        mkHitl({ id: "h1", raisedAt: NOW - DAY_MS }),
        mkHitl({ id: "h2", raisedAt: NOW - DAY_MS }),
        mkHitl({ id: "h3", raisedAt: NOW }),
      ],
      audit: [],
      windowDays: 30,
      now: NOW,
    });
    expect(rollup.gateVolumeSeries.length).toBe(2);
    const sorted = [...rollup.gateVolumeSeries].sort((a, b) => a.bucketStart - b.bucketStart);
    expect(sorted[0].raised).toBe(2);
    expect(sorted[1].raised).toBe(1);
  });
});

describe("computeAutonomyTelemetryRollup — breaker trips/lifts", () => {
  it("attributes trip/lift audit records to the project via runId, within the window", () => {
    const rollup = computeAutonomyTelemetryRollup({
      projects: [mkProject()],
      runs: [mkRun()],
      queue: [],
      audit: [
        mkAudit({ action: "autonomy-breaker-tripped", at: NOW }),
        mkAudit({ action: "autonomy-breaker-lifted", at: NOW }),
        mkAudit({ action: "autonomy-breaker-tripped", at: NOW - 40 * DAY_MS }), // outside window
        mkAudit({ action: "approve", at: NOW }), // not a breaker event
      ],
      windowDays: 30,
      now: NOW,
    });
    expect(rollup.totals.breakerTrips).toBe(1);
    expect(rollup.totals.breakerLifts).toBe(1);
  });
});

describe("computeAutonomyTelemetryRollup — by project / by detent", () => {
  it("includes every scoped project even with zero activity, and groups by CURRENT detent", () => {
    const rollup = computeAutonomyTelemetryRollup({
      projects: [
        mkProject({ id: "p-shadow", name: "Shadow Co", autonomy: false, approvalLevel: "manual" }),
        mkProject({ id: "p-unattended", name: "Unattended Co", autonomy: true, approvalLevel: "full" }),
      ],
      runs: [],
      queue: [],
      audit: [],
      windowDays: 30,
      now: NOW,
    });
    expect(rollup.byProject.map((r) => r.projectId).sort()).toEqual(["p-shadow", "p-unattended"]);
    expect(rollup.byProject.find((r) => r.projectId === "p-shadow")!.detent).toBe("shadow");
    expect(rollup.byProject.find((r) => r.projectId === "p-unattended")!.detent).toBe("unattended");

    const byDetent = new Map(rollup.byDetent.map((r) => [r.detent, r]));
    expect(byDetent.get("shadow")!.projectCount).toBe(1);
    expect(byDetent.get("unattended")!.projectCount).toBe(1);
    expect(byDetent.get("assisted")!.projectCount).toBe(0);
    expect(byDetent.get("earned")!.projectCount).toBe(0);
    // All 4 detents always present, even ones with no projects — a stable
    // 4-row table/legend for the UI.
    expect(rollup.byDetent.map((r) => r.detent).sort()).toEqual(["assisted", "earned", "shadow", "unattended"]);
  });

  it("a gate/run whose project isn't in the caller's scope is silently dropped, not attributed", () => {
    const rollup = computeAutonomyTelemetryRollup({
      projects: [mkProject({ id: "p-visible" })],
      runs: [mkRun({ id: "r-hidden", projectId: "p-hidden", mergedAt: NOW })],
      queue: [mkHitl({ runId: "r-hidden", raisedAt: NOW })],
      audit: [],
      windowDays: 30,
      now: NOW,
    });
    expect(rollup.totals.mergedCount).toBe(0);
    expect(rollup.totals.gateRaisedCount).toBe(0);
  });

  it("no accessible projects returns an empty rollup rather than throwing", () => {
    const rollup = computeAutonomyTelemetryRollup({ projects: [], runs: [], queue: [], audit: [], windowDays: 30, now: NOW });
    expect(rollup.byProject).toEqual([]);
    expect(rollup.byDetent).toEqual([]);
    expect(rollup.totals.ztmr).toBeNull();
  });
});
