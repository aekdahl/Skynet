// Regression guard for the runner double-booking TOCTOU. acquireRunner does
// listRunners() → find(idle) → upsertRunner(busy) with an `await` between the
// find and the write. Two concurrent acquisitions could both observe the SAME
// idle runner and hand it to two agents (observed live: two running agents
// sharing one runnerId). Acquisition is now serialized so find→mark-busy is
// atomic: a busy-marked runner is persisted before the next acquire's find().
import { describe, it, expect, beforeEach } from "vitest";
import type { ProviderId, Runner, Project, Task, ServerEvent } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { NoCapacityError, Orchestrator } from "../apps/server/src/orchestrator.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

class NullBus implements Bus {
  publish(_ws: string, _event: ServerEvent): void {}
  subscribe(): () => void {
    return () => {};
  }
}

// Stays running — never completes/fails — so acquired runners stay busy while we
// inspect the outcome of a concurrent acquisition race.
class RunningProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  async start(spec: StartSpec, _events: RunnerEvents): Promise<RunnerHandle> {
    return { agentId: spec.agentId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

const project: Project = {
  id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "Proj", goal: "", agentIds: [], status: "active",
};
const mkTask = (id: string): Task => ({
  id, workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: `task ${id}`, state: "backlog", agentId: null,
});
const mkRunner = (id: string): Runner => ({
  id, workspaceId: DEFAULT_WORKSPACE, name: id, provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0,
});

describe("runner acquisition is serialized (no double-booking)", () => {
  let store: MemoryStore;
  let hub: Hub;
  let orchestrator: Orchestrator;

  beforeEach(async () => {
    store = new MemoryStore({ seed: false });
    hub = new Hub(store, new NullBus());
    orchestrator = new Orchestrator(store, hub, new RunningProvider());
    await store.putProject(project);
  });

  it("with ONE idle runner, two concurrent assigns → one agent, the other 409s; no shared runner", async () => {
    await store.putRunner(mkRunner("r1"));
    await store.putTask(mkTask("t1"));
    await store.putTask(mkTask("t2"));

    const results = await Promise.allSettled([
      orchestrator.assignTask("p1", "t1"),
      orchestrator.assignTask("p1", "t2"),
    ]);

    const created = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<Orchestrator["assignTask"]>>>[];
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];

    // Exactly one agent got the single runner; the other was refused for capacity.
    expect(created).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(NoCapacityError);

    // The one created agent holds r1, and no second agent shares it.
    expect(created[0].value.runnerId).toBe("r1");
    const agents = await store.listAgents(DEFAULT_WORKSPACE);
    expect(agents).toHaveLength(1);
    // The runner is bound to exactly one live agent.
    expect(orchestrator.isBusy("r1")).toBe(true);
  });

  it("with TWO idle runners, two concurrent assigns → two DISTINCT runners, never the same twice", async () => {
    await store.putRunner(mkRunner("r1"));
    await store.putRunner(mkRunner("r2"));
    await store.putTask(mkTask("t1"));
    await store.putTask(mkTask("t2"));

    const agents = await Promise.all([
      orchestrator.assignTask("p1", "t1"),
      orchestrator.assignTask("p1", "t2"),
    ]);

    const runnerIds = agents.map((a) => a.runnerId);
    // Two agents, two different runners — no runner handed out twice.
    expect(new Set(runnerIds).size).toBe(2);
    expect(runnerIds).toEqual(expect.arrayContaining(["r1", "r2"]));
    // Both runners are now busy and each held by a distinct live agent.
    expect((await store.getRunner("r1"))?.status).toBe("busy");
    expect((await store.getRunner("r2"))?.status).toBe("busy");
  });
});
