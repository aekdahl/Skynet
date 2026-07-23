// The autonomy loop moves tasks without a human: backlog → triage (assessment),
// auto-pick todo → ongoing, and review → done/flag. Uses an injected provider so
// the consult (triage/review) and run start are deterministic.
import { describe, it, expect, beforeEach } from "vitest";
import type { Agent, HitlItem, Project, Task, TaskRun, ServerEvent } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

class NullBus implements Bus {
  publish(_ws: string, _e: ServerEvent): void {}
  subscribe(): () => void { return () => {}; }
}

class AutoProvider implements RunnerProvider {
  readonly id = "claude" as const;
  started = 0;
  constructor(private reply = "ok") {}
  async start(spec: StartSpec, _e: RunnerEvents): Promise<RunnerHandle> {
    this.started++;
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
  async consult(): Promise<string> { return this.reply; }
}

const project: Project = {
  id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [],
  status: "active", autonomy: true, repoPath: null, gitBacked: false,
};
const idleAgent: Agent = {
  id: "a1", workspaceId: DEFAULT_WORKSPACE, name: "a1", provider: "claude",
  model: "opus-4.8", status: "idle", idleSince: 0,
};
// Default eligibility "any" so autonomy will act on these; the parking behavior
// for `unassigned` tasks is covered explicitly below.
const mkTask = (over: Partial<Task>): Task => ({
  id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "do X", state: "backlog",
  runId: null, autoPick: false, assessment: null, reviewFlaggedReason: null,
  assignment: { mode: "any", agentIds: [] }, ...over,
});

const setup = async (reply?: string) => {
  const store = new MemoryStore();
  const hub = new Hub(store, new NullBus());
  const provider = new AutoProvider(reply);
  const orch = new Orchestrator(store, hub, provider);
  await store.putProject(project);
  await store.putAgent(idleAgent);
  return { store, orch, provider };
};

describe("autonomy loop", () => {
  it("triages a backlog task → triage with an assessment", async () => {
    const { store, orch } = await setup("clear ask, S, low risk");
    await store.putTask(mkTask({ state: "backlog" }));
    await orch.tickAutonomy();
    const t = await store.getTask("t1");
    expect(t?.state).toBe("triage");
    expect(t?.assessment).toContain("clear ask");
  });

  it("parks an unassigned backlog task (never auto-triages without an eligibility choice)", async () => {
    const { store, orch } = await setup("clear ask, S, low risk");
    await store.putTask(mkTask({ state: "backlog", assignment: { mode: "unassigned", agentIds: [] } }));
    await orch.tickAutonomy();
    expect((await store.getTask("t1"))?.state).toBe("backlog");
  });

  it("does NOT auto-pick an unassigned todo task", async () => {
    const { store, orch, provider } = await setup();
    await store.putTask(mkTask({ state: "todo", autoPick: true, assignment: { mode: "unassigned", agentIds: [] } }));
    await orch.tickAutonomy();
    expect((await store.getTask("t1"))?.state).toBe("todo");
    expect(provider.started).toBe(0);
  });

  it("does NOT cross the human gate (leaves triage where it is)", async () => {
    const { store, orch } = await setup();
    await store.putTask(mkTask({ state: "triage" }));
    await orch.tickAutonomy();
    expect((await store.getTask("t1"))?.state).toBe("triage");
  });

  it("starts an auto-pick todo task → ongoing", async () => {
    const { store, orch, provider } = await setup();
    await store.putTask(mkTask({ state: "todo", autoPick: true }));
    await orch.tickAutonomy();
    expect((await store.getTask("t1"))?.state).toBe("ongoing");
    expect(provider.started).toBe(1);
  });

  it("leaves a non-auto-pick todo task alone", async () => {
    const { store, orch, provider } = await setup();
    await store.putTask(mkTask({ state: "todo", autoPick: false }));
    await orch.tickAutonomy();
    expect((await store.getTask("t1"))?.state).toBe("todo");
    expect(provider.started).toBe(0);
  });

  it("auto-review that FLAGs sets reviewFlaggedReason and leaves the HITL open", async () => {
    const { store, orch } = await setup("FLAG: missing tests");
    const run: TaskRun = {
      id: "r1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", name: "do X", status: "review",
      runnerId: null, agentId: "a1", model: "opus-4.8", branch: "agent/r1", modules: [], progress: 1,
      plan: [], modifiedFiles: [], log: [], startedAt: 0, lastHeartbeatAt: 0, visual: false,
      previewUrl: null, dependsOn: [], parentId: null, branchFromStep: null, archived: false,
    };
    const hitl: HitlItem = {
      id: "q1", workspaceId: DEFAULT_WORKSPACE, runId: "r1", kind: "diff", title: "Review",
      why: "", risk: "medium", raisedAt: 0, expiresAt: null, resolvedAt: null, resolution: null,
      command: null, options: null, recommended: null, steps: null, diff: null,
    };
    await store.putRun(run);
    await store.putHitl(hitl);
    await store.putTask(mkTask({ state: "review", runId: "r1" }));
    await orch.tickAutonomy();
    expect((await store.getTask("t1"))?.reviewFlaggedReason).toContain("missing tests");
    expect((await store.getHitl("q1"))?.resolvedAt).toBeNull();
  });

  it("auto-review that APPROVEs resolves the review HITL", async () => {
    const { store, orch } = await setup("APPROVE: looks good");
    const run: TaskRun = {
      id: "r1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", name: "do X", status: "review",
      runnerId: null, agentId: "a1", model: "opus-4.8", branch: "agent/r1", modules: [], progress: 1,
      plan: [], modifiedFiles: [], log: [], startedAt: 0, lastHeartbeatAt: 0, visual: false,
      previewUrl: null, dependsOn: [], parentId: null, branchFromStep: null, archived: false,
    };
    const hitl: HitlItem = {
      id: "q1", workspaceId: DEFAULT_WORKSPACE, runId: "r1", kind: "diff", title: "Review",
      why: "", risk: "medium", raisedAt: 0, expiresAt: null, resolvedAt: null, resolution: null,
      command: null, options: null, recommended: null, steps: null, diff: null,
    };
    await store.putRun(run);
    await store.putHitl(hitl);
    await store.putTask(mkTask({ state: "review", runId: "r1" }));
    await orch.tickAutonomy();
    expect((await store.getHitl("q1"))?.resolution?.action).toBe("approve");
  });

  it("does NOT clobber a task that reached done while its review consult was running", async () => {
    // Race: autonomy picks up the review task and starts a (slow) review consult;
    // meanwhile the operator approves the diff gate → merge → task done. The
    // consult then returns FLAG. Autonomy must defer, not knock done → review.
    const store = new MemoryStore();
    const hub = new Hub(store, new NullBus());
    const run: TaskRun = {
      id: "r1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", name: "do X", status: "review",
      runnerId: null, agentId: "a1", model: "opus-4.8", branch: "agent/r1", modules: [], progress: 1,
      plan: [], modifiedFiles: [], log: [], startedAt: 0, lastHeartbeatAt: 0, visual: false,
      previewUrl: null, dependsOn: [], parentId: null, branchFromStep: null, archived: false,
    };
    const hitl: HitlItem = {
      id: "q1", workspaceId: DEFAULT_WORKSPACE, runId: "r1", kind: "diff", title: "Review",
      why: "", risk: "medium", raisedAt: 0, expiresAt: null, resolvedAt: null, resolution: null,
      command: null, options: null, recommended: null, steps: null, diff: null,
    };
    // The consult simulates the operator winning the race mid-consult: the gate
    // resolves and the task advances to done before FLAG comes back.
    const racing: RunnerProvider = {
      id: "claude",
      async start(spec: StartSpec, _e: RunnerEvents): Promise<RunnerHandle> {
        return { runId: spec.runId, provider: "claude", async pause() {}, async resume() {}, async message() {}, async stop() {} };
      },
      async consult(): Promise<string> {
        await store.putHitl({ ...hitl, resolvedAt: 1, resolution: { action: "approve", optionIndex: null, guidance: null, by: "jordan", at: 1 } });
        await store.putTask(mkTask({ state: "done", runId: "r1" }));
        return "FLAG: needs more tests";
      },
    };
    const orch = new Orchestrator(store, hub, racing);
    await store.putProject(project);
    await store.putAgent(idleAgent);
    await store.putRun(run);
    await store.putHitl(hitl);
    await store.putTask(mkTask({ state: "review", runId: "r1" }));
    await orch.tickAutonomy();
    const t = await store.getTask("t1");
    expect(t?.state).toBe("done"); // NOT clobbered back to review
    expect(t?.reviewFlaggedReason).toBeNull();
  });
});
