// ─── Orchestrator ─────────────────────────────────────────────────────────
// TaskRun lifecycle (Backend Brief §04): provision a runner, start an agent on a
// task, route HITL gates, deliver decisions, fork, complete. Phase 0 uses the
// mock runner; real providers drop in behind the same runner-sdk interface.

import type { TaskRun, HitlItem, Project, Resolution, Agent, Task } from "@skynet/shared";
import {
  type HitlRaise,
  type RunnerEvents,
  type RunnerHandle,
  type RunnerProvider,
} from "@skynet/runner-sdk";
import { config, now } from "./config.js";
import { githubService } from "./github/index.js";
import type { Hub } from "./hub.js";
import { MergeEngine, type MergeRequest } from "./merge.js";
import { loadModuleMap, type ModuleMap } from "./modules-map.js";
import { providerUsableFromEnv } from "./provider-env.js";
import { secretService } from "./secrets/index.js";
import { previewService } from "./preview/index.js";
import type { Store } from "./store/store.js";
import { WorktreeProvisioner } from "./worktrees.js";

interface LiveAgent {
  handle: RunnerHandle;
  agentId: string | null;
  taskId: string | null;
  /** The agent's branch (used as its merge-queue source). */
  branch: string;
  /** Set when the agent runs in a real worktree; enables the commit→review→merge
   *  loop. The ref the branch was cut from, for diffing. */
  baseRef?: string;
  /** The git backend (worktrees + merge queue) this agent is integrating into,
   *  resolved from its project's repo. Unset in the Phase 0 / no-repo flow. */
  git?: GitContext;
  /** Set when a question this agent raised went unanswered and was auto-resolved
   *  by the no-operator-answer timeout. If it then finishes with no change, it's
   *  surfaced as needs-attention rather than a silent "done". */
  blockedUnanswered?: boolean;
}

/** The git integration backend bound to one repo: an isolated worktree per agent
 *  feeding a serialized merge queue. Resolved per project (its own local repo
 *  when git-backed, else the server-global integration repo) and cached by repo
 *  path so each repo keeps exactly one worktree provisioner + one merge queue. */
interface GitContext {
  repo: string;
  worktrees: WorktreeProvisioner;
  merge: MergeEngine;
}

export class NoCapacityError extends Error {
  constructor() {
    super("No idle runner available");
    this.name = "NoCapacityError";
  }
}

/** No runner can execute — the fleet is empty, or the executor has no API key.
 *  The route maps this to 409 so agent creation is refused rather than spawning
 *  an agent that can only fail. */
export class RunnerNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerNotConfiguredError";
  }
}

/** A task can't be assigned because it's already handled (assigned or done). The
 *  route maps this to 409 so a double-assign is rejected, never double-spawned. */
export class TaskAlreadyAssignedError extends Error {
  constructor(message: string, readonly agent?: TaskRun) {
    super(message);
    this.name = "TaskAlreadyAssignedError";
  }
}

export class Orchestrator {
  private live = new Map<string, LiveAgent>();
  private chatWaiters = new Map<string, (reply: string) => void>();
  // Pending no-operator-answer timers for open `question` HITLs, keyed by item id.
  private questionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private seq = 0;
  // Serializes runner acquisition (find-idle → mark-busy). The find and the busy
  // write are separated by an `await`, so without this two concurrent acquires
  // could both observe the SAME idle runner and hand it to two agents (TOCTOU
  // double-booking). Every acquire chains onto this promise so the read-check-
  // write runs atomically; a busy-marked runner is persisted before the next
  // acquire's find() reads, so it can never be re-selected. Mirrors the Hub's
  // per-hitl-id resolve mutex.
  private acquireLock: Promise<unknown> = Promise.resolve();
  // One lazily-loaded provider backend per provider id (real backends are heavy).
  private providers = new Map<string, Promise<RunnerProvider>>();
  private moduleMap: ModuleMap = loadModuleMap(config.integrationRepo);
  // One git backend per repo path (worktrees + serialized merge queue), built on
  // demand. Keyed by repo so a project's local repo and the global integration
  // repo each get their own queue.
  private gitCtx = new Map<string, GitContext>();
  // Runs parked at a diff review, keyed by runId. The live entry is dropped when
  // a review is raised (compute is freed while a human reviews), so this holds
  // the little that a `modify` needs to resume the run for a revision in its
  // still-present worktree (see reviseAfterReview / deliver()). Cleared on merge.
  private reviews = new Map<string, { git: GitContext; baseRef: string; taskId: string | null }>();

  // `providerOverride` is a test seam — inject a runner provider directly instead
  // of resolving the runner's own provider. Production always passes (store, hub) only.
  constructor(private store: Store, private hub: Hub, private providerOverride?: RunnerProvider) {}

  /** Build (or reuse) the git backend for a repo path. Cached so each repo keeps
   *  exactly one worktree provisioner and one serialized merge queue (§2). */
  private gitContextForRepo(repo: string): GitContext {
    let ctx = this.gitCtx.get(repo);
    if (!ctx) {
      const worktrees = new WorktreeProvisioner(repo, config.baseBranch, config.worktreesDir);
      const merge = new MergeEngine(
        repo,
        config.baseBranch,
        {
          onMerged: (req) => this.completeMerged(req.runId, req.agentBranch),
          onConflict: (req, files) => this.raiseMergeHitl(req, files),
          onChecksFailed: async (req, out) => {
            await this.hub.runLog(req.runId, `checks failed: ${out.slice(0, 200)}`);
            await this.hub.runStatus(req.runId, "review");
          },
          onLog: (id, line) => void this.hub.runLog(id, line),
        },
        config.checkCmd,
      );
      ctx = { repo, worktrees, merge };
      this.gitCtx.set(repo, ctx);
    }
    return ctx;
  }

  /** Resolve the git backend for a project: its own local repo when git-backed,
   *  else the server-global integration repo, else none (Phase 0 → runnerCwd). */
  private gitContextFor(project?: Project | null): GitContext | undefined {
    const repo = project?.gitBacked && project.repoPath ? project.repoPath : config.integrationRepo;
    return repo ? this.gitContextForRepo(repo) : undefined;
  }

  /** Resolve the git backend for an existing agent (prefers the live entry, else
   *  looks it up via the agent's project). Used by post-completion cleanup. */
  private async gitContextForAgent(runId: string): Promise<GitContext | undefined> {
    const live = this.live.get(runId);
    if (live?.git) return live.git;
    const agent = await this.store.getRun(runId);
    const project = agent ? await this.store.getProject(agent.projectId) : null;
    return this.gitContextFor(project);
  }

  // Resolve the execution backend for an agent. The provider is the fleet
  // runner's own provider (runner.provider) — there is no global override and no
  // mock. Real backends load on demand (heavy) and are cached per id.
  private getProvider(id: string): Promise<RunnerProvider> {
    // Test seam: an injected provider short-circuits resolution.
    if (this.providerOverride) return Promise.resolve(this.providerOverride);
    let p = this.providers.get(id);
    if (!p) {
      p = (() => {
        switch (id) {
          case "claude":
            return import("@skynet/runner-sdk/claude").then((m) => new m.ClaudeRunnerProvider());
          case "codex":
            return import("@skynet/runner-sdk/codex").then((m) => new m.CodexRunnerProvider());
          case "gemini":
            return import("@skynet/runner-sdk/gemini").then((m) => new m.GeminiRunnerProvider());
          case "cursor":
            return import("@skynet/runner-sdk/cursor").then((m) => new m.CursorRunnerProvider());
          case "copilot":
            return import("@skynet/runner-sdk/copilot").then((m) => new m.CopilotRunnerProvider());
          case "hermes":
            return import("@skynet/runner-sdk/hermes").then((m) => new m.HermesRunnerProvider());
          default:
            // An unresolvable provider is a loud error — there is no mock fallback.
            return Promise.reject(new Error(`Unknown runner provider "${id}" (expected claude|codex|gemini|cursor|copilot|hermes).`));
        }
      })();
      this.providers.set(id, p);
    }
    return p;
  }

  private slug(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32);
  }

  private events(): RunnerEvents {
    return {
      onLog: (runId, line, detail) => void this.hub.runLog(runId, line, detail),
      onProgress: (runId, progress, plan) => void this.hub.runProgress(runId, progress, plan),
      onUsage: (runId, usage) => void this.hub.runUsage(runId, usage),
      onHeartbeat: (runId) => void this.hub.runHeartbeat(runId),
      // "done" is the ORCHESTRATOR's decision, made in complete()/completeMerged
      // only AFTER a finished agent's diff has been committed → reviewed → merged
      // (or confirmed genuinely empty). A runner that flips itself to "done" on
      // finish() would mark the agent done while its edits are still uncommitted;
      // an observer polling that window sees a premature "done" with an empty diff
      // and the work looks silently dropped. Ignore a runner-emitted "done" here —
      // onCompleted drives the real terminal transition. Other statuses
      // (running/waiting/review) pass through unchanged.
      onStatus: (runId, status) => {
        if (status === "done") return;
        void this.hub.runStatus(runId, status);
      },
      onHitl: (runId, raise) => void this.raise(runId, raise),
      onCompleted: (runId, branch) => void this.complete(runId, branch),
      onFailed: (runId, reason) => void this.fail(runId, reason),
      onChatReply: (runId, text) => {
        const waiter = this.chatWaiters.get(runId);
        if (waiter) {
          waiter(text);
          this.chatWaiters.delete(runId);
        }
        void this.hub.runLog(runId, `↳ ${text}`);
      },
    };
  }

  private async raise(runId: string, raise: HitlRaise): Promise<void> {
    const agent = await this.store.getRun(runId);
    if (!agent) return;
    // A clarifying `question` gets an optional no-operator-answer deadline so a
    // headless/idle run doesn't hang forever waiting on a human (0 = disabled).
    const timeout = config.hitlQuestionTimeoutMs;
    const expiresAt = raise.kind === "question" && timeout > 0 ? now() + timeout : null;
    const item: HitlItem = {
      id: `q-${runId}-${++this.seq}`,
      workspaceId: agent.workspaceId,
      runId,
      kind: raise.kind,
      title: raise.title,
      why: raise.why,
      risk: raise.risk,
      raisedAt: now(),
      expiresAt,
      resolvedAt: null,
      resolution: null,
      command: raise.command ?? null,
      options: raise.options ?? null,
      recommended: raise.recommended ?? null,
      steps: raise.steps ?? null,
      diff: raise.diff ?? null,
    };
    await this.hub.raiseHitl(item);
    if (expiresAt != null) {
      this.questionTimers.set(item.id, setTimeout(() => void this.expireQuestion(item), timeout));
    }
  }

  /** No operator answered a `question` within its window: auto-resolve it as
   *  "no answer" through the normal resolve→deliver path so the audit records it,
   *  the Inbox clears, and the agent is told to conclude WITHOUT guessing. */
  private async expireQuestion(item: HitlItem): Promise<void> {
    this.questionTimers.delete(item.id);
    const current = await this.store.getHitl(item.id);
    if (!current || current.resolvedAt != null) return; // a human got there first
    const resolution: Resolution = {
      action: "reject",
      optionIndex: null,
      guidance: null,
      by: "system:timeout",
      at: now(),
    };
    const resolved = await this.hub.resolveHitl(item.id, resolution);
    if (resolved && resolved.resolution?.at === resolution.at) {
      // Remember the agent concluded only because its question went unanswered,
      // so complete() can surface it as needs-attention instead of "done".
      const live = this.live.get(item.runId);
      if (live) live.blockedUnanswered = true;
      await this.hub.runLog(
        item.runId,
        `no operator answer within ${Math.round(config.hitlQuestionTimeoutMs / 1000)}s — asking the agent to conclude without guessing`,
      );
      await this.deliver(item, resolution);
    }
  }

  private async complete(runId: string, branch: string): Promise<void> {
    const live = this.live.get(runId);

    // Real loop: the agent ran in an isolated worktree → commit its diff onto
    // its branch and raise a review. Approving it enqueues the branch onto the
    // merge queue (deliver → merge.enqueue → completeMerged).
    if (live?.git && live.baseRef !== undefined) {
      const wt = live.git.worktrees;
      const agent = await this.store.getRun(runId);
      const res = await wt
        .commitAll(runId, `Skynet agent ${runId}${agent ? `: ${agent.name}` : ""}`)
        .catch((err) => {
          void this.hub.runLog(runId, `commit failed: ${(err as Error).message}`);
          // A git error is NOT "nothing to integrate" — the agent may have real
          // edits we simply couldn't commit. Falling through to done would drop
          // them silently, so surface it for attention instead.
          return { committed: false, error: true } as const;
        });

      if (res.committed) {
        const stat = await wt.diffStat(runId, live.baseRef);
        await this.freeRunner(live.agentId); // compute is done; awaiting review
        await this.hub.runStatus(runId, "review");
        // The run produced a diff → its task enters the review column (a human or
        // an autonomous reviewer resolves the diff HITL, which merges → done).
        if (live.taskId) {
          const task = await this.store.getTask(live.taskId);
          if (task) await this.hub.upsertTask({ ...task, state: "review" });
        }
        await this.raiseDiffReview(runId, stat);
        // Keep what a `modify` review resolution needs to resume this run for a
        // revision — its worktree survives (retire only happens on merge).
        this.reviews.set(runId, { git: live.git, baseRef: live.baseRef, taskId: live.taskId });
        this.live.delete(runId);
        return;
      }

      if ("error" in res && res.error) {
        // Couldn't commit a finished agent's worktree — needs-attention, never a
        // silent "done" that would lose the (possibly real) uncommitted work.
        await this.freeRunner(live.agentId);
        await this.hub.runStatus(runId, "review");
        this.live.delete(runId);
        return;
      }

      // Nothing to integrate — retire the worktree and complete plainly.
      await this.hub.runLog(runId, "no changes to integrate");
      await wt.retire(runId).catch(() => undefined);
    } else if (live?.git) {
      await live.git.worktrees.retire(runId).catch(() => undefined);
    }

    // Reached here with no diff. If the agent only stopped because a question it
    // raised went unanswered, it did no real work — surface it as needs-attention
    // (never a silent "done"), leave its task open, and don't mark it completed.
    if (live?.blockedUnanswered) {
      await this.freeRunner(live.agentId);
      await this.hub.runStatus(runId, "review");
      await this.hub.runLog(runId, "concluded without an answer to its question — needs attention (no change made)");
      this.live.delete(runId);
      return;
    }

    // Phase 0 / no-diff completion: free the runner, finish the task & agent.
    // The orchestrator sets "done" HERE (not the runner) — this is the only place
    // a genuinely change-free agent becomes terminal, so a runner's own "done" is
    // ignored (see events().onStatus) and can never precede real integration.
    await this.freeRunner(live?.agentId ?? null);
    if (live?.taskId) {
      const task = await this.store.getTask(live.taskId);
      if (task) await this.hub.upsertTask({ ...task, state: "done" });
    }
    await this.hub.runStatus(runId, "done");
    await this.hub.runCompleted(runId, branch);
    this.live.delete(runId);
  }

  /**
   * A runner could not execute (binary missing, auth failure, crash). Surface it
   * loudly and free the runner — but never mark the agent done, complete the
   * task, or integrate a branch. A broken runner must not look like success.
   */
  private async fail(runId: string, reason: string): Promise<void> {
    const live = this.live.get(runId);
    await this.freeRunner(live?.agentId ?? null);
    await this.hub.runLog(runId, `runner failed — ${reason}. Not completed; needs attention.`);
    await this.hub.runStatus(runId, "review"); // visible needs-attention, NOT "done"
    if (live?.git) await live.git.worktrees.retire(runId).catch(() => undefined);
    this.live.delete(runId);
  }

  /** Startup failed (no runner configured, worktree provisioning, runner.start
   *  threw): free the runner, surface it, and leave the agent visibly errored —
   *  never silently degraded. The caller rethrows so the API returns the error. */
  private async failStartup(runId: string, agentId: string, reason: string): Promise<void> {
    await this.freeRunner(agentId);
    await this.hub.runLog(runId, `failed to start — ${reason}. Needs attention.`);
    await this.hub.runStatus(runId, "review");
    // A worktree may have been provisioned before start threw — retire it.
    const ctx = await this.gitContextForAgent(runId).catch(() => undefined);
    if (ctx) await ctx.worktrees.retire(runId).catch(() => undefined);
    this.live.delete(runId);
  }

  /** Return a runner to the idle pool (no-op if it's already gone). */
  private async freeRunner(agentId: string | null): Promise<void> {
    if (!agentId) return;
    const runner = await this.store.getAgent(agentId);
    if (runner) await this.hub.upsertAgent({ ...runner, status: "idle", idleSince: now() });
  }

  /** Raise the `diff` review that gates a finished agent's branch into the queue. */
  private async raiseDiffReview(runId: string, stat: { add: number; del: number; files: string[] }): Promise<void> {
    const agent = await this.store.getRun(runId);
    if (!agent) return;
    await this.hub.raiseHitl({
      id: `q-diff-${runId}-${++this.seq}`,
      workspaceId: agent.workspaceId,
      runId,
      kind: "diff",
      title: `Review diff: ${agent.name}`,
      why: `Finished on ${agent.branch} — ${stat.add}+/${stat.del}- across ${stat.files.length} file(s). Approve to integrate.`,
      risk: stat.del > 200 || stat.files.length > 40 ? "high" : "medium",
      raisedAt: now(),
      expiresAt: null,
      resolvedAt: null,
      resolution: null,
      command: null,
      options: null,
      recommended: null,
      steps: null,
      diff: { add: stat.add, del: stat.del, modules: agent.modules },
    });
  }

  /**
   * Whether a provider can actually execute: a CLI-login provider (cursor /
   * copilot), a provider with a credential env var, or one with a stored
   * per-workspace secret. There is no mock — no credential means nothing runs.
   */
  private async providerUsable(workspaceId: string, provider: Agent["provider"]): Promise<boolean> {
    // An injected provider (test seam / a deliberately-supplied backend, see
    // getProvider) is a working provider — credentialing is the injector's
    // responsibility, so it's usable regardless of env/secret.
    if (this.providerOverride) return true;
    if (providerUsableFromEnv(provider)) return true;
    return (await secretService.resolve(workspaceId, provider)) !== undefined;
  }

  /**
   * Run a runner-acquisition critical section serially. Each call chains onto the
   * previous one so the find-idle → mark-busy sequence inside `fn` is atomic with
   * respect to every other acquisition, closing the double-booking TOCTOU. A
   * prior failure never poisons the chain (we swallow it for the NEXT waiter; the
   * failing call still rejects to its own caller).
   */
  private acquireExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.acquireLock.catch(() => undefined).then(fn);
    this.acquireLock = run.catch(() => undefined);
    return run;
  }

  /** Acquire an idle agent whose provider can actually execute; mark it busy.
   *  Serialized via acquireExclusive so find-idle → mark-busy is atomic (closes
   *  the double-booking TOCTOU). Empty fleet or no key for any idle agent →
   *  RunnerNotConfiguredError (409); agents exist but all busy → NoCapacityError. */
  private acquireAgent(workspaceId: string): Promise<{ id: string; provider: TaskRun["provider"]; model: string }> {
    return this.acquireExclusive(async () => {
      const runners = await this.store.listAgents(workspaceId);
      if (runners.length === 0) {
        throw new RunnerNotConfiguredError("No agent configured — add one in Fleet before assigning tasks.");
      }
      const idle = runners.filter((r) => r.status === "idle");
      if (idle.length === 0) throw new NoCapacityError();
      for (const r of idle) {
        if (await this.providerUsable(workspaceId, r.provider)) {
          await this.hub.upsertAgent({ ...r, status: "busy", idleSince: null });
          return { id: r.id, provider: r.provider, model: r.model };
        }
      }
      throw new RunnerNotConfiguredError(
        "No credential for any available agent's provider — add a provider key in Settings (or sign in a CLI-login provider). Nothing runs without one.",
      );
    });
  }

  /**
   * Acquire an idle runner, or PROVISION a fresh one on demand when the fleet is
   * fully occupied — used by fork so a family can branch even when every runner
   * is busy (a fork shouldn't be blocked waiting for capacity). The new runner
   * inherits the requested provider/model. Gated on a usable provider, so we
   * never spin up a runner the executor has no credential for.
   */
  private acquireOrProvisionRunner(
    workspaceId: string,
    provider: TaskRun["provider"],
    model: string,
  ): Promise<{ id: string; provider: TaskRun["provider"]; model: string }> {
    return this.acquireExclusive(async () => {
      const runners = await this.store.listAgents(workspaceId);
      // Prefer an idle agent whose provider can actually execute.
      for (const r of runners.filter((r) => r.status === "idle")) {
        if (await this.providerUsable(workspaceId, r.provider)) {
          await this.hub.upsertAgent({ ...r, status: "busy", idleSince: null });
          return { id: r.id, provider: r.provider, model: r.model };
        }
      }
      // None idle+usable → provision one for the requested provider, but only if
      // that provider is usable (else nothing can run).
      if (!(await this.providerUsable(workspaceId, provider))) {
        throw new RunnerNotConfiguredError(
          `No credential for provider "${provider}" — add a key in Settings (or sign in a CLI-login provider). Nothing runs without one.`,
        );
      }
      const id = `runner-auto-${++this.seq}`;
      const runner: Agent = { id, workspaceId, name: id, provider, model, status: "busy", idleSince: null };
      await this.hub.upsertAgent(runner);
      return { id, provider, model };
    });
  }

  /**
   * Provision the runner's working directory. Without an integration repo this
   * is the shared config.runnerCwd (Phase 0). With one configured, isolation is
   * REQUIRED: a fresh worktree on `branch`. If that fails we throw rather than
   * silently dropping runs into a shared dir where their branches would
   * collide — the caller surfaces it as a failed agent.
   */
  private async provisionCwd(
    git: GitContext | undefined,
    runId: string,
    branch: string,
    baseRef?: string,
  ): Promise<{ cwd: string | undefined; baseRef?: string }> {
    if (!git) return { cwd: config.runnerCwd };
    const prov = await git.worktrees.provision(runId, branch, { baseRef });
    await this.hub.runLog(runId, `worktree ready on ${branch} (from ${prov.baseRef})`);
    return { cwd: prov.cwd, baseRef: prov.baseRef };
  }

  // ── assignTask ────────────────────────────────────────────────────────────
  async assignTask(projectId: string, taskId: string): Promise<TaskRun> {
    const task = await this.store.getTask(taskId);
    if (!task || task.projectId !== projectId) throw new Error("Task not found");
    const project = await this.store.getProject(projectId);
    if (!project) throw new Error("Project not found");

    // DEF-005: a completed task has nothing to (re)assign — refuse rather than
    // spawn an agent on already-finished work.
    if (task.state === "done") {
      throw new TaskAlreadyAssignedError("Task is already done");
    }

    // DEF-003: re-assigning a task that already owns a live agent must be
    // idempotent — return the existing agent instead of acquiring a second
    // runner and spawning a duplicate (which orphaned the first agent and left
    // its runner stuck "busy"). Only a done/missing agent frees the task to be
    // (re)assigned.
    if (task.runId) {
      const existing = await this.store.getRun(task.runId);
      if (existing && existing.status !== "done") return existing;
    }

    const runner = await this.acquireAgent(project.workspaceId);
    const runId = `${this.slug(task.text)}-${++this.seq}`;
    // runId is unique → unique branch & worktree path (two same-named tasks
    // never collide on the same branch).
    const branch = `agent/${runId}`;
    // W5: reserve a sandboxed live-preview URL for visual deliverables.
    const preview = await previewService.resolve({
      workspaceId: project.workspaceId,
      projectId,
      projectName: project.name,
      projectGoal: project.goal,
      runId,
      branch,
      seedVisual: false,
    });
    const agent: TaskRun = {
      id: runId,
      workspaceId: project.workspaceId,
      projectId,
      name: task.text,
      status: "running",
      agentId: runner.id,
      provider: runner.provider,
      model: runner.model,
      branch,
      modules: [],
      progress: 0,
      plan: [],
      usage: null,
      modifiedFiles: [],
      log: [],
      startedAt: now(),
      lastHeartbeatAt: now(),
      visual: preview.visual,
      previewUrl: preview.previewUrl,
      dependsOn: [],
      parentId: null,
      branchFromStep: null,
      archived: false,
    };

    // Resolve the runner provider first — fail fast (before mutating state) if
    // it can't be resolved, rather than silently running a fake one.
    const provider = await this.getProvider(runner.provider);

    await this.hub.createRun(agent);
    await this.hub.upsertTask({ ...task, state: "ongoing", runId });
    await this.hub.upsertProject({ ...project, runIds: [...project.runIds, runId] });

    // Git backend for this project's repo (local repoPath, else global) — drives
    // the isolated worktree + which merge queue this agent integrates into.
    const git = this.gitContextFor(project);
    try {
      // Isolated worktree cut from the project's integration tip (or base).
      const { cwd, baseRef } = await this.provisionCwd(git, runId, branch, git?.merge.integrationBranch(projectId));
      // Inject this workspace's provider key (env fallback when none is stored).
      const apiKey = await secretService.resolve(project.workspaceId, runner.provider);
      const handle = await provider.start(
        { runId, projectId, task: task.text, model: runner.model, branch, cwd, apiKey },
        this.events(),
      );
      this.live.set(runId, { handle, agentId: runner.id, taskId, branch, baseRef, git });
    } catch (err) {
      await this.failStartup(runId, runner.id, (err as Error).message);
      throw err;
    }
    return agent;
  }

  // ── fork ──────────────────────────────────────────────────────────────────
  async fork(parentId: string): Promise<TaskRun> {
    const parent = await this.store.getRun(parentId);
    if (!parent) throw new Error("Parent agent not found");

    // Fork provisions capacity on demand: if no runner is idle, spin one up
    // (inheriting the parent's provider/model) rather than refusing the fork.
    const runner = await this.acquireOrProvisionRunner(parent.workspaceId, parent.provider, parent.model);
    const runId = `${this.slug(parent.name)}-fork-${++this.seq}`;
    const stepIndex = Math.max(0, parent.plan.findIndex((s) => s.state === "now"));
    const forkBranch = `${parent.branch}-fork`;
    const project = await this.store.getProject(parent.projectId);
    // W5: a fork is its own branch, so it gets its own preview URL (inherits the
    // parent's visual nature as the seed signal).
    const preview = await previewService.resolve({
      workspaceId: parent.workspaceId,
      projectId: parent.projectId,
      projectName: project?.name ?? "",
      projectGoal: project?.goal ?? "",
      runId,
      branch: forkBranch,
      seedVisual: parent.visual,
    });
    const agent: TaskRun = {
      ...parent,
      id: runId,
      name: `${parent.name} (fork)`,
      status: "running",
      agentId: runner.id,
      provider: runner.provider,
      model: runner.model,
      branch: `agent/${runId}`,
      progress: parent.progress,
      log: [],
      startedAt: now(),
      lastHeartbeatAt: now(),
      visual: preview.visual,
      previewUrl: preview.previewUrl,
      parentId,
      branchFromStep: stepIndex,
    };

    const provider = await this.getProvider(runner.provider); // fail fast if it can't resolve

    await this.hub.createRun(agent);
    if (project) await this.hub.upsertProject({ ...project, runIds: [...project.runIds, runId] });

    const git = this.gitContextFor(project);
    try {
      // A fork branches from its parent (family-internal integration, §7).
      const { cwd, baseRef } = await this.provisionCwd(git, runId, agent.branch, parent.branch);
      const apiKey = await secretService.resolve(parent.workspaceId, runner.provider);
      const handle = await provider.start(
        { runId, projectId: parent.projectId, task: parent.name, model: runner.model, branch: agent.branch, cwd, parentId, branchFromStep: stepIndex, apiKey },
        this.events(),
      );
      this.live.set(runId, { handle, agentId: runner.id, taskId: null, branch: agent.branch, baseRef, git });
    } catch (err) {
      await this.failStartup(runId, runner.id, (err as Error).message);
      throw err;
    }
    return agent;
  }

  // ── deliver a resolved decision ────────────────────────────────────────────
  async deliver(item: HitlItem, resolution: Resolution): Promise<void> {
    const runId = item.runId;

    // Answered (by a human or the timeout) — cancel any pending expiry timer.
    const timer = this.questionTimers.get(item.id);
    if (timer) {
      clearTimeout(timer);
      this.questionTimers.delete(item.id);
    }

    // diff-approve / merge-retry → integrate the agent's branch. This is the
    // post-approval half of the `approveBeforePush` guardrail: the diff review
    // gated here, so reaching this point means an operator approved the push.
    if (resolution.action === "approve" && (item.kind === "diff" || item.kind === "merge")) {
      const agent = await this.store.getRun(runId);
      if (agent) {
        const project = await this.store.getProject(agent.projectId);
        const git = this.gitContextFor(project);
        const conn = await githubService.get(agent.workspaceId);
        // GitHub PR flow: workspace connected, project bound to one repo, and a
        // worktree to push from. Otherwise fall back to the local merge queue
        // (against the project's own repo when git-backed, else the global one).
        if (conn?.connected && project?.repo && git) {
          await this.pushToGithub(git, agent, project.repo);
          return;
        }
        if (git) {
          await this.hub.runStatus(runId, "review");
          await this.hub.runLog(runId, item.kind === "merge" ? "retrying merge after reconciliation" : "diff approved — queued for merge");
          git.merge.enqueue({ runId, projectId: agent.projectId, agentBranch: agent.branch, workspaceId: agent.workspaceId });
          return;
        }
      }
    }

    // Review feedback loop: a `modify` on a finished run's diff/merge review is a
    // request to revise before it can merge. Compute was freed for the review, so
    // there's no live handle — re-acquire one and resume the run in its worktree
    // with the guidance (reviseAfterReview), rather than silently dropping it.
    if ((item.kind === "diff" || item.kind === "merge") && resolution.action === "modify" && !this.live.has(runId)) {
      await this.reviseAfterReview(runId, resolution.guidance ?? "");
      return;
    }

    const live = this.live.get(runId);
    if (live) {
      await live.handle.resume(resolution);
    } else {
      // No live runner to receive the decision (e.g. a seeded/demo agent or one
      // whose runner already exited). Be honest: record that it couldn't be
      // delivered — don't fake a resume by flipping the agent back to "running".
      await this.hub.runLog(runId, `decision "${resolution.action}" recorded, but no live runner is attached — not delivered to an agent`);
    }
  }

  /** A `modify` on a finished run's diff review: re-acquire compute and resume the
   *  agent in its existing worktree with the reviewer's guidance so it can revise
   *  and re-submit. The worktree still holds the committed work (retire happens
   *  only on merge), so a fresh turn edits on top of it; on the agent's next
   *  completion, complete() re-commits and re-raises the review. Loops until the
   *  operator approves. */
  private async reviseAfterReview(runId: string, guidance: string): Promise<void> {
    const review = this.reviews.get(runId);
    const run = await this.store.getRun(runId);
    if (!run || !review) {
      await this.hub.runLog(runId, `revision requested but this run is no longer resumable — not applied`);
      return;
    }
    let acq: { id: string; provider: TaskRun["provider"]; model: string };
    try {
      acq = await this.acquireOrProvisionRunner(run.workspaceId, run.provider, run.model);
    } catch (err) {
      await this.hub.runLog(runId, `cannot revise — ${(err as Error).message}`);
      return;
    }
    const provider = await this.getProvider(acq.provider);
    const cwd = review.git.worktrees.pathFor(runId);
    const apiKey = await secretService.resolve(run.workspaceId, run.provider);
    const revisePrompt =
      `A reviewer looked at your work and asked for changes before it can be merged:\n\n${guidance}\n\n` +
      `Your previous output is already in the working directory (branch ${run.branch}). Read it, make ` +
      `only the changes needed to address the request, then stop.`;
    await this.hub.runStatus(runId, "running");
    if (review.taskId) {
      const task = await this.store.getTask(review.taskId);
      if (task) await this.hub.upsertTask({ ...task, state: "ongoing" });
    }
    await this.hub.runLog(runId, "revising per review guidance");
    try {
      const handle = await provider.start(
        { runId, projectId: run.projectId, task: revisePrompt, model: run.model, branch: run.branch, cwd, apiKey },
        this.events(),
      );
      this.live.set(runId, { handle, agentId: acq.id, taskId: review.taskId, branch: run.branch, baseRef: review.baseRef, git: review.git });
      this.reviews.delete(runId);
    } catch (err) {
      await this.failStartup(runId, acq.id, (err as Error).message);
    }
  }

  /** Merge committed: free the runner, mark the owning task done, finish the agent. */
  private async completeMerged(runId: string, branch: string): Promise<void> {
    const review = this.reviews.get(runId);
    this.reviews.delete(runId); // integrated — no longer awaiting a revise
    const agent = await this.store.getRun(runId);
    await this.freeRunner(agent?.agentId ?? null);
    // Advance the owning task to done alongside the run. Resolve it by the EXACT
    // taskId we stashed when the review was raised (reliable), falling back to a
    // runId match. The find-by-runId alone left tasks stranded in `review` after
    // their run reached `done` (an incoherent lifecycle) whenever that lookup came
    // up empty — a task's `runId` is set at assign, but this closes the gap and,
    // if a task still can't be resolved, says so loudly rather than silently
    // leaving it behind.
    const taskId =
      review?.taskId ??
      (agent ? (await this.store.listTasks(agent.workspaceId)).find((t) => t.runId === runId)?.id : undefined);
    if (taskId) {
      const task = await this.store.getTask(taskId);
      if (task && task.state !== "done") await this.hub.upsertTask({ ...task, state: "done" });
    } else {
      await this.hub.runLog(runId, "merged, but could not resolve the owning task to mark it done");
    }
    await this.hub.runStatus(runId, "done");
    await this.hub.runCompleted(runId, branch);
    const live = this.live.get(runId);
    if (live) {
      await live.handle.stop().catch(() => undefined);
      this.live.delete(runId);
    }
    // Integrated — retire the agent's worktree (the branch is kept in history).
    const ctx = await this.gitContextForAgent(runId).catch(() => undefined);
    if (ctx) await ctx.worktrees.retire(runId).catch(() => undefined);
  }

  /**
   * Integrate an approved agent branch via GitHub: run the safety preflight,
   * then (if clean) mint an installation token, push the branch, and open a PR.
   * The agent stays in `review` until the PR is merged on GitHub. Enforcement is
   * server-side here — the runner never had credentials to push around it.
   */
  private async pushToGithub(git: GitContext, agent: TaskRun, repo: string): Promise<void> {
    const worktreePath = git.worktrees.pathFor(agent.id);
    const stat = await git.worktrees.diffStat(agent.id, config.baseBranch);
    const modules = this.moduleMap.modulesForFiles(stat.files);
    await this.hub.runStatus(agent.id, "review");
    try {
      const result = await githubService.pushAndOpenPr({
        workspaceId: agent.workspaceId,
        runId: agent.id,
        repo,
        branch: agent.branch,
        baseBranch: config.baseBranch,
        worktreePath,
        changedFiles: stat.files,
        modules,
        allowedModules: agent.modules, // [] = unconstrained (no scope declared)
        force: false,
        title: agent.name,
        body: `Automated by Skynet agent \`${agent.id}\`.\n\n${stat.add}+/${stat.del}- across ${stat.files.length} file(s).`,
      });
      if (!result.ok) {
        await this.hub.runLog(agent.id, `push blocked by safety policy: ${result.violations.map((v) => v.message).join("; ")}`);
        return;
      }
      await this.hub.runLog(agent.id, `pushed ${agent.branch} → opened PR ${result.pr?.url ?? "(opened)"}`);
    } catch (err) {
      await this.hub.runLog(agent.id, `GitHub push failed: ${(err as Error).message}`);
    }
  }

  /** Textual merge conflict → raise a `merge` HITL for an operator to reconcile. */
  private async raiseMergeHitl(req: MergeRequest, files: string[]): Promise<void> {
    const agent = await this.store.getRun(req.runId);
    if (!agent) return;
    await this.hub.runStatus(req.runId, "review");
    await this.hub.raiseHitl({
      id: `q-merge-${req.runId}-${++this.seq}`,
      workspaceId: agent.workspaceId,
      runId: req.runId,
      kind: "merge",
      title: `Merge conflict: ${agent.name}`,
      why: `${files.length} file(s) conflict integrating ${req.agentBranch}. Reconcile, then approve to retry.`,
      risk: "high",
      raisedAt: now(),
      expiresAt: null,
      resolvedAt: null,
      resolution: null,
      command: null,
      options: null,
      recommended: null,
      steps: null,
      diff: { add: 0, del: 0, modules: agent.modules },
    });
  }

  // ── chat ────────────────────────────────────────────────────────────────────
  async chat(runId: string, text: string): Promise<string> {
    await this.hub.runLog(runId, `you: ${text}`);
    const live = this.live.get(runId);

    // No live session (finished, in review, or the server restarted since it ran)
    // → answer statelessly via the provider, grounded in the agent's stored log.
    // A `done` agent is also answered statelessly even if a stale live entry
    // lingers: it has nothing left to relay to, so we must never block on its
    // handle's chat waiter (which would hang until the 45s timeout).
    if (!live || (await this.store.getRun(runId))?.status === "done") {
      const reply = await this.consultFinished(runId, text);
      await this.hub.runLog(runId, `↳ ${reply}`);
      return reply;
    }

    return new Promise<string>((resolve) => {
      // A real model turn can take well over 5s; give it room before giving up.
      const timer = setTimeout(() => {
        this.chatWaiters.delete(runId);
        resolve("(no reply yet — it may still be working; check the agent's log)");
      }, 45_000);
      this.chatWaiters.set(runId, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      void live.handle.message(text);
    });
  }

  /** Answer a follow-up when there's no live session, via the provider's
   *  stateless consult, grounded in the stored log — works even across a server
   *  restart. The reply is truthful about the agent's actual status (DEF-002):
   *  we only say "finished" when the agent is really done. */
  private async consultFinished(runId: string, question: string): Promise<string> {
    const agent = await this.store.getRun(runId);
    if (!agent) return `(${runId}) no such agent.`;
    const provider = await this.getProvider(agent.provider);
    if (!provider.consult) {
      // No stateless consult available. Don't claim the agent "finished" unless
      // it actually did — otherwise chatting a running/waiting agent gets a
      // misleading canned reply.
      if (agent.status === "done") {
        return "This agent has finished; follow-up chat isn't supported for its runner.";
      }
      return `This agent is ${agent.status}, but chat isn't wired to a live runner in this config, so I can't relay your message to it right now.`;
    }
    const apiKey = await secretService.resolve(agent.workspaceId, agent.provider);
    const context = agent.log.slice(-40).map((l) => l.line).join("\n").slice(-4000);
    try {
      return await provider.consult(
        { task: agent.name, model: agent.model, cwd: config.runnerCwd, apiKey, context },
        question,
      );
    } catch (err) {
      return `couldn't look into that right now (${(err as Error).message}).`;
    }
  }

  /**
   * Detach an agent's live session — stop its runner if live, free the runner it
   * holds (so a stuck "busy" runner is released), retire its worktree, and record
   * why. Works even for an ORPHAN (no live handle after a restart): the agent's
   * recorded agentId is the only handle to the stuck runner.
   *
   * It deliberately does NOT change the agent's status: the caller owns the
   * terminal state. Operator "stop" ({@link haltAgent}) and the reaper mark the
   * agent done themselves; a restart-orphan is left running/waiting so a
   * follow-up chat can still report its real status (DEF-002) rather than a
   * misleading "finished".
   */
  async stopAgent(runId: string, reason = "stopped by operator"): Promise<void> {
    const agent = await this.store.getRun(runId);
    if (!agent) return;
    const live = this.live.get(runId);
    if (live) await live.handle.stop().catch(() => undefined);
    // Free the runner using the live mapping OR the agent's recorded agentId
    // (an orphan has no live entry, so agent.agentId is the only handle).
    await this.freeRunner(live?.agentId ?? agent.agentId ?? null);
    const ctx = live?.git ?? (await this.gitContextForAgent(runId).catch(() => undefined));
    if (ctx) await ctx.worktrees.retire(runId).catch(() => undefined);
    await this.hub.runLog(runId, reason);
    this.live.delete(runId);
  }

  /**
   * Reap presumed-dead runs: a `running`/`waiting` agent whose heartbeat has
   * been silent past `config.agentReapMs` (a live runner beats every few
   * seconds, so prolonged silence means the runner crashed or the server
   * restarted and orphaned it). `review` runs are intentionally parked with no
   * runner awaiting operator approval, so they never beat and are NOT reaped.
   * Runs periodically and once at startup (which clears restart orphans).
   */
  async reapStaleAgents(): Promise<void> {
    const ms = config.agentReapMs;
    if (!ms || ms <= 0) return; // disabled
    const cutoff = now() - ms;
    const runs = await this.store.listAllRuns().catch(() => [] as TaskRun[]);
    for (const a of runs) {
      if (a.status !== "running" && a.status !== "waiting") continue;
      if (a.lastHeartbeatAt > cutoff) continue;
      const silentSec = Math.round((now() - a.lastHeartbeatAt) / 1000);
      // Detach the (presumed-dead) session + free its runner, then mark it
      // terminal — a reaped agent isn't coming back, so it must not linger
      // "running" and get reaped again on the next sweep.
      await this.stopAgent(a.id, `reaped — no heartbeat for ${silentSec}s; runner freed`).catch(() => undefined);
      await this.hub.runStatus(a.id, "done").catch(() => undefined);
      await this.hub.runCompleted(a.id, a.branch).catch(() => undefined);
    }
  }

  private autonomyTicking = false;

  /**
   * Autonomy loop: for each project with `autonomy` on and idle-agent capacity,
   * do the low-risk moves so tasks flow without a human — triage a backlog item
   * (agent writes an assessment), start an auto-pick todo task, and review a
   * finished run (approve → merge → done, else flag it for a human). The human
   * gate (triage → todo) is never crossed here. Bounded per project per tick.
   */
  async tickAutonomy(): Promise<void> {
    if (!config.autonomyMs || config.autonomyMs <= 0) return;
    if (this.autonomyTicking) return; // never overlap ticks
    this.autonomyTicking = true;
    try {
      const allAgents = await this.store.listAllAgents().catch(() => [] as Agent[]);
      const workspaces = [...new Set(allAgents.map((a) => a.workspaceId))];
      for (const ws of workspaces) {
        const projects = (await this.store.listProjects(ws)).filter((p) => p.autonomy);
        if (projects.length === 0) continue;
        const tasks = await this.store.listTasks(ws);
        for (const p of projects) {
          // Re-read idle capacity per project (an earlier project may have used it).
          const idle = (await this.store.listAgents(ws)).filter((a) => a.status === "idle");
          if (idle.length === 0) break; // no capacity left in this workspace
          const mine = tasks.filter((t) => t.projectId === p.id);
          try {
            // 1) Triage one backlog item → assessment, move to triage.
            const backlog = mine.find((t) => t.state === "backlog");
            if (backlog) {
              const assessment = await this.assessTask(ws, idle[0]!, backlog);
              await this.hub.upsertTask({ ...backlog, state: "triage", assessment });
            }
            // 2) Start auto-pick todo tasks (todo → ongoing) while capacity lasts.
            for (const t of mine.filter((t) => t.state === "todo" && t.autoPick)) {
              try {
                await this.assignTask(p.id, t.id);
              } catch {
                break; // out of capacity / no credential — stop pickups this tick
              }
            }
            // 3) Review a finished run: approve → merge/done, else flag for a human.
            const review = mine.find((t) => t.state === "review" && t.runId && !t.reviewFlaggedReason);
            if (review?.runId) {
              const open = (await this.store.listQueue(ws)).find(
                (h) => h.runId === review.runId && !h.resolvedAt,
              );
              if (open) await this.autoReview(ws, idle[0]!, review, open);
            }
          } catch (err) {
            await this.hub.runLog(p.id, `autonomy skipped ${p.id}: ${(err as Error).message}`).catch(() => undefined);
          }
        }
      }
    } finally {
      this.autonomyTicking = false;
    }
  }

  /** A short agent-written assessment for autonomous triage. Falls back to a
   *  deterministic note when the provider has no stateless consult (e.g. mock). */
  private async assessTask(ws: string, agent: Agent, task: Task): Promise<string> {
    try {
      const provider = await this.getProvider(agent.provider);
      if (!provider.consult) return `Auto-triaged — "${task.text}" looks actionable; no blockers noted.`;
      const apiKey = await secretService.resolve(ws, agent.provider);
      const reply = await provider.consult(
        { task: task.text, model: agent.model, cwd: config.runnerCwd, apiKey },
        "You are triaging a backlog item for a coding project. In 2-3 short lines: is the ask clear, rough effort (S/M/L), and any risks? Be terse.",
      );
      return reply.trim().slice(0, 500) || `Auto-triaged — "${task.text}".`;
    } catch (err) {
      return `Auto-triaged — "${task.text}" (assessment unavailable: ${(err as Error).message}).`;
    }
  }

  /** Autonomous review of a finished run's open HITL: approve → resolve (merges →
   *  done via the normal path), else flag the task for a human. */
  private async autoReview(ws: string, agent: Agent, task: Task, hitl: HitlItem): Promise<void> {
    const run = task.runId ? await this.store.getRun(task.runId) : undefined;
    let approve = true;
    let reason = "auto-approved";
    try {
      const provider = await this.getProvider(agent.provider);
      if (provider.consult && run) {
        const apiKey = await secretService.resolve(ws, agent.provider);
        const context = run.log.slice(-30).map((l) => l.line).join("\n").slice(-3000);
        const reply = await provider.consult(
          { task: task.text, model: agent.model, cwd: config.runnerCwd, apiKey, context },
          `Review whether this run satisfies the task "${task.text}". Reply on the FIRST line with exactly APPROVE or FLAG, then a one-line reason.`,
        );
        const head = reply.trim().split("\n")[0]?.toUpperCase() ?? "";
        approve = !head.includes("FLAG");
        reason = reply.trim().slice(0, 300) || reason;
      }
    } catch (err) {
      approve = false;
      reason = `review consult failed: ${(err as Error).message}`;
    }
    // The consult above is slow (an LLM round-trip); meanwhile an operator — or
    // another actor — may have resolved this same gate and driven the run to
    // done. Re-validate against fresh state before writing so autonomy defers to
    // whatever already happened and never clobbers a task that moved on (a stale
    // `{...task, state:"review"}` write would knock a merged→done task back to
    // review). DEF-001: derive the write from fresh state, not the snapshot.
    const freshHitl = await this.store.getHitl(hitl.id);
    if (!freshHitl || freshHitl.resolvedAt) return; // already handled — defer
    const freshTask = await this.store.getTask(task.id);
    if (!freshTask || freshTask.state !== "review" || freshTask.runId !== task.runId) return;
    if (approve) {
      const resolution: Resolution = { action: "approve", optionIndex: null, guidance: null, by: "autonomy", at: now() };
      const resolved = await this.hub.resolveHitl(hitl.id, resolution);
      if (resolved && resolved.resolution?.at === resolution.at) await this.deliver(hitl, resolution);
    } else {
      await this.hub.upsertTask({ ...freshTask, reviewFlaggedReason: reason });
    }
  }

  /**
   * Release runners that are persisted "busy" but held by no live agent —
   * "orphaned busy" state. It happens across a restart (the in-memory live map
   * is empty, but the file/pg store still says busy) or if a freeRunner was ever
   * missed. Left alone, such a runner shows "busy" forever with no work, and the
   * retire guard refuses to remove it. Runs once at startup, where nothing is
   * live yet — so any busy runner is definitionally an orphan and safe to reset.
   * `isBusy` (the live map) is the source of truth for "actually executing".
   */
  async reconcileRunners(): Promise<void> {
    const runners = await this.store.listAllAgents().catch(() => [] as Agent[]);
    for (const r of runners) {
      if (r.status === "busy" && !this.isBusy(r.id)) {
        await this.hub.upsertAgent({ ...r, status: "idle", idleSince: now() });
      }
    }
  }

  /** Pause a running/waiting agent — halts its runner but keeps the session. */
  async pauseAgent(runId: string): Promise<TaskRun | undefined> {
    const agent = await this.store.getRun(runId);
    if (!agent || agent.status === "done" || agent.status === "paused") return agent;
    const live = this.live.get(runId);
    if (live) await live.handle.pause().catch(() => undefined);
    await this.hub.runStatus(runId, "paused");
    return this.store.getRun(runId);
  }

  /** Resume a paused agent back into the running state. */
  async resumeAgent(runId: string): Promise<TaskRun | undefined> {
    const agent = await this.store.getRun(runId);
    if (!agent || agent.status !== "paused") return agent;
    const live = this.live.get(runId);
    if (live) await live.handle.resume().catch(() => undefined);
    await this.hub.runStatus(runId, "running");
    return this.store.getRun(runId);
  }

  /** Operator "stop / remove": halt execution, free the runner, mark the agent done. */
  async haltAgent(runId: string): Promise<TaskRun | undefined> {
    const agent = await this.store.getRun(runId);
    if (!agent) return undefined;
    const live = this.live.get(runId);
    if (live?.agentId) {
      const runner = await this.store.getAgent(live.agentId);
      if (runner) await this.hub.upsertAgent({ ...runner, status: "idle", idleSince: now() });
    }
    await this.stopAgent(runId); // stop the handle + retire the worktree + drop the session
    // stopAgent detaches but leaves the status untouched — halt is the terminal
    // operator action, so mark it done and emit the completion event.
    if (agent.status !== "done") {
      await this.hub.runStatus(runId, "done");
      await this.hub.runCompleted(runId, agent.branch);
    }
    return this.store.getRun(runId);
  }

  isBusy(agentId: string): boolean {
    for (const l of this.live.values()) if (l.agentId === agentId) return true;
    return false;
  }
}
