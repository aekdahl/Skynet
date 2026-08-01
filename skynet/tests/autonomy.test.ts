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
  consults = 0;
  constructor(private reply = "ok") {}
  async start(spec: StartSpec, _e: RunnerEvents): Promise<RunnerHandle> {
    this.started++;
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
  async consult(): Promise<string> { this.consults++; return this.reply; }
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
  runId: null, autoPick: false, assessment: null, reviewVerdict: null,
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

  it("auto-promotes triage→todo when the LLM self-reports clarity=clear", async () => {
    // The LLM tail signal `{"clarity":"clear"}` is the "safe to advance"
    // handshake — the task's eligibility must also be set (already `any` in
    // mkTask), so leaving backlog is legal.
    const { store, orch } = await setup('Clear scope.\n{"estMinutes":15,"clarity":"clear"}');
    await store.putTask(mkTask({ state: "backlog" }));
    await orch.tickAutonomy();
    const t = await store.getTask("t1");
    expect(t?.state).toBe("todo");
    expect(t?.assessment).toContain("Clear scope");
    expect(t?.estimatedDurationMs).toBe(15 * 60_000);
  });

  it("parks in triage when clarity=unclear (human still owns the promote)", async () => {
    const { store, orch } = await setup('Ambiguous ask.\n{"clarity":"unclear"}');
    await store.putTask(mkTask({ state: "backlog" }));
    await orch.tickAutonomy();
    const t = await store.getTask("t1");
    expect(t?.state).toBe("triage");
    expect(t?.assessment).toContain("Ambiguous");
  });

  it("parks in triage when the LLM omits clarity entirely (missing = unclear-equivalent)", async () => {
    const { store, orch } = await setup("Clear ask, S, low risk"); // no JSON tag
    await store.putTask(mkTask({ state: "backlog" }));
    await orch.tickAutonomy();
    expect((await store.getTask("t1"))?.state).toBe("triage");
  });

  it("triages even when project.autonomy is off (informative, no work runs)", async () => {
    const { store, orch } = await setup("clear ask, S, low risk");
    // Flip autonomy off — pickup/review should be gated but triage still runs.
    await store.putProject({ ...project, autonomy: false });
    await store.putTask(mkTask({ state: "backlog" }));
    await orch.tickAutonomy();
    expect((await store.getTask("t1"))?.state).toBe("triage");
    expect((await store.getTask("t1"))?.assessment).toContain("clear ask");
  });

  it("does NOT auto-pick when project.autonomy is off — even if the task is auto-pick + eligible", async () => {
    // The gate is on the ACTION step (spends time/tokens), not on triage.
    const { store, orch, provider } = await setup();
    await store.putProject({ ...project, autonomy: false });
    await store.putTask(mkTask({ state: "todo", autoPick: true }));
    await orch.tickAutonomy();
    expect((await store.getTask("t1"))?.state).toBe("todo"); // stays put
    expect(provider.started).toBe(0);                        // no run started
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

  it("auto-review that FLAGs records the verdict on the task and leaves the HITL open", async () => {
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
    const flagged = await store.getTask("t1");
    expect(flagged?.reviewVerdict?.decision).toBe("flag");
    expect(flagged?.reviewVerdict?.reason).toContain("missing tests");
    expect(flagged?.reviewVerdict?.by).toBe("a1");
    expect((await store.getHitl("q1"))?.resolvedAt).toBeNull();
    // The review is recorded on the run's live log: WHO reviewed + the verdict,
    // with the reviewer's full reasoning foldable in `detail`.
    const flog = (await store.getRun("r1"))?.log.find((l) => /auto-reviewed by a1/i.test(l.line));
    expect(flog?.line).toMatch(/flagged for a human/i);
    expect(flog?.detail).toContain("missing tests");
  });

  it("auto-review that APPROVEs resolves the review HITL AND moves the task to done", async () => {
    // When the AGENT signs off, the task advances to `done` (and its run's
    // status flips to done) regardless of the downstream integration path.
    // For local merges completeMerged() ALSO writes done (idempotent); for the
    // GitHub PR path pushToGithub stops at review waiting for a human — this
    // guarantees the KANBAN task doesn't strand there.
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
    // Task advanced to done + run.status synced.
    expect((await store.getTask("t1"))?.state).toBe("done");
    expect((await store.getRun("r1"))?.status).toBe("done");
    const alog = (await store.getRun("r1"))?.log.find((l) => /auto-reviewed by a1/i.test(l.line));
    expect(alog?.line).toMatch(/approved/i);
    expect(alog?.detail).toContain("looks good");
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
    expect(t?.reviewVerdict).toBeNull();
  });

  it("auto-review runs even when project.autonomy is OFF — records verdict but does NOT resolve the HITL", async () => {
    // Reviewing is diagnostic; the audit trail must exist for a human even when
    // the project has opted out of autonomous spending. The APPROVE-and-merge
    // step, in contrast, DOES stay gated on autonomy.
    const store = new MemoryStore();
    const hub = new Hub(store, new NullBus());
    const provider = new AutoProvider("APPROVE: looks good");
    const orch = new Orchestrator(store, hub, provider);
    await store.putProject({ ...project, autonomy: false });
    await store.putAgent(idleAgent);
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
    const t = await store.getTask("t1");
    expect(t?.state).toBe("review"); // still awaiting the human
    expect(t?.reviewVerdict?.decision).toBe("approve");
    expect(t?.reviewVerdict?.reason).toContain("looks good");
    expect((await store.getHitl("q1"))?.resolvedAt).toBeNull();
    // Log line notes the "awaiting human" flavor of the approve verdict.
    const alog = (await store.getRun("r1"))?.log.find((l) => /auto-reviewed by a1/i.test(l.line));
    expect(alog?.line).toMatch(/awaiting human/i);
  });

  it("does not re-review a task that already has a verdict (idempotent)", async () => {
    // Once the verdict exists, subsequent ticks must NOT spend another LLM call.
    const { store, orch, provider } = await setup("APPROVE: looks good");
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
    await store.putTask(mkTask({
      state: "review", runId: "r1",
      reviewVerdict: { decision: "flag", reason: "prior verdict", by: "a1", at: 1 },
    }));
    const consultsBefore = provider.consults;
    await orch.tickAutonomy();
    expect(provider.consults).toBe(consultsBefore); // no new consult fired
    const t = await store.getTask("t1");
    expect(t?.reviewVerdict?.reason).toBe("prior verdict"); // unchanged
  });
});
