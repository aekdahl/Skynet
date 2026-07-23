// The kanban is a guarded state machine: humans may only make the transitions in
// HUMAN_TRANSITIONS (the gates + demotions), and illegal jumps are rejected.
import { describe, it, expect, beforeEach } from "vitest";
import type { Project, Task, ServerEvent } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { Operations, InvalidTransitionError, AssignmentRequiredError } from "../apps/server/src/operations.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";

class NullBus implements Bus {
  publish(_ws: string, _e: ServerEvent): void {}
  subscribe(): () => void { return () => {}; }
}

const project: Project = {
  id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [],
  status: "active", autonomy: true, repoPath: null, gitBacked: false,
};
// Default eligibility is "any" so existing transition tests exercise legal moves;
// the leaving-backlog gate is covered explicitly below with an `unassigned` task.
const mkTask = (state: Task["state"], assignment: Task["assignment"] = { mode: "any", agentIds: [] }): Task => ({
  id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "x", state,
  runId: null, autoPick: false, assessment: null, reviewFlaggedReason: null, assignment,
});

describe("task transition guard", () => {
  let store: MemoryStore;
  let ops: Operations;

  beforeEach(async () => {
    store = new MemoryStore();
    const hub = new Hub(store, new NullBus());
    const orchestrator = new Orchestrator(store, hub);
    ops = new Operations({ store, hub, orchestrator });
    await store.putProject(project);
  });

  it("allows a legal human move (backlog → triage)", async () => {
    await store.putTask(mkTask("backlog"));
    const t = await ops.transitionTask(DEFAULT_WORKSPACE, "t1", "triage", "op-1");
    expect(t.state).toBe("triage");
  });

  it("allows the human gate (triage → todo) and demotion (done → backlog)", async () => {
    await store.putTask(mkTask("triage"));
    expect((await ops.transitionTask(DEFAULT_WORKSPACE, "t1", "todo", "op-1")).state).toBe("todo");
    await store.putTask({ ...mkTask("done"), id: "t1" });
    expect((await ops.transitionTask(DEFAULT_WORKSPACE, "t1", "backlog", "op-1")).state).toBe("backlog");
  });

  it("rejects an illegal jump (backlog → done)", async () => {
    await store.putTask(mkTask("backlog"));
    await expect(ops.transitionTask(DEFAULT_WORKSPACE, "t1", "done", "op-1")).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );
  });

  it("rejects skipping the human gate (triage → ongoing)", async () => {
    await store.putTask(mkTask("triage"));
    await expect(ops.transitionTask(DEFAULT_WORKSPACE, "t1", "ongoing", "op-1")).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );
  });

  it("blocks leaving backlog until an agent is assigned", async () => {
    await store.putTask(mkTask("backlog", { mode: "unassigned", agentIds: [] }));
    await expect(ops.transitionTask(DEFAULT_WORKSPACE, "t1", "triage", "op-1")).rejects.toBeInstanceOf(
      AssignmentRequiredError,
    );
    // Setting eligibility unblocks the move.
    await ops.updateTask(DEFAULT_WORKSPACE, "t1", { assignment: { mode: "any", agentIds: [] } });
    expect((await ops.transitionTask(DEFAULT_WORKSPACE, "t1", "triage", "op-1")).state).toBe("triage");
  });
});
