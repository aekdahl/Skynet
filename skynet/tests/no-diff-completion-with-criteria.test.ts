// Regression guard: a run that completes with NO diff must not be trusted as
// "genuinely done" when its task carries explicit acceptance criteria (a linked
// SolutionBrief's `acceptanceCriteria`) — an agent deciding "nothing needs to
// change" is exactly the failure mode where a task gets silently closed without
// ever checking that self-report against what was actually asked for. Such a
// completion now routes to "review" (needs a confirming look) instead of the
// ordinary Phase-0 "done" a real no-op task gets.
//
// A task with no linked brief (or a brief with no criteria) keeps the original
// behavior — already covered by agent-completion-integrity.test.ts's "an agent
// that makes no change still completes as 'done'" — so this file only covers
// the new branch, using the same throwaway-repo harness as brief-threading.test.ts.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { Agent, Feature, Project, ProviderId, ServerEvent, SolutionBrief, Task } from "@skynet/shared";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";
import type { Bus } from "../apps/server/src/bus.js";

class RecordingBus implements Bus {
  events: ServerEvent[] = [];
  publish(_ws: string, event: ServerEvent): void {
    this.events.push(event);
  }
  subscribe(): () => void {
    return () => {};
  }
}

// Never touches the worktree — the same "genuine no-op" shape a real agent
// reports when it concluded (rightly or wrongly) that nothing needs to change.
class NoOpProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    setTimeout(() => events.onCompleted(spec.runId, spec.branch), 0);
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

const mkBrief = (over: Partial<SolutionBrief> = {}): SolutionBrief => ({
  id: "brief-1",
  workspaceId: DEFAULT_WORKSPACE,
  projectId: "p1",
  title: "Repo-optional mode",
  problem: "Every project resolves a repo one way or another.",
  approach: "Skip WorktreeProvisioner and MergeEngine entirely for repo-optional projects.",
  optionsConsidered: [],
  risks: [],
  acceptanceCriteria: ["No git/worktree/branch terminology appears in the UI", "No git binary is invoked"],
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

let Hub: typeof import("../apps/server/src/hub.js").Hub;
let Orchestrator: typeof import("../apps/server/src/orchestrator.js").Orchestrator;
let MemoryStore: typeof import("../apps/server/src/store/memory.js").MemoryStore;
let repo: string, worktreesDir: string;

const git = (...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const waitFor = async (pred: () => Promise<boolean>, ms = 5000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await pred()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error("condition not met in time");
};

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "skynet-nodiff-criteria-repo-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "skynet-nodiff-criteria-wt-"));
  execFileSync("git", ["init", "-b", "main", repo]);
  git("config", "user.email", "test@skynet.local");
  git("config", "user.name", "Test");
  writeFileSync(join(repo, "README.md"), "# base\n");
  git("add", "-A");
  git("commit", "-m", "base");
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

describe("a zero-diff completion against explicit acceptance criteria needs confirmation, not a silent 'done'", () => {
  beforeEach(() => {
    git("checkout", "-f", "main");
    git("branch", "--list", "agent/*").split("\n").filter(Boolean)
      .forEach((b) => { try { git("branch", "-D", b.replace("*", "").trim()); } catch { /* ignore */ } });
  });

  it("routes to 'review' (not 'done') when the task's brief has acceptance criteria", async () => {
    const store = new MemoryStore({ seed: false });
    const bus = new RecordingBus();
    const hub = new Hub(store, bus);
    const provider = new NoOpProvider();
    const orch = new Orchestrator(store, hub, provider);

    const project: Project = { id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [], status: "active", repoPath: null, gitBacked: false } as Project;
    await store.putProject(project);
    await store.putAgent({ id: "a1", workspaceId: DEFAULT_WORKSPACE, name: "a1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
    const feature: Feature = {
      id: "f1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", name: "Repo-optional mode",
      description: null, status: "active", milestoneId: null, archived: false, createdAt: Date.now(), pr: null,
    };
    await store.putFeature(feature);
    await store.putSolutionBrief(mkBrief());
    await store.putTask({ id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "make projects repo-optional", state: "backlog", runId: null, featureId: "f1" } as Task);

    const run = await orch.assignTask("p1", "t1");
    await waitFor(async () => (await store.getRun(run.id))?.status === "review");

    const after = await store.getRun(run.id);
    expect(after?.status).toBe("review"); // NOT "done" — needs confirmation
    expect((await store.getTask("t1"))?.state).toBe("review");
    // No spurious diff review — there's genuinely nothing to merge, just a
    // completion claim that needs a confirming look.
    expect(bus.events.some((e) => e.type === "hitl.raised" && e.item.kind === "diff")).toBe(false);
    expect(bus.events.some((e) => e.type === "run.completed")).toBe(false);
    expect(bus.events.some((e) => e.type === "run.log" && e.line.includes("acceptance criter"))).toBe(true);
  });

  it("still completes as 'done' when the task's brief has NO acceptance criteria", async () => {
    const store = new MemoryStore({ seed: false });
    const bus = new RecordingBus();
    const hub = new Hub(store, bus);
    const provider = new NoOpProvider();
    const orch = new Orchestrator(store, hub, provider);

    const project: Project = { id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [], status: "active", repoPath: null, gitBacked: false } as Project;
    await store.putProject(project);
    await store.putAgent({ id: "a1", workspaceId: DEFAULT_WORKSPACE, name: "a1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
    const feature: Feature = {
      id: "f1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", name: "Repo-optional mode",
      description: null, status: "active", milestoneId: null, archived: false, createdAt: Date.now(), pr: null,
    };
    await store.putFeature(feature);
    await store.putSolutionBrief(mkBrief({ acceptanceCriteria: [] }));
    await store.putTask({ id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "make projects repo-optional", state: "backlog", runId: null, featureId: "f1" } as Task);

    const run = await orch.assignTask("p1", "t1");
    await waitFor(async () => (await store.getRun(run.id))?.status === "done");

    expect((await store.getRun(run.id))?.status).toBe("done");
    expect((await store.getTask("t1"))?.state).toBe("done");
  });
});
