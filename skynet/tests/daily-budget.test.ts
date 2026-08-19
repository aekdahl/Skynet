// Daily budget ceiling (ROADMAP: "today we develop for $20"). Two layers:
// computeDailySpend (pure — the one place "how much has this project spent
// today" is computed, shared by the autonomy gate and the web project header)
// and the tickAutonomy gate itself (skips auto-pick once known spend reaches
// the budget; manual assignTask is never gated; day rollover is a property of
// always recomputing "today" from `now()`, not a separate reset).
import { describe, it, expect, vi } from "vitest";
import type { Agent, Project, ServerEvent, Task, TaskRun } from "@skynet/shared";
import { DEFAULT_WORKSPACE, computeDailySpend, dayWindow } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

class NullBus implements Bus {
  publish(_ws: string, _e: ServerEvent): void {}
  subscribe(): () => void {
    return () => {};
  }
}
class AutoProvider implements RunnerProvider {
  readonly id = "claude" as const;
  started = 0;
  async start(spec: StartSpec, _e: RunnerEvents): Promise<RunnerHandle> {
    this.started++;
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

const mkProject = (over: Partial<Project> = {}): Project =>
  ({
    id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [],
    status: "active", autonomy: true, dailyBudgetUsd: null, repoPath: null, gitBacked: false,
    ...over,
  } as Project);

const mkAgent = (over: Partial<Agent> = {}): Agent =>
  ({ id: "a1", workspaceId: DEFAULT_WORKSPACE, name: "a1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0, ...over } as Agent);

const mkTask = (over: Partial<Task> = {}): Task =>
  ({
    id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "do X", state: "todo",
    runId: null, autoPick: true, assignment: { mode: "any", agentIds: [] },
    ...over,
  } as Task);

const mkRun = (over: Partial<TaskRun> = {}): TaskRun =>
  ({
    id: "r1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", name: "run", status: "done",
    agentId: "a1", provider: "claude", credentialId: null, model: "opus-4.8", branch: "agent/r1",
    modules: [], progress: 1, plan: [], usage: null, modifiedFiles: [], log: [], startedAt: Date.now(),
    lastHeartbeatAt: Date.now(), visual: false, previewUrl: null, dependsOn: [], parentId: null,
    branchFromStep: null, archived: false, pr: null,
    ...over,
  } as TaskRun);

const cost = (usd: number | null) => ({ inputTokens: 0, outputTokens: 0, costUsd: usd, turns: 0, durationMs: null });

describe("computeDailySpend (pure)", () => {
  it("sums known costs and counts unknown-cost runs separately", () => {
    const now = Date.now();
    const runs = [
      mkRun({ id: "r1", startedAt: now, usage: cost(3) }),
      mkRun({ id: "r2", startedAt: now, usage: cost(2) }),
      mkRun({ id: "r3", startedAt: now, usage: null }), // vendor reported nothing at all
      mkRun({ id: "r4", startedAt: now, usage: cost(null) }), // usage present, cost omitted
    ];
    const spend = computeDailySpend(runs, "p1", now);
    expect(spend.spentUsd).toBe(5);
    expect(spend.unknownCostRuns).toBe(2);
  });

  it("only counts runs for the given project", () => {
    const now = Date.now();
    const runs = [
      mkRun({ id: "r1", projectId: "p1", startedAt: now, usage: cost(10) }),
      mkRun({ id: "r2", projectId: "p2", startedAt: now, usage: cost(99) }),
    ];
    expect(computeDailySpend(runs, "p1", now).spentUsd).toBe(10);
  });

  it("day rollover: a run from yesterday isn't counted against today, but IS counted against yesterday's own window", () => {
    const today = Date.now();
    const yesterday = today - 24 * 60 * 60 * 1000;
    const run = mkRun({ startedAt: yesterday, usage: cost(7) });
    expect(computeDailySpend([run], "p1", today).spentUsd).toBe(0);
    expect(computeDailySpend([run], "p1", yesterday).spentUsd).toBe(7);
  });

  it("dayWindow spans exactly 24h starting at local midnight", () => {
    const w = dayWindow(Date.now());
    expect(w.end - w.start).toBe(24 * 60 * 60 * 1000);
    expect(new Date(w.start).getHours()).toBe(0);
    expect(new Date(w.start).getMinutes()).toBe(0);
  });
});

describe("tickAutonomy — daily budget gate", () => {
  const setup = async () => {
    const store = new MemoryStore();
    const hub = new Hub(store, new NullBus());
    const provider = new AutoProvider();
    const orch = new Orchestrator(store, hub, provider);
    return { store, hub, orch, provider };
  };

  it("skips auto-pick once known spend reaches the budget", async () => {
    const { store, orch, provider } = await setup();
    await store.putProject(mkProject({ dailyBudgetUsd: 10 }));
    await store.putAgent(mkAgent());
    await store.putRun(mkRun({ id: "spent", startedAt: Date.now(), usage: cost(10) }));
    await store.putTask(mkTask());

    await orch.tickAutonomy();

    expect(provider.started).toBe(0);
    expect((await store.getTask("t1"))?.state).toBe("todo"); // never picked up
  });

  it("proceeds when known spend is still under the budget", async () => {
    const { store, orch, provider } = await setup();
    await store.putProject(mkProject({ dailyBudgetUsd: 10 }));
    await store.putAgent(mkAgent());
    await store.putRun(mkRun({ id: "spent", startedAt: Date.now(), usage: cost(3) }));
    await store.putTask(mkTask());

    await orch.tickAutonomy();

    expect(provider.started).toBe(1);
    expect((await store.getTask("t1"))?.state).toBe("ongoing");
  });

  it("an unset budget (null) is completely unaffected — byte-for-byte today's behavior", async () => {
    const { store, orch, provider } = await setup();
    await store.putProject(mkProject({ dailyBudgetUsd: null }));
    await store.putAgent(mkAgent());
    await store.putRun(mkRun({ id: "spent", startedAt: Date.now(), usage: cost(999_999) }));
    await store.putTask(mkTask());

    await orch.tickAutonomy();

    expect(provider.started).toBe(1);
  });

  it("unknown-cost runs are a floor, not silently dropped — they don't themselves trip the gate", async () => {
    const { store, orch, provider } = await setup();
    await store.putProject(mkProject({ dailyBudgetUsd: 1 })); // a tiny budget
    await store.putAgent(mkAgent());
    // Two runs today with no reported cost at all — real spend may be well
    // above $1, but the gate only acts on KNOWN spend (which is $0 here).
    await store.putRun(mkRun({ id: "u1", startedAt: Date.now(), usage: null }));
    await store.putRun(mkRun({ id: "u2", startedAt: Date.now(), usage: cost(null) }));
    // assessmentEffort: "small" — an unrelated dimension (budget-allocation's
    // cost-band picking, see budget-allocation.test.ts) treats a task with NO
    // effort signal as the conservative "medium" band ($2), which would
    // itself exceed this test's $1 budget and mask what THIS test is actually
    // checking (that unreported RUN cost doesn't trip the gate). Pin it small
    // ($0.5, well under $1) so only the dimension under test varies.
    await store.putTask(mkTask({ assessmentEffort: "small" }));

    await orch.tickAutonomy();

    expect(provider.started).toBe(1); // not blocked — known spend is $0
  });

  it("manual assignTask is never gated by budget, even while auto-pick is paused", async () => {
    const { store, orch, provider } = await setup();
    await store.putProject(mkProject({ dailyBudgetUsd: 1 }));
    await store.putAgent(mkAgent());
    await store.putRun(mkRun({ id: "spent", startedAt: Date.now(), usage: cost(5) }));
    await store.putTask(mkTask());

    const run = await orch.assignTask("p1", "t1");

    expect(run).toBeTruthy();
    expect(provider.started).toBe(1);
  });

  it("logs the pause once per transition into paused, not once per tick", async () => {
    const { store, hub, orch } = await setup();
    const logSpy = vi.spyOn(hub, "runLog");
    await store.putProject(mkProject({ dailyBudgetUsd: 1 }));
    await store.putAgent(mkAgent());
    await store.putRun(mkRun({ id: "spent", startedAt: Date.now(), usage: cost(5) }));
    await store.putTask(mkTask());

    await orch.tickAutonomy();
    await orch.tickAutonomy();
    await orch.tickAutonomy();

    const budgetLogs = logSpy.mock.calls.filter(([runId]) => String(runId).startsWith("budget-"));
    expect(budgetLogs.length).toBe(1);
    expect(budgetLogs[0]![1]).toMatch(/autonomy paused for today/);
  });

  it("other projects in the same workspace are unaffected by one project's exhausted budget", async () => {
    const { store, orch, provider } = await setup();
    await store.putProject(mkProject({ id: "p1", dailyBudgetUsd: 1 }));
    await store.putProject(mkProject({ id: "p2", dailyBudgetUsd: null }));
    await store.putAgent(mkAgent());
    await store.putAgent(mkAgent({ id: "a2" }));
    await store.putRun(mkRun({ id: "spent", projectId: "p1", startedAt: Date.now(), usage: cost(5) }));
    await store.putTask(mkTask({ id: "t1", projectId: "p1" }));
    await store.putTask(mkTask({ id: "t2", projectId: "p2" }));

    await orch.tickAutonomy();

    expect((await store.getTask("t1"))?.state).toBe("todo"); // p1 paused
    expect((await store.getTask("t2"))?.state).toBe("ongoing"); // p2 unaffected
    expect(provider.started).toBe(1);
  });
});
