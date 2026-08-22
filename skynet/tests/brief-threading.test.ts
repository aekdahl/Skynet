// S8 — Brief threading + the feedback loop. Three layers:
//   1. resolveTaskBrief (packages/shared) — pure resolution rule, no I/O.
//   2. Feedback: a fleet-proposed task parked (not auto-promoted) still
//      inherits the source task's feature when a SolutionBrief backs it —
//      same lighter in-memory harness as tests/fleet-proposals.test.ts.
//   3. Threading + status transitions, end to end through the real
//      Orchestrator against a throwaway git repo — same harness as
//      tests/feature-brief-orchestrator.test.ts / tests/agent-context-wiring.test.ts.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE, resolveTaskBrief } from "@skynet/shared";
import type { Agent, Feature, HitlItem, Project, ProviderId, Resolution, ServerEvent, SolutionBrief, Task, TaskRun } from "@skynet/shared";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";
import type { Bus } from "../apps/server/src/bus.js";

class NullBus implements Bus {
  publish(_ws: string, _e: ServerEvent): void {}
  subscribe(): () => void {
    return () => {};
  }
}

const mkBrief = (over: Partial<SolutionBrief> = {}): SolutionBrief => ({
  id: "brief-1",
  workspaceId: DEFAULT_WORKSPACE,
  projectId: "p1",
  title: "Rate limiting",
  problem: "The API has no rate limiting and gets hammered.",
  approach: "Add a token-bucket limiter middleware in front of every route.",
  optionsConsidered: [],
  risks: [],
  acceptanceCriteria: ["429s returned once a client exceeds the bucket", "limiter config is per-route"],
  openQuestions: [],
  status: "approved",
  featureId: "f1",
  createdAt: 0,
  updatedAt: 0,
  approvedAt: 0,
  approvedBy: "op-1",
  sourceConversation: null,
  ...over,
});

// ─── 1. resolveTaskBrief — pure ────────────────────────────────────────────

describe("resolveTaskBrief (pure)", () => {
  const briefs = [mkBrief({ id: "b-feature", featureId: "f1" }), mkBrief({ id: "b-direct", featureId: null })];

  it("resolves via a direct source.briefId reference", () => {
    const task = { featureId: null, source: { kind: "brief", briefId: "b-direct" } } as unknown as Task;
    expect(resolveTaskBrief(task, briefs)?.id).toBe("b-direct");
  });

  it("resolves via the task's Feature when there's no direct source link", () => {
    const task = { featureId: "f1", source: null } as unknown as Task;
    expect(resolveTaskBrief(task, briefs)?.id).toBe("b-feature");
  });

  it("prefers a direct source.briefId over the feature link when both are present", () => {
    const task = { featureId: "f1", source: { kind: "brief", briefId: "b-direct" } } as unknown as Task;
    expect(resolveTaskBrief(task, briefs)?.id).toBe("b-direct");
  });

  it("returns undefined when the task has neither a brief source nor a brief-linked feature", () => {
    const task = { featureId: "f-unrelated", source: null } as unknown as Task;
    expect(resolveTaskBrief(task, briefs)).toBeUndefined();
  });

  it("returns undefined when the task has no featureId and no source at all", () => {
    const task = { featureId: null, source: null } as unknown as Task;
    expect(resolveTaskBrief(task, briefs)).toBeUndefined();
  });
});

// ─── 2. Feedback loop — lighter in-memory harness (no real git needed) ─────

class ReplyProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  reply = "ok";
  async start(spec: StartSpec, _events: RunnerEvents): Promise<RunnerHandle> {
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
  async consult(): Promise<string> {
    return this.reply;
  }
}

const mkProject = (over: Partial<Project> = {}): Project =>
  ({ id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [], status: "active", autonomy: true, repoPath: null, gitBacked: false, ...over } as Project);
const mkAgent = (over: Partial<Agent>): Agent =>
  ({ id: "a1", workspaceId: DEFAULT_WORKSPACE, name: "a1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0, ...over } as Agent);
const mkFeature = (over: Partial<Feature> = {}): Feature =>
  ({ id: "f1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", name: "Rate limiting", description: null, status: "active", milestoneId: null, archived: false, createdAt: 1, pr: null, ...over } as Feature);

describe("S8 feedback — a parked fleet proposal inherits the source task's brief-linked feature", () => {
  const setup = async () => {
    const { Hub } = await import("../apps/server/src/hub.js");
    const { Orchestrator } = await import("../apps/server/src/orchestrator.js");
    const { MemoryStore } = await import("../apps/server/src/store/memory.js");
    const store = new MemoryStore();
    const hub = new Hub(store, new NullBus());
    const provider = new ReplyProvider();
    const orch = new Orchestrator(store, hub, provider);
    await store.putProject(mkProject());
    await store.putAgent(mkAgent({ id: "a1" }));
    await store.putAgent(mkAgent({ id: "a2", canReview: true }));
    return { store, orch, provider };
  };

  const reviewRound = async (store: any, orch: any, provider: ReplyProvider, taskOver: Partial<Task>, reply: string) => {
    const id = taskOver.id ?? "t1";
    const runId = `r-${id}`;
    await store.putRun({
      id: runId, workspaceId: DEFAULT_WORKSPACE, projectId: "p1", name: "do X", status: "review",
      agentId: "a1", provider: "claude", model: "opus-4.8", branch: `agent/${runId}`, modules: [], progress: 1,
      plan: [], modifiedFiles: [], log: [], startedAt: 0, lastHeartbeatAt: 0, visual: false,
      previewUrl: null, dependsOn: [], parentId: null, branchFromStep: null, archived: false,
    } as TaskRun);
    await store.putHitl({
      id: `q-${id}`, workspaceId: DEFAULT_WORKSPACE, runId, kind: "diff", title: "Review", why: "", risk: "medium",
      raisedAt: 0, expiresAt: null, resolvedAt: null, resolution: null, command: null, options: null,
      recommended: null, steps: null, diff: null,
    } as HitlItem);
    await store.putTask({
      id, workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "do X", state: "review", runId,
      autoPick: false, assessment: null, reviewVerdict: null, lint: null, assignment: { mode: "any", agentIds: [] },
      ...taskOver,
    } as Task);
    provider.reply = reply;
    await orch.tickAutonomy();
  };

  const fleetTasks = async (store: any) =>
    (await store.listTasks(DEFAULT_WORKSPACE)).filter((t: Task) => t.projectId === "p1" && t.source?.kind === "fleet");

  it("today's behavior is unaffected — a new-scope proposal with NO brief still parks unscoped", async () => {
    const { store, orch, provider } = await setup();
    await store.putFeature(mkFeature());
    await reviewRound(
      store, orch, provider, { id: "t1", featureId: "f1" },
      '{"verdict":"approve","reason":"ok","proposals":[{"title":"Add a dark mode toggle","why":"an idea, unrelated to this change","scope":"new-scope"}]}',
    );
    const created = await fleetTasks(store);
    expect(created).toHaveLength(1);
    expect(created[0]!.state).toBe("backlog"); // still parked, not auto-promoted
    expect(created[0]!.autoPick).toBe(false);
    expect(created[0]!.featureId).toBeNull(); // no brief backs "f1" — unchanged from today
  });

  it("a new-scope (parked) proposal inherits the feature when a SolutionBrief backs it", async () => {
    const { store, orch, provider } = await setup();
    await store.putFeature(mkFeature());
    await store.putSolutionBrief(mkBrief({ id: "brief-1", projectId: "p1", featureId: "f1", status: "building" }));
    await reviewRound(
      store, orch, provider, { id: "t1", featureId: "f1" },
      '{"verdict":"approve","reason":"ok","proposals":[{"title":"Add a dark mode toggle","why":"an idea, unrelated to this change","scope":"new-scope"}]}',
    );
    const created = await fleetTasks(store);
    expect(created).toHaveLength(1);
    // Still lands in backlog for human/autonomy judgment — the brief-link
    // ATTACHES it to scope, it does NOT auto-promote (that's create-active's
    // job, gated on the placement resolver, untouched here).
    expect(created[0]!.state).toBe("backlog");
    expect(created[0]!.autoPick).toBe(false);
    expect(created[0]!.featureId).toBe("f1");
  });

  it("an in-scope proposal that already auto-promotes is unaffected by the brief link (still create-active's path)", async () => {
    const { store, orch, provider } = await setup();
    await store.putFeature(mkFeature());
    await store.putSolutionBrief(mkBrief({ id: "brief-1", projectId: "p1", featureId: "f1", status: "building" }));
    await reviewRound(
      store, orch, provider, { id: "t1", featureId: "f1" },
      '{"verdict":"approve","reason":"ok","proposals":[{"title":"Fix off-by-one in the paginator","why":"found while reviewing the diff","scope":"in-scope"}]}',
    );
    const created = await fleetTasks(store);
    expect(created).toHaveLength(1);
    expect(created[0]!.state).toBe("todo");
    expect(created[0]!.featureId).toBe("f1");
    expect(created[0]!.autoPick).toBe(true);
  });
});

// ─── 3. Threading + status transitions — real git harness ─────────────────

let Hub: typeof import("../apps/server/src/hub.js").Hub;
let Orchestrator: typeof import("../apps/server/src/orchestrator.js").Orchestrator;
let MemoryStore: typeof import("../apps/server/src/store/memory.js").MemoryStore;
let repo: string, worktreesDir: string;

const waitFor = async (pred: () => Promise<boolean> | boolean, ms = 8000) => {
  const dl = Date.now() + ms;
  while (Date.now() < dl) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("timeout");
};

class TwoTaskProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  specs: StartSpec[] = [];
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    this.specs.push(spec);
    writeFileSync(join(spec.cwd!, `${spec.runId}.txt`), `work for ${spec.runId}\n`);
    setTimeout(() => events.onCompleted(spec.runId, spec.branch), 0);
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "skynet-brief-repo-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "skynet-brief-wt-"));
  execFileSync("git", ["init", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@t.local"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "T"]);
  writeFileSync(join(repo, "README.md"), "# base\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-m", "base"]);
  process.env.STORE = "memory";
  process.env.BUS = "memory";
  process.env.SKYNET_INTEGRATION_REPO = repo;
  process.env.SKYNET_WORKTREES_DIR = worktreesDir;
  process.env.SKYNET_BASE_BRANCH = "main";
  delete process.env.RUNNER;
  ({ Hub } = await import("../apps/server/src/hub.js"));
  ({ Orchestrator } = await import("../apps/server/src/orchestrator.js"));
  ({ MemoryStore } = await import("../apps/server/src/store/memory.js"));
});
afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(worktreesDir, { recursive: true, force: true });
});

describe("S8: brief threading + status transitions (real git)", () => {
  async function runTaskToDone(store: any, orch: any, taskId: string, projectId: string): Promise<void> {
    await orch.assignTask(projectId, taskId);
    const findOpenDiff = async (): Promise<HitlItem | undefined> => {
      const task = await store.getTask(taskId);
      if (!task?.runId) return undefined;
      return (await store.listQueue(DEFAULT_WORKSPACE)).find((h: HitlItem) => h.kind === "diff" && h.runId === task.runId && !h.resolvedAt);
    };
    await waitFor(async () => (await findOpenDiff()) != null);
    const item = (await findOpenDiff())!;
    const resolution: Resolution = { action: "approve", optionIndex: null, guidance: null, targetBranch: null, memoryNote: null, by: "op-1", at: Date.now() };
    await orch.deliver(item, resolution);
    await waitFor(async () => (await store.getTask(taskId))?.state === "done");
  }

  const setup = async (provider: RunnerProvider) => {
    const store = new MemoryStore({ seed: false });
    const hub = new Hub(store, new NullBus());
    const orch = new Orchestrator(store, hub, provider);
    const project: Project = {
      id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [],
      status: "active", repoPath: repo, gitBacked: true, repo: null,
    } as Project;
    await store.putProject(project);
    await store.putAgent({ id: "a1", workspaceId: DEFAULT_WORKSPACE, name: "a1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
    const feature: Feature = {
      id: "f1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", name: "Rate limiting",
      description: null, status: "active", milestoneId: null, archived: false, createdAt: Date.now(), pr: null,
    };
    await store.putFeature(feature);
    return { store, hub, orch, project, feature };
  };

  it("threading: assignTask's StartSpec carries the approved brief's approach + acceptance criteria", async () => {
    const provider = new TwoTaskProvider();
    const { store, orch } = await setup(provider);
    const brief = mkBrief({ id: "brief-1", projectId: "p1", featureId: "f1", status: "approved" });
    await store.putSolutionBrief(brief);
    await store.putTask({ id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "add limiter middleware", state: "todo", runId: null, featureId: "f1" } as Task);

    await orch.assignTask("p1", "t1");

    expect(provider.specs).toHaveLength(1);
    const { task } = provider.specs[0]!;
    expect(task).toContain("=== SOLUTION BRIEF ===");
    expect(task).toContain("Add a token-bucket limiter middleware in front of every route.");
    expect(task).toContain("Acceptance criteria:");
    expect(task).toContain("429s returned once a client exceeds the bucket");
  });

  it("status: approved → building the moment the first child task leaves todo", async () => {
    const provider = new TwoTaskProvider();
    const { store, orch } = await setup(provider);
    const brief = mkBrief({ id: "brief-1", projectId: "p1", featureId: "f1", status: "approved" });
    await store.putSolutionBrief(brief);
    await store.putTask({ id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "add limiter middleware", state: "todo", runId: null, featureId: "f1" } as Task);

    await orch.assignTask("p1", "t1");

    expect((await store.getSolutionBrief("brief-1"))?.status).toBe("building");
  });

  it("status: starting a task from backlog (not todo) does not trigger the transition", async () => {
    const provider = new TwoTaskProvider();
    const { store, orch } = await setup(provider);
    const brief = mkBrief({ id: "brief-1", projectId: "p1", featureId: "f1", status: "approved" });
    await store.putSolutionBrief(brief);
    // Assigned straight from backlog (skipping todo) — a real path (e.g. a
    // human "Start now" on a backlog card with eligibility already set).
    await store.putTask({ id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "add limiter middleware", state: "backlog", runId: null, featureId: "f1" } as Task);

    await orch.assignTask("p1", "t1");

    expect((await store.getSolutionBrief("brief-1"))?.status).toBe("approved"); // unchanged — never left todo
  });

  it("status: leaving todo does NOT flip a brief that isn't 'approved' yet (e.g. still draft)", async () => {
    const provider = new TwoTaskProvider();
    const { store, orch } = await setup(provider);
    // Brief is still "draft" — never approved. A task under its feature
    // starting from todo must NOT jump it straight to "building".
    const brief = mkBrief({ id: "brief-1", projectId: "p1", featureId: "f1", status: "draft" });
    await store.putSolutionBrief(brief);
    await store.putTask({ id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "add limiter middleware", state: "todo", runId: null, featureId: "f1" } as Task);

    await orch.assignTask("p1", "t1");

    expect((await store.getSolutionBrief("brief-1"))?.status).toBe("draft");
  });

  it("status: building → done once every task under the feature completes", async () => {
    const provider = new TwoTaskProvider();
    const { store, orch } = await setup(provider);
    const brief = mkBrief({ id: "brief-1", projectId: "p1", featureId: "f1", status: "building" });
    await store.putSolutionBrief(brief);
    await store.putTask({ id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "add limiter middleware", state: "backlog", runId: null, featureId: "f1" } as Task);
    await store.putTask({ id: "t2", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "add limiter tests", state: "backlog", runId: null, featureId: "f1" } as Task);

    await runTaskToDone(store, orch, "t1", "p1");
    expect((await store.getSolutionBrief("brief-1"))?.status).toBe("building"); // t2 still open

    await runTaskToDone(store, orch, "t2", "p1");
    // checkFeatureCompletion runs AFTER completeMerged flips the task's own
    // state to "done" (still within the same awaited chain, but a task
    // reading "done" doesn't guarantee checkFeatureCompletion has finished
    // yet) — poll for the brief's own status rather than assuming it's
    // synchronous with the task-done observation above.
    await waitFor(async () => (await store.getSolutionBrief("brief-1"))?.status === "done");
  });

  it("manual override via update still works — an operator can set a brief's status directly regardless of automatic transitions", async () => {
    const provider = new TwoTaskProvider();
    const { store } = await setup(provider);
    const brief = mkBrief({ id: "brief-1", projectId: "p1", featureId: "f1", status: "approved" });
    await store.putSolutionBrief(brief);

    // A human jumps straight to "done" without any task ever running — the
    // automatic transitions never fight a direct write.
    await store.putSolutionBrief({ ...brief, status: "done" });
    expect((await store.getSolutionBrief("brief-1"))?.status).toBe("done");
  });
});
