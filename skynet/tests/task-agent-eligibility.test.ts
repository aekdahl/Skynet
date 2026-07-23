// Agent eligibility: a task's `assignment` decides WHICH fleet agents may take it.
//  • agents  — acquisition is restricted to the pinned pool; if none of them are
//              idle the assign fails (no queue), even when other agents are free.
//  • unassigned — a human explicitly assigning means "any", which is persisted so
//              the task carries a real set once it leaves backlog.
import { describe, it, expect, beforeEach } from "vitest";
import type { ProviderId, Agent, Project, Task, ServerEvent } from "@skynet/shared";
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

// Never completes, so acquired agents stay busy while we inspect the outcome.
class RunningProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  async start(spec: StartSpec, _events: RunnerEvents): Promise<RunnerHandle> {
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

const project: Project = {
  id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "Proj", goal: "", runIds: [], status: "active",
};
const mkTask = (id: string, assignment: Task["assignment"]): Task => ({
  id, workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: `task ${id}`, state: "backlog",
  runId: null, autoPick: false, assessment: null, reviewFlaggedReason: null, assignment,
});
const mkAgent = (id: string): Agent => ({
  id, workspaceId: DEFAULT_WORKSPACE, name: id, provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0,
});

describe("task agent eligibility", () => {
  let store: MemoryStore;
  let orchestrator: Orchestrator;

  beforeEach(async () => {
    store = new MemoryStore({ seed: false });
    orchestrator = new Orchestrator(store, new Hub(store, new NullBus()), new RunningProvider());
    await store.putProject(project);
  });

  it("pins a task to its assigned agent even when another agent is idle first", async () => {
    await store.putAgent(mkAgent("r1")); // listed first — the historical pick
    await store.putAgent(mkAgent("r2"));
    await store.putTask(mkTask("t1", { mode: "agents", agentIds: ["r2"] }));

    const run = await orchestrator.assignTask("p1", "t1");

    expect(run.agentId).toBe("r2");
    expect((await store.getAgent("r1"))?.status).toBe("idle"); // untouched
    expect((await store.getAgent("r2"))?.status).toBe("busy");
  });

  it("does not run — nor provision — when every pinned agent is busy, though another is idle", async () => {
    await store.putAgent(mkAgent("r1"));
    await store.putAgent(mkAgent("r2"));
    // Occupy r1 via a task pinned to it, then a second task also pinned to r1.
    await store.putTask(mkTask("t1", { mode: "agents", agentIds: ["r1"] }));
    await store.putTask(mkTask("t2", { mode: "agents", agentIds: ["r1"] }));

    await orchestrator.assignTask("p1", "t1"); // r1 now busy
    await expect(orchestrator.assignTask("p1", "t2")).rejects.toBeInstanceOf(NoCapacityError);

    // r2 stayed idle — eligibility was honored rather than falling back to it.
    expect((await store.getAgent("r2"))?.status).toBe("idle");
    const agents = await store.listAgents(DEFAULT_WORKSPACE);
    expect(agents).toHaveLength(2); // no auto-provisioned third agent
  });

  it("a human assigning an unassigned task means 'any' — persisted on the task", async () => {
    await store.putAgent(mkAgent("r1"));
    await store.putTask(mkTask("t1", { mode: "unassigned", agentIds: [] }));

    const run = await orchestrator.assignTask("p1", "t1");

    expect(run.agentId).toBe("r1");
    expect((await store.getTask("t1"))?.assignment).toEqual({ mode: "any", agentIds: [] });
  });
});
