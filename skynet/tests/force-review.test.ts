// Manual "Force to review" — pull a still-`ongoing` task's live run up for
// review right now, instead of waiting for the agent to finish its own turn.
// Runs the exact same commit -> diff -> raiseDiffReview path complete() runs
// on a natural finish. Drives the real Orchestrator/Operations against a real
// throwaway git repo (same harness as diff-review-requires-human.test.ts),
// not a mocked git backend.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { ProviderId, Project, Agent, Task, HitlItem } from "@skynet/shared";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";
import type { Bus } from "../apps/server/src/bus.js";

class NullBus implements Bus {
  publish(): void {}
  subscribe(): () => void { return () => {}; }
}

// Stays live indefinitely — never calls onCompleted — so a test can force it
// to review mid-turn. `writeFile` toggles whether it produces any change,
// covering both the "real work" and "nothing yet" cases.
class StaysLiveProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  stopped = false;
  constructor(private readonly writeFile: boolean) {}
  async start(spec: StartSpec, _events: RunnerEvents): Promise<RunnerHandle> {
    if (this.writeFile) writeFileSync(join(spec.cwd!, "wip.txt"), "in-progress work\n");
    return {
      runId: spec.runId, provider: this.id,
      async pause() {}, async resume() {}, async message() {},
      stop: async () => { this.stopped = true; },
    };
  }
}

let Hub: typeof import("../apps/server/src/hub.js").Hub;
let Orchestrator: typeof import("../apps/server/src/orchestrator.js").Orchestrator;
let NothingToReviewError: typeof import("../apps/server/src/orchestrator.js").NothingToReviewError;
let Operations: typeof import("../apps/server/src/operations.js").Operations;
let MemoryStore: typeof import("../apps/server/src/store/memory.js").MemoryStore;
let repo: string, worktreesDir: string;

const git = (...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "skynet-fr-repo-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "skynet-fr-wt-"));
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
  ({ Orchestrator, NothingToReviewError } = await import("../apps/server/src/orchestrator.js"));
  ({ Operations } = await import("../apps/server/src/operations.js"));
  ({ MemoryStore } = await import("../apps/server/src/store/memory.js"));
});
afterAll(() => { rmSync(repo, { recursive: true, force: true }); rmSync(worktreesDir, { recursive: true, force: true }); });

const setup = async (projectId: string, provider: RunnerProvider) => {
  const store = new MemoryStore({ seed: false });
  const hub = new Hub(store, new NullBus());
  const orchestrator = new Orchestrator(store, hub, provider);
  const ops = new Operations({ store, hub, orchestrator });
  await store.putProject({ id: projectId, workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [], status: "active", repoPath: null, gitBacked: false } as Project);
  await store.putAgent({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
  await store.putTask({ id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId, text: "do work", state: "backlog", runId: null } as Task);
  const run = await orchestrator.assignTask(projectId, "t1");
  return { store, orchestrator, ops, run };
};

describe("forceReview — a still-live ongoing task", () => {
  it("commits the worktree, stops the session, and raises a real diff review — the task moves to review", async () => {
    const provider = new StaysLiveProvider(true);
    const { store, ops, run } = await setup("p-live", provider);

    expect((await store.getTask("t1"))?.state).toBe("ongoing");

    await ops.forceReview(DEFAULT_WORKSPACE, "t1");

    expect(provider.stopped).toBe(true); // dead session torn down
    expect((await store.getAgent("r1"))?.status).toBe("idle"); // runner freed
    expect((await store.getRun(run.id))?.status).toBe("review");
    expect((await store.getTask("t1"))?.state).toBe("review");

    const diff = (await store.listQueue(DEFAULT_WORKSPACE)).find((q: HitlItem) => q.kind === "diff" && !q.resolvedAt);
    expect(diff).toBeDefined();
    expect(diff?.diff?.files).toEqual(["wip.txt"]);

    // The commit really landed on the branch, not just recorded in the HITL.
    expect(git("cat-file", "-t", `${run.branch}:wip.txt`)).toBe("blob");
  });

  it("throws NothingToReviewError and leaves the session running when nothing has changed yet", async () => {
    const provider = new StaysLiveProvider(false); // no file written — clean worktree
    const { store, ops, run } = await setup("p-empty", provider);

    await expect(ops.forceReview(DEFAULT_WORKSPACE, "t1")).rejects.toThrow(NothingToReviewError);

    // Commit-before-stop: nothing to show means nothing gets torn down —
    // real in-progress work (if any existed) would never be killed for
    // nothing. The task/run are untouched, still genuinely ongoing/live.
    expect(provider.stopped).toBe(false);
    expect((await store.getTask("t1"))?.state).toBe("ongoing");
    expect((await store.getRun(run.id))?.status).not.toBe("review");
  });

  it("throws NothingToReviewError for a task that's not ongoing (never even reaches the orchestrator)", async () => {
    const store = new MemoryStore({ seed: false });
    const hub = new Hub(store, new NullBus());
    const orchestrator = new Orchestrator(store, hub, new StaysLiveProvider(true));
    const ops = new Operations({ store, hub, orchestrator });
    await store.putProject({ id: "p-todo", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [], status: "active", repoPath: null, gitBacked: false } as Project);
    await store.putTask({ id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p-todo", text: "not started yet", state: "todo", runId: null } as Task);

    await expect(ops.forceReview(DEFAULT_WORKSPACE, "t1")).rejects.toThrow(NothingToReviewError);
  });
});
