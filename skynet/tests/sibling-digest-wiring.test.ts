// S3 wiring: does buildSiblingDigest's output actually reach the StartSpec.task
// a runner receives, at the genuine "an agent is starting FRESH" moments
// (assign, fork, reassign/escalation-relaunch) — not just prove the pure
// function itself (see sibling-digest.test.ts). Uses the lightweight
// MemoryStore+Hub+Orchestrator+RecordingProvider pattern (same as
// tests/agent-lifecycle.test.ts / tests/project-instructions.test.ts) since
// none of this needs a real git worktree — the digest is pure store data.
import { describe, it, expect } from "vitest";
import type { Agent, Project, ProviderId, ServerEvent, Task, TaskRun } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

class NullBus implements Bus {
  publish(_ws: string, _e: ServerEvent): void {}
  subscribe(): () => void { return () => {}; }
}

class RecordingProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  specs: StartSpec[] = [];
  async start(spec: StartSpec, _events: RunnerEvents): Promise<RunnerHandle> {
    this.specs.push(spec);
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

function setup() {
  const store = new MemoryStore();
  const hub = new Hub(store, new NullBus());
  const provider = new RecordingProvider();
  const orchestrator = new Orchestrator(store, hub, provider);
  return { store, orchestrator, provider };
}

const project: Project = {
  id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "Acme", goal: "", runIds: [], status: "active",
};
const runner: Agent = {
  id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0,
};

describe("sibling digest wiring — assign", () => {
  it("a busy sibling shows up in === IN FLIGHT === at assign time", async () => {
    const { store, orchestrator, provider } = setup();
    await store.putProject(project);
    await store.putAgent(runner);
    const busy: Task = {
      id: "t-busy", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "Add rate limiting to the API",
      state: "ongoing", runId: null, assignment: { mode: "unassigned", agentIds: [] },
    } as Task;
    const fresh: Task = {
      id: "t-fresh", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "Fix the settings page layout",
      state: "todo", runId: null, assignment: { mode: "unassigned", agentIds: [] },
    } as Task;
    await store.putTask(busy);
    await store.putTask(fresh);

    await orchestrator.assignTask("p1", "t-fresh");

    expect(provider.specs).toHaveLength(1);
    const { task } = provider.specs[0]!;
    expect(task).toContain("=== IN FLIGHT ===");
    expect(task).toContain("Add rate limiting to the API");
    expect(task).toContain("(ongoing)");
    expect(task).toContain("prefer building on it over duplicating it");
    // The task being assigned right now is never listed as its own sibling.
    expect(task.indexOf("=== IN FLIGHT ===")).toBeLessThan(task.indexOf("=== TASK ==="));
  });

  it("no === IN FLIGHT === section when the project has no other siblings", async () => {
    const { store, orchestrator, provider } = setup();
    await store.putProject(project);
    await store.putAgent(runner);
    const solo: Task = {
      id: "t-solo", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "The only task in this project",
      state: "todo", runId: null, assignment: { mode: "unassigned", agentIds: [] },
    } as Task;
    await store.putTask(solo);

    await orchestrator.assignTask("p1", "t-solo");

    const { task } = provider.specs[0]!;
    expect(task).not.toContain("=== IN FLIGHT ===");
  });
});

describe("sibling digest wiring — fork", () => {
  it("a busy sibling shows up in the forked run's brief too", async () => {
    const { store, orchestrator, provider } = setup();
    await store.putProject(project);
    await store.putAgent(runner);
    await store.putAgent({ ...runner, id: "r2" }); // fork() provisions/acquires a runner
    const busy: Task = {
      id: "t-busy", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "Refactor the auth module",
      state: "review", runId: null, assignment: { mode: "unassigned", agentIds: [] },
    } as Task;
    await store.putTask(busy);
    const parentTask: Task = {
      id: "t-parent", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "Build the checkout flow",
      state: "ongoing", runId: "parent-run", assignment: { mode: "unassigned", agentIds: [] },
    } as Task;
    await store.putTask(parentTask);
    const parentRun: TaskRun = {
      id: "parent-run", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", name: "Build the checkout flow",
      status: "waiting", agentId: "r1", provider: "claude", model: "opus-4.8", branch: "agent/parent-run",
      modules: [], progress: 0.5, plan: [], usage: null, modifiedFiles: [], log: [], startedAt: 0,
      lastHeartbeatAt: 0, visual: false, previewUrl: null, dependsOn: [], parentId: null,
      branchFromStep: null, archived: false, pr: null, mergedAt: null,
    } as TaskRun;
    await store.putRun(parentRun);

    await orchestrator.fork("parent-run");

    expect(provider.specs).toHaveLength(1);
    const { task } = provider.specs[0]!;
    expect(task).toContain("=== IN FLIGHT ===");
    expect(task).toContain("Refactor the auth module");
    // The fork's OWN parent task is never listed as if it were a sibling of itself.
    expect(task).not.toContain('"Build the checkout flow" (ongoing)');
  });
});
