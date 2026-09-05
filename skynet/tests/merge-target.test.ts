// Merge-target resolution (agent-hierarchy brief §5 / VCS brief §7) — a pure
// function, covered deterministically here rather than by exercising the real
// orchestrator/git.
import { describe, it, expect } from "vitest";
import type { Agent, TaskRun } from "@skynet/shared";
import { isManagerDelegated, resolveMergeTarget } from "../apps/server/src/derive/merge-target.js";

const run = (id: string, extra: Partial<TaskRun> = {}): TaskRun =>
  ({ id, branch: `agent/${id}`, parentId: null, ...extra }) as unknown as TaskRun;

const runner = (role: Agent["role"]): Pick<Agent, "role"> => ({ role });

describe("resolveMergeTarget", () => {
  it("no parent → the project base branch", () => {
    expect(resolveMergeTarget(run("solo"), undefined, undefined, "main")).toBe("main");
  });

  it("a plain fork (parent exists, but no runner resolved) → the project base branch, unchanged from today", () => {
    const parent = run("parent");
    const child = run("child", { parentId: "parent" });
    expect(resolveMergeTarget(child, parent, undefined, "main")).toBe("main");
  });

  it("a fork whose parent's runner is role:'worker' → the project base branch, unchanged from today", () => {
    const parent = run("parent");
    const child = run("child", { parentId: "parent" });
    expect(resolveMergeTarget(child, parent, runner("worker"), "main")).toBe("main");
  });

  it("a parent unresolvable (e.g. deleted) → the project base branch", () => {
    const child = run("child", { parentId: "ghost" });
    expect(resolveMergeTarget(child, undefined, runner("manager"), "main")).toBe("main");
  });

  it("a worker whose direct parent's runner is role:'manager' → the manager's branch first", () => {
    const manager = run("mgr", { branch: "skynet/mgr/billing" });
    const worker = run("worker-1", { parentId: "mgr" });
    expect(resolveMergeTarget(worker, manager, runner("manager"), "main")).toBe("skynet/mgr/billing");
  });

  it("resolves tier-by-tier — a grandchild's target is its OWN direct parent, not the family root", () => {
    // worker-2's direct parent is worker-1 (a plain worker, not a manager), so
    // even though worker-1's OWN parent is a manager, worker-2 still targets
    // the project base — it doesn't skip ahead past its immediate parent.
    const worker1 = run("worker-1", { parentId: "mgr", branch: "agent/worker-1" });
    const worker2 = run("worker-2", { parentId: "worker-1" });
    expect(resolveMergeTarget(worker2, worker1, runner("worker"), "main")).toBe("main");
  });
});

describe("isManagerDelegated", () => {
  it("false with no parent", () => {
    expect(isManagerDelegated(run("solo"), undefined, undefined)).toBe(false);
  });

  it("false when the parent's runner is role:'worker'", () => {
    const parent = run("parent");
    const child = run("child", { parentId: "parent" });
    expect(isManagerDelegated(child, parent, runner("worker"))).toBe(false);
  });

  it("false when the parent's runner is unresolvable", () => {
    const child = run("child", { parentId: "ghost" });
    expect(isManagerDelegated(child, undefined, runner("manager"))).toBe(false);
  });

  it("true when the direct parent's runner is role:'manager'", () => {
    const manager = run("mgr", { branch: "skynet/mgr/billing" });
    const worker = run("worker-1", { parentId: "mgr" });
    expect(isManagerDelegated(worker, manager, runner("manager"))).toBe(true);
  });
});
