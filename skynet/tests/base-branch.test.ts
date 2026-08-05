// Per-project base branch: a project can point its runs at a FEATURE branch
// instead of main — every run cuts from it, syncs to it, and (via pushToGithub)
// PRs into it. The orchestrator threads `project.baseBranch ?? config.baseBranch`
// into the WorktreeProvisioner/MergeEngine, so the real behavior lives in the
// provisioner respecting an arbitrary base. These drive the real provisioner
// against a real bare "origin" whose default is a feature branch, plus the
// field's persistence + empty→null normalization through Operations.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE, Project } from "@skynet/shared";
import { WorktreeProvisioner } from "../apps/server/src/worktrees.js";
import { Hub } from "../apps/server/src/hub.js";
import { Operations } from "../apps/server/src/operations.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import { InProcessBus } from "../apps/server/src/bus.js";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe", env: ENV }).toString().trim();

describe("per-project base branch — provisioner cuts from / tracks a feature base", () => {
  let remote: string, seed: string, repo: string, wtRoot: string;
  let prov: WorktreeProvisioner;
  const BASE = "feature/stack"; // the project's chosen base, NOT main

  beforeEach(() => {
    remote = mkdtempSync(join(tmpdir(), "bb-remote-"));
    seed = mkdtempSync(join(tmpdir(), "bb-seed-"));
    repo = mkdtempSync(join(tmpdir(), "bb-repo-"));
    wtRoot = mkdtempSync(join(tmpdir(), "bb-wt-"));
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote], { env: ENV });
    execFileSync("git", ["clone", "-q", remote, seed], { env: ENV });
    git(seed, "config", "user.email", "t@t");
    git(seed, "config", "user.name", "t");
    writeFileSync(join(seed, "README.md"), "base\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "base");
    git(seed, "push", "-q", "origin", "main");
    // A feature branch off main with a file that ONLY exists on the feature base.
    git(seed, "checkout", "-q", "-b", BASE);
    writeFileSync(join(seed, "FEATURE-ONLY.md"), "on the feature base\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "feature base work");
    git(seed, "push", "-q", "origin", BASE);
    execFileSync("git", ["clone", "-q", remote, repo], { env: ENV });
    git(repo, "config", "user.email", "t@t");
    git(repo, "config", "user.name", "t");
    // The provisioner is built with the FEATURE branch as its base.
    prov = new WorktreeProvisioner(repo, BASE, wtRoot);
  });
  afterEach(() => {
    for (const d of [remote, seed, repo, wtRoot]) rmSync(d, { recursive: true, force: true });
  });

  it("a new run branches from origin/<featureBase>, not main", async () => {
    const { cwd, baseRef } = await prov.provision("r1", "agent/r1");
    expect(baseRef).toBe(`origin/${BASE}`); // cut from the feature base, not origin/main
    expect(existsSync(join(cwd, "FEATURE-ONLY.md"))).toBe(true); // has the feature-base-only work
  });

  it("baseAheadOf tracks the feature base moving (not main)", async () => {
    await prov.provision("r2", "agent/r2");
    expect(await prov.baseAheadOf("refs/heads/agent/r2")).toBe(false); // up to date with the feature base
    // main moves — irrelevant to this project's base.
    git(seed, "checkout", "-q", "main");
    writeFileSync(join(seed, "on-main.md"), "x\n");
    git(seed, "add", "-A"); git(seed, "commit", "-q", "-m", "main moves"); git(seed, "push", "-q", "origin", "main");
    await prov.fetchBase();
    expect(await prov.baseAheadOf("refs/heads/agent/r2")).toBe(false); // still current — base didn't move
    // the feature base moves → now behind.
    git(seed, "checkout", "-q", BASE);
    writeFileSync(join(seed, "more-feature.md"), "y\n");
    git(seed, "add", "-A"); git(seed, "commit", "-q", "-m", "feature base advances"); git(seed, "push", "-q", "origin", BASE);
    await prov.fetchBase();
    expect(await prov.baseAheadOf("refs/heads/agent/r2")).toBe(true);
  });
});

describe("per-project base branch — field persistence", () => {
  const mkOps = () => {
    const store = new MemoryStore({ seed: false });
    const hub = new Hub(store, new InProcessBus());
    return { store, operations: new Operations({ store, hub, orchestrator: new Orchestrator(store, hub) }) };
  };

  it("defaults to null (= the global base) on a fresh project", () => {
    expect(Project.parse({ id: "p", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [], status: "active" }).baseBranch).toBe(null);
  });

  it("update sets it, and blank clears it back to null", async () => {
    const { store, operations } = mkOps();
    await store.putProject(Project.parse({ id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [], status: "active" }));

    const set = await operations.updateProject(DEFAULT_WORKSPACE, "p1", { baseBranch: "  release/2.0  " });
    expect(set.baseBranch).toBe("release/2.0"); // trimmed + stored

    const cleared = await operations.updateProject(DEFAULT_WORKSPACE, "p1", { baseBranch: "" });
    expect(cleared.baseBranch).toBe(null); // empty → null (never "")

    const untouched = await operations.updateProject(DEFAULT_WORKSPACE, "p1", { goal: "g" });
    expect(untouched.baseBranch).toBe(null); // omitting the field leaves it alone
  });
});
