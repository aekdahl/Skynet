// Phase 28 (TASK 31) — roadmap drift's pure math, checked against
// hand-computed values for a seeded RoadmapDoc/Task/Transition fixture set
// (this task's own acceptance bar: "a seeded roadmap with on-time/late/
// unforecastable lines renders every verdict state correctly").
import { describe, it, expect } from "vitest";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { RoadmapChecklistItemNode, RoadmapDoc, Task, Transition } from "@skynet/shared";
import {
  forecastRoadmapLine,
  verdictForLine,
  driftRows,
  roadmapHealthMetrics,
  oneDecision,
  STALE_LINE_THRESHOLD_MS,
} from "../apps/web/src/kanban/roadmap-drift-metrics.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const PROJECT_ID = "p1";
const NOW = 100 * DAY_MS; // an arbitrary fixed epoch — never Date.now()

const mkLine = (over: Partial<RoadmapChecklistItemNode> = {}): RoadmapChecklistItemNode =>
  ({
    id: "l1", type: "checklistItem", text: "Line", checked: false, state: "todo",
    acceptanceCriteria: null, author: null, authorRef: null, addedAt: null, claimedByHuman: false,
    taskIds: [], promisedDate: null, forecast: null, questionIds: [], blameSha: null,
    indent: 0, marker: " ", links: [], raw: "- [ ] Line\n",
    ...over,
  }) as RoadmapChecklistItemNode;

const mkDoc = (lines: RoadmapChecklistItemNode[]): RoadmapDoc =>
  ({
    workspaceId: DEFAULT_WORKSPACE, projectId: PROJECT_ID, path: "ROADMAP.md", commitSha: null,
    syncedAt: NOW, syncState: "in_sync", raw: "", ast: lines, sections: [],
  }) as RoadmapDoc;

const mkTask = (over: Partial<Task> = {}): Task =>
  ({
    id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: PROJECT_ID, text: "x", state: "backlog",
    runId: null, autoPick: false, assessment: null, reviewVerdict: null, lint: null, priority: null,
    assignment: { mode: "any", agentIds: [] }, archived: false, dependsOnTaskIds: [],
    ...over,
  }) as Task;

const mkTr = (over: Partial<Transition> & Pick<Transition, "taskId" | "from" | "to" | "at">): Transition =>
  ({
    id: `tr-${Math.random()}`, workspaceId: DEFAULT_WORKSPACE, projectId: PROJECT_ID,
    actor: "machine", actorId: null, ruleId: null, evidence: [], ...over,
  }) as Transition;

describe("forecastRoadmapLine", () => {
  it("returns an explicit unforecastable state for a line with zero linked tasks — never a fake 0% or date", () => {
    const line = mkLine({ taskIds: [] });
    const f = forecastRoadmapLine(line, [mkTask({ id: "t1" })], [], NOW);
    expect(f).toEqual({
      forecastable: false, totalTasks: 0, doneTasks: 0, inFlightTasks: 0,
      deliveredPct: null, inFlightPct: null, recentRatePerDay: null, etaAt: null, completedAt: null,
    });
  });

  it("matches a hand count: 2 of 4 done, 1 in flight, recent rate 2/7 per day", () => {
    const line = mkLine({ taskIds: ["a", "b", "c", "d"] });
    const tasks = [
      mkTask({ id: "a", state: "done" }),
      mkTask({ id: "b", state: "done" }),
      mkTask({ id: "c", state: "ongoing" }),
      mkTask({ id: "d", state: "todo" }),
    ];
    const transitions = [
      mkTr({ taskId: "a", from: "ongoing", to: "done", at: NOW - 1 * DAY_MS }),
      mkTr({ taskId: "b", from: "ongoing", to: "done", at: NOW - 3 * DAY_MS }),
      // outside the trailing-7d window — must not count toward the rate
      mkTr({ taskId: "a", from: "review", to: "done", at: NOW - 9 * DAY_MS }),
    ];
    const f = forecastRoadmapLine(line, tasks, transitions, NOW);
    expect(f.forecastable).toBe(true);
    expect(f.totalTasks).toBe(4);
    expect(f.doneTasks).toBe(2);
    expect(f.inFlightTasks).toBe(1);
    expect(f.deliveredPct).toBe(50);
    expect(f.inFlightPct).toBe(25);
    expect(f.recentRatePerDay).toBeCloseTo(2 / 7);
    // 2 remaining / (2/7 per day) = 7 days out.
    expect(f.etaAt).toBe(NOW + 7 * DAY_MS);
    expect(f.completedAt).toBeNull(); // not every task is done yet
  });

  it("has a real delivered/in-flight % but a null eta when there are tasks but zero recent landings (stalled)", () => {
    const line = mkLine({ taskIds: ["a", "b"] });
    const tasks = [mkTask({ id: "a", state: "ongoing" }), mkTask({ id: "b", state: "todo" })];
    const f = forecastRoadmapLine(line, tasks, [], NOW);
    expect(f.forecastable).toBe(true);
    expect(f.deliveredPct).toBe(0);
    expect(f.recentRatePerDay).toBe(0);
    expect(f.etaAt).toBeNull();
  });

  it("sets completedAt to the LATEST done-transition once every linked task is done", () => {
    const line = mkLine({ taskIds: ["a", "b"] });
    const tasks = [mkTask({ id: "a", state: "done" }), mkTask({ id: "b", state: "done" })];
    const transitions = [
      mkTr({ taskId: "a", from: "ongoing", to: "done", at: NOW - 5 * DAY_MS }),
      mkTr({ taskId: "b", from: "ongoing", to: "done", at: NOW - 2 * DAY_MS }),
    ];
    const f = forecastRoadmapLine(line, tasks, transitions, NOW);
    expect(f.deliveredPct).toBe(100);
    expect(f.etaAt).toBe(NOW);
    expect(f.completedAt).toBe(NOW - 2 * DAY_MS);
  });
});

describe("verdictForLine — the spec's exact 5 words, one hand-checked fixture per state", () => {
  it('"no date yet" — no promisedDate at all, regardless of task status', () => {
    const line = mkLine({ promisedDate: null, taskIds: ["a"] });
    const f = forecastRoadmapLine(line, [mkTask({ id: "a", state: "done" })], [], NOW);
    expect(verdictForLine(line, f)).toBe("no date yet");
  });

  it('"write the brief" — a promise with zero linked tasks', () => {
    const line = mkLine({ promisedDate: NOW + 10 * DAY_MS, taskIds: [] });
    const f = forecastRoadmapLine(line, [], [], NOW);
    expect(verdictForLine(line, f)).toBe("write the brief");
  });

  it('"landed early" — every task done, before the promised date', () => {
    const line = mkLine({ promisedDate: NOW - 1 * DAY_MS, taskIds: ["a"] });
    const tasks = [mkTask({ id: "a", state: "done" })];
    const transitions = [mkTr({ taskId: "a", from: "ongoing", to: "done", at: NOW - 5 * DAY_MS })];
    const f = forecastRoadmapLine(line, tasks, transitions, NOW);
    expect(f.completedAt).toBe(NOW - 5 * DAY_MS);
    expect(verdictForLine(line, f)).toBe("landed early");
  });

  it('"on the date" — every task done, landed on/after the promise', () => {
    const line = mkLine({ promisedDate: NOW - 5 * DAY_MS, taskIds: ["a"] });
    const tasks = [mkTask({ id: "a", state: "done" })];
    const transitions = [mkTr({ taskId: "a", from: "ongoing", to: "done", at: NOW - 1 * DAY_MS })];
    const f = forecastRoadmapLine(line, tasks, transitions, NOW);
    expect(verdictForLine(line, f)).toBe("on the date");
  });

  it('"on the date" — still in flight, but the forecast eta lands ON/before the promise', () => {
    const line = mkLine({ promisedDate: NOW + 10 * DAY_MS, taskIds: ["a", "b"] });
    const tasks = [mkTask({ id: "a", state: "done" }), mkTask({ id: "b", state: "ongoing" })];
    // 1 landing in the trailing 7d → rate 1/7/day; 1 remaining → eta = now + 7d, inside the 10d promise.
    const transitions = [mkTr({ taskId: "a", from: "ongoing", to: "done", at: NOW - 1 * DAY_MS })];
    const f = forecastRoadmapLine(line, tasks, transitions, NOW);
    expect(f.etaAt).toBe(NOW + 7 * DAY_MS);
    expect(verdictForLine(line, f)).toBe("on the date");
  });

  it('"cut or re-date" — still in flight, forecast eta lands AFTER the promise', () => {
    const line = mkLine({ promisedDate: NOW + 3 * DAY_MS, taskIds: ["a", "b"] });
    const tasks = [mkTask({ id: "a", state: "done" }), mkTask({ id: "b", state: "ongoing" })];
    // Same 1/7/day rate → eta = now + 7d, PAST the 3d promise.
    const transitions = [mkTr({ taskId: "a", from: "ongoing", to: "done", at: NOW - 1 * DAY_MS })];
    const f = forecastRoadmapLine(line, tasks, transitions, NOW);
    expect(f.etaAt).toBe(NOW + 7 * DAY_MS);
    expect(verdictForLine(line, f)).toBe("cut or re-date");
  });

  it('"cut or re-date" — still in flight, stalled (no eta at all) — treated as late, not "on the date"', () => {
    const line = mkLine({ promisedDate: NOW + 10 * DAY_MS, taskIds: ["a"] });
    const tasks = [mkTask({ id: "a", state: "ongoing" })];
    const f = forecastRoadmapLine(line, tasks, [], NOW);
    expect(f.etaAt).toBeNull();
    expect(verdictForLine(line, f)).toBe("cut or re-date");
  });
});

describe("driftRows", () => {
  it("computes one row per checklist line, in doc order, with lateDays only on a real cut-or-re-date forecast", () => {
    const early = mkLine({ id: "l-early", promisedDate: NOW + 5 * DAY_MS, taskIds: ["a"] });
    const late = mkLine({ id: "l-late", promisedDate: NOW + 1 * DAY_MS, taskIds: ["b", "c"] });
    const doc = mkDoc([early, late]);
    const tasks = [mkTask({ id: "a", state: "done" }), mkTask({ id: "b", state: "done" }), mkTask({ id: "c", state: "ongoing" })];
    const transitions = [
      mkTr({ taskId: "a", from: "ongoing", to: "done", at: NOW - 1 * DAY_MS }),
      mkTr({ taskId: "b", from: "ongoing", to: "done", at: NOW - 1 * DAY_MS }),
    ];
    const rows = driftRows(doc, tasks, transitions, NOW);
    expect(rows.map((r) => r.line.id)).toEqual(["l-early", "l-late"]);
    expect(rows[0]!.verdict).toBe("landed early");
    expect(rows[0]!.lateDays).toBeNull();
    expect(rows[1]!.verdict).toBe("cut or re-date");
    // rate 1/7/day, 1 remaining → eta = now+7d; promise = now+1d → 6 days late.
    expect(rows[1]!.lateDays).toBe(6);
  });
});

describe("roadmapHealthMetrics", () => {
  it("orphanTasks matches a hand-checked reverse join: tasks with NO roadmap line linking to them", () => {
    const linked = mkLine({ id: "l1", taskIds: ["t1", "t2"] });
    const doc = mkDoc([linked]);
    const t1 = mkTask({ id: "t1" });
    const t2 = mkTask({ id: "t2" });
    const t3 = mkTask({ id: "t3" }); // not linked by any line — an orphan
    const t4Archived = mkTask({ id: "t4", archived: true }); // not linked AND archived — excluded either way
    const metrics = roadmapHealthMetrics(doc, [t1, t2, t3, t4Archived], [], NOW);
    expect(metrics.orphanTasks.map((t) => t.id)).toEqual(["t3"]);
    expect(metrics.linesWithTasks).toBe(1);
  });

  it("linesWithTasks/linesWithCriteria count exactly the lines that have them", () => {
    const doc = mkDoc([
      mkLine({ id: "l1", taskIds: ["t1"] }),
      mkLine({ id: "l2", taskIds: [] }),
      mkLine({ id: "l3", acceptanceCriteria: "Must do X" }),
      mkLine({ id: "l4" }),
    ]);
    const metrics = roadmapHealthMetrics(doc, [], [], NOW);
    expect(metrics.totalLines).toBe(4);
    expect(metrics.linesWithTasks).toBe(1);
    expect(metrics.linesWithCriteria).toBe(1);
  });

  it("staleLines: a linked line with old last activity is stale via its tasks' transitions; a taskless line is stale via addedAt; a recently-active line is not", () => {
    const staleViaTasks = mkLine({ id: "l-stale-tasks", taskIds: ["a"] });
    const staleViaAddedAt = mkLine({ id: "l-stale-added", taskIds: [], addedAt: NOW - 40 * DAY_MS });
    const fresh = mkLine({ id: "l-fresh", taskIds: ["b"] });
    const doc = mkDoc([staleViaTasks, staleViaAddedAt, fresh]);
    const transitions = [
      mkTr({ taskId: "a", from: "todo", to: "ongoing", at: NOW - 35 * DAY_MS }),
      mkTr({ taskId: "b", from: "todo", to: "ongoing", at: NOW - 1 * DAY_MS }),
    ];
    const metrics = roadmapHealthMetrics(doc, [mkTask({ id: "a" }), mkTask({ id: "b" })], transitions, NOW);
    expect(metrics.staleLines.map((s) => s.line.id)).toEqual(["l-stale-added", "l-stale-tasks"]); // most-stale first
    expect(metrics.staleLines[0]!.staleMs).toBeGreaterThan(STALE_LINE_THRESHOLD_MS);
  });
});

describe("oneDecision", () => {
  it("picks the cut-or-re-date row combining the most lateness with the most downstream blocking", () => {
    // Row A: a REAL (non-stalled) forecast — 1 of 2 tasks done recently, 1
    // remaining → rate 1/7/day → eta = now+7d; promise = now+1d → 6d late.
    // Also blocks 1 other task (downstream-of-a2 depends on a2).
    const lineA = mkLine({ id: "lA", promisedDate: NOW + 1 * DAY_MS, taskIds: ["a1", "a2"] });
    // Row B: stalled — has a task, but zero recent landings at all, so no eta
    // can be projected — treated as maximally late (worse than any concrete
    // number), even with zero downstream blockers.
    const lineB = mkLine({ id: "lB", promisedDate: NOW + 10 * DAY_MS, taskIds: ["b1"] });
    // Row C: on track — not a "cut or re-date" candidate at all.
    const lineC = mkLine({ id: "lC", promisedDate: NOW + 30 * DAY_MS, taskIds: ["c1"] });
    const doc = mkDoc([lineA, lineB, lineC]);
    const tasks = [
      mkTask({ id: "a1", state: "done" }),
      mkTask({ id: "a2", state: "ongoing" }),
      mkTask({ id: "downstream-of-a2", dependsOnTaskIds: ["a2"] }),
      mkTask({ id: "b1", state: "ongoing" }),
      mkTask({ id: "c1", state: "done" }),
    ];
    const transitions = [
      mkTr({ taskId: "a1", from: "ongoing", to: "done", at: NOW - 1 * DAY_MS }),
      mkTr({ taskId: "c1", from: "ongoing", to: "done", at: NOW - 1 * DAY_MS }),
    ];
    const rows = driftRows(doc, tasks, transitions, NOW);
    const rowA = rows.find((r) => r.line.id === "lA")!;
    expect(rowA.verdict).toBe("cut or re-date");
    expect(rowA.lateDays).toBe(6);
    const rowB = rows.find((r) => r.line.id === "lB")!;
    expect(rowB.verdict).toBe("cut or re-date");
    expect(rowB.lateDays).toBeNull(); // stalled — no eta to measure lateness from

    const decision = oneDecision(rows, tasks);
    expect(decision).not.toBeNull();
    // lineB's stalled sentinel (3650d) dwarfs lineA's real 6 days + 1 blocker (score 7).
    expect(decision!.row.line.id).toBe("lB");
  });

  it("returns null when nothing is in cut-or-re-date", () => {
    const doc = mkDoc([mkLine({ id: "l1", promisedDate: null })]);
    const rows = driftRows(doc, [], [], NOW);
    expect(oneDecision(rows, [])).toBeNull();
  });
});
