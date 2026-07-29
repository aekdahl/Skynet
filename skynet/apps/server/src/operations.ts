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
import { dirname, join, resolve as resolvePath } from "node:path";
import { assertApprovable, CommandDeniedError } from "./command-safety.js";
import { normalizeCommand, rememberableRisk } from "./approval-policy.js";
import { config, now } from "./config.js";
import { generateAgentName } from "./fleet-names.js";
import { isGitRepo } from "./fs-browse.js";
import { projectPreview, type PreviewState } from "./preview/project-preview.js";
import { githubService } from "./github/index.js";
import {
  answerProjectQuestion,
  answerProjectQuestionStream,
  type AssistantAction,
  type ChatTurn,
} from "./project-assistant.js";
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

  /** Repo-aware project chat assistant — answers about the project's live status
   *  and its repository content (see project-assistant.ts). */
  async projectAssistant(
    workspaceId: string,
    projectId: string,
    question: string,
    history?: ChatTurn[],
  ): Promise<{ reply: string; action: AssistantAction | null }> {
    const project = await this.store.getProject(projectId);
    if (!project || project.workspaceId !== workspaceId) throw new NotFoundError("Project");
    return answerProjectQuestion(this.store, { workspaceId, project, question, history });
  }

  /** Streaming form of {@link projectAssistant} — yields the answer as text
   *  deltas. Ownership is validated before the first yield (404 stays JSON). */
  async *projectAssistantStream(
    workspaceId: string,
    projectId: string,
    question: string,
    history?: ChatTurn[],
  ): AsyncGenerator<string> {
    const project = await this.store.getProject(projectId);
    if (!project || project.workspaceId !== workspaceId) throw new NotFoundError("Project");
    yield* answerProjectQuestionStream(this.store, { workspaceId, project, question, history });
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

  /** Fetch a project scoped to the workspace, or throw NotFoundError (404). */
  async getProject(ws: string, projectId: string): Promise<Project> {
    const project = await this.store.getProject(projectId);
    if (!project || project.workspaceId !== ws) throw new NotFoundError("Project");
    return project;
  }

  // ── live preview (Phase-1 v0) ─────────────────────────────────────────────
  previewState(ws: string, projectId: string): Promise<PreviewState> {
    return this.getProject(ws, projectId).then(() => projectPreview.state(projectId));
  }
  async previewStart(ws: string, projectId: string): Promise<PreviewState> {
    const project = await this.getProject(ws, projectId);
    if (!project.repoPath) throw new Error("This project has no local folder to preview.");
    return projectPreview.start(projectId, project.repoPath, ws);
  }
  async previewRestart(ws: string, projectId: string): Promise<PreviewState> {
    const project = await this.getProject(ws, projectId);
    if (!project.repoPath) throw new Error("This project has no local folder to preview.");
    return projectPreview.restart(projectId, project.repoPath, ws);
  }
  async previewStop(ws: string, projectId: string): Promise<PreviewState> {
    await this.getProject(ws, projectId);
    return projectPreview.stop(projectId);
  }
  async previewRefresh(ws: string, projectId: string): Promise<PreviewState> {
    await this.getProject(ws, projectId);
    return projectPreview.refresh(projectId);
  }

  // ── per-run pre-merge preview ("Preview this change") ─────────────────────
  // Preview a single run's branch (`agent/<runId>`) BEFORE it merges, so an
  // operator can verify the change visually. Scoped to the run's workspace; the
  // run's project must have a local folder.
  async runPreviewState(ws: string, runId: string): Promise<PreviewState> {
    await this.getRun(ws, runId);
    return projectPreview.state(`run:${runId}`);
  }
  private async runPreviewOpts(ws: string, runId: string) {
    const run = await this.getRun(ws, runId);
    const project = await this.getProject(ws, run.projectId);
    if (!project.repoPath) throw new Error("This project has no local folder to preview.");
    return { repoPath: project.repoPath, projectId: run.projectId, branch: run.branch, workspaceId: ws };
  }
  async runPreviewStart(ws: string, runId: string): Promise<PreviewState> {
    return projectPreview.startRun(runId, await this.runPreviewOpts(ws, runId));
  }
  async runPreviewRestart(ws: string, runId: string): Promise<PreviewState> {
    return projectPreview.restartRun(runId, await this.runPreviewOpts(ws, runId));
  }
  async runPreviewStop(ws: string, runId: string): Promise<PreviewState> {
    await this.getRun(ws, runId);
    return projectPreview.stop(`run:${runId}`);
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
      // Approve-and-remember: add a standing "approve always" rule for this exact
      // command to the project, so identical future commands auto-approve. Honored
      // only for rememberable (low/medium, non-deny) commands — boundary/high-risk
      // ops can never become a persistent auto-approval. De-duped by command.
      if (input.remember && input.action === "approve" && item.kind === "approval" && item.command) {
        await this.rememberApproval(item.runId, item.command, operatorId);
      }
    }
    return resolved ?? item;
  }

  /** Add a standing "approve always" rule for `command` to the run's project, if
   *  the command is rememberable (low/medium, non-deny) and not already stored.
   *  Best-effort — a non-rememberable command or a missing project is a silent
   *  no-op (the approval itself already succeeded). */
  private async rememberApproval(runId: string, command: string, operatorId: string): Promise<void> {
    const cap = rememberableRisk(command);
    if (!cap) return; // high-risk / boundary ops can never become a standing rule
    const run = await this.store.getRun(runId);
    const project = run ? await this.store.getProject(run.projectId) : undefined;
    if (!project) return;
    const norm = normalizeCommand(command);
    if (project.approvalRules.some((r) => normalizeCommand(r.command) === norm)) return; // de-dupe
    const rule = { id: this.uid("ar"), command: norm, riskCap: cap, createdBy: operatorId, createdAt: now() };
    await this.hub.upsertProject({ ...project, approvalRules: [...project.approvalRules, rule] });
  }

  // ── agent actions ───────────────────────────────────────────────────────
  async chatAgent(ws: string, runId: string, text: string): Promise<string> {
    await this.getRun(ws, runId); // 404 unless it's in this workspace
    return this.orchestrator.chat(runId, text);
  }
  /** Streaming chat — yields the reply as text deltas. Caller (the streaming
   *  route) checks ownership first via getRun, so the generator can stream. */
  async *chatAgentStream(ws: string, runId: string, text: string): AsyncGenerator<string> {
    await this.getRun(ws, runId); // 404 unless it's in this workspace
    yield* this.orchestrator.chatStream(runId, text);
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
  async createProject(ws: string, input: CreateProjectRequest): Promise<Project> {
    // "Create a new repo" binding: make the GitHub repo FIRST (outward-facing, so
    // it's gated behind an explicit confirm in the UI) and bind the project to it.
    // If this throws (bad token, name taken, missing scope) the project is never
    // created — the operator sees the GitHub error, not an orphaned project. A new
    // repo supersedes any local folder; the fresh repo is auto-cloned below.
    let repo = input.repo;
    let repoPath = input.repoPath ? resolvePath(input.repoPath) : null;
    if (input.createRepo) {
      const created = await githubService.createRepo(ws, input.createRepo, { description: input.goal });
      repo = created.name; // "owner/repo"
      repoPath = null;
    }
    // A local repoPath that contains a .git is git-backed → Skynet auto-manages a
    // worktree per agent + the merge queue against it (desktop-first default).
    const project: Project = {
      id: this.uid("p"),
      workspaceId: ws,
      name: input.name,
      goal: input.goal,
      runIds: [],
      status: "active",
      autonomy: true,
      approvalLevel: config.defaultApprovalLevel,
      approvalRules: [],
      repoPath,
      gitBacked: repoPath ? isGitRepo(repoPath) : false,
      repo,
    };
    const created = await this.hub.upsertProject(project);
    this.maybeAutoClone(ws, created);
    return created;
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
    const updated = await this.hub.upsertProject({ ...existing, ...patch, ...rebind });
    this.maybeAutoClone(ws, updated); // binding a repo on a server clones it
    return updated;
  }
  /** Remove one standing "approve always" rule from a project (the operator
   *  revoking a previously-remembered auto-approval). No-op if it's already gone. */
  async removeApprovalRule(ws: string, id: string, ruleId: string): Promise<Project> {
    const existing = await this.store.getProject(id);
    if (!existing || existing.workspaceId !== ws) throw new NotFoundError("Project");
    const approvalRules = (existing.approvalRules ?? []).filter((r) => r.id !== ruleId);
    return this.hub.upsertProject({ ...existing, approvalRules });
  }
  /**
   * A repo-bound project with no local checkout is cloned in the BACKGROUND so
   * it's immediately workable — no manual "clone" step — whether that's a
   * headless server or the desktop. This is what makes a GitHub-only project
   * (pick a repo, no folder) exactly as ready as a folder-only one. Best-effort:
   * failures (GitHub not connected yet, network) are logged (the token is
   * already redacted by the clone path) and leave the project un-cloned; the
   * operator can retry via the "Clone repo" button.
   */
  private maybeAutoClone(ws: string, project: Project): void {
    if (!project.repo || project.repoPath) return;
    void this.cloneRepoIntoProject(ws, project.id).catch((err) =>
      console.warn(`[project ${project.id}] auto-clone failed: ${(err as Error).message}`),
    );
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
    // Default clone root: co-located with the durable file store, so on the
    // desktop it lands in the per-user data dir (dbPath = <userData>/…) and on a
    // server next to STORE=file — both persistent + writable. SKYNET_REPOS_DIR
    // overrides (e.g. /data/repos on a VM's mounted disk).
    const base = config.reposDir ? resolvePath(config.reposDir) : resolvePath(dirname(config.dbPath), "repos");
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
      archived: false,
      // Scheduling starts blank — the autonomous triage step estimates
      // `estimatedDurationMs`; `plannedStartAt` is operator-set via Steward/UI.
      estimatedDurationMs: null,
      plannedStartAt: null,
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
  /**
   * REVERSIBLE soft-hide: mark a task `archived` (hidden from the board + the
   * assistant's grounding context) without deleting it — un-archive (archived:
   * false) restores it. NEVER a hard delete; the record stays in the store.
   *
   * Refuses to archive a task that currently owns a LIVE run — one in `ongoing`/
   * `review` with a runId whose run hasn't finished. Archiving that would orphan
   * a running agent from the board; stop the run first. Un-archiving is always
   * allowed (nothing in flight to protect).
   */
  async archiveTask(ws: string, projectId: string, tid: string, archived: boolean): Promise<Task> {
    const task = await this.store.getTask(tid);
    if (!task || task.workspaceId !== ws || task.projectId !== projectId) throw new NotFoundError("Task");
    if (archived && task.runId && (task.state === "ongoing" || task.state === "review")) {
      const run = await this.store.getRun(task.runId);
      if (run && run.status !== "done") {
        throw new Error("stop the run first (/stop) or handle it in the app");
      }
    }
    return this.hub.upsertTask({ ...task, archived });
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

    const updated = await this.hub.upsertTask({
      ...task,
      state: to,
      ...(abandonsRun ? { runId: null } : {}),
      reviewFlaggedReason: null,
    });

    // Sync the linked TaskRun's status to match — the "review → done" path with
    // NO open HITL falls through here without going via resolveHitl → merge
    // (which sets run.status="done"), so without this the run could stay at
    // "review"/"running" while the board shows the card in Done. Idempotent —
    // best-effort so a bus/persistence hiccup doesn't undo the transition.
    if (to === "done" && !abandonsRun && updated.runId) {
      await this.hub.runStatus(updated.runId, "done").catch(() => undefined);
    }
    return updated;
  }

  /**
   * Force a task to `done` — the escape hatch when the normal review→done path
   * fails (e.g. the merge queue chokes on a conflict, an HITL got stuck, or the
   * run finished but the task didn't advance and there's no HITL to resolve).
   * Bypasses HUMAN_TRANSITIONS: usable from ANY state (except archived).
   * ALWAYS syncs run.status to "done" when a run is linked. Never merges the
   * branch — this is a "call it done" operator override, not a work-completion
   * signal for the runner; use the normal Approve → Done for that.
   */
  async forceTaskDone(ws: string, tid: string): Promise<Task> {
    const task = await this.store.getTask(tid);
    if (!task || task.workspaceId !== ws) throw new NotFoundError("Task");
    if (task.archived) throw new NotFoundError("Task"); // archived is a soft-hide, not force-doneable
    const updated = await this.hub.upsertTask({
      ...task,
      state: "done",
      reviewFlaggedReason: null,
    });
    if (updated.runId) {
      await this.hub.runStatus(updated.runId, "done").catch(() => undefined);
    }
    return updated;
  }

  // ── fleet ──────────────────────────────────────────────────────────────
  async configureRunner(ws: string, input: ConfigureRunnerRequest): Promise<Agent> {
    // Validate the provider+model pairing. ADVISORY on the model: the catalog is
    // curated suggestions, not an allowlist, so any non-empty model is accepted for
    // a known provider (a just-released model works without a catalog edit); only
    // an unknown provider or an empty model is a 400 (fail() maps Error → 400).
    const invalid = modelValidForProvider(await this.store.listProviders(), input.provider, input.model);
    if (invalid) throw new Error(invalid);
    // The id is a stable, opaque handle (runs reference it as agentId); the name
    // is the human-facing label shown on the board. Keeping them separate means
    // a rename never moves the id, and two agents can share a display name
    // without colliding. Auto-name to `<provider>-<name>` when none is given.
    const id = this.uid("runner");
    const existing = await this.store.listAgents(ws);
    const name = input.name?.trim() || generateAgentName(input.provider, existing.map((a) => a.name));
    const runner: Agent = {
      id,
      workspaceId: ws,
      name,
      provider: input.provider,
      credentialId: input.credentialId ?? null,
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
