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
  Checkpoint,
  CommandPolicy,
  ConfigureRunnerRequest,
  CreateFeatureRequest,
  CreateMilestoneRequest,
  CreateProjectContextEntryRequest,
  CreateProjectRequest,
  CreateSolutionBriefRequest,
  CreateTaskRequest,
  DraftCharterRequest,
  DryRunPolicyRequest,
  Feature,
  FlyDeployment,
  GenerateComplianceReportRequest,
  HitlItem,
  InformRequest,
  Milestone,
  PolicyDryRunResult,
  PolicyVersion,
  PrChecksStatus,
  Project,
  ProjectCharter,
  ProjectQualityResult,
  ProjectContextEntry,
  ProviderInfo,
  ResolveRequest,
  Resolution,
  SavePolicyVersionRequest,
  Agent,
  SignedComplianceReport,
  Snapshot,
  SolutionBrief,
  StewardActionOutcome,
  StewardExecutionAction,
  Task,
  UpdateFeatureRequest,
  UpdateMilestoneRequest,
  UpdateProjectRequest,
  UpdateProjectRoadmapRequest,
  UpdateRunnerRequest,
  UpdateSolutionBriefRequest,
  UpdateTaskRequest,
  UpdateWorkspaceSettingsRequest,
  PauseCredentialResult,
  SecretMeta,
} from "@skynet/shared";
import { modelValidForProvider, ProjectCharter as ProjectCharterSchema, WorkspaceSettings } from "@skynet/shared";
import { buildReplenishPrompt, parseProposedTasks } from "./steward/replenish.js";
import { sameTaskText } from "./steward/assistant.js";

// Cheap mid-tier model for backlog replenishment — one short, tool-less call
// grounded in text we already have. See CLARIFY_DRAFT_MODEL for the same choice.
const REPLENISH_MODEL = "sonnet";
import { existsSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { assertApprovable, CommandDeniedError } from "./command-safety.js";
import { normalizeCommand, rememberableRisk } from "./approval-policy.js";
import { dryRunPolicy, resolveActivePolicy, savePolicyVersion } from "./command-policy.js";
import { config, now } from "./config.js";
import { computeParallelismNudge } from "./derive/parallelism.js";
import { generateAgentName } from "./fleet-names.js";
import { isGitRepo } from "./fs-browse.js";
import { projectPreview, type PreviewState, type PreviewSource } from "./preview/project-preview.js";
import { git as gitExec } from "./preview/worktree.js";
import { ASSISTANT_MODEL, oneShotText } from "@skynet/runner-sdk/claude";
import { flyDeploy, type FlyDeployState } from "./fly/deploy.js";
import { githubService, parseRepoRef } from "./github/index.js";
import { parseChecklist } from "./tasks/checklist.js";
import { lintTask } from "./task-linter.js";
import { reconcileSourceState } from "./task-sync.js";
import { buildDecomposePrompt, parseDecomposition } from "./decompose.js";
import {
  answerProjectQuestion,
  type AssistantAction,
  type ChatTurn,
} from "./project-assistant.js";
import { askStewardWorkspace, askStewardWorkspaceStream, askStewardStream, resolveFocusProject } from "./steward/assistant.js";
import { contentHash, readProjectDoc, resolveRoadmapDoc } from "./steward/docs.js";
import { draftBriefFromConversation, summarizeConversation } from "./steward/crystallize.js";
import { scanRepo } from "./quality/scan.js";
import { condenseProjectContext } from "./steward/context.js";
import { prioritizeColumn, suggestAnyAgentEligible } from "./steward/organize.js";
import { extractText } from "./steward/extract.js";
import { commitLocalRepoFile } from "./local-repo-write.js";
import { generateSignedComplianceReport } from "./compliance/index.js";
import type { CapturedDiff, Hub } from "./hub.js";
import { CLARIFICATION_ANSWERED_MARKER, NoCapacityError, NothingToReviewError, RunnerNotConfiguredError, TaskAlreadyAssignedError, type Orchestrator } from "./orchestrator.js";
import { resolveExecutable } from "./steward/execution.js";
import { secretService, withSecretAvailability } from "./secrets/index.js";
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

/** A roadmap-doc edit's baseline no longer matches the file on disk/GitHub —
 *  someone else changed it since this edit was drafted. 409. */
export class RoadmapConflictError extends Error {
  constructor() {
    super("The roadmap doc changed since this edit was drafted — refresh and try again.");
    this.name = "RoadmapConflictError";
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

/** A project's roadmap doc, or why it couldn't be read. */
export type ProjectRoadmapResult =
  | { state: "ok"; path: string; content: string; source: "local" | "github"; sha?: string }
  | { state: "unbound" }
  | { state: "missing_local_repo" }
  | { state: "not_found" }
  | { state: "github_error"; message: string };

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
  // Test seam, mirroring Orchestrator's providerOverride/previewOverride: the
  // one-shot consult decomposeBrief uses to turn a brief into a plan. Defaults
  // to the real oneShotText. Injectable because it's a module-level function
  // (not something reachable via an injected RunnerProvider — decomposeBrief
  // has no live run to ride a provider's own consult() on), so a deterministic
  // test needs its own seam rather than mocking the imported module.
  decomposeConsult?: (opts: { prompt: string; model: string; apiKey?: string | null }) => Promise<string>;
  /** Test seam: override the model call crystallizeBrief makes (see
   *  draftBriefFromConversation's `ask` param). Defaults to a real Claude
   *  one-shot call authenticated via the workspace's "claude" secret — tests
   *  inject a stub here so the retry contract is verifiable without a real
   *  LLM call or a configured API key. */
  crystallizeAsk?: (prompt: string) => Promise<string>;
  /** Test seam: override the model call refreshProjectContext makes (see
   *  condenseProjectContext's `ask` param). Same rationale as crystallizeAsk. */
  contextAsk?: (prompt: string) => Promise<string>;
  /** Test seam: override the model call organizeBoard makes per column, and
   *  the one it makes for any-agent eligibility (see prioritizeColumn /
   *  suggestAnyAgentEligible's `ask` param). Same rationale as crystallizeAsk. */
  organizeAsk?: (prompt: string) => Promise<string>;
  /** Injected for tests; defaults to a cheap one-shot. See replenishBacklog. */
  replenishAsk?: (prompt: string) => Promise<string>;
  /** Test seam: override the call lintTaskNow makes to grade one task (see
   *  `withLintSlot`'s bulk-import concurrency cap). Defaults to the real
   *  `lintTask`. Same rationale as decomposeConsult — needed to make the
   *  throttle's concurrency ceiling deterministically observable in a test,
   *  without a real LLM call. */
  lintConsult?: (text: string, description: string | null, siblingTitles: string[]) => ReturnType<typeof lintTask>;
}

export class Operations {
  private seq = 0;
  private readonly store: Store;
  private readonly hub: Hub;
  private readonly orchestrator: Orchestrator;
  private readonly decomposeConsult: (opts: { prompt: string; model: string; apiKey?: string | null }) => Promise<string>;
  private readonly crystallizeAsk?: (prompt: string) => Promise<string>;
  private readonly contextAsk?: (prompt: string) => Promise<string>;
  private readonly organizeAsk?: (prompt: string) => Promise<string>;
  private readonly replenishAsk?: (prompt: string) => Promise<string>;
  private readonly lintConsult: (text: string, description: string | null, siblingTitles: string[]) => ReturnType<typeof lintTask>;
  // Bounds concurrent task-linter calls (see `lintTaskNow`). Each is a real
  // in-process Claude Agent SDK session (`lintTask` -> `oneShotText`), not a
  // cheap HTTP call, and `maybeLintTask` is fire-and-forget with no caller-
  // side throttle. A bulk task-creation path — GitHub-issue resync, brief
  // decomposition, repo-file import — otherwise fires one of these PER task
  // with zero concurrency limit: found live, a GitHub-issue re-sync that
  // pulled in a large batch of never-before-seen issues fired dozens of
  // concurrent SDK sessions inside the app's own process, exhausted host
  // memory (no swap at the time either — see startup.sh.tftpl), and wedged
  // the whole VM (2026-08-27 incident) badly enough that even a plain `echo`
  // over SSH wouldn't run. 3 concurrent lints keeps single-task-create
  // latency unaffected while capping bulk-import fan-out.
  private lintInFlight = 0;
  private readonly lintQueue: Array<() => void> = [];
  private static readonly MAX_CONCURRENT_LINTS = 3;

  constructor(deps: OperationsDeps) {
    this.store = deps.store;
    this.hub = deps.hub;
    this.orchestrator = deps.orchestrator;
    // The project driver may re-pull a bound source when a board runs dry. It
    // lives on the orchestrator (which ticks) but the pull lives here, so it's
    // injected rather than imported — the orchestrator must not depend on this
    // layer.
    this.orchestrator.onDriveRefill = (ws, projectId) => this.refillProjectSource(ws, projectId);
    this.decomposeConsult = deps.decomposeConsult ?? ((opts) => oneShotText({ ...opts, apiKey: opts.apiKey ?? undefined }));
    this.crystallizeAsk = deps.crystallizeAsk;
    this.contextAsk = deps.contextAsk;
    this.organizeAsk = deps.organizeAsk;
    this.replenishAsk = deps.replenishAsk;
    // A dry board proposes its own next steps — see replenishBacklog. Injected
    // for the same reason as onDriveRefill: the driver ticks in the
    // orchestrator, the thinking lives here.
    this.orchestrator.onDriveReplenish = (ws, projectId) => this.replenishBacklog(ws, projectId).then(() => undefined);
    this.lintConsult = deps.lintConsult ?? lintTask;
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
    snap.parallelismNudge = computeParallelismNudge(snap.fleet, snap.tasks);
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

  // ── command policy (versioned, per-workspace command-safety classifier) ────
  /** The workspace's currently active command policy — the shipped default if
   *  it has never saved a custom version. */
  getActiveCommandPolicy(ws: string): Promise<CommandPolicy> {
    return resolveActivePolicy(this.store, ws);
  }
  /** Full version history, newest first. Empty = still on the shipped default. */
  listCommandPolicyVersions(ws: string): Promise<PolicyVersion[]> {
    return this.store.listPolicyVersions(ws);
  }
  /** Replay the workspace's historical commands through an unsaved, proposed
   *  policy and report what would change vs. the currently active policy. */
  dryRunCommandPolicy(ws: string, req: DryRunPolicyRequest): Promise<PolicyDryRunResult> {
    return dryRunPolicy(this.store, ws, req.policy, req.limit);
  }
  /** Save a new active policy version (git-like — the previous active version
   *  stays inspectable, just no longer active). */
  saveCommandPolicyVersion(ws: string, req: SavePolicyVersionRequest, operatorId: string): Promise<PolicyVersion> {
    return savePolicyVersion(this.store, ws, req.policy, operatorId, req.label ?? null);
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
  listBriefs(ws: string): Promise<SolutionBrief[]> {
    return this.store.listSolutionBriefs(ws);
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
  /** Fetch ONE HITL item scoped to the workspace, or throw NotFoundError (404)
   *  — the full-record counterpart to a summarized queue listing (the MCP
   *  list_hitl → get_hitl drill-in). */
  async getHitl(ws: string, hitlId: string): Promise<HitlItem> {
    const item = await this.store.getHitl(hitlId);
    if (!item || item.workspaceId !== ws) throw new NotFoundError("HITL item");
    return item;
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

  /** One-click, signed "AI change report" for a project, a run, a date range,
   *  or the whole workspace (ROADMAP: Compliance evidence pack). Built
   *  entirely from the existing audit trail — see compliance/report.ts. */
  async generateComplianceReport(
    ws: string,
    operatorId: string,
    scope: GenerateComplianceReportRequest,
  ): Promise<SignedComplianceReport> {
    if (scope.projectId) {
      const project = await this.store.getProject(scope.projectId);
      if (!project || project.workspaceId !== ws) throw new NotFoundError("Project");
    }
    if (scope.runId) {
      const run = await this.store.getRun(scope.runId);
      if (!run || run.workspaceId !== ws) throw new NotFoundError("Run");
    }
    return generateSignedComplianceReport(this.store, ws, operatorId, scope);
  }

  async getRun(ws: string, runId: string): Promise<TaskRun> {
    const agent = await this.store.getRun(runId);
    if (!agent || agent.workspaceId !== ws) throw new NotFoundError("TaskRun");
    return agent;
  }

  /** Fetch one task scoped to the workspace, or throw NotFoundError (404). The
   *  full-detail counterpart to listTasks — see mcp/summarize.ts for why the
   *  MCP list tool doesn't just return this shape for every task up front. */
  async getTask(ws: string, taskId: string): Promise<Task> {
    const task = await this.store.getTask(taskId);
    if (!task || task.workspaceId !== ws) throw new NotFoundError("Task");
    return task;
  }

  /** Fetch one solution brief scoped to the workspace, or throw NotFoundError (404). */
  async getBrief(ws: string, briefId: string): Promise<SolutionBrief> {
    const brief = await this.store.getSolutionBrief(briefId);
    if (!brief || brief.workspaceId !== ws) throw new NotFoundError("SolutionBrief");
    return brief;
  }

  /** Fetch one resolved HITL decision scoped to the workspace, or throw
   *  NotFoundError (404) — the full-payload (incl. captured diff patch)
   *  counterpart to listAudit's summarized rows. No dedicated store method for
   *  a single record (the audit trail is append-only and not typically huge in
   *  COUNT, just per-record size), so this filters listAudit — fine at
   *  realistic workspace scale. */
  async getAuditRecord(ws: string, hitlId: string): Promise<AuditRecord> {
    const record = (await this.store.listAudit(ws)).find((r) => r.hitlId === hitlId);
    if (!record) throw new NotFoundError("AuditRecord");
    return record;
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

  // ── per-run live preview — "Preview this change" (the run's own branch, ────
  // pinned, pre-merge — see docs/live-preview.md). Same manager, same
  // sandboxed `/p/<token>/` proxy as the project preview above; keyed
  // `run:<runId>` so it never collides with (and is stopped independently of)
  // a project-level preview of the same repo.
  previewRunState(ws: string, runId: string): Promise<PreviewState> {
    return this.getRun(ws, runId).then((r) => projectPreview.state(`run:${r.id}`));
  }
  async previewRunStart(ws: string, runId: string): Promise<PreviewState> {
    const run = await this.getRun(ws, runId);
    const project = await this.getProject(ws, run.projectId);
    if (!project.repoPath) throw new Error("This project has no local folder to preview.");
    return projectPreview.startRun(run.id, { repoPath: project.repoPath, projectId: project.id, branch: run.branch, workspaceId: ws });
  }
  async previewRunRestart(ws: string, runId: string): Promise<PreviewState> {
    const run = await this.getRun(ws, runId);
    const project = await this.getProject(ws, run.projectId);
    if (!project.repoPath) throw new Error("This project has no local folder to preview.");
    return projectPreview.restartRun(run.id, { repoPath: project.repoPath, projectId: project.id, branch: run.branch, workspaceId: ws });
  }
  async previewRunStop(ws: string, runId: string): Promise<PreviewState> {
    await this.getRun(ws, runId);
    return projectPreview.stop(`run:${runId}`);
  }

  // ── Fly.io deploy (persistent, human-triggered — see docs/live-preview.md) ─
  // Explicit operator action ONLY: never called from the autonomy loop, the
  // merge queue, or any automatic trigger. Two targets, same engine: a
  // project's integration branch (the "overwatch" slice) or a single run's
  // own branch (pre-merge verification). Unlike the local preview, the
  // terminal state is PERSISTED on the Project/TaskRun record — the whole
  // point is that the deployment outlives the local Skynet process, so the UI
  // must still be able to show "live at https://…" after a restart.
  private async flyToken(ws: string, credentialId: string | null): Promise<string> {
    const apiKey = await secretService.resolve(ws, credentialId ?? "fly");
    if (!apiKey) throw new Error("No Fly.io API token is set — add one in Integrations, or pick an account in this project's settings.");
    return apiKey;
  }
  flyDeployProjectState(ws: string, projectId: string): Promise<FlyDeployState> {
    return this.getProject(ws, projectId).then((p) => this.mergeFlyState(projectId, p.flyDeployment));
  }
  async flyDeployProjectStart(ws: string, projectId: string, operatorId: string): Promise<FlyDeployState> {
    const project = await this.getProject(ws, projectId);
    if (!project.repoPath) throw new Error("This project has no local folder to deploy.");
    const integration = `skynet/integration/${projectId}`;
    const hasIntegration = await this.branchExists(project.repoPath, integration);
    const ref = hasIntegration ? integration : project.baseBranch || config.baseBranch;
    const flyApiToken = await this.flyToken(ws, project.flyCredentialId);
    const result = await flyDeploy.start({
      key: projectId, gitRepo: project.repoPath, ref, branch: ref,
      projectId, projectName: project.name, flyApiToken,
    });
    await this.persistFlyDeployment(ws, "project", projectId, result, operatorId);
    return result;
  }
  async flyDeployProjectStop(ws: string, projectId: string): Promise<FlyDeployState> {
    const project = await this.getProject(ws, projectId);
    const appName = project.flyDeployment?.appName;
    if (!appName) throw new Error("Nothing deployed for this project.");
    const flyApiToken = await this.flyToken(ws, project.flyCredentialId);
    const result = await flyDeploy.destroy({ key: projectId, appName, flyApiToken, gitRepo: project.repoPath ?? undefined });
    await this.persistFlyDeployment(ws, "project", projectId, result, project.flyDeployment?.deployedBy ?? "");
    return result;
  }
  flyDeployRunState(ws: string, runId: string): Promise<FlyDeployState> {
    return this.getRun(ws, runId).then((r) => this.mergeFlyState(`run:${runId}`, r.flyDeployment));
  }
  async flyDeployRunStart(ws: string, runId: string, operatorId: string): Promise<FlyDeployState> {
    const run = await this.getRun(ws, runId);
    const project = await this.getProject(ws, run.projectId);
    if (!project.repoPath) throw new Error("This project has no local folder to deploy.");
    if (!(await this.branchExists(project.repoPath, run.branch))) {
      throw new Error(`This run has no commits to deploy yet (branch ${run.branch} doesn't exist).`);
    }
    const flyApiToken = await this.flyToken(ws, project.flyCredentialId);
    const result = await flyDeploy.start({
      key: `run:${runId}`, gitRepo: project.repoPath, ref: run.branch, branch: run.branch,
      projectId: run.projectId, projectName: project.name, flyApiToken,
    });
    await this.persistFlyDeployment(ws, "run", runId, result, operatorId);
    return result;
  }
  async flyDeployRunStop(ws: string, runId: string): Promise<FlyDeployState> {
    const run = await this.getRun(ws, runId);
    const project = await this.getProject(ws, run.projectId);
    const appName = run.flyDeployment?.appName;
    if (!appName) throw new Error("Nothing deployed for this run.");
    const flyApiToken = await this.flyToken(ws, project.flyCredentialId);
    const result = await flyDeploy.destroy({ key: `run:${runId}`, appName, flyApiToken, gitRepo: project.repoPath ?? undefined });
    await this.persistFlyDeployment(ws, "run", runId, result, run.flyDeployment?.deployedBy ?? "");
    return result;
  }
  /** The manager's in-memory record is ephemeral (gone on restart); the
   *  persisted Project/TaskRun.flyDeployment is the source of truth for
   *  "is something live" across restarts. When the manager has nothing (e.g.
   *  right after a restart, before anyone's re-polled), fall back to the
   *  persisted terminal state instead of reporting "idle" for a deployment
   *  that's actually still live on Fly. */
  private mergeFlyState(key: string, persisted: FlyDeployment | null): FlyDeployState {
    const live = flyDeploy.state(key);
    if (live.status !== "idle" || !persisted) return live;
    return {
      status: persisted.status, appName: persisted.appName, region: persisted.region, url: persisted.url,
      branch: persisted.branch, sha: persisted.sha, error: persisted.error, logs: [], deployedAt: persisted.deployedAt,
    };
  }
  private async persistFlyDeployment(ws: string, kind: "project" | "run", id: string, result: FlyDeployState, operatorId: string): Promise<void> {
    const flyDeployment = {
      status: result.status,
      appName: result.appName,
      region: result.region,
      url: result.url,
      branch: result.branch,
      sha: result.sha,
      error: result.error,
      deployedAt: result.deployedAt,
      deployedBy: result.status === "live" ? operatorId : null,
    };
    if (kind === "project") {
      const project = await this.store.getProject(id);
      if (project && project.workspaceId === ws) await this.hub.upsertProject({ ...project, flyDeployment });
    } else {
      const run = await this.store.getRun(id);
      if (run && run.workspaceId === ws) await this.hub.upsertRun({ ...run, flyDeployment });
    }
  }
  private async branchExists(gitRepo: string, branch: string): Promise<boolean> {
    const { stdout } = await gitExec(gitRepo, "branch", "--list", branch).catch(() => ({ stdout: "" }));
    return !!stdout.trim();
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
      assertApprovable(item.command, await resolveActivePolicy(this.store, ws)); // throws CommandDeniedError → 422, nothing recorded
    }
    const resolution: Resolution = {
      action: input.action,
      optionIndex: input.optionIndex ?? null,
      guidance: input.guidance ?? null,
      // Guided merge — only meaningful alongside an actual approval.
      targetBranch: input.action === "approve" ? (input.targetBranch?.trim() || null) : null,
      // Approve-with-memory — only meaningful alongside an actual approval.
      memoryNote: input.action === "approve" ? (input.memoryNote?.trim() || null) : null,
      // See Resolution.resetWork — only meaningful alongside a real reassign.
      resetWork: input.action === "reassign" ? !!input.resetWork : false,
      by: operatorId,
      at: now(),
    };
    // Capture the real diff into the audit record now, while the worktree still
    // exists — it's retired once the branch merges, so a diff/merge/verifier
    // decision can't be re-fetched afterward. Best-effort; the summary always
    // remains. (A verifier gate's agent worktree is still around — only the
    // scratch INTEGRATION worktree the check ran in was torn down.)
    let capturedDiff: CapturedDiff | undefined;
    if (item.kind === "diff" || item.kind === "merge" || item.kind === "verifier") {
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
        await this.rememberApproval(ws, item.runId, item.command, operatorId);
      }
    }
    return resolved ?? item;
  }

  /** Add a standing "approve always" rule for `command` to the run's project, if
   *  the command is rememberable (low/medium, non-deny) and not already stored.
   *  Best-effort — a non-rememberable command or a missing project is a silent
   *  no-op (the approval itself already succeeded). */
  private async rememberApproval(ws: string, runId: string, command: string, operatorId: string): Promise<void> {
    const cap = rememberableRisk(command, await resolveActivePolicy(this.store, ws));
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
  /**
   * `inform` — mass-select a set of runs (explicit ids, a whole project's live
   * runs, or both) and attach a note that rides each one's NEXT prompt, at no
   * extra turn (see Orchestrator.inform). Never blocks on the runs actually
   * reading it, never routes through a HITL gate. Reports per-run whether the
   * note was actually queued (`informed`) or couldn't be (`skipped` — no live
   * session, or the runner doesn't support it), so the caller can be honest
   * with the operator about partial delivery rather than a blanket "sent".
   */
  async informRuns(
    ws: string,
    input: InformRequest,
  ): Promise<{ informed: string[]; skipped: Array<{ runId: string; reason: string }> }> {
    const note = input.note.trim();
    if (!note) throw new Error("Note text is required.");
    const ids = new Set<string>(input.runIds);
    if (input.projectId) {
      await this.getProject(ws, input.projectId); // 404 unless it's in this workspace
      for (const id of await this.orchestrator.liveRunIdsForProject(input.projectId)) ids.add(id);
    }
    if (ids.size === 0) {
      throw new Error("No runs to inform — select at least one agent, or a project with active runs.");
    }
    const informed: string[] = [];
    const skipped: Array<{ runId: string; reason: string }> = [];
    for (const runId of ids) {
      const run = await this.store.getRun(runId);
      if (!run || run.workspaceId !== ws) {
        skipped.push({ runId, reason: "not found" });
        continue;
      }
      const ok = await this.orchestrator.inform(runId, note);
      if (ok) informed.push(runId);
      else skipped.push({ runId, reason: "not live — no active session to attach the note to" });
    }
    return { informed, skipped };
  }
  async forkAgent(ws: string, runId: string): Promise<TaskRun> {
    await this.getRun(ws, runId);
    return this.orchestrator.fork(runId);
  }
  async createCheckpoint(ws: string, runId: string, label: string | null): Promise<Checkpoint> {
    await this.getRun(ws, runId); // 404 unless it's in this workspace
    return this.orchestrator.checkpoint(runId, label);
  }
  async listCheckpoints(ws: string, runId: string): Promise<Checkpoint[]> {
    await this.getRun(ws, runId);
    return this.orchestrator.listCheckpoints(runId);
  }
  async restoreCheckpoint(ws: string, runId: string, checkpointId: string): Promise<TaskRun> {
    await this.getRun(ws, runId);
    return this.orchestrator.restoreCheckpoint(runId, checkpointId);
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
  /** Live GitHub check-run status for a ready PR — fetched on demand by the
   *  card, not part of the polled snapshot (a real GitHub API call). */
  async prChecksForRun(ws: string, runId: string): Promise<PrChecksStatus | null> {
    await this.getRun(ws, runId);
    return this.orchestrator.prChecksForRun(ws, runId);
  }

  // ── Ready-to-merge, feature-scoped batches (feature-scoped branch batching) ─
  /** Fetch a feature scoped to the workspace, or throw NotFoundError (404). */
  private async getFeatureScoped(ws: string, featureId: string): Promise<Feature> {
    const feature = await this.store.getFeature(featureId);
    if (!feature || feature.workspaceId !== ws) throw new NotFoundError("Feature");
    return feature;
  }
  /** Features whose aggregate PR is open and awaiting a human merge decision. */
  listReadyFeaturePrs(ws: string): Promise<Feature[]> {
    return this.orchestrator.listReadyFeaturePrs(ws);
  }
  async mergeReadyFeaturePr(
    ws: string,
    featureId: string,
    method: "merge" | "squash" | "rebase",
  ): Promise<{ merged: boolean; reason?: string; blocked?: "conflict" | "checks" | "protection" }> {
    await this.getFeatureScoped(ws, featureId);
    return this.orchestrator.mergeReadyFeaturePr(ws, featureId, method);
  }
  async dismissReadyFeaturePr(ws: string, featureId: string): Promise<void> {
    await this.getFeatureScoped(ws, featureId);
    return this.orchestrator.dismissReadyFeaturePr(ws, featureId);
  }
  /** Live GitHub check-run status for a feature's aggregate ready PR. */
  async prChecksForFeature(ws: string, featureId: string): Promise<PrChecksStatus | null> {
    await this.getFeatureScoped(ws, featureId);
    return this.orchestrator.prChecksForFeature(ws, featureId);
  }
  async archiveAgent(ws: string, runId: string, archived: boolean): Promise<TaskRun> {
    await this.getRun(ws, runId);
    const updated = await this.hub.setRunArchived(runId, archived);
    if (!updated) throw new NotFoundError("TaskRun");
    // Archiving a run that's still mid-flight (review/running/waiting/paused)
    // must SETTLE it, not just hide it: otherwise it keeps its status, its
    // runner and its live controls forever, and the stuck-review sweep skips
    // archived runs so nothing can ever finish it off. The worktree is kept —
    // archive is a reversible soft-hide, not a delete. See
    // Orchestrator.settleArchivedRun.
    if (archived) {
      await this.orchestrator.settleArchivedRun(runId).catch(() => undefined);
      return (await this.store.getRun(runId)) ?? updated;
    }
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

  /**
   * Draft a Project Charter from the operator's raw goal description using the
   * workspace's stored Claude key (one cheap Haiku call, metered). Returns a
   * structured charter the operator edits/approves before creating the project.
   * Falls back gracefully: if no key is set the response is a 402-friendly error
   * propagated to the UI (which prompts the user to connect a provider).
   */
  async draftCharter(ws: string, input: DraftCharterRequest): Promise<ProjectCharter> {
    const apiKey = (await secretService.resolve(ws, "claude")) ?? undefined;
    const prompt =
      `You are a project intake assistant. The operator has described a project they want to build. ` +
      `Draft a concise Project Charter with exactly these five sections. ` +
      `Be practical and specific — write 2-4 bullet points per section, no waffle.\n\n` +
      `Operator's raw ask: "${input.goal}"\n\n` +
      `Respond with ONLY a JSON object (no markdown fences) matching this exact shape:\n` +
      `{\n` +
      `  "goals": "<what success looks like — the core deliverable>",\n` +
      `  "nonGoals": "<what is explicitly out of scope for this project>",\n` +
      `  "risks": "<known unknowns, technical bets, or delivery risks>",\n` +
      `  "constraints": "<stack, timeline, budget, or integration constraints>",\n` +
      `  "definitionOfDone": "<observable, testable criteria that close this project>"\n` +
      `}`;
    const raw = await oneShotText({ prompt, model: "haiku", apiKey });
    // Strip optional markdown fences if the model wraps anyway.
    const json = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error("Charter draft returned invalid JSON — try again or fill it in manually.");
    }
    const result = ProjectCharterSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error("Charter draft had unexpected shape — try again or fill it in manually.");
    }
    return result.data;
  }

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
      // Create AS the pinned account when one was chosen — the owner list the
      // operator picked from was that account's, so creating with the default
      // connection's token would either fail or land under the wrong identity.
      const created = await githubService.createRepo(ws, input.createRepo, {
        description: input.goal,
        githubCredentialId: input.githubCredentialId,
      });
      repo = created.name; // "owner/repo"
      repoPath = null;
    }
    // A local repoPath that contains a .git is git-backed → Skynet auto-manages a
    // worktree per agent + the merge queue against it (desktop-first default).
    const project: Project = {
      id: this.uid("p"),
      // Null until the first autonomy tick has looked at this project — the
      // driver writes it, nothing seeds it.
      drive: null,
      workspaceId: ws,
      name: input.name,
      goal: input.goal,
      runIds: [],
      status: "active",
      // Governance is chosen at creation when the form sends it, else the
      // server defaults (autonomy on; approvalLevel from SKYNET_APPROVAL_LEVEL).
      autonomy: input.autonomy ?? true,
      // No daily budget at creation unless the form sends one — set later in
      // project settings too. null = no limit (today's behavior, unchanged).
      dailyBudgetUsd: input.dailyBudgetUsd ?? null,
      // Pacing off at creation unless the form opts in — set later too.
      budgetPacing: input.budgetPacing ?? false,
      approvalLevel: input.approvalLevel ?? config.defaultApprovalLevel,
      approvalRules: [],
      // Plan-mode gating is off by default — set later in project settings.
      planModeGate: false,
      // No tool restriction at creation — set later in project settings.
      disallowedTools: null,
      // Deep review is off at creation — a real agent run costs money, so it
      // stays an explicit opt-in set later in project settings.
      deepReview: false,
      // Breaker review is layered on top of deepReview — off at creation for
      // the same reason (another real agent run), set later in settings.
      breakerReview: false,
      repoPath,
      gitBacked: repoPath ? isGitRepo(repoPath) : false,
      repo,
      // Project-scoped agent guidance is optional at creation. Trimmed to null
      // when blank so the "no rules" grounding path is unambiguous downstream.
      instructions: input.instructions?.trim() || null,
      // Optional: pin to a specific GitHub account at creation, else the default
      // connection (chosen later in project settings).
      githubCredentialId: input.githubCredentialId ?? null,
      // Fly.io deploy account + deployment state are set/populated later —
      // never at creation (see project.tsx settings, "Deploy to Fly.io").
      flyCredentialId: null,
      flyDeployment: null,
      // Runner-key confinement is opt-in and set later in project settings —
      // a fresh project runs on any workspace key until narrowed.
      enabledRunnerCredentialIds: [],
      // Source-of-truth write-back is opt-in (outward-facing) — enabled in settings,
      // or right here when the creation form asks for an issue import (below).
      syncSourceStatus: !!(repo && input.importGithubIssues),
      // Optional: stack this project's runs/PRs onto a branch; else the global default.
      baseBranch: input.baseBranch?.trim() || null,
      // No override at creation — set later, once the operator (or Steward)
      // discovers the default ROADMAP.md/docs/ROADMAP.md candidates are wrong.
      roadmapPath: null,
      // Verifier gate command is set later in project settings, else the global default.
      checkCmd: null,
      // Operator-approved charter from the charter-assisted creation flow (Gate G-1).
      // null when the project was created without charter assistance (today's fast-path).
      charter: input.charter ?? null,
      // No context entries yet at creation — set by refreshProjectContext once
      // the operator pastes/uploads something.
      contextSummary: null,
      contextSummaryUpdatedAt: null,
    };
    const created = await this.hub.upsertProject(project);
    this.maybeAutoClone(ws, created);
    this.maybeAutoImportIssues(ws, created, input.importGithubIssues);
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
    // Same again for the roadmap doc override: empty/whitespace clears back to
    // null (= the default ROADMAP.md/docs/ROADMAP.md candidates).
    const roadmapPath =
      patch.roadmapPath === undefined
        ? {}
        : { roadmapPath: patch.roadmapPath?.trim() ? patch.roadmapPath.trim() : null };
    const updated = await this.hub.upsertProject({ ...existing, ...patch, ...rebind, ...instructions, ...baseBranch, ...roadmapPath });
    this.maybeAutoClone(ws, updated); // binding a repo on a server clones it
    // Re-enabling autonomy (whether the operator turned it off themselves, or
    // the session circuit-breaker did) starts the streak fresh — otherwise an
    // already-at-threshold in-memory count could re-trip on the very next bad
    // outcome instead of giving the project a clean run.
    if (patch.autonomy === true) this.orchestrator.resetAutonomyStreak(id);
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
  /** Seed the backlog from the repo's open GitHub issues right after creation,
   *  when the creation form asked for it — same best-effort background shape as
   *  maybeAutoClone. Runs against the GitHub API directly (not the local
   *  checkout), so it doesn't wait on the clone. No-op unless the project is
   *  repo-bound and `wanted` is true. */
  private maybeAutoImportIssues(ws: string, project: Project, wanted: boolean | undefined): void {
    if (!wanted || !project.repo) return;
    void this.importGithubIssues(ws, project.id).catch((err) =>
      console.warn(`[project ${project.id}] auto-import GitHub issues failed: ${(err as Error).message}`),
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
      assessmentEffort: null,
      assessmentRisks: [],
      // Triage asks for what it needs; nothing to ask before it has run.
      clarification: null,
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
      // Ordering intent starts empty — only a brief decomposition (S7) sets
      // this, at creation time, directly (bypassing this generic constructor).
      dependsOnTaskIds: [],
      lint: null,
      // Start-picker preference starts unset — plain auto-pick until an operator
      // saves one via updateTask.
      preferredProvider: null,
      preferredModel: null,
    };
    const created = await this.hub.upsertTask(task);
    // Skip the assistive linter for content imported wholesale from an
    // EXTERNAL source (a GitHub issue someone else already filed, a
    // repo-file checklist line already written) — it's already someone
    // else's text, the linter adds little value re-grading it, and these are
    // exactly the bulk-import paths that can create many tasks in one call
    // (importGithubIssues, resyncProjectSource, importRepoFile — the
    // GitHub-issue resync that fired dozens of concurrent lint calls and
    // wedged the host, 2026-08-27). An AI-decomposed brief task is NOT
    // skipped here — unlike an import, that's freshly-drafted content, and
    // linting it "same as any other newly-created task" is deliberate (see
    // the S7 comment above); its own bulk loop is protected by
    // withLintSlot's concurrency cap instead. An operator/Steward editing an
    // imported task's text later still gets relinted normally (updateTask's
    // `relint`, below) — at that point it's genuinely being human-tuned one
    // task at a time, not bulk-ingested.
    if (created.source?.kind !== "github_issue" && created.source?.kind !== "repo_file") {
      this.maybeLintTask(ws, created);
    }
    return created;
  }

  /**
   * Task linter (assistive): run {@link lintTask} in the BACKGROUND right
   * after an organically-created task is created or ANY task's text/
   * description is edited, same best-effort fire-and-forget shape as
   * `maybeAutoClone`. Never blocks the caller and never throws into it — a
   * failure just leaves `lint` unset, which is indistinguishable from "no
   * concerns" in the UI (advisory-only, so silence is a safe fallback).
   */
  private maybeLintTask(ws: string, task: Task): void {
    void this.lintTaskNow(ws, task).catch((err) =>
      console.warn(`[task ${task.id}] linter failed: ${(err as Error).message}`),
    );
  }
  /** Runs `fn` once fewer than {@link MAX_CONCURRENT_LINTS} lint calls are
   *  already in flight, queueing (FIFO) otherwise — the bulk-import throttle
   *  described on the class fields above. */
  private async withLintSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.lintInFlight >= Operations.MAX_CONCURRENT_LINTS) {
      await new Promise<void>((resolve) => this.lintQueue.push(resolve));
    }
    this.lintInFlight++;
    try {
      return await fn();
    } finally {
      this.lintInFlight--;
      this.lintQueue.shift()?.();
    }
  }
  private async lintTaskNow(ws: string, task: Task): Promise<void> {
    // v5 coach context: the rest of the project's own open backlog, for the
    // missing-dependency / parallel-candidate rules — a snapshot at lint time,
    // same staleness caveat as everywhere else this is advisory-only.
    const siblingTitles = (await this.store.listTasks(ws))
      .filter((t) => t.projectId === task.projectId && t.id !== task.id && !t.archived && (t.state === "backlog" || t.state === "todo"))
      .map((t) => t.text);
    const concerns = await this.withLintSlot(() => this.lintConsult(task.text, task.description, siblingTitles));
    const current = await this.store.getTask(task.id);
    if (!current || current.workspaceId !== ws) return; // deleted meanwhile
    // The task may have been edited again while the consult was in flight —
    // only apply the result if it still matches what was linted, else a
    // stale verdict would clobber a fresher edit's own (pending) lint.
    if (current.text !== task.text || current.description !== task.description) return;
    await this.hub.upsertTask({ ...current, lint: { concerns, at: now(), dismissed: false } });
  }
  /** Dismiss the current lint hint on a task — the operator has seen it and
   *  is setting it aside. A no-op if the task has no active lint result. */
  async dismissTaskLint(ws: string, tid: string): Promise<Task> {
    const task = await this.store.getTask(tid);
    if (!task || task.workspaceId !== ws) throw new NotFoundError("Task");
    if (!task.lint) return task;
    return this.hub.upsertTask({ ...task, lint: { ...task.lint, dismissed: true } });
  }

  /**
   * Answer triage's clarifying questions (see TaskClarification). The answer is
   * APPENDED to the task's description — never replacing it, and never rewritten
   * by a model — so the operator's own words are what the next triage pass and
   * any eventual agent actually read.
   *
   * The task returns to `backlog` for a genuine RE-TRIAGE rather than being
   * promoted straight to `todo`: the answer may well change the effort, risk or
   * grouping read, and the whole point of this loop is that the clarity call is
   * made with the missing information in hand. Clearing `clarification` is what
   * makes the ask disappear from the board.
   *
   * The stamped `CLARIFICATION_ANSWERED_MARKER` heading isn't just a nice
   * transcript — the re-triage tick greps for it to recognize "this task
   * already went through one round" and forces a promote if the model still
   * comes back unclear, so a stubborn model can't re-ask the same question
   * forever (see tickAutonomy's triage step in orchestrator.ts).
   */
  async answerClarification(ws: string, tid: string, answer: string): Promise<Task> {
    const task = await this.store.getTask(tid);
    if (!task || task.workspaceId !== ws) throw new NotFoundError("Task");
    if (!task.clarification) throw new Error("This task has no open clarifying questions.");
    const asked = task.clarification.questions;
    const block = [
      "",
      "---",
      CLARIFICATION_ANSWERED_MARKER,
      ...asked.map((q) => `- _${q}_`),
      "",
      answer.trim(),
    ].join("\n");
    return this.hub.upsertTask({
      ...task,
      description: `${task.description?.trim() ?? ""}${block}`.trim(),
      clarification: null,
      state: "backlog",
    });
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

  /**
   * The v3 "inbound-trigger" primitive's first concrete instance: a GitHub
   * `issues` webhook (opened/reopened/labeled) creates the task immediately,
   * instead of waiting on the next manual "Import issues" click or re-sync.
   * Called from the verified webhook route (github/webhook.ts) — signature
   * verification already happened there, so this only does the domain work.
   * No workspace context arrives with a GitHub webhook, so it fans out across
   * every workspace's projects bound to that repo (usually exactly one) and
   * reuses `importGithubIssues`'s same opt-in gate (`syncSourceStatus`) and
   * dedup key (`source.repo`+`source.number`) so a redelivered or
   * already-imported issue is a no-op.
   */
  async handleGithubIssueEvent(event: {
    action: string;
    repo: string;
    issue: { number: number; title: string; body: string | null; url: string };
  }): Promise<{ created: number }> {
    if (!["opened", "reopened", "labeled"].includes(event.action)) return { created: 0 };
    const projects = (await this.store.listAllProjects()).filter((p) => p.repo === event.repo && p.syncSourceStatus);
    let created = 0;
    for (const project of projects) {
      const existing = await this.store.listTasks(project.workspaceId);
      const already = existing.some(
        (t) =>
          t.projectId === project.id &&
          t.source?.kind === "github_issue" &&
          t.source.repo === event.repo &&
          t.source.number === event.issue.number,
      );
      if (already) continue;
      await this.createTask(project.workspaceId, project.id, {
        text: event.issue.title,
        description: event.issue.body || undefined,
        source: { kind: "github_issue", repo: event.repo, number: event.issue.number, url: event.issue.url },
      });
      created++;
    }
    return { created };
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

  /**
   * Manual "Re-sync" — the operator (or Steward) explicitly asking to catch up
   * both directions at once, rather than waiting on either the one-time import
   * or the event-driven write-back (task-sync.ts) to happen to have covered
   * everything. Three passes, each safe to call repeatedly:
   *  1. PULL new — importGithubIssues/importRepoFile's own dedup (unchanged).
   *  2. PULL drift — an already-linked github_issue task's title/description
   *     is re-synced from the CURRENT issue (last-GitHub-write-wins for those
   *     two fields; see docs/task-source-sync.md's "two-way sync deferred" —
   *     this is the narrow, safe slice of it: no conflict detection, no
   *     sourceRev, just "GitHub is the source of truth for these fields").
   *     repo_file items have no stable id to update against (anchored by their
   *     own label text), so only new-item pull applies there.
   *  3. PUSH drift — reconcileSourceState for every sourced task in the
   *     project, catching a state change that never made it back (sync was
   *     off, or a write-back attempt failed) — see task-sync.ts. Gated on
   *     `project.syncSourceStatus` same as the automatic path; re-sync is a
   *     catch-up on the project's own policy, not a way around it.
   * Best-effort per task/issue — one failure doesn't abort the rest.
   */
  async resyncProjectSource(ws: string, projectId: string): Promise<{ imported: number; updated: number; pushed: number }> {
    const project = await this.store.getProject(projectId);
    if (!project || project.workspaceId !== ws) throw new NotFoundError("Project");
    if (!project.repo) throw new Error("Project isn't bound to a GitHub repo — nothing to re-sync.");

    let imported = 0;
    let updated = 0;

    // 1 + 2: GitHub issues — new ones, plus drift on already-linked ones.
    const issues = await githubService.listIssues(ws, project.repo, project.githubCredentialId).catch(() => []);
    const mine = (await this.store.listTasks(ws)).filter((t) => t.projectId === projectId);
    const byIssue = new Map(
      mine.flatMap((t) => (t.source?.kind === "github_issue" ? [[`${t.source.repo}#${t.source.number}`, t] as const] : [])),
    );
    for (const iss of issues) {
      const linked = byIssue.get(`${project.repo}#${iss.number}`);
      if (!linked) {
        await this.createTask(ws, projectId, {
          text: iss.title,
          description: iss.body || undefined,
          source: { kind: "github_issue", repo: project.repo, number: iss.number, url: iss.url },
        }).then(() => imported++).catch(() => undefined);
        continue;
      }
      const wantDescription = iss.body || null;
      if (linked.text !== iss.title || (linked.description ?? null) !== wantDescription) {
        await this.updateTask(ws, linked.id, { text: iss.title, description: wantDescription })
          .then(() => updated++)
          .catch(() => undefined);
      }
    }

    // 1: repo-file checklist items — re-scan every distinct file already linked
    // in this project for newly-added open items (no stable id to detect
    // per-item title drift against, so that half doesn't apply here).
    const repoFilePaths = new Set(mine.flatMap((t) => (t.source?.kind === "repo_file" ? [t.source.path] : [])));
    for (const path of repoFilePaths) {
      const res = await this.importRepoFile(ws, projectId, path).catch(() => ({ imported: 0, skipped: 0 }));
      imported += res.imported;
    }

    // 3: push drift for every sourced task, current project state.
    let pushed = 0;
    if (project.syncSourceStatus) {
      const sourced = (await this.store.listTasks(ws)).filter((t) => t.projectId === projectId && t.source);
      for (const t of sourced) {
        const did = await reconcileSourceState(t, { store: this.store }).catch(() => false);
        if (did) pushed++;
      }
    }

    return { imported, updated, pushed };
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
      await this.maybeWarnFeatureBatchSize(ws, f, tid);
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
    // Editing the text or description invalidates any existing lint result —
    // clear it immediately (so a stale hint doesn't linger against new text)
    // and kick a fresh background check.
    const relint =
      (patch.text !== undefined && patch.text !== task.text) ||
      (patch.description !== undefined && patch.description !== task.description);
    const updated = await this.hub.upsertTask({
      ...task,
      ...patch,
      ...autoPickPatch,
      ...(relint ? { lint: null } : {}),
    });
    if (relint) this.maybeLintTask(ws, updated);
    return updated;
  }
  /**
   * Earlier warning for the feature-batch size guardrail (see
   * orchestrator.ts's checkFeatureBatchSize, applied at PR-open time): fires
   * the moment a task JOINS a feature and the resulting batch crosses
   * SKYNET_FEATURE_BATCH_MAX_TASKS, not just once the whole batch completes —
   * an operator sees it while there's still time to split the feature.
   * Assistive only: never blocks the link, never throws. Fires ONCE — once
   * `feature.sizeWarning` is set it's left alone, so adding an 13th, 14th, …
   * task doesn't keep re-triggering the same note.
   */
  private async maybeWarnFeatureBatchSize(ws: string, feature: Feature, joiningTaskId: string): Promise<void> {
    if (feature.sizeWarning) return; // already warned once — assistive, not a nag
    const siblingCount =
      (await this.store.listTasks(ws)).filter((t) => t.featureId === feature.id && !t.archived && t.id !== joiningTaskId).length + 1; // +1 for the task joining right now
    if (siblingCount <= config.featureBatchMaxTasks) return;
    const note = `"${feature.name}" now has ${siblingCount} tasks under it — over the ${config.featureBatchMaxTasks}-task batch guardrail. Consider splitting it into a second feature before the batch completes (it'll still open as one PR either way).`;
    console.warn(`[feature ${feature.id}] ${note}`);
    await this.hub.upsertFeature({
      ...feature,
      sizeWarning: { taskCount: siblingCount, threshold: config.featureBatchMaxTasks, note, at: now() },
    });
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
  /** Steward-driven board tidy: priority-sorts every non-done column by what
   *  it can infer from each task's title + description (see
   *  steward/organize.ts), suggests any-agent eligibility for currently-
   *  unassigned backlog tasks (an `unassigned` task never leaves backlog on
   *  its own — see AssignmentRequiredError — so this is also Steward's
   *  chance to clear that blocker for the ones that don't actually need an
   *  operator's routing judgment), and archives every current Done task —
   *  recorded work with no reason to keep cluttering the active board;
   *  Archive is fully reversible from the Archived view. One explicit
   *  operator-triggered action (not a background job) — same one-click
   *  directness as Force done / Archive. Best-effort throughout: a column
   *  whose consult fails/degrades keeps its existing order, and a task the
   *  eligibility consult doesn't confidently vouch for is simply left
   *  unassigned — never a hard failure over one bad reply. */
  async organizeBoard(ws: string, projectId: string): Promise<{ reordered: number; archived: number; assigned: number }> {
    const project = await this.store.getProject(projectId);
    if (!project || project.workspaceId !== ws) throw new NotFoundError("Project");
    const all = (await this.store.listTasks(ws)).filter((t) => t.projectId === projectId && !t.archived);

    const ask =
      this.organizeAsk ??
      (async (prompt: string) => {
        const apiKey = (await secretService.resolve(ws, "claude")) ?? undefined;
        return oneShotText({ prompt, model: ASSISTANT_MODEL, apiKey });
      });
    // Skip the (doomed) call when we already know no key resolves — same
    // structural guard as refreshProjectContext, not reply-content sniffing.
    const canAsk = !!this.organizeAsk || !!(await secretService.resolve(ws, "claude"));

    let reordered = 0;
    const rank = (t: Task) => t.order ?? 0;
    if (canAsk) {
      for (const state of ["backlog", "triage", "todo", "ongoing", "review"] as const) {
        const column = all.filter((t) => t.state === state).sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
        if (column.length < 2) continue;
        const order = await prioritizeColumn(
          ask,
          project.name,
          project.goal,
          column.map((t) => ({ id: t.id, text: t.text, description: t.description })),
        );
        for (let i = 0; i < order.length; i++) {
          const task = column.find((t) => t.id === order[i]);
          if (task && rank(task) !== i) {
            await this.hub.upsertTask({ ...task, order: i });
            reordered++;
          }
        }
      }
    }

    let assigned = 0;
    if (canAsk) {
      const unassigned = all.filter(
        (t) => t.state === "backlog" && (t.assignment?.mode ?? "unassigned") === "unassigned",
      );
      if (unassigned.length > 0) {
        const eligibleIds = await suggestAnyAgentEligible(
          ask,
          project.name,
          project.goal,
          unassigned.map((t) => ({ id: t.id, text: t.text, description: t.description })),
        );
        for (const id of eligibleIds) {
          const task = unassigned.find((t) => t.id === id);
          if (task) {
            await this.hub.upsertTask({ ...task, assignment: { mode: "any", agentIds: [] } });
            assigned++;
          }
        }
      }
    }

    let archived = 0;
    for (const task of all.filter((t) => t.state === "done")) {
      await this.hub.upsertTask({ ...task, archived: true });
      archived++;
    }
    return { reordered, archived, assigned };
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
   * its run and detaches it so the task returns clean — UNLESS `opts.preserve` is
   * set on an ongoing/review→todo move, which pauses the run instead (worktree +
   * committed work kept; a later Start on the same task resumes it in place, see
   * Orchestrator.pauseRun). Preserve only applies to that one edge — a done task
   * demoted back to triage/backlog always discards (a different, rarer flow).
   */
  async transitionTask(
    ws: string,
    tid: string,
    to: Task["state"],
    operatorId: string,
    opts: { preserve?: boolean } = {},
  ): Promise<Task> {
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
    // Preserve only applies to the ongoing/review→todo edge (a "stalled or
    // hung, come back later" move) — never the done-demotion case above, which
    // always starts clean.
    const preserveWork =
      !!opts.preserve && !!task.runId && (task.state === "ongoing" || task.state === "review") && to === "todo";
    if (preserveWork && task.runId) {
      await this.orchestrator.pauseRun(task.runId).catch(() => undefined);
    } else if (abandonsRun && task.runId) {
      await this.orchestrator.stopAgent(task.runId, "task moved off the run by an operator").catch(() => undefined);
      await this.hub.setRunArchived(task.runId, true).catch(() => undefined);
      // Any HITL gate still open for this run (e.g. a diff/verifier/approval
      // gate raised while it was ongoing/review) is now unanswerable — the run
      // is stopped and the task is starting fresh elsewhere, so leaving the
      // card would strand it in the Inbox pointing at dead work. Dismissed
      // directly via the Hub (not Operations.resolveHitl, which calls
      // orchestrator.deliver — meaningless for a handle stopAgent just tore
      // down), same lower-level pattern settleArchivedRun uses for the
      // direct-archive path. This path can't reuse settleArchivedRun wholesale:
      // it deliberately keeps the worktree (reversible archive), while an
      // abandoned kanban move is a genuine "start over," correctly retired via
      // stopAgent above.
      const open = (await this.store.listQueue(ws)).filter((h) => h.runId === task.runId && !h.resolvedAt);
      for (const h of open) {
        await this.hub
          .resolveHitl(h.id, {
            action: "dismiss", by: operatorId, at: now(), optionIndex: null, guidance: null,
            targetBranch: null, memoryNote: null, resetWork: false,
          })
          .catch(() => undefined);
      }
    }

    const updated = await this.hub.upsertTask({
      ...task,
      state: to,
      // A preserved run stays linked (its runId is how a later Start finds and
      // resumes it) — only a truly abandoned run gets detached.
      ...(abandonsRun && !preserveWork ? { runId: null } : {}),
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
   * Execution intents (S10): the ONE server executor for the four
   * start/queue action kinds — direct (start_task) and composite
   * (queue_tasks, start_feature, process_backlog). Every one resolves
   * feasibility through the SAME pure resolver (steward/execution.ts's
   * resolveExecutable) whether this is a real run or `opts.dryRun` — a
   * confirm chip's preview and its later confirmed execution can never
   * disagree about what's eligible. Dry-run computes the identical decision
   * and returns it WITHOUT calling hub.upsertTask/upsertProject or
   * assignTask — zero mutation. Called by the dock (POST
   * .../steward/actions) today; Telegram + MCP reuse this same method rather
   * than growing their own copies (see steward/assistant.ts's ProjectActionKind
   * doc comment for why these four aren't yet reachable from Steward chat).
   *
   * Autonomy fold-in: queuing a task (autoPick: true) does nothing if the
   * project's autonomy toggle is off — nothing would ever pick it up. Rather
   * than making the operator separately confirm a set_autonomy action for
   * what is conceptually the SAME intent ("start this feature"), this turns
   * autonomy on as part of executing any call that queues at least one task,
   * and reports it via `autonomyEnabled` — including on a dry-run, so the
   * confirm chip is honest about the side effect before it happens.
   */
  async executeStewardAction(
    ws: string,
    projectId: string,
    action: StewardExecutionAction,
    operatorId: string,
    opts: { dryRun?: boolean } = {},
  ): Promise<StewardActionOutcome> {
    const project = await this.getProject(ws, projectId); // throws NotFoundError
    const dryRun = opts.dryRun ?? false;
    // `operatorId` isn't consumed yet — each started/queued task's own
    // record (its run, or its state change) is today's audit trail; kept in
    // the signature since S11/S12 (Telegram/MCP callers) already have one
    // to hand and a dedicated audit record is the natural next step.

    // Move a batch of already-resolved-ELIGIBLE tasks to todo + autoPick, and
    // fix an `unassigned` eligibility to `any` (queue_task spec). Bypasses
    // Operations.transitionTask/HUMAN_TRANSITIONS deliberately: this is a
    // SYSTEM-initiated queue, the exact same kind of write the autonomy
    // tick's own triage step already makes directly via hub.upsertTask
    // (orchestrator.ts) — not a human kanban drag, which is what
    // HUMAN_TRANSITIONS' stricter gate (no direct backlog→todo) exists for.
    const queue = async (tasks: Task[]): Promise<void> => {
      if (dryRun) return;
      for (const t of tasks) {
        await this.hub.upsertTask({
          ...t,
          state: "todo",
          autoPick: true,
          assignment: t.assignment.mode === "unassigned" ? { mode: "any", agentIds: [] } : t.assignment,
        });
      }
    };
    const enableAutonomyIfNeeded = async (willQueueAny: boolean): Promise<boolean> => {
      if (!willQueueAny || project.autonomy) return false;
      if (!dryRun) await this.hub.upsertProject({ ...project, autonomy: true });
      return true;
    };

    switch (action.kind) {
      case "start_task": {
        const task = await this.store.getTask(action.taskId);
        if (!task || task.workspaceId !== ws || task.projectId !== projectId) throw new NotFoundError("Task");
        const runs = await this.store.listRuns(ws);
        const { eligible, excluded } = resolveExecutable(project, [task], runs, { atMs: now() });
        if (eligible.length === 0) return { started: [], queued: [], excluded, autonomyEnabled: false, dryRun };
        if (!dryRun) await this.assignTask(ws, projectId, task.id);
        return { started: [task.id], queued: [], excluded, autonomyEnabled: false, dryRun };
      }

      case "queue_tasks": {
        const all = await this.store.listTasks(ws);
        const found = action.taskIds
          .map((id) => all.find((t) => t.id === id && t.projectId === projectId))
          .filter((t): t is Task => !!t);
        // An id that doesn't resolve (wrong project, or doesn't exist) never
        // silently drops — reported the same way an in-scope but unstartable
        // task is, so the caller's count always adds up.
        const unknown = action.taskIds.filter((id) => !found.some((t) => t.id === id));
        const runs = await this.store.listRuns(ws);
        const { eligible, excluded } = resolveExecutable(project, found, runs, { atMs: now() });
        const allExcluded = [...excluded, ...unknown.map((taskId) => ({ taskId, reason: "not-in-scope" as const }))];
        const autonomyEnabled = await enableAutonomyIfNeeded(eligible.length > 0);
        await queue(eligible);
        return { started: [], queued: eligible.map((t) => t.id), excluded: allExcluded, autonomyEnabled, dryRun };
      }

      case "start_feature": {
        const feature = await this.store.getFeature(action.featureId);
        if (!feature || feature.workspaceId !== ws || feature.projectId !== projectId) throw new NotFoundError("Feature");
        const all = await this.store.listTasks(ws);
        const tasks = all.filter((t) => t.featureId === feature.id);
        const runs = await this.store.listRuns(ws);
        const { eligible, excluded } = resolveExecutable(project, tasks, runs, {
          feasibleOnly: action.feasibleOnly,
          atMs: now(),
        });

        if (action.execMode === "queue") {
          const autonomyEnabled = await enableAutonomyIfNeeded(eligible.length > 0);
          await queue(eligible);
          return { started: [], queued: eligible.map((t) => t.id), excluded, autonomyEnabled, dryRun };
        }

        // start_now: assign as many as idle capacity allows (priority
        // order), queue the rest for the tick to pick up once capacity/budget
        // frees. A dry-run never actually acquires a runner — real-time fleet
        // capacity can't be previewed without racing it — so it reports every
        // eligible task as "would queue", the conservative honest answer;
        // the real run may start some of them immediately instead.
        if (dryRun) {
          const autonomyEnabled = eligible.length > 0 && !project.autonomy;
          return { started: [], queued: eligible.map((t) => t.id), excluded, autonomyEnabled, dryRun };
        }
        const started: string[] = [];
        const toQueue: Task[] = [];
        let outOfCapacity = false;
        for (const t of eligible) {
          if (outOfCapacity) {
            toQueue.push(t);
            continue;
          }
          try {
            await this.assignTask(ws, projectId, t.id);
            started.push(t.id);
          } catch (err) {
            if (err instanceof NoCapacityError || err instanceof RunnerNotConfiguredError) {
              outOfCapacity = true;
              toQueue.push(t);
            } else if (err instanceof TaskAlreadyAssignedError) {
              // Finished between resolve and now — same race any other
              // caller of assignTask can hit; nothing to start OR queue.
            } else {
              throw err;
            }
          }
        }
        const autonomyEnabled = await enableAutonomyIfNeeded(toQueue.length > 0);
        await queue(toQueue);
        return { started, queued: toQueue.map((t) => t.id), excluded, autonomyEnabled, dryRun };
      }

      case "process_backlog": {
        const all = await this.store.listTasks(ws);
        const tasks = all.filter(
          (t) => t.projectId === projectId && (t.state === "backlog" || t.state === "triage" || t.state === "todo"),
        );
        const runs = await this.store.listRuns(ws);
        const { eligible, excluded } = resolveExecutable(project, tasks, runs, {
          feasibleOnly: action.feasibleOnly,
          atMs: now(),
        });
        const autonomyEnabled = await enableAutonomyIfNeeded(eligible.length > 0);
        await queue(eligible);
        return { started: [], queued: eligible.map((t) => t.id), excluded, autonomyEnabled, dryRun };
      }
    }
  }

  /**
   * Force a task to `done` — the escape hatch when the normal review→done path
   * fails (e.g. the merge queue chokes on a conflict, an HITL got stuck, or the
   * run finished but the task didn't advance and there's no HITL to resolve).
   * Bypasses HUMAN_TRANSITIONS: usable from ANY state (except archived).
   *
   * This is "call it done" pressure applied to the SAME integration path a
   * normal Approve uses, not a cosmetic label flip: an open diff/merge/
   * verifier gate gets approved (commits + pushes/opens a PR, or enqueues the
   * local merge, exactly like a human clicking Approve); with no open gate,
   * whatever's sitting uncommitted in the run's worktree — live or not — gets
   * committed, sanity-checked, and pushed through the same pipeline
   * (Orchestrator.forceIntegrateRun). Skipping the normal review gate doesn't
   * skip judgment entirely: forceIntegrateRun's own completeness check can
   * come back "flag" — nothing gets pushed, a real diff review is raised
   * instead (which is also the notification — Telegram/push fires the moment
   * that gate is raised), and the task lands in `review`, not `done`.
   * The task only flips to `done` here in the store when nothing could be
   * integrated (no run, or no git backend at all) — the GitHub-push case marks
   * done synchronously as part of that same call, and the local-merge-queue
   * case marks it done asynchronously once the merge actually lands (or raises
   * a real conflict gate instead of lying about "done"), same as any other
   * approve. So this can return a task still in `review` — that's real
   * in-flight state, not the old unconditional flip.
   */
  async forceTaskDone(ws: string, tid: string, operatorId: string): Promise<Task> {
    const task = await this.store.getTask(tid);
    if (!task || task.workspaceId !== ws) throw new NotFoundError("Task");
    if (task.archived) throw new NotFoundError("Task"); // archived is a soft-hide, not force-doneable

    if (task.runId) {
      const open = (await this.store.listQueue(ws)).find(
        (h) => h.runId === task.runId && !h.resolvedAt && (h.kind === "diff" || h.kind === "merge" || h.kind === "verifier"),
      );
      if (open) {
        await this.resolveHitl(ws, open.id, { action: "approve" }, operatorId);
        return (await this.store.getTask(tid)) ?? task;
      }
      // No gate waiting — the run may still be live/mid-turn, or finished
      // with real, uncommitted work sitting in its worktree. Commit it and
      // route it through the same push/merge integration a diff approval
      // uses, so "done" isn't a fiction over unlanded work — "flagged" means
      // it held back and raised a real review instead; either way real work
      // just happened, so neither outcome falls through to the cosmetic tail.
      const outcome = await this.orchestrator.forceIntegrateRun(task.runId).catch(() => "nothing" as const);
      if (outcome !== "nothing") return (await this.store.getTask(tid)) ?? task;
    }

    // Nothing to integrate (no run, or no git backend at all) — cosmetic-only,
    // same as this escape hatch's original behavior.
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

  /**
   * Manual "Request review" — force a review pass on a review-stage task now,
   * instead of waiting for a periodic tick to find an idle reviewer on its
   * own. Throws NoOpenReviewGateError / AlreadyReviewedError /
   * NoReviewerAvailableError (orchestrator.ts) for the honest failure modes —
   * the route maps each to a specific status so the operator sees why, not a
   * generic 500.
   */
  async requestReview(ws: string, tid: string): Promise<void> {
    const task = await this.getTask(ws, tid);
    await this.orchestrator.requestReview(ws, task.id);
  }

  /**
   * Manual "Request re-triage" — force a fresh triage pass on a task already
   * parked in `triage` now, instead of waiting for it to cycle back through
   * `backlog` on its own. Throws NoTriageTargetError / NoCapacityError
   * (orchestrator.ts) for the honest failure modes.
   */
  async requestRetriage(ws: string, tid: string): Promise<void> {
    const task = await this.getTask(ws, tid);
    await this.orchestrator.requestRetriage(ws, task.id);
  }

  /**
   * Manual "Force to review" — pull a still-`ongoing` task's live run up for
   * review right now, instead of waiting for the agent to finish its own
   * turn. Throws NothingToReviewError (orchestrator.ts) for the honest
   * failure modes: the task isn't ongoing / has no linked run, its run isn't
   * live right now, or nothing has actually changed yet to show.
   */
  async forceReview(ws: string, tid: string): Promise<void> {
    const task = await this.getTask(ws, tid);
    if (task.state !== "ongoing" || !task.runId) throw new NothingToReviewError();
    await this.orchestrator.forceReviewRun(task.runId);
  }

  /**
   * Manual "Switch agent" — move a still-`ongoing` task's live run to a
   * SPECIFIC, operator-chosen idle agent: stops the current session, keeps
   * the same worktree/branch/committed work, resumes it on the target.
   * Throws an honest error (task isn't ongoing / has no linked run, or the
   * chosen agent isn't found/idle/usable — see
   * Orchestrator.acquireSpecificAgent) rather than a silent no-op; the live
   * run is left untouched on failure.
   */
  async reassignTaskAgent(ws: string, tid: string, targetAgentId: string): Promise<void> {
    const task = await this.getTask(ws, tid);
    if (task.state !== "ongoing" || !task.runId) throw new Error("This task isn't ongoing right now — nothing to reassign.");
    await this.orchestrator.reassignRunToAgent(task.runId, targetAgentId);
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
      pr: null,
      sizeWarning: null,
      verification: null,
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

  // ── solution briefs (pre-work planning docs) ───────────────────────────
  // sourceConversation is a PROVENANCE breadcrumb, not a transcript — capped
  // at write time (same "assessment" truncation convention as
  // orchestrator.ts's auto-triage: `.slice(0, 500)`), never enforced in the
  // schema itself (contracts.ts stays permissive; length policy is here).
  private static readonly SOURCE_CONVERSATION_MAX = 500;

  async createBrief(ws: string, projectId: string, input: CreateSolutionBriefRequest): Promise<SolutionBrief> {
    const project = await this.store.getProject(projectId);
    if (!project || project.workspaceId !== ws) throw new NotFoundError("Project");
    if (input.featureId != null) {
      const f = await this.store.getFeature(input.featureId);
      if (!f || f.workspaceId !== ws || f.projectId !== projectId) throw new NotFoundError("Feature");
    }
    const at = now();
    const brief: SolutionBrief = {
      id: this.uid(`brief-${this.slug(project.name)}`),
      workspaceId: ws,
      projectId,
      title: input.title,
      problem: input.problem?.trim() ?? "",
      approach: input.approach?.trim() ?? "",
      optionsConsidered: input.optionsConsidered ?? [],
      risks: input.risks ?? [],
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      openQuestions: input.openQuestions ?? [],
      status: "draft",
      featureId: input.featureId ?? null,
      createdAt: at,
      updatedAt: at,
      approvedAt: null,
      approvedBy: null,
      sourceConversation: input.sourceConversation?.trim().slice(0, Operations.SOURCE_CONVERSATION_MAX) || null,
      exploration: null,
    };
    return this.hub.upsertSolutionBrief(brief);
  }

  /** PATCH a brief. `operatorId` is stamped as `approvedBy` ONLY on the actual
   *  draft/building/done → "approved" transition (never re-stamped on a later
   *  edit while already approved, and never cleared by moving past it to
   *  building/done — that history stays). Callers are responsible for
   *  deciding whether `patch.status === "approved"` may even reach this
   *  method — see api.ts's route and mcp/tools.ts's update_brief, both of
   *  which refuse it for a scoped (agent) token before calling here; this
   *  method itself has no notion of "who's calling", by design (Operations
   *  stays transport-agnostic — see this file's header comment). */
  async updateBrief(ws: string, briefId: string, patch: UpdateSolutionBriefRequest, operatorId: string): Promise<SolutionBrief> {
    const brief = await this.store.getSolutionBrief(briefId);
    if (!brief || brief.workspaceId !== ws) throw new NotFoundError("SolutionBrief");
    if (patch.featureId != null) {
      const f = await this.store.getFeature(patch.featureId);
      if (!f || f.workspaceId !== ws || f.projectId !== brief.projectId) throw new NotFoundError("Feature");
    }
    const approving = patch.status === "approved" && brief.status !== "approved";
    return this.hub.upsertSolutionBrief({
      ...brief,
      ...patch,
      updatedAt: now(),
      ...(approving ? { approvedAt: now(), approvedBy: operatorId } : {}),
    });
  }

  async deleteBrief(ws: string, briefId: string): Promise<void> {
    const brief = await this.store.getSolutionBrief(briefId);
    if (!brief || brief.workspaceId !== ws) throw new NotFoundError("SolutionBrief");
    await this.hub.deleteSolutionBrief(briefId);
  }

  /** "Crystallize" (S5): turn a Steward conversation into a draft SolutionBrief.
   *  One LLM call (retried once on an unreadable/invalid reply — see
   *  draftBriefFromConversation) drafts the content-bearing fields; this method
   *  fills the system-owned ones the SAME way createBrief always does (id,
   *  status: "draft", timestamps) — the model is never trusted with those. On a
   *  second bad reply this throws CrystallizeParseError (→ 4xx at the HTTP
   *  boundary) and no brief is created — never a half-parsed one. */
  async crystallizeBrief(ws: string, projectId: string, history: ChatTurn[]): Promise<SolutionBrief> {
    const project = await this.store.getProject(projectId);
    if (!project || project.workspaceId !== ws) throw new NotFoundError("Project");
    const ask =
      this.crystallizeAsk ??
      (async (prompt: string) => {
        const apiKey = (await secretService.resolve(ws, "claude")) ?? undefined;
        return oneShotText({ prompt, model: ASSISTANT_MODEL, apiKey });
      });
    const draft = await draftBriefFromConversation(ask, project.name, history);
    return this.createBrief(ws, projectId, { ...draft, sourceConversation: summarizeConversation(history) });
  }

  // ─── Project context (meeting notes, emails, pasted/uploaded docs) ────────
  // Raw entries are the source of truth (kept verbatim); refreshProjectContext
  // condenses the accumulated set into Project.contextSummary — the primer
  // every agent's task prompt and Steward's grounding both read (see
  // agent-context.ts / steward/assistant.ts). Add/upload/delete all trigger a
  // re-condense so the summary never drifts stale behind the raw entries.

  async listContextEntries(ws: string, projectId: string): Promise<ProjectContextEntry[]> {
    const project = await this.store.getProject(projectId);
    if (!project || project.workspaceId !== ws) throw new NotFoundError("Project");
    return (await this.store.listContextEntries(ws))
      .filter((e) => e.projectId === projectId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  private contextAskFn(ws: string): (prompt: string) => Promise<string> {
    return (
      this.contextAsk ??
      (async (prompt: string) => {
        const apiKey = (await secretService.resolve(ws, "claude")) ?? undefined;
        return oneShotText({ prompt, model: ASSISTANT_MODEL, apiKey });
      })
    );
  }

  /** Re-condense a project's accumulated context entries into
   *  Project.contextSummary — called automatically after add/upload/delete,
   *  and exposed as its own operation for a manual "Regenerate" action. A
   *  project with zero entries clears the summary back to null rather than
   *  leaving a stale one from since-deleted entries. */
  async refreshProjectContext(ws: string, projectId: string): Promise<Project> {
    const project = await this.store.getProject(projectId);
    if (!project || project.workspaceId !== ws) throw new NotFoundError("Project");
    const entries = await this.listContextEntries(ws, projectId);
    // Skip the (doomed) call when we already know no key resolves — see
    // condenseProjectContext's doc comment for why this structural check (not
    // reply-content sniffing) is the right place to guard against a degraded
    // reply landing as a fake summary. Only for the real default ask — never
    // for an injected test stub.
    if (!this.contextAsk && !(await secretService.resolve(ws, "claude"))) return project;
    const summary = await condenseProjectContext(this.contextAskFn(ws), project.name, entries);
    return this.hub.upsertProject({ ...project, contextSummary: summary, contextSummaryUpdatedAt: now() });
  }

  async addContextEntry(ws: string, projectId: string, operatorId: string, input: CreateProjectContextEntryRequest): Promise<ProjectContextEntry> {
    const project = await this.store.getProject(projectId);
    if (!project || project.workspaceId !== ws) throw new NotFoundError("Project");
    const entry: ProjectContextEntry = {
      id: this.uid(`ctx-${this.slug(project.name)}`),
      workspaceId: ws,
      projectId,
      source: "paste",
      label: input.label?.trim() || `Note — ${new Date(now()).toLocaleDateString()}`,
      content: input.content.trim(),
      filename: null,
      mimeType: null,
      createdAt: now(),
      createdBy: operatorId,
    };
    await this.hub.upsertContextEntry(entry);
    await this.refreshProjectContext(ws, projectId);
    return entry;
  }

  /** `UnsupportedFileTypeError` (bad extension) and any extraction failure
   *  propagate to the caller — see api.ts's fail() mapping — rather than
   *  silently storing an empty/garbled entry. */
  async uploadContextEntry(
    ws: string,
    projectId: string,
    operatorId: string,
    file: { filename: string; mimeType: string; buffer: Buffer },
  ): Promise<ProjectContextEntry> {
    const project = await this.store.getProject(projectId);
    if (!project || project.workspaceId !== ws) throw new NotFoundError("Project");
    const content = await extractText(file.filename, file.mimeType, file.buffer);
    const entry: ProjectContextEntry = {
      id: this.uid(`ctx-${this.slug(project.name)}`),
      workspaceId: ws,
      projectId,
      source: "upload",
      label: file.filename,
      content,
      filename: file.filename,
      mimeType: file.mimeType || null,
      createdAt: now(),
      createdBy: operatorId,
    };
    await this.hub.upsertContextEntry(entry);
    await this.refreshProjectContext(ws, projectId);
    return entry;
  }

  async deleteContextEntry(ws: string, projectId: string, entryId: string): Promise<void> {
    const entry = await this.store.getContextEntry(entryId);
    if (!entry || entry.workspaceId !== ws || entry.projectId !== projectId) throw new NotFoundError("Context entry");
    await this.hub.deleteContextEntry(entryId);
    await this.refreshProjectContext(ws, projectId);
  }

  /**
   * S7: turn an APPROVED brief into a Feature + an ordered, sized, linked batch
   * of Tasks — one LLM call (structured output, see decompose.ts), retried once
   * on an unreadable reply, then a thrown error (4xx at the route) with
   * NOTHING created — the Feature and every Task are only ever written once
   * the whole plan parses, never half-created from a partial/bad reply.
   *
   * Idempotent by CONTENT, not by `brief.featureId` (a brief may already carry
   * a featureId from manual pre-linking at creation time — see
   * CreateSolutionBriefRequest — without ever having been decomposed): a brief
   * counts as "already decomposed" only once a real Task in this project
   * carries `source: {kind:"brief", briefId}`. Regenerating means deleting
   * those tasks (and, typically, the feature) first — a manual, explicit
   * operator action, never an implicit overwrite of work that may already be
   * underway.
   */
  async decomposeBrief(ws: string, projectId: string, briefId: string): Promise<{ feature: Feature; tasks: Task[] }> {
    const project = await this.store.getProject(projectId);
    if (!project || project.workspaceId !== ws) throw new NotFoundError("Project");
    const brief = await this.store.getSolutionBrief(briefId);
    if (!brief || brief.workspaceId !== ws || brief.projectId !== projectId) throw new NotFoundError("SolutionBrief");
    if (brief.status !== "approved") {
      throw new Error("Only an approved brief can be decomposed into tasks.");
    }
    const projectTasks = await this.store.listTasks(ws);
    const alreadyDecomposed = projectTasks.some(
      (t) => t.projectId === projectId && t.source?.kind === "brief" && t.source.briefId === briefId,
    );
    if (alreadyDecomposed) {
      throw new Error("This brief has already been decomposed — delete the resulting feature/tasks first to regenerate.");
    }

    const apiKey = await secretService.resolve(ws, "claude");
    const model = process.env.SKYNET_DECOMPOSE_MODEL || "sonnet";
    const prompt = buildDecomposePrompt(brief);
    let plan: ReturnType<typeof parseDecomposition> = null;
    for (let attempt = 0; attempt < 2 && !plan; attempt++) {
      const reply = await this.decomposeConsult({ prompt, model, apiKey }).catch(() => "");
      plan = parseDecomposition(reply);
    }
    if (!plan) {
      throw new Error("Couldn't generate a plan from this brief — the model's reply wasn't readable as one. Try again.");
    }

    const at = now();
    const inFeatures = (await this.store.listFeatures(ws)).filter((f) => f.projectId === projectId);
    const feature: Feature = {
      id: this.uid(`f-${this.slug(project.name)}`),
      workspaceId: ws,
      projectId,
      name: plan.feature.name,
      description: plan.feature.description || brief.approach.trim().slice(0, 500) || null,
      status: "active",
      milestoneId: null,
      order: inFeatures.length,
      archived: false,
      createdAt: at,
      pr: null,
      sizeWarning: null,
      verification: null,
    };
    await this.hub.upsertFeature(feature);

    const inProject = projectTasks.filter((t) => t.projectId === projectId);
    // Ids are minted up front so dependsOnIndex (an index into THIS plan) can
    // resolve to real task ids before any task is written.
    const ids = plan.tasks.map((_, i) => this.uid(`t-${this.slug(project.name)}-${i}`));
    const tasks: Task[] = plan.tasks.map((t, i) => {
      const acceptance = t.acceptanceCriteria.length
        ? `\n\n## Acceptance\n${t.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`
        : "";
      const description = `${t.description}${acceptance}`.trim();
      return {
        id: ids[i]!,
        workspaceId: ws,
        projectId,
        text: t.text,
        description: description || null,
        // Lands in backlog, not todo — triage + the task linter run on it
        // normally, same as any other newly-created task (see S7 spec).
        state: "backlog",
        runId: null,
        autoPick: false,
        assessment: null,
        assessmentEffort: t.effort,
        assessmentRisks: [],
        clarification: null,
        reviewVerdict: null,
        assignment: { mode: "unassigned", agentIds: [] },
        order: inProject.length + i,
        archived: false,
        estimatedDurationMs: null,
        plannedStartAt: null,
        featureId: feature.id,
        milestoneId: null,
        source: { kind: "brief", briefId: brief.id },
        dependsOnTaskIds: t.dependsOnIndex.map((idx) => ids[idx]!),
        lint: null,
        preferredProvider: null,
        preferredModel: null,
      };
    });
    for (const t of tasks) {
      const created = await this.hub.upsertTask(t);
      this.maybeLintTask(ws, created);
    }

    // Link the brief to the feature it just produced. Deliberately leaves
    // `status` at "approved" — the approved→"building" transition belongs to
    // S8, not this step.
    await this.hub.upsertSolutionBrief({ ...brief, featureId: feature.id, updatedAt: at });

    return { feature, tasks };
  }

  /**
   * S6 (optional): opt-in rigor before approving a brief — spins a bounded,
   * read-only agent run (Orchestrator.exploreBrief) that actually reads the
   * codebase and appends its findings/touchpoints to the brief. Advisory
   * only: `status`/every operator-authored field is untouched either way.
   * `exploreBrief` returns null on ANY failure (no local repo, no usable
   * credential, worktree prep failed, timeout, unreadable output) — turned
   * into a real thrown Error here so the failure is VISIBLE at the API
   * boundary (a 400 the caller sees), rather than a silent 200 that looks
   * like success. The brief itself is never written on failure.
   */
  async exploreBrief(ws: string, projectId: string, briefId: string): Promise<SolutionBrief> {
    const brief = await this.getBrief(ws, briefId);
    if (brief.projectId !== projectId) throw new NotFoundError("SolutionBrief");
    const project = await this.store.getProject(projectId);
    if (!project || project.workspaceId !== ws) throw new NotFoundError("Project");
    const result = await this.orchestrator.exploreBrief(ws, brief, project);
    if (!result) {
      throw new Error("Explore couldn't complete (no local repo, no usable Claude credential, or it timed out) — the brief is unchanged.");
    }
    return this.hub.upsertSolutionBrief({ ...brief, exploration: { at: now(), findings: result.findings, touchpoints: result.touchpoints } });
  }

  // ── roadmap doc (ROADMAP.md read straight from the project's bound repo) ──
  async getProjectRoadmap(ws: string, projectId: string): Promise<ProjectRoadmapResult> {
    const project = await this.store.getProject(projectId);
    if (!project || project.workspaceId !== ws) throw new NotFoundError("Project");
    if (!project.repoPath && !project.repo) return { state: "unbound" };
    if (project.repoPath && !existsSync(project.repoPath)) return { state: "missing_local_repo" };
    try {
      const doc = await resolveRoadmapDoc(ws, project);
      return doc
        ? { state: "ok", path: doc.path, content: doc.content, source: doc.source, ...(doc.sha ? { sha: doc.sha } : {}) }
        : { state: "not_found" };
    } catch (err) {
      return { state: "github_error", message: (err as Error).message };
    }
  }

  /**
   * Scenario coverage for a project's checked-out branch — the "how well does
   * this actually work?" panel. Derived purely by READING the repo (see
   * quality/scan.ts): it never runs the project's toolchain, so it's safe to
   * point at code an agent just wrote and fast enough to be an on-demand panel.
   *
   * Local checkout only. A GitHub-only project would need hundreds of Contents
   * API reads to scan, which is neither fast nor free — reported honestly as
   * `missing_local_repo` rather than silently returning an empty report that
   * would read as "nothing to cover".
   */
  async getProjectQuality(ws: string, projectId: string): Promise<ProjectQualityResult> {
    const project = await this.store.getProject(projectId);
    if (!project || project.workspaceId !== ws) throw new NotFoundError("Project");
    const root = project.repoPath ?? (config.reposDir ? join(config.reposDir, project.id) : null);
    if (!root && !project.repo) return { state: "unbound" };
    if (!root || !existsSync(root)) return { state: "missing_local_repo" };
    const scan = await scanRepo(root, now());
    return {
      state: "ok",
      quality: {
        axes: scan.scenarios.axes,
        behaviourCount: scan.scenarios.behaviours.length,
        totalCases: scan.scenarios.totalCases,
        coveredCases: scan.scenarios.coveredCases,
        sourceFiles: scan.scenarios.sourceFiles,
        testFiles: scan.scenarios.testFiles,
        coverage: scan.coverage,
        scannedAt: scan.scannedAt,
      },
    };
  }

  /** Commit a Steward-drafted edit to the project's roadmap doc — only reachable
   *  after the operator has confirmed the diff in the chat UI. Refuses
   *  (RoadmapConflictError) if the file changed since the edit was drafted. */
  async updateProjectRoadmap(ws: string, projectId: string, body: UpdateProjectRoadmapRequest): Promise<ProjectRoadmapResult> {
    const project = await this.store.getProject(projectId);
    if (!project || project.workspaceId !== ws) throw new NotFoundError("Project");
    if (!project.repoPath && !project.repo) throw new Error("This project has no bound repo to commit to.");

    if (project.repoPath) {
      const current = await readProjectDoc(ws, project, body.path);
      if (!current || contentHash(current.content) !== body.baselineHash) throw new RoadmapConflictError();
      await commitLocalRepoFile(project.repoPath, body.path, body.content, current.content, `Skynet: update ${body.path} (Steward)`);
      return { state: "ok", path: body.path, content: body.content, source: "local" };
    }
    if (!body.baselineSha) throw new Error("Missing baseline sha for a GitHub-bound roadmap edit.");
    // Reuse the ORIGINAL sha (not a refetch) so a concurrent edit trips GitHub's own
    // atomic sha check in commitRepoFile/provider.putFile instead of silently overwriting it.
    try {
      await githubService.commitRepoFile(ws, project.repo!, body.path, body.content, body.baselineSha, `Skynet: update ${body.path} (Steward)`, project.githubCredentialId);
    } catch (err) {
      // GitHub's Contents API returns 409/422 specifically for a sha mismatch (the
      // API has no typed error, only the status embedded in the message — see
      // github/provider.ts's api()). Anything else is a real failure (auth, network,
      // rate-limit) and should surface as-is, not be misreported as "someone edited it".
      const msg = (err as Error).message;
      if (/→ (409|422):/.test(msg)) throw new RoadmapConflictError();
      throw err;
    }
    return { state: "ok", path: body.path, content: body.content, source: "github" };
  }

  // ── fleet ──────────────────────────────────────────────────────────────
  async configureRunner(ws: string, input: ConfigureRunnerRequest): Promise<Agent> {
    // Validate the provider+model pairing. ADVISORY on the model: the catalog is
    // curated suggestions, not an allowlist, so any non-empty model is accepted for
    // a known provider (a just-released model works without a catalog edit); only
    // an unknown provider or an empty model is a 400 (fail() maps Error → 400).
    const invalid = modelValidForProvider(await this.store.listProviders(), input.provider, input.model);
    if (invalid) throw new Error(invalid);
    // maxRunners caps how many runners work AT ONCE, not how many may exist.
    // Blocking creation here was the wrong lever: an operator configuring a
    // fleet (a cheap-endpoint runner per vendor, a spare on a second key) is
    // not the runaway case the cap defends against — starting them all at once
    // is, and that's gated where runs are actually assigned. Fleet page shows a
    // notice when the roster is larger than the cap.
    const fleet = await this.store.listAgents(ws);
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
      label: input.label?.trim() || null, // optional grouping bucket (empty → ungrouped)
      role: "worker", // no manager provisioning exists yet — every runner is a worker
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
    // A credential must exist AND belong to this runner's provider. Without the
    // provider check you could point a Claude runner at a GitHub or Fly token,
    // which would authenticate nothing and fail only once a real run started.
    if (patch.credentialId) {
      const creds = await secretService.list(ws);
      const cred = creds.find((c) => c.id === patch.credentialId);
      if (!cred) throw new Error(`Unknown credential "${patch.credentialId}"`);
      if (cred.provider !== existing.provider) {
        throw new Error(`That credential is for ${cred.provider}, but this runner is a ${existing.provider} runner.`);
      }
    }
    // Normalize an empty/whitespace label to null so a cleared field lands in the
    // "Ungrouped" bucket rather than a phantom "" group.
    const normalized =
      patch.label !== undefined ? { ...patch, label: patch.label?.trim() || null } : patch;
    return this.hub.upsertAgent({ ...existing, ...normalized });
  }
  /** Re-pull a project's bound source. Wired onto the orchestrator as
   *  `onDriveRefill` so the driver can top a dry board back up without the
   *  orchestrator depending on this layer. */
  private async refillProjectSource(ws: string, projectId: string): Promise<void> {
    const project = await this.store.getProject(projectId).catch(() => undefined);
    if (!project?.repo || !project.syncSourceStatus) return;
    await this.importGithubIssues(ws, projectId).catch(() => undefined);
  }

  /**
   * A project has run out of startable work — propose what's next from what it
   * already knows (goal, roadmap doc, operator context, and what's already
   * done), and put those on the board.
   *
   * Created in `backlog` with `autoPick: false`. That is the safety property,
   * not a detail: auto-pick only ever starts tasks flagged `autoPick`, so
   * nothing proposed here can start itself. Without it this would be a
   * perpetual work generator — invent tasks, run them, empty the board, invent
   * more — which is the one failure mode a cost-conscious operator would never
   * forgive.
   *
   * Returns the tasks it created (empty is a perfectly good outcome — a project
   * whose direction isn't written down anywhere SHOULD produce nothing rather
   * than a plausible-sounding invented roadmap).
   */
  async replenishBacklog(ws: string, projectId: string): Promise<Task[]> {
    const project = await this.store.getProject(projectId);
    if (!project || project.workspaceId !== ws) throw new NotFoundError("Project");
    const ask = this.replenishAsk ?? ((prompt: string) => oneShotText({ prompt, model: REPLENISH_MODEL }));

    const all = (await this.store.listTasks(ws)).filter((t) => t.projectId === projectId && !t.archived);
    // Best-effort: a project with no repo (or no roadmap doc) simply grounds on
    // its goal + context instead. Never a hard failure — replenishment is
    // advisory.
    const roadmapDoc = await this.getProjectRoadmap(ws, projectId).catch(() => null);
    const roadmap = roadmapDoc && roadmapDoc.state === "ok" ? roadmapDoc.content.slice(0, 6000) : null;
    const prompt = buildReplenishPrompt({
      projectName: project.name,
      goal: project.goal,
      roadmap,
      contextSummary: project.contextSummary ?? null,
      doneTitles: all.filter((t) => t.state === "done").map((t) => t.text),
      openTitles: all.filter((t) => t.state !== "done").map((t) => t.text),
    });

    let proposed = parseProposedTasks(await ask(prompt).catch(() => ""));
    if (proposed === null) {
      // ONE retry with the failure named, same as decompose/crystallize. A
      // second unreadable reply yields nothing rather than a half-parsed guess.
      proposed = parseProposedTasks(
        await ask(`${prompt}

Your previous reply could not be parsed as the required JSON. Reply with ONLY the JSON object.`).catch(() => ""),
      );
    }
    if (!proposed?.length) return [];

    // Never re-propose something already on the board, whatever the prompt said.
    const existing = all.map((t) => t.text);
    const fresh = proposed.filter((p) => !existing.some((e) => sameTaskText(e, p.text)));

    const created: Task[] = [];
    for (const p of fresh) {
      const task = await this.createTask(ws, projectId, { text: p.text, description: p.description }).catch(() => null);
      if (task) created.push(task);
    }
    return created;
  }

  /**
   * Bench a credential: no runner authenticating with it gets new work, and
   * every run already on it is stopped and its task released back to `todo`.
   *
   * Both halves matter. Refusing new work alone would leave whatever is already
   * running to keep using a key the operator just declared unsafe — for a
   * leaking or rate-limited key that's most of the damage. And stopping runs
   * without the durable flag would just let the autonomy loop pick them straight
   * back up on the next tick.
   *
   * Order is deliberate: mark FIRST, then halt. The reverse leaves a window
   * where a freed task is re-assigned to the same key before the flag lands.
   */
  async pauseCredential(ws: string, id: string, reason: string, by: string): Promise<PauseCredentialResult> {
    const secret = await secretService.setPaused(ws, id, { by, reason }, now());
    const haltedRunIds = await this.orchestrator.haltRunsOnCredential(ws, id);
    return { secret, haltedRunIds };
  }

  /** Un-bench a credential. Also clears the in-memory quota breaker: an explicit
   *  resume is the operator saying this key is good again, so a stale
   *  auto-learned "depleted" mark must not keep refusing it. */
  async resumeCredential(ws: string, id: string, by: string): Promise<SecretMeta> {
    const secret = await secretService.setPaused(ws, id, null, now());
    this.orchestrator.clearKeyBreaker(ws, id);
    return secret;
  }

  async retireRunner(ws: string, id: string): Promise<void> {
    const existing = await this.store.getAgent(id);
    if (!existing || existing.workspaceId !== ws) throw new NotFoundError("Agent");
    // Busy-runner guard — enforced server-side (Backend Brief §04).
    if (existing.status === "busy" || this.orchestrator.isBusy(id)) throw new RunnerBusyError();
    await this.hub.deleteAgent(id);
  }
}
