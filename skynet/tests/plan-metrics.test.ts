// Product Steward Phase 1 — the project-view Plan panel's pure rollup logic.
import { describe, it, expect } from "vitest";
import type { Feature, Milestone, Task } from "@skynet/shared";
import { rollupMilestones } from "../apps/web/src/kanban/plan-metrics.js";

const milestone = (id: string, over: Partial<Milestone> = {}): Milestone => ({
  id, workspaceId: "w", projectId: "p1", name: `Milestone ${id}`, description: null,
  targetAt: null, status: "planned", order: 0, archived: false, createdAt: 0,
  ...over,
});

const task = (id: string, over: Partial<Task> = {}): Task =>
  ({
    id, workspaceId: "w", projectId: "p1", text: `Task ${id}`, state: "todo",
    featureId: null, milestoneId: null,
    ...over,
  }) as Task;

const feature = (id: string, over: Partial<Feature> = {}): Feature =>
  ({ id, workspaceId: "w", projectId: "p1", name: `Feature ${id}`, milestoneId: null, ...over }) as Feature;

describe("rollupMilestones", () => {
  it("groups a directly-assigned task under its milestone, marked direct: true", () => {
    const rollups = rollupMilestones([milestone("m1")], [task("t1", { milestoneId: "m1" })], []);
    expect(rollups).toHaveLength(1);
    expect(rollups[0]!.tasks).toEqual([{ task: expect.objectContaining({ id: "t1" }), direct: true }]);
  });

  it("groups a task under its FEATURE's milestone, marked direct: false", () => {
    const rollups = rollupMilestones(
      [milestone("m1")],
      [task("t1", { featureId: "f1" })],
      [feature("f1", { milestoneId: "m1" })],
    );
    expect(rollups[0]!.tasks).toEqual([{ task: expect.objectContaining({ id: "t1" }), direct: false }]);
  });

  it("a task's own milestoneId wins over its feature's, when both are set", () => {
    const rollups = rollupMilestones(
      [milestone("m1"), milestone("m2")],
      [task("t1", { milestoneId: "m1", featureId: "f1" })],
      [feature("f1", { milestoneId: "m2" })],
    );
    expect(rollups.find((r) => r.milestone.id === "m1")!.tasks).toHaveLength(1);
    expect(rollups.find((r) => r.milestone.id === "m2")!.tasks).toHaveLength(0);
  });

  it("a milestone with nothing under it still gets an entry, tasks: []", () => {
    const rollups = rollupMilestones([milestone("m1")], [], []);
    expect(rollups).toEqual([{ milestone: expect.objectContaining({ id: "m1" }), tasks: [] }]);
  });

  it("a task with no milestoneId and no feature (or a feature with no milestone) lands under nothing", () => {
    const rollups = rollupMilestones(
      [milestone("m1")],
      [task("t1"), task("t2", { featureId: "f1" })],
      [feature("f1")], // milestoneId: null
    );
    expect(rollups[0]!.tasks).toHaveLength(0);
  });

  it("preserves milestone input order (the caller sorts before calling)", () => {
    const rollups = rollupMilestones([milestone("m2"), milestone("m1")], [], []);
    expect(rollups.map((r) => r.milestone.id)).toEqual(["m2", "m1"]);
  });
});
