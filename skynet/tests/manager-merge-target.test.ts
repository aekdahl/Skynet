// A worker spawned under a manager (Orchestrator.spawnWorker) merges into its
// MANAGER's branch first, not the project's default integration branch —
// agent-hierarchy.md §5, generalizing the "a fork merges into its parent
// first" rule one tier up. Covers both what the diff HITL tells the operator
// (`defaultTargetBranch`) and where an unmodified "Approve" actually lands, on
// the LOCAL merge queue (no GitHub connection) — the path
// resolveMergeTarget/mergeTargetBranchFor's own tests don't exercise, since
// those are pure-function unit tests, not a real merge.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { ProviderId, Project, Agent, Task, HitlItem, Resolution } from "@skynet/shared";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";
import type { Bus } from "../apps/server/src/bus.js";

class NullBus implements Bus { publish(): void {} subscribe(): () => void { return () => {}; } }

// The manager's own run just sits there (no file writes, never completes on
// its own); a spawned worker (StartSpec.parentId set) writes one file then
// reports done — same shape as guided-merge-orchestrator.test.ts's
// EditOnceProvider, just scoped to worker-only runs.
class ManagerAndWorkerProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    if (spec.parentId) {
      writeFileSync(join(spec.cwd!, "reconcile.txt"), "done\n");
      setTimeout(() => events.onCompleted(spec.runId, spec.branch), 0);
    }
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

let Hub: typeof import("../apps/server/src/hub.js").Hub;
let Orchestrator: typeof import("../apps/server/src/orchestrator.js").Orchestrator;
let MemoryStore: typeof import("../apps/server/src/store/memory.js").MemoryStore;
let repo: string, worktreesDir: string;

const git = (...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

const waitFor = async (pred: () => Promise<boolean>, ms = 8000) => {
  const dl = Date.now() + ms;
  while (Date.now() < dl) { if (await pred()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error("timeout");
};

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "skynet-mgr-merge-repo-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "skynet-mgr-merge-wt-"));
  execFileSync("git", ["init", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@t.local"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "T"]);
  writeFileSync(join(repo, "README.md"), "# base\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-m", "base"]);
  process.env.STORE = "memory"; process.env.BUS = "memory";
  process.env.SKYNET_INTEGRATION_REPO = repo; process.env.SKYNET_WORKTREES_DIR = worktreesDir;
  process.env.SKYNET_BASE_BRANCH = "main"; delete process.env.RUNNER;
  ({ Hub } = await import("../apps/server/src/hub.js"));
  ({ Orchestrator } = await import("../apps/server/src/orchestrator.js"));
  ({ MemoryStore } = await import("../apps/server/src/store/memory.js"));
});
afterAll(() => { rmSync(repo, { recursive: true, force: true }); rmSync(worktreesDir, { recursive: true, force: true }); });

describe("a spawnWorker'd worker merges into its manager's branch first (agent-hierarchy.md §5, local merge queue)", () => {
  it("the diff HITL's default target branch is the manager's branch, and approving lands there — not the project's integration branch", async () => {
    const store = new MemoryStore({ seed: false });
    const hub = new Hub(store, new NullBus());
    const provider = new ManagerAndWorkerProvider();
    const orchestrator = new Orchestrator(store, hub, provider);
    const pid = "p-mgr-merge";
    await store.putProject({ id: pid, workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [], status: "active", repoPath: null, gitBacked: false } as Project);
    await store.putAgent({ id: "mgr-a", workspaceId: DEFAULT_WORKSPACE, name: "mgr-a", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0, role: "manager" } as Agent);
    await store.putAgent({ id: "wkr-a", workspaceId: DEFAULT_WORKSPACE, name: "wkr-a", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0, role: "worker" } as Agent);
    await store.putTask({ id: "t-mgr", workspaceId: DEFAULT_WORKSPACE, projectId: pid, text: "own billing", state: "backlog", runId: null } as Task);

    const manager = await orchestrator.assignTask(pid, "t-mgr", { role: "manager", area: [] });
    const worker = await orchestrator.spawnWorker(manager.id, "reconcile webhooks", []);

    const openDiff = async (): Promise<HitlItem | undefined> =>
      (await store.listQueue(DEFAULT_WORKSPACE)).find((q) => q.runId === worker.id && q.kind === "diff" && q.resolvedAt == null);
    await waitFor(async () => (await openDiff()) != null);
    const item = (await openDiff())!;

    // What the operator sees on the card matches where an unmodified Approve
    // actually goes — the manager's own branch, not skynet/integration/<pid>.
    expect(item.diff?.defaultTargetBranch).toBe(manager.branch);

    const resolution: Resolution = { action: "approve", optionIndex: null, guidance: null, targetBranch: null, memoryNote: null, resetWork: false, by: "op-1", at: Date.now() };
    await orchestrator.deliver(item, resolution);
    await waitFor(async () => {
      try { git("cat-file", "-e", `${manager.branch}:reconcile.txt`); return true; } catch { return false; }
    });

    expect(git("cat-file", "-t", `${manager.branch}:reconcile.txt`)).toBe("blob");
    // The project's plain integration branch was never touched by this merge.
    expect(git("branch", "--list", `skynet/integration/${pid}`)).toBe("");
  });
});
