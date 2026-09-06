// A worker's TaskRun.parentId points at its manager's run — the SAME field a
// plain fork uses (spawnWorker sets it exactly like a fork does). The only way
// to tell a manager delegation apart from a generic fork is a join against the
// PARENT run's agent role (role lives on the fleet Agent, not the TaskRun).
// Subway/Roster both need this join; it's covered once here rather than per view.
import { describe, it, expect } from "vitest";
import type { Agent, TaskRun } from "@skynet/shared";
import { isManagerRun, workersOf } from "../apps/web/src/lib/derive.js";

const agent = (id: string, role: Agent["role"] = "worker"): Agent => ({ id, role } as Agent);
const run = (id: string, agentId: string, parentId: string | null = null): TaskRun => ({ id, agentId, parentId } as TaskRun);

describe("isManagerRun", () => {
  it("is true when the run's agent has role manager", () => {
    const fleet = [agent("mgr", "manager")];
    expect(isManagerRun(run("r1", "mgr"), fleet)).toBe(true);
  });

  it("is false for a plain worker agent — a generic fork, not a delegation", () => {
    const fleet = [agent("w1", "worker")];
    expect(isManagerRun(run("r1", "w1"), fleet)).toBe(false);
  });

  it("is false when the run has no agent yet, or the agent isn't in the fleet", () => {
    expect(isManagerRun(run("r1", null), [])).toBe(false);
    expect(isManagerRun(run("r1", "gone"), [])).toBe(false);
  });
});

describe("workersOf", () => {
  it("returns exactly the runs spawn_worker delegated under a manager's run", () => {
    const managerRun = run("mgr-run", "mgr");
    const worker1 = run("w1-run", "w1", "mgr-run");
    const worker2 = run("w2-run", "w2", "mgr-run");
    const unrelated = run("other-run", "other", null);
    const runs = [managerRun, worker1, worker2, unrelated];
    expect(workersOf("mgr-run", runs)).toEqual([worker1, worker2]);
  });

  it("is empty for a manager that hasn't spawned any worker yet", () => {
    expect(workersOf("mgr-run", [run("mgr-run", "mgr")])).toEqual([]);
  });
});
