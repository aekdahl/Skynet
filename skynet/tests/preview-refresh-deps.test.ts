// When a live PROJECT preview refreshes to a new integration tip that changed a
// dependency manifest, it reconciles deps — but must NEVER write into a
// node_modules that's a symlink to the operator's checkout. This drives the real
// ProjectPreviewManager.refresh() against a real git repo: it detects the
// package.json change on refresh and, for a symlinked node_modules, logs a note
// instead of installing (leaving the operator's deps untouched).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectPreviewManager } from "../apps/server/src/preview/project-preview.js";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe", env: ENV }).toString().trim();

describe("preview refresh — reconcile deps without touching a symlinked node_modules", () => {
  let repo: string;
  let wtRoot: string;
  let operatorNodeModules: string;
  let mgr: ProjectPreviewManager;
  const INTEGRATION = "skynet/integration/p1";

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "prd-repo-"));
    wtRoot = mkdtempSync(join(tmpdir(), "prd-wt-"));
    operatorNodeModules = mkdtempSync(join(tmpdir(), "prd-nm-")); // stands in for the operator's node_modules
    mkdirSync(join(operatorNodeModules, ".bin"), { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", repo], { env: ENV });
    git(repo, "config", "user.email", "t@t");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "package.json"), '{"name":"app","version":"1.0.0"}\n');
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");
    git(repo, "branch", INTEGRATION); // the preview's refresh branch, at base
    mgr = new ProjectPreviewManager(wtRoot);
  });

  afterEach(() => {
    for (const d of [repo, wtRoot, operatorNodeModules]) rmSync(d, { recursive: true, force: true });
  });

  it("on refresh with a changed package.json, symlinked node_modules is left alone (note, not install)", async () => {
    // Stand up the preview worktree the way the manager names it, detached at the
    // integration tip, then inject a matching live entry into the manager.
    const dir = join(wtRoot, "preview-p1");
    git(repo, "worktree", "add", "--detach", dir, INTEGRATION);
    // node_modules is a SYMLINK to the "operator's" node_modules (the fast path).
    symlinkSync(operatorNodeModules, join(dir, "node_modules"), "dir");

    const live = {
      status: "live", key: "p1", dir, gitRepo: repo, recipeKey: "p1", refreshBranch: INTEGRATION,
      port: 5999, logs: [] as string[], error: null, startedAt: 0, lastTouched: 0,
    };
    (mgr as unknown as { previews: Map<string, unknown> }).previews.set("p1", live);

    // A merge lands on the integration branch that bumps a dependency.
    const scratch = mkdtempSync(join(tmpdir(), "prd-scratch-"));
    git(repo, "worktree", "add", scratch, INTEGRATION);
    writeFileSync(join(scratch, "package.json"), '{"name":"app","version":"1.0.0","dependencies":{"left-pad":"^1"}}\n');
    git(scratch, "add", "-A");
    git(scratch, "commit", "-q", "-m", "add a dependency");
    git(repo, "worktree", "remove", "--force", scratch);

    await mgr.refresh("p1");

    // node_modules is still the SAME symlink to the operator's dir — untouched.
    expect(lstatSync(join(dir, "node_modules")).isSymbolicLink()).toBe(true);
    // And the preview logged a note rather than installing.
    const logs = (live.logs as string[]).join("\n");
    expect(logs).toMatch(/refreshed to integration branch tip/i);
    expect(logs).toMatch(/touched dependencies/i);
    expect(logs).toMatch(/checkout's node_modules/i);
  });
});
