// Regression guards for the agent lifecycle controls (detail view): pause,
// resume, and stop/remove.
//   pause  — running/waiting agent → status "paused"; the live runner is paused.
//   resume — paused agent → back to "running"; the live runner is resumed.
//   stop   — halts execution, frees the runner back to idle, marks agent "done".
import { describe, it, expect, beforeEach } from "vitest";
import type { ProviderId, Agent, Project, Task, ServerEvent } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

class NullBus implements Bus {
  publish(_ws: string, _event: ServerEvent): void {}
  subscribe(): () => void {
    return () => {};
  }
}

// Records which handle controls the orchestrator invokes.
class RecordingProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  calls = { pause: 0, resume: 0, stop: 0 };
  async start(spec: StartSpec, _events: RunnerEvents): Promise<RunnerHandle> {
    const calls = this.calls;
    return {
      runId: spec.runId,
      provider: this.id,
      async pause() { calls.pause++; },
      async resume() { calls.resume++; },
      async message() {},
      async stop() { calls.stop++; },
    };
  }
}

const mkFixtures = async (store: MemoryStore) => {
  const project: Project = {
    id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "Proj", goal: "", runIds: [], status: "active",
  };
  const runner: Agent = {
    id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1",
    provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0,
  };
  const task: Task = {
    id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "do the thing", state: "backlog", runId: null,
  };
  await store.putProject(project);
  await store.putAgent(runner);
  await store.putTask(task);
};

describe("agent lifecycle controls: pause / resume / stop", () => {
  let store: MemoryStore;
  let hub: Hub;
  let provider: RecordingProvider;
  let orchestrator: Orchestrator;

  beforeEach(async () => {
    store = new MemoryStore();
    hub = new Hub(store, new NullBus());
    provider = new RecordingProvider();
    orchestrator = new Orchestrator(store, hub, provider);
    await mkFixtures(store);
  });

  it("pause moves a live agent to 'paused' and pauses its runner", async () => {
    const agent = await orchestrator.assignTask("p1", "t1");
    expect(agent.status).not.toBe("paused");

    const paused = await orchestrator.pauseAgent(agent.id);
    expect(paused?.status).toBe("paused");
    expect(provider.calls.pause).toBe(1);
    expect((await store.getRun(agent.id))?.status).toBe("paused");
  });

  it("resume returns a paused agent to 'running' and resumes its runner", async () => {
    const agent = await orchestrator.assignTask("p1", "t1");
    await orchestrator.pauseAgent(agent.id);

    const resumed = await orchestrator.resumeAgent(agent.id);
    expect(resumed?.status).toBe("running");
    expect(provider.calls.resume).toBe(1);
  });

  it("stop halts the agent, frees its runner to idle, and marks it done", async () => {
    const agent = await orchestrator.assignTask("p1", "t1");
    expect((await store.getAgent("r1"))?.status).toBe("busy");

    const stopped = await orchestrator.haltAgent(agent.id);
    expect(stopped?.status).toBe("done");
    expect(provider.calls.stop).toBe(1);
    expect((await store.getAgent("r1"))?.status).toBe("idle");
    // The live session is gone — pausing a stopped agent is a no-op.
    expect(orchestrator.isBusy("r1")).toBe(false);
  });

  it("pause is a no-op on a finished agent", async () => {
    const agent = await orchestrator.assignTask("p1", "t1");
    await orchestrator.haltAgent(agent.id); // → done
    const res = await orchestrator.pauseAgent(agent.id);
    expect(res?.status).toBe("done");
    expect(provider.calls.pause).toBe(0);
  });
});
