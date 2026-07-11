// DEF-003 / DEF-005: assigning a task must not double-spawn. Re-assigning an
// already-assigned task used to acquire a SECOND runner and create a SECOND
// agent, overwriting task.runId and orphaning the first agent + its runner.
// Assign is now idempotent (returns the existing agent) and refuses done tasks.
import { describe, it, expect } from "vitest";
import type { ProviderId, Agent, Project, Task } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator, TaskAlreadyAssignedError } from "../apps/server/src/orchestrator.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

class NullBus implements Bus {
  publish(): void {}
  subscribe(): () => void {
    return () => {};
  }
}

// A runner that just keeps running — never completes or fails — so the agent
// stays "running" and the task stays "assigned" while we re-assign it.
class RunningProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  starts = 0;
  async start(spec: StartSpec, _events: RunnerEvents): Promise<RunnerHandle> {
    this.starts++;
    return {
      runId: spec.runId,
      provider: this.id,
      async pause() {},
      async resume() {},
      async message() {},
      async stop() {},
    };
  }
}

function seed(store: MemoryStore, taskState: Task["state"] = "backlog") {
  const project: Project = {
    id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "Proj", goal: "", runIds: [], status: "active",
  };
  const task: Task = {
    id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "do the thing", state: taskState, runId: null,
  };
  // Two idle runners: proves the second assign doesn't grab the spare one.
  const runners: Agent[] = ["r1", "r2"].map((id) => ({
    id, workspaceId: DEFAULT_WORKSPACE, name: id,
    provider: "claude" as ProviderId, model: "opus-4.8", status: "idle", idleSince: 0,
  }));
  return Promise.all([
    store.putProject(project),
    store.putTask(task),
    ...runners.map((r) => store.putAgent(r)),
  ]);
}

const busyCount = async (store: MemoryStore) =>
  (await store.listAgents(DEFAULT_WORKSPACE)).filter((r) => r.status === "busy").length;

describe("assignTask is idempotent (DEF-003) and refuses done tasks (DEF-005)", () => {
  it("re-assigning an assigned task returns the same agent, spawns no second agent, leaks no runner", async () => {
    const store = new MemoryStore({ seed: false });
    const provider = new RunningProvider();
    const orchestrator = new Orchestrator(store, new Hub(store, new NullBus()), provider);
    await seed(store);

    const first = await orchestrator.assignTask("p1", "t1");
    expect(provider.starts).toBe(1);
    expect(await busyCount(store)).toBe(1);
    expect((await store.getTask("t1"))?.runId).toBe(first.id);

    const second = await orchestrator.assignTask("p1", "t1");

    // Same agent returned — no new one created, no new runner acquired.
    expect(second.id).toBe(first.id);
    expect(provider.starts).toBe(1); // provider.start NOT called again
    expect(await busyCount(store)).toBe(1); // r2 stayed idle — no leak
    expect((await store.getTask("t1"))?.runId).toBe(first.id); // pointer unchanged

    // Exactly one agent exists in the workspace (no orphan B).
    expect((await store.listRuns(DEFAULT_WORKSPACE)).length).toBe(1);
  });

  it("refuses to assign a done task (no runner acquired)", async () => {
    const store = new MemoryStore({ seed: false });
    const provider = new RunningProvider();
    const orchestrator = new Orchestrator(store, new Hub(store, new NullBus()), provider);
    await seed(store, "done");

    await expect(orchestrator.assignTask("p1", "t1")).rejects.toBeInstanceOf(TaskAlreadyAssignedError);
    expect(provider.starts).toBe(0);
    expect(await busyCount(store)).toBe(0);
    expect((await store.listRuns(DEFAULT_WORKSPACE)).length).toBe(0);
  });
});
