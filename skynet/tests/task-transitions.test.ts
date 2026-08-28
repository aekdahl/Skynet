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
  runId: null, autoPick: false, assessment: null, reviewVerdict: null, lint: null, assignment,
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

  it("ongoing → todo abandons the run (the 'Send to To-do' button); review/done are not human moves from ongoing", async () => {
    // The board locks ongoing cards, so the only human exit is the explicit
    // "Send to To-do" button → transitionTask(…, "todo"), which detaches the run.
    await store.putTask({ ...mkTask("ongoing"), runId: "run-1" });
    const t = await ops.transitionTask(DEFAULT_WORKSPACE, "t1", "todo", "op-1");
    expect(t.state).toBe("todo");
    expect(t.runId).toBeNull(); // detached so the task returns clean

    // ongoing → review / done are agent-driven, never a human kanban move.
    await store.putTask({ ...mkTask("ongoing"), id: "t1", runId: "run-1" });
    await expect(ops.transitionTask(DEFAULT_WORKSPACE, "t1", "review", "op-1")).rejects.toBeInstanceOf(InvalidTransitionError);
    await expect(ops.transitionTask(DEFAULT_WORKSPACE, "t1", "done", "op-1")).rejects.toBeInstanceOf(InvalidTransitionError);
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

// A task landing in `done` MUST also flip its linked run's status to "done".
// The "review → done" path with no open HITL used to fall through to a plain
// upsertTask (no sync), so a card in Done could sit next to a run still shown
// as "review"/"running" on the board and detail view. These pin the sync.
describe("transitionTask — task.done syncs run.status", () => {
  const seedRunAndTask = async (
    store: MemoryStore,
    runStatus: "running" | "review" | "done",
    taskState: Task["state"],
  ): Promise<void> => {
    await store.putRun({
      id: "run-1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", name: "r",
      taskId: "t1", provider: "claude", model: "opus", branch: "main", status: runStatus,
      progress: 1, plan: [], log: [], startedAt: 0, lastHeartbeatAt: 0,
    } as never);
    await store.putTask({ ...mkTask(taskState), runId: "run-1" });
  };

  it("review → done (no open HITL) also flips the linked run to status 'done'", async () => {
    const store = new MemoryStore();
    const hub = new Hub(store, new NullBus());
    const orchestrator = new Orchestrator(store, hub);
    const ops = new Operations({ store, hub, orchestrator });
    await store.putProject(project);
    await seedRunAndTask(store, "review", "review");

    const t = await ops.transitionTask(DEFAULT_WORKSPACE, "t1", "done", "op-1");
    expect(t.state).toBe("done");
    expect((await store.getRun("run-1"))?.status).toBe("done");
  });

  it("demoting done → backlog retires the abandoned run (via retireRun, not the done-sync line)", async () => {
    const store = new MemoryStore();
    const hub = new Hub(store, new NullBus());
    const orchestrator = new Orchestrator(store, hub);
    const ops = new Operations({ store, hub, orchestrator });
    await store.putProject(project);
    // Task in `done` but with a `review` run — the abandonsRun path retires it.
    await seedRunAndTask(store, "review", "done");

    const t = await ops.transitionTask(DEFAULT_WORKSPACE, "t1", "backlog", "op-1");
    expect(t.state).toBe("backlog");
    expect(t.runId).toBeNull(); // detached
    // Kanban redesign, stage 1: retireRun consistently marks an abandoned run
    // terminal ("done") — this is NOT the done-sync line (`to === "done" &&
    // !abandonsRun`, which does not fire here since we're LEAVING done, not
    // landing on it) firing by coincidence; it's retireRun's own explicit
    // "this run is over" write, replacing the old inconsistent behavior where
    // only some of the five detach paths did this and this one didn't.
    expect((await store.getRun("run-1"))?.status).toBe("done");
    expect((await store.getRun("run-1"))?.archived).toBe(true);
  });
});

// Bug: "inbox messages must update if tasks move in kanban" — abandoning a
// run (ongoing/review → todo, or demoting done → triage/backlog) stopped +
// archived the run but left any open HITL gate for it dangling: the Inbox
// kept showing a now-meaningless pending decision for a run whose worktree
// was already retired and runner already freed. Distinct from the
// review→done path above (which already correctly resolves the gate via
// approve) — this covers the OTHER abandon direction.
describe("transitionTask — abandoning a run dismisses its dangling HITL gate", () => {
  const seedRunTaskAndHitl = async (
    store: MemoryStore,
    taskState: Task["state"],
    hitlId = "q1",
  ): Promise<void> => {
    await store.putRun({
      id: "run-1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", name: "r",
      taskId: "t1", provider: "claude", model: "opus", branch: "main", status: "review",
      progress: 1, plan: [], log: [], startedAt: 0, lastHeartbeatAt: 0,
    } as never);
    await store.putTask({ ...mkTask(taskState), runId: "run-1" });
    await store.putHitl({
      id: hitlId, workspaceId: DEFAULT_WORKSPACE, runId: "run-1", kind: "diff", title: "Review diff",
      why: "", risk: "medium", raisedAt: 0, expiresAt: null, resolvedAt: null, resolution: null,
      rationale: null, command: null, options: null, recommended: null, steps: null,
      diff: { add: 1, del: 0, modules: [] },
    } as never);
  };

  const setup = async () => {
    const store = new MemoryStore();
    const hub = new Hub(store, new NullBus());
    const orchestrator = new Orchestrator(store, hub);
    const ops = new Operations({ store, hub, orchestrator });
    await store.putProject(project);
    return { store, ops };
  };

  it("ongoing → todo dismisses the run's open HITL gate", async () => {
    const { store, ops } = await setup();
    await seedRunTaskAndHitl(store, "ongoing");

    await ops.transitionTask(DEFAULT_WORKSPACE, "t1", "todo", "op-1");

    const item = await store.getHitl("q1");
    expect(item?.resolvedAt).not.toBeNull(); // no longer dangling in the Inbox
    expect(item?.resolution?.action).toBe("dismiss");
    expect(item?.resolution?.by).toBe("op-1");
  });

  it("demoting done → backlog also dismisses the run's open HITL gate", async () => {
    const { store, ops } = await setup();
    await seedRunTaskAndHitl(store, "done");

    await ops.transitionTask(DEFAULT_WORKSPACE, "t1", "backlog", "op-1");

    const item = await store.getHitl("q1");
    expect(item?.resolvedAt).not.toBeNull();
    expect(item?.resolution?.action).toBe("dismiss");
  });

  it("dismisses EVERY open gate for the run, not just one", async () => {
    const { store, ops } = await setup();
    await seedRunTaskAndHitl(store, "ongoing", "q1");
    await store.putHitl({
      id: "q2", workspaceId: DEFAULT_WORKSPACE, runId: "run-1", kind: "verifier", title: "Check failed",
      why: "", risk: "medium", raisedAt: 0, expiresAt: null, resolvedAt: null, resolution: null,
      rationale: null, command: null, options: null, recommended: null, steps: null, diff: null,
    } as never);

    await ops.transitionTask(DEFAULT_WORKSPACE, "t1", "todo", "op-1");

    expect((await store.getHitl("q1"))?.resolvedAt).not.toBeNull();
    expect((await store.getHitl("q2"))?.resolvedAt).not.toBeNull();
  });

  it("a preserved move (pause, not abandon) leaves the open HITL untouched", async () => {
    const { store, ops } = await setup();
    await seedRunTaskAndHitl(store, "ongoing");

    await ops.transitionTask(DEFAULT_WORKSPACE, "t1", "todo", "op-1", { preserve: true });

    // Paused, not abandoned — the gate may still be answerable once resumed.
    expect((await store.getHitl("q1"))?.resolvedAt).toBeNull();
  });

  it("a legal move that does NOT abandon the run (review → done via approve) is unaffected", async () => {
    const { store, ops } = await setup();
    await seedRunTaskAndHitl(store, "review");

    await ops.transitionTask(DEFAULT_WORKSPACE, "t1", "done", "op-1");
    // Resolved via the existing "approve" path (transitionTask's OWN review→done
    // branch, above `abandonsRun`), not "dismiss" — my new dismissal logic
    // never fires for this path.
    expect((await store.getHitl("q1"))?.resolution?.action).toBe("approve");
  });
});

// Escape hatch: forceTaskDone bypasses HUMAN_TRANSITIONS and routes through the
// same integrate-and-sync path a normal Approve uses. These three run with no
// git backend configured (bare MemoryStore, non-git-backed project, no
// SKYNET_INTEGRATION_REPO) — Orchestrator.forceIntegrateRun's `!git` guard
// makes it a no-op, so these fall all the way to the cosmetic-only tail, same
// as the escape hatch's original behavior. The real commit+push/merge path is
// covered separately in tests/force-done-integration.test.ts.
describe("forceTaskDone — escape hatch", () => {
  let store: MemoryStore;
  let ops: Operations;

  beforeEach(async () => {
    store = new MemoryStore();
    const hub = new Hub(store, new NullBus());
    const orchestrator = new Orchestrator(store, hub);
    ops = new Operations({ store, hub, orchestrator });
    await store.putProject(project);
  });

  it("forces a task to done from any state (e.g. ongoing) and syncs the run", async () => {
    await store.putRun({
      id: "run-1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", name: "r",
      taskId: "t1", provider: "claude", model: "opus", branch: "main", status: "running",
      progress: 0.5, plan: [], log: [], startedAt: 0, lastHeartbeatAt: 0,
    } as never);
    await store.putTask({ ...mkTask("ongoing"), runId: "run-1" });

    const t = await ops.forceTaskDone(DEFAULT_WORKSPACE, "t1", "op-1");
    expect(t.state).toBe("done");
    expect((await store.getRun("run-1"))?.status).toBe("done");
  });

  it("idempotent — task already done + run already done → no-op success", async () => {
    await store.putRun({
      id: "run-1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", name: "r",
      taskId: "t1", provider: "claude", model: "opus", branch: "main", status: "done",
      progress: 1, plan: [], log: [], startedAt: 0, lastHeartbeatAt: 0,
    } as never);
    await store.putTask({ ...mkTask("done"), runId: "run-1" });

    const t = await ops.forceTaskDone(DEFAULT_WORKSPACE, "t1", "op-1");
    expect(t.state).toBe("done");
    expect((await store.getRun("run-1"))?.status).toBe("done");
  });

  it("works even with no linked run (nothing to sync)", async () => {
    await store.putTask({ ...mkTask("review"), runId: null });
    const t = await ops.forceTaskDone(DEFAULT_WORKSPACE, "t1", "op-1");
    expect(t.state).toBe("done");
    expect(t.runId).toBeNull();
  });
});

// Once an operator says "any agent can take this", they usually also want the
// autonomy loop to pick it up — asking them to also tick the Auto-pick box was
// a redundant step. Setting eligibility for the FIRST time (unassigned → any /
// agents) now flips autoPick on automatically. Later re-picks don't re-flip.
describe("updateTask — autoPick defaults on when eligibility first gets set", () => {
  let store: MemoryStore;
  let ops: Operations;

  beforeEach(async () => {
    store = new MemoryStore();
    const hub = new Hub(store, new NullBus());
    const orchestrator = new Orchestrator(store, hub);
    ops = new Operations({ store, hub, orchestrator });
    await store.putProject(project);
  });

  it("unassigned → any flips autoPick from false to true", async () => {
    await store.putTask({ ...mkTask("backlog", { mode: "unassigned", agentIds: [] }), autoPick: false });
    const t = await ops.updateTask(DEFAULT_WORKSPACE, "t1", { assignment: { mode: "any", agentIds: [] } });
    expect(t.autoPick).toBe(true);
    expect(t.assignment.mode).toBe("any");
  });

  it("unassigned → agents also flips autoPick on", async () => {
    // Seed the fleet so the agent id validates.
    await store.putAgent({
      id: "a-1", workspaceId: DEFAULT_WORKSPACE, name: "alpha",
      provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0,
    } as never);
    await store.putTask({ ...mkTask("backlog", { mode: "unassigned", agentIds: [] }), autoPick: false });
    const t = await ops.updateTask(DEFAULT_WORKSPACE, "t1", { assignment: { mode: "agents", agentIds: ["a-1"] } });
    expect(t.autoPick).toBe(true);
  });

  it("switching between any ↔ agents does NOT re-flip autoPick (respects the operator's later choice)", async () => {
    // Operator set eligibility once (autoPick got flipped on), then explicitly
    // turned autoPick off. A later mode swap must NOT silently re-enable it.
    await store.putTask({ ...mkTask("backlog", { mode: "any", agentIds: [] }), autoPick: false });
    await store.putAgent({
      id: "a-1", workspaceId: DEFAULT_WORKSPACE, name: "alpha",
      provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0,
    } as never);
    const t = await ops.updateTask(DEFAULT_WORKSPACE, "t1", { assignment: { mode: "agents", agentIds: ["a-1"] } });
    expect(t.autoPick).toBe(false);
  });

  it("an explicit autoPick in the same patch wins (user override)", async () => {
    // Operator sets eligibility AND unchecks autoPick in the same edit — respect it.
    await store.putTask({ ...mkTask("backlog", { mode: "unassigned", agentIds: [] }), autoPick: false });
    const t = await ops.updateTask(DEFAULT_WORKSPACE, "t1", {
      assignment: { mode: "any", agentIds: [] },
      autoPick: false,
    });
    expect(t.autoPick).toBe(false);
  });

  it("patches with no assignment change leave autoPick untouched", async () => {
    await store.putTask({ ...mkTask("backlog", { mode: "any", agentIds: [] }), autoPick: false });
    const t = await ops.updateTask(DEFAULT_WORKSPACE, "t1", { text: "renamed" });
    expect(t.autoPick).toBe(false);
    expect(t.text).toBe("renamed");
  });
});
