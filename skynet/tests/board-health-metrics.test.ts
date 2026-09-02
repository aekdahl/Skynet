// Momentum Rollout Phase 7 (TASK 09) — Board Health's pure math, checked
// against hand-computed values for a small seeded Task/Transition/Rule
// fixture set (this task's own acceptance bar: "numbers on this dashboard
// match hand-computed values from the same underlying Transition data").
import { describe, it, expect } from "vitest";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { Task, Transition, Rule } from "@skynet/shared";
import {
  automationRate,
  cycleTimeMedianMs,
  stalledTasks,
  forecastBacklogClear,
  medianTimePerBucket,
  rulePerformance,
  STALLED_THRESHOLD_MS,
  UNDO_RATE_FLAG_THRESHOLD,
} from "../apps/web/src/kanban/health-metrics.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const PROJECT_ID = "p1";
const NOW = 100 * DAY_MS; // an arbitrary fixed epoch — never Date.now()

const mkTask = (over: Partial<Task> = {}): Task =>
  ({
    id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: PROJECT_ID, text: "x", state: "backlog",
    runId: null, autoPick: false, assessment: null, reviewVerdict: null, lint: null, priority: null,
    assignment: { mode: "any", agentIds: [] }, archived: false, ...over,
  }) as Task;

const mkTr = (over: Partial<Transition> & Pick<Transition, "taskId" | "from" | "to" | "at">): Transition => ({
  id: `tr-${Math.random()}`, workspaceId: DEFAULT_WORKSPACE, projectId: PROJECT_ID,
  actor: "machine", actorId: null, ruleId: null, evidence: [], ...over,
});

describe("automationRate", () => {
  it("matches a hand count: 3 machine / 4 total in the trailing 7d window", () => {
    const transitions = [
      mkTr({ taskId: "a", from: "todo", to: "ongoing", actor: "machine", at: NOW - 1 * DAY_MS }),
      mkTr({ taskId: "b", from: "todo", to: "ongoing", actor: "machine", at: NOW - 2 * DAY_MS }),
      mkTr({ taskId: "c", from: "ongoing", to: "review", actor: "machine", at: NOW - 3 * DAY_MS }),
      mkTr({ taskId: "d", from: "review", to: "done", actor: "human", at: NOW - 4 * DAY_MS }),
      // Outside the 7d window — must not count either way.
      mkTr({ taskId: "e", from: "todo", to: "ongoing", actor: "human", at: NOW - 9 * DAY_MS }),
    ];
    const result = automationRate(transitions, NOW);
    expect(result).toEqual({ pct: 75, machineCount: 3, totalCount: 4 });
  });

  it("reports null (not 0) when the window has zero transitions", () => {
    expect(automationRate([], NOW)).toEqual({ pct: null, machineCount: 0, totalCount: 0 });
  });
});

describe("cycleTimeMedianMs", () => {
  it("matches a hand-computed median across 3 tasks: durations 2d, 4d, 6d → median 4d", () => {
    const transitions = [
      // Task a: queued at day0, landed at day2 → 2d
      mkTr({ taskId: "a", from: "triage", to: "todo", at: 0 }),
      mkTr({ taskId: "a", from: "todo", to: "ongoing", at: 0.5 * DAY_MS }),
      mkTr({ taskId: "a", from: "ongoing", to: "done", at: 2 * DAY_MS }),
      // Task b: queued at day1, landed at day5 → 4d
      mkTr({ taskId: "b", from: "triage", to: "todo", at: 1 * DAY_MS }),
      mkTr({ taskId: "b", from: "todo", to: "done", at: 5 * DAY_MS }),
      // Task c: queued at day0, landed at day6 → 6d
      mkTr({ taskId: "c", from: "backlog", to: "todo", at: 0 }),
      mkTr({ taskId: "c", from: "todo", to: "done", at: 6 * DAY_MS }),
      // Task d: never queued (jumped straight to done) — excluded, not zero.
      mkTr({ taskId: "d", from: "backlog", to: "done", at: 1 * DAY_MS }),
      // Task e: queued but never landed — excluded.
      mkTr({ taskId: "e", from: "triage", to: "todo", at: 0 }),
    ];
    const result = cycleTimeMedianMs(transitions);
    expect(result.sampleSize).toBe(3);
    expect(result.medianMs).toBe(4 * DAY_MS);
  });

  it("returns null with zero sample size when nothing qualifies", () => {
    expect(cycleTimeMedianMs([])).toEqual({ medianMs: null, sampleSize: 0 });
  });
});

describe("stalledTasks", () => {
  it("flags exactly the tasks seeded to trigger it: >48h since their last transition AND currently in flight", () => {
    const tasks = [
      mkTask({ id: "stale-ongoing", state: "ongoing" }), // last moved 72h ago — STALLED
      mkTask({ id: "stale-review", state: "review" }), // last moved 50h ago — STALLED
      mkTask({ id: "fresh-ongoing", state: "ongoing" }), // last moved 10h ago — not stalled
      mkTask({ id: "stale-but-todo", state: "todo" }), // last moved 200h ago, but not "in flight" — not stalled
      mkTask({ id: "no-signal", state: "ongoing" }), // no transition at all — excluded, not assumed stalled
    ];
    const transitions = [
      mkTr({ taskId: "stale-ongoing", from: "todo", to: "ongoing", at: NOW - 72 * 60 * 60 * 1000 }),
      mkTr({ taskId: "stale-review", from: "ongoing", to: "review", at: NOW - 50 * 60 * 60 * 1000 }),
      mkTr({ taskId: "fresh-ongoing", from: "todo", to: "ongoing", at: NOW - 10 * 60 * 60 * 1000 }),
      mkTr({ taskId: "stale-but-todo", from: "triage", to: "todo", at: NOW - 200 * 60 * 60 * 1000 }),
    ];
    const result = stalledTasks(tasks, transitions, NOW);
    expect(result.map((s) => s.task.id)).toEqual(["stale-ongoing", "stale-review"]); // most-stale first
    expect(result[0]!.staleMs).toBeGreaterThan(STALLED_THRESHOLD_MS);
  });

  it("a task exactly AT the threshold is not flagged (strictly greater than 48h)", () => {
    const tasks = [mkTask({ id: "a", state: "ongoing" })];
    const transitions = [mkTr({ taskId: "a", from: "todo", to: "ongoing", at: NOW - STALLED_THRESHOLD_MS })];
    expect(stalledTasks(tasks, transitions, NOW)).toEqual([]);
  });
});

describe("forecastBacklogClear", () => {
  it("matches a hand computation: backlog 20, trailing-7d rate 7/7=1/day → 20 days", () => {
    const tasks = Array.from({ length: 20 }, (_, i) => mkTask({ id: `open-${i}`, state: "todo" }))
      .concat(Array.from({ length: 5 }, (_, i) => mkTask({ id: `done-${i}`, state: "done" })));
    const transitions = Array.from({ length: 7 }, (_, i) =>
      mkTr({ taskId: `land-${i}`, from: "review", to: "done", at: NOW - i * DAY_MS }),
    );
    const result = forecastBacklogClear(tasks, transitions, NOW);
    expect(result.backlogCount).toBe(20); // "done" tasks excluded from backlog
    expect(result.recentRatePerDay).toBe(1);
    expect(result.daysEstimate).toBe(20);
  });

  it("returns null estimates (not Infinity/NaN) when nothing has landed recently", () => {
    const result = forecastBacklogClear([mkTask({ state: "todo" })], [], NOW);
    expect(result.daysEstimate).toBeNull();
    expect(result.daysLow).toBeNull();
    expect(result.daysHigh).toBeNull();
  });

  it("a widening band when the recent rate differs from the prior week's", () => {
    // Prior week (7 distinct days, 2/day = 14 landings). Recent week (7
    // distinct days, 1/day = 7 landings) — rate slowed.
    const transitions = [
      ...Array.from({ length: 7 }, (_, i) => mkTr({ taskId: `recent-${i}`, from: "review", to: "done", at: NOW - i * DAY_MS })),
      ...Array.from({ length: 14 }, (_, i) =>
        mkTr({ taskId: `prior-${i}`, from: "review", to: "done", at: NOW - (7 + Math.floor(i / 2)) * DAY_MS }),
      ),
    ];
    const tasks = Array.from({ length: 10 }, (_, i) => mkTask({ id: `open-${i}`, state: "todo" }));
    const result = forecastBacklogClear(tasks, transitions, NOW);
    expect(result.recentRatePerDay).toBe(1);
    expect(result.priorRatePerDay).toBe(2);
    expect(result.daysLow).toBe(5); // optimistic: the faster (prior) rate
    expect(result.daysHigh).toBe(10); // pessimistic: the slower (recent) rate
    expect(result.daysEstimate).toBe(10); // point estimate always uses the recent rate
  });
});

describe("medianTimePerBucket", () => {
  it("matches a hand computation for the in_flight bucket: two completed ongoing-stays of 1d and 3d → median 2d", () => {
    const transitions = [
      mkTr({ taskId: "a", from: "todo", to: "ongoing", at: 0 }),
      mkTr({ taskId: "a", from: "ongoing", to: "review", at: 1 * DAY_MS }), // 1d in in_flight (ongoing)
      mkTr({ taskId: "b", from: "todo", to: "ongoing", at: 0 }),
      mkTr({ taskId: "b", from: "ongoing", to: "done", at: 3 * DAY_MS }), // 3d in in_flight (ongoing)
      // An OPEN stay (no next transition) must be excluded, not counted as 0 or as "to now".
      mkTr({ taskId: "c", from: "todo", to: "ongoing", at: 0 }),
    ];
    const result = medianTimePerBucket(transitions);
    expect(result.in_flight.sampleSize).toBe(2);
    expect(result.in_flight.medianMs).toBe(2 * DAY_MS);
  });

  it("returns null/0 for a bucket with no completed stays", () => {
    const result = medianTimePerBucket([]);
    expect(result.intake).toEqual({ medianMs: null, sampleSize: 0 });
    expect(result.queued).toEqual({ medianMs: null, sampleSize: 0 });
    expect(result.in_flight).toEqual({ medianMs: null, sampleSize: 0 });
    expect(result.landed).toEqual({ medianMs: null, sampleSize: 0 });
  });
});

describe("rulePerformance", () => {
  const mkRule = (over: Partial<Rule> = {}): Rule => ({
    id: "r1", workspaceId: DEFAULT_WORKSPACE, projectId: PROJECT_ID, name: "R", when: "x",
    conditions: [], actions: [], safety: { announceBeforeActing: true, undoWindowMin: 10, pauseAfterUndos: 3, excludePriorities: [] },
    stats: { moves: 0, undos: 0 }, state: "live", pausedReason: null, createdAt: 0, archived: false, ...over,
  });

  it("flags a rule seeded with an undo rate over 20% (3/10 = 30%), and not one at 10%", () => {
    const highUndo = mkRule({ id: "high", stats: { moves: 10, undos: 3 } });
    const lowUndo = mkRule({ id: "low", stats: { moves: 10, undos: 1 } });
    const result = rulePerformance([highUndo, lowUndo]);
    expect(result.find((r) => r.rule.id === "high")).toMatchObject({ undoRate: 0.3, flagged: true, flagReason: "undo-rate" });
    expect(result.find((r) => r.rule.id === "low")).toMatchObject({ undoRate: 0.1, flagged: false, flagReason: null });
  });

  it("exactly at the threshold (20%) is not flagged — 'exceeds', not 'reaches'", () => {
    const atThreshold = mkRule({ stats: { moves: 10, undos: 2 } });
    expect(rulePerformance([atThreshold])[0]).toMatchObject({ undoRate: UNDO_RATE_FLAG_THRESHOLD, flagged: false });
  });

  it("a rule with zero moves has no rate and isn't flagged", () => {
    expect(rulePerformance([mkRule({ stats: { moves: 0, undos: 0 } })])[0]).toMatchObject({ undoRate: null, flagged: false });
  });

  it("an auto-paused rule (the breaker tripped) is flagged even with a lifetime undo rate under 20%", () => {
    const breakerPaused = mkRule({ stats: { moves: 100, undos: 5 }, state: "paused", pausedReason: "Auto-paused: 3 undo(s) within 24h." });
    expect(rulePerformance([breakerPaused])[0]).toMatchObject({ flagged: true, flagReason: "auto-paused" });
  });

  it("a rule a HUMAN paused (no pausedReason) is not flagged just for being paused", () => {
    const humanPaused = mkRule({ stats: { moves: 10, undos: 1 }, state: "paused", pausedReason: null });
    expect(rulePerformance([humanPaused])[0]).toMatchObject({ flagged: false, flagReason: null });
  });
});
