// Git freshness: the fleet must work off LATEST merged main. These drive the
// real WorktreeProvisioner against a real bare "origin" so we can simulate a
// human merge (advance origin/main) and assert: a new run branches from the
// fetched origin/main (not a stale local branch); a pre-PR mergeBase merges main
// cleanly; and a conflicting main is reported (merge aborted) so the caller can
// escalate instead of opening a broken PR.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeProvisioner } from "../apps/server/src/worktrees.js";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe", env: ENV }).toString().trim();

describe("worktree freshness — branch from latest origin/main, sync before PR", () => {
  let remote: string; // bare "origin"
  let seed: string; // a clone used to push commits (simulates humans merging)
  let repo: string; // the provisioner's repo (a clone with origin)
  let wtRoot: string;
  let prov: WorktreeProvisioner;

  const advanceOrigin = (file: string, content: string, msg: string) => {
    writeFileSync(join(seed, file), content);
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", msg);
    git(seed, "push", "-q", "origin", "main");
  };

  beforeEach(() => {
    remote = mkdtempSync(join(tmpdir(), "wf-remote-"));
    seed = mkdtempSync(join(tmpdir(), "wf-seed-"));
    repo = mkdtempSync(join(tmpdir(), "wf-repo-"));
    wtRoot = mkdtempSync(join(tmpdir(), "wf-wt-"));
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote], { env: ENV });
    execFileSync("git", ["clone", "-q", remote, seed], { env: ENV });
    git(seed, "config", "user.email", "t@t");
    git(seed, "config", "user.name", "t");
    writeFileSync(join(seed, "README.md"), "base\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "base");
    git(seed, "push", "-q", "origin", "main");
    execFileSync("git", ["clone", "-q", remote, repo], { env: ENV });
    git(repo, "config", "user.email", "t@t");
    git(repo, "config", "user.name", "t");
    prov = new WorktreeProvisioner(repo, "main", wtRoot);
  });

  afterEach(() => {
    for (const d of [remote, seed, repo, wtRoot]) rmSync(d, { recursive: true, force: true });
  });

  it("a new run branches from the FETCHED latest main, not the stale local clone", async () => {
    // A human merges after this repo was cloned → origin/main has a file the
    // local clone hasn't pulled.
    advanceOrigin("FEATURE.md", "shipped\n", "merge a feature");
    const { cwd, baseRef } = await prov.provision("r1", "agent/r1");
    expect(baseRef).toBe("origin/main"); // cut from the fetched remote tip
    expect(existsSync(join(cwd, "FEATURE.md"))).toBe(true); // has the just-merged work
  });

  it("mergeBase brings a clean main into the branch (ok) before the PR", async () => {
    const { cwd } = await prov.provision("r2", "agent/r2");
    writeFileSync(join(cwd, "agent-work.md"), "by the agent\n"); // the run's own change
    git(cwd, "add", "-A");
    git(cwd, "commit", "-q", "-m", "agent work");
    advanceOrigin("unrelated.md", "meanwhile on main\n", "unrelated merge"); // main moves, no overlap
    const res = await prov.mergeBase("r2");
    expect(res.ok).toBe(true);
    expect(res.depsChanged).toBe(false); // main didn't touch a dependency manifest
    expect(existsSync(join(cwd, "unrelated.md"))).toBe(true); // latest main folded in
    expect(existsSync(join(cwd, "agent-work.md"))).toBe(true); // agent work preserved
  });

  it("flags a dependency-manifest change on merge, and only reconciles when node_modules exists", async () => {
    const { cwd } = await prov.provision("r5", "agent/r5");
    writeFileSync(join(cwd, "code.ts"), "export const x = 1;\n");
    git(cwd, "add", "-A");
    git(cwd, "commit", "-q", "-m", "agent code");
    advanceOrigin("package.json", '{"name":"app","dependencies":{"left-pad":"^1.0.0"}}\n', "main adds a dependency");
    const res = await prov.mergeBase("r5");
    expect(res.ok).toBe(true);
    expect(res.depsChanged).toBe(true); // package.json changed → deps may be stale
    // No node_modules in this worktree → nothing to reconcile; installDeps skips
    // (rather than installing from scratch on every PR).
    expect(existsSync(join(cwd, "node_modules"))).toBe(false);
    const inst = await prov.installDeps("r5");
    expect(inst.installed).toBe(false);
  });

  it("mergeBase reports a conflict and ABORTS (leaves the worktree clean) → caller escalates", async () => {
    const { cwd } = await prov.provision("r3", "agent/r3");
    writeFileSync(join(cwd, "README.md"), "agent edit\n"); // both sides touch README
    git(cwd, "add", "-A");
    git(cwd, "commit", "-q", "-m", "agent edits README");
    advanceOrigin("README.md", "main edit\n", "main also edits README");
    const res = await prov.mergeBase("r3");
    expect(res.ok).toBe(false);
    expect(res.conflicts).toContain("README.md");
    // Merge aborted → worktree is clean (no conflict markers left behind).
    expect(git(cwd, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(cwd, "README.md"), "utf8")).toBe("agent edit\n"); // still the agent's version
  });

  it("baseAheadOf flags a branch once main has moved past it", async () => {
    const { } = await prov.provision("r4", "agent/r4"); // cut from current origin tip
    expect(await prov.baseAheadOf("refs/heads/agent/r4")).toBe(false); // up to date
    advanceOrigin("later.md", "later\n", "a later merge");
    await prov.fetchBase(); // the periodic sweep fetches, then checks
    expect(await prov.baseAheadOf("refs/heads/agent/r4")).toBe(true); // now behind
  });
});
