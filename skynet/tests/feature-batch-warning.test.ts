// Earlier warning for the feature-batch size guardrail (see
// orchestrator.ts's checkFeatureBatchSize, applied later at PR-open time):
// operations.ts's updateTask fires an assistive, non-blocking note the moment
// a task joins a feature and the resulting batch crosses
// SKYNET_FEATURE_BATCH_MAX_TASKS — so an operator can split the feature
// before its batch completes, not just find out once it's already one
// mega-PR. Never blocks linking more tasks in; fires once (Feature.sizeWarning
// stays set, never re-triggered on every further add).
import { describe, it, expect } from "vitest";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { Operations } from "../apps/server/src/operations.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";

class NullBus implements Bus {
  publish(): void {}
  subscribe(): () => void {
    return () => {};
  }
}

function setup() {
  const store = new MemoryStore({ seed: false });
  const hub = new Hub(store, new NullBus());
  const orchestrator = new Orchestrator(store, hub);
  const ops = new Operations({ store, hub, orchestrator });
  return { store, ops };
}

/** SKYNET_FEATURE_BATCH_MAX_TASKS defaults to 12 (config.ts) — link this many
 *  tasks (the default's own count) to stay under threshold without needing to
 *  override the env var per test. */
const UNDER = 5;
const OVER = 14; // > 12

async function linkNTasksToOneFeature(n: number) {
  const { store, ops } = setup();
  const project = await ops.createProject(DEFAULT_WORKSPACE, { name: "Proj", goal: "ship it", repo: undefined });
  const feature = await ops.createFeature(DEFAULT_WORKSPACE, project.id, { name: "Big Feature" });
  const tasks = [];
  for (let i = 0; i < n; i++) {
    const t = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: `task ${i}` });
    tasks.push(await ops.updateTask(DEFAULT_WORKSPACE, t.id, { featureId: feature.id }));
  }
  return { store, ops, project, feature, tasks };
}

describe("feature-batch size guardrail — earlier warning at task-link time", () => {
  it("under the task-count threshold: no warning set on the feature", async () => {
    const { store, feature } = await linkNTasksToOneFeature(UNDER);
    const stored = await store.getFeature(feature.id);
    expect(stored?.sizeWarning).toBeNull();
  });

  it("crossing the threshold sets an assistive note on the feature (never blocks the link)", async () => {
    const { store, feature, tasks } = await linkNTasksToOneFeature(OVER);
    // The link itself was never blocked — every task actually got featureId set,
    // including the ones added after the guardrail had already tripped.
    expect(tasks.every((t) => t.featureId === feature.id)).toBe(true);
    const stored = await store.getFeature(feature.id);
    expect(stored?.sizeWarning).not.toBeNull();
    // Fires at the FIRST crossing (the 13th task, threshold 12) — a snapshot of
    // the count at that moment, not the final count once all OVER tasks landed.
    expect(stored?.sizeWarning?.taskCount).toBe(13);
    expect(stored?.sizeWarning?.threshold).toBe(12);
    expect(stored?.sizeWarning?.note).toMatch(/Big Feature/);
    expect(stored?.sizeWarning?.note).toMatch(/13 tasks/);
    expect(stored?.sizeWarning?.note).toMatch(/split/i);
  });

  it("fires ONCE — the note doesn't change (or re-fire) as more tasks are added past the threshold", async () => {
    const { store, ops, project, feature } = await linkNTasksToOneFeature(OVER);
    const firstWarning = (await store.getFeature(feature.id))?.sizeWarning;
    expect(firstWarning).not.toBeNull();

    // Add several more tasks past the threshold — the warning must stay
    // exactly as it was first set (same taskCount snapshot), not creep upward.
    for (let i = 0; i < 3; i++) {
      const t = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: `extra ${i}` });
      await ops.updateTask(DEFAULT_WORKSPACE, t.id, { featureId: feature.id });
    }
    const finalWarning = (await store.getFeature(feature.id))?.sizeWarning;
    expect(finalWarning).toEqual(firstWarning);
  });

  it("unlinking and relinking a task never re-fires once already warned", async () => {
    const { store, ops, feature, tasks } = await linkNTasksToOneFeature(OVER);
    const before = (await store.getFeature(feature.id))?.sizeWarning;
    await ops.updateTask(DEFAULT_WORKSPACE, tasks[0]!.id, { featureId: null });
    await ops.updateTask(DEFAULT_WORKSPACE, tasks[0]!.id, { featureId: feature.id });
    const after = (await store.getFeature(feature.id))?.sizeWarning;
    expect(after).toEqual(before);
  });

  it("archived siblings don't count toward the threshold", async () => {
    const { store, ops } = setup();
    const project = await ops.createProject(DEFAULT_WORKSPACE, { name: "Proj2", goal: "ship it", repo: undefined });
    const feature = await ops.createFeature(DEFAULT_WORKSPACE, project.id, { name: "Feature" });
    // 20 tasks total, but 15 are archived — only 5 "real" siblings.
    for (let i = 0; i < 20; i++) {
      const t = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: `t${i}` });
      const linked = await ops.updateTask(DEFAULT_WORKSPACE, t.id, { featureId: feature.id });
      if (i < 15) await store.putTask({ ...linked, archived: true });
    }
    const stored = await store.getFeature(feature.id);
    expect(stored?.sizeWarning).toBeNull();
  });
});
