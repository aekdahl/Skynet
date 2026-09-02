// Momentum Rollout Phase 22 — Home dashboard's pure math, checked against
// hand-computed values for a seeded fixture set (this task's own acceptance
// bar: "all 4 stat cards show correct derived numbers against seeded data").
import { describe, it, expect } from "vitest";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { AuditRecordWithActor, Decision, HitlItem, Task, TaskRun, Transition } from "@skynet/shared";
import {
  OVERNIGHT_WINDOW_MS,
  overnightActivity,
  greetingSentence,
  waitingOnYou,
  handledWithoutYou,
  mergedStats,
  needsHumanLook,
  spendVsWorkSeries,
  spendVsWorkTrend,
  topDecisions,
} from "../apps/web/src/kanban/home-metrics.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const NOW = 100 * DAY_MS; // an arbitrary fixed epoch — never Date.now()
const PROJECT_ID = "p1";

const mkRun = (over: Partial<TaskRun> = {}): TaskRun =>
  ({
    id: "r1", workspaceId: DEFAULT_WORKSPACE, projectId: PROJECT_ID, name: "run", status: "running",
    agentId: "a1", provider: "claude", model: "m", branch: "b", modules: [], progress: 0, plan: [],
    modifiedFiles: [], log: [], startedAt: NOW, lastHeartbeatAt: NOW, mergedAt: null, merge: null,
    usage: null, pr: null, archived: false, ...over,
  }) as TaskRun;

const mkHitl = (over: Partial<HitlItem> = {}): HitlItem =>
  ({
    id: "h1", workspaceId: DEFAULT_WORKSPACE, runId: "r1", kind: "question", title: "x", why: null,
    raisedAt: NOW, resolvedAt: null, resolution: null, options: null, risk: "low", flags: [],
    ...over,
  }) as HitlItem;

const mkDecision = (over: Partial<Decision> = {}): Decision =>
  ({ ...mkHitl(), projectId: PROJECT_ID, projectName: "P", taskTitle: "t", costOfWaiting: 0, ...over }) as Decision;

const mkAudit = (over: Partial<AuditRecordWithActor> = {}): AuditRecordWithActor =>
  ({
    workspaceId: DEFAULT_WORKSPACE, hitlId: "h1", runId: "r1", action: "diff", operatorId: "op1",
    at: NOW, payload: null, actorType: "human", ...over,
  }) as AuditRecordWithActor;

const mkTask = (over: Partial<Task> = {}): Task =>
  ({
    id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: PROJECT_ID, text: "x", state: "ongoing",
    runId: null, autoPick: false, assessment: null, reviewVerdict: null, lint: null, priority: null,
    assignment: { mode: "any", agentIds: [] }, archived: false, ...over,
  }) as Task;

const mkTr = (over: Partial<Transition> & Pick<Transition, "taskId" | "from" | "to" | "at">): Transition => ({
  id: `tr-${Math.random()}`, workspaceId: DEFAULT_WORKSPACE, projectId: PROJECT_ID,
  actor: "machine", actorId: null, ruleId: null, evidence: [], ...over,
});

describe("overnightActivity", () => {
  it("counts agents that started or heartbeated in the trailing window, and only OPEN escalations", () => {
    const runs = [
      mkRun({ id: "started-in-window", startedAt: NOW - 2 * HOUR_MS, lastHeartbeatAt: NOW - 2 * HOUR_MS }),
      mkRun({ id: "heartbeated-in-window", startedAt: NOW - 20 * HOUR_MS, lastHeartbeatAt: NOW - 1 * HOUR_MS }),
      mkRun({ id: "outside-window", startedAt: NOW - 20 * HOUR_MS, lastHeartbeatAt: NOW - 15 * HOUR_MS }),
    ];
    const queue = [
      mkHitl({ id: "q1", kind: "question", raisedAt: NOW - 3 * HOUR_MS }),
      mkHitl({ id: "q2", kind: "approval", raisedAt: NOW - 4 * HOUR_MS }),
      mkHitl({ id: "q3", kind: "escalation", raisedAt: NOW - 5 * HOUR_MS, resolvedAt: null }),
      // Escalated overnight but ALREADY RESOLVED — not "stuck" anymore, excluded.
      mkHitl({ id: "q4", kind: "escalation", raisedAt: NOW - 6 * HOUR_MS, resolvedAt: NOW - HOUR_MS }),
      // Raised outside the window entirely.
      mkHitl({ id: "q5", kind: "question", raisedAt: NOW - 20 * HOUR_MS }),
    ];
    const activity = overnightActivity(runs, queue, NOW);
    expect(activity).toEqual({ agentCount: 2, questions: 1, approvals: 1, escalations: 1 });
  });

  it("a custom window is honored", () => {
    const runs = [mkRun({ startedAt: NOW - 5 * HOUR_MS, lastHeartbeatAt: NOW - 5 * HOUR_MS })];
    expect(overnightActivity(runs, [], NOW, 4 * HOUR_MS).agentCount).toBe(0);
    expect(overnightActivity(runs, [], NOW, 6 * HOUR_MS).agentCount).toBe(1);
  });
});

describe("greetingSentence", () => {
  it("never falls back to a static greeting — the all-zero case gets its own honest sentence", () => {
    const g = greetingSentence({ agentCount: 0, questions: 0, approvals: 0, escalations: 0 }, 0);
    expect(g.before).not.toMatch(/good morning/i);
    expect(g.before.length).toBeGreaterThan(0);
    expect(g.needsYou).toBeNull();
    expect(g.after).toBe("");
  });

  it("combines agents + questions + approvals in one clause, pluralized correctly", () => {
    const g = greetingSentence({ agentCount: 3, questions: 2, approvals: 1, escalations: 0 }, 0);
    expect(g.before).toBe("3 agents worked overnight, raising 2 questions and 1 approval.");
    expect(g.needsYou).toBeNull();
  });

  it("singular counts don't pluralize", () => {
    const g = greetingSentence({ agentCount: 1, questions: 1, approvals: 0, escalations: 0 }, 0);
    expect(g.before).toBe("1 agent worked overnight, raising 1 question.");
  });

  it("the needs-you clause is a separate segment, only present when something escalated", () => {
    const g = greetingSentence({ agentCount: 3, questions: 0, approvals: 0, escalations: 1 }, 0);
    expect(g.needsYou).toBe(" 1 task got stuck and needs you.");
    const g2 = greetingSentence({ agentCount: 3, questions: 0, approvals: 0, escalations: 2 }, 0);
    expect(g2.needsYou).toBe(" 2 tasks got stuck and need you.");
  });

  it("the ready-to-merge clause trails after needsYou, singular/plural correct", () => {
    const g = greetingSentence({ agentCount: 1, questions: 0, approvals: 0, escalations: 0 }, 1);
    expect(g.after).toBe(" 1 run is ready for you to merge.");
    const g2 = greetingSentence({ agentCount: 1, questions: 0, approvals: 0, escalations: 0 }, 4);
    expect(g2.after).toBe(" 4 runs are ready for you to merge.");
  });

  it("zero agents but something else happened doesn't say 'no agents worked overnight' silently — still names what did happen", () => {
    const g = greetingSentence({ agentCount: 0, questions: 0, approvals: 0, escalations: 0 }, 2);
    expect(g.before).toBe("No agents worked overnight.");
    expect(g.after).toBe(" 2 runs are ready for you to merge.");
  });
});

describe("waitingOnYou", () => {
  it("tallies the decision list by kind — a hand count", () => {
    const decisions = [
      mkDecision({ id: "d1", kind: "approval" }),
      mkDecision({ id: "d2", kind: "approval" }),
      mkDecision({ id: "d3", kind: "diff" }),
      mkDecision({ id: "d4", kind: "escalation" }),
    ];
    expect(waitingOnYou(decisions)).toEqual({ total: 4, byKind: { approval: 2, diff: 1, escalation: 1 } });
  });

  it("empty decisions → zero total, empty breakdown", () => {
    expect(waitingOnYou([])).toEqual({ total: 0, byKind: {} });
  });
});

describe("handledWithoutYou", () => {
  it("counts non-human actorType rows in the window — a hand count: 2 of 3 gates handled without a human", () => {
    const audit = [
      mkAudit({ hitlId: "h1", actorType: "policy", at: NOW - 1 * DAY_MS }),
      mkAudit({ hitlId: "h2", actorType: "agent-review", at: NOW - 2 * DAY_MS }),
      mkAudit({ hitlId: "h3", actorType: "human", at: NOW - 3 * DAY_MS }),
      // Outside the 7d window — excluded.
      mkAudit({ hitlId: "h4", actorType: "policy", at: NOW - 8 * DAY_MS }),
    ];
    expect(handledWithoutYou(audit, NOW)).toEqual({ count: 2, pct: 67, totalGates: 3 });
  });

  it("missing actorType is treated as human (undercounts automation, never overcounts)", () => {
    const audit = [mkAudit({ actorType: undefined, at: NOW })];
    expect(handledWithoutYou(audit, NOW)).toEqual({ count: 0, pct: 0, totalGates: 1 });
  });

  it("null (not 0) pct when there are no gates at all in the window", () => {
    expect(handledWithoutYou([], NOW)).toEqual({ count: 0, pct: null, totalGates: 0 });
  });
});

describe("mergedStats", () => {
  it("counts merges in the trailing 7d window, and reverts among THOSE merges — a hand count", () => {
    const runs = [
      mkRun({ id: "m1", mergedAt: NOW - 1 * DAY_MS, merge: { commit: "c1", branch: "b1", revertedAt: null, revertCommit: null, revertedBy: null } }),
      mkRun({ id: "m2", mergedAt: NOW - 2 * DAY_MS, merge: { commit: "c2", branch: "b2", revertedAt: NOW - HOUR_MS, revertCommit: "c2r", revertedBy: "op1" } }),
      // Merged outside the window — excluded from both counts.
      mkRun({ id: "m3", mergedAt: NOW - 8 * DAY_MS, merge: { commit: "c3", branch: "b3", revertedAt: NOW - HOUR_MS, revertCommit: "c3r", revertedBy: "op1" } }),
      // Never merged.
      mkRun({ id: "m4", mergedAt: null }),
    ];
    expect(mergedStats(runs, NOW)).toEqual({ merged: 2, reverted: 1 });
  });
});

describe("needsHumanLook", () => {
  it("sums open escalations + stalled (>48h) tasks — a hand count", () => {
    const queue = [
      mkHitl({ id: "e1", kind: "escalation", resolvedAt: null }),
      mkHitl({ id: "e2", kind: "escalation", resolvedAt: NOW }), // resolved — excluded
      mkHitl({ id: "e3", kind: "question", resolvedAt: null }), // wrong kind — excluded
    ];
    const tasks = [
      mkTask({ id: "stalled", state: "ongoing" }),
      mkTask({ id: "fresh", state: "ongoing" }),
      mkTask({ id: "backlog-not-stalled", state: "backlog" }),
    ];
    const transitions = [
      mkTr({ taskId: "stalled", from: "todo", to: "ongoing", at: NOW - 50 * HOUR_MS }), // >48h stale
      mkTr({ taskId: "fresh", from: "todo", to: "ongoing", at: NOW - 1 * HOUR_MS }),
    ];
    expect(needsHumanLook(queue, tasks, transitions, NOW)).toEqual({ escalations: 1, stalls: 1, total: 2 });
  });
});

describe("spendVsWorkSeries / spendVsWorkTrend", () => {
  it("buckets merges by UTC day and computes cost-per-merge from that day's own merged runs — a hand count", () => {
    const day0 = Math.floor(NOW / DAY_MS) * DAY_MS; // today's UTC boundary
    const runs = [
      mkRun({ id: "a", mergedAt: day0 + 1000, usage: { costUsd: 2, inputTokens: 0, outputTokens: 0 } }),
      mkRun({ id: "b", mergedAt: day0 + 2000, usage: { costUsd: 4, inputTokens: 0, outputTokens: 0 } }),
      mkRun({ id: "c", mergedAt: day0 - DAY_MS + 1000, usage: { costUsd: 9, inputTokens: 0, outputTokens: 0 } }),
    ];
    const series = spendVsWorkSeries(runs, NOW, 3);
    expect(series).toHaveLength(3);
    const today = series[series.length - 1]!;
    const yesterday = series[series.length - 2]!;
    expect(today).toEqual({ dayStart: day0, mergedCount: 2, costUsd: 6, costPerMerge: 3 });
    expect(yesterday).toEqual({ dayStart: day0 - DAY_MS, mergedCount: 1, costUsd: 9, costPerMerge: 9 });
    expect(series[0]!.mergedCount).toBe(0); // 3 days back — nothing merged, no data
    expect(series[0]!.costPerMerge).toBeNull();
  });

  it("insufficient-data when fewer than 2 days have a cost-per-merge reading", () => {
    const series = spendVsWorkSeries([], NOW, 14);
    expect(spendVsWorkTrend(series)).toEqual({ kind: "insufficient-data" });
  });

  it("reads a real, sustained swing as rising/falling — not day-to-day noise", () => {
    const day0 = Math.floor(NOW / DAY_MS) * DAY_MS;
    const rising = [
      { dayStart: day0 - DAY_MS, mergedCount: 1, costUsd: 10, costPerMerge: 10 },
      { dayStart: day0, mergedCount: 1, costUsd: 20, costPerMerge: 20 }, // +100%, well past the 15% bar
    ];
    expect(spendVsWorkTrend(rising)).toEqual({ kind: "read", totalMerges: 2, avgCostPerMerge: 15, direction: "rising" });

    const steady = [
      { dayStart: day0 - DAY_MS, mergedCount: 1, costUsd: 10, costPerMerge: 10 },
      { dayStart: day0, mergedCount: 1, costUsd: 10.5, costPerMerge: 10.5 }, // +5% — noise, not a trend
    ];
    expect((spendVsWorkTrend(steady) as { direction: string }).direction).toBe("steady");
  });
});

describe("topDecisions", () => {
  it("takes the first N — server already sorts by costOfWaiting descending", () => {
    const decisions = [
      mkDecision({ id: "d1", costOfWaiting: 300 }),
      mkDecision({ id: "d2", costOfWaiting: 200 }),
      mkDecision({ id: "d3", costOfWaiting: 100 }),
      mkDecision({ id: "d4", costOfWaiting: 50 }),
    ];
    expect(topDecisions(decisions).map((d) => d.id)).toEqual(["d1", "d2", "d3"]);
    expect(topDecisions(decisions, 2).map((d) => d.id)).toEqual(["d1", "d2"]);
  });

  it("fewer than N decisions returns what's there, no padding", () => {
    const decisions = [mkDecision({ id: "d1" })];
    expect(topDecisions(decisions)).toHaveLength(1);
  });
});

// Sanity: the window constant is what the doc comment claims (12h), so a
// future edit that silently changes it fails loudly here too.
describe("OVERNIGHT_WINDOW_MS", () => {
  it("is 12 hours", () => {
    expect(OVERNIGHT_WINDOW_MS).toBe(12 * HOUR_MS);
  });
});
