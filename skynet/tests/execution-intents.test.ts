// S10 — Execution intents: the pure feasibility resolver (steward/execution.ts)
// and the ONE server executor (Operations.executeStewardAction) built on it.
// Two halves: resolveExecutable is pure (no I/O) and tested directly with
// hand-built fixtures; the executor is tested through a REAL Operations +
// Orchestrator + MemoryStore so the composite's actual side effects (a task's
// state, a run getting started, autonomy flipping on) are the thing verified,
// not a mock of them.
import { describe, it, expect } from "vitest";
import type { Agent, Feature, Project, ProviderId, ServerEvent, Task, TaskRun } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { resolveExecutable } from "../apps/server/src/steward/execution.js";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { Operations } from "../apps/server/src/operations.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

// ─── fixtures ────────────────────────────────────────────────────────────
const mkProject = (over: Partial<Project> = {}): Project =>
  ({
    id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [],
    status: "active", autonomy: true, dailyBudgetUsd: null, budgetPacing: false,
    repoPath: null, gitBacked: false,
    ...over,
  } as Project);

const mkTask = (over: Partial<Task> = {}): Task =>
  ({
    id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "task", state: "todo",
    runId: null, autoPick: false, assignment: { mode: "unassigned", agentIds: [] },
    assessmentEffort: null, order: 0, archived: false, featureId: null,
    ...over,
  } as Task);

const mkRun = (over: Partial<TaskRun> = {}): TaskRun =>
  ({
    id: "r1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", name: "run", status: "running",
    agentId: "a1", provider: "claude", credentialId: null, model: "sonnet-5", branch: "agent/r1",
    modules: [], progress: 0, plan: [], usage: null, modifiedFiles: [], log: [], startedAt: Date.now(),
    lastHeartbeatAt: Date.now(), visual: false, previewUrl: null, dependsOn: [], parentId: null,
    branchFromStep: null, archived: false, pr: null,
    ...over,
  } as TaskRun);

const mkFeature = (over: Partial<Feature> = {}): Feature =>
  ({
    id: "f1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", name: "Feature", description: null,
    status: "active", milestoneId: null, archived: false, createdAt: 1, pr: null,
    ...over,
  } as Feature);

const mkAgent = (over: Partial<Agent> = {}): Agent =>
  ({ id: "a1", workspaceId: DEFAULT_WORKSPACE, name: "a1", provider: "claude", model: "sonnet-5", status: "idle", idleSince: 0, ...over } as Agent);

// ─── resolveExecutable (pure) ───────────────────────────────────────────────
describe("resolveExecutable (pure)", () => {
  it("excludes a triage-parked task as 'unclear' only when feasibleOnly is set", () => {
    const project = mkProject();
    const tasks = [mkTask({ id: "t1", state: "triage" })];

    const strict = resolveExecutable(project, tasks, [], { feasibleOnly: true, atMs: 1000 });
    expect(strict.eligible).toHaveLength(0);
    expect(strict.excluded).toEqual([{ taskId: "t1", reason: "unclear" }]);

    const lenient = resolveExecutable(project, tasks, [], { atMs: 1000 });
    expect(lenient.eligible.map((t) => t.id)).toEqual(["t1"]);
    expect(lenient.excluded).toEqual([]);
  });

  it("excludes ongoing/review as 'already-running' — ALWAYS, regardless of feasibleOnly (idempotency)", () => {
    const project = mkProject();
    const tasks = [mkTask({ id: "t1", state: "ongoing" }), mkTask({ id: "t2", state: "review" })];
    for (const feasibleOnly of [true, false, undefined]) {
      const r = resolveExecutable(project, tasks, [], { feasibleOnly, atMs: 1000 });
      expect(r.eligible).toHaveLength(0);
      expect(r.excluded.sort((a, b) => a.taskId.localeCompare(b.taskId))).toEqual([
        { taskId: "t1", reason: "already-running" },
        { taskId: "t2", reason: "already-running" },
      ]);
    }
  });

  it("excludes done tasks — always", () => {
    const project = mkProject();
    const r = resolveExecutable(project, [mkTask({ id: "t1", state: "done" })], [], { atMs: 1000 });
    expect(r.eligible).toHaveLength(0);
    expect(r.excluded).toEqual([{ taskId: "t1", reason: "done" }]);
  });

  it("excludes an archived task as 'not-in-scope' even if its state would otherwise be eligible", () => {
    const project = mkProject();
    const r = resolveExecutable(project, [mkTask({ id: "t1", state: "todo", archived: true })], [], { atMs: 1000 });
    expect(r.eligible).toHaveLength(0);
    expect(r.excluded).toEqual([{ taskId: "t1", reason: "not-in-scope" }]);
  });

  it("annotates a budget split honestly — a tight budget still walks priority order, skipping (not reordering) what doesn't fit", () => {
    const project = mkProject({ dailyBudgetUsd: 3 });
    const tasks = [
      mkTask({ id: "a", order: 0, assessmentEffort: null }), // medium, $2
      mkTask({ id: "b", order: 1, assessmentEffort: "small" }), // $0.5
      mkTask({ id: "c", order: 2, assessmentEffort: "large" }), // $8 — blows the remaining $0.5
    ];
    const r = resolveExecutable(project, tasks, [], { atMs: 1000 });
    // available 3 → "a" fits (2, leaves 1) → "b" fits (0.5, leaves 0.5) → "c" (8) doesn't.
    expect(r.eligible.map((t) => t.id)).toEqual(["a", "b"]);
    expect(r.excluded).toEqual([{ taskId: "c", reason: "over-budget" }]);
  });

  it("an over-budget task is still QUEUEABLE conceptually — reported, never silently dropped", () => {
    const project = mkProject({ dailyBudgetUsd: 0.1 });
    const r = resolveExecutable(project, [mkTask({ id: "t1", assessmentEffort: "small" })], [], { atMs: 1000 });
    expect(r.eligible).toHaveLength(0);
    expect(r.excluded).toEqual([{ taskId: "t1", reason: "over-budget" }]);
  });

  it("no budget set → unlimited headroom, nothing excluded for cost", () => {
    const project = mkProject({ dailyBudgetUsd: null });
    const tasks = [mkTask({ id: "a", assessmentEffort: "large" }), mkTask({ id: "b", assessmentEffort: "large" })];
    const r = resolveExecutable(project, tasks, [], { atMs: 1000 });
    expect(r.eligible.map((t) => t.id)).toEqual(["a", "b"]);
    expect(r.excluded).toEqual([]);
  });

  it("respects priority order (task.order, tie-broken by id) — the SAME sort tickAutonomy's auto-pick uses", () => {
    const project = mkProject();
    const tasks = [mkTask({ id: "z", order: 1 }), mkTask({ id: "m", order: 0 }), mkTask({ id: "a", order: 0 })];
    const r = resolveExecutable(project, tasks, [], { atMs: 1000 });
    expect(r.eligible.map((t) => t.id)).toEqual(["a", "m", "z"]); // order 0 ties broken a<m, then z
  });

  it("eligible.length + excluded.length === tasks.length — every candidate is accounted for", () => {
    const project = mkProject({ dailyBudgetUsd: 1 });
    const tasks = [
      mkTask({ id: "a", state: "todo", assessmentEffort: "large" }),
      mkTask({ id: "b", state: "done" }),
      mkTask({ id: "c", state: "ongoing" }),
      mkTask({ id: "d", state: "triage" }),
      mkTask({ id: "e", state: "todo", archived: true }),
    ];
    const r = resolveExecutable(project, tasks, [], { feasibleOnly: true, atMs: 1000 });
    expect(r.eligible.length + r.excluded.length).toBe(tasks.length);
  });
});

// ─── Operations.executeStewardAction (real Operations + Orchestrator + MemoryStore) ─
class NullBus implements Bus {
  publish(_ws: string, _e: ServerEvent): void {}
  subscribe(): () => void {
    return () => {};
  }
}
class AutoProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  startedIds: string[] = [];
  async start(spec: StartSpec, _e: RunnerEvents): Promise<RunnerHandle> {
    this.startedIds.push(spec.runId);
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

function setup() {
  const store = new MemoryStore({ seed: false });
  const hub = new Hub(store, new NullBus());
  const provider = new AutoProvider();
  const orch = new Orchestrator(store, hub, provider);
  const ops = new Operations({ store, hub, orchestrator: orch });
  return { store, hub, orch, ops, provider };
}

describe("Operations.executeStewardAction", () => {
  it("queue_tasks moves backlog→todo + autoPick — makes the task pickable, and the NEXT tickAutonomy actually starts it", async () => {
    const { store, orch, ops } = setup();
    await store.putProject(mkProject());
    await store.putAgent(mkAgent());
    await store.putTask(mkTask({ id: "t1", state: "backlog" }));

    const outcome = await ops.executeStewardAction(DEFAULT_WORKSPACE, "p1", { kind: "queue_tasks", taskIds: ["t1"] }, "op1");
    expect(outcome.queued).toEqual(["t1"]);
    expect(outcome.started).toEqual([]);
    expect(outcome.excluded).toEqual([]);

    const queued = await store.getTask("t1");
    expect(queued?.state).toBe("todo");
    expect(queued?.autoPick).toBe(true);
    expect(queued?.assignment.mode).toBe("any"); // was unassigned — fixed so the picker can see it

    await orch.tickAutonomy();
    const started = await store.getTask("t1");
    expect(started?.state).toBe("ongoing");
    expect(started?.runId).toBeTruthy();
  });

  it("queue_tasks reports an unknown/cross-project id as excluded, not silently dropped", async () => {
    const { store, ops } = setup();
    await store.putProject(mkProject());
    const outcome = await ops.executeStewardAction(DEFAULT_WORKSPACE, "p1", { kind: "queue_tasks", taskIds: ["nope"] }, "op1");
    expect(outcome.queued).toEqual([]);
    expect(outcome.excluded).toEqual([{ taskId: "nope", reason: "not-in-scope" }]);
  });

  it("start_feature(queue) on a feature with a done + an ongoing + two todo tasks touches ONLY the two todo tasks", async () => {
    const { store, ops } = setup();
    await store.putProject(mkProject());
    await store.putFeature(mkFeature());
    await store.putTask(mkTask({ id: "done1", featureId: "f1", state: "done" }));
    await store.putTask(mkTask({ id: "ongoing1", featureId: "f1", state: "ongoing", runId: "r1" }));
    await store.putTask(mkTask({ id: "todo1", featureId: "f1", state: "todo", order: 0, assignment: { mode: "any", agentIds: [] } }));
    await store.putTask(mkTask({ id: "todo2", featureId: "f1", state: "todo", order: 1, assignment: { mode: "any", agentIds: [] } }));

    const outcome = await ops.executeStewardAction(
      DEFAULT_WORKSPACE, "p1",
      { kind: "start_feature", featureId: "f1", execMode: "queue", feasibleOnly: true },
      "op1",
    );
    expect(outcome.queued).toEqual(["todo1", "todo2"]);
    expect(outcome.excluded.map((e) => e.taskId).sort()).toEqual(["done1", "ongoing1"]);
    expect((await store.getTask("done1"))?.state).toBe("done"); // untouched
    expect((await store.getTask("ongoing1"))?.state).toBe("ongoing"); // untouched
  });

  it("start_feature(start_now) with one idle runner assigns one and queues the rest — and folds autonomy on", async () => {
    const { store, ops, provider } = setup();
    await store.putProject(mkProject({ autonomy: false })); // also exercises the autonomy fold-in
    await store.putAgent(mkAgent());
    await store.putFeature(mkFeature());
    await store.putTask(mkTask({ id: "t1", featureId: "f1", state: "todo", order: 0, assignment: { mode: "any", agentIds: [] } }));
    await store.putTask(mkTask({ id: "t2", featureId: "f1", state: "todo", order: 1, assignment: { mode: "any", agentIds: [] } }));

    const outcome = await ops.executeStewardAction(
      DEFAULT_WORKSPACE, "p1",
      { kind: "start_feature", featureId: "f1", execMode: "start_now", feasibleOnly: true },
      "op1",
    );
    expect(outcome.started).toEqual(["t1"]);
    expect(outcome.queued).toEqual(["t2"]);
    expect(outcome.autonomyEnabled).toBe(true);
    expect(provider.startedIds).toHaveLength(1);

    expect((await store.getProject("p1"))?.autonomy).toBe(true);
    expect((await store.getTask("t1"))?.state).toBe("ongoing");
    const t2 = await store.getTask("t2");
    expect(t2?.state).toBe("todo");
    expect(t2?.autoPick).toBe(true);
  });

  it("process_backlog scopes to backlog+triage+todo only — never touches ongoing/done/review", async () => {
    const { store, ops } = setup();
    await store.putProject(mkProject());
    await store.putTask(mkTask({ id: "bl", state: "backlog", order: 0 }));
    await store.putTask(mkTask({ id: "tr", state: "triage", order: 1 })); // feasibleOnly excludes this one
    await store.putTask(mkTask({ id: "td", state: "todo", order: 2, assignment: { mode: "any", agentIds: [] } }));
    await store.putTask(mkTask({ id: "og", state: "ongoing" }));
    await store.putTask(mkTask({ id: "dn", state: "done" }));

    const outcome = await ops.executeStewardAction(DEFAULT_WORKSPACE, "p1", { kind: "process_backlog", feasibleOnly: true }, "op1");
    expect(outcome.queued.sort()).toEqual(["bl", "td"]);
    const excludedIds = outcome.excluded.map((e) => e.taskId).sort();
    expect(excludedIds).toEqual(["tr"]); // og/dn were never even in the candidate scope
  });

  it("start_task starts one task directly, without touching the rest of the board", async () => {
    const { store, ops } = setup();
    await store.putProject(mkProject());
    await store.putAgent(mkAgent());
    await store.putTask(mkTask({ id: "t1", state: "todo", assignment: { mode: "any", agentIds: [] } }));

    const outcome = await ops.executeStewardAction(DEFAULT_WORKSPACE, "p1", { kind: "start_task", taskId: "t1" }, "op1");
    expect(outcome.started).toEqual(["t1"]);
    expect((await store.getTask("t1"))?.state).toBe("ongoing");
  });

  it("start_task on an already-done task is refused honestly, not silently no-op'd or thrown", async () => {
    const { store, ops } = setup();
    await store.putProject(mkProject());
    await store.putTask(mkTask({ id: "t1", state: "done" }));
    const outcome = await ops.executeStewardAction(DEFAULT_WORKSPACE, "p1", { kind: "start_task", taskId: "t1" }, "op1");
    expect(outcome.started).toEqual([]);
    expect(outcome.excluded).toEqual([{ taskId: "t1", reason: "done" }]);
  });

  it("dry-run resolves feasibility and reports the autonomy fold-in — but mutates NOTHING", async () => {
    const { store, ops } = setup();
    await store.putProject(mkProject({ autonomy: false }));
    await store.putTask(mkTask({ id: "t1", state: "backlog" }));

    const outcome = await ops.executeStewardAction(
      DEFAULT_WORKSPACE, "p1",
      { kind: "queue_tasks", taskIds: ["t1"] },
      "op1",
      { dryRun: true },
    );
    expect(outcome.dryRun).toBe(true);
    expect(outcome.queued).toEqual(["t1"]);
    expect(outcome.autonomyEnabled).toBe(true); // reported honestly, even though not applied

    expect((await store.getTask("t1"))?.state).toBe("backlog"); // untouched
    expect((await store.getTask("t1"))?.autoPick).toBe(false); // untouched
    expect((await store.getProject("p1"))?.autonomy).toBe(false); // untouched
  });

  it("dry-run start_feature(start_now) never acquires a runner — reports every eligible task as 'would queue'", async () => {
    const { store, ops, provider } = setup();
    await store.putProject(mkProject());
    await store.putAgent(mkAgent());
    await store.putFeature(mkFeature());
    await store.putTask(mkTask({ id: "t1", featureId: "f1", state: "todo", assignment: { mode: "any", agentIds: [] } }));

    const outcome = await ops.executeStewardAction(
      DEFAULT_WORKSPACE, "p1",
      { kind: "start_feature", featureId: "f1", execMode: "start_now", feasibleOnly: true },
      "op1",
      { dryRun: true },
    );
    expect(outcome.started).toEqual([]);
    expect(outcome.queued).toEqual(["t1"]);
    expect(provider.startedIds).toEqual([]); // no runner ever acquired
    expect((await store.getTask("t1"))?.state).toBe("todo"); // untouched
  });

  it("re-issuing the SAME composite is a no-op for an already-started task — idempotency", async () => {
    const { store, ops } = setup();
    await store.putProject(mkProject());
    await store.putAgent(mkAgent());
    await store.putTask(mkTask({ id: "t1", state: "todo", assignment: { mode: "any", agentIds: [] } }));

    const first = await ops.executeStewardAction(DEFAULT_WORKSPACE, "p1", { kind: "start_task", taskId: "t1" }, "op1");
    expect(first.started).toEqual(["t1"]);

    const second = await ops.executeStewardAction(DEFAULT_WORKSPACE, "p1", { kind: "start_task", taskId: "t1" }, "op1");
    expect(second.started).toEqual([]);
    expect(second.excluded).toEqual([{ taskId: "t1", reason: "already-running" }]);
  });

  it("re-issuing the SAME composite is a no-op for already-queued tasks — doesn't re-queue or duplicate", async () => {
    const { store, ops } = setup();
    await store.putProject(mkProject({ autonomy: false })); // autonomy stays off after the tick hasn't run
    await store.putTask(mkTask({ id: "t1", state: "backlog" }));

    const first = await ops.executeStewardAction(DEFAULT_WORKSPACE, "p1", { kind: "queue_tasks", taskIds: ["t1"] }, "op1");
    expect(first.queued).toEqual(["t1"]);
    expect((await store.getProject("p1"))?.autonomy).toBe(true); // folded on by the first call

    // t1 is now "todo" — still a valid queue_tasks candidate (not done/ongoing) —
    // so a second issue re-applies the same target shape (idempotent, not an error).
    const second = await ops.executeStewardAction(DEFAULT_WORKSPACE, "p1", { kind: "queue_tasks", taskIds: ["t1"] }, "op1");
    expect(second.queued).toEqual(["t1"]);
    expect(second.autonomyEnabled).toBe(false); // already on — nothing new folded in
    expect((await store.getTask("t1"))?.state).toBe("todo");
  });

  it("throws NotFoundError for an unknown project/feature", async () => {
    const { store, ops } = setup();
    await store.putProject(mkProject());
    await expect(
      ops.executeStewardAction(DEFAULT_WORKSPACE, "nope", { kind: "process_backlog", feasibleOnly: true }, "op1"),
    ).rejects.toThrow(/not found/i);
    await expect(
      ops.executeStewardAction(DEFAULT_WORKSPACE, "p1", { kind: "start_feature", featureId: "nope", execMode: "queue", feasibleOnly: true }, "op1"),
    ).rejects.toThrow(/not found/i);
  });
});
