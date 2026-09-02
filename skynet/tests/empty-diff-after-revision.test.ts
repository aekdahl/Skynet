// Regression guard: a review gate must never open for a finished run whose
// net diff against its base is empty (0+/0-, 0 files) — the exact symptom
// reported live (a "modify" revision that undid its own earlier change,
// still committed something real on this turn, and reopened a review with
// nothing in it to look at).
//
// The bug: `commitAll` only proves the worktree was dirty vs its OWN last
// commit, not vs the branch's `baseRef`. A revision that fully reverts an
// earlier turn's change commits that revert (a real commit object lands),
// but `diffStat(baseRef...HEAD)` comes back empty. The orchestrator used to
// gate review-raising on "did a commit land" instead of "is there anything
// left to show" — this file drives the real Orchestrator/Operations against
// a real throwaway git repo (same harness as force-review.test.ts /
// merge-conflict-ask-agent.test.ts) through exactly that sequence, on both
// the natural-completion path (`complete()`) and the operator-forced path
// (`forceReviewRun`).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { ProviderId, Project, Agent, Task, HitlItem, ServerEvent } from "@skynet/shared";
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

// Turn 1 adds a file — a real diff, a review gate raised as usual. Turn 2 (the
// "modify" revision, resumed on the SAME worktree/branch — see
// reviseAfterReview) deletes it again, landing the branch back on exactly its
// base tree. `stayLiveOnTurn2` picks which path exercises the bug: `false`
// drives complete()'s natural finish, `true` leaves the session running so the
// test can call forceReviewRun on it directly.
class RevertingProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  starts = 0;
  constructor(private readonly stayLiveOnTurn2: boolean) {}
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    this.starts++;
    if (this.starts === 1) {
      writeFileSync(join(spec.cwd!, "scratch.txt"), "temporary content\n");
      setTimeout(() => events.onCompleted(spec.runId, spec.branch), 0);
    } else {
      rmSync(join(spec.cwd!, "scratch.txt"));
      if (!this.stayLiveOnTurn2) setTimeout(() => events.onCompleted(spec.runId, spec.branch), 0);
    }
    return {
      runId: spec.runId,
      provider: this.id,
      async pause() {},
      async resume() {},
      async message() {},
      stop: async () => {},
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

const waitFor = async (pred: () => Promise<boolean>, ms = 8000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not met in time");
};

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "skynet-empty-diff-repo-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "skynet-empty-diff-wt-"));
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
  ({ Orchestrator, NothingToReviewError } = await import("../apps/server/src/orchestrator.js"));
  ({ Operations } = await import("../apps/server/src/operations.js"));
  ({ MemoryStore } = await import("../apps/server/src/store/memory.js"));
});
afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(worktreesDir, { recursive: true, force: true });
});

const setup = async (projectId: string, provider: RunnerProvider) => {
  const store = new MemoryStore({ seed: false });
  const bus = new RecordingBus();
  const hub = new Hub(store, bus);
  const orchestrator = new Orchestrator(store, hub, provider);
  const ops = new Operations({ store, hub, orchestrator });
  await store.putProject({ id: projectId, workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [], status: "active", repoPath: null, gitBacked: false } as Project);
  await store.putAgent({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
  await store.putTask({ id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId, text: "do work", state: "backlog", runId: null } as Task);
  const run = await orchestrator.assignTask(projectId, "t1");
  return { store, bus, ops, run };
};

const openDiff = async (store: InstanceType<typeof MemoryStore>) =>
  (await store.listQueue(DEFAULT_WORKSPACE)).find((q: HitlItem) => q.kind === "diff" && !q.resolvedAt);

describe("a revision that nets back to its base never opens an empty review gate", () => {
  it("natural completion: a second turn that fully reverts the first falls through to done, not a 0-file review", async () => {
    const provider = new RevertingProvider(false);
    const { store, bus, ops, run } = await setup("p-natural", provider);

    await waitFor(async () => !!(await openDiff(store)));
    const diff1 = (await openDiff(store))!;
    expect(diff1.diff?.files).toEqual(["scratch.txt"]);

    await ops.resolveHitl(DEFAULT_WORKSPACE, diff1.id, { action: "modify", guidance: "actually, undo that" }, "op-1");
    await waitFor(async () => provider.starts >= 2);

    // The revision turn reverted the file — the branch now matches `main`
    // exactly. That must NOT reopen a review with nothing in it; it should
    // fall through to the same no-diff completion path a genuine no-op gets.
    await waitFor(async () => (await store.getRun(run.id))?.status === "done");
    expect((await store.getTask("t1"))?.state).toBe("done");

    const allDiffHitls = (await store.listQueue(DEFAULT_WORKSPACE)).filter((q: HitlItem) => q.kind === "diff");
    expect(allDiffHitls).toHaveLength(1); // only the first turn's — never a second, empty one
    expect(bus.events.filter((e) => e.type === "hitl.raised" && e.item.kind === "diff")).toHaveLength(1);

    // The revert commit really landed (a real commit exists) — it's just that
    // there's nothing left in it to review against base.
    expect(git("diff", `main...${run.branch}`)).toBe("");
  });

  it("forceReview: pulling a live revision that already reverted everything throws NothingToReviewError and leaves the session live", async () => {
    const provider = new RevertingProvider(true);
    const { store, ops, run } = await setup("p-forced", provider);

    await waitFor(async () => !!(await openDiff(store)));
    const diff1 = (await openDiff(store))!;
    await ops.resolveHitl(DEFAULT_WORKSPACE, diff1.id, { action: "modify", guidance: "actually, undo that" }, "op-1");
    await waitFor(async () => provider.starts >= 2);
    await waitFor(async () => (await store.getRun(run.id))?.status === "running");

    await expect(ops.forceReview(DEFAULT_WORKSPACE, "t1")).rejects.toThrow(NothingToReviewError);

    // Nothing was torn down for an empty result: still running/ongoing, not
    // bounced into a review with nothing in it.
    expect((await store.getRun(run.id))?.status).not.toBe("review");
    expect((await store.getTask("t1"))?.state).toBe("ongoing");
    const openDiffHitls = (await store.listQueue(DEFAULT_WORKSPACE)).filter((q: HitlItem) => q.kind === "diff" && !q.resolvedAt);
    expect(openDiffHitls).toHaveLength(0); // the first turn's diff was already resolved (modify)
  });
});
