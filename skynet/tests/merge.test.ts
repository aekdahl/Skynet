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

const req = (runId: string, agentBranch: string, extra: Partial<MergeRequest> = {}): MergeRequest => ({
  runId, agentBranch, projectId: "payments", workspaceId: "cyberdyne", ...extra,
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
});

describe("MergeEngine — Feature-branch hierarchy", () => {
  it("targets the task's Feature branch, not the project integration branch, when featureId is set", async () => {
    git("checkout", "-b", "agent/t1", "main");
    commit("a.ts", "export const a = 1;\n", "task 1");
    git("checkout", "main");

    const { calls, enqueueAndWait } = harness();
    await enqueueAndWait(req("t1", "agent/t1", { featureId: "f-onboarding" }));

    expect(calls.merged).toHaveLength(1);
    expect(calls.merged[0]!.branch).toBe("skynet/feature/f-onboarding");
    // Never touched the project integration branch.
    expect(git("branch", "--list", "skynet/integration/payments").trim()).toBe("");
    expect(git("cat-file", "-t", "skynet/feature/f-onboarding:a.ts").trim()).toBe("blob");
  });

  it("a task with no featureId is unaffected — still merges to the project integration branch", async () => {
    git("checkout", "-b", "agent/plain", "main");
    commit("b.ts", "export const b = 1;\n", "no feature");
    git("checkout", "main");

    const { calls, enqueueAndWait } = harness();
    await enqueueAndWait(req("plain", "agent/plain"));

    expect(calls.merged).toHaveLength(1);
    expect(calls.merged[0]!.branch).toBe("skynet/integration/payments");
  });

  it("two sibling tasks under the same Feature both land on that Feature's branch, serialized like any project integration", async () => {
    git("checkout", "-b", "agent/s1", "main");
    commit("s1.ts", "export const s1 = 1;\n", "sibling 1");
    git("checkout", "main");
    git("checkout", "-b", "agent/s2", "main");
    commit("s2.ts", "export const s2 = 1;\n", "sibling 2");
    git("checkout", "main");

    const { calls, enqueueAndWait } = harness();
    await enqueueAndWait(req("s1", "agent/s1", { featureId: "f-x" }));
    await enqueueAndWait(req("s2", "agent/s2", { featureId: "f-x" }));

    expect(calls.merged).toHaveLength(2);
    expect(calls.merged.every((m) => m.branch === "skynet/feature/f-x")).toBe(true);
    expect(git("cat-file", "-t", "skynet/feature/f-x:s1.ts").trim()).toBe("blob");
    expect(git("cat-file", "-t", "skynet/feature/f-x:s2.ts").trim()).toBe("blob");
  });

  it("a Feature branch and the project integration branch merge concurrently without racing on scratch worktrees", async () => {
    // Regression: scratch worktree dirs used to be keyed by projectId alone, so
    // two different target branches for the same project shared one scratch
    // dir. Chains now serialize per TARGET branch, so two different targets for
    // the same project run truly concurrently — the scratch path must follow.
    git("checkout", "-b", "agent/int", "main");
    commit("int.ts", "export const i = 1;\n", "plain task");
    git("checkout", "main");
    git("checkout", "-b", "agent/feat", "main");
    commit("feat.ts", "export const f = 1;\n", "feature task");
    git("checkout", "main");

    const { calls, engine } = harness();
    engine.enqueue(req("int", "agent/int"));
    engine.enqueue(req("feat", "agent/feat", { featureId: "f-y" }));
    const deadline = Date.now() + 5000;
    while (calls.merged.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));

    expect(calls.merged).toHaveLength(2);
    expect(new Set(calls.merged.map((m) => m.branch))).toEqual(
      new Set(["skynet/integration/payments", "skynet/feature/f-y"]),
    );
    expect(git("cat-file", "-t", "skynet/integration/payments:int.ts").trim()).toBe("blob");
    expect(git("cat-file", "-t", "skynet/feature/f-y:feat.ts").trim()).toBe("blob");
  });

  it("targetOverride (stage 2) merges the Feature branch directly into the given base, ignoring the project integration branch", async () => {
    // Simulate stage 1 already having landed a task onto the Feature branch.
    git("checkout", "-b", "skynet/feature/f-ship", "main");
    commit("shipped.ts", "export const shipped = 1;\n", "feature work");
    git("checkout", "main");

    const { calls, enqueueAndWait } = harness();
    await enqueueAndWait(req("feature-f-ship", "skynet/feature/f-ship", { featureId: "f-ship", targetOverride: "main" }));

    expect(calls.merged).toHaveLength(1);
    expect(calls.merged[0]!.branch).toBe("main");
    expect(git("cat-file", "-t", "main:shipped.ts").trim()).toBe("blob");
    // Never created/touched a project integration branch for this.
    expect(git("branch", "--list", "skynet/integration/payments").trim()).toBe("");
  });

  it("a stage-2 conflict is escalated the same way a task-level conflict is", async () => {
    git("checkout", "-b", "skynet/feature/f-conflict", "main");
    commit("shared.txt", "feature version\n", "feature edits shared");
    git("checkout", "main");
    commit("shared.txt", "base moved on\n", "base edits shared after branch cut");

    const { calls, enqueueAndWait } = harness();
    await enqueueAndWait(req("feature-f-conflict", "skynet/feature/f-conflict", { featureId: "f-conflict", targetOverride: "main" }));

    expect(calls.conflict).toHaveLength(1);
    expect(calls.conflict[0]!.files).toContain("shared.txt");
    expect(calls.merged).toHaveLength(0);
  });
});
