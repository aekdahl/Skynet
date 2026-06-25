// ─── Orchestrator ─────────────────────────────────────────────────────────
// Agent lifecycle (Backend Brief §04): provision a runner, start an agent on a
// task, route HITL gates, deliver decisions, fork, complete. Phase 0 uses the
// mock runner; real providers drop in behind the same runner-sdk interface.

import type { Agent, HitlItem, Resolution, Task } from "@skynet/shared";
import {
  MockRunnerProvider,
  type HitlRaise,
  type RunnerEvents,
  type RunnerHandle,
  type RunnerProvider,
} from "@skynet/runner-sdk";
import { config, now } from "./config.js";
import type { Hub } from "./hub.js";
import { MergeEngine, type MergeRequest } from "./merge.js";
import { loadModuleMap, type ModuleMap } from "./modules-map.js";
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
}

export class NoCapacityError extends Error {
  constructor() {
    super("No idle runner available");
    this.name = "NoCapacityError";
  }
}

export class Orchestrator {
  private live = new Map<string, LiveAgent>();
  private chatWaiters = new Map<string, (reply: string) => void>();
  private seq = 0;
  // One lazily-loaded provider backend per provider id (real backends are heavy).
  private providers = new Map<string, Promise<RunnerProvider>>();
  private merge?: MergeEngine;
  private moduleMap: ModuleMap = loadModuleMap(config.integrationRepo);
  private worktrees?: WorktreeProvisioner;

  constructor(private store: Store, private hub: Hub) {
    if (config.integrationRepo) {
      // One worktree per agent feeds real branches to the merge queue (§2).
      this.worktrees = new WorktreeProvisioner(
        config.integrationRepo,
        config.baseBranch,
        config.worktreesDir,
      );
      this.merge = new MergeEngine(
        config.integrationRepo,
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
    }
  }

  // Resolve the backend for an agent. The provider is chosen per fleet runner at
  // agent creation (runner.provider); config.runner is an optional GLOBAL override
  // for demos/dev (e.g. RUNNER=mock). Real backends load on demand (heavy) and are
  // cached per id; the mock path never imports them.
  private resolveProviderId(runnerProvider: string): string {
    return config.runner ?? runnerProvider;
  }

  private getProvider(id: string): Promise<RunnerProvider> {
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
          default:
            return Promise.resolve(new MockRunnerProvider());
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
      onHeartbeat: (agentId) => void this.hub.agentHeartbeat(agentId),
      onStatus: (agentId, status) => void this.hub.agentStatus(agentId, status),
      onHitl: (agentId, raise) => void this.raise(agentId, raise),
      onCompleted: (agentId, branch) => void this.complete(agentId, branch),
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
    const item: HitlItem = {
      id: `q-${agentId}-${++this.seq}`,
      workspaceId: agent.workspaceId,
      agentId,
      kind: raise.kind,
      title: raise.title,
      why: raise.why,
      risk: raise.risk,
      raisedAt: now(),
      resolvedAt: null,
      resolution: null,
      command: raise.command ?? null,
      options: raise.options ?? null,
      recommended: raise.recommended ?? null,
      steps: raise.steps ?? null,
      diff: raise.diff ?? null,
    };
    await this.hub.raiseHitl(item);
  }

  private async complete(agentId: string, branch: string): Promise<void> {
    const live = this.live.get(agentId);

    // Real loop: the agent ran in an isolated worktree → commit its diff onto
    // its branch and raise a review. Approving it enqueues the branch onto the
    // merge queue (deliver → merge.enqueue → completeMerged).
    if (this.worktrees && this.merge && live?.baseRef !== undefined) {
      const agent = await this.store.getAgent(agentId);
      const res = await this.worktrees
        .commitAll(agentId, `Skynet agent ${agentId}${agent ? `: ${agent.name}` : ""}`)
        .catch((err) => {
          void this.hub.agentLog(agentId, `commit failed: ${(err as Error).message}`);
          return { committed: false } as const;
        });

      if (res.committed) {
        const stat = await this.worktrees.diffStat(agentId, live.baseRef);
        await this.freeRunner(live.runnerId); // compute is done; awaiting review
        await this.hub.agentStatus(agentId, "review");
        await this.raiseDiffReview(agentId, stat);
        this.live.delete(agentId);
        return;
      }

      // Nothing to integrate — retire the worktree and complete plainly.
      await this.hub.agentLog(agentId, "no changes to integrate");
      await this.worktrees.retire(agentId).catch(() => undefined);
    } else if (this.worktrees) {
      await this.worktrees.retire(agentId).catch(() => undefined);
    }

    // Phase 0 / no-diff completion: free the runner, finish the task & agent.
    await this.freeRunner(live?.runnerId ?? null);
    if (live?.taskId) {
      const task = await this.store.getTask(live.taskId);
      if (task) await this.hub.upsertTask({ ...task, state: "done" });
    }
    await this.hub.agentCompleted(agentId, branch);
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
      resolvedAt: null,
      resolution: null,
      command: null,
      options: null,
      recommended: null,
      steps: null,
      diff: { add: stat.add, del: stat.del, modules: agent.modules },
    });
  }

  /** Acquire an idle runner in a workspace; mark it busy. Throws if none. */
  private async acquireRunner(workspaceId: string): Promise<{ id: string; provider: Agent["provider"]; model: string }> {
    const runners = await this.store.listRunners(workspaceId);
    const idle = runners.find((r) => r.status === "idle");
    if (!idle) throw new NoCapacityError();
    await this.hub.upsertRunner({ ...idle, status: "busy", idleSince: null });
    return { id: idle.id, provider: idle.provider, model: idle.model };
  }

  /**
   * Provision the runner's working directory. With an integration repo
   * configured this is a fresh isolated git worktree on `branch` (cut from
   * `baseRef` when it exists, else the base branch); otherwise the shared
   * config.runnerCwd (Phase 0). Falls back to runnerCwd if worktree creation
   * fails, so a misconfigured repo never blocks the agent from running.
   */
  private async provisionCwd(
    agentId: string,
    branch: string,
    baseRef?: string,
  ): Promise<{ cwd: string | undefined; baseRef?: string }> {
    if (!this.worktrees) return { cwd: config.runnerCwd };
    try {
      const prov = await this.worktrees.provision(agentId, branch, { baseRef });
      await this.hub.agentLog(agentId, `worktree ready on ${branch} (from ${prov.baseRef})`);
      return { cwd: prov.cwd, baseRef: prov.baseRef };
    } catch (err) {
      await this.hub.agentLog(
        agentId,
        `worktree provisioning failed (${(err as Error).message}) — running without isolation`,
      );
      return { cwd: config.runnerCwd };
    }
  }

  // ── assignTask ────────────────────────────────────────────────────────────
  async assignTask(projectId: string, taskId: string): Promise<Agent> {
    const task = await this.store.getTask(taskId);
    if (!task || task.projectId !== projectId) throw new Error("Task not found");
    const project = await this.store.getProject(projectId);
    if (!project) throw new Error("Project not found");

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

    await this.hub.createAgent(agent);
    await this.hub.upsertTask({ ...task, state: "assigned", agentId });
    await this.hub.upsertProject({ ...project, agentIds: [...project.agentIds, agentId] });

    // Isolated worktree cut from the project's integration tip (or base).
    const { cwd, baseRef } = await this.provisionCwd(
      agentId,
      branch,
      this.merge?.integrationBranch(projectId),
    );

    const provider = await this.getProvider(this.resolveProviderId(runner.provider));
    // Inject this workspace's provider key (env fallback when none is stored).
    const apiKey = await secretService.resolve(project.workspaceId, runner.provider);
    const handle = await provider.start(
      { agentId, projectId, task: task.text, model: runner.model, branch, cwd, apiKey },
      this.events(),
    );
    this.live.set(agentId, { handle, runnerId: runner.id, taskId, branch, baseRef });
    return agent;
  }

  // ── fork ──────────────────────────────────────────────────────────────────
  async fork(parentId: string): Promise<Agent> {
    const parent = await this.store.getAgent(parentId);
    if (!parent) throw new Error("Parent agent not found");

    const runner = await this.acquireRunner(parent.workspaceId);
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

    await this.hub.createAgent(agent);
    if (project) await this.hub.upsertProject({ ...project, agentIds: [...project.agentIds, agentId] });

    // A fork branches from its parent (family-internal integration, §7).
    const { cwd, baseRef } = await this.provisionCwd(agentId, agent.branch, parent.branch);

    const provider = await this.getProvider(this.resolveProviderId(runner.provider));
    const apiKey = await secretService.resolve(parent.workspaceId, runner.provider);
    const handle = await provider.start(
      { agentId, projectId: parent.projectId, task: parent.name, model: runner.model, branch: agent.branch, cwd, parentId, branchFromStep: stepIndex, apiKey },
      this.events(),
    );
    this.live.set(agentId, { handle, runnerId: runner.id, taskId: null, branch: agent.branch, baseRef });
    return agent;
  }

  // ── deliver a resolved decision ────────────────────────────────────────────
  async deliver(item: HitlItem, resolution: Resolution): Promise<void> {
    const agentId = item.agentId;

    // diff-approve / merge-retry → enqueue onto the merge queue (when enabled).
    if (this.merge && resolution.action === "approve" && (item.kind === "diff" || item.kind === "merge")) {
      const agent = await this.store.getAgent(agentId);
      if (agent) {
        await this.hub.agentStatus(agentId, "review");
        await this.hub.agentLog(agentId, item.kind === "merge" ? "retrying merge after reconciliation" : "diff approved — queued for merge");
        this.merge.enqueue({ agentId, projectId: agent.projectId, agentBranch: agent.branch, workspaceId: agent.workspaceId });
        return;
      }
    }

    const live = this.live.get(agentId);
    if (live) {
      await live.handle.resume(resolution);
    } else {
      // Seeded agent with no live runner — record the decision in the log so the
      // round-trip is still observable end-to-end.
      await this.hub.agentLog(agentId, `decision delivered: ${resolution.action}`);
      await this.hub.agentStatus(agentId, "running");
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
    if (this.worktrees) await this.worktrees.retire(agentId).catch(() => undefined);
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
    if (!live) {
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

  /** Answer a follow-up about a finished agent via its provider's stateless
   *  consult, grounded in the stored log — works even across a server restart. */
  private async consultFinished(agentId: string, question: string): Promise<string> {
    const agent = await this.store.getAgent(agentId);
    if (!agent) return `(${agentId}) no such agent.`;
    const provider = await this.getProvider(this.resolveProviderId(agent.provider));
    if (!provider.consult) {
      return "This agent has finished; follow-up chat isn't supported for its runner.";
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

  async stopAgent(agentId: string): Promise<void> {
    const live = this.live.get(agentId);
    if (live) {
      await live.handle.stop();
      this.live.delete(agentId);
    }
    // Retire the worktree so a stopped agent doesn't leave one behind.
    if (this.worktrees) await this.worktrees.retire(agentId).catch(() => undefined);
  }

  isBusy(runnerId: string): boolean {
    for (const l of this.live.values()) if (l.runnerId === runnerId) return true;
    return false;
  }
}
