// Merge engine: the serialized merge queue integrates agent branches one at a
// time per project integration branch (VCS brief §5–6). Drive it against real
// throwaway git repos and assert the three outcomes: clean merge, textual
// conflict (escalated with the contested files), and post-merge check failure
// (merge commit rolled back, bounced to the agent).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MergeEngine, type MergeCallbacks, type MergeRequest } from "../apps/server/src/merge.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@skynet.local",
  GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@skynet.local",
};

let repo: string;
// Capture stdout; keep git's chatty stderr ("Switched to branch …") out of the
// test log. Non-zero exits still throw (so .toThrow() assertions work).
const git = (...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] }).toString();
const commit = (file: string, content: string, msg: string) => {
  writeFileSync(join(repo, file), content);
  git("add", "-A");
  git("commit", "-m", msg);
};

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "skynet-merge-"));
  execFileSync("git", ["init", "-b", "main", repo], { env: GIT_ENV });
  // Repo-local identity so the MergeEngine's *own* git commits work even when
  // the host has no global git config (e.g. CI runners). GIT_ENV only covers
  // this test's setup commits — the engine shells out with the ambient env.
  git("config", "user.email", "test@skynet.local");
  git("config", "user.name", "Test");
  commit("README.md", "base\n", "init");
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(`${repo}-wt`, { recursive: true, force: true }); // the engine's scratch worktrees
});

// Build an engine whose callbacks record outcomes and signal completion, so the
// fire-and-forget enqueue() can be awaited deterministically.
function harness(checkCmd?: string) {
  const calls = {
    merged: [] as { req: MergeRequest; branch: string }[],
    conflict: [] as { req: MergeRequest; files: string[] }[],
    checksFailed: [] as { req: MergeRequest; out: string }[],
    mergeFailed: [] as { req: MergeRequest; reason: string }[],
    logs: [] as string[],
  };
  let settle: (() => void) | null = null;
  const cb: MergeCallbacks = {
    onMerged: async (req, branch) => { calls.merged.push({ req, branch }); settle?.(); },
    onConflict: async (req, files) => { calls.conflict.push({ req, files }); settle?.(); },
    onChecksFailed: async (req, out) => { calls.checksFailed.push({ req, out }); settle?.(); },
    onMergeFailed: async (req, reason) => { calls.mergeFailed.push({ req, reason }); settle?.(); },
    onLog: (_id, line) => { calls.logs.push(line); },
  };
  const engine = new MergeEngine(repo, "main", cb, checkCmd, join(repo, "..", `${repo.split("/").pop()}-wt`));
  const enqueueAndWait = (req: MergeRequest) =>
    new Promise<void>((res) => { settle = res; engine.enqueue(req); });
  return { engine, calls, enqueueAndWait };
}

const req = (runId: string, agentBranch: string): MergeRequest => ({
  runId, agentBranch, projectId: "payments", workspaceId: "cyberdyne",
});

describe("MergeEngine", () => {
  it("merges a non-conflicting agent branch onto the integration branch", async () => {
    git("checkout", "-b", "agent/clean", "main");
    commit("feature.ts", "export const x = 1;\n", "add feature");
    git("checkout", "main");

    const { calls, enqueueAndWait } = harness();
    await enqueueAndWait(req("a-clean", "agent/clean"));

    expect(calls.merged).toHaveLength(1);
    expect(calls.merged[0]!.branch).toBe("skynet/integration/payments");
    expect(calls.conflict).toHaveLength(0);
    // The integration branch now contains the agent's file.
    expect(git("cat-file", "-t", "skynet/integration/payments:feature.ts").trim()).toBe("blob");
  });

  it("serializes two merges and escalates the second as a conflict", async () => {
    // Two runs edit the same line off main → first merges clean, second conflicts.
    git("checkout", "-b", "agent/a", "main");
    commit("shared.txt", "version A\n", "A edits shared");
    git("checkout", "main");
    git("checkout", "-b", "agent/b", "main");
    commit("shared.txt", "version B\n", "B edits shared");
    git("checkout", "main");

    const { calls, enqueueAndWait } = harness();
    await enqueueAndWait(req("a", "agent/a")); // clean into fresh integration branch
    await enqueueAndWait(req("b", "agent/b")); // conflicts with A's change

    expect(calls.merged).toHaveLength(1);
    expect(calls.conflict).toHaveLength(1);
    expect(calls.conflict[0]!.files).toContain("shared.txt");
    // After an aborted merge the working tree is clean (merge --abort ran).
    expect(git("status", "--porcelain").trim()).toBe("");
  });

  it("merges in a scratch worktree — a dirty shared checkout neither breaks nor is touched", async () => {
    // The phantom-gate scenario (sim-judge finding): the shared repo's own
    // checkout is dirty AND has an untracked file colliding with the incoming
    // one. The old checkout-in-repo flow failed here with a non-conflict git
    // error, misreported as "Merge conflict — 0 files" and re-raised forever.
    git("checkout", "-b", "agent/dirty", "main");
    commit("feature.ts", "export const x = 1;\n", "add feature");
    git("checkout", "main");
    writeFileSync(join(repo, "README.md"), "LOCAL EDITS — do not lose\n"); // tracked, dirty
    writeFileSync(join(repo, "feature.ts"), "UNTRACKED local file\n"); // collides with incoming

    const { calls, enqueueAndWait } = harness();
    await enqueueAndWait(req("a-dirty", "agent/dirty"));

    expect(calls.merged).toHaveLength(1);
    expect(calls.conflict).toHaveLength(0);
    expect(calls.mergeFailed).toHaveLength(0);
    // The user's checkout is untouched: still on main, dirty files intact.
    expect(git("branch", "--show-current").trim()).toBe("main");
    expect(readFileSync(join(repo, "README.md"), "utf8")).toContain("LOCAL EDITS");
    expect(readFileSync(join(repo, "feature.ts"), "utf8")).toContain("UNTRACKED");
    // …and the merge really landed on the integration branch ref.
    expect(git("cat-file", "-t", "skynet/integration/payments:feature.ts").trim()).toBe("blob");
  });

  it("a merge that cannot run reports onMergeFailed — never a 0-file 'conflict'", async () => {
    const { calls, enqueueAndWait } = harness();
    await enqueueAndWait(req("a-missing", "agent/does-not-exist"));

    expect(calls.mergeFailed).toHaveLength(1);
    expect(calls.mergeFailed[0]!.reason).toBeTruthy(); // git's actual error, human-readable
    expect(calls.conflict).toHaveLength(0); // the old phantom path
    expect(calls.merged).toHaveLength(0);
  });

  it("rolls back the merge commit and bounces when project checks fail", async () => {
    git("checkout", "-b", "agent/checks", "main");
    commit("feature.ts", "export const y = 2;\n", "add feature");
    git("checkout", "main");

    const { calls, enqueueAndWait } = harness("exit 3"); // checks always fail
    await enqueueAndWait(req("a-checks", "agent/checks"));

    expect(calls.checksFailed).toHaveLength(1);
    expect(calls.merged).toHaveLength(0);
    // Merge commit was reset (HEAD~1) — integration branch tip is the base commit,
    // so the agent's file is not present on it.
    expect(() => git("cat-file", "-e", "skynet/integration/payments:feature.ts")).toThrow();
  });

  // Guided merge (ROADMAP: "understand-then-merge, to any branch"). The
  // "unset behaves exactly as today" half is already covered by every test
  // above (none of them set `targetBranch`) — these cover the new half: an
  // explicit target, its validation, and the concurrency fix it required.
  describe("guided merge — targetBranch", () => {
    it("merges into an explicit target branch instead of the project's default integration branch", async () => {
      git("checkout", "-b", "agent/feat", "main");
      commit("widget.ts", "export const w = 1;\n", "add widget");
      git("checkout", "main");

      const { calls, enqueueAndWait } = harness();
      await enqueueAndWait({ ...req("a-feat", "agent/feat"), targetBranch: "release/v2" });

      expect(calls.merged).toHaveLength(1);
      expect(calls.merged[0]!.branch).toBe("release/v2"); // NOT skynet/integration/payments
      // The target didn't exist — created off `main` (mirrors integrationBranch's
      // own "create on demand" behavior), so an operator can target a feature
      // stack or release branch that hasn't been cut yet.
      expect(git("cat-file", "-t", "release/v2:widget.ts").trim()).toBe("blob");
      // The project's actual default integration branch was never touched.
      expect(() => git("rev-parse", "--verify", "skynet/integration/payments")).toThrow();
    });

    it("rejects an invalid target branch name before touching git — never a phantom conflict", async () => {
      git("checkout", "-b", "agent/bad-target", "main");
      commit("x.ts", "export const x = 1;\n", "x");
      git("checkout", "main");

      const { calls, enqueueAndWait } = harness();
      await enqueueAndWait({ ...req("a-bad-target", "agent/bad-target"), targetBranch: "--upload-pack=evil" });

      expect(calls.mergeFailed).toHaveLength(1);
      expect(calls.mergeFailed[0]!.reason).toMatch(/invalid target branch/i);
      expect(calls.merged).toHaveLength(0);
      expect(calls.conflict).toHaveLength(0);
      // Never created as a branch, never merged into.
      expect(() => git("rev-parse", "--verify", "--upload-pack=evil")).toThrow();
    });

    it("two different target branches for the same project merge concurrently without racing on the scratch worktree", async () => {
      // Regression for the bug this feature would otherwise reintroduce: the
      // scratch dir used to be keyed by projectId alone, so two concurrent
      // merges for the same project (now genuinely possible once a project can
      // have more than one live target) would fight over one checkout.
      git("checkout", "-b", "agent/one", "main");
      commit("one.ts", "export const one = 1;\n", "one");
      git("checkout", "-b", "agent/two", "main");
      commit("two.ts", "export const two = 2;\n", "two");
      git("checkout", "main");

      const { engine, calls } = harness();
      engine.enqueue(req("a-one", "agent/one")); // → default integration branch
      engine.enqueue({ ...req("a-two", "agent/two"), targetBranch: "release/v3" }); // → a different target, same project

      const deadline = Date.now() + 10_000;
      while (calls.merged.length < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }

      expect(calls.merged).toHaveLength(2);
      expect(calls.conflict).toHaveLength(0);
      expect(calls.mergeFailed).toHaveLength(0);
      const branches = calls.merged.map((m) => m.branch).sort();
      expect(branches).toEqual(["release/v3", "skynet/integration/payments"]);
      expect(git("cat-file", "-t", "skynet/integration/payments:one.ts").trim()).toBe("blob");
      expect(git("cat-file", "-t", "release/v3:two.ts").trim()).toBe("blob");
    });
  });
});
