// Agent failure must NOT look like success. A runner that can't execute (binary
// missing, auth failure, crash) calls onFailed — the orchestrator surfaces it and
// frees the runner, but never marks the agent done or completes its task. This is
// the regression guard for the "silent mock/fallback" class of bugs.
import { describe, it, expect } from "vitest";
import type { ProviderId, Agent, Project, Task, ServerEvent } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

class NullBus implements Bus {
  events: ServerEvent[] = [];
  publish(_ws: string, event: ServerEvent): void {
    this.events.push(event);
  }
  subscribe(): () => void {
    return () => {};
  }
}

// A runner that can't run: like a missing CLI binary, it reports onFailed (next
// tick, after start() returns — matching real runners) and never onCompleted.
class FailingProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    setTimeout(() => events.onFailed(spec.runId, "binary not found (simulated)"), 0);
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

const tick = () => new Promise((r) => setTimeout(r, 20));

describe("runner failure is loud, not a fake completion", () => {
  it("a failed runner → agent needs-attention, runner freed, task NOT done", async () => {
    const store = new MemoryStore();
    const bus = new NullBus();
    const hub = new Hub(store, bus);
    const orchestrator = new Orchestrator(store, hub, new FailingProvider());

    const runner: Agent = {
      id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1",
      provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0,
    };
    const project: Project = {
      id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "Proj", goal: "", runIds: [], status: "active",
    };
    const task: Task = {
      id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "do the thing", state: "backlog", runId: null,
    };
    await store.putAgent(runner);
    await store.putProject(project);
    await store.putTask(task);

    const agent = await orchestrator.assignTask("p1", "t1");
    await tick(); // let the (async) failure propagate

    const after = await store.getRun(agent.id);
    expect(after?.status).toBe("review"); // surfaced, NOT "done"
    expect(after?.status).not.toBe("done");

    // The runner was returned to the idle pool (not leaked as busy).
    expect((await store.getAgent("r1"))?.status).toBe("idle");

    // The task was NOT marked done by a fake completion.
    expect((await store.getTask("t1"))?.state).not.toBe("done");

    // No "completed" event was ever published for this agent.
    expect(bus.events.some((e) => e.type === "run.completed")).toBe(false);
  });

  it("errors loudly for an unresolvable provider (no silent mock fallback)", async () => {
    // The backend is chosen per fleet runner (config.runner is only a global
    // override). A runner whose provider doesn't resolve to a real backend must
    // reject loudly — never quietly fall back to the mock and look like a real run.
    const store = new MemoryStore();
    const hub = new Hub(store, new NullBus());
    const orchestrator = new Orchestrator(store, hub); // no providerOverride; RUNNER unset

    const project: Project = { id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [], status: "active" };
    const runner: Agent = {
      id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1",
      provider: "bogus" as ProviderId, model: "x", status: "idle", idleSince: 0,
    };
    const task: Task = { id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "x", state: "backlog", runId: null };
    await store.putProject(project);
    await store.putAgent(runner);
    await store.putTask(task);

    await expect(orchestrator.assignTask("p1", "t1")).rejects.toThrow(/unknown runner provider/i);
  });
});
