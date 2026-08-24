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
import { existsSync } from "node:fs";
import { mkdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { gitBin } from "./git-bin.js";

const exec = promisify(execFile);

// Files whose change (folding in main) means the worktree's deps may be stale.
const DEP_MANIFESTS = new Set(["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"]);

/** Infer the install command from the lockfile present, else npm. */
function pmInstallCmd(dir: string): string {
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm install";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn install";
  if (existsSync(join(dir, "bun.lockb"))) return "bun install";
  return "npm install";
}

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
    const { stdout } = await exec(gitBin(), ["-C", cwd, ...args]);
    return stdout.trim();
  }

  /** Worktree directory for an agent (id sanitized for the filesystem). */
  pathFor(runId: string): string {
    const safe = runId.replace(/[^a-zA-Z0-9._-]/g, "_");
    return isAbsolute(this.root) ? join(this.root, safe) : resolve(this.repo, this.root, safe);
  }

  /** True while this run's worktree is still checked out on disk (not yet
   *  retired) — i.e. there's a working directory to resume the run into. */
  exists(runId: string): boolean {
    return existsSync(this.pathFor(runId));
  }

  private async refExists(ref: string): Promise<boolean> {
    try {
      await this.git(this.repo, "rev-parse", "--verify", "--quiet", ref);
      return true;
    } catch {
      return false;
    }
  }

  /** Best-effort refresh of the base branch from origin, so `origin/<base>` is
   *  current before we branch/merge. No-op (swallowed) when the repo has no
   *  usable remote (a pure-local project) or is offline — callers then fall back
   *  to the local base branch. */
  async fetchBase(): Promise<void> {
    await this.git(this.repo, "fetch", "--quiet", "origin", this.baseBranch).catch(() => undefined);
  }

  /** The freshest base ref to cut from / sync to: the fetched `origin/<base>`
   *  when a remote gave us one, else the local base branch. */
  async freshBase(): Promise<string> {
    return (await this.refExists(`refs/remotes/origin/${this.baseBranch}`)) ? `origin/${this.baseBranch}` : this.baseBranch;
  }

  /** True when the latest base has commits the agent's branch doesn't — i.e. the
   *  branch is behind `main` and should sync. Used to flag stale in-flight runs. */
  async baseAheadOf(branch: string): Promise<boolean> {
    const base = await this.freshBase();
    if (!(await this.refExists(branch))) return false;
    // Exit 0 = base IS an ancestor of the branch (branch already has base = up to
    // date); non-zero = base has commits the branch lacks (behind).
    try {
      await this.git(this.repo, "merge-base", "--is-ancestor", base, branch);
      return false;
    } catch {
      return true;
    }
  }

  /**
   * Merge the latest base (`origin/<base>`) into an agent's worktree branch, so a
   * PR opens against current `main` (and conflicts surface HERE, not at merge
   * time). Fetches first. Returns `{ok:true}` on a clean merge; on conflict the
   * merge is ABORTED (worktree left clean) and `{ok:false, conflicts}` is returned
   * so the caller can escalate instead of pushing a broken branch.
   */
  async mergeBase(runId: string): Promise<{ ok: boolean; conflicts?: string[]; depsChanged?: boolean }> {
    const path = this.pathFor(runId);
    await this.fetchBase();
    const base = await this.freshBase();
    const before = await this.git(path, "rev-parse", "HEAD").catch(() => "");
    // A merge when already current is a harmless "Already up to date" no-op.
    try {
      await this.git(path, "-c", "user.name=Skynet", "-c", "user.email=skynet@local", "merge", "--no-edit", base);
      // Did folding in main touch a dependency manifest? (so the caller can
      // re-install — node_modules is gitignored, but a revise/checks/preview
      // running in this worktree afterward needs the new deps.)
      const after = await this.git(path, "rev-parse", "HEAD").catch(() => "");
      let depsChanged = false;
      if (before && after && before !== after) {
        const changed = (await this.git(path, "diff", "--name-only", before, after).catch(() => "")).split("\n");
        depsChanged = changed.some((f) => DEP_MANIFESTS.has(f.split("/").pop() ?? ""));
      }
      return { ok: true, depsChanged };
    } catch {
      const conflicts = (await this.git(path, "diff", "--name-only", "--diff-filter=U").catch(() => ""))
        .split("\n")
        .filter(Boolean);
      await this.git(path, "merge", "--abort").catch(() => undefined);
      return { ok: false, conflicts };
    }
  }

  /**
   * Re-install dependencies in an agent's worktree — for use after a mergeBase
   * that changed a dependency manifest. Only runs when node_modules already
   * exists (deps were installed for this run); otherwise there's nothing to
   * reconcile and we skip (the agent/preview installs on demand). Best-effort +
   * time-boxed; a failure is reported, never fatal (the PR's source is correct
   * regardless — node_modules is gitignored). */
  async installDeps(runId: string): Promise<{ installed: boolean; note?: string }> {
    const path = this.pathFor(runId);
    if (!existsSync(join(path, "node_modules"))) return { installed: false };
    const cmd = pmInstallCmd(path);
    try {
      await exec("/bin/sh", ["-c", cmd], { cwd: path, timeout: 3 * 60_000 });
      return { installed: true, note: cmd };
    } catch (err) {
      return { installed: false, note: `${cmd} failed: ${(err as Error).message}` };
    }
  }

  /**
   * Create an isolated worktree on a fresh `branch`. Fetches origin first, then
   * cuts from `opts.baseRef` when it exists (a fork's parent branch) else the
   * freshest base (`origin/<base>`) — so a new run always starts on latest main,
   * not a stale local branch. Cleans up any stale worktree/branch left by a prior
   * agent with the same id so provisioning is idempotent.
   */
  async provision(runId: string, branch: string, opts: ProvisionOpts = {}): Promise<ProvisionResult> {
    await mkdir(this.root, { recursive: true }).catch(() => undefined);
    const path = this.pathFor(runId);
    await this.fetchBase(); // refresh origin/<base> so a fresh run starts on latest main
    const baseRef = opts.baseRef && (await this.refExists(opts.baseRef)) ? opts.baseRef : await this.freshBase();

    // Clear anything stale at this path / branch name.
    await this.removePath(path);
    if (await this.refExists(`refs/heads/${branch}`)) {
      await this.git(this.repo, "branch", "-D", branch).catch(() => undefined);
    }

    await this.git(this.repo, "worktree", "add", "-b", branch, path, baseRef);
    return { cwd: path, branch, baseRef };
  }

  /**
   * Re-create a run's worktree from its EXISTING branch — the recovery path for
   * a resume/reassign whose worktree was cleaned up (reaper, restart, disk
   * hygiene) while the branch, and thus all committed work, survived in the
   * shared repo. Unlike {@link provision} this never deletes or re-cuts the
   * branch: it checks the branch out into a fresh worktree exactly as it stands.
   * Throws with a plain-language reason when the branch is gone too — the caller
   * surfaces that instead of spawning an agent into a nonexistent directory
   * (which fails with a misleading low-level error).
   */
  async reattach(runId: string, branch: string): Promise<{ cwd: string }> {
    if (!(await this.refExists(`refs/heads/${branch}`))) {
      throw new Error(`branch ${branch} no longer exists in the repo — its work is unrecoverable here`);
    }
    await mkdir(this.root, { recursive: true }).catch(() => undefined);
    const path = this.pathFor(runId);
    await this.removePath(path); // clear any stale/partial dir at this path
    // A pruned worktree can leave stale metadata claiming the branch is still
    // checked out, which would make `worktree add` refuse — clear it first.
    await this.git(this.repo, "worktree", "prune").catch(() => undefined);
    await this.git(this.repo, "worktree", "add", path, branch);
    return { cwd: path };
  }

  /**
   * Best-effort cleanup for a worktree whose PREVIOUS occupant was killed
   * mid-turn (an escalated run's agent, forcibly `stop()`-ed so the run can be
   * resumed/reassigned into the SAME worktree) rather than exiting normally.
   * A normal exit never leaves git mid-operation; a hard interrupt can, if the
   * killed process was itself in the middle of a `git merge`/`git rebase` (e.g.
   * an agent that got "stuck" BECAUSE a merge/rebase hit a conflict it didn't
   * know how to resolve — exactly the state a reassigned agent then inherits
   * with no idea it's there, and has to reverse-engineer via ad-hoc `git log`/
   * `git status`/`git fsck` archaeology before it can even start, sometimes
   * getting stuck the same way itself). Aborting is always safe here: any real
   * edits the agent made are plain working-tree changes, untouched by
   * `merge --abort`/`rebase --abort` — only the interrupted merge/rebase
   * ITSELF (which was never going to complete on its own) is undone. Never
   * touches uncommitted file changes. Returns which operation(s) were found
   * and aborted, for the caller to log/surface to the next agent.
   */
  async sanitizeInterrupted(runId: string): Promise<string[]> {
    const path = this.pathFor(runId);
    const cleaned: string[] = [];
    // Both fail harmlessly ("no merge/rebase in progress") when there's
    // nothing to abort — the .catch is the actual check, not error handling.
    await this.git(path, "merge", "--abort").then(
      () => cleaned.push("merge"),
      () => undefined,
    );
    await this.git(path, "rebase", "--abort").then(
      () => cleaned.push("rebase"),
      () => undefined,
    );
    return cleaned;
  }

  /**
   * Commit everything in the agent's worktree onto its branch — so the branch
   * carries the agent's diff regardless of whether the runner committed itself.
   * Returns committed:false when the worktree is clean (nothing to integrate).
   */
  async commitAll(runId: string, message: string): Promise<{ committed: boolean; sha?: string }> {
    const path = this.pathFor(runId);
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

  /** Current HEAD commit of the agent's worktree — e.g. for checkpointing after
   *  a {@link commitAll} that found nothing new (`sha` is only set when it
   *  actually committed; this always resolves the worktree's real HEAD). */
  async headSha(runId: string): Promise<string> {
    return this.git(this.pathFor(runId), "rev-parse", "HEAD");
  }

  /**
   * Pin a commit under a stable ref namespace outside `refs/heads/*` so it stays
   * reachable (never gc'd) even after the branch that produced it is deleted or
   * reset — e.g. a checkpoint's sha, which `provision()` may later branch-delete
   * out from under when a restore rewinds the run's branch to an EARLIER commit.
   */
  async pinRef(ref: string, sha: string): Promise<void> {
    await this.git(this.repo, "update-ref", ref, sha);
  }

  /** Added/deleted line counts + touched files of the branch vs its base ref. */
  async diffStat(runId: string, baseRef: string): Promise<DiffStat> {
    const path = this.pathFor(runId);
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

  /**
   * Full unified diff (patch) of the branch vs its base ref — the real change an
   * operator reviews. Best-effort; capped so a giant diff can't bloat the wire.
   */
  async patch(runId: string, baseRef: string, maxBytes = 200_000): Promise<string> {
    try {
      const { stdout } = await exec(gitBin(), ["-C", this.pathFor(runId), "diff", `${baseRef}...HEAD`], {
        maxBuffer: 8 * 1024 * 1024,
      });
      return stdout.length > maxBytes ? stdout.slice(0, maxBytes) + "\n… (diff truncated — review the full branch)" : stdout;
    } catch {
      return "";
    }
  }

  /** Retire the worktree (the branch is left for the merge queue / history). */
  async retire(runId: string): Promise<void> {
    await this.removePath(this.pathFor(runId));
  }

  // ── GC plumbing (see Orchestrator.gcWorktrees) ─────────────────────────────

  /**
   * Worktrees living under THIS provisioner's root — never the repo's own
   * checkout or anyone else's worktrees (the same repo may host the user's
   * unrelated worktrees; we only ever touch what we created).
   */
  /** Canonical root for path comparisons — git reports realpaths (e.g. macOS
   *  /var → /private/var), so prefix checks must compare like with like. */
  private async realRoot(): Promise<string> {
    const r = await realpath(this.root).catch(() => this.root);
    return r.endsWith("/") ? r : r + "/";
  }

  async list(): Promise<Array<{ path: string; branch: string | null }>> {
    const out = await this.git(this.repo, "worktree", "list", "--porcelain").catch(() => "");
    const all: Array<{ path: string; branch: string | null }> = [];
    let cur: { path: string; branch: string | null } | null = null;
    for (const line of out.split("\n")) {
      if (line.startsWith("worktree ")) {
        cur = { path: line.slice("worktree ".length).trim(), branch: null };
        all.push(cur);
      } else if (line.startsWith("branch ") && cur) {
        cur.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
      }
    }
    const root = await this.realRoot();
    return all.filter((w) => w.path.startsWith(root));
  }

  /** Remove a worktree by absolute path (GC of zombies whose run id is gone). */
  async removeAt(path: string): Promise<void> {
    const real = await realpath(path).catch(() => path);
    if (!real.startsWith(await this.realRoot())) return; // never reach outside our root
    await this.removePath(path);
  }

  /** `agent/*` branches fully merged into `mergedInto` (safe to delete). */
  async mergedAgentBranches(mergedInto: string): Promise<string[]> {
    if (!(await this.refExists(mergedInto))) return [];
    const out = await this.git(
      this.repo,
      "for-each-ref", "--format=%(refname:short)", "--merged", mergedInto, "refs/heads/agent",
    ).catch(() => "");
    return out.split("\n").filter(Boolean);
  }

  /** Delete a branch ref (only ever called for verified-merged agent branches). */
  async deleteBranch(name: string): Promise<void> {
    if (!name.startsWith("agent/")) return; // GC only ever deletes agent branches
    await this.git(this.repo, "branch", "-D", name).catch(() => undefined);
  }

  private async removePath(path: string): Promise<void> {
    // `git worktree remove` is the clean path; prune + rm covers stale/missing.
    await this.git(this.repo, "worktree", "remove", "--force", path).catch(() => undefined);
    await this.git(this.repo, "worktree", "prune").catch(() => undefined);
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
  }
}
