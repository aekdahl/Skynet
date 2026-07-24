// Canonical full-loop guard (the v0 "testable loop" as a blocking CI gate).
//
// Drives the REAL orchestrator against a throwaway git repo with a scripted
// provider (no LLM, deterministic) and asserts every stage of the core loop the
// product promises:
//   assign → isolated worktree/branch → agent plans + produces a real diff →
//   diff-review HITL raised → approve → merged to the integration branch →
//   run + task reach done → the runner is freed back to idle.
//
// Other hermetic orchestration tests (merge, pipeline-task-done, review-modify)
// exercise slices of this; this one is the single explicit end-to-end assertion
// so a regression anywhere in the loop trips one obvious guard. No credentials,
// deterministic — safe as a PR gate (the REAL-LLM loop lives in evals/, nightly).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
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

// A deterministic stand-in for a real coding agent: emits a plan, writes one
// file into its own worktree, then completes. The orchestrator does the rest
// (raises the diff review, merges on approve) — that plumbing is what we guard.
class ScriptedProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  starts = 0;
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    this.starts++;
    const plan: PlanStep[] = [
      { title: "Read the task", state: "done" },
      { title: "Add the feature", state: "now" },
    ];
    events.onProgress(spec.runId, 0.5, plan);
    writeFileSync(join(spec.cwd!, "feature.txt"), "hello from the fleet\n");
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

const git = (...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
// Generous default: the merge stage runs real git worktree operations (scratch
// worktree add + merge + commit) that take ~8s on a busy machine — a 5s timeout
// flaked this stage intermittently. A genuine hang still fails (well under the
// 20s vitest testTimeout).
const waitFor = async (pred: () => Promise<boolean>, ms = 15_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not met in time");
};

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "skynet-loop-repo-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "skynet-loop-wt-"));
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

describe("full loop: assign → worktree → diff → approve → merge → done", () => {
  beforeEach(() => {
    git("checkout", "-f", "main");
    git("branch", "--list", "agent/*")
      .split("\n")
      .filter(Boolean)
      .forEach((b) => {
        try {
          git("branch", "-D", b.replace("*", "").trim());
        } catch {
          /* ignore */
        }
      });
  });

  it("runs the whole loop and frees the runner", async () => {
    const store = new MemoryStore({ seed: false });
    const hub = new Hub(store, new NullBus());
    const provider = new ScriptedProvider();
    const orchestrator = new Orchestrator(store, hub, provider);

    await store.putProject({ id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [], status: "active", repoPath: null, gitBacked: false } as Project);
    await store.putAgent({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
    await store.putTask({ id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "Add a feature file", state: "backlog", runId: null } as Task);

    const openDiff = async (): Promise<HitlItem | undefined> =>
      (await store.listQueue(DEFAULT_WORKSPACE)).find((q) => q.kind === "diff" && q.resolvedAt == null);
    const resolve = async (item: HitlItem, action: Resolution["action"]) => {
      const resolution: Resolution = { action, optionIndex: null, guidance: null, by: "test", at: Date.now() };
      const r = await hub.resolveHitl(item.id, resolution);
      if (r?.resolution?.at === resolution.at) await orchestrator.deliver(item, resolution);
    };

    // 1. Assign → a run spawns on its own agent/* branch, holding the runner.
    const run = await orchestrator.assignTask("p1", "t1");
    expect(run.branch).toMatch(/^agent\//);
    expect(run.agentId).toBe("r1");
    expect(provider.starts).toBe(1);
    expect((await store.getAgent("r1"))?.status).toBe("busy"); // runner acquired

    // 2. The agent plans + produces a REAL diff → a diff-review HITL is raised.
    await waitFor(openDiff);
    const live = (await store.getRun(run.id))!;
    expect(live.plan.length).toBeGreaterThan(0); // plan surfaced
    const diffOut = git("diff", `main...${live.branch}`);
    expect(diffOut).toContain("feature.txt"); // real change on the isolated branch
    expect(existsSync(join(worktreesDir, run.id, "feature.txt"))).toBe(true); // real worktree on disk

    // 3. Approve → merge to the integration branch → run + task done, runner freed.
    await resolve((await openDiff())!, "approve");
    await waitFor(async () => (await store.getRun(run.id))?.status === "done");

    expect(git("show", `skynet/integration/p1:feature.txt`)).toContain("hello from the fleet");
    const doneTask = (await store.listTasks(DEFAULT_WORKSPACE)).find((t) => t.id === "t1")!;
    expect(doneTask.state).toBe("done");
    expect((await store.getAgent("r1"))?.status).toBe("idle"); // runner released
  });
});
