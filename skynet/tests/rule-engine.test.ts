// Momentum Rollout Phase 1b — the rule engine's core loop, end to end:
// signal in → rule evaluates → pending action → window elapses → Transition
// written → undo works within the window → 3 undos pauses the rule. Also
// covers the two safety rails (excludePriorities, the reentrancy guard) and
// the separate stall-detection sweep. Real MemoryStore + Hub + InProcessBus —
// no git, no worktrees, no live agent: the engine never touches any of that.
import { describe, it, expect } from "vitest";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { Project, Task, TaskRun, ServerEvent, Rule, Transition } from "@skynet/shared";
import { InProcessBus } from "../apps/server/src/bus.js";
import { Hub } from "../apps/server/src/hub.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import { RuleEngine } from "../apps/server/src/rules/engine.js";
import { seedStarterRules } from "../apps/server/src/rules/seed.js";

const waitFor = async (pred: () => Promise<boolean> | boolean, ms = 2000): Promise<void> => {
  const dl = Date.now() + ms;
  while (Date.now() < dl) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("condition not met in time");
};

const PROJECT_ID = "p1";

async function setup() {
  const store = new MemoryStore({ seed: false });
  const bus = new InProcessBus();
  const hub = new Hub(store, bus);
  const engine = new RuleEngine({ store, hub, bus });
  await store.putProject({
    id: PROJECT_ID, workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [], status: "active",
  } as Project);
  await engine.start();
  return { store, bus, hub, engine };
}

const mkTask = (over: Partial<Task> = {}): Task =>
  ({
    id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: PROJECT_ID, text: "do X", state: "ongoing",
    runId: null, autoPick: false, assessment: null, reviewVerdict: null, lint: null, priority: null,
    assignment: { mode: "any", agentIds: [] }, archived: false, ...over,
  }) as Task;

const prMerged = (over: Partial<Extract<ServerEvent, { type: "github.signal" }>> = {}): ServerEvent => ({
  type: "github.signal", taskId: "t1", kind: "pr_merged",
  payload: { prNumber: 42, prUrl: "https://github.com/acme/app/pull/42", branch: "agent/x" },
  ...over,
});

const checkFailed = (over: Partial<Extract<ServerEvent, { type: "github.signal" }>> = {}): ServerEvent => ({
  type: "github.signal", taskId: "t1", kind: "check_failed",
  payload: { prNumber: 42, checkName: "build", sha: "abc123", conclusion: "failure" },
  ...over,
});

describe("rule engine — inert until a project opts in", () => {
  it("does nothing when the project has no live Rule at all", async () => {
    const { store, bus } = await setup();
    await store.putTask(mkTask());
    bus.publish(DEFAULT_WORKSPACE, prMerged());
    // Give any (incorrect) async handling a moment to run, then assert nothing happened.
    await new Promise((r) => setTimeout(r, 30));
    expect(await store.listPendingActionsForProject(PROJECT_ID)).toEqual([]);
    expect(await store.listTransitionsForTask("t1")).toEqual([]);
    expect((await store.getTask("t1"))?.state).toBe("ongoing");
  });

  it("does nothing for a rule that's paused or in watch mode — only state:'live' evaluates", async () => {
    const { store, bus } = await setup();
    await store.putTask(mkTask());
    const [rule] = await seedStarterRules(store, DEFAULT_WORKSPACE, PROJECT_ID);
    await store.putRule({ ...rule!, state: "paused" });
    bus.publish(DEFAULT_WORKSPACE, prMerged());
    await new Promise((r) => setTimeout(r, 30));
    expect(await store.listPendingActionsForProject(PROJECT_ID)).toEqual([]);
  });
});

describe("rule engine — the full loop", () => {
  it("signal in → pending action (announce-before-acting) → sweep finalizes → Transition written → task moved", async () => {
    const { store, bus, engine } = await setup();
    await store.putTask(mkTask({ state: "ongoing" }));
    await seedStarterRules(store, DEFAULT_WORKSPACE, PROJECT_ID, { undoWindowMin: 0 }); // ready immediately

    bus.publish(DEFAULT_WORKSPACE, prMerged());
    await waitFor(async () => (await store.listPendingActionsForProject(PROJECT_ID)).length > 0);

    const pending = (await store.listPendingActionsForProject(PROJECT_ID))[0]!;
    expect(pending.status).toBe("pending");
    expect(pending.fromState).toBe("ongoing");
    expect(pending.toState).toBe("review");
    expect((await store.getTask("t1"))?.state).toBe("ongoing"); // NOT applied yet

    await engine.sweepPendingActions();

    const finalized = await store.getPendingRuleAction(pending.id);
    expect(finalized?.status).toBe("finalized");
    expect(finalized?.transitionId).toBeTruthy();
    expect((await store.getTask("t1"))?.state).toBe("review");

    const transitions = await store.listTransitionsForTask("t1");
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ from: "ongoing", to: "review", actor: "machine", ruleId: `rule-${PROJECT_ID}-pr-merged` });
    expect(transitions[0]!.evidence.some((e) => e.includes("pr_merged"))).toBe(true);

    const rule = await store.getRule(`rule-${PROJECT_ID}-pr-merged`);
    expect(rule?.stats.moves).toBe(1);
  });

  it("undo works on a still-pending action — the task never moves at all", async () => {
    const { store, bus, engine } = await setup();
    await store.putTask(mkTask({ state: "ongoing" }));
    await seedStarterRules(store, DEFAULT_WORKSPACE, PROJECT_ID, { undoWindowMin: 10 }); // NOT yet ready

    bus.publish(DEFAULT_WORKSPACE, prMerged());
    await waitFor(async () => (await store.listPendingActionsForProject(PROJECT_ID)).length > 0);
    const pending = (await store.listPendingActionsForProject(PROJECT_ID))[0]!;

    const undone = await engine.undo(pending.id, "op-1");
    expect(undone.status).toBe("undone");

    await engine.sweepPendingActions(); // even once "ready", an undone action must not finalize
    expect((await store.getPendingRuleAction(pending.id))?.status).toBe("undone");
    expect((await store.getTask("t1"))?.state).toBe("ongoing");

    const rule = await store.getRule(`rule-${PROJECT_ID}-pr-merged`);
    expect(rule?.stats.undos).toBe(1);
    expect(rule?.stats.moves).toBe(0); // never finalized — no move to count
  });

  it("undo works on a just-finalized action — reverts the task's move", async () => {
    const { store, bus, engine } = await setup();
    await store.putTask(mkTask({ state: "ongoing" }));
    await seedStarterRules(store, DEFAULT_WORKSPACE, PROJECT_ID, { undoWindowMin: 1 }); // a real (short) post-finalize grace window

    bus.publish(DEFAULT_WORKSPACE, prMerged());
    await waitFor(async () => (await store.listPendingActionsForProject(PROJECT_ID)).length > 0);
    const pending = (await store.listPendingActionsForProject(PROJECT_ID))[0]!;
    // undoWindowMin:1 means readyAt is 1 minute out — force it ready NOW by
    // rewriting the record directly (this test is about undo-after-finalize,
    // not about waiting out the window).
    await store.putPendingRuleAction({ ...pending, readyAt: Date.now() });
    await engine.sweepPendingActions();
    expect((await store.getTask("t1"))?.state).toBe("review");

    const undone = await engine.undo(pending.id, "op-1");
    expect(undone.status).toBe("undone");
    expect((await store.getTask("t1"))?.state).toBe("ongoing"); // reverted

    const transitions = await store.listTransitionsForTask("t1");
    expect(transitions).toHaveLength(2); // the move, then the undo
    expect(transitions[1]).toMatchObject({ from: "review", to: "ongoing", actorId: "op-1" });
  });

  it("undoing a finalized action past its window is refused", async () => {
    const { store, bus, engine } = await setup();
    await store.putTask(mkTask({ state: "ongoing" }));
    await seedStarterRules(store, DEFAULT_WORKSPACE, PROJECT_ID, { undoWindowMin: 0 });

    bus.publish(DEFAULT_WORKSPACE, prMerged());
    await waitFor(async () => (await store.listPendingActionsForProject(PROJECT_ID)).length > 0);
    const pending = (await store.listPendingActionsForProject(PROJECT_ID))[0]!;
    await engine.sweepPendingActions();
    // Force the grace window to have already passed.
    const finalized = (await store.getPendingRuleAction(pending.id))!;
    await store.putPendingRuleAction({ ...finalized, undoableUntil: Date.now() - 1000 });

    await expect(engine.undo(pending.id, "op-1")).rejects.toThrow(/window.*passed/i);
    expect((await store.getTask("t1"))?.state).toBe("review"); // untouched
  });

  it("3 undos within the rolling window auto-pauses the rule", async () => {
    const { store, bus, engine } = await setup();
    await seedStarterRules(store, DEFAULT_WORKSPACE, PROJECT_ID, { undoWindowMin: 10 });

    for (const n of [1, 2, 3]) {
      await store.putTask(mkTask({ id: `t-undo-${n}`, state: "ongoing" }));
      bus.publish(DEFAULT_WORKSPACE, prMerged({ taskId: `t-undo-${n}` }));
      await waitFor(async () => (await store.listPendingActionsForProject(PROJECT_ID)).some((a) => a.taskId === `t-undo-${n}` && a.status === "pending"));
      const pending = (await store.listPendingActionsForProject(PROJECT_ID)).find((a) => a.taskId === `t-undo-${n}`)!;
      await engine.undo(pending.id, "op-1");
    }

    const rule = await store.getRule(`rule-${PROJECT_ID}-pr-merged`);
    expect(rule?.stats.undos).toBe(3);
    expect(rule?.state).toBe("paused");
    expect(rule?.pausedReason).toMatch(/auto-paused/i);
  });

  it("a paused rule stops matching new signals — the breaker actually holds", async () => {
    const { store, bus, engine } = await setup();
    await store.putTask(mkTask({ state: "ongoing" }));
    const [rule] = await seedStarterRules(store, DEFAULT_WORKSPACE, PROJECT_ID, { undoWindowMin: 0 });
    await store.putRule({ ...rule!, state: "paused", pausedReason: "manually paused for this test" });

    bus.publish(DEFAULT_WORKSPACE, prMerged());
    await new Promise((r) => setTimeout(r, 30));
    expect(await store.listPendingActionsForProject(PROJECT_ID)).toEqual([]);
    expect((await store.getTask("t1"))?.state).toBe("ongoing");
  });
});

describe("rule engine — reengage_run action (feedback-loop responders)", () => {
  const immediateSafety = { announceBeforeActing: false, undoWindowMin: 10, pauseAfterUndos: 3, excludePriorities: [] };
  const reengageRule = (id = "rule-reengage") => ({
    id, workspaceId: DEFAULT_WORKSPACE, projectId: PROJECT_ID, name: "CI failed → re-engage",
    when: "check_failed", conditions: [{ field: "github.signal", op: "check_failed", value: null }],
    actions: [{ type: "reengage_run", params: {} }],
    safety: immediateSafety, stats: { moves: 0, undos: 0 }, state: "live" as const, pausedReason: null, createdAt: Date.now(), archived: false,
  });

  it("check_failed condition + reengage_run action calls the wired hook with the run id and a descriptive note", async () => {
    const { store, bus, engine } = await setup();
    await store.putTask(mkTask({ state: "review", runId: "run-1" }));
    const calls: Array<{ runId: string; note: string }> = [];
    engine.reengageRun = async (runId, note) => {
      calls.push({ runId, note });
      return { engaged: true };
    };
    await store.putRule(reengageRule());

    bus.publish(DEFAULT_WORKSPACE, checkFailed());
    await waitFor(async () => calls.length > 0);

    expect(calls[0]!.runId).toBe("run-1");
    expect(calls[0]!.note).toContain("build");
    expect(calls[0]!.note).toContain("failed");

    const transitions = await store.listTransitionsForTask("t1");
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.status).not.toBe("failed");
    expect(transitions[0]!.evidence.some((e) => e.includes("re-engaged run run-1"))).toBe(true);
  });

  it("review_changes_requested is a distinct condition — a check_failed rule doesn't fire for it", async () => {
    const { store, bus, engine } = await setup();
    await store.putTask(mkTask({ state: "review", runId: "run-1" }));
    let called = false;
    engine.reengageRun = async () => {
      called = true;
      return { engaged: true };
    };
    await store.putRule(reengageRule());

    bus.publish(DEFAULT_WORKSPACE, { type: "github.signal", taskId: "t1", kind: "review_changes_requested", payload: { prNumber: 42, reviewBody: "please fix" } });
    await new Promise((r) => setTimeout(r, 30));
    expect(called).toBe(false);
  });

  it("no orchestrator hook wired → records a benign 'not wired' evidence, never throws", async () => {
    const { store, bus } = await setup();
    await store.putTask(mkTask({ state: "review", runId: "run-1" }));
    await store.putRule(reengageRule("rule-reengage-unwired")); // engine.reengageRun deliberately left unset

    bus.publish(DEFAULT_WORKSPACE, checkFailed());
    await waitFor(async () => (await store.listTransitionsForTask("t1")).length > 0);

    const transitions = await store.listTransitionsForTask("t1");
    expect(transitions[0]!.status).not.toBe("failed");
    expect(transitions[0]!.evidence.some((e) => e.includes("not wired"))).toBe(true);
  });

  it("a task with no run → records 'has no run', never calls the hook", async () => {
    const { store, bus, engine } = await setup();
    await store.putTask(mkTask({ state: "review", runId: null }));
    let called = false;
    engine.reengageRun = async () => {
      called = true;
      return { engaged: true };
    };
    await store.putRule(reengageRule("rule-reengage-norun"));

    bus.publish(DEFAULT_WORKSPACE, checkFailed());
    await waitFor(async () => (await store.listTransitionsForTask("t1")).length > 0);

    expect(called).toBe(false);
    const transitions = await store.listTransitionsForTask("t1");
    expect(transitions[0]!.evidence.some((e) => e.includes("has no run"))).toBe(true);
  });
});

describe("rule engine — safety rails", () => {
  it("excludePriorities blocks the action outright, even though the conditions matched", async () => {
    const { store, bus } = await setup();
    await store.putTask(mkTask({ state: "ongoing", priority: "P0" }));
    const [rule] = await seedStarterRules(store, DEFAULT_WORKSPACE, PROJECT_ID, { undoWindowMin: 0 });
    await store.putRule({ ...rule!, safety: { ...rule!.safety, excludePriorities: ["P0"] } });

    bus.publish(DEFAULT_WORKSPACE, prMerged());
    await new Promise((r) => setTimeout(r, 30));
    expect(await store.listPendingActionsForProject(PROJECT_ID)).toEqual([]);
    expect((await store.getTask("t1"))?.state).toBe("ongoing");
  });

  it("excludePriorities is re-checked at finalize time too — a priority change during the window still blocks it", async () => {
    const { store, bus, engine } = await setup();
    await store.putTask(mkTask({ state: "ongoing", priority: null }));
    const [rule] = await seedStarterRules(store, DEFAULT_WORKSPACE, PROJECT_ID, { undoWindowMin: 10 });
    await store.putRule({ ...rule!, safety: { ...rule!.safety, excludePriorities: ["P0"] } });

    bus.publish(DEFAULT_WORKSPACE, prMerged());
    await waitFor(async () => (await store.listPendingActionsForProject(PROJECT_ID)).length > 0);
    // Escalated to P0 mid-window, before the sweep finalizes.
    await store.putTask({ ...(await store.getTask("t1"))!, priority: "P0" });
    const pending = (await store.listPendingActionsForProject(PROJECT_ID))[0]!;
    await store.putPendingRuleAction({ ...pending, readyAt: Date.now() });

    await engine.sweepPendingActions();
    expect((await store.getPendingRuleAction(pending.id))?.status).toBe("undone");
    expect((await store.getTask("t1"))?.state).toBe("ongoing"); // never applied
  });

  it("an immediate (non-announced) two-rule cycle terminates instead of looping forever", async () => {
    const { store, bus } = await setup();
    await store.putTask(mkTask({ state: "todo" }));
    const immediateSafety = { announceBeforeActing: false, undoWindowMin: 10, pauseAfterUndos: 3, excludePriorities: [] };
    await store.putRule({
      id: "rule-ping", workspaceId: DEFAULT_WORKSPACE, projectId: PROJECT_ID, name: "todo → ongoing",
      when: "todo", conditions: [{ field: "task.state", op: "state_equals", value: "todo" }],
      actions: [{ type: "move_task", params: { toState: "ongoing" } }],
      safety: immediateSafety, stats: { moves: 0, undos: 0 }, state: "live", pausedReason: null, createdAt: Date.now(), archived: false,
    });
    await store.putRule({
      id: "rule-pong", workspaceId: DEFAULT_WORKSPACE, projectId: PROJECT_ID, name: "ongoing → todo",
      when: "ongoing", conditions: [{ field: "task.state", op: "state_equals", value: "ongoing" }],
      actions: [{ type: "move_task", params: { toState: "todo" } }],
      safety: immediateSafety, stats: { moves: 0, undos: 0 }, state: "live", pausedReason: null, createdAt: Date.now(), archived: false,
    });

    bus.publish(DEFAULT_WORKSPACE, { type: "task.upserted", task: (await store.getTask("t1"))! });
    // If the reentrancy guard didn't hold, this would hang the test (or the
    // process) — reaching here at all is the assertion. A few real moves
    // happen (ping→pong cascades once) before the guard cuts it off.
    await new Promise((r) => setTimeout(r, 50));
    const transitions = await store.listTransitionsForTask("t1");
    expect(transitions.length).toBeGreaterThan(0);
    expect(transitions.length).toBeLessThan(20); // bounded, not runaway
  });
});

describe("rule engine — stall detection sweep", () => {
  it("no signal in stallNudgeHours (48h default) → creates a stall_nudge proposal", async () => {
    const { store, engine } = await setup();
    await store.putTask(mkTask({ id: "t-stall", state: "ongoing" }));
    await store.createTransition({
      id: "tr-old", workspaceId: DEFAULT_WORKSPACE, projectId: PROJECT_ID, taskId: "t-stall",
      from: "todo", to: "ongoing", actor: "machine", actorId: null, ruleId: null, evidence: [],
      at: Date.now() - 50 * 60 * 60 * 1000, // 50h ago — past the 48h default
    });

    await engine.sweepStallDetection();

    const proposals = await store.listProposalsForProject(PROJECT_ID, { status: "pending" });
    const nudge = proposals.find((p) => p.kind === "stall_nudge" && (p.payload as { taskId?: string }).taskId === "t-stall");
    expect(nudge).toBeDefined();

    // A second sweep doesn't duplicate the same nudge.
    await engine.sweepStallDetection();
    const again = await store.listProposalsForProject(PROJECT_ID, { status: "pending" });
    expect(again.filter((p) => p.kind === "stall_nudge" && (p.payload as { taskId?: string }).taskId === "t-stall")).toHaveLength(1);
  });

  it("no signal in stallEscalateHours (96h default) → escalates to a suggested_reassignment proposal", async () => {
    const { store, engine } = await setup();
    await store.putTask(mkTask({ id: "t-escalate", state: "review" }));
    await store.createTransition({
      id: "tr-old2", workspaceId: DEFAULT_WORKSPACE, projectId: PROJECT_ID, taskId: "t-escalate",
      from: "ongoing", to: "review", actor: "machine", actorId: null, ruleId: null, evidence: [],
      at: Date.now() - 100 * 60 * 60 * 1000, // 100h ago — past the 96h default
    });

    await engine.sweepStallDetection();

    const proposals = await store.listProposalsForProject(PROJECT_ID, { status: "pending" });
    const escalation = proposals.find((p) => p.kind === "suggested_reassignment" && (p.payload as { taskId?: string }).taskId === "t-escalate");
    expect(escalation).toBeDefined();
    // Past the escalate threshold means past the nudge one too, but only ONE proposal fires per sweep, not both.
    expect(proposals.filter((p) => p.kind === "stall_nudge" && (p.payload as { taskId?: string }).taskId === "t-escalate")).toHaveLength(0);
  });

  it("a task with a recent signal is left alone", async () => {
    const { store, engine } = await setup();
    await store.putTask(mkTask({ id: "t-fresh", state: "ongoing" }));
    await store.createTransition({
      id: "tr-fresh", workspaceId: DEFAULT_WORKSPACE, projectId: PROJECT_ID, taskId: "t-fresh",
      from: "todo", to: "ongoing", actor: "machine", actorId: null, ruleId: null, evidence: [],
      at: Date.now() - 60 * 60 * 1000, // 1h ago
    });
    await engine.sweepStallDetection();
    expect(await store.listProposalsForProject(PROJECT_ID)).toEqual([]);
  });

  it("a task with no Transition falls back to its run's heartbeat — never reads as infinitely stale", async () => {
    const { store, engine } = await setup();
    const run: TaskRun = {
      id: "r1", workspaceId: DEFAULT_WORKSPACE, projectId: PROJECT_ID, name: "do X", status: "running",
      agentId: "a1", provider: "claude", credentialId: null, model: "opus-4.8", branch: "agent/r1",
      modules: [], progress: 0.5, plan: [], usage: null, modifiedFiles: [], log: [], startedAt: Date.now() - 3600_000,
      lastHeartbeatAt: Date.now() - 600_000, visual: false, previewUrl: null, dependsOn: [], parentId: null,
      branchFromStep: null, archived: false,
    };
    await store.putRun(run);
    await store.putTask(mkTask({ id: "t-live-run", state: "ongoing", runId: "r1" })); // no Transition at all
    await engine.sweepStallDetection();
    expect(await store.listProposalsForProject(PROJECT_ID)).toEqual([]); // 10 minutes ago is fresh, not stale
  });
});

describe("rule engine — pattern-spotted automation onboarding (TASK 10)", () => {
  const humanMove = (over: Partial<Transition>): Transition => ({
    id: `tr-${Math.random()}`, workspaceId: DEFAULT_WORKSPACE, projectId: PROJECT_ID,
    taskId: "t1", from: "todo", to: "ongoing", actor: "human", actorId: "op-1", ruleId: null,
    evidence: [], at: Date.now() - 60_000, ...over,
  });

  it("below the threshold (3 distinct tasks), nothing is proposed", async () => {
    const { store, engine } = await setup();
    await store.createTransition(humanMove({ id: "tr1", taskId: "ta" }));
    await store.createTransition(humanMove({ id: "tr2", taskId: "tb" }));
    await engine.sweepPatternDetection();
    expect(await store.listProposalsForProject(PROJECT_ID)).toEqual([]);
  });

  it("3 distinct tasks sharing the same manual {from,to} move → a suggested_rule proposal with detector stats", async () => {
    const { store, engine } = await setup();
    await store.createTransition(humanMove({ id: "tr1", taskId: "ta" }));
    await store.createTransition(humanMove({ id: "tr2", taskId: "tb" }));
    await store.createTransition(humanMove({ id: "tr3", taskId: "tc" }));

    await engine.sweepPatternDetection();

    const proposals = await store.listProposalsForProject(PROJECT_ID, { status: "pending" });
    const proposal = proposals.find((p) => p.kind === "suggested_rule");
    expect(proposal).toBeDefined();
    const payload = proposal!.payload as {
      conditions: { op: string; value: unknown }[];
      actions: { type: string; params: unknown }[];
      detected?: { sampleSize: number; matchCount: number; matchRate: number; windowDays: number; estimatedMinutesSavedPerMonth: number };
    };
    expect(payload.conditions).toEqual([{ field: "state", op: "state_equals", value: "todo" }]);
    expect(payload.actions).toEqual([{ type: "move_task", params: { toState: "ongoing" } }]);
    expect(payload.detected?.matchCount).toBe(3);
    expect(payload.detected?.sampleSize).toBe(3);
    expect(payload.detected?.matchRate).toBe(1); // every human move OUT of "todo" in this test went to "ongoing"
    expect(payload.detected?.estimatedMinutesSavedPerMonth).toBeGreaterThan(0);

    // A second sweep doesn't duplicate the same pattern (it's already pending).
    await engine.sweepPatternDetection();
    const again = (await store.listProposalsForProject(PROJECT_ID, { status: "pending" })).filter((p) => p.kind === "suggested_rule");
    expect(again).toHaveLength(1);
  });

  it("one task moved 3 times is noise, not a pattern — requires DISTINCT tasks", async () => {
    const { store, engine } = await setup();
    await store.createTransition(humanMove({ id: "tr1", taskId: "ta" }));
    await store.createTransition(humanMove({ id: "tr2", taskId: "ta" }));
    await store.createTransition(humanMove({ id: "tr3", taskId: "ta" }));
    await engine.sweepPatternDetection();
    expect(await store.listProposalsForProject(PROJECT_ID)).toEqual([]);
  });

  it("ignores machine-actor and rule-driven moves — only actor:'human', ruleId:null counts", async () => {
    const { store, engine } = await setup();
    await store.createTransition(humanMove({ id: "tr1", taskId: "ta" }));
    await store.createTransition(humanMove({ id: "tr2", taskId: "tb" }));
    await store.createTransition(humanMove({ id: "tr3", taskId: "tc", actor: "machine", actorId: null }));
    await store.createTransition(humanMove({ id: "tr4", taskId: "td", ruleId: "some-rule" }));
    await engine.sweepPatternDetection();
    expect(await store.listProposalsForProject(PROJECT_ID)).toEqual([]);
  });

  it("ignores transitions outside the detection window", async () => {
    const { store, engine } = await setup();
    const old = Date.now() - 40 * 24 * 60 * 60 * 1000; // 40 days ago — past the 30-day default window
    await store.createTransition(humanMove({ id: "tr1", taskId: "ta", at: old }));
    await store.createTransition(humanMove({ id: "tr2", taskId: "tb", at: old }));
    await store.createTransition(humanMove({ id: "tr3", taskId: "tc", at: old }));
    await engine.sweepPatternDetection();
    expect(await store.listProposalsForProject(PROJECT_ID)).toEqual([]);
  });

  it("a pattern the operator already dismissed ('Never') is not re-proposed", async () => {
    const { store, engine } = await setup();
    await store.createTransition(humanMove({ id: "tr1", taskId: "ta" }));
    await store.createTransition(humanMove({ id: "tr2", taskId: "tb" }));
    await store.createTransition(humanMove({ id: "tr3", taskId: "tc" }));
    await engine.sweepPatternDetection();

    const [proposal] = await store.listProposalsForProject(PROJECT_ID, { status: "pending" });
    await store.putProposal({ ...proposal!, status: "dismissed", resolvedAt: Date.now() });

    await engine.sweepPatternDetection();
    const suggested = (await store.listProposalsForProject(PROJECT_ID)).filter((p) => p.kind === "suggested_rule");
    expect(suggested).toHaveLength(1); // still just the one dismissed row — no fresh duplicate
    expect(suggested[0]!.status).toBe("dismissed");
  });

  it("a pattern already accepted into a real Rule is not re-proposed — the underlying Transitions never expire from the window on their own", async () => {
    const { store, engine } = await setup();
    await store.createTransition(humanMove({ id: "tr1", taskId: "ta" }));
    await store.createTransition(humanMove({ id: "tr2", taskId: "tb" }));
    await store.createTransition(humanMove({ id: "tr3", taskId: "tc" }));
    await engine.sweepPatternDetection();

    // Simulate "Turn it on": accept the proposal into a real, live Rule —
    // the SAME conditions/actions the detector generated.
    const [proposal] = await store.listProposalsForProject(PROJECT_ID, { status: "pending" });
    const payload = proposal!.payload as { conditions: unknown; actions: unknown };
    await store.putProposal({ ...proposal!, status: "accepted", resolvedAt: Date.now() });
    await store.putRule({
      id: "rule-from-proposal", workspaceId: DEFAULT_WORKSPACE, projectId: PROJECT_ID, name: "Auto: Todo → Ongoing",
      when: "x", conditions: payload.conditions as never, actions: payload.actions as never,
      safety: { announceBeforeActing: true, undoWindowMin: 10, pauseAfterUndos: 3, excludePriorities: [] },
      stats: { moves: 0, undos: 0, watchMatches: 0 }, state: "live", pausedReason: null,
      createdAt: Date.now(), watchStartedAt: null, updatedAt: Date.now(), archived: false,
    });

    await engine.sweepPatternDetection(); // the same 3 historical Transitions are still well within the window
    const suggested = (await store.listProposalsForProject(PROJECT_ID, { status: "pending" })).filter((p) => p.kind === "suggested_rule");
    expect(suggested).toHaveLength(0); // no duplicate proposal for a pattern that's already a real rule
  });
});

describe("rule engine — watch-state rules (TASK 10)", () => {
  const watchRule = (over: Partial<Rule> = {}): Rule => ({
    id: "rule-watch", workspaceId: DEFAULT_WORKSPACE, projectId: PROJECT_ID, name: "Watching",
    when: "x", conditions: [{ field: "state", op: "state_equals", value: "ongoing" }],
    actions: [{ type: "move_task", params: { toState: "review" } }],
    safety: { announceBeforeActing: true, undoWindowMin: 10, pauseAfterUndos: 3, excludePriorities: [] },
    stats: { moves: 0, undos: 0, watchMatches: 0 }, state: "watch", pausedReason: null,
    createdAt: Date.now(), watchStartedAt: Date.now(), updatedAt: Date.now(), archived: false, ...over,
  });

  it("a matching watch rule bumps stats.watchMatches — evaluated and logged, never acts", async () => {
    const { store, bus } = await setup();
    await store.putTask(mkTask({ state: "ongoing" }));
    await store.putRule(watchRule());

    bus.publish(DEFAULT_WORKSPACE, { type: "task.upserted", task: mkTask({ state: "ongoing" }) });
    await waitFor(async () => ((await store.getRule("rule-watch"))?.stats.watchMatches ?? 0) > 0);

    expect((await store.getRule("rule-watch"))?.stats.watchMatches).toBe(1);
    expect((await store.getTask("t1"))?.state).toBe("ongoing"); // never moved
    expect(await store.listTransitionsForTask("t1")).toEqual([]); // never a Transition
  });

  it("a non-matching watch rule does nothing", async () => {
    const { store, bus } = await setup();
    await store.putTask(mkTask({ state: "todo" }));
    await store.putRule(watchRule());
    bus.publish(DEFAULT_WORKSPACE, { type: "task.upserted", task: mkTask({ state: "todo" }) });
    await new Promise((r) => setTimeout(r, 30));
    expect((await store.getRule("rule-watch"))?.stats.watchMatches).toBe(0);
  });
});

describe("rule engine — watch-promotion sweep (TASK 10)", () => {
  const watchRule = (over: Partial<Rule> = {}): Rule => ({
    id: "rule-watch", workspaceId: DEFAULT_WORKSPACE, projectId: PROJECT_ID, name: "Watching",
    when: "x", conditions: [], actions: [],
    safety: { announceBeforeActing: true, undoWindowMin: 10, pauseAfterUndos: 3, excludePriorities: [] },
    stats: { moves: 0, undos: 0, watchMatches: 0 }, state: "watch", pausedReason: null,
    createdAt: Date.now() - 8 * 24 * 60 * 60 * 1000, watchStartedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
    updatedAt: Date.now() - 8 * 24 * 60 * 60 * 1000, archived: false, ...over,
  });

  it("promotes an unmodified watch rule to live once the promotion window has elapsed", async () => {
    const { store, engine } = await setup();
    await store.putRule(watchRule());
    await engine.sweepWatchPromotion();
    const rule = await store.getRule("rule-watch");
    expect(rule?.state).toBe("live");
    expect(rule?.watchStartedAt).toBeNull();
  });

  it("does not promote before the promotion window elapses", async () => {
    const { store, engine } = await setup();
    const recent = Date.now() - 60_000; // 1 minute ago — nowhere near the 7-day default
    await store.putRule(watchRule({ watchStartedAt: recent, createdAt: recent, updatedAt: recent }));
    await engine.sweepWatchPromotion();
    expect((await store.getRule("rule-watch"))?.state).toBe("watch");
  });

  it("does not promote a rule the operator edited during its watch week", async () => {
    const { store, engine } = await setup();
    const watchStartedAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
    await store.putRule(watchRule({ watchStartedAt, createdAt: watchStartedAt, updatedAt: Date.now() - 60_000 })); // touched 1 minute ago
    await engine.sweepWatchPromotion();
    expect((await store.getRule("rule-watch"))?.state).toBe("watch"); // left alone for the operator
  });
});

describe("rule engine — failed action visibility + retry (TASK 13 hardening)", () => {
  const failRule = (over: Partial<Rule> = {}): Rule => ({
    id: "rule-fail", workspaceId: DEFAULT_WORKSPACE, projectId: PROJECT_ID, name: "Failable",
    when: "x", conditions: [{ field: "state", op: "state_equals", value: "ongoing" }],
    actions: [{ type: "create_proposal", params: { kind: "stall_nudge", payload: {} } }],
    safety: { announceBeforeActing: true, undoWindowMin: 0, pauseAfterUndos: 3, excludePriorities: [] },
    stats: { moves: 0, undos: 0, watchMatches: 0 }, state: "live", pausedReason: null,
    createdAt: Date.now(), watchStartedAt: null, updatedAt: Date.now(), archived: false, ...over,
  });

  /** Makes the NEXT `store.putProposal` call throw once — the real,
   *  genuinely throw-capable persistence call inside applyAction's
   *  create_proposal case (see engine.ts's own audit comment). */
  function failNextPutProposal(store: MemoryStore): void {
    const original = store.putProposal.bind(store);
    store.putProposal = (async (p) => {
      store.putProposal = original;
      throw new Error("simulated store failure");
    }) as typeof store.putProposal;
  }

  it("immediate path (announceBeforeActing:false): a failed action records a status:'failed' Transition, never throws out to the caller", async () => {
    const { store, bus } = await setup();
    await store.putTask(mkTask({ state: "ongoing" }));
    await store.putRule(failRule({ safety: { announceBeforeActing: false, undoWindowMin: 0, pauseAfterUndos: 3, excludePriorities: [] } }));
    failNextPutProposal(store);

    bus.publish(DEFAULT_WORKSPACE, { type: "task.upserted", task: mkTask({ state: "ongoing" }) });
    await waitFor(async () => (await store.listTransitionsForTask("t1")).length > 0);

    const [transition] = await store.listTransitionsForTask("t1");
    expect(transition?.status).toBe("failed");
    expect(transition?.failureReason).toContain("simulated store failure");
    expect(transition?.from).toBe(transition?.to); // no real move — nothing to move for create_proposal anyway
    expect(transition?.ruleId).toBe("rule-fail");
    expect((await store.getTask("t1"))?.state).toBe("ongoing"); // task itself untouched by the failure
  });

  it("announce path: a failure at finalize is recorded as status:'failed' and the pending action is finalized, not left dangling for silent infinite retry", async () => {
    const { store, bus, engine } = await setup();
    await store.putTask(mkTask({ state: "ongoing" }));
    await store.putRule(failRule()); // announceBeforeActing:true, undoWindowMin:0 — ready immediately

    bus.publish(DEFAULT_WORKSPACE, { type: "task.upserted", task: mkTask({ state: "ongoing" }) });
    await waitFor(async () => (await store.listPendingActionsForProject(PROJECT_ID)).length > 0);
    const pending = (await store.listPendingActionsForProject(PROJECT_ID))[0]!;
    expect(pending.status).toBe("pending");

    failNextPutProposal(store); // arm it right before the sweep actually calls applyAction
    await engine.sweepPendingActions();

    const finalized = await store.getPendingRuleAction(pending.id);
    expect(finalized?.status).toBe("finalized"); // NOT stuck at "pending" — see the audit's own finding
    expect(finalized?.transitionId).toBeTruthy();
    const failedTransition = (await store.listTransitionsForTask("t1")).find((t) => t.id === finalized!.transitionId);
    expect(failedTransition?.status).toBe("failed");
    expect(failedTransition?.failureReason).toContain("simulated store failure");

    // A second sweep does NOT retry it again — no silent infinite-retry, no
    // duplicate proposal (the exact bug the audit flagged in the old design).
    await engine.sweepPendingActions();
    expect(await store.listTransitionsForTask("t1")).toHaveLength(1);

    // Retry, this time letting it actually succeed — the operator-triggered
    // path replacing the old accidental auto-retry.
    await engine.retryFailedAction("rule-fail", "t1");
    const afterRetry = await store.listPendingActionsForProject(PROJECT_ID);
    expect(afterRetry).toHaveLength(2); // the original failed hold + a fresh one from the retry
    const fresh = afterRetry.find((p) => p.id !== pending.id)!;
    expect(fresh.status).toBe("pending");
    await engine.sweepPendingActions();
    const proposals = await store.listProposalsForProject(PROJECT_ID, { status: "pending" });
    expect(proposals.some((p) => p.kind === "stall_nudge")).toBe(true); // the retry's action actually completed this time
  });

  it("retryFailedAction throws a clear error for a rule/task that no longer exists", async () => {
    const { engine } = await setup();
    await expect(engine.retryFailedAction("nope", "also-nope")).rejects.toThrow(/no longer exists/);
  });
});
