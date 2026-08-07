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
  CreateFeatureRequest,
  CreateMilestoneRequest,
  CreateProjectRequest,
  CreateTaskRequest,
  Feature,
  HitlItem,
  Milestone,
  Project,
  ProviderInfo,
  ResolveRequest,
  Resolution,
  Agent,
  Snapshot,
  Task,
  UpdateFeatureRequest,
  UpdateMilestoneRequest,
  UpdateProjectRequest,
  UpdateRunnerRequest,
  UpdateTaskRequest,
  UpdateWorkspaceSettingsRequest,
} from "@skynet/shared";
import { modelValidForProvider, WorkspaceSettings } from "@skynet/shared";
import { existsSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { assertApprovable, CommandDeniedError } from "./command-safety.js";
import { normalizeCommand, rememberableRisk } from "./approval-policy.js";
import { config, now } from "./config.js";
import { generateAgentName } from "./fleet-names.js";
import { isGitRepo } from "./fs-browse.js";
import { projectPreview, type PreviewState, type PreviewSource } from "./preview/project-preview.js";
import { githubService, parseRepoRef } from "./github/index.js";
import { parseChecklist } from "./tasks/checklist.js";
import {
  answerProjectQuestion,
  type AssistantAction,
  type ChatTurn,
} from "./project-assistant.js";
import { askStewardWorkspace, askStewardWorkspaceStream, askStewardStream, resolveFocusProject } from "./steward/assistant.js";
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

  /** Global Steward chat (the sidebar dock, available on every page). Runs the
   *  full project assistant — repo-aware, proposes confirm-first actions — whenever
   *  a single project is in scope: the page you're on (`focusProjectId`), OR, from
   *  the workspace view, the project the conversation is clearly about (resolved
   *  from the message + history). Only when no single project can be pinned down
   *  does it answer workspace-wide (cross-project status, answer-only). The
   *  returned `projectId` tells the dock which project any action targets. */
  async stewardChat(
    workspaceId: string,
    question: string,
    history?: ChatTurn[],
    focusProjectId?: string,
  ): Promise<{ reply: string; actions: AssistantAction[]; projectId: string | null }> {
    // An explicit page focus wins; otherwise resolve the project from the
    // conversation so the workspace dock can act on it, not just report on it.
    let project = focusProjectId ? await this.store.getProject(focusProjectId) : null;
    if (project && project.workspaceId !== workspaceId) project = null; // stale / not ours
    if (!project) {
      const projects = await this.store.listProjects(workspaceId);
      const id = resolveFocusProject(projects.map((p) => ({ id: p.id, name: p.name })), question, history);
      project = id ? projects.find((p) => p.id === id) ?? null : null;
    }
    if (project) {
      const { reply, actions } = await answerProjectQuestion(this.store, { workspaceId, project, question, history });
      return { reply, actions, projectId: project.id };
    }
    const { reply, actions } = await askStewardWorkspace(this.store, { workspaceId, question, history });
    return { reply, actions, projectId: null };
  }

  /** Streaming form of {@link stewardChat} — yields the reply as text deltas, then
   *  RETURNS the clean reply + any proposed action + the resolved project. Same
   *  focus resolution as stewardChat, so streaming and non-streaming agree. */
  async *stewardChatStream(
    workspaceId: string,
    question: string,
    history?: ChatTurn[],
    focusProjectId?: string,
  ): AsyncGenerator<string, { reply: string; actions: AssistantAction[]; projectId: string | null }> {
    let project = focusProjectId ? await this.store.getProject(focusProjectId) : null;
    if (project && project.workspaceId !== workspaceId) project = null;
    if (!project) {
      const projects = await this.store.listProjects(workspaceId);
      const id = resolveFocusProject(projects.map((p) => ({ id: p.id, name: p.name })), question, history);
      project = id ? projects.find((p) => p.id === id) ?? null : null;
    }
    if (project) {
      const { reply, actions } = yield* askStewardStream(this.store, { workspaceId, project, question, history });
      return { reply, actions, projectId: project.id };
    }
    const { reply, actions } = yield* askStewardWorkspaceStream(this.store, { workspaceId, question, history });
    return { reply, actions, projectId: null };
  }

  // ── reads (workspace-scoped) ──────────────────────────────────────────────
  async snapshot(ws: string): Promise<Snapshot> {
    const snap = await this.store.snapshot(ws);
    snap.providers = await withSecretAvailability(snap.providers, ws);
    snap.defaultApprovalLevel = config.defaultApprovalLevel;
    snap.workspaceSettings = await this.getWorkspaceSettings(ws);
    return snap;
  }

  /** The live workspace fleet policy, defaulted when never set. */
  async getWorkspaceSettings(ws: string): Promise<WorkspaceSettings> {
    return (await this.store.getWorkspaceSettings(ws)) ?? WorkspaceSettings.parse({ workspaceId: ws });
  }

  /** Patch the workspace fleet policy (auto-scale + cap). */
  async updateWorkspaceSettings(ws: string, patch: UpdateWorkspaceSettingsRequest): Promise<WorkspaceSettings> {
    const next = WorkspaceSettings.parse({ ...(await this.getWorkspaceSettings(ws)), ...patch, workspaceId: ws });
    await this.store.putWorkspaceSettings(next);
    return next;
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
  listFeatures(ws: string): Promise<Feature[]> {
    return this.store.listFeatures(ws);
  }
  listMilestones(ws: string): Promise<Milestone[]> {
    return this.store.listMilestones(ws);
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
  async previewStart(ws: string, projectId: string, source: PreviewSource = "merged"): Promise<PreviewState> {
    const project = await this.getProject(ws, projectId);
    if (!project.repoPath) throw new Error("This project has no local folder to preview.");
    return projectPreview.start(projectId, project.repoPath, ws, await this.previewOpts(projectId, project.baseBranch, source));
  }
  async previewRestart(ws: string, projectId: string): Promise<PreviewState> {
    const project = await this.getProject(ws, projectId);
    if (!project.repoPath) throw new Error("This project has no local folder to preview.");
    // Preserve whatever source the operator last chose across a restart.
    const source = projectPreview.currentSource(projectId);
    return projectPreview.restart(projectId, project.repoPath, ws, await this.previewOpts(projectId, project.baseBranch, source));
  }
  /** Resolve the base branch + (for `latest`) the review-ready run branches to
   *  fold into the combined preview. Review-ready = a non-archived run in this
   *  project sitting in `review` — the agent-finished, proposed-but-not-merged
   *  state; still-ongoing runs are deliberately excluded so the combined preview
   *  stays coherent. */
  private async previewOpts(projectId: string, projectBase: string | null | undefined, source: PreviewSource): Promise<{ source: PreviewSource; baseBranch: string; combineBranches: string[] }> {
    const baseBranch = projectBase || config.baseBranch;
    let combineBranches: string[] = [];
    if (source === "latest") {
      const runs = await this.store.listAllRuns().catch(() => []);
      combineBranches = runs
        .filter((r) => r.projectId === projectId && !r.archived && r.status === "review" && !!r.branch)
        .map((r) => r.branch);
    }
    return { source, baseBranch, combineBranches };
  }
  async previewStop(ws: string, projectId: string): Promise<PreviewState> {
    await this.getProject(ws, projectId);
    return projectPreview.stop(projectId);
  }
  async previewRefresh(ws: string, projectId: string): Promise<PreviewState> {
    await this.getProject(ws, projectId);
    return projectPreview.refresh(projectId);
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

  // ── Ready-to-merge (human PR merge decisions) ──────────────────────────────
  /** Runs whose PR is open and awaiting a human merge decision. */
  listReadyPrs(ws: string): Promise<TaskRun[]> {
    return this.orchestrator.listReadyPrs(ws);
  }
  async mergeReadyPr(ws: string, runId: string, method: "merge" | "squash" | "rebase"): Promise<{ merged: boolean; reason?: string; blocked?: "conflict" | "checks" | "protection" }> {
    await this.getRun(ws, runId); // 404 unless it's in this workspace
    return this.orchestrator.mergeReadyPr(ws, runId, method);
  }
  async updateReadyPrBranch(ws: string, runId: string): Promise<{ updated: boolean; conflicts?: string[] }> {
    await this.getRun(ws, runId);
    return this.orchestrator.updateReadyPrBranch(ws, runId);
  }
  async reworkReadyPr(ws: string, runId: string, guidance: string, comment?: string): Promise<void> {
    await this.getRun(ws, runId);
    return this.orchestrator.reworkReadyPr(ws, runId, guidance, comment);
  }
  async dismissReadyPr(ws: string, runId: string): Promise<void> {
    await this.getRun(ws, runId);
    return this.orchestrator.dismissReadyPr(ws, runId);
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
    // Cloning an EXISTING repo: the operator pastes its git URL (HTTPS/SSH) — we
    // normalize it to the "owner/repo" slug and bind to it, so the existing
    // repo-bound path takes over (auto-clone below via the workspace's GitHub
    // token). A repo URL supersedes any local folder; the fresh checkout wins.
    if (input.repoUrl) {
      const slug = parseRepoRef(input.repoUrl);
      if (!slug) throw new Error(`Not a recognizable GitHub repo URL: ${input.repoUrl}`);
      repo = slug;
      repoPath = null;
    }
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
      // Governance is chosen at creation when the form sends it, else the
      // server defaults (autonomy on; approvalLevel from SKYNET_APPROVAL_LEVEL).
      autonomy: input.autonomy ?? true,
      approvalLevel: input.approvalLevel ?? config.defaultApprovalLevel,
      approvalRules: [],
      repoPath,
      gitBacked: repoPath ? isGitRepo(repoPath) : false,
      repo,
      // Project-scoped agent guidance is optional at creation. Trimmed to null
      // when blank so the "no rules" grounding path is unambiguous downstream.
      instructions: input.instructions?.trim() || null,
      // Optional: pin to a specific GitHub account at creation, else the default
      // connection (chosen later in project settings).
      githubCredentialId: input.githubCredentialId ?? null,
      // Runner-key confinement is opt-in and set later in project settings —
      // a fresh project runs on any workspace key until narrowed.
      enabledRunnerCredentialIds: [],
      // Source-of-truth write-back is opt-in (outward-facing) — enabled in settings.
      syncSourceStatus: false,
      // Optional: stack this project's runs/PRs onto a branch; else the global default.
      baseBranch: input.baseBranch?.trim() || null,
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
    // Normalize instructions: empty / whitespace-only clears back to null so
    // downstream "no rules" branches don't have to distinguish "" from null.
    // `patch.instructions === undefined` means the field is untouched.
    const instructions =
      patch.instructions === undefined
        ? {}
        : { instructions: patch.instructions?.trim() ? patch.instructions.trim() : null };
    // Same normalization for the base branch: empty/whitespace clears back to null
    // (= the global default), so `project.baseBranch ?? config.baseBranch` is never "".
    const baseBranch =
      patch.baseBranch === undefined
        ? {}
        : { baseBranch: patch.baseBranch?.trim() ? patch.baseBranch.trim() : null };
    const updated = await this.hub.upsertProject({ ...existing, ...patch, ...rebind, ...instructions, ...baseBranch });
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
      await githubService.cloneRepo(ws, project.repo, dest, project.githubCredentialId);
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
      reviewVerdict: null,
      assignment: { mode: "unassigned", agentIds: [] },
      order: inProject.length,
      archived: false,
      // Scheduling starts blank — the autonomous triage step estimates
      // `estimatedDurationMs`; `plannedStartAt` is operator-set via Steward/UI.
      estimatedDurationMs: null,
      plannedStartAt: null,
      // Grouping / roadmap linkage starts unassigned — set later via
      // updateTask (Steward or the task detail modal).
      featureId: null,
      milestoneId: null,
      // Provenance — set when importing from a source of truth (GitHub issue, …).
      source: input.source ?? null,
    };
    return this.hub.upsertTask(task);
  }

  /** Import a GitHub-connected project's OPEN issues as backlog tasks, each linked
   *  back to its issue (Task.source) so status changes can be written back. Skips
   *  issues already imported (deduped by repo#number). Uses the project's GitHub
   *  account. See docs/task-source-sync.md. */
  async importGithubIssues(ws: string, projectId: string): Promise<{ imported: number; skipped: number }> {
    const project = await this.store.getProject(projectId);
    if (!project || project.workspaceId !== ws) throw new NotFoundError("Project");
    if (!project.repo) throw new Error("Project isn't bound to a GitHub repo — set its repo first.");
    const issues = await githubService.listIssues(ws, project.repo, project.githubCredentialId);
    const existing = await this.store.listTasks(ws);
    const seen = new Set(
      existing.flatMap((t) =>
        t.projectId === projectId && t.source?.kind === "github_issue" ? [`${t.source.repo}#${t.source.number}`] : [],
      ),
    );
    let imported = 0;
    for (const iss of issues) {
      if (seen.has(`${project.repo}#${iss.number}`)) continue;
      await this.createTask(ws, projectId, {
        text: iss.title,
        description: iss.body || undefined,
        source: { kind: "github_issue", repo: project.repo, number: iss.number, url: iss.url },
      });
      imported++;
    }
    return { imported, skipped: issues.length - imported };
  }

  /** Import a repo file's OPEN checklist items (`- [ ] …`) as backlog tasks, each
   *  linked back to the file+item so completing the task checks the box (Phase 2).
   *  Deduped by path+label. GitHub-repo-backed projects only. */
  async importRepoFile(ws: string, projectId: string, path: string): Promise<{ imported: number; skipped: number }> {
    const project = await this.store.getProject(projectId);
    if (!project || project.workspaceId !== ws) throw new NotFoundError("Project");
    if (!project.repo) throw new Error("Repo-file import needs a GitHub-bound project.");
    const file = await githubService.getRepoFileWithSha(ws, project.repo, path, project.githubCredentialId);
    if (!file) throw new Error(`File not found in the repo: ${path}`);
    const open = parseChecklist(file.content).filter((i) => !i.checked); // unchecked = still to do
    const existing = await this.store.listTasks(ws);
    const seen = new Set(
      existing.flatMap((t) =>
        t.projectId === projectId && t.source?.kind === "repo_file" && t.source.path === path
          ? [t.source.anchor.trim().toLowerCase()]
          : [],
      ),
    );
    let imported = 0;
    for (const it of open) {
      if (seen.has(it.label.trim().toLowerCase())) continue;
      await this.createTask(ws, projectId, { text: it.label, source: { kind: "repo_file", path, anchor: it.label } });
      imported++;
    }
    return { imported, skipped: open.length - imported };
  }
  async updateTask(ws: string, tid: string, patch: UpdateTaskRequest): Promise<Task> {
    const task = await this.store.getTask(tid);
    if (!task || task.workspaceId !== ws) throw new NotFoundError("Task");
    // Enforce that a referenced feature/milestone exists and belongs to the
    // task's project — cross-project linkage would produce nonsensical roadmap
    // rollups. `null` explicitly clears the assignment.
    if (patch.featureId !== undefined && patch.featureId !== null) {
      const f = await this.store.getFeature(patch.featureId);
      if (!f || f.workspaceId !== ws || f.projectId !== task.projectId) throw new NotFoundError("Feature");
    }
    if (patch.milestoneId !== undefined && patch.milestoneId !== null) {
      const m = await this.store.getMilestone(patch.milestoneId);
      if (!m || m.workspaceId !== ws || m.projectId !== task.projectId) throw new NotFoundError("Milestone");
    }
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
    // Auto-pick defaults to ON the FIRST time eligibility gets set (unassigned →
    // any/agents). Once an operator has said "any agent can take this" they
    // usually want the autonomy loop to pick it up automatically — asking them
    // to also tick the Auto-pick box is a redundant step. Toggling between
    // `any` ↔ `agents` doesn't re-flip (operator already made an autoPick
    // choice), and an explicit `autoPick` in the same patch wins (user override).
    const settingEligibility =
      patch.assignment &&
      patch.assignment.mode !== "unassigned" &&
      task.assignment.mode === "unassigned";
    const autoPickPatch: Pick<Task, "autoPick"> | Record<string, never> =
      settingEligibility && patch.autoPick === undefined ? { autoPick: true } : {};
    return this.hub.upsertTask({ ...task, ...patch, ...autoPickPatch });
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
  /** Drag-reorder within a state (the backlog): move `tid` to sit immediately
   *  before `beforeId` (null = end), then renumber `order` 0..n-1. Same ordering
   *  model as moveTask, but to an arbitrary position rather than one step. */
  async reorderTask(ws: string, tid: string, beforeId: string | null): Promise<Task> {
    const task = await this.store.getTask(tid);
    if (!task || task.workspaceId !== ws) throw new NotFoundError("Task");
    const rank = (t: Task) => t.order ?? 0;
    const list = (await this.store.listTasks(ws))
      .filter((t) => t.projectId === task.projectId && t.state === task.state)
      .sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
    const from = list.findIndex((t) => t.id === tid);
    if (from < 0) return task;
    list.splice(from, 1);
    let to = beforeId ? list.findIndex((t) => t.id === beforeId) : -1;
    if (to < 0) to = list.length; // unknown/self/none → append
    list.splice(to, 0, task);
    for (let i = 0; i < list.length; i++) {
      if (rank(list[i]!) !== i) await this.hub.upsertTask({ ...list[i]!, order: i });
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
      reviewVerdict: null,
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
      reviewVerdict: null,
    });
    if (updated.runId) {
      await this.hub.runStatus(updated.runId, "done").catch(() => undefined);
    }
    return updated;
  }

  // ── features (task grouping) ───────────────────────────────────────────
  async createFeature(ws: string, projectId: string, input: CreateFeatureRequest): Promise<Feature> {
    const project = await this.store.getProject(projectId);
    if (!project || project.workspaceId !== ws) throw new NotFoundError("Project");
    if (input.milestoneId != null) {
      const m = await this.store.getMilestone(input.milestoneId);
      if (!m || m.workspaceId !== ws || m.projectId !== projectId) throw new NotFoundError("Milestone");
    }
    const inProject = (await this.store.listFeatures(ws)).filter((f) => f.projectId === projectId);
    const feature: Feature = {
      id: this.uid(`f-${this.slug(project.name)}`),
      workspaceId: ws,
      projectId,
      name: input.name,
      description: input.description?.trim() || null,
      status: "active",
      milestoneId: input.milestoneId ?? null,
      order: inProject.length,
      archived: false,
      createdAt: now(),
    };
    return this.hub.upsertFeature(feature);
  }
  async updateFeature(ws: string, fid: string, patch: UpdateFeatureRequest): Promise<Feature> {
    const feature = await this.store.getFeature(fid);
    if (!feature || feature.workspaceId !== ws) throw new NotFoundError("Feature");
    if (patch.milestoneId !== undefined && patch.milestoneId !== null) {
      const m = await this.store.getMilestone(patch.milestoneId);
      if (!m || m.workspaceId !== ws || m.projectId !== feature.projectId) throw new NotFoundError("Milestone");
    }
    return this.hub.upsertFeature({ ...feature, ...patch });
  }
  async deleteFeature(ws: string, fid: string): Promise<void> {
    const feature = await this.store.getFeature(fid);
    if (!feature || feature.workspaceId !== ws) throw new NotFoundError("Feature");
    // Clear the featureId on any tasks that referenced it — leaving dangling
    // pointers would render a "phantom feature" chip on the board.
    const tasks = (await this.store.listTasks(ws)).filter((t) => t.featureId === fid);
    for (const t of tasks) await this.hub.upsertTask({ ...t, featureId: null });
    await this.hub.deleteFeature(fid);
  }

  // ── milestones (roadmap grouping) ──────────────────────────────────────
  async createMilestone(ws: string, projectId: string, input: CreateMilestoneRequest): Promise<Milestone> {
    const project = await this.store.getProject(projectId);
    if (!project || project.workspaceId !== ws) throw new NotFoundError("Project");
    const inProject = (await this.store.listMilestones(ws)).filter((m) => m.projectId === projectId);
    const milestone: Milestone = {
      id: this.uid(`m-${this.slug(project.name)}`),
      workspaceId: ws,
      projectId,
      name: input.name,
      description: input.description?.trim() || null,
      targetAt: input.targetAt ?? null,
      status: "planned",
      order: inProject.length,
      archived: false,
      createdAt: now(),
    };
    return this.hub.upsertMilestone(milestone);
  }
  async updateMilestone(ws: string, mid: string, patch: UpdateMilestoneRequest): Promise<Milestone> {
    const milestone = await this.store.getMilestone(mid);
    if (!milestone || milestone.workspaceId !== ws) throw new NotFoundError("Milestone");
    return this.hub.upsertMilestone({ ...milestone, ...patch });
  }
  async deleteMilestone(ws: string, mid: string): Promise<void> {
    const milestone = await this.store.getMilestone(mid);
    if (!milestone || milestone.workspaceId !== ws) throw new NotFoundError("Milestone");
    // Clear the milestoneId on features + tasks that referenced it.
    const features = (await this.store.listFeatures(ws)).filter((f) => f.milestoneId === mid);
    for (const f of features) await this.hub.upsertFeature({ ...f, milestoneId: null });
    const tasks = (await this.store.listTasks(ws)).filter((t) => t.milestoneId === mid);
    for (const t of tasks) await this.hub.upsertTask({ ...t, milestoneId: null });
    await this.hub.deleteMilestone(mid);
  }

  // ── fleet ──────────────────────────────────────────────────────────────
  async configureRunner(ws: string, input: ConfigureRunnerRequest): Promise<Agent> {
    // Validate the provider+model pairing. ADVISORY on the model: the catalog is
    // curated suggestions, not an allowlist, so any non-empty model is accepted for
    // a known provider (a just-released model works without a catalog edit); only
    // an unknown provider or an empty model is a 400 (fail() maps Error → 400).
    const invalid = modelValidForProvider(await this.store.listProviders(), input.provider, input.model);
    if (invalid) throw new Error(invalid);
    // Honor the workspace fleet cap — the safety valve against runaway creation
    // (a project-scoped MCP token, an over-eager script). 0 = no cap.
    const { maxRunners } = await this.getWorkspaceSettings(ws);
    const fleet = await this.store.listAgents(ws);
    if (maxRunners > 0 && fleet.length >= maxRunners) {
      throw new Error(`Fleet is at its maximum of ${maxRunners} runner${maxRunners === 1 ? "" : "s"} — raise the limit in settings or retire an idle runner.`);
    }
    // The id is a stable, opaque handle (runs reference it as agentId); the name
    // is the human-facing label shown on the board. Keeping them separate means
    // a rename never moves the id, and two agents can share a display name
    // without colliding. Auto-name to `<provider>-<name>` when none is given.
    const id = this.uid("runner");
    const name = input.name?.trim() || generateAgentName(input.provider, fleet.map((a) => a.name));
    const runner: Agent = {
      id,
      workspaceId: ws,
      name,
      provider: input.provider,
      credentialId: input.credentialId ?? null,
      model: input.model,
      status: "idle",
      idleSince: now(),
      autoProvisioned: false, // an operator added this — the idle reaper leaves it alone
      canReview: true, // reviewer-eligible by default (never reviews its own runs)
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
