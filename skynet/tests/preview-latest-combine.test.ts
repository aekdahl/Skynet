// The `latest` preview source folds every review-ready run branch onto the base
// into ONE worktree — best-effort: a branch that conflicts with an earlier one is
// aborted and skipped, and the tally is reported. This drives the real
// ProjectPreviewManager against a throwaway git repo (no dev server: with no
// recipe the start fails fast AFTER the combine, so `combined` + the worktree
// contents are what we assert).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectPreviewManager } from "../apps/server/src/preview/project-preview.js";

let repo: string;
let worktreesDir: string;
const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: ["ignore", "pipe", "pipe"] }).toString();

// A branch off main that sets app.txt to `content`.
const branchWith = (name: string, content: string) => {
  git("checkout", "-q", "main");
  git("checkout", "-q", "-b", name);
  writeFileSync(join(repo, "app.txt"), content);
  git("add", "-A");
  git("commit", "-q", "-m", name);
  git("checkout", "-q", "main");
};

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "skynet-latest-repo-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "skynet-latest-wt-"));
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git("config", "user.email", "t@skynet.local");
  git("config", "user.name", "T");
  writeFileSync(join(repo, "app.txt"), "base\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(worktreesDir, { recursive: true, force: true });
});

const previewFile = () => readFileSync(join(worktreesDir, "preview-p1", "app.txt"), "utf8");

describe("latest preview — combine review branches", () => {
  it("folds in a conflicting branch best-effort: earlier wins, the conflict is skipped + reported", async () => {
    branchWith("agent/r1", "A\n"); // clean off base
    branchWith("agent/r2", "B\n"); // same line as r1 → conflicts once r1 is in
    const mgr = new ProjectPreviewManager(worktreesDir);
    const st = await mgr.start("p1", repo, undefined, { source: "latest", baseBranch: "main", combineBranches: ["agent/r1", "agent/r2"] });

    expect(st.source).toBe("latest");
    expect(st.combined).toEqual({ total: 2, included: 1, skipped: 1 });
    expect(previewFile()).toBe("A\n"); // r1 merged; r2 aborted, tree clean
  });

  it("combines multiple non-conflicting branches into one worktree", async () => {
    // Two branches touching DIFFERENT files → both merge cleanly.
    git("checkout", "-q", "-b", "agent/r1");
    writeFileSync(join(repo, "a.txt"), "from r1\n");
    git("add", "-A"); git("commit", "-q", "-m", "r1"); git("checkout", "-q", "main");
    git("checkout", "-q", "-b", "agent/r2");
    writeFileSync(join(repo, "b.txt"), "from r2\n");
    git("add", "-A"); git("commit", "-q", "-m", "r2"); git("checkout", "-q", "main");

    const mgr = new ProjectPreviewManager(worktreesDir);
    const st = await mgr.start("p1", repo, undefined, { source: "latest", baseBranch: "main", combineBranches: ["agent/r1", "agent/r2"] });

    expect(st.combined).toEqual({ total: 2, included: 2, skipped: 0 });
    expect(readFileSync(join(worktreesDir, "preview-p1", "a.txt"), "utf8")).toBe("from r1\n");
    expect(readFileSync(join(worktreesDir, "preview-p1", "b.txt"), "utf8")).toBe("from r2\n");
  });

  it("skips a branch that doesn't exist (reaped / never committed)", async () => {
    branchWith("agent/r1", "A\n");
    const mgr = new ProjectPreviewManager(worktreesDir);
    const st = await mgr.start("p1", repo, undefined, { source: "latest", baseBranch: "main", combineBranches: ["agent/r1", "agent/gone"] });
    expect(st.combined).toEqual({ total: 2, included: 1, skipped: 1 });
    expect(previewFile()).toBe("A\n");
  });

  it("`main` source checks out the base with no combine", async () => {
    branchWith("agent/r1", "A\n");
    const mgr = new ProjectPreviewManager(worktreesDir);
    const st = await mgr.start("p1", repo, undefined, { source: "main", baseBranch: "main", combineBranches: [] });
    expect(st.source).toBe("main");
    expect(st.combined).toBeNull();
    expect(previewFile()).toBe("base\n"); // untouched base
  });
});
