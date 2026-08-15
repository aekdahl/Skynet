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

export interface MergeRequest {
  runId: string;
  projectId: string;
  agentBranch: string;
  workspaceId: string;
  /** The task's Feature (Task.featureId). When set, the merge target is the
   *  Feature's shared branch instead of the project integration branch — every
   *  task under a Feature merges/tests together on that branch before the
   *  Feature merges up into the project base as a unit. */
  featureId?: string;
  /** Explicit merge target, overriding the featureId/projectId default. Used
   *  for the second-stage "Feature branch → project base" merge, where
   *  `agentBranch` IS the Feature branch and the target is the base branch
   *  itself — not another integration/feature branch. */
  targetOverride?: string;
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

  /** Naming sibling to {@link integrationBranch}: the shared branch every one
   *  of a Feature's task branches merges/tests into first, before the Feature
   *  itself merges up into the project base as a unit. */
  featureBranch(featureId: string): string {
    return `skynet/feature/${featureId}`;
  }

  /** Lazily create a Feature's branch (off {@link baseBranch}) if it doesn't
   *  exist yet, and return its name — so a task's worktree can branch FROM it
   *  before any sibling task has actually merged into it. Idempotent. */
  async ensureFeatureBranch(featureId: string): Promise<string> {
    const branch = this.featureBranch(featureId);
    await this.ensureBranch(branch);
    return branch;
  }

  enqueue(req: MergeRequest): void {
    // Stage 2 (targetOverride) merges straight to that branch; stage 1 targets
    // the task's Feature branch when it has one, else the project integration
    // branch — same queue, same serialization, just a different destination.
    const branch = req.targetOverride ?? (req.featureId ? this.featureBranch(req.featureId) : this.integrationBranch(req.projectId));
    const prev = this.chains.get(branch) ?? Promise.resolve();
    const next = prev
      .then(() => this.process(req, branch))
      // A crash anywhere in process() must surface, never silently vanish
      // (the old chain swallowed it → the run hung in review with no gate).
      .catch((err) => this.cb.onMergeFailed(req, gitReason(err)).catch(() => undefined));
    this.chains.set(branch, next);
  }

  private async ensureBranch(branch: string): Promise<void> {
    const exists = await this.git(this.repo, "branch", "--list", branch);
    if (!exists) await this.git(this.repo, "branch", branch, this.baseBranch);
  }

  /** Sanitized scratch worktree path for a merge target. Keyed by the TARGET
   *  branch (not the project) — chains now serialize per branch, so a project
   *  with several Feature branches merging concurrently must not have them
   *  race on the same scratch dir. The "integration-" prefix is load-bearing:
   *  the worktree GC sweep (orchestrator.gcWorktrees) skips paths with this
   *  prefix as self-managed merge-engine scratch, never a zombie run worktree. */
  private scratchFor(branch: string): string {
    return join(this.scratchRoot, `integration-${branch.replace(/[^a-zA-Z0-9._-]/g, "_")}`);
  }

  private async process(req: MergeRequest, branch: string): Promise<void> {
    this.cb.onLog(req.runId, `merge queue: integrating ${req.agentBranch} → ${branch}`);
    await this.ensureBranch(branch);

    // A fresh scratch worktree holding the target branch. --force covers a
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

      if (this.checkCmd) {
        // Run the operator-configured check under hard limits (timeout, output
        // cap, confined cwd, no inherited stdio) and refuse denylisted commands
        // outright. Env is preserved (an operator-set check needs the real
        // toolchain on PATH), unlike agent commands which are gated at approve.
        const bounce = async (output: string) => {
          await this.git(scratch, "reset", "--hard", "HEAD~1").catch(() => undefined); // undo the merge commit
          await this.cb.onChecksFailed(req, output);
        };
        try {
          assertApprovable(this.checkCmd);
        } catch (err) {
          if (err instanceof CommandDeniedError) {
            await bounce(`check command refused by safety policy: ${err.message}`);
            return;
          }
          throw err;
        }
        const res = await runBounded(this.checkCmd, {
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
