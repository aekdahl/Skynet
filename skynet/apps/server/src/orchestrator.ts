// ─── Orchestrator ─────────────────────────────────────────────────────────
// Agent lifecycle (Backend Brief §04): provision a runner, start an agent on a
// task, route HITL gates, deliver decisions, fork, complete. Phase 0 uses the
// mock runner; real providers drop in behind the same runner-sdk interface.

import type { Agent, HitlItem, Project, Resolution, Runner, Task } from "@skynet/shared";
import {
  MockRunnerProvider,
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
import { assessRunnerReadiness, envKeyPresent, executorNeedsNoKey } from "./runner-readiness.js";
import { secretService } from "./secrets/index.js";
import { previewService } from "./preview/index.js";
import type { Store } from "./store/store.js";
import { WorktreeProvisioner } from "./worktrees.js";

interface LiveAgent {
  handle: RunnerHandle;
  runnerId: string | null;
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
  constructor(message: string, readonly agent?: Agent) {
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
  // One lazily-loaded provider backend per provider id (real backends are heavy).
  private providers = new Map<string, Promise<RunnerProvider>>();
  private moduleMap: ModuleMap = loadModuleMap(config.integrationRepo);
  // One git backend per repo path (worktrees + serialized merge queue), built on
  // demand. Keyed by repo so a project's local repo and the global integration
  // repo each get their own queue.
  private gitCtx = new Map<string, GitContext>();

  // `providerOverride` is a test seam — inject a runner provider directly instead
  // of resolving one from RUNNER. Production always passes (store, hub) only.
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
          onMerged: (req) => this.completeMerged(req.agentId, req.agentBranch),
          onConflict: (req, files) => this.raiseMergeHitl(req, files),
          onChecksFailed: async (req, out) => {
            await this.hub.agentLog(req.agentId, `checks failed: ${out.slice(0, 200)}`);
            await this.hub.agentStatus(req.agentId, "review");
          },
          onLog: (id, line) => void this.hub.agentLog(id, line),
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
  private async gitContextForAgent(agentId: string): Promise<GitContext | undefined> {
    const live = this.live.get(agentId);
    if (live?.git) return live.git;
    const agent = await this.store.getAgent(agentId);
    const project = agent ? await this.store.getProject(agent.projectId) : null;
    return this.gitContextFor(project);
  }

  // Resolve the backend for an agent. The provider is chosen per fleet runner at
  // agent creation (runner.provider); config.runner is an optional GLOBAL override
  // for demos/dev (e.g. RUNNER=mock). Real backends load on demand (heavy) and are
  // cached per id; the mock path never imports them.
  private resolveProviderId(runnerProvider: string): string {
    return config.runner ?? runnerProvider;
  }

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
          case "mock":
            // Explicit opt-in only — a deterministic test double, never the default.
            return Promise.resolve(new MockRunnerProvider());
          default:
            // No silent mock fallback: an unresolvable provider is a loud error.
            return Promise.reject(new Error(`Unknown runner provider "${id}" (expected mock|claude|codex|gemini|cursor|copilot).`));
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
      onLog: (agentId, line, detail) => void this.hub.agentLog(agentId, line, detail),
      onProgress: (agentId, progress, plan) => void this.hub.agentProgress(agentId, progress, plan),
      onUsage: (agentId, usage) => void this.hub.agentUsage(agentId, usage),
      onHeartbeat: (agentId) => void this.hub.agentHeartbeat(agentId),
      // "done" is the ORCHESTRATOR's decision, made in complete()/completeMerged
      // only AFTER a finished agent's diff has been committed → reviewed → merged
      // (or confirmed genuinely empty). A runner that flips itself to "done" on
      // finish() would mark the agent done while its edits are still uncommitted;
      // an observer polling that window sees a premature "done" with an empty diff
      // and the work looks silently dropped. Ignore a runner-emitted "done" here —
      // onCompleted drives the real terminal transition. Other statuses
      // (running/waiting/review) pass through unchanged.
      onStatus: (agentId, status) => {
        if (status === "done") return;
        void this.hub.agentStatus(agentId, status);
      },
      onHitl: (agentId, raise) => void this.raise(agentId, raise),
      onCompleted: (agentId, branch) => void this.complete(agentId, branch),
      onFailed: (agentId, reason) => void this.fail(agentId, reason),
      onChatReply: (agentId, text) => {
        const waiter = this.chatWaiters.get(agentId);
        if (waiter) {
          waiter(text);
          this.chatWaiters.delete(agentId);
        }
        void this.hub.agentLog(agentId, `↳ ${text}`);
      },
    };
  }

  private async raise(agentId: string, raise: HitlRaise): Promise<void> {
    const agent = await this.store.getAgent(agentId);
    if (!agent) return;
    // A clarifying `question` gets an optional no-operator-answer deadline so a
    // headless/idle run doesn't hang forever waiting on a human (0 = disabled).
    const timeout = config.hitlQuestionTimeoutMs;
    const expiresAt = raise.kind === "question" && timeout > 0 ? now() + timeout : null;
    const item: HitlItem = {
      id: `q-${agentId}-${++this.seq}`,
      workspaceId: agent.workspaceId,
      agentId,
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
      const live = this.live.get(item.agentId);
      if (live) live.blockedUnanswered = true;
      await this.hub.agentLog(
        item.agentId,
        `no operator answer within ${Math.round(config.hitlQuestionTimeoutMs / 1000)}s — asking the agent to conclude without guessing`,
      );
      await this.deliver(item, resolution);
    }
  }

  private async complete(agentId: string, branch: string): Promise<void> {
    const live = this.live.get(agentId);

    // Real loop: the agent ran in an isolated worktree → commit its diff onto
    // its branch and raise a review. Approving it enqueues the branch onto the
    // merge queue (deliver → merge.enqueue → completeMerged).
    if (live?.git && live.baseRef !== undefined) {
      const wt = live.git.worktrees;
      const agent = await this.store.getAgent(agentId);
      const res = await wt
        .commitAll(agentId, `Skynet agent ${agentId}${agent ? `: ${agent.name}` : ""}`)
        .catch((err) => {
          void this.hub.agentLog(agentId, `commit failed: ${(err as Error).message}`);
          // A git error is NOT "nothing to integrate" — the agent may have real
          // edits we simply couldn't commit. Falling through to done would drop
          // them silently, so surface it for attention instead.
          return { committed: false, error: true } as const;
        });

      if (res.committed) {
        const stat = await wt.diffStat(agentId, live.baseRef);
        await this.freeRunner(live.runnerId); // compute is done; awaiting review
        await this.hub.agentStatus(agentId, "review");
        await this.raiseDiffReview(agentId, stat);
        this.live.delete(agentId);
        return;
      }

      if ("error" in res && res.error) {
        // Couldn't commit a finished agent's worktree — needs-attention, never a
        // silent "done" that would lose the (possibly real) uncommitted work.
        await this.freeRunner(live.runnerId);
        await this.hub.agentStatus(agentId, "review");
        this.live.delete(agentId);
        return;
      }

      // Nothing to integrate — retire the worktree and complete plainly.
      await this.hub.agentLog(agentId, "no changes to integrate");
      await wt.retire(agentId).catch(() => undefined);
    } else if (live?.git) {
      await live.git.worktrees.retire(agentId).catch(() => undefined);
    }

    // Reached here with no diff. If the agent only stopped because a question it
    // raised went unanswered, it did no real work — surface it as needs-attention
    // (never a silent "done"), leave its task open, and don't mark it completed.
    if (live?.blockedUnanswered) {
      await this.freeRunner(live.runnerId);
      await this.hub.agentStatus(agentId, "review");
      await this.hub.agentLog(agentId, "concluded without an answer to its question — needs attention (no change made)");
      this.live.delete(agentId);
      return;
    }

    // Phase 0 / no-diff completion: free the runner, finish the task & agent.
    // The orchestrator sets "done" HERE (not the runner) — this is the only place
    // a genuinely change-free agent becomes terminal, so a runner's own "done" is
    // ignored (see events().onStatus) and can never precede real integration.
    await this.freeRunner(live?.runnerId ?? null);
    if (live?.taskId) {
      const task = await this.store.getTask(live.taskId);
      if (task) await this.hub.upsertTask({ ...task, state: "done" });
    }
    await this.hub.agentStatus(agentId, "done");
    await this.hub.agentCompleted(agentId, branch);
    this.live.delete(agentId);
  }

  /**
   * A runner could not execute (binary missing, auth failure, crash). Surface it
   * loudly and free the runner — but never mark the agent done, complete the
   * task, or integrate a branch. A broken runner must not look like success.
   */
  private async fail(agentId: string, reason: string): Promise<void> {
    const live = this.live.get(agentId);
    await this.freeRunner(live?.runnerId ?? null);
    await this.hub.agentLog(agentId, `runner failed — ${reason}. Not completed; needs attention.`);
    await this.hub.agentStatus(agentId, "review"); // visible needs-attention, NOT "done"
    if (live?.git) await live.git.worktrees.retire(agentId).catch(() => undefined);
    this.live.delete(agentId);
  }

  /** Startup failed (no runner configured, worktree provisioning, runner.start
   *  threw): free the runner, surface it, and leave the agent visibly errored —
   *  never silently degraded. The caller rethrows so the API returns the error. */
  private async failStartup(agentId: string, runnerId: string, reason: string): Promise<void> {
    await this.freeRunner(runnerId);
    await this.hub.agentLog(agentId, `failed to start — ${reason}. Needs attention.`);
    await this.hub.agentStatus(agentId, "review");
    // A worktree may have been provisioned before start threw — retire it.
    const ctx = await this.gitContextForAgent(agentId).catch(() => undefined);
    if (ctx) await ctx.worktrees.retire(agentId).catch(() => undefined);
    this.live.delete(agentId);
  }

  /** Return a runner to the idle pool (no-op if it's already gone). */
  private async freeRunner(runnerId: string | null): Promise<void> {
    if (!runnerId) return;
    const runner = await this.store.getRunner(runnerId);
    if (runner) await this.hub.upsertRunner({ ...runner, status: "idle", idleSince: now() });
  }

  /** Raise the `diff` review that gates a finished agent's branch into the queue. */
  private async raiseDiffReview(agentId: string, stat: { add: number; del: number; files: string[] }): Promise<void> {
    const agent = await this.store.getAgent(agentId);
    if (!agent) return;
    await this.hub.raiseHitl({
      id: `q-diff-${agentId}-${++this.seq}`,
      workspaceId: agent.workspaceId,
      agentId,
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
   * Refuse agent creation unless a runner can actually execute: the fleet has a
   * runner AND the executor has a credential (mock / CLI-login providers need
   * none). Throws {@link RunnerNotConfiguredError} otherwise.
   */
  private async assertRunnerReady(workspaceId: string, runnerCount: number): Promise<void> {
    // Unset RUNNER falls through to the mock provider (see getProvider), which
    // needs no credential — mirror that here so the dev default stays open.
    const mode = config.runner ?? "mock";
    const credentialPresent = executorNeedsNoKey(mode)
      ? true
      : envKeyPresent(mode) ||
        (await secretService.resolve(workspaceId, mode as Agent["provider"])) !== undefined;
    const readiness = assessRunnerReadiness({ runnerMode: mode, runnerCount, credentialPresent });
    if (!readiness.ok) throw new RunnerNotConfiguredError(readiness.reason!);
  }

  /** Acquire an idle runner in a workspace; mark it busy. Throws if none. */
  private async acquireRunner(workspaceId: string): Promise<{ id: string; provider: Agent["provider"]; model: string }> {
    const runners = await this.store.listRunners(workspaceId);
    await this.assertRunnerReady(workspaceId, runners.length);
    const idle = runners.find((r) => r.status === "idle");
    if (!idle) throw new NoCapacityError();
    await this.hub.upsertRunner({ ...idle, status: "busy", idleSince: null });
    return { id: idle.id, provider: idle.provider, model: idle.model };
  }

  /**
   * Acquire an idle runner, or PROVISION a fresh one on demand when the fleet is
   * fully occupied — used by fork so a family can branch even when every runner
   * is busy (a fork shouldn't be blocked waiting for capacity). The new runner
   * inherits the requested provider/model. Still gated by assertRunnerReady, so
   * we never spin up a runner the executor has no credential for.
   */
  private async acquireOrProvisionRunner(
    workspaceId: string,
    provider: Agent["provider"],
    model: string,
  ): Promise<{ id: string; provider: Agent["provider"]; model: string }> {
    const runners = await this.store.listRunners(workspaceId);
    await this.assertRunnerReady(workspaceId, runners.length);
    const idle = runners.find((r) => r.status === "idle");
    if (idle) {
      await this.hub.upsertRunner({ ...idle, status: "busy", idleSince: null });
      return { id: idle.id, provider: idle.provider, model: idle.model };
    }
    const id = `runner-auto-${++this.seq}`;
    const runner: Runner = { id, workspaceId, name: id, provider, model, status: "busy", idleSince: null };
    await this.hub.upsertRunner(runner);
    return { id, provider, model };
  }

  /**
   * Provision the runner's working directory. Without an integration repo this
   * is the shared config.runnerCwd (Phase 0). With one configured, isolation is
   * REQUIRED: a fresh worktree on `branch`. If that fails we throw rather than
   * silently dropping agents into a shared dir where their branches would
   * collide — the caller surfaces it as a failed agent.
   */
  private async provisionCwd(
    git: GitContext | undefined,
    agentId: string,
    branch: string,
    baseRef?: string,
  ): Promise<{ cwd: string | undefined; baseRef?: string }> {
    if (!git) return { cwd: config.runnerCwd };
    const prov = await git.worktrees.provision(agentId, branch, { baseRef });
    await this.hub.agentLog(agentId, `worktree ready on ${branch} (from ${prov.baseRef})`);
    return { cwd: prov.cwd, baseRef: prov.baseRef };
  }

  // ── assignTask ────────────────────────────────────────────────────────────
  async assignTask(projectId: string, taskId: string): Promise<Agent> {
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
    if (task.agentId) {
      const existing = await this.store.getAgent(task.agentId);
      if (existing && existing.status !== "done") return existing;
    }

    const runner = await this.acquireRunner(project.workspaceId);
    const agentId = `${this.slug(task.text)}-${++this.seq}`;
    // agentId is unique → unique branch & worktree path (two same-named tasks
    // never collide on the same branch).
    const branch = `agent/${agentId}`;
    // W5: reserve a sandboxed live-preview URL for visual deliverables.
    const preview = await previewService.resolve({
      workspaceId: project.workspaceId,
      projectId,
      projectName: project.name,
      projectGoal: project.goal,
      agentId,
      branch,
      seedVisual: false,
    });
    const agent: Agent = {
      id: agentId,
      workspaceId: project.workspaceId,
      projectId,
      name: task.text,
      status: "running",
      runnerId: runner.id,
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
    const provider = await this.getProvider(this.resolveProviderId(runner.provider));

    await this.hub.createAgent(agent);
    await this.hub.upsertTask({ ...task, state: "assigned", agentId });
    await this.hub.upsertProject({ ...project, agentIds: [...project.agentIds, agentId] });

    // Git backend for this project's repo (local repoPath, else global) — drives
    // the isolated worktree + which merge queue this agent integrates into.
    const git = this.gitContextFor(project);
    try {
      // Isolated worktree cut from the project's integration tip (or base).
      const { cwd, baseRef } = await this.provisionCwd(git, agentId, branch, git?.merge.integrationBranch(projectId));
      // Inject this workspace's provider key (env fallback when none is stored).
      const apiKey = await secretService.resolve(project.workspaceId, runner.provider);
      const handle = await provider.start(
        { agentId, projectId, task: task.text, model: runner.model, branch, cwd, apiKey },
        this.events(),
      );
      this.live.set(agentId, { handle, runnerId: runner.id, taskId, branch, baseRef, git });
    } catch (err) {
      await this.failStartup(agentId, runner.id, (err as Error).message);
      throw err;
    }
    return agent;
  }

  // ── fork ──────────────────────────────────────────────────────────────────
  async fork(parentId: string): Promise<Agent> {
    const parent = await this.store.getAgent(parentId);
    if (!parent) throw new Error("Parent agent not found");

    // Fork provisions capacity on demand: if no runner is idle, spin one up
    // (inheriting the parent's provider/model) rather than refusing the fork.
    const runner = await this.acquireOrProvisionRunner(parent.workspaceId, parent.provider, parent.model);
    const agentId = `${this.slug(parent.name)}-fork-${++this.seq}`;
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
      agentId,
      branch: forkBranch,
      seedVisual: parent.visual,
    });
    const agent: Agent = {
      ...parent,
      id: agentId,
      name: `${parent.name} (fork)`,
      status: "running",
      runnerId: runner.id,
      provider: runner.provider,
      model: runner.model,
      branch: `agent/${agentId}`,
      progress: parent.progress,
      log: [],
      startedAt: now(),
      lastHeartbeatAt: now(),
      visual: preview.visual,
      previewUrl: preview.previewUrl,
      parentId,
      branchFromStep: stepIndex,
    };

    const provider = await this.getProvider(this.resolveProviderId(runner.provider)); // fail fast if it can't resolve

    await this.hub.createAgent(agent);
    if (project) await this.hub.upsertProject({ ...project, agentIds: [...project.agentIds, agentId] });

    const git = this.gitContextFor(project);
    try {
      // A fork branches from its parent (family-internal integration, §7).
      const { cwd, baseRef } = await this.provisionCwd(git, agentId, agent.branch, parent.branch);
      const apiKey = await secretService.resolve(parent.workspaceId, runner.provider);
      const handle = await provider.start(
        { agentId, projectId: parent.projectId, task: parent.name, model: runner.model, branch: agent.branch, cwd, parentId, branchFromStep: stepIndex, apiKey },
        this.events(),
      );
      this.live.set(agentId, { handle, runnerId: runner.id, taskId: null, branch: agent.branch, baseRef, git });
    } catch (err) {
      await this.failStartup(agentId, runner.id, (err as Error).message);
      throw err;
    }
    return agent;
  }

  // ── deliver a resolved decision ────────────────────────────────────────────
  async deliver(item: HitlItem, resolution: Resolution): Promise<void> {
    const agentId = item.agentId;

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
      const agent = await this.store.getAgent(agentId);
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
          await this.hub.agentStatus(agentId, "review");
          await this.hub.agentLog(agentId, item.kind === "merge" ? "retrying merge after reconciliation" : "diff approved — queued for merge");
          git.merge.enqueue({ agentId, projectId: agent.projectId, agentBranch: agent.branch, workspaceId: agent.workspaceId });
          return;
        }
      }
    }

    const live = this.live.get(agentId);
    if (live) {
      await live.handle.resume(resolution);
    } else {
      // No live runner to receive the decision (e.g. a seeded/demo agent or one
      // whose runner already exited). Be honest: record that it couldn't be
      // delivered — don't fake a resume by flipping the agent back to "running".
      await this.hub.agentLog(agentId, `decision "${resolution.action}" recorded, but no live runner is attached — not delivered to an agent`);
    }
  }

  /** Merge committed: free the runner, mark the owning task done, finish the agent. */
  private async completeMerged(agentId: string, branch: string): Promise<void> {
    const agent = await this.store.getAgent(agentId);
    await this.freeRunner(agent?.runnerId ?? null);
    if (agent) {
      const tasks = await this.store.listTasks(agent.workspaceId);
      const task = tasks.find((t) => t.agentId === agentId);
      if (task) await this.hub.upsertTask({ ...task, state: "done" });
    }
    await this.hub.agentStatus(agentId, "done");
    await this.hub.agentCompleted(agentId, branch);
    const live = this.live.get(agentId);
    if (live) {
      await live.handle.stop().catch(() => undefined);
      this.live.delete(agentId);
    }
    // Integrated — retire the agent's worktree (the branch is kept in history).
    const ctx = await this.gitContextForAgent(agentId).catch(() => undefined);
    if (ctx) await ctx.worktrees.retire(agentId).catch(() => undefined);
  }

  /**
   * Integrate an approved agent branch via GitHub: run the safety preflight,
   * then (if clean) mint an installation token, push the branch, and open a PR.
   * The agent stays in `review` until the PR is merged on GitHub. Enforcement is
   * server-side here — the runner never had credentials to push around it.
   */
  private async pushToGithub(git: GitContext, agent: Agent, repo: string): Promise<void> {
    const worktreePath = git.worktrees.pathFor(agent.id);
    const stat = await git.worktrees.diffStat(agent.id, config.baseBranch);
    const modules = this.moduleMap.modulesForFiles(stat.files);
    await this.hub.agentStatus(agent.id, "review");
    try {
      const result = await githubService.pushAndOpenPr({
        workspaceId: agent.workspaceId,
        agentId: agent.id,
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
        await this.hub.agentLog(agent.id, `push blocked by safety policy: ${result.violations.map((v) => v.message).join("; ")}`);
        return;
      }
      await this.hub.agentLog(agent.id, `pushed ${agent.branch} → opened PR ${result.pr?.url ?? "(opened)"}`);
    } catch (err) {
      await this.hub.agentLog(agent.id, `GitHub push failed: ${(err as Error).message}`);
    }
  }

  /** Textual merge conflict → raise a `merge` HITL for an operator to reconcile. */
  private async raiseMergeHitl(req: MergeRequest, files: string[]): Promise<void> {
    const agent = await this.store.getAgent(req.agentId);
    if (!agent) return;
    await this.hub.agentStatus(req.agentId, "review");
    await this.hub.raiseHitl({
      id: `q-merge-${req.agentId}-${++this.seq}`,
      workspaceId: agent.workspaceId,
      agentId: req.agentId,
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
  async chat(agentId: string, text: string): Promise<string> {
    await this.hub.agentLog(agentId, `you: ${text}`);
    const live = this.live.get(agentId);

    // No live session (finished, in review, or the server restarted since it ran)
    // → answer statelessly via the provider, grounded in the agent's stored log.
    // A `done` agent is also answered statelessly even if a stale live entry
    // lingers: it has nothing left to relay to, so we must never block on its
    // handle's chat waiter (which would hang until the 45s timeout).
    if (!live || (await this.store.getAgent(agentId))?.status === "done") {
      const reply = await this.consultFinished(agentId, text);
      await this.hub.agentLog(agentId, `↳ ${reply}`);
      return reply;
    }

    return new Promise<string>((resolve) => {
      // A real model turn can take well over 5s; give it room before giving up.
      const timer = setTimeout(() => {
        this.chatWaiters.delete(agentId);
        resolve("(no reply yet — it may still be working; check the agent's log)");
      }, 45_000);
      this.chatWaiters.set(agentId, (reply) => {
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
  private async consultFinished(agentId: string, question: string): Promise<string> {
    const agent = await this.store.getAgent(agentId);
    if (!agent) return `(${agentId}) no such agent.`;
    const provider = await this.getProvider(this.resolveProviderId(agent.provider));
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
   * recorded runnerId is the only handle to the stuck runner.
   *
   * It deliberately does NOT change the agent's status: the caller owns the
   * terminal state. Operator "stop" ({@link haltAgent}) and the reaper mark the
   * agent done themselves; a restart-orphan is left running/waiting so a
   * follow-up chat can still report its real status (DEF-002) rather than a
   * misleading "finished".
   */
  async stopAgent(agentId: string, reason = "stopped by operator"): Promise<void> {
    const agent = await this.store.getAgent(agentId);
    if (!agent) return;
    const live = this.live.get(agentId);
    if (live) await live.handle.stop().catch(() => undefined);
    // Free the runner using the live mapping OR the agent's recorded runnerId
    // (an orphan has no live entry, so agent.runnerId is the only handle).
    await this.freeRunner(live?.runnerId ?? agent.runnerId ?? null);
    const ctx = live?.git ?? (await this.gitContextForAgent(agentId).catch(() => undefined));
    if (ctx) await ctx.worktrees.retire(agentId).catch(() => undefined);
    await this.hub.agentLog(agentId, reason);
    this.live.delete(agentId);
  }

  /**
   * Reap presumed-dead agents: a `running`/`waiting` agent whose heartbeat has
   * been silent past `config.agentReapMs` (a live runner beats every few
   * seconds, so prolonged silence means the runner crashed or the server
   * restarted and orphaned it). `review` agents are intentionally parked with no
   * runner awaiting operator approval, so they never beat and are NOT reaped.
   * Runs periodically and once at startup (which clears restart orphans).
   */
  async reapStaleAgents(): Promise<void> {
    const ms = config.agentReapMs;
    if (!ms || ms <= 0) return; // disabled
    const cutoff = now() - ms;
    const agents = await this.store.listAllAgents().catch(() => [] as Agent[]);
    for (const a of agents) {
      if (a.status !== "running" && a.status !== "waiting") continue;
      if (a.lastHeartbeatAt > cutoff) continue;
      const silentSec = Math.round((now() - a.lastHeartbeatAt) / 1000);
      // Detach the (presumed-dead) session + free its runner, then mark it
      // terminal — a reaped agent isn't coming back, so it must not linger
      // "running" and get reaped again on the next sweep.
      await this.stopAgent(a.id, `reaped — no heartbeat for ${silentSec}s; runner freed`).catch(() => undefined);
      await this.hub.agentStatus(a.id, "done").catch(() => undefined);
      await this.hub.agentCompleted(a.id, a.branch).catch(() => undefined);
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
    const runners = await this.store.listAllRunners().catch(() => [] as Runner[]);
    for (const r of runners) {
      if (r.status === "busy" && !this.isBusy(r.id)) {
        await this.hub.upsertRunner({ ...r, status: "idle", idleSince: now() });
      }
    }
  }

  /** Pause a running/waiting agent — halts its runner but keeps the session. */
  async pauseAgent(agentId: string): Promise<Agent | undefined> {
    const agent = await this.store.getAgent(agentId);
    if (!agent || agent.status === "done" || agent.status === "paused") return agent;
    const live = this.live.get(agentId);
    if (live) await live.handle.pause().catch(() => undefined);
    await this.hub.agentStatus(agentId, "paused");
    return this.store.getAgent(agentId);
  }

  /** Resume a paused agent back into the running state. */
  async resumeAgent(agentId: string): Promise<Agent | undefined> {
    const agent = await this.store.getAgent(agentId);
    if (!agent || agent.status !== "paused") return agent;
    const live = this.live.get(agentId);
    if (live) await live.handle.resume().catch(() => undefined);
    await this.hub.agentStatus(agentId, "running");
    return this.store.getAgent(agentId);
  }

  /** Operator "stop / remove": halt execution, free the runner, mark the agent done. */
  async haltAgent(agentId: string): Promise<Agent | undefined> {
    const agent = await this.store.getAgent(agentId);
    if (!agent) return undefined;
    const live = this.live.get(agentId);
    if (live?.runnerId) {
      const runner = await this.store.getRunner(live.runnerId);
      if (runner) await this.hub.upsertRunner({ ...runner, status: "idle", idleSince: now() });
    }
    await this.stopAgent(agentId); // stop the handle + retire the worktree + drop the session
    // stopAgent detaches but leaves the status untouched — halt is the terminal
    // operator action, so mark it done and emit the completion event.
    if (agent.status !== "done") {
      await this.hub.agentStatus(agentId, "done");
      await this.hub.agentCompleted(agentId, agent.branch);
    }
    return this.store.getAgent(agentId);
  }

  isBusy(runnerId: string): boolean {
    for (const l of this.live.values()) if (l.runnerId === runnerId) return true;
    return false;
  }
}
