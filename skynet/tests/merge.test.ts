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
    conflict: [] as { req: MergeRequest; files: string[]; conflictDiff: string }[],
    checksFailed: [] as { req: MergeRequest; out: string }[],
    mergeFailed: [] as { req: MergeRequest; reason: string }[],
    logs: [] as string[],
  };
  let settle: (() => void) | null = null;
  const cb: MergeCallbacks = {
    onMerged: async (req, branch) => { calls.merged.push({ req, branch }); settle?.(); },
    onConflict: async (req, files, conflictDiff) => { calls.conflict.push({ req, files, conflictDiff }); settle?.(); },
    onChecksFailed: async (req, out) => { calls.checksFailed.push({ req, out }); settle?.(); },
    onMergeFailed: async (req, reason) => { calls.mergeFailed.push({ req, reason }); settle?.(); },
    onLog: (_id, line) => { calls.logs.push(line); },
  };
  const engine = new MergeEngine(repo, "main", cb, checkCmd, join(repo, "..", `${repo.split("/").pop()}-wt`));
  const enqueueAndWait = (req: MergeRequest) =>
    new Promise<void>((res) => { settle = res; engine.enqueue(req); });
  return { engine, calls, enqueueAndWait };
}

const req = (runId: string, agentBranch: string, targetBranch?: string, featureId?: string): MergeRequest => ({
  runId, agentBranch, projectId: "payments", workspaceId: "cyberdyne",
  ...(targetBranch ? { targetBranch } : {}),
  ...(featureId ? { featureId } : {}),
});

// Poll a condition until true (short interval — these are in-memory array
// lengths, not I/O), for asserting on two concurrently-enqueued merges whose
// completion order isn't determined by the test.
async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition never became true");
    await new Promise((r) => setTimeout(r, 10));
  }
}

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
    // The actual conflict markers, captured before `merge --abort` discards
    // them — this is what lets an agent be handed the real conflict instead
    // of just a list of contested filenames.
    expect(calls.conflict[0]!.conflictDiff).toContain("<<<<<<<");
    expect(calls.conflict[0]!.conflictDiff).toContain("version A");
    expect(calls.conflict[0]!.conflictDiff).toContain("version B");
    expect(calls.conflict[0]!.conflictDiff).toContain(">>>>>>>");
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

  // ── Guided merge: operator-chosen target branch ─────────────────────────
  it("merges into a chosen target branch instead of the project's default integration branch", async () => {
    git("checkout", "-b", "agent/to-release", "main");
    commit("feature.ts", "export const x = 1;\n", "add feature");
    git("checkout", "main");

    const { calls, enqueueAndWait } = harness();
    await enqueueAndWait(req("a-release", "agent/to-release", "release/v2"));

    expect(calls.merged).toHaveLength(1);
    expect(calls.merged[0]!.branch).toBe("release/v2");
    // The default integration branch was never created/touched.
    expect(git("branch", "--list", "skynet/integration/payments").trim()).toBe("");
    expect(git("cat-file", "-t", "release/v2:feature.ts").trim()).toBe("blob");
  });

  it("creates the target branch off baseBranch when it doesn't exist yet, same as the default", async () => {
    git("checkout", "-b", "agent/fresh-target", "main");
    commit("feature.ts", "export const x = 1;\n", "add feature");
    git("checkout", "main");
    // "release/v3" doesn't exist anywhere yet.
    expect(git("branch", "--list", "release/v3").trim()).toBe("");

    const { calls, enqueueAndWait } = harness();
    await enqueueAndWait(req("a-fresh", "agent/fresh-target", "release/v3"));

    expect(calls.merged).toHaveLength(1);
    expect(git("cat-file", "-t", "release/v3:feature.ts").trim()).toBe("blob");
    // Created off baseBranch ("main"), same ancestry rule as the default path.
    expect(git("merge-base", "--is-ancestor", "main", "release/v3")).toBe("");
  });

  it("an unset targetBranch is unaffected — same default integration branch as before", async () => {
    git("checkout", "-b", "agent/default-path", "main");
    commit("feature.ts", "export const x = 1;\n", "add feature");
    git("checkout", "main");

    const { calls, enqueueAndWait } = harness();
    await enqueueAndWait(req("a-default", "agent/default-path")); // no targetBranch

    expect(calls.merged).toHaveLength(1);
    expect(calls.merged[0]!.branch).toBe("skynet/integration/payments");
  });

  it("two merges for the SAME project into DIFFERENT target branches run as independent chains without stomping each other's scratch worktree", async () => {
    git("checkout", "-b", "agent/one", "main");
    commit("one.ts", "export const one = 1;\n", "one");
    git("checkout", "main");
    git("checkout", "-b", "agent/two", "main");
    commit("two.ts", "export const two = 2;\n", "two");
    git("checkout", "main");

    const { calls, engine } = harness();
    // Fire both concurrently — distinct target branches, so distinct chains
    // (see MergeEngine.enqueue keying by branch) that may overlap in time.
    engine.enqueue(req("a-one", "agent/one", "release/one"));
    engine.enqueue(req("a-two", "agent/two", "release/two"));
    const deadline = Date.now() + 10_000;
    while (calls.merged.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(calls.merged).toHaveLength(2);
    expect(calls.mergeFailed).toHaveLength(0);
    expect(calls.conflict).toHaveLength(0);
    expect(git("cat-file", "-t", "release/one:one.ts").trim()).toBe("blob");
    expect(git("cat-file", "-t", "release/two:two.ts").trim()).toBe("blob");
  });

  it("MergeRequest.checkCmd (per-project, resolved by the caller) overrides the engine's constructor default", async () => {
    git("checkout", "-b", "agent/override", "main");
    commit("feature.ts", "export const z = 3;\n", "add feature");
    git("checkout", "main");

    // Engine constructed with a PASSING global default...
    const { calls, enqueueAndWait } = harness("true");
    // ...but this request's resolved project checkCmd fails — proves the
    // per-request value wins, not the engine-level one baked in at construction.
    await enqueueAndWait({ ...req("a-override", "agent/override"), checkCmd: "exit 1" });

    expect(calls.checksFailed).toHaveLength(1);
    expect(calls.merged).toHaveLength(0);
  });

  it("MergeRequest.checkCmd falls back to the engine's constructor default when absent", async () => {
    git("checkout", "-b", "agent/fallback", "main");
    commit("feature.ts", "export const w = 4;\n", "add feature");
    git("checkout", "main");

    const { calls, enqueueAndWait } = harness("exit 1"); // global default fails
    await enqueueAndWait(req("a-fallback", "agent/fallback")); // no per-request override

    expect(calls.checksFailed).toHaveLength(1);
    expect(calls.merged).toHaveLength(0);
  });
});

// Feature-scoped branch batching (ROADMAP.md): tasks under the same Feature
// merge into a shared `skynet/feature/<id>` branch first, and only once every
// one is done does that branch merge up into the project's normal integration
// branch — one PR instead of N. Two tiers, same MergeEngine, distinguished by
// `MergeRequest.featureId` (destination override) — see `targetBranchFor`.
describe("MergeEngine — feature-scoped branch batching", () => {
  it("targetBranchFor resolves to the feature branch when featureId is set, else the project's default", () => {
    const { engine } = harness();
    expect(engine.targetBranchFor(req("a", "agent/a", undefined, "f-1"))).toBe("skynet/feature/f-1");
    expect(engine.targetBranchFor(req("a", "agent/a"))).toBe("skynet/integration/payments");
  });

  it("batches two tasks into a shared feature branch, then merges that branch up into the project's integration branch", async () => {
    git("checkout", "-b", "agent/task-1", "main");
    commit("a.ts", "export const a = 1;\n", "task 1");
    git("checkout", "main");
    git("checkout", "-b", "agent/task-2", "main");
    commit("b.ts", "export const b = 2;\n", "task 2");
    git("checkout", "main");

    const { calls, enqueueAndWait } = harness();
    // Step 1: both tasks merge into the SAME feature branch (destination
    // override via featureId) — a normal per-run merge in every other respect.
    await enqueueAndWait(req("task-1", "agent/task-1", undefined, "f-checkout"));
    await enqueueAndWait(req("task-2", "agent/task-2", undefined, "f-checkout"));
    expect(calls.merged).toHaveLength(2);
    expect(calls.merged.every((m) => m.branch === "skynet/feature/f-checkout")).toBe(true);
    expect(git("cat-file", "-t", "skynet/feature/f-checkout:a.ts").trim()).toBe("blob");
    expect(git("cat-file", "-t", "skynet/feature/f-checkout:b.ts").trim()).toBe("blob");
    // The project's own integration branch doesn't exist yet — nothing has
    // targeted it (this is exactly the PR-count reduction: neither task opened
    // its own PR/merge here).
    expect(() => git("rev-parse", "--verify", "skynet/integration/payments")).toThrow();

    // Step 2: once every task is done, the feature branch itself merges up —
    // agentBranch is the feature branch (the SOURCE), featureId unset (the
    // DESTINATION is the project's normal integration branch).
    await enqueueAndWait(req("task-2", "skynet/feature/f-checkout")); // anchor runId, any of the batch's own
    expect(calls.merged).toHaveLength(3);
    expect(calls.merged[2]!.branch).toBe("skynet/integration/payments");
    // Both tasks' work landed on the project's integration branch in ONE merge.
    expect(git("cat-file", "-t", "skynet/integration/payments:a.ts").trim()).toBe("blob");
    expect(git("cat-file", "-t", "skynet/integration/payments:b.ts").trim()).toBe("blob");
  });

  it("a conflict merging the feature branch up is reported against the project's integration branch, not the feature branch", async () => {
    // Set up a real conflict: the project's integration branch and the feature
    // branch both edit the same file differently.
    git("checkout", "-b", "skynet/integration/payments", "main");
    commit("shared.txt", "on main line\n", "integration edits shared");
    git("checkout", "main");
    git("checkout", "-b", "skynet/feature/f-conflict", "main");
    commit("shared.txt", "on feature line\n", "feature edits shared");
    git("checkout", "main");

    const { calls, enqueueAndWait } = harness();
    await enqueueAndWait(req("anchor", "skynet/feature/f-conflict"));

    expect(calls.conflict).toHaveLength(1);
    expect(calls.conflict[0]!.files).toContain("shared.txt");
    expect(calls.conflict[0]!.req.agentBranch).toBe("skynet/feature/f-conflict");
  });

  it("two different feature branches merge concurrently without colliding on the same scratch worktree", async () => {
    // Regression test: scratchFor() used to be keyed by projectId alone, so two
    // targets under the same project (its integration branch, plus any number
    // of feature branches) raced on the SAME scratch worktree path. Now keyed
    // by the target branch — each gets its own chain (enqueue) AND its own
    // scratch path, so concurrent merges to different feature branches under
    // the same project can't corrupt each other.
    git("checkout", "-b", "agent/x", "main");
    commit("x.ts", "export const x = 1;\n", "task x");
    git("checkout", "main");
    git("checkout", "-b", "agent/y", "main");
    commit("y.ts", "export const y = 1;\n", "task y");
    git("checkout", "main");

    const { calls, engine } = harness();
    // Enqueue both WITHOUT awaiting between them — they run concurrently on
    // separate chains (different target branches), racing in real time.
    engine.enqueue(req("x", "agent/x", undefined, "f-alpha"));
    engine.enqueue(req("y", "agent/y", undefined, "f-beta"));
    await waitFor(() => calls.merged.length + calls.conflict.length + calls.mergeFailed.length >= 2);

    expect(calls.merged).toHaveLength(2);
    expect(calls.conflict).toHaveLength(0);
    expect(calls.mergeFailed).toHaveLength(0);
    expect(git("cat-file", "-t", "skynet/feature/f-alpha:x.ts").trim()).toBe("blob");
    expect(git("cat-file", "-t", "skynet/feature/f-beta:y.ts").trim()).toBe("blob");
  });
});
