// ─── Operations ───────────────────────────────────────────────────────────
// The workspace-scoped service layer behind the product surface: create a
// project, add & assign tasks, drive runs, resolve HITL, manage the fleet.
// Every front-end (the HTTP API today, the MCP server next) delegates here, so
// there is exactly ONE implementation of each action and no drift between the
// human and agent-facing contracts.
//
// The boundary: callers own INPUT VALIDATION (the Zod request schemas) and
// transport-specific ERROR MAPPING (HTTP status codes / MCP errors). Operations
// owns the DOMAIN LOGIC — existence + workspace-ownership checks, id minting,
// and the persist-then-publish mutation via the Hub / Orchestrator.

import type {
  TaskRun,
  AuditRecord,
  ConfigureRunnerRequest,
  CreateProjectRequest,
  CreateTaskRequest,
  HitlItem,
  Project,
  ProviderInfo,
  ResolveRequest,
  Resolution,
  Agent,
  Snapshot,
  Task,
  UpdateProjectRequest,
  UpdateRunnerRequest,
  UpdateTaskRequest,
} from "@skynet/shared";
import { modelValidForProvider } from "@skynet/shared";
import { existsSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { assertApprovable, CommandDeniedError } from "./command-safety.js";
import { config, now } from "./config.js";
import { isGitRepo } from "./fs-browse.js";
import { githubService } from "./github/index.js";
import type { CapturedDiff, Hub } from "./hub.js";
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

/** A kanban move that isn't a legal human transition. 400. */
export class InvalidTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Can't move a task from "${from}" to "${to}".`);
    this.name = "InvalidTransitionError";
  }
}

/** A task can't leave `backlog` until its agent eligibility is set. 400. */
export class AssignmentRequiredError extends Error {
  constructor() {
    super("Set an agent (any, or specific agents) before moving this task out of backlog.");
    this.name = "AssignmentRequiredError";
  }
}

// Legal HUMAN kanban moves (the autonomy loop uses its own paths). `ongoing` is
// run-driven — a human uses Stop on the run, or abandons back to `todo` (which
// stops+detaches the run). `todo → ongoing` is "Start now" (assignTask), not here.
const HUMAN_TRANSITIONS: Record<Task["state"], Task["state"][]> = {
  backlog: ["triage"],
  triage: ["todo", "backlog"],
  todo: ["triage", "backlog"],
  ongoing: ["todo"],
  review: ["done", "todo"],
  done: ["triage", "backlog"],
};

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
  listRuns(ws: string): Promise<TaskRun[]> {
    return this.store.listRuns(ws);
  }
  listAgents(ws: string): Promise<Agent[]> {
    return this.store.listAgents(ws);
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

  async getRun(ws: string, runId: string): Promise<TaskRun> {
    const agent = await this.store.getRun(runId);
    if (!agent || agent.workspaceId !== ws) throw new NotFoundError("TaskRun");
    return agent;
  }

  // ── HITL ──────────────────────────────────────────────────────────────────
  /** Resolve a HITL item and deliver the decision to the agent (idempotent). */
  async resolveHitl(ws: string, hitlId: string, input: ResolveRequest, operatorId: string): Promise<HitlItem> {
    const item = await this.store.getHitl(hitlId);
    if (!item || item.workspaceId !== ws) throw new NotFoundError("HITL item");
    // A catastrophic command can NEVER be approved, even if an operator
    // fat-fingers "approve" on the gate — re-validate the command against the
    // denylist server-side and refuse before recording any decision. GATE-risk
    // commands still approve; only hard-DENY patterns (e.g. `rm -rf /`) throw.
    if (input.action === "approve" && item.kind === "approval" && item.command) {
      assertApprovable(item.command); // throws CommandDeniedError → 422, nothing recorded
    }
    const resolution: Resolution = {
      action: input.action,
      optionIndex: input.optionIndex ?? null,
      guidance: input.guidance ?? null,
      by: operatorId,
      at: now(),
    };
    // Capture the real diff into the audit record now, while the worktree still
    // exists — it's retired once the branch merges, so a diff/merge decision
    // can't be re-fetched afterward. Best-effort; the summary always remains.
    let capturedDiff: CapturedDiff | undefined;
    if (item.kind === "diff" || item.kind === "merge") {
      const d = await this.orchestrator.runDiff(item.runId).catch(() => null);
      if (d && (d.patch || d.files.length > 0)) capturedDiff = { patch: d.patch, files: d.files };
    }
    const resolved = await this.hub.resolveHitl(hitlId, resolution, capturedDiff);
    // Deliver to the agent & resume/merge only on the FIRST resolve (first-writer
    // wins in the Hub; a later resolve returns the existing item, unchanged `at`).
    if (resolved && resolved.resolution?.at === resolution.at) {
      await this.orchestrator.deliver(item, resolution);
    }
    return resolved ?? item;
  }

  // ── agent actions ───────────────────────────────────────────────────────
  async chatAgent(ws: string, runId: string, text: string): Promise<string> {
    await this.getRun(ws, runId); // 404 unless it's in this workspace
    return this.orchestrator.chat(runId, text);
  }
  async forkAgent(ws: string, runId: string): Promise<TaskRun> {
    await this.getRun(ws, runId);
    return this.orchestrator.fork(runId);
  }
  /** The real diff (unified patch + stat) of a run's branch, for the review UI. */
  async runDiff(ws: string, runId: string): Promise<{ patch: string; add: number; del: number; files: string[] }> {
    await this.getRun(ws, runId); // 404 unless it's in this workspace
    return this.orchestrator.runDiff(runId);
  }
  async archiveAgent(ws: string, runId: string, archived: boolean): Promise<TaskRun> {
    await this.getRun(ws, runId);
    const updated = await this.hub.setRunArchived(runId, archived);
    if (!updated) throw new NotFoundError("TaskRun");
    return updated;
  }
  /** Pause a running/waiting task run — halts its agent, keeps the session. */
  async pauseAgent(ws: string, runId: string): Promise<TaskRun> {
    await this.getRun(ws, runId); // 404 unless it's in this workspace
    const updated = await this.orchestrator.pauseAgent(runId);
    if (!updated) throw new NotFoundError("TaskRun");
    return updated;
  }
  /** Resume a paused task run back into the running state. */
  async resumeAgent(ws: string, runId: string): Promise<TaskRun> {
    await this.getRun(ws, runId); // 404 unless it's in this workspace
    const updated = await this.orchestrator.resumeAgent(runId);
    if (!updated) throw new NotFoundError("TaskRun");
    return updated;
  }
  /**
   * Operator "stop": terminal. Halt execution, free the agent, retire the
   * worktree, and mark the run done — NOT the detach-only orchestrator.stopAgent
   * (which leaves status untouched). Returns the now-terminal run.
   */
  async stopAgent(ws: string, runId: string): Promise<TaskRun> {
    await this.getRun(ws, runId); // 404 unless it's in this workspace
    const updated = await this.orchestrator.haltAgent(runId);
    if (!updated) throw new NotFoundError("TaskRun");
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
      runIds: [],
      status: "active",
      autonomy: true,
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
  /**
   * Clone a GitHub-connected project's repo into a managed local checkout and
   * mark it git-backed — the missing link for headless/server (GCP) use, where
   * (unlike the desktop) there's no folder to point at. Uses the workspace's
   * GitHub token (via githubService; token never exposed). Idempotent: an
   * existing checkout is reused. After this, the orchestrator cuts worktrees
   * from `repoPath` and the normal edit→diff→push(PR) loop works.
   */
  async cloneRepoIntoProject(ws: string, id: string): Promise<Project> {
    const project = await this.store.getProject(id);
    if (!project || project.workspaceId !== ws) throw new NotFoundError("Project");
    if (!project.repo) throw new Error("Project is not bound to a GitHub repo — set its repo first.");
    const base = config.reposDir ? resolvePath(config.reposDir) : resolvePath(".skynet-repos");
    const dest = join(base, project.id);
    if (!existsSync(join(dest, ".git"))) {
      await githubService.cloneRepo(ws, project.repo, dest);
    }
    return this.hub.upsertProject({ ...project, repoPath: dest, gitBacked: true });
  }
  async deleteProject(ws: string, id: string): Promise<void> {
    const existing = await this.store.getProject(id);
    if (!existing || existing.workspaceId !== ws) throw new NotFoundError("Project");
    // haltAgent (not the detach-only stopAgent) so each agent is left terminal
    // and its runner freed before the project record goes away.
    for (const runId of existing.runIds) await this.orchestrator.haltAgent(runId);
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
      description: input.description?.trim() || null,
      state: "backlog",
      runId: null,
      autoPick: false,
      assessment: null,
      reviewFlaggedReason: null,
      assignment: { mode: "unassigned", agentIds: [] },
      order: inProject.length,
    };
    return this.hub.upsertTask(task);
  }
  async updateTask(ws: string, tid: string, patch: UpdateTaskRequest): Promise<Task> {
    const task = await this.store.getTask(tid);
    if (!task || task.workspaceId !== ws) throw new NotFoundError("Task");
    if (patch.assignment) {
      // Clearing eligibility back to `unassigned` is only allowed while parked in
      // backlog — otherwise a running/queued task could lose the set it left
      // backlog with, breaking the invariant the transition gate enforces.
      if (patch.assignment.mode === "unassigned" && task.state !== "backlog") {
        throw new AssignmentRequiredError();
      }
      // Pin only to agents that actually exist in this workspace's fleet.
      if (patch.assignment.mode === "agents") {
        const fleet = new Set((await this.store.listAgents(ws)).map((a) => a.id));
        const unknown = patch.assignment.agentIds.filter((id) => !fleet.has(id));
        if (unknown.length > 0) throw new NotFoundError(`Agent(s) ${unknown.join(", ")}`);
      }
    }
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
  async assignTask(ws: string, projectId: string, tid: string): Promise<TaskRun> {
    const project = await this.store.getProject(projectId);
    if (!project || project.workspaceId !== ws) throw new NotFoundError("Project");
    return this.orchestrator.assignTask(projectId, tid);
  }

  /**
   * Human-driven kanban move, validated against HUMAN_TRANSITIONS. Handles the
   * gated edges: review→done approves an open diff HITL (merges → done) when one
   * exists; abandoning `ongoing`/`review` or demoting a `done` task stops+archives
   * its run and detaches it so the task returns clean.
   */
  async transitionTask(ws: string, tid: string, to: Task["state"], operatorId: string): Promise<Task> {
    const task = await this.store.getTask(tid);
    if (!task || task.workspaceId !== ws) throw new NotFoundError("Task");
    if (task.state === to) return task; // no-op
    if (!(HUMAN_TRANSITIONS[task.state] ?? []).includes(to)) {
      throw new InvalidTransitionError(task.state, to);
    }

    // Leaving backlog requires an agent-eligibility choice (who may take it).
    // Unassigned tasks stay parked in backlog until a human — later, an agent —
    // sets `any` or a specific pool.
    // (Legacy tasks persisted before this field default to `unassigned`.)
    if (task.state === "backlog" && to !== "backlog" && (task.assignment?.mode ?? "unassigned") === "unassigned") {
      throw new AssignmentRequiredError();
    }

    // review → done: if the run still has an open review HITL, approve it — that
    // merges the branch and marks the task done through the normal path.
    if (task.state === "review" && to === "done" && task.runId) {
      const open = (await this.store.listQueue(ws)).find(
        (h) => h.runId === task.runId && !h.resolvedAt,
      );
      if (open) {
        await this.resolveHitl(ws, open.id, { action: "approve" }, operatorId);
        return (await this.store.getTask(tid)) ?? task;
      }
    }

    // Moves that abandon in-flight work (ongoing/review → todo, or demoting a
    // done task) stop + archive the run and detach it, so the task starts fresh.
    const abandonsRun =
      !!task.runId &&
      ((task.state === "ongoing" || task.state === "review") && to === "todo" ||
        (task.state === "done" && (to === "triage" || to === "backlog")));
    if (abandonsRun && task.runId) {
      await this.orchestrator.stopAgent(task.runId, "task moved off the run by an operator").catch(() => undefined);
      await this.hub.setRunArchived(task.runId, true).catch(() => undefined);
    }

    return this.hub.upsertTask({
      ...task,
      state: to,
      ...(abandonsRun ? { runId: null } : {}),
      reviewFlaggedReason: null,
    });
  }

  // ── fleet ──────────────────────────────────────────────────────────────
  async configureRunner(ws: string, input: ConfigureRunnerRequest): Promise<Agent> {
    // A runner's model must be one the chosen provider actually offers — the
    // provider catalog is the single source of truth (DEF-004). An invalid model
    // is a 400 (fail() maps a plain Error → 400), matching the HTTP contract.
    const invalid = modelValidForProvider(await this.store.listProviders(), input.provider, input.model);
    if (invalid) throw new Error(invalid);
    const id = input.name ?? this.uid("runner");
    const runner: Agent = {
      id,
      workspaceId: ws,
      name: id,
      provider: input.provider,
      model: input.model,
      status: "idle",
      idleSince: now(),
    };
    return this.hub.upsertAgent(runner);
  }
  async updateAgent(ws: string, id: string, patch: UpdateRunnerRequest): Promise<Agent> {
    const existing = await this.store.getAgent(id);
    if (!existing || existing.workspaceId !== ws) throw new NotFoundError("Agent");
    // A model change is validated against the runner's existing provider (DEF-004).
    if (patch.model !== undefined) {
      const invalid = modelValidForProvider(await this.store.listProviders(), existing.provider, patch.model);
      if (invalid) throw new Error(invalid);
    }
    return this.hub.upsertAgent({ ...existing, ...patch });
  }
  async retireRunner(ws: string, id: string): Promise<void> {
    const existing = await this.store.getAgent(id);
    if (!existing || existing.workspaceId !== ws) throw new NotFoundError("Agent");
    // Busy-runner guard — enforced server-side (Backend Brief §04).
    if (existing.status === "busy" || this.orchestrator.isBusy(id)) throw new RunnerBusyError();
    await this.hub.deleteAgent(id);
  }
}
