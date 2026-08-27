// Force Done must make a task REALLY done, not just relabel the card: any
// real work sitting in the run's worktree — committed or not, live or not —
// has to land through the same commit + push/merge pipeline a normal Approve
// uses. Exercises Operations.forceTaskDone / Orchestrator.forceIntegrateRun
// against a real throwaway git repo (same harness as
// tests/guided-merge-orchestrator.test.ts), not a mocked git backend.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { ProviderId, Project, Agent, Task } from "@skynet/shared";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";
import type { Bus } from "../apps/server/src/bus.js";

class NullBus implements Bus { publish(): void {} subscribe(): () => void { return () => {}; } }

// Writes a file into the worktree and then just... sits there. Never calls
// onCompleted — simulates a still-live, mid-turn agent whose edits are real
// but uncommitted, which is exactly the state Force Done has to rescue.
class StaysLiveProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  stopped = false;
  async start(spec: StartSpec, _events: RunnerEvents): Promise<RunnerHandle> {
    writeFileSync(join(spec.cwd!, "wip.txt"), "uncommitted work\n");
    return {
      runId: spec.runId, provider: this.id,
      async pause() {}, async resume() {}, async message() {},
      stop: async () => { this.stopped = true; },
    };
  }
}

// Completes normally (raises the diff HITL) so forceTaskDone's
// find-open-gate-and-approve branch has something to find.
class CompletesProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    writeFileSync(join(spec.cwd!, "done.txt"), "finished work\n");
    setTimeout(() => events.onCompleted(spec.runId, spec.branch), 0);
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

// Stays live (like StaysLiveProvider) but supports `consult` — so
// forceIntegrateRun's completeness check has a real reply to read. Returns
// the SAME verdict for every call whose question asks "does this satisfy
// the task" (the completeness check); anything else (the diff walkthrough /
// merge brief drafts that fire once raiseDiffReview raises the gate) gets an
// empty object, which those best-effort drafters already tolerate as "no
// draft" — not what these tests are covering.
class JudgingLiveProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  stopped = false;
  constructor(private verdict: string, private fileName = "half-done.txt") {}
  async start(spec: StartSpec, _events: RunnerEvents): Promise<RunnerHandle> {
    writeFileSync(join(spec.cwd!, this.fileName), "partial work\n");
    return {
      runId: spec.runId, provider: this.id,
      async pause() {}, async resume() {}, async message() {},
      stop: async () => { this.stopped = true; },
    };
  }
  consult = async (_spec: unknown, question: string): Promise<string> =>
    /Review whether this run satisfies/.test(question) ? this.verdict : "{}";
}

let Hub: typeof import("../apps/server/src/hub.js").Hub;
let Orchestrator: typeof import("../apps/server/src/orchestrator.js").Orchestrator;
let Operations: typeof import("../apps/server/src/operations.js").Operations;
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
  repo = mkdtempSync(join(tmpdir(), "skynet-fd-repo-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "skynet-fd-wt-"));
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
  ({ Operations } = await import("../apps/server/src/operations.js"));
  ({ MemoryStore } = await import("../apps/server/src/store/memory.js"));
});
afterAll(() => { rmSync(repo, { recursive: true, force: true }); rmSync(worktreesDir, { recursive: true, force: true }); });

const setup = async (provider: RunnerProvider, projectId: string) => {
  const store = new MemoryStore({ seed: false });
  const hub = new Hub(store, new NullBus());
  const orchestrator = new Orchestrator(store, hub, provider);
  const ops = new Operations({ store, hub, orchestrator });
  await store.putProject({ id: projectId, workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [], status: "active", repoPath: null, gitBacked: false } as Project);
  await store.putAgent({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
  await store.putTask({ id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId, text: "do work", state: "backlog", runId: null } as Task);
  const run = await orchestrator.assignTask(projectId, "t1");
  return { store, hub, orchestrator, ops, run };
};

describe("forceTaskDone — a still-LIVE run's uncommitted work really lands", () => {
  it("commits the worktree, frees the runner, and merges the branch through the local queue — task actually finishes done", async () => {
    const provider = new StaysLiveProvider();
    const { store, ops, run } = await setup(provider, "p-live");

    // Sanity: the run is genuinely live and the task is "ongoing" with real,
    // uncommitted work sitting in its worktree — not yet reviewed, no gate.
    expect((await store.getTask("t1"))?.state).toBe("ongoing");
    expect((await store.listQueue(DEFAULT_WORKSPACE)).filter((h) => !h.resolvedAt)).toHaveLength(0);

    await ops.forceTaskDone(DEFAULT_WORKSPACE, "t1", "op-1");

    // The runner was stopped as part of detaching the live run.
    await waitFor(async () => provider.stopped);
    // The merge queue is async — the branch lands on the project's default
    // integration branch, and the task genuinely finishes "done" once it does.
    await waitFor(async () => {
      try { git("cat-file", "-e", "skynet/integration/p-live:wip.txt"); return true; } catch { return false; }
    });
    expect(git("cat-file", "-t", "skynet/integration/p-live:wip.txt")).toBe("blob");
    await waitFor(async () => (await store.getTask("t1"))?.state === "done");
    expect((await store.getRun(run.id))?.status).toBe("done");
  });
});

describe("forceTaskDone — an open diff gate gets approved, not bypassed", () => {
  it("routes through the same approve path as a normal Approve click", async () => {
    const provider = new CompletesProvider();
    const { store, ops } = await setup(provider, "p-gated");

    const openDiff = async () => (await store.listQueue(DEFAULT_WORKSPACE)).find((h) => h.kind === "diff" && !h.resolvedAt);
    await waitFor(async () => !!(await openDiff()));

    await ops.forceTaskDone(DEFAULT_WORKSPACE, "t1", "op-1");

    await waitFor(async () => {
      try { git("cat-file", "-e", "skynet/integration/p-gated:done.txt"); return true; } catch { return false; }
    });
    expect(git("cat-file", "-t", "skynet/integration/p-gated:done.txt")).toBe("blob");
    await waitFor(async () => (await store.getTask("t1"))?.state === "done");
    expect((await openDiff())).toBeUndefined(); // the gate got resolved, not skipped
  });
});

// Skipping the normal review gate shouldn't also skip judgment: with no open
// HITL to approve, forceIntegrateRun runs its own "does this satisfy the
// task" consult before pushing. These pin both outcomes.
describe("forceTaskDone — completeness check gates the push", () => {
  it("a FLAG verdict holds back the push and raises a real diff review instead — the review IS the notification", async () => {
    const provider = new JudgingLiveProvider('{"verdict":"flag","reason":"Missing tests for the new endpoint."}', "half-done.txt");
    const { store, ops, run } = await setup(provider, "p-incomplete");

    await ops.forceTaskDone(DEFAULT_WORKSPACE, "t1", "op-1");
    await waitFor(async () => provider.stopped); // the session still gets stopped — the work is real, just held back

    const t = await store.getTask("t1");
    expect(t?.state).toBe("review"); // NOT done
    expect(t?.reviewVerdict).toMatchObject({ decision: "flag", reason: "Missing tests for the new endpoint." });

    const openDiff = (await store.listQueue(DEFAULT_WORKSPACE)).find(
      (h) => h.runId === run.id && h.kind === "diff" && !h.resolvedAt,
    );
    expect(openDiff).toBeDefined(); // a real, actionable Approve/Reject/Modify gate
    expect(openDiff?.diff?.files).toContain("half-done.txt");

    // Never reached the integration branch.
    expect(() => git("cat-file", "-e", "skynet/integration/p-incomplete:half-done.txt")).toThrow();
  });

  it("an APPROVE verdict still pushes through exactly as before", async () => {
    const provider = new JudgingLiveProvider('{"verdict":"approve","reason":"Looks complete."}', "all-done.txt");
    const { store, ops } = await setup(provider, "p-complete-judge");

    await ops.forceTaskDone(DEFAULT_WORKSPACE, "t1", "op-1");

    await waitFor(async () => {
      try { git("cat-file", "-e", "skynet/integration/p-complete-judge:all-done.txt"); return true; } catch { return false; }
    });
    await waitFor(async () => (await store.getTask("t1"))?.state === "done");
  });
});
