// The remote kill switch: orchestrator.stopAll() must pause autonomy AND halt
// every in-flight run, and a paused orchestrator's tickAutonomy() must be a no-op.
// Harness mirrors autonomy.test.ts (MemoryStore + Hub + an injected provider).
import { describe, it, expect } from "vitest";
import type { Agent, Project, Task, TaskRun, ServerEvent } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
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

class FakeProvider implements RunnerProvider {
  readonly id = "claude" as const;
  started = 0;
  async start(spec: StartSpec, _e: RunnerEvents): Promise<RunnerHandle> {
    this.started++;
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
  async consult(): Promise<string> {
    return "ok";
  }
}

const project: Project = {
  id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [],
  status: "active", autonomy: true, repoPath: null, gitBacked: false,
};
const idleAgent: Agent = {
  id: "a1", workspaceId: DEFAULT_WORKSPACE, name: "a1", provider: "claude",
  model: "opus-4.8", status: "idle", idleSince: 0,
};
const mkRun = (id: string, status: TaskRun["status"]): TaskRun => ({
  id, workspaceId: DEFAULT_WORKSPACE, projectId: "p1", name: `run ${id}`, status,
  agentId: "a1", provider: "claude", model: "opus-4.8", branch: `agent/${id}`, modules: [],
  progress: 0.5, plan: [], usage: null, modifiedFiles: [], log: [], startedAt: 0,
  lastHeartbeatAt: 0, visual: false, previewUrl: null, dependsOn: [], parentId: null,
  branchFromStep: null, archived: false,
});
const mkTask = (over: Partial<Task>): Task => ({
  id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "do X", state: "backlog",
  runId: null, autoPick: false, assessment: null, reviewVerdict: null,
  assignment: { mode: "any", agentIds: [] }, ...over,
});

const setup = async () => {
  const store = new MemoryStore();
  const hub = new Hub(store, new NullBus());
  const provider = new FakeProvider();
  const orch = new Orchestrator(store, hub, provider);
  await store.putProject(project);
  await store.putAgent(idleAgent);
  return { store, orch, provider };
};

describe("orchestrator kill switch (stopAll)", () => {
  it("halts every running/waiting run and pauses autonomy", async () => {
    const { store, orch } = await setup();
    await store.putRun(mkRun("r1", "running"));
    await store.putRun(mkRun("r2", "waiting"));

    const stopped = await orch.stopAll("kill switch via Telegram");

    expect(stopped).toBe(2);
    expect(orch.isPaused()).toBe(true);
    // Both runs are no longer running/waiting — halted terminal (done).
    expect((await store.getRun("r1"))?.status).not.toBe("running");
    expect((await store.getRun("r2"))?.status).not.toBe("waiting");
    expect((await store.getRun("r1"))?.status).toBe("done");
    expect((await store.getRun("r2"))?.status).toBe("done");
  });

  it("does NOT touch runs that were already terminal", async () => {
    const { store, orch } = await setup();
    await store.putRun(mkRun("r1", "running"));
    await store.putRun(mkRun("done1", "done"));

    const stopped = await orch.stopAll("kill switch");
    expect(stopped).toBe(1); // only the running one
  });

  it("makes tickAutonomy a no-op while paused", async () => {
    const { store, orch, provider } = await setup();
    // An auto-pick todo task would normally be started by autonomy.
    await store.putTask(mkTask({ state: "todo", autoPick: true }));

    await orch.stopAll("kill switch");
    expect(orch.isPaused()).toBe(true);

    await orch.tickAutonomy();
    // Paused → no work picked up: the task stays todo and no runner was started.
    expect((await store.getTask("t1"))?.state).toBe("todo");
    expect(provider.started).toBe(0);
  });

  it("resumes autonomy via setPaused(false)", async () => {
    const { orch } = await setup();
    await orch.stopAll("kill switch");
    expect(orch.isPaused()).toBe(true);
    orch.setPaused(false);
    expect(orch.isPaused()).toBe(false);
  });
});
