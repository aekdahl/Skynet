// Features + milestones: task-grouping and roadmap CRUD. Exercises the full
// Operations path (validation, workspace-scoped existence checks, cascade
// clears on delete) against a real MemoryStore + Hub. No fleet, no HTTP —
// just the domain layer.
import { describe, it, expect } from "vitest";
import type { ProviderId, ServerEvent } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { NotFoundError, Operations } from "../apps/server/src/operations.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

class RecordingBus implements Bus {
  events: { ws: string; event: ServerEvent }[] = [];
  publish(ws: string, event: ServerEvent): void { this.events.push({ ws, event }); }
  subscribe(): () => void { return () => {}; }
}

class NoopProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  async start(spec: StartSpec, _e: RunnerEvents): Promise<RunnerHandle> {
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

const setup = () => {
  const store = new MemoryStore();
  const bus = new RecordingBus();
  const hub = new Hub(store, bus);
  const orchestrator = new Orchestrator(store, hub, new NoopProvider());
  const ops = new Operations({ store, hub, orchestrator });
  return { store, hub, bus, ops };
};

const mkProject = async (ops: Operations) =>
  ops.createProject(DEFAULT_WORKSPACE, { name: "P", goal: "ship" });

describe("Features + roadmap", () => {
  it("creates a feature under a project, publishes feature.upserted, and lists it", async () => {
    const { ops, bus } = setup();
    const project = await mkProject(ops);
    const feature = await ops.createFeature(DEFAULT_WORKSPACE, project.id, {
      name: "Onboarding",
      description: "first-run flow",
    });
    expect(feature.projectId).toBe(project.id);
    expect(feature.name).toBe("Onboarding");
    expect(feature.status).toBe("active");
    expect(feature.archived).toBe(false);
    expect(feature.milestoneId).toBeNull();
    // The bus saw a feature.upserted with the same feature.
    const upserts = bus.events.filter((e) => e.event.type === "feature.upserted");
    expect(upserts.length).toBe(1);
    expect((upserts[0]!.event as { type: "feature.upserted"; feature: { id: string } }).feature.id).toBe(feature.id);
    // listFeatures returns it.
    expect(await ops.listFeatures(DEFAULT_WORKSPACE)).toHaveLength(1);
  });

  it("assigns a task to a feature (and clears it) via updateTask", async () => {
    const { ops } = setup();
    const project = await mkProject(ops);
    const task = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "do X" });
    const feature = await ops.createFeature(DEFAULT_WORKSPACE, project.id, { name: "Onboarding" });
    expect(task.featureId).toBeNull();

    const linked = await ops.updateTask(DEFAULT_WORKSPACE, task.id, { featureId: feature.id });
    expect(linked.featureId).toBe(feature.id);

    // Explicit null clears the linkage.
    const cleared = await ops.updateTask(DEFAULT_WORKSPACE, task.id, { featureId: null });
    expect(cleared.featureId).toBeNull();
  });

  it("rejects cross-project feature linkage on updateTask", async () => {
    const { ops } = setup();
    const p1 = await mkProject(ops);
    const p2 = await ops.createProject(DEFAULT_WORKSPACE, { name: "Other", goal: "" });
    const task = await ops.createTask(DEFAULT_WORKSPACE, p1.id, { text: "in p1" });
    const wrong = await ops.createFeature(DEFAULT_WORKSPACE, p2.id, { name: "In p2" });
    await expect(ops.updateTask(DEFAULT_WORKSPACE, task.id, { featureId: wrong.id }))
      .rejects.toThrow(NotFoundError);
  });

  it("deleting a feature clears featureId on its tasks (no phantom pointers)", async () => {
    const { ops, store } = setup();
    const project = await mkProject(ops);
    const feature = await ops.createFeature(DEFAULT_WORKSPACE, project.id, { name: "Doomed" });
    const t1 = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "a" });
    const t2 = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "b" });
    await ops.updateTask(DEFAULT_WORKSPACE, t1.id, { featureId: feature.id });
    await ops.updateTask(DEFAULT_WORKSPACE, t2.id, { featureId: feature.id });

    await ops.deleteFeature(DEFAULT_WORKSPACE, feature.id);
    expect(await store.getFeature(feature.id)).toBeUndefined();
    expect((await store.getTask(t1.id))?.featureId).toBeNull();
    expect((await store.getTask(t2.id))?.featureId).toBeNull();
  });

  it("creates a milestone with a target date and status", async () => {
    const { ops, bus } = setup();
    const project = await mkProject(ops);
    const targetAt = Date.UTC(2026, 5, 1); // June 1, 2026 — deterministic epoch.
    const milestone = await ops.createMilestone(DEFAULT_WORKSPACE, project.id, {
      name: "v1.0",
      description: "public launch",
      targetAt,
    });
    expect(milestone.projectId).toBe(project.id);
    expect(milestone.name).toBe("v1.0");
    expect(milestone.targetAt).toBe(targetAt);
    expect(milestone.status).toBe("planned");
    // Bus event.
    const upserts = bus.events.filter((e) => e.event.type === "milestone.upserted");
    expect(upserts.length).toBe(1);
  });

  it("assigns a feature to a milestone (and clears it)", async () => {
    const { ops } = setup();
    const project = await mkProject(ops);
    const feature = await ops.createFeature(DEFAULT_WORKSPACE, project.id, { name: "F" });
    const m = await ops.createMilestone(DEFAULT_WORKSPACE, project.id, { name: "v1.0" });
    const linked = await ops.updateFeature(DEFAULT_WORKSPACE, feature.id, { milestoneId: m.id });
    expect(linked.milestoneId).toBe(m.id);
    const cleared = await ops.updateFeature(DEFAULT_WORKSPACE, feature.id, { milestoneId: null });
    expect(cleared.milestoneId).toBeNull();
  });

  it("deleting a milestone clears the ref on features AND tasks", async () => {
    const { ops, store } = setup();
    const project = await mkProject(ops);
    const m = await ops.createMilestone(DEFAULT_WORKSPACE, project.id, { name: "v1.0" });
    // Feature under the milestone.
    const feature = await ops.createFeature(DEFAULT_WORKSPACE, project.id, { name: "F", milestoneId: m.id });
    // Orphan task directly on the milestone (no feature).
    const task = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "orphan" });
    await ops.updateTask(DEFAULT_WORKSPACE, task.id, { milestoneId: m.id });

    await ops.deleteMilestone(DEFAULT_WORKSPACE, m.id);
    expect(await store.getMilestone(m.id)).toBeUndefined();
    expect((await store.getFeature(feature.id))?.milestoneId).toBeNull();
    expect((await store.getTask(task.id))?.milestoneId).toBeNull();
  });

  it("rejects milestone linkage across projects on createFeature", async () => {
    const { ops } = setup();
    const p1 = await mkProject(ops);
    const p2 = await ops.createProject(DEFAULT_WORKSPACE, { name: "P2", goal: "" });
    const m = await ops.createMilestone(DEFAULT_WORKSPACE, p2.id, { name: "v1" });
    await expect(ops.createFeature(DEFAULT_WORKSPACE, p1.id, { name: "F", milestoneId: m.id }))
      .rejects.toThrow(NotFoundError);
  });

  it("scopes reads to the caller's workspace (other-workspace features stay hidden)", async () => {
    const { ops, store } = setup();
    const project = await mkProject(ops);
    await ops.createFeature(DEFAULT_WORKSPACE, project.id, { name: "Mine" });
    // Seed a foreign feature by writing directly (skips ops validation).
    await store.putFeature({
      id: "f-foreign",
      workspaceId: "other",
      projectId: "elsewhere",
      name: "Other's",
      description: null,
      status: "active",
      milestoneId: null,
      archived: false,
      createdAt: 0,
    });
    const listed = await ops.listFeatures(DEFAULT_WORKSPACE);
    expect(listed.map((f) => f.workspaceId)).toEqual([DEFAULT_WORKSPACE]);
  });

  it("Snapshot carries features + milestones through the store", async () => {
    const { ops } = setup();
    const project = await mkProject(ops);
    await ops.createFeature(DEFAULT_WORKSPACE, project.id, { name: "F1" });
    await ops.createMilestone(DEFAULT_WORKSPACE, project.id, { name: "v1" });
    const snap = await ops.snapshot(DEFAULT_WORKSPACE);
    expect(snap.features.length).toBe(1);
    expect(snap.milestones.length).toBe(1);
    expect(snap.features[0]!.name).toBe("F1");
    expect(snap.milestones[0]!.name).toBe("v1");
  });
});
