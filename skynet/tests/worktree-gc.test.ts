// Worktree GC: zombie agent worktrees (run done/archived/unknown — crash or
// memory-store restart leftovers) are removed; agent/* branches already merged
// into their integration branch are deleted once no live run uses them; runs
// parked in `review` past the TTL with no open gate are SURFACED, never deleted
// (their worktree may hold the only copy of unmerged work).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { Project, TaskRun } from "@skynet/shared";
import type { Bus } from "../apps/server/src/bus.js";

class NullBus implements Bus {
  publish(): void {}
  subscribe(): () => void { return () => {}; }
}

let Hub: typeof import("../apps/server/src/hub.js").Hub;
let Orchestrator: typeof import("../apps/server/src/orchestrator.js").Orchestrator;
let MemoryStore: typeof import("../apps/server/src/store/memory.js").MemoryStore;
let WorktreeProvisioner: typeof import("../apps/server/src/worktrees.js").WorktreeProvisioner;
let repo: string, worktreesDir: string;

const git = (...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

const mkRun = (id: string, status: TaskRun["status"], over: Partial<TaskRun> = {}): TaskRun =>
  ({
    id, workspaceId: DEFAULT_WORKSPACE, projectId: "p1", name: id, status,
    agentId: null, provider: "claude", model: "opus-4.8", branch: `agent/${id}`, modules: [],
    progress: 0, plan: [], usage: null, modifiedFiles: [], log: [], startedAt: 0,
    lastHeartbeatAt: Date.now(), visual: false, previewUrl: null, dependsOn: [],
    parentId: null, branchFromStep: null, archived: false, ...over,
  }) as TaskRun;

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "skynet-gc-repo-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "skynet-gc-wt-"));
  execFileSync("git", ["init", "-b", "main", repo]);
  git("config", "user.email", "test@skynet.local");
  git("config", "user.name", "Test");
  writeFileSync(join(repo, "README.md"), "# base\n");
  git("add", "-A");
  git("commit", "-m", "base");
  process.env.STORE = "memory";
  process.env.BUS = "memory";
  process.env.SKYNET_INTEGRATION_REPO = repo;
  process.env.SKYNET_WORKTREES_DIR = worktreesDir;
  process.env.SKYNET_BASE_BRANCH = "main";
  delete process.env.RUNNER;
  ({ Hub } = await import("../apps/server/src/hub.js"));
  ({ Orchestrator } = await import("../apps/server/src/orchestrator.js"));
  ({ MemoryStore } = await import("../apps/server/src/store/memory.js"));
  ({ WorktreeProvisioner } = await import("../apps/server/src/worktrees.js"));
});
afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(worktreesDir, { recursive: true, force: true });
});

describe("worktree GC", () => {
  it("removes zombie worktrees, keeps live ones, deletes merged branches, keeps unmerged, surfaces limbo", async () => {
    const store = new MemoryStore({ seed: false });
    const hub = new Hub(store, new NullBus());
    const orch = new Orchestrator(store, hub);
    await store.putProject({
      id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [],
      status: "active", repoPath: null, gitBacked: false,
    } as Project);

    // Provision three worktrees exactly like the orchestrator's own provisioner
    // (same repo + root, so GC sees them as its own).
    const wt = new WorktreeProvisioner(repo, "main", worktreesDir);
    await wt.provision("r-live", "agent/r-live", {});
    await wt.provision("r-done", "agent/r-done", {});
    await wt.provision("r-ghost", "agent/r-ghost", {}); // no run in the store at all

    // A branch MERGED into the integration branch (its run is done) → deletable.
    // An UNMERGED branch with unique work (run also done) → must be kept.
    const scratch = mkdtempSync(join(tmpdir(), "skynet-gc-seed-"));
    execFileSync("git", ["-C", repo, "worktree", "add", "-b", "agent/merged", join(scratch, "m"), "main"]);
    writeFileSync(join(scratch, "m", "merged.txt"), "integrated\n");
    execFileSync("git", ["-C", join(scratch, "m"), "add", "-A"]);
    execFileSync("git", ["-C", join(scratch, "m"), "-c", "user.name=T", "-c", "user.email=t@t", "commit", "-m", "m"]);
    execFileSync("git", ["-C", repo, "worktree", "add", "-b", "agent/unmerged", join(scratch, "u"), "main"]);
    writeFileSync(join(scratch, "u", "unmerged.txt"), "precious unmerged work\n");
    execFileSync("git", ["-C", join(scratch, "u"), "add", "-A"]);
    execFileSync("git", ["-C", join(scratch, "u"), "-c", "user.name=T", "-c", "user.email=t@t", "commit", "-m", "u"]);
    execFileSync("git", ["-C", repo, "worktree", "remove", "--force", join(scratch, "m")]);
    execFileSync("git", ["-C", repo, "worktree", "remove", "--force", join(scratch, "u")]);
    git("branch", "skynet/integration/p1", "main");
    execFileSync("git", ["-C", repo, "worktree", "add", join(scratch, "i"), "skynet/integration/p1"]);
    execFileSync("git", ["-C", join(scratch, "i"), "-c", "user.name=T", "-c", "user.email=t@t", "merge", "--no-ff", "-m", "integrate", "agent/merged"]);
    execFileSync("git", ["-C", repo, "worktree", "remove", "--force", join(scratch, "i")]);
    rmSync(scratch, { recursive: true, force: true });

    const fourDaysAgo = Date.now() - 4 * 24 * 60 * 60 * 1000;
    await store.putRun(mkRun("r-live", "running"));
    await store.putRun(mkRun("r-done", "done"));
    await store.putRun(mkRun("r-merged", "done", { branch: "agent/merged" }));
    await store.putRun(mkRun("r-unmerged", "done", { branch: "agent/unmerged" }));
    await store.putRun(mkRun("r-limbo", "review", { branch: "agent/r-limbo", lastHeartbeatAt: fourDaysAgo }));

    const stats = await orch.gcWorktrees();

    // Zombies removed; the live run's worktree intact.
    expect(existsSync(wt.pathFor("r-live"))).toBe(true);
    expect(existsSync(wt.pathFor("r-done"))).toBe(false);
    expect(existsSync(wt.pathFor("r-ghost"))).toBe(false);
    expect(stats.worktreesRemoved).toBe(2);

    // Integrated branch deleted; the dead runs' zero-commit branches (tips ==
    // main == ancestor of the integration branch) are equally safe to drop.
    // Unmerged unique work is preserved; the live run's branch is kept.
    const branches = git("branch", "--list", "agent/*");
    expect(branches).not.toContain("agent/merged");
    expect(branches).not.toContain("agent/r-done");
    expect(branches).not.toContain("agent/r-ghost");
    expect(branches).toContain("agent/unmerged");
    expect(branches).toContain("agent/r-live");
    expect(stats.branchesDeleted).toBe(3);

    // Limbo surfaced (once), never deleted.
    expect(stats.limbo).toBe(1);
    const limbo = await store.getRun("r-limbo");
    const parked = limbo!.log.filter((l) => l.line.includes("parked in review"));
    expect(parked).toHaveLength(1);
    await orch.gcWorktrees(); // second sweep must not duplicate the warning
    const again = (await store.getRun("r-limbo"))!.log.filter((l) => l.line.includes("parked in review"));
    expect(again).toHaveLength(1);

    // The shared repo's own checkout was never touched.
    expect(git("branch", "--show-current")).toBe("main");
  });
});
