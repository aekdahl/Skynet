// ─── Worktree provisioning ──────────────────────────────────────────────────
// Branch-per-agent in an isolated git worktree (VCS model §2). One runner ⇄ one
// worktree ⇄ one branch: "provision a runner" = create the worktree, "retire" =
// remove it. Worktrees share the canonical repo's object store, so agent
// branches are cheap to spin up and the integration branch stays visible for the
// merge queue (merge.ts) to integrate into.
//
// This is the layer that produces *real* agent branches with committed work for
// the merge engine to consume. Active only when an integration repo is
// configured; otherwise the orchestrator points runners at config.runnerCwd and
// the Phase 0 (mock + memory) flow is untouched.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const exec = promisify(execFile);

export interface ProvisionOpts {
  /** Preferred ref to branch from — the project's integration branch for a
   *  fresh agent, or a parent agent's branch for a fork (family-internal
   *  integration, §7). Falls back to the base branch if the ref doesn't exist. */
  baseRef?: string;
}

export interface ProvisionResult {
  /** Absolute path the runner executes in (its private working copy). */
  cwd: string;
  /** The agent branch that was created. */
  branch: string;
  /** The ref the branch was actually cut from (for later diffing). */
  baseRef: string;
}

export interface DiffStat {
  add: number;
  del: number;
  files: string[];
}

export class WorktreeProvisioner {
  /** Effective root that per-agent worktrees live under. */
  readonly root: string;

  constructor(
    private repo: string,
    private baseBranch: string,
    root?: string,
  ) {
    // Default outside the repo so worktree files never show up as untracked.
    this.root = root
      ? resolve(root)
      : resolve(repo, "..", ".skynet-worktrees");
  }

  private async git(cwd: string, ...args: string[]): Promise<string> {
    const { stdout } = await exec("git", ["-C", cwd, ...args]);
    return stdout.trim();
  }

  /** Worktree directory for an agent (id sanitized for the filesystem). */
  pathFor(agentId: string): string {
    const safe = agentId.replace(/[^a-zA-Z0-9._-]/g, "_");
    return isAbsolute(this.root) ? join(this.root, safe) : resolve(this.repo, this.root, safe);
  }

  private async refExists(ref: string): Promise<boolean> {
    try {
      await this.git(this.repo, "rev-parse", "--verify", "--quiet", ref);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create an isolated worktree on a fresh `branch`, cut from `opts.baseRef`
   * (when it exists) else the base branch. Cleans up any stale worktree/branch
   * left by a prior agent with the same id so provisioning is idempotent.
   */
  async provision(agentId: string, branch: string, opts: ProvisionOpts = {}): Promise<ProvisionResult> {
    await mkdir(this.root, { recursive: true }).catch(() => undefined);
    const path = this.pathFor(agentId);
    const baseRef = opts.baseRef && (await this.refExists(opts.baseRef)) ? opts.baseRef : this.baseBranch;

    // Clear anything stale at this path / branch name.
    await this.removePath(path);
    if (await this.refExists(`refs/heads/${branch}`)) {
      await this.git(this.repo, "branch", "-D", branch).catch(() => undefined);
    }

    await this.git(this.repo, "worktree", "add", "-b", branch, path, baseRef);
    return { cwd: path, branch, baseRef };
  }

  /**
   * Commit everything in the agent's worktree onto its branch — so the branch
   * carries the agent's diff regardless of whether the runner committed itself.
   * Returns committed:false when the worktree is clean (nothing to integrate).
   */
  async commitAll(agentId: string, message: string): Promise<{ committed: boolean; sha?: string }> {
    const path = this.pathFor(agentId);
    const status = await this.git(path, "status", "--porcelain");
    if (!status) return { committed: false };
    await this.git(path, "add", "-A");
    // Inline identity so this never depends on global git config.
    await this.git(
      path,
      "-c", "user.name=Skynet",
      "-c", "user.email=skynet@local",
      "commit", "-m", message,
    );
    const sha = await this.git(path, "rev-parse", "HEAD");
    return { committed: true, sha };
  }

  /** Added/deleted line counts + touched files of the branch vs its base ref. */
  async diffStat(agentId: string, baseRef: string): Promise<DiffStat> {
    const path = this.pathFor(agentId);
    const stat: DiffStat = { add: 0, del: 0, files: [] };
    try {
      const out = await this.git(path, "diff", "--numstat", `${baseRef}...HEAD`);
      for (const line of out.split("\n").filter(Boolean)) {
        const [a, d, f] = line.split("\t");
        stat.add += Number(a) || 0;
        stat.del += Number(d) || 0;
        if (f) stat.files.push(f);
      }
    } catch {
      /* ignore — diff is best-effort metadata for the review */
    }
    return stat;
  }

  /** Retire the worktree (the branch is left for the merge queue / history). */
  async retire(agentId: string): Promise<void> {
    await this.removePath(this.pathFor(agentId));
  }

  private async removePath(path: string): Promise<void> {
    // `git worktree remove` is the clean path; prune + rm covers stale/missing.
    await this.git(this.repo, "worktree", "remove", "--force", path).catch(() => undefined);
    await this.git(this.repo, "worktree", "prune").catch(() => undefined);
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
  }
}
