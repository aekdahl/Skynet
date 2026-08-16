// The autonomy loop moves tasks without a human: backlog → triage (assessment),
// auto-pick todo → ongoing, and review → done/flag. Uses an injected provider so
// the consult (triage/review) and run start are deterministic.
import { describe, it, expect, beforeEach } from "vitest";
import type { Agent, Feature, HitlItem, Milestone, Project, Task, TaskRun, ServerEvent } from "@skynet/shared";
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
// A SECOND idle agent. An agent never reviews its own run, so auto-review tests
// (whose run was done by a1) seed this one as the eligible reviewer — the loop
// picks the first idle agent that isn't the run's own agent and has canReview on.
const reviewerAgent: Agent = {
  id: "a2", workspaceId: DEFAULT_WORKSPACE, name: "a2", provider: "claude",
  model: "opus-4.8", status: "idle", idleSince: 0, canReview: true,
};
// Default eligibility "any" so autonomy will act on these; the parking behavior
// for `unassigned` tasks is covered explicitly below.
const mkTask = (over: Partial<Task>): Task => ({
  id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "do X", state: "backlog",
  runId: null, autoPick: false, assessment: null, reviewVerdict: null, lint: null,
  assignment: { mode: "any", agentIds: [] }, ...over,
});

const mkFeature = (over: Partial<Feature>): Feature => ({
  id: "f1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", name: "Billing", description: null,
  status: "active", milestoneId: null, archived: false, createdAt: 0, ...over,
});
const mkMilestone = (over: Partial<Milestone>): Milestone => ({
  id: "m1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", name: "v1", description: null,
  targetAt: null, status: "planned", archived: false, createdAt: 0, ...over,
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

  it("triages a backlog task → structured triage card (effort + risks land on the task)", async () => {
    const { store, orch } = await setup(
      'Adds a rate limiter to the login endpoint.\n{"estMinutes":20,"clarity":"clear","effort":"medium","risks":["touches auth — verify session handling","no existing tests for this path"]}',
    );
    await store.putTask(mkTask({ state: "backlog" }));
    await orch.tickAutonomy();
    const t = await store.getTask("t1");
    expect(t?.assessment).toContain("rate limiter");
    expect(t?.assessmentEffort).toBe("medium");
    expect(t?.assessmentRisks).toEqual(["touches auth — verify session handling", "no existing tests for this path"]);
  });

  it("a reply with no effort/risks tag leaves both at their legacy-safe defaults (renders as the old free-text-only card)", async () => {
    const { store, orch } = await setup("clear ask, S, low risk"); // no JSON tag at all
    await store.putTask(mkTask({ state: "backlog" }));
    await orch.tickAutonomy();
    const t = await store.getTask("t1");
    expect(t?.assessment).toContain("clear ask");
    expect(t?.assessmentEffort).toBeNull();
    expect(t?.assessmentRisks).toEqual([]);
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

  it("auto-picks multiple eligible todo tasks concurrently without double-booking a runner", async () => {
    // tickAutonomy fires assignTask for every eligible task via Promise.allSettled
    // rather than one at a time — this pins the safety property that relies on:
    // acquireAgent's find-idle→mark-busy step is serialized by acquireExclusive,
    // so racing 3 tasks against 2 idle agents claims exactly 2 distinct agents
    // and leaves the third queued, instead of double-booking or crashing the tick.
    const { store, orch, provider } = await setup();
    await store.putAgent(reviewerAgent); // a second idle agent — 2 idle total
    await store.putTask(mkTask({ id: "t1", state: "todo", autoPick: true }));
    await store.putTask(mkTask({ id: "t2", state: "todo", autoPick: true }));
    await store.putTask(mkTask({ id: "t3", state: "todo", autoPick: true })); // exceeds capacity
    await orch.tickAutonomy();

    const [t1, t2, t3] = await Promise.all(["t1", "t2", "t3"].map((id) => store.getTask(id)));
    const started = [t1, t2, t3].filter((t) => t?.state === "ongoing");
    const queued = [t1, t2, t3].filter((t) => t?.state === "todo");
    expect(started).toHaveLength(2);
    expect(queued).toHaveLength(1);
    expect(provider.started).toBe(2);

    const runs = await Promise.all(started.map((t) => store.getRun(t!.runId!)));
    const agentIds = new Set(runs.map((r) => r?.agentId));
    expect(agentIds).toEqual(new Set(["a1", "a2"])); // two distinct agents, not one double-booked
  });

  it("picks the lowest-`order` (highest-priority) eligible task first when capacity is short", async () => {
    // Only one idle agent (a1) — capacity for exactly one task. t2 carries the
    // lower `order` (promoted via the ↑/↓ control), so it must win the single
    // slot even though t1 was inserted first and sorts first by id.
    const { store, orch, provider } = await setup();
    await store.putTask(mkTask({ id: "t1", state: "todo", autoPick: true, order: 1 }));
    await store.putTask(mkTask({ id: "t2", state: "todo", autoPick: true, order: 0 }));
    await orch.tickAutonomy();

    expect((await store.getTask("t2"))?.state).toBe("ongoing");
    expect((await store.getTask("t1"))?.state).toBe("todo");
    expect(provider.started).toBe(1);
  });

  it("leaves a non-auto-pick todo task alone", async () => {
    const { store, orch, provider } = await setup();
    await store.putTask(mkTask({ state: "todo", autoPick: false }));
    await orch.tickAutonomy();
    expect((await store.getTask("t1"))?.state).toBe("todo");
    expect(provider.started).toBe(0);
  });

  // Archived is a soft-hide: autonomy must ignore archived tasks entirely, or it
  // re-picks one the operator hid and spawns a run — the "archived task still
  // marked as running" bug.
  it("does NOT auto-pick an ARCHIVED todo task (no run spawned)", async () => {
    const { store, orch, provider } = await setup();
    await store.putTask(mkTask({ state: "todo", autoPick: true, archived: true }));
    await orch.tickAutonomy();
    expect((await store.getTask("t1"))?.state).toBe("todo"); // untouched
    expect(provider.started).toBe(0);                        // never started
  });

  it("does NOT triage an ARCHIVED backlog task", async () => {
    const { store, orch } = await setup('Clear scope.\n{"clarity":"clear"}');
    await store.putTask(mkTask({ state: "backlog", archived: true }));
    await orch.tickAutonomy();
    const t = await store.getTask("t1");
    expect(t?.state).toBe("backlog"); // not promoted
    expect(t?.assessment).toBeNull(); // never assessed
  });

  it("does NOT auto-review an ARCHIVED review task", async () => {
    const { store, orch, provider } = await setup('{"verdict":"approve","reason":"looks good"}');
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
    await store.putTask(mkTask({ state: "review", runId: "r1", archived: true }));
    const consultsBefore = provider.consults;
    await orch.tickAutonomy();
    expect(provider.consults).toBe(consultsBefore);           // no review consult
    expect((await store.getTask("t1"))?.reviewVerdict).toBeNull();
    expect((await store.getHitl("q1"))?.resolvedAt).toBeNull(); // not merged
  });

  it("assignTask refuses an archived task (defense in depth for any caller)", async () => {
    const { store, orch, provider } = await setup();
    await store.putTask(mkTask({ state: "todo", archived: true }));
    await expect(orch.assignTask("p1", "t1")).rejects.toThrow(/archived/i);
    expect(provider.started).toBe(0);
  });

  it("auto-review that FLAGs records the verdict on the task and leaves the HITL open", async () => {
    const { store, orch } = await setup('{"verdict":"flag","reason":"missing tests"}');
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
    await store.putAgent(reviewerAgent); // a different agent reviews a1's run
    await store.putRun(run);
    await store.putHitl(hitl);
    await store.putTask(mkTask({ state: "review", runId: "r1" }));
    await orch.tickAutonomy();
    const flagged = await store.getTask("t1");
    expect(flagged?.reviewVerdict?.decision).toBe("flag");
    expect(flagged?.reviewVerdict?.reason).toContain("missing tests");
    expect(flagged?.reviewVerdict?.by).toBe("a2");
    expect((await store.getHitl("q1"))?.resolvedAt).toBeNull();
    // The review is recorded on the run's live log: WHO reviewed + the verdict,
    // with the reviewer's full reasoning foldable in `detail`.
    const flog = (await store.getRun("r1"))?.log.find((l) => /auto-reviewed by a2/i.test(l.line));
    expect(flog?.line).toMatch(/flagged for a human/i);
    expect(flog?.detail).toContain("missing tests");
  });

  it("auto-review that APPROVEs resolves the review HITL AND moves the task to done", async () => {
    // When the AGENT signs off, the task advances to `done` (and its run's
    // status flips to done) regardless of the downstream integration path.
    // For local merges completeMerged() ALSO writes done (idempotent); for the
    // GitHub PR path pushToGithub stops at review waiting for a human — this
    // guarantees the KANBAN task doesn't strand there.
    const { store, orch } = await setup('{"verdict":"approve","reason":"looks good"}');
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
    await store.putAgent(reviewerAgent); // a different agent reviews a1's run
    await store.putRun(run);
    await store.putHitl(hitl);
    await store.putTask(mkTask({ state: "review", runId: "r1" }));
    await orch.tickAutonomy();
    expect((await store.getHitl("q1"))?.resolution?.action).toBe("approve");
    // Task advanced to done + run.status synced.
    expect((await store.getTask("t1"))?.state).toBe("done");
    expect((await store.getRun("r1"))?.status).toBe("done");
    const alog = (await store.getRun("r1"))?.log.find((l) => /auto-reviewed by a2/i.test(l.line));
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
        await store.putHitl({ ...hitl, resolvedAt: 1, resolution: { action: "approve", optionIndex: null, guidance: null, memoryNote: null, by: "jordan", at: 1 } });
        await store.putTask(mkTask({ state: "done", runId: "r1" }));
        return "FLAG: needs more tests";
      },
    };
    const orch = new Orchestrator(store, hub, racing);
    await store.putProject(project);
    await store.putAgent(idleAgent);
    await store.putAgent(reviewerAgent); // a different agent reviews a1's run
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
    const provider = new AutoProvider('{"verdict":"approve","reason":"looks good"}');
    const orch = new Orchestrator(store, hub, provider);
    await store.putProject({ ...project, autonomy: false });
    await store.putAgent(idleAgent);
    await store.putAgent(reviewerAgent); // a different agent reviews a1's run
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
    const alog = (await store.getRun("r1"))?.log.find((l) => /auto-reviewed by a2/i.test(l.line));
    expect(alog?.line).toMatch(/awaiting human/i);
  });

  it("never lets an agent review its OWN run — with no other agent, it waits for a human", async () => {
    // The reviewer must differ from the run's own agent. When a1 did the run and
    // a1 is the ONLY agent, there's no eligible reviewer: no verdict is written,
    // no consult fires, and the diff gate stays open for a human — the run is
    // never rubber-stamped into a PR by the agent that produced it.
    const { store, orch, provider } = await setup('{"verdict":"approve","reason":"looks good"}');
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
    expect((await store.getTask("t1"))?.reviewVerdict).toBeNull(); // not self-reviewed
    expect(provider.consults).toBe(0); // no review consult fired
    expect((await store.getHitl("q1"))?.resolvedAt).toBeNull(); // gate still open for a human
    expect((await store.getTask("t1"))?.state).toBe("review");
  });

  it("does not re-review a task that already has a verdict (idempotent)", async () => {
    // Once the verdict exists, subsequent ticks must NOT spend another LLM call.
    const { store, orch, provider } = await setup('{"verdict":"approve","reason":"looks good"}');
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

describe("autonomy triage — feature/milestone grouping", () => {
  // Triage offers the project's open features/milestones; the model picks an id
  // from those lists, which we validate before writing (never a fabricated id).
  const triageWith = async (reply: string, over: Partial<Task> = {}) => {
    const { store, orch } = await setup(reply);
    await store.putFeature(mkFeature({ id: "f1", name: "Billing" }));
    await store.putMilestone(mkMilestone({ id: "m1", name: "v1" }));
    await store.putTask(mkTask({ state: "backlog", ...over }));
    await orch.tickAutonomy();
    return store.getTask("t1");
  };

  it("files the task under a suitable existing feature (milestone inherited → not set directly)", async () => {
    const t = await triageWith('Fits Billing.\n{"estMinutes":20,"clarity":"clear","featureId":"f1"}');
    expect(t?.featureId).toBe("f1");
    expect(t?.milestoneId).toBeNull();
    expect(t?.state).toBe("todo"); // clarity=clear still auto-promotes
  });

  it("sets a milestone directly when no feature fits", async () => {
    const t = await triageWith('Belongs in v1.\n{"clarity":"unclear","milestoneId":"m1"}');
    expect(t?.milestoneId).toBe("m1");
    expect(t?.featureId).toBeNull();
  });

  it("prefers the feature and drops a co-picked milestone (the feature carries it)", async () => {
    const t = await triageWith('Both.\n{"clarity":"clear","featureId":"f1","milestoneId":"m1"}');
    expect(t?.featureId).toBe("f1");
    expect(t?.milestoneId).toBeNull();
  });

  it("rejects a fabricated id not in the offered lists", async () => {
    const t = await triageWith('Made up.\n{"clarity":"unclear","featureId":"ghost","milestoneId":"nope"}');
    expect(t?.featureId).toBeNull();
    expect(t?.milestoneId).toBeNull();
  });

  it("never clobbers a grouping the operator already set", async () => {
    const t = await triageWith(
      'Retriage.\n{"clarity":"unclear","featureId":"f1"}',
      { featureId: "operator-choice" },
    );
    expect(t?.featureId).toBe("operator-choice");
  });
});
