// Regression guards for DEF-003 / DEF-005 (assign idempotency) and DEF-002
// (honest chat reply).
//
// DEF-003: re-assigning a task that already owns a live agent double-spawned a
//   second agent on a second runner, orphaning the first. Re-assign must be
//   idempotent — same agent back, no second runner marked busy.
// DEF-005: assigning a task already in state "done" must be refused, not spawn
//   an agent on finished work.
// DEF-002: chatting a running/waiting agent returned the same canned "finished"
//   string as a done agent. The reply must reflect the agent's actual status.
import { describe, it, expect, beforeEach } from "vitest";
import type { ProviderId, Agent, Project, Task, ServerEvent } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator, TaskAlreadyAssignedError } from "../apps/server/src/orchestrator.js";
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

// A quiet runner that just stays "running" — no plan, no HITL, no completion.
// Lets us exercise assign/chat against a live-but-idle agent deterministically.
// It has no `consult` method, so chat with no live session falls to the canned
// path — exactly the DEF-002 surface.
class QuietProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  started = 0;
  async start(spec: StartSpec, _events: RunnerEvents): Promise<RunnerHandle> {
    this.started++;
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

// Same shape as QuietProvider, but its stateless consult() always throws the
// exact raw shape a model-alias resolution failure produces — exercises the
// friendlyConsultError translation end-to-end through chat()'s stateless path.
class ThrowingConsultProvider extends QuietProvider {
  async consult(): Promise<string> {
    throw new Error(
      'HTTP 404: {"type":"error","error":{"type":"not_found_error","message":"model: claude-sonnet"},"request_id":"req_1"}',
    );
  }
}

const mkFixtures = async (store: MemoryStore) => {
  const project: Project = {
    id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "Proj", goal: "", runIds: [], status: "active",
  };
  const r1: Agent = {
    id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1",
    provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0,
  };
  const r2: Agent = {
    id: "r2", workspaceId: DEFAULT_WORKSPACE, name: "r2",
    provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0,
  };
  const task: Task = {
    id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "do the thing", state: "backlog", runId: null,
  };
  await store.putProject(project);
  await store.putAgent(r1);
  await store.putAgent(r2);
  await store.putTask(task);
};

describe("DEF-003/005: assign is idempotent and refuses done tasks", () => {
  let store: MemoryStore;
  let bus: NullBus;
  let hub: Hub;
  let provider: QuietProvider;
  let orchestrator: Orchestrator;

  beforeEach(async () => {
    store = new MemoryStore();
    bus = new NullBus();
    hub = new Hub(store, bus);
    provider = new QuietProvider();
    orchestrator = new Orchestrator(store, hub, provider);
    await mkFixtures(store);
  });

  it("re-assigning an already-assigned task returns the SAME agent, spawns no second one", async () => {
    const first = await orchestrator.assignTask("p1", "t1");
    const second = await orchestrator.assignTask("p1", "t1");

    // Same agent back — no duplicate spawned.
    expect(second.id).toBe(first.id);
    expect(provider.started).toBe(1);

    // The task still points at the original run, still ongoing.
    const task = await store.getTask("t1");
    expect(task?.runId).toBe(first.id);
    expect(task?.state).toBe("ongoing");

    // Only one runner was ever marked busy; the second stayed idle.
    expect((await store.getAgent("r1"))?.status).toBe("busy");
    expect((await store.getAgent("r2"))?.status).toBe("idle");

    // The project didn't accumulate a second, orphaned agent id.
    const project = await store.getProject("p1");
    expect(project?.runIds).toEqual([first.id]);

    // The original agent is not orphaned — still the live/attached one.
    const agent = await store.getRun(first.id);
    expect(agent?.status).not.toBe("done");

    // Exactly one run exists workspace-wide (no untracked orphan run).
    expect((await store.listRuns(DEFAULT_WORKSPACE)).length).toBe(1);
  });

  it("assigning a done task is refused (TaskAlreadyAssignedError), no runner acquired", async () => {
    const done: Task = {
      id: "t-done", workspaceId: DEFAULT_WORKSPACE, projectId: "p1",
      text: "already finished", state: "done", runId: null,
    };
    await store.putTask(done);

    await expect(orchestrator.assignTask("p1", "t-done")).rejects.toBeInstanceOf(TaskAlreadyAssignedError);

    // Nothing was spawned and no runner was taken.
    expect(provider.started).toBe(0);
    expect((await store.getAgent("r1"))?.status).toBe("idle");
    expect((await store.getAgent("r2"))?.status).toBe("idle");
    expect((await store.listRuns(DEFAULT_WORKSPACE)).length).toBe(0);
  });

  it("a task whose agent is done CAN be re-assigned (frees a fresh spawn)", async () => {
    const first = await orchestrator.assignTask("p1", "t1");
    // Mark the agent done (task still 'assigned', pointing at it).
    const agent = await store.getRun(first.id);
    await store.putRun({ ...agent!, status: "done" });

    const second = await orchestrator.assignTask("p1", "t1");
    expect(second.id).not.toBe(first.id);
    expect(provider.started).toBe(2);
  });
});

describe("DEF-002: chat reply reflects the agent's actual status", () => {
  let store: MemoryStore;
  let hub: Hub;
  let orchestrator: Orchestrator;

  beforeEach(async () => {
    store = new MemoryStore();
    hub = new Hub(store, new NullBus());
    orchestrator = new Orchestrator(store, hub, new QuietProvider());
    await mkFixtures(store);
  });

  const CANNED_FINISHED = "This agent has finished; follow-up chat isn't supported for its runner.";

  it("a done agent (no live session, no consult) gets the 'finished' reply", async () => {
    const agent = await orchestrator.assignTask("p1", "t1");
    const stored = await store.getRun(agent.id);
    await store.putRun({ ...stored!, status: "done" });
    // Drop the live session so chat takes the stateless (consultFinished) path.
    await orchestrator.stopAgent(agent.id);

    const reply = await orchestrator.chat(agent.id, "hi");
    expect(reply).toBe(CANNED_FINISHED);
  });

  it("a running agent does NOT get the constant 'finished' reply", async () => {
    const agent = await orchestrator.assignTask("p1", "t1");
    const stored = await store.getRun(agent.id);
    expect(stored?.status).toBe("running");
    // Force the stateless path for a still-running agent (server-restart shape).
    await orchestrator.stopAgent(agent.id);

    const reply = await orchestrator.chat(agent.id, "hi");
    expect(reply).not.toBe(CANNED_FINISHED);
    expect(reply.toLowerCase()).not.toContain("finished");
    expect(reply.toLowerCase()).toContain("running");
  });

  it("a stateless consult failing on a model-resolution 404 gets a plain, actionable reply — not the raw JSON blob", async () => {
    const throwingOrchestrator = new Orchestrator(store, hub, new ThrowingConsultProvider());
    const agent = await throwingOrchestrator.assignTask("p1", "t1");
    await throwingOrchestrator.stopAgent(agent.id); // force the stateless (consultFinished) path

    const reply = await throwingOrchestrator.chat(agent.id, "hi");
    expect(reply).toContain('the model "claude-sonnet" isn\'t recognized');
    expect(reply).not.toContain("request_id");
    expect(reply).not.toContain("not_found_error");
  });
});
