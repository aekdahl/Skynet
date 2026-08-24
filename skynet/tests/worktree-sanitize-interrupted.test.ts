// A reassigned/resumed escalation hands a WORKTREE that the previous agent
// was forcibly stopped in back to a fresh agent turn (see orchestrator.ts's
// relaunchEscalated). If the killed agent was mid `git merge`/`git rebase` —
// plausibly WHY it got stuck (a conflict it didn't know how to resolve) — the
// new agent inherits a half-finished operation with no idea it's there, and
// has to reverse-engineer it via ad-hoc git archaeology before it can even
// start (observed in the wild: git log/status/fsck, then a second stuck
// escalation). sanitizeInterrupted is the fix: abort any in-progress
// merge/rebase before handoff — never touches committed or uncommitted file
// changes, only the interrupted git OPERATION itself.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let WorktreeProvisioner: typeof import("../apps/server/src/worktrees.js").WorktreeProvisioner;
let repo: string, worktreesDir: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "skynet-sanitize-repo-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "skynet-sanitize-wt-"));
  execFileSync("git", ["init", "-b", "main", repo]);
  git(repo, "config", "user.email", "test@skynet.local");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "shared.txt"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "base");
  ({ WorktreeProvisioner } = await import("../apps/server/src/worktrees.js"));
});
afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(worktreesDir, { recursive: true, force: true });
});

describe("WorktreeProvisioner.sanitizeInterrupted", () => {
  it("aborts an in-progress merge conflict, leaving other file changes untouched", async () => {
    const wt = new WorktreeProvisioner(repo, "main", worktreesDir);
    const { cwd } = await wt.provision("r-merge", "agent/r-merge", {});

    // A conflicting branch: main and the agent branch each change shared.txt
    // differently, and the agent branch ALSO has an unrelated file — real
    // uncommitted work that must survive the abort.
    writeFileSync(join(cwd, "shared.txt"), "agent version\n");
    git(cwd, "add", "-A");
    git(cwd, "-c", "user.name=T", "-c", "user.email=t@t", "commit", "-m", "agent edit");
    writeFileSync(join(repo, "shared.txt"), "main version\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "main edit");

    // Simulate the killed agent mid-merge: it started `git merge main` (hit
    // the conflict) and was interrupted before resolving it.
    try {
      git(cwd, "merge", "main");
    } catch {
      /* expected — real conflict, git exits non-zero */
    }
    expect(existsSync(join(cwd, ".git"))).toBe(true); // sanity: real worktree
    const statusDuringConflict = git(cwd, "status", "--porcelain=v1");
    expect(statusDuringConflict).toContain("UU shared.txt"); // both-modified conflict marker

    // A genuinely untouched, uncommitted file the agent was also mid-edit on —
    // must survive the abort exactly as it stood.
    writeFileSync(join(cwd, "untouched-work.txt"), "precious in-progress edit\n");

    const cleaned = await wt.sanitizeInterrupted("r-merge");
    expect(cleaned).toEqual(["merge"]);

    // The conflict is gone — back to a clean, comprehensible state on the
    // agent's own last commit (never resurrects main's changes into the tree).
    const statusAfter = git(cwd, "status", "--porcelain=v1");
    expect(statusAfter).not.toContain("UU shared.txt");
    expect(git(cwd, "rev-parse", "HEAD")).toBe(git(cwd, "rev-parse", "agent/r-merge"));

    // The unrelated in-progress file survived untouched — abort never touches
    // real work, only the interrupted merge machinery.
    expect(existsSync(join(cwd, "untouched-work.txt"))).toBe(true);
  });

  it("aborts an in-progress rebase", async () => {
    const wt = new WorktreeProvisioner(repo, "main", worktreesDir);
    const { cwd } = await wt.provision("r-rebase", "agent/r-rebase", {});
    writeFileSync(join(cwd, "shared.txt"), "rebase agent version\n");
    git(cwd, "add", "-A");
    git(cwd, "-c", "user.name=T", "-c", "user.email=t@t", "commit", "-m", "agent edit for rebase");
    // Diverge main again (test 1 already moved it once) so the rebase has a
    // real conflict to pause on, not a no-op fast-forward.
    writeFileSync(join(repo, "shared.txt"), "main version 2\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "main edit 2");

    try {
      git(cwd, "rebase", "main");
    } catch {
      /* expected — conflict, rebase pauses mid-operation */
    }
    // Mid-rebase state really exists: a second rebase attempt refuses to
    // start while one is already in progress — the actual proof, rather than
    // asserting on a specific unrelated command's behavior during the pause.
    expect(() => git(cwd, "rebase", "main")).toThrow();

    const cleaned = await wt.sanitizeInterrupted("r-rebase");
    expect(cleaned).toEqual(["rebase"]);

    // Rebase machinery cleared — a fresh rebase can start again (would refuse
    // if the old one were still active).
    expect(() => git(cwd, "rebase", "--abort")).toThrow(); // nothing to abort anymore
  });

  it("is a safe no-op when there's nothing to abort (the common case — most runs exit cleanly)", async () => {
    const wt = new WorktreeProvisioner(repo, "main", worktreesDir);
    const { cwd } = await wt.provision("r-clean", "agent/r-clean", {});
    writeFileSync(join(cwd, "clean-work.txt"), "normal uncommitted work\n");

    const cleaned = await wt.sanitizeInterrupted("r-clean");
    expect(cleaned).toEqual([]);
    expect(existsSync(join(cwd, "clean-work.txt"))).toBe(true); // never touched
  });
});
