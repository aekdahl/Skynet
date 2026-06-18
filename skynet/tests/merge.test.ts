// Merge engine: the serialized merge queue integrates agent branches one at a
// time per project integration branch (VCS brief §5–6). Drive it against real
// throwaway git repos and assert the three outcomes: clean merge, textual
// conflict (escalated with the contested files), and post-merge check failure
// (merge commit rolled back, bounced to the agent).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  commit("README.md", "base\n", "init");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

// Build an engine whose callbacks record outcomes and signal completion, so the
// fire-and-forget enqueue() can be awaited deterministically.
function harness(checkCmd?: string) {
  const calls = {
    merged: [] as { req: MergeRequest; branch: string }[],
    conflict: [] as { req: MergeRequest; files: string[] }[],
    checksFailed: [] as { req: MergeRequest; out: string }[],
    logs: [] as string[],
  };
  let settle: (() => void) | null = null;
  const cb: MergeCallbacks = {
    onMerged: async (req, branch) => { calls.merged.push({ req, branch }); settle?.(); },
    onConflict: async (req, files) => { calls.conflict.push({ req, files }); settle?.(); },
    onChecksFailed: async (req, out) => { calls.checksFailed.push({ req, out }); settle?.(); },
    onLog: (_id, line) => { calls.logs.push(line); },
  };
  const engine = new MergeEngine(repo, "main", cb, checkCmd);
  const enqueueAndWait = (req: MergeRequest) =>
    new Promise<void>((res) => { settle = res; engine.enqueue(req); });
  return { engine, calls, enqueueAndWait };
}

const req = (agentId: string, agentBranch: string): MergeRequest => ({
  agentId, agentBranch, projectId: "payments", workspaceId: "cyberdyne",
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
    // Two agents edit the same line off main → first merges clean, second conflicts.
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
    expect(() => gitQuiet("cat-file", "-e", "skynet/integration/payments:feature.ts")).toThrow();
  });
});
