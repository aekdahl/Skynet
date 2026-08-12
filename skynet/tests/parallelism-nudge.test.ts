// Parallelism nudge — "idle runners + deep backlog → spin up more?" (roadmap
// v1.5). A pure function, covered deterministically here. Eligibility must
// mirror the autonomy loop's own auto-pick check (orchestrator.ts
// tickAutonomy): a task with no assignment set isn't workable by anyone yet,
// so it must never count toward backlog depth.
import { describe, it, expect } from "vitest";
import type { Agent, Task } from "@skynet/shared";
import { computeParallelismNudge } from "../apps/server/src/derive/parallelism.js";

const agent = (id: string, status: Agent["status"] = "idle"): Agent =>
  ({ id, status } as unknown as Agent);

const task = (id: string, extra: Partial<Task> = {}): Task =>
  ({
    id,
    state: "todo",
    archived: false,
    assignment: { mode: "any", agentIds: [] },
    ...extra,
  }) as unknown as Task;

describe("computeParallelismNudge", () => {
  it("nudges when idle runners AND eligible backlog both clear the threshold", () => {
    const fleet = [agent("a1"), agent("a2")];
    const tasks = [task("t1"), task("t2"), task("t3")];
    expect(computeParallelismNudge(fleet, tasks)).toEqual({
      idleRunners: 2,
      eligibleBacklog: 3,
      shouldNudge: true,
    });
  });

  it("does not nudge on a single idle runner — normal churn, not spare capacity", () => {
    const fleet = [agent("a1"), agent("a2", "busy")];
    const tasks = [task("t1"), task("t2"), task("t3")];
    expect(computeParallelismNudge(fleet, tasks).shouldNudge).toBe(false);
  });

  it("does not nudge on a shallow backlog even with idle capacity", () => {
    const fleet = [agent("a1"), agent("a2")];
    const tasks = [task("t1"), task("t2")];
    expect(computeParallelismNudge(fleet, tasks).shouldNudge).toBe(false);
  });

  it("does not nudge when the fleet is busy, regardless of backlog depth", () => {
    const fleet = [agent("a1", "busy"), agent("a2", "busy")];
    const tasks = [task("t1"), task("t2"), task("t3"), task("t4")];
    expect(computeParallelismNudge(fleet, tasks).shouldNudge).toBe(false);
  });

  it("excludes unassigned tasks — same eligibility bar as auto-pick", () => {
    const fleet = [agent("a1"), agent("a2")];
    const tasks = [
      task("t1"),
      task("t2"),
      task("t3", { assignment: { mode: "unassigned", agentIds: [] } }),
      task("t4", { assignment: { mode: "unassigned", agentIds: [] } }),
    ];
    const nudge = computeParallelismNudge(fleet, tasks);
    expect(nudge.eligibleBacklog).toBe(2); // only t1/t2 count
    expect(nudge.shouldNudge).toBe(false); // 2 < MIN_ELIGIBLE_BACKLOG (3)
  });

  it("excludes archived and non-backlog/todo tasks", () => {
    const fleet = [agent("a1"), agent("a2")];
    const tasks = [
      task("t1"),
      task("t2"),
      task("t3", { archived: true }),
      task("t4", { state: "done" }),
      task("t5", { state: "ongoing" }),
    ];
    expect(computeParallelismNudge(fleet, tasks).eligibleBacklog).toBe(2);
  });

  it("counts backlog-state tasks too, not just todo", () => {
    const fleet = [agent("a1"), agent("a2")];
    const tasks = [task("t1", { state: "backlog" }), task("t2", { state: "backlog" }), task("t3")];
    const nudge = computeParallelismNudge(fleet, tasks);
    expect(nudge.eligibleBacklog).toBe(3);
    expect(nudge.shouldNudge).toBe(true);
  });
});
