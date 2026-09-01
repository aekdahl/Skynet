// Orchestrator.mergeQueueSnapshot (Review & Merge, Phase 15) — the
// mode/reason composition on top of MergeEngine.queueFor's raw position data
// (queueFor itself is covered deterministically in merge.test.ts). Drives the
// REAL orchestrator against a throwaway git repo with a scripted provider, the
// same discipline as full-loop.test.ts, so this is the one place "does the
// merge-queue ENDPOINT's data actually match what a human/policy approval
// produced" is asserted end to end.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { ProviderId, Project, Agent, Task, Resolution, HitlItem, PlanStep } from "@skynet/shared";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";
import type { Bus } from "../apps/server/src/bus.js";

class NullBus implements Bus {
  publish(): void {}
  subscribe(): () => void {
    return () => {};
  }
}

// Writes a distinct file per run (named after the task text) — no collision,
// this test is only about the queue's mode/reason/position bookkeeping.
class ScriptedProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    const plan: PlanStep[] = [{ text: "Add the file", state: "now" }];
    events.onProgress(spec.runId, 0.5, plan);
    writeFileSync(join(spec.cwd!, `${spec.runId}.txt`), "hello\n");
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

const waitFor = async (pred: () => Promise<boolean> | boolean, ms = 15_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not met in time");
};

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "skynet-mq-repo-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "skynet-mq-wt-"));
  execFileSync("git", ["init", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@skynet.local"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
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

describe("Orchestrator.mergeQueueSnapshot", () => {
  it("reports real position + who/what approved each queued run, and drains once they land", async () => {
    const store = new MemoryStore({ seed: false });
    const hub = new Hub(store, new NullBus());
    const provider = new ScriptedProvider();
    const orchestrator = new Orchestrator(store, hub, provider);

    const project: Project = {
      id: "mq-project", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [], status: "active",
      repoPath: null, gitBacked: false,
      // Slow enough that both approvals land in the queue together, fast
      // enough the test doesn't crawl.
      checkCmd: "sleep 1",
    } as Project;
    await store.putProject(project);
    await store.putAgent({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
    await store.putAgent({ id: "r2", workspaceId: DEFAULT_WORKSPACE, name: "r2", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
    await store.putTask({ id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "mq-project", text: "Task one", state: "backlog", runId: null } as Task);
    await store.putTask({ id: "t2", workspaceId: DEFAULT_WORKSPACE, projectId: "mq-project", text: "Task two", state: "backlog", runId: null } as Task);

    const openDiffFor = async (runId: string): Promise<HitlItem | undefined> =>
      (await store.listQueue(DEFAULT_WORKSPACE)).find((q) => q.kind === "diff" && q.runId === runId && q.resolvedAt == null);
    const resolve = async (item: HitlItem, by: string) => {
      const resolution: Resolution = { action: "approve", optionIndex: null, guidance: null, targetBranch: null, memoryNote: null, resetWork: false, by, at: Date.now() };
      const r = await hub.resolveHitl(item.id, resolution);
      if (r?.resolution?.at === resolution.at) await orchestrator.deliver(item, resolution);
    };

    const runA = await orchestrator.assignTask("mq-project", "t1");
    const runB = await orchestrator.assignTask("mq-project", "t2");
    await waitFor(async () => !!(await openDiffFor(runA.id)));
    await waitFor(async () => !!(await openDiffFor(runB.id)));

    // A human approves the first, a policy approves the second — deliver()
    // records mergeApprovals right before enqueueing, so the queue snapshot
    // must reflect exactly this, not a re-derivation.
    await resolve((await openDiffFor(runA.id))!, "operator@example.com");
    await resolve((await openDiffFor(runB.id))!, "policy:evidence");

    const snapshot = orchestrator.mergeQueueSnapshot(project);
    expect(snapshot).toEqual([
      { runId: runA.id, position: 0, mode: "human", reason: null },
      { runId: runB.id, position: 1, mode: "auto", reason: "policy: low risk + green evidence merges itself." },
    ]);

    // Drains once both real merges (each gated by the 1s checkCmd) land. The
    // queue shift itself trails the run's status flip by a beat (process()'s
    // own worktree cleanup still has to finish first) — poll rather than
    // assert the instant both runs report done.
    await waitFor(async () => (await store.getRun(runA.id))?.status === "done" && (await store.getRun(runB.id))?.status === "done", 20_000);
    await waitFor(() => orchestrator.mergeQueueSnapshot(project).length === 0, 5_000);
  });

  it("returns an empty queue for a project nothing has ever been enqueued against", () => {
    const store = new MemoryStore({ seed: false });
    const hub = new Hub(store, new NullBus());
    const orchestrator = new Orchestrator(store, hub, new ScriptedProvider());
    const project: Project = { id: "never-queued", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [], status: "active", repoPath: null, gitBacked: false } as Project;
    expect(orchestrator.mergeQueueSnapshot(project)).toEqual([]);
    void hub;
  });
});
