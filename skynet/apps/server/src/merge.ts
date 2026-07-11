// ─── Merge engine ─────────────────────────────────────────────────────────
// Integration via a serialized merge queue (VCS brief §5). On diff-approve the
// orchestrator enqueues an agent branch; the queue, one merge at a time per
// per-project integration branch, merges it, runs the project's checks, and
// commits — or, on a textual conflict, surfaces a `merge` HITL (§6).
//
// Operates on a real target repo (config.integrationRepo). When that's unset
// the orchestrator skips this entirely and keeps the Phase 0 complete-on-approve
// behavior, so mock+memory dev is unaffected.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface MergeRequest {
  runId: string;
  projectId: string;
  agentBranch: string;
  workspaceId: string;
}

export interface MergeCallbacks {
  /** Merge committed onto the integration branch. */
  onMerged(req: MergeRequest, integrationBranch: string): Promise<void>;
  /** Textual conflict — raise a `merge` HITL with the contested files. */
  onConflict(req: MergeRequest, conflictedFiles: string[]): Promise<void>;
  /** Project checks failed after merge — bounce back to the agent to revise. */
  onChecksFailed(req: MergeRequest, output: string): Promise<void>;
  /** Progress/info line for the agent's log. */
  onLog(runId: string, line: string): void;
}

export class MergeEngine {
  // One promise chain per integration branch → serialized merges.
  private chains = new Map<string, Promise<void>>();

  constructor(
    private repo: string,
    private baseBranch: string,
    private cb: MergeCallbacks,
    private checkCmd?: string,
  ) {}

  private async git(...args: string[]): Promise<string> {
    const { stdout } = await exec("git", ["-C", this.repo, ...args]);
    return stdout.trim();
  }

  integrationBranch(projectId: string): string {
    return `skynet/integration/${projectId}`;
  }

  enqueue(req: MergeRequest): void {
    const branch = this.integrationBranch(req.projectId);
    const prev = this.chains.get(branch) ?? Promise.resolve();
    const next = prev.then(() => this.process(req, branch)).catch(() => undefined);
    this.chains.set(branch, next);
  }

  private async ensureIntegrationBranch(branch: string): Promise<void> {
    const exists = await this.git("branch", "--list", branch);
    if (!exists) await this.git("branch", branch, this.baseBranch);
  }

  private async process(req: MergeRequest, branch: string): Promise<void> {
    this.cb.onLog(req.runId, `merge queue: integrating ${req.agentBranch} → ${branch}`);
    await this.ensureIntegrationBranch(branch);
    await this.git("checkout", branch);

    try {
      await this.git("merge", "--no-ff", "-m", `Merge ${req.agentBranch} (agent ${req.runId})`, req.agentBranch);
    } catch {
      // Conflict — capture the contested files, abort cleanly, escalate.
      let conflicted: string[] = [];
      try {
        const out = await this.git("diff", "--name-only", "--diff-filter=U");
        conflicted = out ? out.split("\n").filter(Boolean) : [];
      } catch {
        /* ignore */
      }
      await this.git("merge", "--abort").catch(() => undefined);
      this.cb.onLog(req.runId, `merge conflict in ${conflicted.length} file(s) — escalating`);
      await this.cb.onConflict(req, conflicted);
      return;
    }

    if (this.checkCmd) {
      try {
        await exec("/bin/sh", ["-c", this.checkCmd], { cwd: this.repo });
      } catch (err) {
        // Undo the merge commit; bounce back to the agent.
        await this.git("reset", "--hard", "HEAD~1").catch(() => undefined);
        await this.cb.onChecksFailed(req, (err as { stderr?: string }).stderr ?? "checks failed");
        return;
      }
    }

    this.cb.onLog(req.runId, `merged ${req.agentBranch} into ${branch}`);
    await this.cb.onMerged(req, branch);
  }
}
