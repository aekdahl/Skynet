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
import { previewService } from "./preview/index.js";
import type { Store } from "./store/store.js";

interface LiveAgent {
  handle: RunnerHandle;
  runnerId: string | null;
  taskId: string | null;
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
  private providerPromise?: Promise<RunnerProvider>;
  private merge?: MergeEngine;
  private moduleMap: ModuleMap = loadModuleMap(config.integrationRepo);

  constructor(private store: Store, private hub: Hub) {
    if (config.integrationRepo) {
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

  // Lazily resolve the runner provider. Each real provider is a subpath import
  // loaded on demand (heavy SDKs/CLIs); the default mock path imports none.
  private getProvider(): Promise<RunnerProvider> {
    if (!this.providerPromise) {
      switch (config.runner) {
        case "claude":
          this.providerPromise = import("@skynet/runner-sdk/claude").then((m) => new m.ClaudeRunnerProvider());
          break;
        case "codex":
          this.providerPromise = import("@skynet/runner-sdk/codex").then((m) => new m.CodexRunnerProvider());
          break;
        case "gemini":
          this.providerPromise = import("@skynet/runner-sdk/gemini").then((m) => new m.GeminiRunnerProvider());
          break;
        case "cursor":
          this.providerPromise = import("@skynet/runner-sdk/cursor").then((m) => new m.CursorRunnerProvider());
          break;
        case "copilot":
          this.providerPromise = import("@skynet/runner-sdk/copilot").then((m) => new m.CopilotRunnerProvider());
          break;
        default:
          this.providerPromise = Promise.resolve(new MockRunnerProvider());
      }
    }
    return this.providerPromise;
  }

  private slug(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32);
  }

  private events(): RunnerEvents {
    return {
      onLog: (agentId, line) => void this.hub.agentLog(agentId, line),
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
    // Free the runner back to idle.
    if (live?.runnerId) {
      const runner = await this.store.getRunner(live.runnerId);
      if (runner) await this.hub.upsertRunner({ ...runner, status: "idle", idleSince: now() });
    }
    // Move the owning task to Done.
    if (live?.taskId) {
      const task = await this.store.getTask(live.taskId);
      if (task) await this.hub.upsertTask({ ...task, state: "done" });
    }
    // W3: derive the modules actually touched from the changed files.
    const agent = await this.store.getAgent(agentId);
    if (agent && agent.modifiedFiles.length) {
      const modules = this.moduleMap.modulesForFiles(agent.modifiedFiles);
      if (modules.length) {
        await this.store.putAgent({ ...agent, modules });
        await this.hub.refreshConflicts(agent.workspaceId);
      }
    }
    await this.hub.agentCompleted(agentId, branch);
    this.live.delete(agentId);
  }

  /** Acquire an idle runner in a workspace; mark it busy. Throws if none. */
  private async acquireRunner(workspaceId: string): Promise<{ id: string; provider: Agent["provider"]; model: string }> {
    const runners = await this.store.listRunners(workspaceId);
    const idle = runners.find((r) => r.status === "idle");
    if (!idle) throw new NoCapacityError();
    await this.hub.upsertRunner({ ...idle, status: "busy", idleSince: null });
    return { id: idle.id, provider: idle.provider, model: idle.model };
  }

  // ── assignTask ────────────────────────────────────────────────────────────
  async assignTask(projectId: string, taskId: string): Promise<Agent> {
    const task = await this.store.getTask(taskId);
    if (!task || task.projectId !== projectId) throw new Error("Task not found");
    const project = await this.store.getProject(projectId);
    if (!project) throw new Error("Project not found");

    const runner = await this.acquireRunner(project.workspaceId);
    const agentId = `${this.slug(task.text)}-${++this.seq}`;
    const branch = `agent/${this.slug(task.text)}`;
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
    };

    await this.hub.createAgent(agent);
    void this.hub.refreshConflicts(agent.workspaceId);
    await this.hub.upsertTask({ ...task, state: "assigned", agentId });
    await this.hub.upsertProject({ ...project, agentIds: [...project.agentIds, agentId] });

    const provider = await this.getProvider();
    const handle = await provider.start(
      { agentId, projectId, task: task.text, model: runner.model, branch, cwd: config.runnerCwd },
      this.events(),
    );
    this.live.set(agentId, { handle, runnerId: runner.id, taskId });
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
      branch: forkBranch,
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

    const provider = await this.getProvider();
    const handle = await provider.start(
      { agentId, projectId: parent.projectId, task: parent.name, model: runner.model, branch: agent.branch, cwd: config.runnerCwd, parentId, branchFromStep: stepIndex },
      this.events(),
    );
    this.live.set(agentId, { handle, runnerId: runner.id, taskId: null });
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
    if (agent?.runnerId) {
      const runner = await this.store.getRunner(agent.runnerId);
      if (runner) await this.hub.upsertRunner({ ...runner, status: "idle", idleSince: now() });
    }
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
    if (!live) {
      const reply = `(${agentId}) noted — I'll factor that in.`;
      await this.hub.agentLog(agentId, `↳ ${reply}`);
      return reply;
    }
    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        this.chatWaiters.delete(agentId);
        resolve("(no reply)");
      }, 5_000);
      this.chatWaiters.set(agentId, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      void live.handle.message(text);
    });
  }

  async stopAgent(agentId: string): Promise<void> {
    const live = this.live.get(agentId);
    if (live) {
      await live.handle.stop();
      this.live.delete(agentId);
    }
  }

  isBusy(runnerId: string): boolean {
    for (const l of this.live.values()) if (l.runnerId === runnerId) return true;
    return false;
  }
}
