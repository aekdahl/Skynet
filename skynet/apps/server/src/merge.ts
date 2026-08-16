// ─── Merge engine ─────────────────────────────────────────────────────────
// Integration via a serialized merge queue (VCS brief §5). On diff-approve the
// orchestrator enqueues an agent branch; the queue, one merge at a time per
// per-project integration branch, merges it, runs the project's checks, and
// commits — or, on a textual conflict, surfaces a `merge` HITL (§6).
//
// The merge runs in a SCRATCH WORKTREE of the integration branch — the engine
// never checks out branches in the shared repo itself. On the desktop that repo
// is the user's live checkout (often sitting dirty on main): flipping its
// branches broke the user's working copy, and a dirty tree made `git merge`
// fail for NON-conflict reasons, which the old code misreported as a
// "Merge conflict — 0 files" phantom gate and re-raised on every retry
// (sim-judge finding: runaway gate generation). Non-conflict failures now
// surface through onMergeFailed with git's actual error.
//
// Operates on a real target repo (config.integrationRepo). When that's unset
// the orchestrator skips this entirely and keeps the Phase 0 complete-on-approve
// behavior, so mock+memory dev is unaffected.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { assertApprovable, CommandDeniedError, runBounded } from "./command-safety.js";
import { gitBin } from "./git-bin.js";

const exec = promisify(execFile);

/** Branch namespace for feature-scoped branch batching's shared per-feature
 *  branches — exported so callers (orchestrator.ts) can recognize a request
 *  whose SOURCE is a feature branch (the "merge the feature branch up into
 *  the project's integration branch" step) without duplicating the literal. */
export const FEATURE_BRANCH_PREFIX = "skynet/feature/";

export interface MergeRequest {
  runId: string;
  projectId: string;
  agentBranch: string;
  workspaceId: string;
  // Feature-scoped branch batching: when set, this merge's DESTINATION is the
  // shared `skynet/feature/<featureId>` branch instead of the project's default
  // integration branch — see `targetBranchFor`. Unset for the reverse step (the
  // feature branch merging UP into the project's integration branch): that's a
  // normal request whose `agentBranch` happens to be the feature branch name.
  featureId?: string;
  // Effective check command for this run's PROJECT, already resolved (project
  // override, else the workspace-global default) at enqueue time. Threaded per-
  // request rather than baked into the engine at construction: a MergeEngine is
  // cached per (repo, baseBranch) and shared across every project on that repo,
  // so a project-level override can't live on `this.checkCmd` without either
  // colliding with another project sharing the cache key or going stale after
  // an operator edits it. Undefined → fall back to `this.checkCmd`.
  checkCmd?: string;
}

export interface MergeCallbacks {
  /** Merge committed onto the integration branch. */
  onMerged(req: MergeRequest, integrationBranch: string): Promise<void>;
  /** Textual conflict — raise a `merge` HITL with the contested files. */
  onConflict(req: MergeRequest, conflictedFiles: string[]): Promise<void>;
  /** Project checks failed after merge — bounce back to the agent to revise. */
  onChecksFailed(req: MergeRequest, output: string): Promise<void>;
  /**
   * The merge could not run at all (missing branch, repo state, git error) —
   * NOT a textual conflict. Distinct so the operator sees the real reason
   * instead of a nonsensical "conflict in 0 files".
   */
  onMergeFailed(req: MergeRequest, reason: string): Promise<void>;
  /** Progress/info line for the agent's log. */
  onLog(runId: string, line: string): void;
}

/** First meaningful line of a git error, for a human-readable gate/log. */
const gitReason = (err: unknown): string => {
  const e = err as { stderr?: string; message?: string };
  const text = (e.stderr || e.message || String(err)).trim();
  const line = text.split("\n").find((l) => l.trim()) ?? "unknown git error";
  return line.replace(/^(fatal|error):\s*/i, "").slice(0, 200);
};

export class MergeEngine {
  // One promise chain per integration branch → serialized merges.
  private chains = new Map<string, Promise<void>>();
  /** Where scratch integration worktrees live (outside the repo working tree). */
  private scratchRoot: string;

  constructor(
    private repo: string,
    private baseBranch: string,
    private cb: MergeCallbacks,
    // Workspace-global default; per-project overrides ride MergeRequest.checkCmd
    // instead (see its doc comment for why).
    private checkCmd?: string,
    scratchRoot?: string,
  ) {
    this.scratchRoot = scratchRoot
      ? isAbsolute(scratchRoot)
        ? scratchRoot
        : resolve(repo, scratchRoot)
      : resolve(repo, "..", ".skynet-worktrees");
  }

  private async git(cwd: string, ...args: string[]): Promise<string> {
    const { stdout } = await exec(gitBin(), ["-C", cwd, ...args]);
    return stdout.trim();
  }

  integrationBranch(projectId: string): string {
    return `skynet/integration/${projectId}`;
  }

  /** Added/deleted line counts + touched files of `branch` vs `base` — read
   *  directly against the shared repo, no worktree needed (unlike a per-run
   *  worktree diff, a branch-to-branch diff doesn't require anything checked
   *  out). Used for feature-scoped branch batching's aggregate PR: the safety
   *  preflight and PR body need real changed-files for a feature branch that
   *  has no dedicated per-run worktree of its own. Best-effort, mirrors
   *  WorktreeProvisioner.diffStat's shape. */
  async diffStat(branch: string, base: string): Promise<{ add: number; del: number; files: string[] }> {
    const stat = { add: 0, del: 0, files: [] as string[] };
    try {
      const out = await this.git(this.repo, "diff", "--numstat", `${base}...${branch}`);
      for (const line of out.split("\n").filter(Boolean)) {
        const [a, d, f] = line.split("\t");
        stat.add += Number(a) || 0;
        stat.del += Number(d) || 0;
        if (f) stat.files.push(f);
      }
    } catch {
      /* best-effort — a missing branch/ref just yields an empty stat */
    }
    return stat;
  }

  /** The merge DESTINATION for a request — the project's default integration
   *  branch, or (feature-scoped branch batching) a shared per-feature branch
   *  when `req.featureId` is set. Generalizes `integrationBranch` so a single
   *  project can have several merges in flight against different targets
   *  (its own integration branch, plus any number of feature branches) —
   *  each gets its own serialized chain (see `enqueue`) and scratch worktree
   *  (see `scratchFor`), so they never collide. */
  targetBranchFor(req: MergeRequest): string {
    return req.featureId ? `${FEATURE_BRANCH_PREFIX}${req.featureId}` : this.integrationBranch(req.projectId);
  }

  enqueue(req: MergeRequest): void {
    const branch = this.targetBranchFor(req);
    const prev = this.chains.get(branch) ?? Promise.resolve();
    const next = prev
      .then(() => this.process(req, branch))
      // A crash anywhere in process() must surface, never silently vanish
      // (the old chain swallowed it → the run hung in review with no gate).
      .catch((err) => this.cb.onMergeFailed(req, gitReason(err)).catch(() => undefined));
    this.chains.set(branch, next);
  }

  private async ensureIntegrationBranch(branch: string): Promise<void> {
    const exists = await this.git(this.repo, "branch", "--list", branch);
    if (!exists) await this.git(this.repo, "branch", branch, this.baseBranch);
  }

  /** Sanitized scratch worktree path for a merge TARGET branch. Keyed by the
   *  branch, not just the project — a project can have several targets in
   *  flight at once (its integration branch, plus any feature branches), each
   *  already on its own serialized chain (see `enqueue`); a shared scratch
   *  path keyed only by projectId would let two of those `git worktree add`
   *  the same path concurrently and corrupt one or both. */
  private scratchFor(branch: string): string {
    return join(this.scratchRoot, `integration-${branch.replace(/[^a-zA-Z0-9._-]/g, "_")}`);
  }

  private async process(req: MergeRequest, branch: string): Promise<void> {
    this.cb.onLog(req.runId, `merge queue: integrating ${req.agentBranch} → ${branch}`);
    await this.ensureIntegrationBranch(branch);

    // A fresh scratch worktree holding the integration branch. --force covers a
    // leftover checkout of the branch elsewhere (e.g. pre-fix state where the
    // engine used to check it out in the shared repo).
    const scratch = this.scratchFor(branch);
    await this.git(this.repo, "worktree", "remove", "--force", scratch).catch(() => undefined);
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    await this.git(this.repo, "worktree", "add", "--force", scratch, branch);

    try {
      try {
        await this.git(
          scratch,
          "-c", "user.name=Skynet",
          "-c", "user.email=skynet@local",
          "merge", "--no-ff", "-m", `Merge ${req.agentBranch} (agent ${req.runId})`, req.agentBranch,
        );
      } catch (err) {
        // Distinguish a TEXTUAL CONFLICT (unmerged paths present) from a merge
        // that couldn't run at all — the latter is an infra/state error and
        // must not masquerade as a "conflict in 0 files".
        let conflicted: string[] = [];
        try {
          const out = await this.git(scratch, "diff", "--name-only", "--diff-filter=U");
          conflicted = out ? out.split("\n").filter(Boolean) : [];
        } catch {
          /* ignore */
        }
        await this.git(scratch, "merge", "--abort").catch(() => undefined);
        if (conflicted.length > 0) {
          this.cb.onLog(req.runId, `merge conflict in ${conflicted.length} file(s) — escalating`);
          await this.cb.onConflict(req, conflicted);
        } else {
          const reason = gitReason(err);
          this.cb.onLog(req.runId, `merge failed (not a conflict): ${reason}`);
          await this.cb.onMergeFailed(req, reason);
        }
        return;
      }

      const checkCmd = req.checkCmd ?? this.checkCmd;
      if (checkCmd) {
        // Run the operator-configured check under hard limits (timeout, output
        // cap, confined cwd, no inherited stdio) and refuse denylisted commands
        // outright. Env is preserved (an operator-set check needs the real
        // toolchain on PATH), unlike agent commands which are gated at approve.
        const bounce = async (output: string) => {
          await this.git(scratch, "reset", "--hard", "HEAD~1").catch(() => undefined); // undo the merge commit
          await this.cb.onChecksFailed(req, output);
        };
        try {
          assertApprovable(checkCmd);
        } catch (err) {
          if (err instanceof CommandDeniedError) {
            await bounce(`check command refused by safety policy: ${err.message}`);
            return;
          }
          throw err;
        }
        const res = await runBounded(checkCmd, {
          cwd: scratch,
          env: process.env as Record<string, string>,
        });
        if (res.code !== 0 || res.timedOut) {
          await bounce(res.timedOut ? "checks timed out" : res.stderr || res.stdout || "checks failed");
          return;
        }
      }

      this.cb.onLog(req.runId, `merged ${req.agentBranch} into ${branch}`);
      await this.cb.onMerged(req, branch);
    } finally {
      // The commit lives on the branch ref; the scratch checkout is disposable.
      await this.git(this.repo, "worktree", "remove", "--force", scratch).catch(() => undefined);
    }
  }
}
