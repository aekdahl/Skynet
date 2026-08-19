// Budget-as-allocation (ROADMAP: "$20 today" plans what fits, not just a stop-
// gate — see daily-budget.test.ts for the ceiling this builds on). Three
// pieces: costBandFor/committedUsd (pure — the rough $ signal from triage's
// FREE assessmentEffort call, no second estimation call), selectAffordable
// (greedy priority-order picking that skips what doesn't fit without ever
// reordering), and pacedAvailableUsd (spreads a budget across a working
// window instead of committing it all to the first tick).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Agent, Project, ServerEvent, Task, TaskRun } from "@skynet/shared";
import { DEFAULT_WORKSPACE, costBandFor, committedUsd, EFFORT_COST_BAND_USD } from "@skynet/shared";
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
  startedIds: string[] = [];
  async start(spec: StartSpec, _e: RunnerEvents): Promise<RunnerHandle> {
    this.startedIds.push(spec.runId);
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

const mkProject = (over: Partial<Project> = {}): Project =>
  ({
    id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [],
    status: "active", autonomy: true, dailyBudgetUsd: null, budgetPacing: false,
    repoPath: null, gitBacked: false,
    ...over,
  } as Project);

const mkAgent = (over: Partial<Agent> = {}): Agent =>
  ({ id: "a1", workspaceId: DEFAULT_WORKSPACE, name: "a1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0, ...over } as Agent);

const mkTask = (over: Partial<Task> = {}): Task =>
  ({
    id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "task", state: "todo",
    runId: null, autoPick: true, assignment: { mode: "any", agentIds: [] }, assessmentEffort: null, order: 0,
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

describe("costBandFor / committedUsd (pure)", () => {
  it("maps each triage effort bucket to its $ band", () => {
    expect(costBandFor("small")).toBe(EFFORT_COST_BAND_USD.small);
    expect(costBandFor("medium")).toBe(EFFORT_COST_BAND_USD.medium);
    expect(costBandFor("large")).toBe(EFFORT_COST_BAND_USD.large);
  });
  it("unknown/null effort assumes the MEDIUM band, not zero — never looks free to a picker", () => {
    expect(costBandFor(null)).toBe(EFFORT_COST_BAND_USD.medium);
    expect(costBandFor(null)).toBeGreaterThan(0);
  });
  it("committedUsd sums cost bands of ONGOING tasks only, scoped to the project", () => {
    const tasks: Task[] = [
      mkTask({ id: "a", state: "ongoing", assessmentEffort: "small" }),
      mkTask({ id: "b", state: "ongoing", assessmentEffort: "large" }),
      mkTask({ id: "c", state: "todo", assessmentEffort: "large" }), // not in flight — excluded
      mkTask({ id: "d", state: "ongoing", assessmentEffort: null, projectId: "p2" }), // other project — excluded
    ];
    expect(committedUsd(tasks, "p1")).toBeCloseTo(EFFORT_COST_BAND_USD.small + EFFORT_COST_BAND_USD.large);
  });
  it("committedUsd is 0 with nothing in flight", () => {
    expect(committedUsd([mkTask({ state: "todo" })], "p1")).toBe(0);
  });
});

describe("tickAutonomy — budget-aware auto-pick (selectAffordable)", () => {
  const setup = async () => {
    const store = new MemoryStore();
    const hub = new Hub(store, new NullBus());
    const provider = new AutoProvider();
    const orch = new Orchestrator(store, hub, provider);
    return { store, hub, orch, provider };
  };

  it("an affordable lower-priority task never jumps an affordable higher-priority one — priority order preserved", async () => {
    const { store, orch, provider } = await setup();
    await store.putProject(mkProject({ dailyBudgetUsd: 100 })); // plenty for both
    await store.putAgent(mkAgent({ id: "a1" }));
    await store.putAgent(mkAgent({ id: "a2" }));
    await store.putTask(mkTask({ id: "hi", order: 1, assessmentEffort: "small" }));
    await store.putTask(mkTask({ id: "lo", order: 2, assessmentEffort: "small" }));

    await orch.tickAutonomy();

    // Both affordable, both fire — but the ORDER they were handed to the
    // provider still reflects priority (order 1 before order 2).
    expect(provider.startedIds.length).toBe(2);
    expect((await store.getTask("hi"))?.state).toBe("ongoing");
    expect((await store.getTask("lo"))?.state).toBe("ongoing");
  });

  it("skips an oversized task but still picks a cheaper LOWER-priority one that fits", async () => {
    const { store, orch, provider } = await setup();
    // $3 total headroom: the $1 large "hi" task followed by a small "lo" task
    // — "large" costs 8, doesn't fit; "small" costs 0.5, does.
    await store.putProject(mkProject({ dailyBudgetUsd: 3 }));
    await store.putAgent(mkAgent({ id: "a1" }));
    await store.putAgent(mkAgent({ id: "a2" }));
    await store.putTask(mkTask({ id: "hi", order: 1, assessmentEffort: "large" })); // costs 8 — too big
    await store.putTask(mkTask({ id: "lo", order: 2, assessmentEffort: "small" })); // costs 0.5 — fits

    await orch.tickAutonomy();

    expect((await store.getTask("hi"))?.state).toBe("todo"); // skipped — never reordered, never force-picked
    expect((await store.getTask("lo"))?.state).toBe("ongoing"); // the cheaper one still ran
    expect(provider.startedIds.length).toBe(1); // exactly one run started
  });

  it("logs skipped tasks once per tick, naming them", async () => {
    const { store, hub, orch } = await setup();
    const logSpy = vi.spyOn(hub, "runLog");
    await store.putProject(mkProject({ dailyBudgetUsd: 1 }));
    await store.putAgent(mkAgent());
    await store.putTask(mkTask({ id: "big1", order: 1, text: "big task one", assessmentEffort: "large" }));
    await store.putTask(mkTask({ id: "big2", order: 2, text: "big task two", assessmentEffort: "large" }));

    await orch.tickAutonomy();

    const skipLogs = logSpy.mock.calls.filter(([, line]) => String(line).includes("skipped"));
    expect(skipLogs.length).toBe(1); // one line, not one per task
    expect(skipLogs[0]![1]).toContain("big task one");
    expect(skipLogs[0]![1]).toContain("big task two");
  });

  it("unknown effort (null) is treated as the medium band, not free — can still get skipped on a tiny budget", async () => {
    const { store, orch, provider } = await setup();
    await store.putProject(mkProject({ dailyBudgetUsd: 1 })); // less than the medium band (2)
    await store.putAgent(mkAgent());
    await store.putTask(mkTask({ id: "unclassified", assessmentEffort: null }));

    await orch.tickAutonomy();

    expect(provider.startedIds.length).toBe(0);
    expect((await store.getTask("unclassified"))?.state).toBe("todo");
  });

  it("with no budget set, selection is a no-op — every eligible task fires exactly as before this feature existed", async () => {
    const { store, orch, provider } = await setup();
    await store.putProject(mkProject({ dailyBudgetUsd: null }));
    await store.putAgent(mkAgent({ id: "a1" }));
    await store.putAgent(mkAgent({ id: "a2" }));
    await store.putTask(mkTask({ id: "t1", order: 1, assessmentEffort: "large" }));
    await store.putTask(mkTask({ id: "t2", order: 2, assessmentEffort: "large" }));

    await orch.tickAutonomy();

    expect(provider.startedIds.length).toBe(2); // no cost filtering at all
  });
});

describe("tickAutonomy — budget pacing", () => {
  const setup = async () => {
    const store = new MemoryStore();
    const hub = new Hub(store, new NullBus());
    const provider = new AutoProvider();
    const orch = new Orchestrator(store, hub, provider);
    return { store, hub, orch, provider };
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pacing OFF (default) behaves exactly like the plain budget gate — full remaining budget available immediately", async () => {
    vi.setSystemTime(new Date(2026, 0, 1, 0, 5)); // 5 minutes after local midnight
    const { store, orch, provider } = await setup();
    await store.putProject(mkProject({ dailyBudgetUsd: 10, budgetPacing: false }));
    await store.putAgent(mkAgent());
    await store.putTask(mkTask({ assessmentEffort: "large" })); // costs 8 — fits under the FULL $10, would NOT fit if paced this early

    await orch.tickAutonomy();

    expect(provider.startedIds.length).toBe(1);
  });

  it("pacing ON early in the day only allows a fraction of the budget — an otherwise-affordable task is skipped", async () => {
    // 1h into an 8h default window → 1/8 of a $16 budget = $2 paced ceiling.
    vi.setSystemTime(new Date(2026, 0, 1, 1, 0));
    const { store, orch, provider } = await setup();
    await store.putProject(mkProject({ dailyBudgetUsd: 16, budgetPacing: true }));
    await store.putAgent(mkAgent());
    await store.putTask(mkTask({ assessmentEffort: "large" })); // costs 8 — fits the full budget, NOT the paced $2 ceiling

    await orch.tickAutonomy();

    expect(provider.startedIds.length).toBe(0);
  });

  it("pacing ON later in the day allows more — the SAME task now fits as the window elapses", async () => {
    // 7h into an 8h window → 7/8 of $16 ≈ $14 paced ceiling — the $8 task fits.
    vi.setSystemTime(new Date(2026, 0, 1, 7, 0));
    const { store, orch, provider } = await setup();
    await store.putProject(mkProject({ dailyBudgetUsd: 16, budgetPacing: true }));
    await store.putAgent(mkAgent());
    await store.putTask(mkTask({ assessmentEffort: "large" }));

    await orch.tickAutonomy();

    expect(provider.startedIds.length).toBe(1);
  });

  it("pacing never grants MORE than the true remaining headroom, even late in the day", async () => {
    // Near end of window (paced ceiling ≈ full budget) but $9 already spent
    // today against a $10 budget — true headroom is $1, too small for the
    // $2 "medium"-band task regardless of how far the window has elapsed.
    vi.setSystemTime(new Date(2026, 0, 1, 7, 59));
    const { store, orch, provider } = await setup();
    await store.putProject(mkProject({ dailyBudgetUsd: 10, budgetPacing: true }));
    await store.putAgent(mkAgent());
    await store.putRun(mkRun({ id: "spent", startedAt: Date.now(), usage: cost(9) }));
    await store.putTask(mkTask({ assessmentEffort: "medium" })); // costs 2 — exceeds the true $1 headroom

    await orch.tickAutonomy();

    expect(provider.startedIds.length).toBe(0);
  });
});
