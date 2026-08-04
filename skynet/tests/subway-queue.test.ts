// The subway lookahead splits a project's not-yet-run work into per-agent queues
// (what's ahead of each agent) and a shared "up next" lane, in priority order.
import { describe, it, expect } from "vitest";
import type { Task } from "@skynet/shared";
import { projectQueue } from "../apps/web/src/lib/derive.js";

const mk = (over: Partial<Task>): Task => ({
  id: "t", workspaceId: "w", projectId: "p1", text: "x", state: "todo", runId: null,
  autoPick: false, assessment: null, reviewVerdict: null,
  assignment: { mode: "any", agentIds: [] }, ...over,
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
