// The subway lookahead splits a project's not-yet-run work into per-agent queues
// (what's ahead of each agent) and a shared "up next" lane, in priority order.
import { describe, it, expect } from "vitest";
import type { Task, TaskRun } from "@skynet/shared";
import { projectQueue, activeProjectRuns } from "../apps/web/src/lib/derive.js";

const mk = (over: Partial<Task>): Task => ({
  id: "t", workspaceId: "w", projectId: "p1", text: "x", state: "todo", runId: null,
  autoPick: false, assessment: null, reviewVerdict: null, lint: null,
  assignment: { mode: "any", agentIds: [] }, ...over,
});

const mkRun = (over: Partial<TaskRun>): TaskRun => ({
  id: "r", workspaceId: "w", projectId: "p1", name: "x", status: "done",
  agentId: "a1", provider: "claude", credentialId: null, model: "m", branch: "b",
  modules: [], progress: 1, plan: [], usage: null, modifiedFiles: [], log: [],
  startedAt: 0, lastHeartbeatAt: 0, visual: false, previewUrl: null, dependsOn: [],
  parentId: null, branchFromStep: null, archived: false, pr: null, ...over,
});

describe("projectQueue (subway lookahead)", () => {
  it("puts agent-pinned waiting tasks on their primary agent's queue, others in the shared lane", () => {
    const tasks: Task[] = [
      mk({ id: "a", assignment: { mode: "agents", agentIds: ["r1"] } }),
      mk({ id: "b", assignment: { mode: "agents", agentIds: ["r2", "r1"] } }), // primary = r2
      mk({ id: "c", assignment: { mode: "any", agentIds: [] } }),
      mk({ id: "d", assignment: { mode: "unassigned", agentIds: [] }, state: "backlog" }),
    ];
    const q = projectQueue(tasks, "p1");
    expect(q.pinned.get("r1")?.map((t) => t.id)).toEqual(["a"]);
    expect(q.pinned.get("r2")?.map((t) => t.id)).toEqual(["b"]);
    expect(q.shared.map((t) => t.id)).toEqual(["c", "d"]);
  });

  it("orders each queue by manual priority (order asc, then id)", () => {
    const tasks: Task[] = [
      mk({ id: "late", order: 5, assignment: { mode: "agents", agentIds: ["r1"] } }),
      mk({ id: "early", order: 1, assignment: { mode: "agents", agentIds: ["r1"] } }),
      mk({ id: "z", order: 2 }),
      mk({ id: "a", order: 2 }),
    ];
    const q = projectQueue(tasks, "p1");
    expect(q.pinned.get("r1")?.map((t) => t.id)).toEqual(["early", "late"]);
    expect(q.shared.map((t) => t.id)).toEqual(["a", "z"]); // same order → id tiebreak
  });

  it("excludes tasks that already have a run (they're existing stations, not queued)", () => {
    const tasks: Task[] = [
      mk({ id: "running", state: "ongoing", runId: "run-1", assignment: { mode: "agents", agentIds: ["r1"] } }),
      mk({ id: "done", state: "done", runId: "run-2" }),
      mk({ id: "waiting", assignment: { mode: "agents", agentIds: ["r1"] } }),
    ];
    const q = projectQueue(tasks, "p1");
    expect(q.pinned.get("r1")?.map((t) => t.id)).toEqual(["waiting"]);
    expect(q.shared).toEqual([]);
  });

  it("treats a legacy task with no assignment as shared", () => {
    const legacy = { ...mk({ id: "old" }) } as Task;
    delete (legacy as { assignment?: unknown }).assignment;
    const q = projectQueue([legacy], "p1");
    expect(q.shared.map((t) => t.id)).toEqual(["old"]);
    expect(q.pinned.size).toBe(0);
  });
});

describe("activeProjectRuns (drops superseded re-run originals)", () => {
  it("keeps a task's CURRENT run and drops its orphaned re-run original", () => {
    // Task t1 ran as r1 (done), was re-run as r2 (now its runId). r1 is orphaned.
    const tasks: Task[] = [mk({ id: "t1", state: "ongoing", runId: "r2" })];
    const runs: TaskRun[] = [
      mkRun({ id: "r1", status: "done" }), // superseded original — no task points here
      mkRun({ id: "r2", status: "running" }), // current run of t1
    ];
    expect(activeProjectRuns(runs, tasks, "p1").map((r) => r.id)).toEqual(["r2"]);
  });

  it("keeps a done run that is still its task's current run (normal history)", () => {
    const tasks: Task[] = [mk({ id: "t1", state: "done", runId: "r1" })];
    const runs: TaskRun[] = [mkRun({ id: "r1", status: "done" })];
    expect(activeProjectRuns(runs, tasks, "p1").map((r) => r.id)).toEqual(["r1"]);
  });

  it("never drops fork branches (child has parentId; its parent is kept)", () => {
    // t1's current run is the parent r1; r1f is a fork off it (not task-referenced).
    const tasks: Task[] = [mk({ id: "t1", state: "ongoing", runId: "r1" })];
    const runs: TaskRun[] = [
      mkRun({ id: "r1", status: "running" }),
      mkRun({ id: "r1f", status: "running", parentId: "r1" }),
    ];
    expect(activeProjectRuns(runs, tasks, "p1").map((r) => r.id).sort()).toEqual(["r1", "r1f"]);
  });

  it("keeps a superseded run if it's a fork parent (a branch still hangs off it)", () => {
    // r1 was re-run (t1.runId = r2), but a fork r1f branches off r1 — keep the family.
    const tasks: Task[] = [mk({ id: "t1", state: "ongoing", runId: "r2" })];
    const runs: TaskRun[] = [
      mkRun({ id: "r1", status: "done" }),
      mkRun({ id: "r1f", status: "running", parentId: "r1" }),
      mkRun({ id: "r2", status: "running" }),
    ];
    expect(activeProjectRuns(runs, tasks, "p1").map((r) => r.id).sort()).toEqual(["r1", "r1f", "r2"]);
  });

  it("scopes to the project", () => {
    const tasks: Task[] = [mk({ id: "t1", projectId: "p1", runId: "r1" })];
    const runs: TaskRun[] = [mkRun({ id: "r1", projectId: "p1" }), mkRun({ id: "rx", projectId: "p2" })];
    expect(activeProjectRuns(runs, tasks, "p1").map((r) => r.id)).toEqual(["r1"]);
  });
});
