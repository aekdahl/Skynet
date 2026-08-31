// Momentum Rollout kanban rebuild, Phase 0 — the two pure functions the new
// board's presentation layer derives from: readiness() (a 0..1 progress
// score) and columnBucket() (the existing six-state TaskState mapped onto the
// new board's four columns). Both are pure (no I/O, `now` passed explicitly)
// so scoring is deterministic and reproducible here.
import { describe, it, expect } from "vitest";
import { readiness, columnBucket, type TaskCheckpoints } from "@skynet/shared";
import type { Task, TaskState } from "@skynet/shared";

const mkTask = (state: TaskState): Task =>
  ({
    id: "t1", workspaceId: "ws1", projectId: "p1", text: "do X", state,
    runId: null, autoPick: false, assessment: null, reviewVerdict: null, lint: null,
    assignment: { mode: "any", agentIds: [] },
  }) as Task;

const NOW = 1_000_000_000_000; // fixed instant — every test's "now"
const noCheckpoints: TaskCheckpoints = {
  branch: false, pr: false, review: false, merged: false, deployed: false, lastSignalAt: NOW,
};

describe("columnBucket", () => {
  // Every TaskState maps to exactly the column the spec names — a pure
  // presentation mapping over the existing state machine, not a new one.
  const cases: [TaskState, string][] = [
    ["backlog", "intake"],
    ["triage", "intake"],
    ["todo", "queued"],
    ["ongoing", "in_flight"],
    ["review", "in_flight"],
    ["done", "landed"],
  ];
  it.each(cases)("%s → %s", (state, bucket) => {
    expect(columnBucket(mkTask(state), noCheckpoints)).toBe(bucket);
  });

  it("checkpoints never change the bucket for a given state — Phase 0's mapping is state-only", () => {
    const allDone: TaskCheckpoints = { branch: true, pr: true, review: true, merged: true, deployed: true, lastSignalAt: NOW };
    for (const [state, bucket] of cases) {
      expect(columnBucket(mkTask(state), allDone)).toBe(bucket);
      expect(columnBucket(mkTask(state), noCheckpoints)).toBe(bucket);
    }
  });
});

describe("readiness", () => {
  it("no stages reached, fresh signal → score 0, every breakdown entry 0, no decay", () => {
    const r = readiness(mkTask("todo"), noCheckpoints, NOW);
    expect(r.score).toBe(0);
    expect(r.breakdown).toEqual({ branch: 0, pr: 0, review: 0, merged: 0, deployed: 0 });
    expect(r.decay).toBe(0);
  });

  it("every stage reached, fresh signal → score 1 (5 × 0.2), full breakdown", () => {
    const all: TaskCheckpoints = { branch: true, pr: true, review: true, merged: true, deployed: true, lastSignalAt: NOW };
    const r = readiness(mkTask("done"), all, NOW);
    expect(r.score).toBe(1);
    expect(r.breakdown).toEqual({ branch: 0.2, pr: 0.2, review: 0.2, merged: 0.2, deployed: 0.2 });
    expect(r.decay).toBe(0);
  });

  // Each stage contributes exactly 0.2, independent of the others — same
  // checkpoint-stage coverage columnBucket's TaskState cases get above.
  const stages: (keyof Omit<TaskCheckpoints, "lastSignalAt">)[] = ["branch", "pr", "review", "merged", "deployed"];
  it.each(stages)("a single '%s' stage alone contributes exactly 0.2, nothing else", (stage) => {
    const checkpoints: TaskCheckpoints = { branch: false, pr: false, review: false, merged: false, deployed: false, lastSignalAt: NOW, [stage]: true };
    const r = readiness(mkTask("ongoing"), checkpoints, NOW);
    expect(r.score).toBeCloseTo(0.2, 10);
    expect(r.breakdown[stage]).toBe(0.2);
    for (const other of stages) if (other !== stage) expect(r.breakdown[other]).toBe(0);
  });

  it("a partial run (branch + pr) sums to 0.4, only those two stages in the breakdown", () => {
    const checkpoints: TaskCheckpoints = { branch: true, pr: true, review: false, merged: false, deployed: false, lastSignalAt: NOW };
    const r = readiness(mkTask("ongoing"), checkpoints, NOW);
    expect(r.score).toBeCloseTo(0.4, 10);
    expect(r.breakdown).toEqual({ branch: 0.2, pr: 0.2, review: 0, merged: 0, deployed: 0 });
  });

  // ── staleness decay ──────────────────────────────────────────────────────
  const DAY = 24 * 60 * 60 * 1000;
  const allDoneAt = (lastSignalAt: number): TaskCheckpoints => ({
    branch: true, pr: true, review: true, merged: true, deployed: true, lastSignalAt,
  });

  it("no decay inside the grace window (< 1 day of silence)", () => {
    const r = readiness(mkTask("done"), allDoneAt(NOW - DAY), NOW);
    expect(r.decay).toBe(0);
    expect(r.score).toBe(1);
  });

  it("decay grows once past the grace window", () => {
    const r = readiness(mkTask("done"), allDoneAt(NOW - 2 * DAY), NOW);
    expect(r.decay).toBeGreaterThan(0);
    expect(r.decay).toBeLessThan(0.3); // not yet at the cap
    expect(r.score).toBeCloseTo(1 - r.decay, 10);
  });

  it("decay is capped — never erases all earned progress, however stale", () => {
    const r = readiness(mkTask("done"), allDoneAt(NOW - 365 * DAY), NOW);
    expect(r.decay).toBeCloseTo(0.3, 10);
    expect(r.score).toBeCloseTo(0.7, 10);
  });

  it("score never goes negative even with little progress and heavy decay", () => {
    const stale: TaskCheckpoints = { branch: true, pr: false, review: false, merged: false, deployed: false, lastSignalAt: NOW - 365 * DAY };
    const r = readiness(mkTask("ongoing"), stale, NOW);
    expect(r.score).toBe(0); // 0.2 stage sum − 0.3 max decay, clamped at 0
    expect(r.score).toBeGreaterThanOrEqual(0);
  });

  it("score is always clamped to [0, 1]", () => {
    const r = readiness(mkTask("done"), allDoneAt(NOW), NOW);
    expect(r.score).toBeLessThanOrEqual(1);
    expect(r.score).toBeGreaterThanOrEqual(0);
  });
});
