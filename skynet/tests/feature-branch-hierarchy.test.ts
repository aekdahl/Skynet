// Feature-branch hierarchy (ROADMAP: group a Feature's tasks under a feature
// branch first, merge/test as a unit, only THEN merge that branch up into the
// project base). Drives the real Orchestrator against a throwaway git repo:
// two sibling tasks under one Feature must land on `skynet/feature/<id>`, not
// the project integration branch; once both are done, an auto-raised
// `feature-merge` HITL gates the Feature branch merging into the project base;
// a task with no Feature is unaffected (still targets the integration branch).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { ProviderId, Project, Agent, Task, Feature, HitlItem, PlanStep, Resolution } from "@skynet/shared";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";
import type { Bus } from "../apps/server/src/bus.js";

class NullBus implements Bus {
  publish(): void {}
  subscribe(): () => void {
    return () => {};
  }
}

// Writes one file (named after the run) into the worktree, then completes —
// a real commit lands on the run's branch for the merge queue to integrate.
class ScriptedProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    const plan: PlanStep[] = [{ title: "Do the thing", state: "now" }];
    events.onProgress(spec.runId, 0.5, plan);
    writeFileSync(join(spec.cwd!, `${spec.runId}.ts`), `export const ${spec.runId.replace(/-/g, "_")} = 1;\n`);
    setTimeout(() => events.onCompleted(spec.runId, spec.branch), 0);
    return {
      runId: spec.runId,
      provider: this.id,
      async pause() {},
      async resume() {},
      async message() {},
      async stop() {},
    };
  }
}

let Hub: typeof import("../apps/server/src/hub.js").Hub;
let Orchestrator: typeof import("../apps/server/src/orchestrator.js").Orchestrator;
let MemoryStore: typeof import("../apps/server/src/store/memory.js").MemoryStore;
let repo: string, worktreesDir: string;

const g = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: ["ignore", "pipe", "pipe"] }).toString();

const waitFor = async (pred: () => Promise<boolean>, ms = 5000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not met in time");
};

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "skynet-fbh-repo-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "skynet-fbh-wt-"));
  execFileSync("git", ["init", "-b", "main", repo]);
  g("config", "user.email", "test@skynet.local");
  g("config", "user.name", "Test");
  writeFileSync(join(repo, "README.md"), "# base\n");
  g("add", "-A");
  g("commit", "-m", "base");

  process.env.STORE = "memory";
  process.env.BUS = "memory";
  process.env.SKYNET_WORKTREES_DIR = worktreesDir;
  process.env.SKYNET_BASE_BRANCH = "main";
  delete process.env.RUNNER;
  ({ Hub } = await import("../apps/server/src/hub.js"));
  ({ Orchestrator } = await import("../apps/server/src/orchestrator.js"));
  ({ MemoryStore } = await import("../apps/server/src/store/memory.js"));
});
afterAll(() => {
  for (const d of [repo, worktreesDir]) rmSync(d, { recursive: true, force: true });
});

const mkProject = (id: string): Project =>
  ({ id, workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [], status: "active", repoPath: repo, gitBacked: true, repo: null } as Project);
const mkAgent = (id: string): Agent =>
  ({ id, workspaceId: DEFAULT_WORKSPACE, name: id, provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
const mkTask = (over: Partial<Task>): Task =>
  ({ id: "t", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "do it", state: "backlog", runId: null, featureId: null, ...over } as Task);

const approveOpenDiff = async (store: InstanceType<typeof MemoryStore>, orch: InstanceType<typeof Orchestrator>): Promise<void> => {
  const item = (await store.listQueue(DEFAULT_WORKSPACE)).find((q) => q.kind === "diff" && q.resolvedAt == null)!;
  const resolution: Resolution = { action: "approve", optionIndex: null, guidance: null, by: "test", at: Date.now() };
  await store.putHitl({ ...item, resolvedAt: resolution.at, resolution });
  await orch.deliver(item, resolution);
};

const waitMergedInto = (branch: string, file: string) =>
  waitFor(async () => {
    try {
      g("cat-file", "-e", `${branch}:${file}`);
      return true;
    } catch {
      return false;
    }
  });

describe("Feature-branch hierarchy", () => {
  it("groups sibling tasks under the Feature's branch, then gates the merge-up into the project base", async () => {
    const store = new MemoryStore({ seed: false });
    const hub = new Hub(store, new NullBus());
    const orch = new Orchestrator(store, hub, new ScriptedProvider());

    await store.putProject(mkProject("p1"));
    await store.putAgent(mkAgent("r1"));
    await store.putFeature({
      id: "feat-onb", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", name: "Onboarding",
      description: null, status: "active", milestoneId: null, archived: false, createdAt: Date.now(),
    } as Feature);
    await store.putTask(mkTask({ id: "t1", text: "task one", featureId: "feat-onb" }));
    await store.putTask(mkTask({ id: "t2", text: "task two", featureId: "feat-onb" }));

    // Task 1: assign → completes → diff HITL → approve → merges into the
    // Feature branch (never the project integration branch). The run id (thus
    // the filename ScriptedProvider writes) is whatever the orchestrator mints.
    const run1 = await orch.assignTask("p1", "t1");
    await waitFor(async () => (await store.listQueue(DEFAULT_WORKSPACE)).some((q) => q.kind === "diff" && q.resolvedAt == null));
    await approveOpenDiff(store, orch);
    const file1 = `${run1.id}.ts`;
    // completeMerged runs its store writes AFTER the git merge lands, so wait on
    // the task's own state (not just the git ref) to avoid a check-before-settle race.
    await waitFor(async () => (await store.getTask("t1"))?.state === "done");
    await waitMergedInto("skynet/feature/feat-onb", file1);
    expect(g("branch", "--list", "skynet/integration/p1").trim()).toBe(""); // never created

    // No feature-merge gate yet — t2 isn't done.
    expect((await store.listQueue(DEFAULT_WORKSPACE)).some((q) => q.kind === "feature-merge")).toBe(false);

    // Task 2: same flow — the (now freed) runner picks it up.
    const run2 = await orch.assignTask("p1", "t2");
    await waitFor(async () => (await store.listQueue(DEFAULT_WORKSPACE)).some((q) => q.kind === "diff" && q.resolvedAt == null));
    await approveOpenDiff(store, orch);
    const file2 = `${run2.id}.ts`;
    await waitFor(async () => (await store.getTask("t2"))?.state === "done");
    await waitMergedInto("skynet/feature/feat-onb", file2);

    // Both tasks under the Feature are now done → the stage-2 gate auto-raises.
    await waitFor(async () => (await store.listQueue(DEFAULT_WORKSPACE)).some((q) => q.kind === "feature-merge" && q.resolvedAt == null));
    const gate = (await store.listQueue(DEFAULT_WORKSPACE)).find((q) => q.kind === "feature-merge" && q.resolvedAt == null)!;
    expect(gate.runId).toBe("feature-feat-onb");
    expect(gate.diff?.files.sort()).toEqual([file1, file2].sort());

    // Approving it merges the Feature branch into the project base (main) —
    // still without ever touching a project integration branch.
    const resolution: Resolution = { action: "approve", optionIndex: null, guidance: null, by: "test", at: Date.now() };
    await store.putHitl({ ...gate, resolvedAt: resolution.at, resolution });
    await orch.deliver(gate, resolution);
    await waitMergedInto("main", file1);
    await waitMergedInto("main", file2);
    expect(g("branch", "--list", "skynet/integration/p1").trim()).toBe(""); // still never created
  }, 20000);

  it("a task with no Feature is unaffected — still merges to the project integration branch", async () => {
    const store = new MemoryStore({ seed: false });
    const hub = new Hub(store, new NullBus());
    const orch = new Orchestrator(store, hub, new ScriptedProvider());

    await store.putProject(mkProject("p2"));
    await store.putAgent(mkAgent("r2"));
    await store.putTask(mkTask({ id: "t3", text: "task three", projectId: "p2", runId: null }));

    const run3 = await orch.assignTask("p2", "t3");
    await waitFor(async () => (await store.listQueue(DEFAULT_WORKSPACE)).some((q) => q.kind === "diff" && q.resolvedAt == null));
    await approveOpenDiff(store, orch);
    await waitFor(async () => (await store.getTask("t3"))?.state === "done");
    await waitMergedInto("skynet/integration/p2", `${run3.id}.ts`);

    expect((await store.listQueue(DEFAULT_WORKSPACE)).some((q) => q.kind === "feature-merge")).toBe(false);
  }, 20000);
});
