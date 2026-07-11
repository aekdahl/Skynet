// ─── Operations ───────────────────────────────────────────────────────────
// The workspace-scoped service layer behind the product surface: create a
// project, add & assign tasks, drive agents, resolve HITL, manage the fleet.
// Every front-end (the HTTP API today, the MCP server next) delegates here, so
// there is exactly ONE implementation of each action and no drift between the
// human and agent-facing contracts.
//
// The boundary: callers own INPUT VALIDATION (the Zod request schemas) and
// transport-specific ERROR MAPPING (HTTP status codes / MCP errors). Operations
// owns the DOMAIN LOGIC — existence + workspace-ownership checks, id minting,
// and the persist-then-publish mutation via the Hub / Orchestrator.

import type {
  Agent,
  AuditRecord,
  ConfigureRunnerRequest,
  CreateProjectRequest,
  CreateTaskRequest,
  HitlItem,
  Project,
  ProviderInfo,
  ResolveRequest,
  Resolution,
  Runner,
  Snapshot,
  Task,
  UpdateProjectRequest,
  UpdateRunnerRequest,
  UpdateTaskRequest,
} from "@skynet/shared";
import { modelValidForProvider } from "@skynet/shared";
import { resolve as resolvePath } from "node:path";
import { now } from "./config.js";
import { isGitRepo } from "./fs-browse.js";
import type { Hub } from "./hub.js";
import { type Orchestrator } from "./orchestrator.js";
import { withSecretAvailability } from "./secrets/index.js";
import type { Store } from "./store/store.js";

/** A referenced entity does not exist (or isn't in the caller's workspace). 404. */
export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = "NotFoundError";
  }
}

/** A runner can't be retired while it's executing an agent. 409. */
export class RunnerBusyError extends Error {
  constructor() {
    super("Cannot retire a busy runner");
    this.name = "RunnerBusyError";
  }
}

export interface OperationsDeps {
  store: Store;
  hub: Hub;
  orchestrator: Orchestrator;
}

export class Operations {
  private seq = 0;
  private readonly store: Store;
  private readonly hub: Hub;
  private readonly orchestrator: Orchestrator;

  constructor(deps: OperationsDeps) {
    this.store = deps.store;
    this.hub = deps.hub;
    this.orchestrator = deps.orchestrator;
  }

  private uid(prefix: string): string {
    return `${prefix}-${Date.now().toString(36)}-${++this.seq}`;
  }
  private slug(t: string): string {
    return t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24);
  }

  // ── reads (workspace-scoped) ──────────────────────────────────────────────
  async snapshot(ws: string): Promise<Snapshot> {
    const snap = await this.store.snapshot(ws);
    snap.providers = await withSecretAvailability(snap.providers, ws);
    return snap;
  }
  listProviders(ws: string): Promise<ProviderInfo[]> {
    return this.store.listProviders().then((p) => withSecretAvailability(p, ws));
  }
  listProjects(ws: string): Promise<Project[]> {
    return this.store.listProjects(ws);
  }
  listTasks(ws: string): Promise<Task[]> {
    return this.store.listTasks(ws);
  }
  listAgents(ws: string): Promise<Agent[]> {
    return this.store.listAgents(ws);
  }
  listRunners(ws: string): Promise<Runner[]> {
    return this.store.listRunners(ws);
  }
  listHitl(ws: string): Promise<HitlItem[]> {
    return this.store.listQueue(ws);
  }
  listAudit(ws: string): Promise<AuditRecord[]> {
    return this.store.listAudit(ws);
  }

  // ── audit maintenance (archive/restore + delete, per-record and bulk) ─────
  // Records are addressed by hitlId, scoped to the caller's workspace; the Hub
  // persists-then-publishes so the audit view can refresh off the audit.* event.
  archiveAudit(ws: string, hitlId: string, archived: boolean): Promise<void> {
    return this.hub.archiveAudit(ws, hitlId, archived);
  }
  deleteAudit(ws: string, hitlId: string): Promise<void> {
    return this.hub.deleteAudit(ws, hitlId);
  }
  archiveAllAudit(ws: string): Promise<void> {
    return this.hub.archiveAllAudit(ws);
  }
  clearAudit(ws: string): Promise<void> {
    return this.hub.clearAudit(ws);
  }

  async getAgent(ws: string, agentId: string): Promise<Agent> {
    const agent = await this.store.getAgent(agentId);
    if (!agent || agent.workspaceId !== ws) throw new NotFoundError("Agent");
    return agent;
  }

  // ── HITL ──────────────────────────────────────────────────────────────────
  /** Resolve a HITL item and deliver the decision to the agent (idempotent). */
  async resolveHitl(ws: string, hitlId: string, input: ResolveRequest, operatorId: string): Promise<HitlItem> {
    const item = await this.store.getHitl(hitlId);
    if (!item || item.workspaceId !== ws) throw new NotFoundError("HITL item");
    const resolution: Resolution = {
      action: input.action,
      optionIndex: input.optionIndex ?? null,
      guidance: input.guidance ?? null,
      by: operatorId,
      at: now(),
    };
    const resolved = await this.hub.resolveHitl(hitlId, resolution);
    // Deliver to the agent & resume/merge only on the FIRST resolve (first-writer
    // wins in the Hub; a later resolve returns the existing item, unchanged `at`).
    if (resolved && resolved.resolution?.at === resolution.at) {
      await this.orchestrator.deliver(item, resolution);
    }
    return resolved ?? item;
  }

  // ── agent actions ───────────────────────────────────────────────────────
  async chatAgent(ws: string, agentId: string, text: string): Promise<string> {
    await this.getAgent(ws, agentId); // 404 unless it's in this workspace
    return this.orchestrator.chat(agentId, text);
  }
  async forkAgent(ws: string, agentId: string): Promise<Agent> {
    await this.getAgent(ws, agentId);
    return this.orchestrator.fork(agentId);
  }
  async archiveAgent(ws: string, agentId: string, archived: boolean): Promise<Agent> {
    await this.getAgent(ws, agentId);
    const updated = await this.hub.setAgentArchived(agentId, archived);
    if (!updated) throw new NotFoundError("Agent");
    return updated;
  }
  /** Pause a running/waiting agent — halts its runner, keeps the session. */
  async pauseAgent(ws: string, agentId: string): Promise<Agent> {
    await this.getAgent(ws, agentId); // 404 unless it's in this workspace
    const updated = await this.orchestrator.pauseAgent(agentId);
    if (!updated) throw new NotFoundError("Agent");
    return updated;
  }
  /** Resume a paused agent back into the running state. */
  async resumeAgent(ws: string, agentId: string): Promise<Agent> {
    await this.getAgent(ws, agentId); // 404 unless it's in this workspace
    const updated = await this.orchestrator.resumeAgent(agentId);
    if (!updated) throw new NotFoundError("Agent");
    return updated;
  }
  /**
   * Operator "stop": terminal. Halt execution, free the runner, retire the
   * worktree, and mark the agent done — NOT the detach-only orchestrator.stopAgent
   * (which leaves status untouched). Returns the now-terminal agent.
   */
  async stopAgent(ws: string, agentId: string): Promise<Agent> {
    await this.getAgent(ws, agentId); // 404 unless it's in this workspace
    const updated = await this.orchestrator.haltAgent(agentId);
    if (!updated) throw new NotFoundError("Agent");
    return updated;
  }

  // ── projects ──────────────────────────────────────────────────────────────
  createProject(ws: string, input: CreateProjectRequest): Promise<Project> {
    // A local repoPath that contains a .git is git-backed → Skynet auto-manages a
    // worktree per agent + the merge queue against it (desktop-first default).
    const repoPath = input.repoPath ? resolvePath(input.repoPath) : null;
    const project: Project = {
      id: this.uid("p"),
      workspaceId: ws,
      name: input.name,
      goal: input.goal,
      agentIds: [],
      status: "active",
      repoPath,
      gitBacked: repoPath ? isGitRepo(repoPath) : false,
      repo: input.repo,
    };
    return this.hub.upsertProject(project);
  }
  async updateProject(ws: string, id: string, patch: UpdateProjectRequest): Promise<Project> {
    const existing = await this.store.getProject(id);
    if (!existing || existing.workspaceId !== ws) throw new NotFoundError("Project");
    // Rebinding the local folder recomputes git-backing (null clears it).
    const rebind =
      patch.repoPath !== undefined
        ? (() => {
            const rp = patch.repoPath ? resolvePath(patch.repoPath) : null;
            return { repoPath: rp, gitBacked: rp ? isGitRepo(rp) : false };
          })()
        : {};
    return this.hub.upsertProject({ ...existing, ...patch, ...rebind });
  }
  async deleteProject(ws: string, id: string): Promise<void> {
    const existing = await this.store.getProject(id);
    if (!existing || existing.workspaceId !== ws) throw new NotFoundError("Project");
    // haltAgent (not the detach-only stopAgent) so each agent is left terminal
    // and its runner freed before the project record goes away.
    for (const agentId of existing.agentIds) await this.orchestrator.haltAgent(agentId);
    await this.hub.deleteProject(id);
  }

  // ── tasks ──────────────────────────────────────────────────────────────
  async createTask(ws: string, projectId: string, input: CreateTaskRequest): Promise<Task> {
    const project = await this.store.getProject(projectId);
    if (!project || project.workspaceId !== ws) throw new NotFoundError("Project");
    // New tasks append to the bottom of the backlog (highest order = lowest
    // priority) so existing manual ordering is preserved.
    const inProject = (await this.store.listTasks(ws)).filter((t) => t.projectId === projectId);
    const task: Task = {
      id: this.uid(`t-${this.slug(project.name)}`),
      workspaceId: ws,
      projectId,
      text: input.text,
      state: "backlog",
      agentId: null,
      order: inProject.length,
    };
    return this.hub.upsertTask(task);
  }
  async updateTask(ws: string, tid: string, patch: UpdateTaskRequest): Promise<Task> {
    const task = await this.store.getTask(tid);
    if (!task || task.workspaceId !== ws) throw new NotFoundError("Task");
    return this.hub.upsertTask({ ...task, ...patch });
  }
  /**
   * Manually promote (up) or demote (down) a task within its project's backlog.
   * Swaps priority with the adjacent backlog task; a no-op at the ends. Renumbers
   * the backlog to a stable 0..n-1 so ties (legacy unset order) resolve cleanly.
   */
  async moveTask(ws: string, tid: string, direction: "up" | "down"): Promise<Task> {
    const task = await this.store.getTask(tid);
    if (!task || task.workspaceId !== ws) throw new NotFoundError("Task");
    const rank = (t: Task) => t.order ?? 0;
    const backlog = (await this.store.listTasks(ws))
      .filter((t) => t.projectId === task.projectId && t.state === task.state)
      .sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
    const idx = backlog.findIndex((t) => t.id === tid);
    const target = direction === "up" ? idx - 1 : idx + 1;
    if (idx < 0 || target < 0 || target >= backlog.length) return task; // at an end — no-op
    // Move the task to its new slot, then renumber the whole list 0..n-1.
    backlog.splice(idx, 1);
    backlog.splice(target, 0, task);
    for (let i = 0; i < backlog.length; i++) {
      if (rank(backlog[i]!) !== i) await this.hub.upsertTask({ ...backlog[i]!, order: i });
    }
    return (await this.store.getTask(tid))!;
  }
  async deleteTask(ws: string, tid: string): Promise<void> {
    const task = await this.store.getTask(tid);
    if (!task || task.workspaceId !== ws) throw new NotFoundError("Task");
    await this.hub.deleteTask(tid);
  }
  /** Assign a task to a fresh agent (idempotent — see Orchestrator.assignTask). */
  async assignTask(ws: string, projectId: string, tid: string): Promise<Agent> {
    const project = await this.store.getProject(projectId);
    if (!project || project.workspaceId !== ws) throw new NotFoundError("Project");
    return this.orchestrator.assignTask(projectId, tid);
  }

  // ── fleet ──────────────────────────────────────────────────────────────
  async configureRunner(ws: string, input: ConfigureRunnerRequest): Promise<Runner> {
    // A runner's model must be one the chosen provider actually offers — the
    // provider catalog is the single source of truth (DEF-004). An invalid model
    // is a 400 (fail() maps a plain Error → 400), matching the HTTP contract.
    const invalid = modelValidForProvider(await this.store.listProviders(), input.provider, input.model);
    if (invalid) throw new Error(invalid);
    const id = input.name ?? this.uid("runner");
    const runner: Runner = {
      id,
      workspaceId: ws,
      name: id,
      provider: input.provider,
      model: input.model,
      status: "idle",
      idleSince: now(),
    };
    return this.hub.upsertRunner(runner);
  }
  async updateRunner(ws: string, id: string, patch: UpdateRunnerRequest): Promise<Runner> {
    const existing = await this.store.getRunner(id);
    if (!existing || existing.workspaceId !== ws) throw new NotFoundError("Runner");
    // A model change is validated against the runner's existing provider (DEF-004).
    if (patch.model !== undefined) {
      const invalid = modelValidForProvider(await this.store.listProviders(), existing.provider, patch.model);
      if (invalid) throw new Error(invalid);
    }
    return this.hub.upsertRunner({ ...existing, ...patch });
  }
  async retireRunner(ws: string, id: string): Promise<void> {
    const existing = await this.store.getRunner(id);
    if (!existing || existing.workspaceId !== ws) throw new NotFoundError("Runner");
    // Busy-runner guard — enforced server-side (Backend Brief §04).
    if (existing.status === "busy" || this.orchestrator.isBusy(id)) throw new RunnerBusyError();
    await this.hub.deleteRunner(id);
  }
}
