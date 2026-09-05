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
  AuditRecordWithActor,
  AutonomyDetentState,
  AutonomyOverride,
  AcceptSubtaskRequest,
  BacktestRuleRequest,
  Checkpoint,
  CommandPolicy,
  ConfigureRunnerRequest,
  CreateFeatureRequest,
  CreateMilestoneRequest,
  CreateProjectContextEntryRequest,
  CreateProjectRequest,
  CreateRuleRequest,
  CreateSolutionBriefRequest,
  CreateTaskRequest,
  Decision,
  DraftCharterRequest,
  DryRunPolicyRequest,
  Feature,
  FlyDeployment,
  GenerateComplianceReportRequest,
  GithubSignalKind,
  GithubSignalPayload,
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
  Proposal,
  ProviderInfo,
  ResolveRequest,
  Resolution,
  RoadmapAstNode,
  RoadmapChecklistItemNode,
  RoadmapDoc,
  RoadmapLineClaim,
  RoadmapProposal,
  ProposeRoadmapChangeRequest,
  CommitRoadmapLineEditRequest,
  RoadmapEditResolveRequest,
  RoadmapConflictResolveRequest,
  RoadmapWorkspaceRollup,
  MemoryFactSummary,
  MemoryScope,
  CreateMemoryFactRequest,
  SourceRef,
  Rule,
  SavePolicyVersionRequest,
  Agent,
  SignedComplianceReport,
  Snapshot,
  SolutionBrief,
  StewardActionOutcome,
  StewardExecutionAction,
  Task,
  Transition,
  UpdateFeatureRequest,
  UpdateMilestoneRequest,
  UpdateProjectRequest,
  UpdateProjectRoadmapRequest,
  UpdateRunnerRequest,
  UpdateRuleRequest,
  UpdateSolutionBriefRequest,
  UpdateTaskRequest,
  UpdateWorkspaceSettingsRequest,
  PauseCredentialResult,
  SecretMeta,
} from "@skynet/shared";
import { modelValidForProvider, ProjectCharter as ProjectCharterSchema, WorkspaceSettings } from "@skynet/shared";
import { type AutonomyDetent, AUTONOMY_DETENT_COST_WEIGHT, detentFor, fieldsForDetent } from "@skynet/shared";
import { DraftTaskPayload, SuggestedRulePayload, SuggestedSubtaskPayload } from "@skynet/shared";
import { buildReplenishPrompt, parseProposedTasks } from "./steward/replenish.js";
import { DEFAULT_AUTO_MERGE_POLICY } from "./merge-policy.js";
import { projectCredential } from "./project-credential.js";
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
import { contentHash, readProjectDoc, resolveRoadmapDoc, ROADMAP_PATHS } from "./steward/docs.js";
import { parseRoadmapDoc } from "./roadmap/sync.js";
import { localRepoHeadSha } from "./roadmap/repo-commit.js";
import {
  applyRoadmapProposalDiff,
  diffRequiresHumanApproval,
  findOpenProposalForSection,
  joinProposal,
  proposalIsStale,
  proposalsConflict,
} from "./roadmap/proposals.js";
import { agentCoAuthor, AUTONOMOUS_APPLY_IDENTITY, operatorGitIdentity } from "./roadmap/attribution.js";
import { parseMemoryFile, readWorkspaceMemory, currentFacts, type MemoryFact } from "./memory-format-reader.js";
import { appendFact, newMemoryFileHeader } from "./memory-format-writer.js";
import { memoryFilePath, memorySlug } from "./memory-paths.js";
import { draftBriefFromConversation, summarizeConversation } from "./steward/crystallize.js";
import { scanRepo } from "./quality/scan.js";
import { condenseProjectContext } from "./steward/context.js";
import { prioritizeColumn, suggestAnyAgentEligible } from "./steward/organize.js";
import { extractText } from "./steward/extract.js";
import { commitLocalRepoFile, revertCommitInLocalRepo } from "./local-repo-write.js";
import { enrichRoadmapDocWithBlame } from "./roadmap/enrich.js";
import { roadmapHistory, type RoadmapHistoryEntry } from "./roadmap/history.js";
import { computeRollupRow, groupMilestones, pendingProposalCount } from "./roadmap/rollup.js";
import type { Principal } from "./auth.js";
import { projectScope } from "./mcp/project-scope.js";
import { generateSignedComplianceReport } from "./compliance/index.js";
import { classifyApprover } from "./compliance/report.js";
import type { CapturedDiff, Hub } from "./hub.js";
import { CLARIFICATION_ANSWERED_MARKER, NoCapacityError, NothingToReviewError, RunnerNotConfiguredError, TaskAlreadyAssignedError, type Orchestrator } from "./orchestrator.js";
import { resolveExecutable } from "./steward/execution.js";
import { secretService, withSecretAvailability } from "./secrets/index.js";
import { VersionConflictError, type Store } from "./store/store.js";
import type { RuleEngine } from "./rules/engine.js";
import { matchCondition, type EvalContext } from "./rules/engine.js";
import type { PendingRuleAction, PendingRuleActionStatus } from "@skynet/shared";
import { fireOnboardingMilestone, type TelemetryMilestone } from "./telemetry.js";

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

/** A RoadmapProposal isn't `open` — already resolved, or held for a human to
 *  untangle a conflict (Rule 4). 409. */
export class RoadmapProposalNotOpenError extends Error {
  constructor(state: string) {
    super(`This roadmap proposal is "${state}", not open — nothing left to apply.`);
    this.name = "RoadmapProposalNotOpenError";
  }
}

/** Rule 2: a diff that removes a line or touches a promised date can NEVER be
 *  applied without an explicit human approver — thrown by
 *  Operations.applyRoadmapProposal before it even looks at the project's
 *  autonomy detent, regardless of caller. 403. */
export class RoadmapProposalNeedsHumanApprovalError extends Error {
  constructor() {
    super("This proposal removes content or touches a promised date — it always needs an explicit human approval, at any autonomy detent.");
    this.name = "RoadmapProposalNeedsHumanApprovalError";
  }
}

/** An autonomous (no operatorId) apply attempt on a project not at the
 *  `unattended` autonomy detent — own-diff auto-merge for a roadmap proposal
 *  follows the exact same gate as an ordinary agent diff (see
 *  packages/shared/src/autonomy.ts's `ownDiffAutoMerge`). 403. */
export class RoadmapProposalAutonomyGateError extends Error {
  constructor() {
    super("This project isn't at the Unattended autonomy detent — a human must approve this roadmap proposal.");
    this.name = "RoadmapProposalAutonomyGateError";
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

/** A Proposal that's already been accepted or dismissed can't be resolved
 *  again — the SAME failure mode as re-clicking a stale HITL card. 409. */
export class ProposalAlreadyResolvedError extends Error {
  constructor(status: string) {
    super(`This proposal was already ${status} — nothing left to resolve.`);
    this.name = "ProposalAlreadyResolvedError";
  }
}

/** A command classifies as high-risk/deny and can never become a standing
 *  "approve always" rule — the same floor rememberApproval's best-effort path
 *  silently respects, surfaced loudly here since this is an explicit operator
 *  action (the Keys & Budget panel's "+ add pattern"), not a background write. 422. */
export class CommandNotRememberableError extends Error {
  constructor() {
    super("That command classifies as high-risk (or is denylisted) and can never become a standing auto-approval — it will always gate for a human.");
    this.name = "CommandNotRememberableError";
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
  /** Momentum Rollout Phase 1b — undoRuleAction delegates here. Optional so
   *  existing test fakes (which construct Operations without a RuleEngine)
   *  keep working; undoRuleAction throws a clear error if it's ever called
   *  without one wired. */
  ruleEngine?: RuleEngine;
  // Test seam, mirroring Orchestrator's providerOverride/previewOverride: the
  // one-shot consult decomposeBrief uses to turn a brief into a plan. Defaults
  // to the real oneShotText. Injectable because it's a module-level function
  // (not something reachable via an injected RunnerProvider — decomposeBrief
  // has no live run to ride a provider's own consult() on), so a deterministic
  // test needs its own seam rather than mocking the imported module.
  decomposeConsult?: (opts: { prompt: string; model: string; apiKey?: string | null; baseUrl?: string | null }) => Promise<string>;
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

/** "Has this project got a real repo bound?" — GitHub-bound OR a local
 *  checkout that's actually a git repo. Onboarding telemetry's (PMF v1.5)
 *  before/after check for the "repo connected" milestone. */
function hasRepoConnected(p: Pick<Project, "repo" | "repoPath" | "gitBacked">): boolean {
  return !!(p.repo || (p.repoPath && p.gitBacked));
}

export class Operations {
  private seq = 0;
  private readonly store: Store;
  private readonly hub: Hub;
  private readonly orchestrator: Orchestrator;
  private readonly ruleEngine?: RuleEngine;
  private readonly decomposeConsult: (opts: { prompt: string; model: string; apiKey?: string | null; baseUrl?: string | null }) => Promise<string>;
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
    this.ruleEngine = deps.ruleEngine;
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
  ): Promise<{ reply: string; actions: AssistantAction[]; projectId: string | null; sources: SourceRef[] }> {
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
      const { reply, actions, sources } = await answerProjectQuestion(this.store, { workspaceId, project, question, history });
      return { reply, actions, projectId: project.id, sources };
    }
    const { reply, actions } = await askStewardWorkspace(this.store, { workspaceId, question, history });
    return { reply, actions, projectId: null, sources: [] };
  }

  /** Streaming form of {@link stewardChat} — yields the reply as text deltas, then
   *  RETURNS the clean reply + any proposed action + the resolved project. Same
   *  focus resolution as stewardChat, so streaming and non-streaming agree. */
  async *stewardChatStream(
    workspaceId: string,
    question: string,
    history?: ChatTurn[],
    focusProjectId?: string,
  ): AsyncGenerator<string, { reply: string; actions: AssistantAction[]; projectId: string | null; sources: SourceRef[] }> {
    let project = focusProjectId ? await this.store.getProject(focusProjectId) : null;
    if (project && project.workspaceId !== workspaceId) project = null;
    if (!project) {
      const projects = await this.store.listProjects(workspaceId);
      const id = resolveFocusProject(projects.map((p) => ({ id: p.id, name: p.name })), question, history);
      project = id ? projects.find((p) => p.id === id) ?? null : null;
    }
    if (project) {
      const { reply, actions, sources } = yield* askStewardStream(this.store, { workspaceId, project, question, history });
      return { reply, actions, projectId: project.id, sources };
    }
    const { reply, actions } = yield* askStewardWorkspaceStream(this.store, { workspaceId, question, history });
    return { reply, actions, projectId: null, sources: [] };
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
    const existing = await this.getWorkspaceSettings(ws);
    const next = WorkspaceSettings.parse({ ...existing, ...patch, workspaceId: ws });
    await this.store.putWorkspaceSettings(next);
    // Onboarding telemetry (PMF v1.5) — the workspace just got its first real
    // name (onboarding's `finish()` step). Fire-and-forget: never block the
    // save this response actually depends on.
    if (!existing.name.trim() && next.name.trim()) void fireOnboardingMilestone(this.store, ws, "workspace_created");
    return next;
  }

  /** Onboarding telemetry (PMF v1.5) — public so callers outside this class
   *  that don't hold a Store reference (e.g. the secrets routes, which own
   *  their own specialized secrets store) can still fire a milestone through
   *  the normal Operations layering instead of reaching into `this.store`. */
  async recordTelemetryMilestone(ws: string, kind: TelemetryMilestone): Promise<void> {
    await fireOnboardingMilestone(this.store, ws, kind);
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

  /** TASK 15 — every open (unresolved) decision across every project in the
   *  workspace, joined with the project/task it belongs to and sorted by
   *  cost-of-waiting (highest first). `store.listQueue`/the bus are already
   *  workspace-scoped, not project-scoped, so this is a join + sort over data
   *  that already exists — no new storage. */
  async listDecisions(ws: string): Promise<Decision[]> {
    const [queue, tasks, projects, runs] = await Promise.all([
      this.store.listQueue(ws),
      this.store.listTasks(ws),
      this.store.listProjects(ws),
      this.store.listRuns(ws),
    ]);
    const projectById = new Map(projects.map((p) => [p.id, p]));
    const runById = new Map(runs.map((r) => [r.id, r]));
    const taskByRunId = new Map(tasks.filter((t): t is Task & { runId: string } => !!t.runId).map((t) => [t.runId, t]));
    const nowTs = now();
    const decisions: Decision[] = [];
    for (const item of queue) {
      if (item.resolution !== null) continue; // only open decisions belong on this list
      // Every OTHER kind has a real run behind it (HitlItem.runId is
      // required, never null) — a `roadmap_edit` item is the one exception
      // (TASK 30: no TaskRun behind a roadmap proposal), resolved via its
      // own `projectId` instead of through a run. Skip defensively rather
      // than throw if the run/project a normal item pointed to was since
      // deleted, so one dangling item can't 500 the list.
      const run = runById.get(item.runId);
      const project = item.kind === "roadmap_edit" && item.projectId ? projectById.get(item.projectId) : run ? projectById.get(run.projectId) : undefined;
      if (!project) continue;
      if (item.kind !== "roadmap_edit" && !run) continue;
      // TASK 19 — weight by the project's composed autonomy detent: a
      // higher notch means less human attention is already in the loop, so
      // an open decision idling there costs more, not less.
      const weight = AUTONOMY_DETENT_COST_WEIGHT[detentFor(project)];
      decisions.push({
        ...item,
        projectId: project.id,
        projectName: project.name,
        taskTitle: run ? (taskByRunId.get(item.runId)?.text ?? null) : null,
        costOfWaiting: (nowTs - item.raisedAt) * weight,
      });
    }
    decisions.sort((a, b) => b.costOfWaiting - a.costOfWaiting);
    return decisions;
  }

  /** Every provider key currently out of credits/quota for the workspace — the
   *  fleet-level banner's one source, distinct from the per-run billing
   *  escalation each affected run still separately raises (Orchestrator.
   *  tripKeyBreaker). Thin passthrough; the breaker state lives on the
   *  Orchestrator (in-memory, per-process — same footing as the autonomy
   *  streak counter before TASK 19 made it durable). */
  listDepletedKeys(ws: string): { credentialId: string; reason: string; at: number }[] {
    return this.orchestrator.listDepletedKeys(ws);
  }

  /** Remote kill switch, exposed to the web app (Telegram's `/stop` already
   *  called `orchestrator.stopAll` directly — this is the same call, reached
   *  from the command palette's "Pause the whole fleet" action instead of a
   *  chat command). Genuinely global (every workspace, per `stopAll`'s own
   *  doc comment) — pauses autonomy AND halts every in-flight run. Returns
   *  how many runs were actually stopped. */
  async stopAllRuns(operatorId: string): Promise<number> {
    return this.orchestrator.stopAll(`command palette — ${operatorId}`);
  }

  /** Fetch ONE HITL item scoped to the workspace, or throw NotFoundError (404)
   *  — the full-record counterpart to a summarized queue listing (the MCP
   *  list_hitl → get_hitl drill-in). */
  async getHitl(ws: string, hitlId: string): Promise<HitlItem> {
    const item = await this.store.getHitl(hitlId);
    if (!item || item.workspaceId !== ws) throw new NotFoundError("HITL item");
    return item;
  }
  /** GET /api/audit's rows — the stored trail plus `actorType` (TASK 21),
   *  computed at response time via classifyApprover (compliance/report.ts) —
   *  the SAME classifier the evidence pack uses, not a second one. Joins in
   *  each record's task (by runId) so an "autonomy" operatorId resolves to
   *  the real reviewing agent/reason, same as classifyApprover already does
   *  for the compliance report. */
  async listAudit(ws: string): Promise<AuditRecordWithActor[]> {
    const [records, tasks] = await Promise.all([this.store.listAudit(ws), this.store.listTasks(ws)]);
    const taskByRunId = new Map(tasks.filter((t) => t.runId).map((t) => [t.runId as string, t]));
    return records.map((r) => ({ ...r, actorType: classifyApprover(r.operatorId, taskByRunId.get(r.runId)).approverType }));
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
    // TASK 30 — a roadmap_edit gate has no live agent/run behind it, so it
    // never goes through orchestrator.deliver() (which assumes one) — this
    // branches off before any of that machinery, straight to the real
    // commit path (Operations.applyRoadmapProposal). A held_conflict pair's
    // richer choose/write_own actions don't fit ResolveRequest's shape at
    // all — those go through the dedicated resolveRoadmapConflict instead,
    // never here (see the web card's/Telegram's own action wiring).
    if (item.kind === "roadmap_edit") {
      if (input.action !== "approve" && input.action !== "reject") {
        throw new Error(
          `A roadmap proposal can only be approved or rejected here (got "${input.action}") — a held_conflict pair resolves via a different action.`,
        );
      }
      return await this.resolveRoadmapEditHitl(ws, item, input.action, operatorId);
    }
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
    // No projectId yet — a charter is drafted BEFORE the project exists, so the
    // workspace default is the only correct answer here. Routed through the
    // shared helper anyway, so this reads as a deliberate fallback rather than
    // one more stray hardcode.
    const { apiKey } = await projectCredential(this.store, ws, null, ASSISTANT_MODEL);
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
      // Evidence-gated auto-merge starts OFF — see Project.autoMerge.
      autoMerge: DEFAULT_AUTO_MERGE_POLICY,
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
      // No standing "always gate" overrides at creation — set later. See
      // Project.alwaysGateCommands.
      alwaysGateCommands: [],
      // "Boundaries set once" default for a NEW automation rule's safety
      // rails — set later. See Project.ruleSafetyDefaults.
      ruleSafetyDefaults: { announceBeforeActing: true, undoWindowMin: 10, pauseAfterUndos: 3, excludePriorities: [] },
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
      // TASK 14 (Phase 11) — the new board is now the default for every
      // freshly-created project (see Project.newBoardEnabled's own comment
      // for the documented rollout/removal criteria). Still per-project, not
      // global: an operator can flip it off in settings for a project that
      // genuinely needs the old board, and every EXISTING project keeps
      // whatever value it already had — this only changes what a NEW project
      // starts with.
      newBoardEnabled: true,
      queuedWipLimit: null,
    };
    const created = await this.hub.upsertProject(project);
    // A brand-new workspace's first-ever project isn't covered by the rule
    // engine's boot-time scan (RuleEngine.start() only saw whatever projects
    // already existed at server start) — without this, that workspace's
    // rules/proposals/transitions would silently never react to anything
    // until the next restart. Safe no-op if already subscribed.
    this.ruleEngine?.ensureSubscribed(ws);
    this.maybeAutoClone(ws, created);
    this.maybeAutoImportIssues(ws, created, input.importGithubIssues);
    // Onboarding telemetry (PMF v1.5) — bound to a repo right at creation
    // (GitHub-bound, an existing local git checkout, or a freshly created repo).
    if (hasRepoConnected(created)) void fireOnboardingMilestone(this.store, ws, "repo_connected");
    return created;
  }
  async updateProject(ws: string, id: string, patch: UpdateProjectRequest, operatorId: string): Promise<Project> {
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
    // already-tripped persisted breaker could re-trip on the very next bad
    // outcome instead of giving the project a clean run. Also cancels any
    // pending override (see Orchestrator.clearAutonomyBreaker) — a fresh
    // manual "on" decision supersedes an earlier bypass either way.
    if (patch.autonomy === true) await this.orchestrator.resetAutonomyStreak(updated, operatorId);
    // Onboarding telemetry (PMF v1.5) — the project just gained a repo it
    // didn't have before (binding an existing local folder, or pointing at a
    // GitHub repo after creation).
    if (!hasRepoConnected(existing) && hasRepoConnected(updated)) void fireOnboardingMilestone(this.store, ws, "repo_connected");
    return updated;
  }
  /** TASK 19 — the composite autonomy dial: notch + underlying fields +
   *  persisted breaker/override, everything the dial + breaker panel render
   *  in one round trip. */
  async getAutonomyDetent(ws: string, id: string): Promise<AutonomyDetentState> {
    const project = await this.store.getProject(id);
    if (!project || project.workspaceId !== ws) throw new NotFoundError("Project");
    const [breaker, override] = await Promise.all([
      this.store.getAutonomyBreaker(id),
      this.store.getAutonomyOverride(id),
    ]);
    return {
      detent: detentFor(project),
      autonomy: project.autonomy,
      approvalLevel: project.approvalLevel,
      maxConsecutiveFailures: config.autonomyMaxConsecutiveFailures,
      breaker: breaker ?? null,
      override: override ?? null,
    };
  }

  /** Set the dial to a target notch — atomically writes both underlying
   *  fields (see fieldsForDetent) through the same path a manual PATCH does,
   *  so it gets the same streak-reset-on-re-enable + override-cancel
   *  behavior for free (see updateProject). */
  async setAutonomyDetent(ws: string, id: string, detent: AutonomyDetent, operatorId: string): Promise<Project> {
    return this.updateProject(ws, id, fieldsForDetent(detent), operatorId);
  }

  /** The project's local merge queue (Review & Merge, Phase 15) — see
   *  Orchestrator.mergeQueueSnapshot's own doc comment. Empty array (not an
   *  error) for a project with no local git backend. */
  async getMergeQueue(ws: string, id: string): Promise<Array<{ runId: string; position: number; mode: "human" | "auto"; reason: string | null }>> {
    const project = await this.store.getProject(id);
    if (!project || project.workspaceId !== ws) throw new NotFoundError("Project");
    return this.orchestrator.mergeQueueSnapshot(project);
  }

  /** "OVERRIDE — I'LL WATCH IT": a temporary manual bypass of a tripped
   *  breaker. Turns autonomy back on immediately; sweepAutonomyOverrides
   *  (orchestrator.ts) reverts it at expiry unless a real lift already
   *  cleared the breaker by then. */
  async createAutonomyOverride(ws: string, id: string, operatorId: string): Promise<AutonomyOverride> {
    const project = await this.store.getProject(id);
    if (!project || project.workspaceId !== ws) throw new NotFoundError("Project");
    const at = now();
    const override: AutonomyOverride = {
      projectId: id,
      overriddenBy: operatorId,
      overriddenAt: at,
      expiresAt: at + config.autonomyOverrideDurationMs,
    };
    await this.hub.putAutonomyOverride(ws, override);
    if (!project.autonomy) await this.hub.upsertProject({ ...project, autonomy: true });
    await this.store
      .recordAudit({
        workspaceId: ws,
        hitlId: this.uid("q-autonomy-override"),
        runId: "none",
        action: "autonomy-override-created",
        operatorId,
        at,
        payload: { expiresAt: override.expiresAt },
      })
      .catch(() => undefined);
    return override;
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
   * Add a standing "approve always" rule directly (the Keys & Budget panel's
   * "+ add pattern" — not the HITL "remember" checkbox, see rememberApproval,
   * though both read/write the identical `Project.approvalRules` field, so a
   * pattern added either way shows up in both places with no reload). The
   * risk cap is DERIVED from the live classifier (rememberableRisk), never
   * client-supplied. Throws (rather than rememberApproval's silent no-op)
   * since this is an explicit operator action, not a best-effort background
   * write — the operator should know immediately if what they typed can
   * never be remembered. Idempotent: re-adding an already-standing command
   * is a no-op, not a duplicate row.
   */
  async addApprovalRule(ws: string, id: string, command: string, operatorId: string): Promise<Project> {
    const existing = await this.store.getProject(id);
    if (!existing || existing.workspaceId !== ws) throw new NotFoundError("Project");
    const cap = rememberableRisk(command, await resolveActivePolicy(this.store, ws));
    if (!cap) throw new CommandNotRememberableError();
    const norm = normalizeCommand(command);
    if (existing.approvalRules.some((r) => normalizeCommand(r.command) === norm)) return existing; // already standing
    const rule = { id: this.uid("ar"), command: norm, riskCap: cap, createdBy: operatorId, createdAt: now() };
    return this.hub.upsertProject({ ...existing, approvalRules: [...existing.approvalRules, rule] });
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
    const allWsTasks = await this.store.listTasks(ws);
    const inProject = allWsTasks.filter((t) => t.projectId === projectId);
    const task: Task = {
      id: this.uid(`t-${this.slug(project.name)}`),
      workspaceId: ws,
      projectId,
      version: 1,
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
      // No subtask relation at creation, UNLESS this task is being created AS
      // a subtask (see CreateTaskRequest.parentTaskId's own comment) — the
      // ordinary case still sets this later, if ever, via updateTask.
      parentTaskId: input.parentTaskId ?? null,
      priority: null,
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
    // Onboarding telemetry (PMF v1.5) — `allWsTasks` was read before this task
    // was appended, so length 0 means this is the workspace's first-ever task
    // (whether typed by hand or the first row of a bulk import — either way
    // it's genuinely the first thing this workspace ever had to work on).
    if (allWsTasks.length === 0) void fireOnboardingMilestone(this.store, ws, "first_task_created");
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
    // The task may have been edited again (or deleted) while the consult was
    // in flight — only apply the result if it still matches what was linted,
    // else a stale verdict would clobber a fresher edit's own (pending) lint.
    // Re-checked against the truly-current value at write time, not a
    // separate pre-write read (see Hub.patchTask).
    await this.hub.patchTask(task.id, (t) =>
      t.workspaceId === ws && t.text === task.text && t.description === task.description
        ? { lint: { concerns, at: now(), dismissed: false } }
        : null,
    );
  }
  /** Dismiss the current lint hint on a task — the operator has seen it and
   *  is setting it aside. A no-op if the task has no active lint result. */
  async dismissTaskLint(ws: string, tid: string): Promise<Task> {
    const task = await this.store.getTask(tid);
    if (!task || task.workspaceId !== ws) throw new NotFoundError("Task");
    if (!task.lint) return task;
    const updated = await this.hub.patchTask(tid, (t) => (t.lint ? { lint: { ...t.lint, dismissed: true } } : null));
    return updated ?? task;
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
    // Guard re-checked against the truly-current value at write time: if a
    // concurrent write already cleared `clarification` (e.g. a re-triage
    // landed first), silently overwriting it here would be exactly the
    // lost-update race this task exists to close — surface it instead.
    const updated = await this.hub.patchTask(tid, (t) =>
      t.clarification ? { description: `${t.description?.trim() ?? ""}${block}`.trim(), clarification: null, state: "backlog" } : null,
    );
    if (!updated) throw new VersionConflictError("task", tid);
    return updated;
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

  /**
   * Momentum Rollout, phase 1a: resolve an already-parsed PR/review/check/
   * deploy webhook signal (github/webhook.ts's `parseGithubSignal`) to the
   * task it's about and publish it onto that task's workspace bus. This
   * phase's job stops at verify → parse → resolve → publish — TASK 02's rule
   * engine subscribes to `github.signal` and is the one that turns it into a
   * persisted Transition; nothing here writes one.
   *
   * No workspace context arrives with a webhook (same shape as
   * handleGithubIssueEvent above), so resolution fans out:
   *   - PR-keyed signals (pull_request, pull_request_review, a check_run with
   *     a linked PR) look up the TaskRun whose OWN `pr.repo`+`pr.number`
   *     matches — that linkage is already established the moment a run's
   *     diff is approved and its PR opens (TaskRun.pr), so this reuses it
   *     rather than inventing a second one.
   *   - deployment_status carries no PR number, only a ref — resolved by
   *     repo+branch instead (Project.repo to find candidate projects, then
   *     TaskRun.branch within them).
   * A signal that can't be resolved to a task (a PR/branch Skynet never
   * opened, or the owning task's run was later detached) is a silent no-op —
   * the caller acks 202 either way, matching the route's "never error a
   * webhook GitHub might disable" contract.
   */
  async publishGithubSignal(input: {
    repo: string;
    kind: GithubSignalKind;
    payload: GithubSignalPayload;
    prNumber?: number;
    branch?: string;
  }): Promise<{ published: boolean }> {
    let run: TaskRun | undefined;
    if (input.prNumber != null) {
      run = (await this.store.listAllRuns()).find((r) => r.pr?.repo === input.repo && r.pr.number === input.prNumber);
    } else if (input.branch != null) {
      const projects = (await this.store.listAllProjects()).filter((p) => p.repo === input.repo);
      for (const project of projects) {
        run = (await this.store.listRuns(project.workspaceId)).find((r) => r.projectId === project.id && r.branch === input.branch);
        if (run) break;
      }
    }
    if (!run) return { published: false };
    const task = (await this.store.listTasks(run.workspaceId)).find((t) => t.runId === run!.id);
    if (!task) return { published: false };
    this.hub.publishGithubSignal(run.workspaceId, task.id, input.kind, input.payload);
    return { published: true };
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
        await this.updateTask(ws, linked.id, { text: iss.title, description: wantDescription }, { skipRelint: true })
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

  async updateTask(
    ws: string,
    tid: string,
    patch: UpdateTaskRequest,
    // Internal (not exposed through the API body): resyncProjectSource's
    // drift pass sets skipRelint because the new text is GitHub's, not a
    // human's — same reasoning as createTask's import skip above, and the
    // same bulk path behind the 2026-08-27 lint-fan-out incident. A stale
    // lint is still cleared; it just isn't re-run.
    opts?: { skipRelint?: boolean },
  ): Promise<Task> {
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
    //
    // Both derivations below read off `current`, not the `task` fetched at
    // the top of this function — deliberately, so a version-conflict retry
    // (see Hub.patchTask) re-derives them against whatever's ACTUALLY current
    // rather than reapplying a decision made against a snapshot that's since
    // gone stale. `relintApplied` is a closure var precisely so the final
    // (successful) attempt's answer is what drives the background lint kick
    // below, not whichever attempt happened to run first.
    let relintApplied = false;
    const updated = await this.hub.patchTask(tid, (current) => {
      const settingEligibility =
        patch.assignment && patch.assignment.mode !== "unassigned" && current.assignment.mode === "unassigned";
      const autoPickPatch: Pick<Task, "autoPick"> | Record<string, never> =
        settingEligibility && patch.autoPick === undefined ? { autoPick: true } : {};
      // Editing the text or description invalidates any existing lint result —
      // clear it immediately (so a stale hint doesn't linger against new text)
      // and kick a fresh background check.
      relintApplied =
        (patch.text !== undefined && patch.text !== current.text) ||
        (patch.description !== undefined && patch.description !== current.description);
      return { ...patch, ...autoPickPatch, ...(relintApplied ? { lint: null } : {}) };
    });
    if (!updated) throw new NotFoundError("Task");
    if (relintApplied && !opts?.skipRelint) this.maybeLintTask(ws, updated);
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
      if (rank(backlog[i]!) !== i) await this.hub.patchTask(backlog[i]!.id, { order: i });
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
      if (rank(list[i]!) !== i) await this.hub.patchTask(list[i]!.id, { order: i });
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
      this.askForProject(ws, projectId);
    // Skip the (doomed) call when we already know no key resolves — same
    // structural guard as refreshProjectContext, not reply-content sniffing.
    const canAsk = !!this.organizeAsk || !!(await projectCredential(this.store, ws, projectId, ASSISTANT_MODEL)).apiKey;

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
            await this.hub.patchTask(task.id, { order: i });
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
            await this.hub.patchTask(task.id, { assignment: { mode: "any", agentIds: [] } });
            assigned++;
          }
        }
      }
    }

    let archived = 0;
    for (const task of all.filter((t) => t.state === "done")) {
      await this.hub.patchTask(task.id, { archived: true });
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
    const updated = await this.hub.patchTask(tid, { archived });
    if (!updated) throw new NotFoundError("Task");
    return updated;
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
        await this.recordHumanTransition(ws, task, to, operatorId);
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
      // Kanban redesign, stage 1: retireRun is the shared "this run is over"
      // teardown — stop, retire the worktree, archive, mark terminal, and
      // dismiss every HITL gate still open for it (a diff/verifier/approval
      // gate raised while it was ongoing/review is now unanswerable — the run
      // is stopped and the task is starting fresh elsewhere, so leaving the
      // card would strand it in the Inbox pointing at dead work). `unstrand:
      // false` because THIS function already knows the operator's chosen
      // destination column (`to`, below) — which may not be `todo` (the
      // done→triage/backlog demotion case) — and writes the task itself.
      await this.orchestrator
        .retireRun(task.runId, "task moved off the run by an operator", { by: operatorId, unstrand: false })
        .catch(() => undefined);
    }

    // Plain object patch (not the guard-function form): `abandonsRun`/
    // `preserveWork` already drove real side effects above (pauseRun/
    // retireRun) — this write has to reflect that decision as made, not
    // re-derive it against whatever's current when the CAS actually lands.
    const updated = await this.hub.patchTask(tid, {
      state: to,
      // A preserved run stays linked (its runId is how a later Start finds and
      // resumes it) — only a truly abandoned run gets detached.
      ...(abandonsRun && !preserveWork ? { runId: null } : {}),
      reviewVerdict: null,
    });
    if (!updated) throw new NotFoundError("Task");

    // Sync the linked TaskRun's status to match — the "review → done" path with
    // NO open HITL falls through here without going via resolveHitl → merge
    // (which sets run.status="done"), so without this the run could stay at
    // "review"/"running" while the board shows the card in Done. Idempotent —
    // best-effort so a bus/persistence hiccup doesn't undo the transition.
    if (to === "done" && !abandonsRun && updated.runId) {
      await this.hub.runStatus(updated.runId, "done").catch(() => undefined);
    }
    await this.recordHumanTransition(ws, task, to, operatorId);
    return updated;
  }

  /** Append-only Transition record (kanban.ts) for a HUMAN-driven kanban
   *  move — transitionTask's own `task.state === to` no-op guard means this
   *  is only ever called on a genuine move. Mirrors the rule engine's own
   *  recordTransition calls (rules/engine.ts) but with `actor: "human"` and
   *  `ruleId: null`, so a project's Transition feed — and anything reading
   *  it (the Momentum Board's automation pill "% touched by hand", a task's
   *  own trail) — actually reflects human moves, not just rule/orchestrator
   *  ones. Best-effort: never blocks the move itself. */
  private async recordHumanTransition(ws: string, task: Task, to: Task["state"], operatorId: string): Promise<void> {
    await this.hub
      .recordTransition({
        id: this.uid("tr"),
        workspaceId: ws,
        projectId: task.projectId,
        taskId: task.id,
        from: task.state,
        to,
        actor: "human",
        actorId: operatorId,
        ruleId: null,
        evidence: [],
        at: now(),
      })
      .catch(() => undefined);
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
    opts: { dryRun?: boolean; onlyIndices?: number[] } = {},
  ): Promise<StewardActionOutcome> {
    const project = await this.getProject(ws, projectId); // throws NotFoundError
    const dryRun = opts.dryRun ?? false;
    // TASK 21 — "JUST #01"-style partial acceptance: `queue_tasks`,
    // `start_feature`, and `process_backlog` each resolve a BATCH of tasks
    // and previously ran all-or-nothing (no way to act on only some of them).
    // `onlyIndices` narrows that batch, BEFORE resolveExecutable runs, to the
    // 0-indexed positions the caller picked — same ordering the caller's own
    // dry-run preview showed, so "#01" in the UI is exactly index 0 here.
    // Filtering before resolveExecutable (not after) means the excluded list
    // only ever reports on what was actually requested — an unselected item
    // is simply never considered, not misreported as "excluded".
    const onlyIndices = opts.onlyIndices;
    const pick = <T,>(items: T[]): T[] =>
      onlyIndices && onlyIndices.length > 0
        ? onlyIndices.map((i) => items[i]).filter((x): x is T => x !== undefined)
        : items;
    // `operatorId` isn't consumed yet — each started/queued task's own
    // record (its run, or its state change) is today's audit trail; kept in
    // the signature since S11/S12 (Telegram/MCP callers) already have one
    // to hand and a dedicated audit record is the natural next step.

    // Move a batch of already-resolved-ELIGIBLE tasks to todo + autoPick, and
    // fix an `unassigned` eligibility to `any` (queue_task spec). Bypasses
    // Operations.transitionTask/HUMAN_TRANSITIONS deliberately: this is a
    // SYSTEM-initiated queue, the exact same kind of write the autonomy
    // tick's own triage step already makes directly via hub.patchTask
    // (orchestrator.ts) — not a human kanban drag, which is what
    // HUMAN_TRANSITIONS' stricter gate (no direct backlog→todo) exists for.
    const queue = async (tasks: Task[]): Promise<void> => {
      if (dryRun) return;
      for (const t of tasks) {
        // `assignment` reads off `current` (the fresh read inside patchTask),
        // not the possibly-stale `t` this batch was resolved against earlier
        // in the call — several tasks queue here in sequence, so by the time
        // a later one's write lands its own snapshot may already be stale.
        await this.hub.patchTask(t.id, (current) => ({
          state: "todo",
          autoPick: true,
          assignment: current.assignment.mode === "unassigned" ? { mode: "any", agentIds: [] } : current.assignment,
        }));
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
        const taskIds = pick(action.taskIds);
        const found = taskIds
          .map((id) => all.find((t) => t.id === id && t.projectId === projectId))
          .filter((t): t is Task => !!t);
        // An id that doesn't resolve (wrong project, or doesn't exist) never
        // silently drops — reported the same way an in-scope but unstartable
        // task is, so the caller's count always adds up.
        const unknown = taskIds.filter((id) => !found.some((t) => t.id === id));
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
        const tasks = pick(all.filter((t) => t.featureId === feature.id));
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
        const tasks = pick(
          all.filter((t) => t.projectId === projectId && (t.state === "backlog" || t.state === "triage" || t.state === "todo")),
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
    const updated = await this.hub.patchTask(tid, { state: "done", reviewVerdict: null });
    if (!updated) throw new NotFoundError("Task");
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

  /** Momentum Rollout Phase 1b — cancel a rule engine action within its
   *  undo window: a still-pending (announce-before-acting) action simply
   *  never applies; a just-finalized one has its task move reverted.
   *  Either way bumps the rule's undo count and may auto-pause it. Throws
   *  NotFoundError (workspace-scoped) or the RuleEngine's own honest reason
   *  (already undone / window passed). */
  async undoRuleAction(ws: string, pendingId: string, operatorId: string): Promise<PendingRuleAction> {
    if (!this.ruleEngine) throw new Error("The rule engine isn't enabled on this server.");
    const pending = await this.store.getPendingRuleAction(pendingId);
    if (!pending || pending.workspaceId !== ws) throw new NotFoundError("Pending rule action");
    return this.ruleEngine.undo(pendingId, operatorId);
  }

  /** Activity Feed (Phase 6b): which of a project's rule-engine actions are
   *  still cancellable — a row's "undo · Xm left" is only rendered for a
   *  FINALIZED action (it has a real Transition to show), matched back to
   *  its Transition via `PendingRuleAction.transitionId`. Workspace-scoped
   *  read, same shape as listTransitionsForProject. */
  async listPendingActionsForProject(ws: string, projectId: string, opts: { status?: PendingRuleActionStatus } = {}): Promise<PendingRuleAction[]> {
    const project = await this.store.getProject(projectId);
    if (!project || project.workspaceId !== ws) throw new NotFoundError("Project");
    return this.store.listPendingActionsForProject(projectId, opts);
  }

  /** TASK 13 hardening — the Activity Feed's "retry" action on a
   *  `status:"failed"` row. Scope-checks both the rule and task belong to
   *  this workspace before delegating to the engine (getRule/getTask already
   *  throw NotFoundError on a workspace mismatch — nothing extra needed here). */
  async retryFailedAction(ws: string, ruleId: string, taskId: string): Promise<Task> {
    if (!this.ruleEngine) throw new Error("The rule engine isn't enabled on this server.");
    await this.getRule(ws, ruleId);
    await this.getTask(ws, taskId);
    return this.ruleEngine.retryFailedAction(ruleId, taskId);
  }

  // ── rules (Momentum Rollout Phase 1c — CRUD) ─────────────────────────────
  /** Fetch one rule scoped to the workspace, or throw NotFoundError (404). */
  async getRule(ws: string, ruleId: string): Promise<Rule> {
    const rule = await this.store.getRule(ruleId);
    if (!rule || rule.workspaceId !== ws) throw new NotFoundError("Rule");
    return rule;
  }

  async listRules(ws: string, projectId: string): Promise<Rule[]> {
    await this.getProject(ws, projectId);
    return this.store.listRulesForProject(projectId);
  }

  async createRule(ws: string, projectId: string, req: CreateRuleRequest): Promise<Rule> {
    await this.getProject(ws, projectId);
    const createdAt = now();
    const state = req.state ?? "live";
    const rule: Rule = {
      id: this.uid("rule"),
      workspaceId: ws,
      projectId,
      name: req.name,
      when: req.when,
      conditions: req.conditions,
      actions: req.actions,
      safety: req.safety ?? { announceBeforeActing: true, undoWindowMin: 10, pauseAfterUndos: 3, excludePriorities: [] },
      stats: { moves: 0, undos: 0, watchMatches: 0 },
      state,
      pausedReason: null,
      createdAt,
      // TASK 10 — a rule created straight into watch starts its promotion
      // clock immediately, same as one that enters watch via updateRule.
      watchStartedAt: state === "watch" ? createdAt : null,
      updatedAt: createdAt,
      archived: false,
    };
    return this.hub.upsertRule(rule);
  }

  async updateRule(ws: string, ruleId: string, req: UpdateRuleRequest): Promise<Rule> {
    const rule = await this.getRule(ws, ruleId);
    const enteringWatch = req.state === "watch" && rule.state !== "watch";
    const leavingWatch = req.state !== undefined && req.state !== "watch" && rule.state === "watch";
    return this.hub.upsertRule({
      ...rule,
      ...(req.name !== undefined ? { name: req.name } : {}),
      ...(req.when !== undefined ? { when: req.when } : {}),
      ...(req.conditions !== undefined ? { conditions: req.conditions } : {}),
      ...(req.actions !== undefined ? { actions: req.actions } : {}),
      ...(req.safety !== undefined ? { safety: req.safety } : {}),
      // A human explicitly choosing a new state here always clears
      // `pausedReason` — that field only ever means "the auto-breaker did
      // this", per Rule's own doc comment, and a fresh human decision
      // supersedes whatever tripped it before.
      ...(req.state !== undefined ? { state: req.state, pausedReason: null } : {}),
      ...(req.archived !== undefined ? { archived: req.archived } : {}),
      // TASK 10 — restart the promotion clock on every fresh entry into
      // watch, clear it the moment the rule leaves watch either direction.
      ...(enteringWatch ? { watchStartedAt: now() } : {}),
      ...(leavingWatch ? { watchStartedAt: null } : {}),
      // Any explicit edit counts as "touched" for sweepWatchPromotion's
      // unmodified-for-a-week check — including a state-only change (an
      // operator manually flipping watch→live IS a deliberate decision, so
      // there's nothing left for the auto-promotion sweep to do anyway).
      updatedAt: now(),
    });
  }

  async deleteRule(ws: string, ruleId: string): Promise<void> {
    await this.getRule(ws, ruleId); // scope check
    await this.hub.deleteRule(ruleId);
  }

  /** Rail Graph's "pause rules" action (TASK 12, Phase 11): bulk-pauses every
   *  LIVE rule for a project in one call, rather than the client looping N
   *  individual PATCHes (N separate confirmations of the same intent, N
   *  separate live WS events for what is really one operator decision).
   *  Watch/already-paused rules are left untouched — nothing for this action
   *  to do to them. `pausedReason: null` matches updateRule's own convention:
   *  that field means "the auto-breaker did this", never a human's own
   *  explicit pause (see Rule's doc comment). Returns exactly the rules this
   *  call actually paused, so the caller can report a real count. */
  async pauseAllRules(ws: string, projectId: string): Promise<Rule[]> {
    await this.getProject(ws, projectId);
    const live = (await this.store.listRulesForProject(projectId)).filter((r) => r.state === "live");
    return Promise.all(live.map((r) => this.hub.upsertRule({ ...r, state: "paused", pausedReason: null, updatedAt: now() })));
  }

  /** Replay a DRAFT (not-yet-saved) rule's conditions against the project's
   *  historical Transition log — reuses the exact `matchCondition` the live
   *  engine dispatches through (rules/engine.ts), so this can never disagree
   *  with what the real engine would do for the same conditions. Per-task
   *  `lastSignalAt` is the previous transition on that same task (or the
   *  transition's own time, for a task's first recorded transition) — a
   *  reasonable historical stand-in for the live engine's own
   *  last-real-signal lookup, not an exact replay of it (see EvalContext's
   *  own doc comment on why `event` is always null here). */
  async backtestRule(ws: string, projectId: string, req: BacktestRuleRequest): Promise<{ wouldHaveMoved: number; sample: Transition[] }> {
    await this.getProject(ws, projectId);
    const transitions = await this.store.listTransitionsForProject(projectId);
    const tasks = await this.store.listTasks(ws);
    const taskById = new Map(tasks.map((t) => [t.id, t]));
    const chronological = [...transitions].sort((a, b) => a.at - b.at);
    const lastSeenByTask = new Map<string, number>();
    const matched: Transition[] = [];
    for (const t of chronological) {
      const lastSignalAt = lastSeenByTask.get(t.taskId) ?? t.at;
      lastSeenByTask.set(t.taskId, t.at);
      const task = taskById.get(t.taskId);
      if (!task) continue; // task since deleted — nothing left to evaluate against
      const ctx: EvalContext = { task: { ...task, state: t.to }, event: null, now: t.at, lastSignalAt };
      if (req.conditions.every((c) => matchCondition(c, ctx))) matched.push(t);
    }
    matched.reverse(); // newest-first, matching listTransitionsForProject's own convention
    return { wouldHaveMoved: matched.length, sample: matched.slice(0, 20) };
  }

  // ── transitions (Momentum Rollout Phase 1c — read) ───────────────────────
  async listTransitionsForTask(ws: string, taskId: string): Promise<Transition[]> {
    await this.getTask(ws, taskId);
    return this.store.listTransitionsForTask(taskId);
  }

  async listTransitionsForProject(ws: string, projectId: string, opts: { since?: number; limit?: number } = {}): Promise<Transition[]> {
    await this.getProject(ws, projectId);
    return this.store.listTransitionsForProject(projectId, opts);
  }

  /** Momentum Rollout Phase 22 (Home rebuild) — the cross-project read a
   *  per-project page has no need for (BoardHealth fetches per-project via
   *  listTransitionsForProject above); Home's automation-rate/stalled-count
   *  stats need the workspace's FULL transition history, not one project's. */
  async listTransitionsForWorkspace(ws: string, opts: { since?: number; limit?: number } = {}): Promise<Transition[]> {
    return this.store.listTransitionsForWorkspace(ws, opts);
  }

  // ── proposals (Momentum Rollout Phase 1c — accept / dismiss) ────────────
  /** Fetch one proposal scoped to the workspace, or throw NotFoundError (404). */
  async getProposal(ws: string, proposalId: string): Promise<Proposal> {
    const proposal = await this.store.getProposal(proposalId);
    if (!proposal || proposal.workspaceId !== ws) throw new NotFoundError("Proposal");
    return proposal;
  }

  /** `opts.activate` only matters for a `suggested_rule` proposal (every
   *  other kind ignores it): true is the pattern-onboarding card's "TURN IT
   *  ON" action — creates the Rule straight into `state:"live"` instead of
   *  the default `"watch"` (the onboarding card's "WATCH FIRST" action is
   *  just a plain accept, `activate` omitted/false). Defaulting to false
   *  keeps every existing caller's behavior — including SuggestedRulePayload's
   *  own doc comment ("watch, never live") — unchanged. */
  async acceptProposal(ws: string, projectId: string, proposalId: string, opts: { activate?: boolean } = {}): Promise<Proposal> {
    const proposal = await this.getProposal(ws, proposalId);
    if (proposal.projectId !== projectId) throw new NotFoundError("Proposal");
    if (proposal.status !== "pending") throw new ProposalAlreadyResolvedError(proposal.status);
    const { proposal: resolved } = await this.applyProposalAccept(proposal, opts);
    return resolved;
  }

  async dismissProposal(ws: string, projectId: string, proposalId: string): Promise<Proposal> {
    const proposal = await this.getProposal(ws, proposalId);
    if (proposal.projectId !== projectId) throw new NotFoundError("Proposal");
    if (proposal.status !== "pending") throw new ProposalAlreadyResolvedError(proposal.status);
    // Marked dismissed, never deleted — for a suggested_rule specifically,
    // this dismissed row is what a future pattern-detector should check
    // before re-proposing the same rule (see ProposalKind's own doc
    // comment). Every other kind gets identical treatment for consistency,
    // not because anything reads it back yet.
    return this.hub.upsertProposal({ ...proposal, status: "dismissed", resolvedAt: now() });
  }

  /** The kind-specific "implied action" behind accepting a Proposal — the
   *  ONE place that logic lives, shared by acceptProposal and the
   *  subtask-specific accept/accept-all below. Always marks the proposal
   *  accepted; returns whichever new entity (if any) it created so callers
   *  that care (acceptSubtask) can hand it back. */
  private async applyProposalAccept(proposal: Proposal, opts: { activate?: boolean } = {}): Promise<{ proposal: Proposal; task?: Task; rule?: Rule }> {
    let task: Task | undefined;
    let rule: Rule | undefined;
    switch (proposal.kind) {
      case "draft_task": {
        const parsed = DraftTaskPayload.safeParse(proposal.payload);
        if (!parsed.success) throw new Error(`This proposal's payload doesn't match the expected shape for "draft_task".`);
        task = await this.createTask(proposal.workspaceId, proposal.projectId, {
          text: parsed.data.text,
          description: parsed.data.description ?? undefined,
        });
        break;
      }
      case "suggested_subtask": {
        const parsed = SuggestedSubtaskPayload.safeParse(proposal.payload);
        if (!parsed.success) throw new Error(`This proposal's payload doesn't match the expected shape for "suggested_subtask".`);
        task = await this.createTask(proposal.workspaceId, proposal.projectId, {
          text: parsed.data.text,
          description: parsed.data.description ?? undefined,
          parentTaskId: parsed.data.parentTaskId,
        });
        break;
      }
      case "suggested_rule": {
        const parsed = SuggestedRulePayload.safeParse(proposal.payload);
        if (!parsed.success) throw new Error(`This proposal's payload doesn't match the expected shape for "suggested_rule".`);
        // Default "watch", never "live" — see SuggestedRulePayload's own doc
        // comment. `opts.activate` (TASK 10's "TURN IT ON" onboarding action)
        // is the one deliberate, explicit override of that default.
        rule = await this.createRule(proposal.workspaceId, proposal.projectId, {
          ...parsed.data,
          state: opts.activate ? "live" : "watch",
        });
        break;
      }
      case "suggested_reassignment":
      case "stall_nudge":
        // Advisory-only heads-up — nothing structural to create; accepting
        // just acknowledges the operator saw it.
        break;
    }
    const resolved = await this.hub.upsertProposal({ ...proposal, status: "accepted", resolvedAt: now() });
    return { proposal: resolved, task, rule };
  }

  // ── suggested subtasks (Momentum Rollout Phase 1c) ───────────────────────
  /** Every PENDING suggested_subtask proposal whose payload targets this
   *  parent task — the shared lookup behind both acceptSubtask (one) and
   *  acceptAllSubtasks (every). Filters in application code, not a store
   *  query, since `parentTaskId` lives inside the untyped `payload`, not a
   *  column/field the store can filter on. */
  private async pendingSubtaskProposals(projectId: string, parentTaskId: string): Promise<Proposal[]> {
    const pending = await this.store.listProposalsForProject(projectId, { status: "pending" });
    return pending.filter((p) => {
      if (p.kind !== "suggested_subtask") return false;
      const parsed = SuggestedSubtaskPayload.safeParse(p.payload);
      return parsed.success && parsed.data.parentTaskId === parentTaskId;
    });
  }

  async acceptSubtask(ws: string, taskId: string, req: AcceptSubtaskRequest): Promise<Task> {
    const parent = await this.getTask(ws, taskId);
    const candidates = await this.pendingSubtaskProposals(parent.projectId, taskId);
    const proposal = candidates.find((p) => p.id === req.proposalId);
    if (!proposal) throw new NotFoundError("Suggested subtask proposal");
    const { task } = await this.applyProposalAccept(proposal);
    return task!; // always set for a suggested_subtask accept — see applyProposalAccept
  }

  async acceptAllSubtasks(ws: string, taskId: string): Promise<Task[]> {
    const parent = await this.getTask(ws, taskId);
    const candidates = await this.pendingSubtaskProposals(parent.projectId, taskId);
    const created: Task[] = [];
    for (const proposal of candidates) {
      const { task } = await this.applyProposalAccept(proposal);
      if (task) created.push(task);
    }
    return created;
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
      color: null,
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
    for (const t of tasks) await this.hub.patchTask(t.id, { featureId: null });
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
    for (const t of tasks) await this.hub.patchTask(t.id, { milestoneId: null });
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
      this.askForProject(ws, projectId);
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

  /** A one-shot asker billed to the PROJECT's credential rather than the
   *  workspace default — see project-credential.ts. `baseUrl` rides along
   *  because a credential can name a compatible endpoint, and sending its key
   *  to Anthropic would authenticate nothing. */
  private askForProject(ws: string, projectId: string | null, model = ASSISTANT_MODEL): (prompt: string) => Promise<string> {
    return async (prompt: string) => {
      const { apiKey, baseUrl } = await projectCredential(this.store, ws, projectId, model);
      return oneShotText({ prompt, model, apiKey, baseUrl });
    };
  }

  private contextAskFn(ws: string, projectId: string | null): (prompt: string) => Promise<string> {
    return this.contextAsk ?? this.askForProject(ws, projectId);
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
    if (!this.contextAsk && !(await projectCredential(this.store, ws, projectId, ASSISTANT_MODEL)).apiKey) return project;
    const summary = await condenseProjectContext(this.contextAskFn(ws, projectId), project.name, entries);
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

    const model = process.env.SKYNET_DECOMPOSE_MODEL || "sonnet";
    const { apiKey, baseUrl } = await projectCredential(this.store, ws, projectId, model);
    const prompt = buildDecomposePrompt(brief);
    let plan: ReturnType<typeof parseDecomposition> = null;
    for (let attempt = 0; attempt < 2 && !plan; attempt++) {
      const reply = await this.decomposeConsult({ prompt, model, apiKey, baseUrl }).catch(() => "");
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
      color: null,
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
        version: 1,
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
        parentTaskId: null,
        priority: null,
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

  /**
   * TASK 27 — re-parse a project's roadmap doc and persist the result in
   * `Store.getRoadmapDoc`/`putRoadmapDoc`. Called by the GitHub push webhook
   * when a commit touches the project's roadmap path; also safe to call
   * standalone (a future manual "resync" action would just call this).
   *
   * `opts.commitSha`, when the caller already knows it (the webhook's own
   * push payload carries the new HEAD), is used directly — no extra lookup.
   * Left unset, a local `repoPath` project resolves its own HEAD via `git
   * rev-parse`; a GitHub-only project falls back to the previous cached
   * doc's commitSha (a Contents-API read has no commit sha of its own to
   * offer — see RoadmapDoc.commitSha's own doc comment).
   *
   * Writes an intermediate `repo_ahead` marker (new commitSha, syncState:
   * "repo_ahead") BEFORE the actual read+parse, so a caller checking
   * mid-flight — or a slow GitHub fetch — observes an honest "we know it
   * moved, still catching up" state instead of stale `in_sync` data. Lands on
   * `in_sync` on success, `unparseable` if the doc couldn't be read/parsed
   * (an unbound project, a missing local checkout, a GitHub auth/network
   * failure — the parser itself essentially never throws, see ast.ts's own
   * "raw span, not reconstruction" design, so this is really "couldn't even
   * fetch the content to parse").
   */
  async syncProjectRoadmap(ws: string, projectId: string, opts: { commitSha?: string } = {}): Promise<RoadmapDoc> {
    const project = await this.store.getProject(projectId);
    if (!project || project.workspaceId !== ws) throw new NotFoundError("Project");

    const previous = await this.store.getRoadmapDoc(projectId);
    const commitSha = opts.commitSha ?? (project.repoPath ? await localRepoHeadSha(project.repoPath) : (previous?.commitSha ?? null));

    const ahead: RoadmapDoc = previous
      ? { ...previous, commitSha, syncState: "repo_ahead", syncedAt: now() }
      : {
          workspaceId: ws,
          projectId,
          path: project.roadmapPath ?? ROADMAP_PATHS[0],
          commitSha,
          syncedAt: now(),
          syncState: "repo_ahead",
          raw: "",
          ast: [],
          sections: [],
        };
    await this.store.putRoadmapDoc(ahead);

    try {
      const doc = await resolveRoadmapDoc(ws, project);
      if (!doc) return await this.store.putRoadmapDoc({ ...ahead, syncState: "unparseable" });
      const parsed = parseRoadmapDoc({
        workspaceId: ws,
        projectId,
        path: doc.path,
        raw: doc.content,
        commitSha,
        syncedAt: now(),
        previousAst: previous?.ast ?? null,
      });
      const saved = await this.store.putRoadmapDoc(parsed);
      // TASK 28, Rule 3 — "the repo wins": a human's direct commit may have
      // already changed exactly what an open proposal targets. Diff every
      // open proposal against THIS fresh parse and supersede any that no
      // longer match — never applied from here on, whatever their state
      // would otherwise have let through.
      await this.supersedeStaleRoadmapProposals(projectId, saved);
      return saved;
    } catch {
      return await this.store.putRoadmapDoc({ ...ahead, syncState: "unparseable" });
    }
  }

  /** Rule 3's own half of syncProjectRoadmap — split out so it's independently
   *  callable (a future manual "resync" action, or a test) without re-running
   *  the parse itself. */
  private async supersedeStaleRoadmapProposals(projectId: string, doc: RoadmapDoc): Promise<void> {
    const open = await this.store.listRoadmapProposalsForProject(projectId, { state: "open" });
    for (const proposal of open) {
      if (proposalIsStale(proposal, doc)) {
        await this.store.putRoadmapProposal({ ...proposal, state: "superseded" });
        // TASK 30 — a human's own direct commit already overtook this;
        // whatever open roadmap_edit card was asking someone to approve it
        // must go too, or it'd sit there un-actionable forever (the repo
        // already moved on, so approving it now would throw
        // RoadmapProposalStaleError anyway).
        await this.dismissRoadmapEditHitlFor(doc.workspaceId, proposal.id, "system");
      }
    }
  }

  /**
   * TASK 27 — a GitHub `push` webhook resolved to `{repo, commitSha,
   * touchedPaths}` (github/webhook.ts's `parseGithubPush`); resyncs every
   * project bound to that repo whose roadmap doc the push actually touched.
   * Mirrors `publishGithubSignal`'s own shape (an inline parameter type, not
   * an import from webhook.ts — operations.ts never imports from the webhook
   * route file, only the other way around) and its "never error a webhook
   * GitHub might disable" contract: a repo with no bound project, or a push
   * that doesn't touch anyone's roadmap, is just an empty result, not a
   * throw. A repo can be bound by more than one project (rare, but the same
   * pattern `publishGithubSignal` already handles) — every match resyncs.
   */
  async handleGithubRoadmapPush(input: { repo: string; commitSha: string; touchedPaths: Set<string> }): Promise<{ syncedProjectIds: string[] }> {
    const projects = (await this.store.listAllProjects()).filter((p) => p.repo === input.repo);
    const syncedProjectIds: string[] = [];
    for (const project of projects) {
      // An explicit roadmapPath override is tried EXCLUSIVELY (matching
      // resolveRoadmapDoc's own contract); unset falls back to the default
      // ROADMAP_PATHS candidates.
      const touches = project.roadmapPath ? input.touchedPaths.has(project.roadmapPath) : ROADMAP_PATHS.some((p) => input.touchedPaths.has(p));
      if (!touches) continue;
      await this.syncProjectRoadmap(project.workspaceId, project.id, { commitSha: input.commitSha });
      syncedProjectIds.push(project.id);
    }
    return { syncedProjectIds };
  }

  // ── roadmap proposal governance (Phase 25 — TASK 28) ──────────────────────

  /**
   * An agent proposes a change to one roadmap section. Rule 1: a second agent
   * proposing against a section that already has an OPEN proposal joins/
   * amends it rather than creating a second row. Rule 4: if the section is
   * currently locked by a `held_conflict` proposal, the caller is simply
   * queued (`blockedAgents`) against that held proposal instead — no new
   * proposal is created while a human hasn't resolved the standing conflict.
   * Otherwise a genuinely incompatible join (Rule 4 mid-flight) forks the
   * section's existing open proposal AND this new one both into
   * `held_conflict`, cross-linked via `conflictsWith`.
   */
  async proposeRoadmapChange(ws: string, projectId: string, input: ProposeRoadmapChangeRequest): Promise<RoadmapProposal> {
    const project = await this.store.getProject(projectId);
    if (!project || project.workspaceId !== ws) throw new NotFoundError("Project");
    if (!(await this.store.getAgent(input.agentId))) throw new NotFoundError("Agent");

    const existingForProject = await this.store.listRoadmapProposalsForProject(projectId);

    // Rule 4 — the section is already locked pending a human's call. Queue
    // the agent against whichever held_conflict proposal targets it (first
    // match; a section can in principle collect more than one held pair over
    // time, but only ever one active resolution at once) rather than
    // creating anything new.
    const locked = existingForProject.find((p) => p.section === input.section && p.state === "held_conflict");
    if (locked) {
      const blockedAgents = locked.blockedAgents.includes(input.agentId) ? locked.blockedAgents : [...locked.blockedAgents, input.agentId];
      return await this.store.putRoadmapProposal({ ...locked, blockedAgents });
    }

    const incomingAsProposal: RoadmapProposal = {
      id: this.uid("rp"),
      workspaceId: ws,
      projectId,
      agentId: input.agentId,
      section: input.section,
      headline: input.headline,
      diff: input.diff,
      reasoning: input.reasoning,
      impact: input.impact ?? { tasksCreated: [], questionsResolved: [], dependencies: [] },
      respectedBoundaries: input.respectedBoundaries ?? [],
      state: "open",
      conflictsWith: [],
      createdAt: now(),
      idleMs: 0,
      blockedAgents: [],
    };

    const openExisting = findOpenProposalForSection(existingForProject, input.section);
    if (!openExisting) {
      // TASK 30 — every genuinely agent-initiated proposal (this method's
      // only caller path) becomes a governed Inbox decision. An operator's
      // OWN direct Steward-dock request never reaches this method at all —
      // it commits straight via updateProjectRoadmap, a completely separate
      // path — so no actor check is needed here: reaching this line IS the
      // "agent-initiated" signal.
      const saved = await this.store.putRoadmapProposal(incomingAsProposal);
      await this.raiseRoadmapEditHitl(saved);
      return saved;
    }

    // Rule 4 — an incompatible overlap with the section's existing open
    // proposal: a blind join would silently pick a winner, so instead BOTH
    // fork into held_conflict, cross-linked, and further agent work on the
    // section locks (Orchestrator's auto-pick checks this via
    // roadmap/proposals.js's lockedSectionIds/taskBlockedByRoadmapLock).
    if (proposalsConflict(openExisting, incomingAsProposal)) {
      const heldExisting: RoadmapProposal = { ...openExisting, state: "held_conflict", conflictsWith: [...new Set([...openExisting.conflictsWith, incomingAsProposal.id])] };
      const heldIncoming: RoadmapProposal = { ...incomingAsProposal, state: "held_conflict", conflictsWith: [...new Set([...incomingAsProposal.conflictsWith, openExisting.id])] };
      await this.store.putRoadmapProposal(heldExisting);
      const saved = await this.store.putRoadmapProposal(heldIncoming);
      // The plain "approve this" card `openExisting` already had (raised the
      // moment IT went open) no longer applies — it's now half of a
      // conflict, not a solo approve. Dismiss it and raise ONE new card for
      // the pair, anchored on the incoming side; the card renders the
      // CONFLICT variant by live-fetching this proposal and seeing
      // `state: "held_conflict"`, then follows `conflictsWith` to fetch the
      // other side too — never a second, duplicate card for the same pair.
      await this.dismissRoadmapEditHitlFor(ws, openExisting.id, "system");
      await this.raiseRoadmapEditHitl(saved);
      return saved;
    }

    // Rule 1 — compatible: join into the existing open proposal, same row.
    // No HITL change — the card already raised for `openExisting.id` stays
    // anchored on the SAME id (joinProposal never changes it) and the web
    // card live-fetches the proposal, so the merged diff/reasoning/impact
    // show up automatically without a second raise (which would just spam
    // Telegram for what the operator already has an open card for).
    const joined = joinProposal(openExisting, input);
    return await this.store.putRoadmapProposal(joined);
  }

  /**
   * Raise a fresh `roadmap_edit` HITL anchored on `proposal` — TASK 30's
   * Inbox integration. `runId` carries an inert `roadmap:<id>` placeholder
   * (see HitlItem's own doc comment on why: no TaskRun exists behind a
   * roadmap proposal) and this is NEVER routed through
   * Orchestrator.deliver() — see `resolveHitl`'s roadmap_edit branch below,
   * which resolves it directly instead. `title`/`why` are a snapshot for
   * Telegram (which can't live-fetch); the web Inbox card ignores them and
   * always fetches the live proposal by `roadmapProposalId` instead, so a
   * later Rule 1 join or Rule 3 supersede is reflected there for free.
   * `flags` carries "has_deletion" — computed once here — the one signal
   * Telegram's compact card needs to withhold its approve button for.
   * Phase 30 hardening: this used to check `diff.removed.length > 0` alone,
   * narrower than Rule 2's own real scope (diffRequiresHumanApproval also
   * blocks a diff that only ADDS a line touching a promised date — no
   * `removed` entries at all). Reused here so Telegram never shows a live
   * one-tap approve button for a diff the exact same rule would refuse to
   * auto-apply — the flag name stays "has_deletion" (Telegram-facing string,
   * not worth a wire-format churn) but its true meaning is "needs a human,
   * no shortcuts," matching diffRequiresHumanApproval exactly.
   */
  private async raiseRoadmapEditHitl(proposal: RoadmapProposal): Promise<void> {
    const needsHuman = diffRequiresHumanApproval(proposal.diff);
    await this.hub.raiseHitl({
      id: this.uid("q-roadmap"),
      workspaceId: proposal.workspaceId,
      runId: `roadmap:${proposal.id}`,
      projectId: proposal.projectId,
      roadmapProposalId: proposal.id,
      kind: "roadmap_edit",
      title: proposal.headline,
      why: proposal.reasoning,
      risk: needsHuman ? "medium" : "low",
      raisedAt: now(),
      expiresAt: null,
      resolvedAt: null,
      resolution: null,
      rationale: null,
      command: null,
      options: null,
      recommended: null,
      steps: null,
      diff: null,
      output: null,
      flags: needsHuman ? ["has_deletion"] : [],
      sourceBranchOverride: null,
    });
  }

  /**
   * Dismiss whatever still-open `roadmap_edit` HITL is anchored on
   * `proposalId` — Rule 3's supersede, or Rule 4 replacing a plain-open card
   * with a fresh conflict one, both need this so a proposal that's moved on
   * never leaves a stale, unanswerable card sitting in the Inbox pointing at
   * dead work. Same "detach → dismiss any open gate" discipline as
   * Orchestrator.retireRun; best-effort no-op when there isn't one (a
   * proposal created via a join never got its own card).
   */
  private async dismissRoadmapEditHitlFor(ws: string, proposalId: string, by: string): Promise<void> {
    const open = (await this.store.listQueue(ws)).find(
      (q) => q.kind === "roadmap_edit" && q.roadmapProposalId === proposalId && !q.resolvedAt,
    );
    if (!open) return;
    await this.hub.resolveHitl(open.id, {
      action: "dismiss",
      optionIndex: null,
      guidance: null,
      targetBranch: null,
      memoryNote: null,
      resetWork: false,
      by,
      at: now(),
    });
  }

  /**
   * Apply an approved (or auto-eligible) roadmap proposal: splices its diff
   * onto the project's CURRENT roadmap doc and commits — via whichever write
   * path the project already uses for a Steward roadmap edit
   * (commitLocalRepoFile for a `repoPath` project, githubService.commitRepoFile
   * for a GitHub-bound one) — with real attribution: the approving human (or,
   * for an eligible autonomous apply, a distinct system identity — see
   * roadmap/attribution.ts) as the commit AUTHOR, the proposing agent as a
   * `Co-authored-by:` trailer.
   *
   * `opts.operatorId` set = an explicit human approval (the API route passes
   * `req.principal!.operatorId`). Omitted = an autonomous/system attempt.
   *
   * Rule 2 is enforced FIRST, unconditionally, before this function reads
   * the project's autonomy detent AT ALL: a diff that removes a line or
   * touches a promised date throws RoadmapProposalNeedsHumanApprovalError
   * the instant `opts.operatorId` is unset, full stop — there is no detent,
   * override, or approvalLevel combination downstream of this check that can
   * still reach the auto-apply branch for such a diff. Only once that's
   * cleared does an operatorId-less call fall through to the ordinary
   * own-diff auto-merge gate (`detentFor(project) === "unattended"` — the
   * exact same notch packages/shared/src/autonomy.ts's `ownDiffAutoMerge`
   * already uses for an agent's own code diff).
   */
  /**
   * A live read of one roadmap proposal — TASK 30's Inbox/conflict card
   * NEVER trusts the snapshot fields on its own HITL item (title/why only,
   * a Telegram-only concession — see raiseRoadmapEditHitl); it fetches this
   * instead, so a Rule 1 join, Rule 3 supersede, or Rule 4 conflict that
   * happened after the card was raised is reflected the moment the operator
   * opens it, not whatever was true when the gate first fired.
   */
  async getRoadmapProposal(ws: string, projectId: string, proposalId: string): Promise<RoadmapProposal> {
    const project = await this.store.getProject(projectId);
    if (!project || project.workspaceId !== ws) throw new NotFoundError("Project");
    const proposal = await this.store.getRoadmapProposal(proposalId);
    if (!proposal || proposal.projectId !== projectId) throw new NotFoundError("Roadmap proposal");
    return proposal;
  }

  async applyRoadmapProposal(ws: string, projectId: string, proposalId: string, opts: { operatorId?: string } = {}): Promise<{ proposal: RoadmapProposal; committed: boolean; sha?: string }> {
    const project = await this.store.getProject(projectId);
    if (!project || project.workspaceId !== ws) throw new NotFoundError("Project");
    const proposal = await this.store.getRoadmapProposal(proposalId);
    if (!proposal || proposal.projectId !== projectId) throw new NotFoundError("Roadmap proposal");
    if (proposal.state !== "open") throw new RoadmapProposalNotOpenError(proposal.state);

    // Rule 2 — unconditional, checked before ANYTHING autonomy-related.
    if (diffRequiresHumanApproval(proposal.diff) && !opts.operatorId) {
      throw new RoadmapProposalNeedsHumanApprovalError();
    }
    if (!opts.operatorId && detentFor(project) !== "unattended") {
      throw new RoadmapProposalAutonomyGateError();
    }

    const agent = await this.store.getAgent(proposal.agentId);
    if (!agent) throw new NotFoundError("Agent");
    const coAuthor = agentCoAuthor(agent);
    const authorIdentity = opts.operatorId ? operatorGitIdentity(opts.operatorId) : AUTONOMOUS_APPLY_IDENTITY;
    const message = `Skynet: ${proposal.headline} (roadmap proposal ${proposal.id})`;

    if (!project.repoPath && !project.repo) throw new Error("This project has no bound repo to commit to.");
    const current = await resolveRoadmapDoc(ws, project);
    if (!current) throw new RoadmapConflictError();
    const newContent = applyRoadmapProposalDiff(current.content, proposal.diff);

    let committed: boolean;
    let sha: string | undefined;
    if (project.repoPath) {
      const result = await commitLocalRepoFile(project.repoPath, current.path, newContent, current.content, message, { ...authorIdentity, coAuthor });
      committed = result.committed;
      sha = result.sha;
    } else {
      if (!current.sha) throw new RoadmapConflictError();
      try {
        await githubService.commitRepoFile(ws, project.repo!, current.path, newContent, current.sha, message, project.githubCredentialId, { ...authorIdentity, coAuthor });
      } catch (err) {
        const msg = (err as Error).message;
        if (/→ (409|422):/.test(msg)) throw new RoadmapConflictError();
        throw err;
      }
      committed = true;
    }

    const approved = await this.store.putRoadmapProposal({ ...proposal, state: "approved" });
    return { proposal: approved, committed, sha };
  }

  /**
   * TASK 31 — commit a single-line roadmap edit directly, on the operator's
   * OWN authority (the Drift dashboard's "MOVE IT TO Q4"/"KEEP AND RE-DATE
   * Q3" actions). Reuses applyRoadmapProposal's exact diff-splice +
   * attributed-commit machinery, but writes no RoadmapProposal and needs no
   * agentId: nothing "proposed" this, the operator decided it right here —
   * the same "a human's own edit just commits" precedent
   * resolveRoadmapConflict's "write_own" action already established, not an
   * agent proposal for governance to route through the Inbox. No
   * Co-authored-by trailer either, for the same reason.
   */
  async commitRoadmapLineEdit(ws: string, projectId: string, input: CommitRoadmapLineEditRequest, operatorId: string): Promise<{ committed: boolean; sha?: string }> {
    const project = await this.store.getProject(projectId);
    if (!project || project.workspaceId !== ws) throw new NotFoundError("Project");
    if (!project.repoPath && !project.repo) throw new Error("This project has no bound repo to commit to.");

    const current = await resolveRoadmapDoc(ws, project);
    if (!current) throw new RoadmapConflictError();
    const newContent = applyRoadmapProposalDiff(current.content, input.diff);
    const authorIdentity = operatorGitIdentity(operatorId);

    if (project.repoPath) {
      return commitLocalRepoFile(project.repoPath, current.path, newContent, current.content, input.message, authorIdentity);
    }
    if (!current.sha) throw new RoadmapConflictError();
    try {
      await githubService.commitRepoFile(ws, project.repo!, current.path, newContent, current.sha, input.message, project.githubCredentialId, authorIdentity);
    } catch (err) {
      const msg = (err as Error).message;
      if (/→ (409|422):/.test(msg)) throw new RoadmapConflictError();
      throw err;
    }
    return { committed: true };
  }

  // ── roadmap doc view (Phase 26 — TASK 29) ─────────────────────────────────
  /** The parsed RoadmapDoc, real per-line git-blame provenance overlaid
   *  (local checkout only — best-effort, see enrich.ts), and any "claim as
   *  mine" overrides applied on top. Always resyncs fresh (same freshness
   *  contract getProjectRoadmap's raw-text sibling already has) rather than
   *  trusting the store's cached parse — a local SOURCE-mode save or a
   *  roadmap-proposal apply doesn't itself trigger a resync, and this is the
   *  one place that matters for line-level state to be current. */
  async getProjectRoadmapDoc(ws: string, projectId: string): Promise<RoadmapDoc> {
    const project = await this.store.getProject(projectId);
    if (!project || project.workspaceId !== ws) throw new NotFoundError("Project");
    let doc = await this.syncProjectRoadmap(ws, projectId);
    if (project.repoPath) doc = await enrichRoadmapDocWithBlame(doc, project.repoPath);

    const claims = await this.store.listRoadmapLineClaimsForProject(projectId);
    if (claims.length === 0) return doc;
    const byLineId = new Map(claims.map((c) => [c.lineId, c]));
    return {
      ...doc,
      ast: doc.ast.map((node) => {
        if (node.type !== "checklistItem") return node;
        const claim = byLineId.get(node.id);
        if (!claim) return node;
        return { ...node, claimedByHuman: true, author: claim.operatorId, authorRef: claim.operatorId };
      }),
    };
  }

  async listRoadmapProposals(ws: string, projectId: string): Promise<RoadmapProposal[]> {
    const project = await this.store.getProject(projectId);
    if (!project || project.workspaceId !== ws) throw new NotFoundError("Project");
    return this.store.listRoadmapProposalsForProject(projectId);
  }

  /** "KEEP · CLAIM AS MINE" — an operator taking display ownership of a line
   *  git-blame otherwise attributes to an agent/Skynet identity. Idempotent
   *  (a repeat claim, even by a different operator, just replaces the row) —
   *  see RoadmapLineClaim's own doc comment for why this never touches git
   *  history or blame itself, only a display-layer override. */
  async claimRoadmapLine(ws: string, projectId: string, lineId: string, operatorId: string): Promise<RoadmapLineClaim> {
    const project = await this.store.getProject(projectId);
    if (!project || project.workspaceId !== ws) throw new NotFoundError("Project");
    const doc = await this.store.getRoadmapDoc(projectId);
    const exists = doc?.ast.some((n) => n.type === "checklistItem" && n.id === lineId) ?? false;
    if (!exists) throw new NotFoundError("Roadmap line");
    const claim: RoadmapLineClaim = { id: this.uid("rlc"), workspaceId: ws, projectId, lineId, operatorId, claimedAt: now() };
    return this.store.putRoadmapLineClaim(claim);
  }

  /** "REVERT THE COMMIT" — reverts whatever commit git-blame currently
   *  attributes this line's text to. Local-repo-bound projects only: a
   *  GitHub-bound project has no local checkout to run `git revert` against
   *  (mirrors blame.ts/history.ts's own local-only contract) — throws a
   *  clear, actionable error rather than silently no-op-ing. Resyncs the
   *  doc afterward so the line's state/blame reflect the revert immediately,
   *  not on the next unrelated read. */
  async revertRoadmapLineCommit(ws: string, projectId: string, lineId: string, operatorId: string): Promise<{ committed: boolean; sha?: string }> {
    const project = await this.store.getProject(projectId);
    if (!project || project.workspaceId !== ws) throw new NotFoundError("Project");
    if (!project.repoPath) throw new Error("Reverting a roadmap line's commit needs a local checkout — this project is GitHub-bound.");
    const doc = await this.getProjectRoadmapDoc(ws, projectId);
    const isChecklistItem = (n: RoadmapAstNode): n is RoadmapChecklistItemNode => n.type === "checklistItem";
    const line = doc.ast.filter(isChecklistItem).find((n) => n.id === lineId);
    if (!line) throw new NotFoundError("Roadmap line");
    if (!line.blameSha) throw new Error("No blamed commit found for this line — nothing to revert.");
    const result = await revertCommitInLocalRepo(project.repoPath, line.blameSha, operatorGitIdentity(operatorId));
    await this.syncProjectRoadmap(ws, projectId).catch(() => undefined);
    return result;
  }

  /** HISTORY tab — real `git log` for the project's roadmap doc path.
   *  Local-repo-bound projects only, same reasoning as
   *  revertRoadmapLineCommit; an empty array (not an error) for a
   *  GitHub-bound project — there's nothing actionable to retry the way a
   *  real failure would be. */
  async getRoadmapHistory(ws: string, projectId: string, opts: { limit?: number } = {}): Promise<RoadmapHistoryEntry[]> {
    const project = await this.store.getProject(projectId);
    if (!project || project.workspaceId !== ws) throw new NotFoundError("Project");
    if (!project.repoPath) return [];
    const path = project.roadmapPath ?? ROADMAP_PATHS[0]!;
    return roadmapHistory(project.repoPath, path, opts.limit);
  }

  // ── workspace roll-up (Phase 29 — TASK 32) ────────────────────────────────
  /**
   * The one real, non-fabricated "why might this repo miss" signal available
   * TODAY, before TASK 31 ships real per-line forecasts (TASK 19's key-health
   * circuit breaker): the first PAUSED credential among the project's own
   * `enabledRunnerCredentialIds` (empty list = every workspace credential is
   * usable — same "empty = unconfined" semantics Project.enabledRunnerCredentialIds
   * already documents — so every secret is a candidate in that case). Null =
   * nothing to report, not "definitely healthy" — this rollup can't see a
   * genuine schedule slip yet, only a stalled key.
   */
  private breakerReasonFor(project: Pick<Project, "enabledRunnerCredentialIds">, secrets: SecretMeta[]): string | null {
    const candidateIds = project.enabledRunnerCredentialIds.length ? new Set(project.enabledRunnerCredentialIds) : null;
    const paused = secrets.find((s) => (candidateIds ? candidateIds.has(s.id) : true) && s.paused);
    return paused?.paused?.reason ?? null;
  }

  /**
   * "Six repos, one quarter" — a roll-up over every project the CALLER
   * already has access to, scoped by the same principal.projectIds allowlist
   * mcp/project-scope.ts enforces everywhere else (no new access-control
   * surface: an unrestricted principal — every human/workspace token today —
   * sees the whole workspace, unchanged). A project with no bound repo is
   * skipped outright (nothing to roll up); one WITH a repo but no resolved
   * roadmap file lands in `noRoadmapProjects` (the dashed row) instead of
   * `rows`. Resyncs every accessible project's doc fresh, same freshness
   * contract getProjectRoadmapDoc already has — this is a dashboard read,
   * not a hot path, so the per-project resync cost is accepted the same way
   * it already is there.
   */
  async getWorkspaceRoadmapRollup(ws: string, principal: Principal): Promise<RoadmapWorkspaceRollup> {
    const allProjects = await this.store.listProjects(ws);
    const scoped = projectScope(principal, this, ws).filterProjects(allProjects);
    const secrets = await secretService.list(ws);

    const rows: RoadmapWorkspaceRollup["rows"] = [];
    const noRoadmapProjects: RoadmapWorkspaceRollup["noRoadmapProjects"] = [];
    const forMilestones: Parameters<typeof groupMilestones>[0] = [];

    for (const project of scoped) {
      if (!project.repoPath && !project.repo) continue;
      const found = await resolveRoadmapDoc(ws, project).catch(() => null);
      if (!found) {
        noRoadmapProjects.push({ projectId: project.id, projectName: project.name });
        continue;
      }
      const doc = await this.syncProjectRoadmap(ws, project.id).catch(() => null);
      if (!doc) continue; // resync itself threw (e.g. project vanished mid-loop) — drop, don't error the whole roll-up
      const proposals = await this.store.listRoadmapProposalsForProject(project.id).catch(() => []);
      const atRiskReason = this.breakerReasonFor(project, secrets);
      rows.push(computeRollupRow(project, doc, pendingProposalCount(proposals), atRiskReason));
      forMilestones.push({ project, doc, atRiskReason });
    }

    return { rows, milestones: groupMilestones(forMilestones), noRoadmapProjects };
  }

  /**
   * "Without a file there is no roadmap — create one from the board." Writes
   * a minimal starter ROADMAP.md and points `project.roadmapPath` at it,
   * committing through TASK 28's SAME attribution path (a real operator
   * author identity, no agent Co-authored-by — nobody proposed this, the
   * operator asked for it directly) since a repo write is a repo write.
   * Refuses if a roadmap file is already resolvable — this is a CREATE, not
   * an overwrite; the operator already has the normal edit paths for that.
   */
  async scaffoldProjectRoadmap(ws: string, projectId: string, operatorId: string): Promise<RoadmapDoc> {
    const project = await this.store.getProject(projectId);
    if (!project || project.workspaceId !== ws) throw new NotFoundError("Project");
    if (!project.repoPath && !project.repo) throw new Error("This project has no bound repo to write a roadmap into.");
    const existing = await resolveRoadmapDoc(ws, project).catch(() => null);
    if (existing) throw new Error("This project already has a roadmap file.");

    const path = project.roadmapPath ?? ROADMAP_PATHS[0]!;
    const content = `# ${project.name} Roadmap\n\n## Now\n- [ ] First task\n`;
    const message = `Skynet: scaffold ${path}`;
    const identity = operatorGitIdentity(operatorId);

    if (project.repoPath) {
      await commitLocalRepoFile(project.repoPath, path, content, null, message, identity);
    } else {
      await githubService.commitRepoFile(ws, project.repo!, path, content, undefined, message, project.githubCredentialId, identity);
    }
    await this.hub.upsertProject({ ...project, roadmapPath: path });
    return this.syncProjectRoadmap(ws, projectId);
  }

  /**
   * The plain (non-conflict) roadmap_edit HITL's approve/reject — TASK 30.
   * "Approve & commit" runs the real TASK 28 attribution path
   * (applyRoadmapProposal, human-authored + agent Co-authored-by); reject
   * just marks the proposal rejected. Either way the HITL resolves via
   * Hub.resolveHitl directly — never Operations.resolveHitl's generic
   * wrapper (that's this method's OWN caller) and never
   * Orchestrator.deliver() (no live agent to deliver to).
   */
  private async resolveRoadmapEditHitl(ws: string, item: HitlItem, action: "approve" | "reject", operatorId: string): Promise<HitlItem> {
    if (!item.projectId || !item.roadmapProposalId) throw new NotFoundError("Roadmap proposal");
    if (action === "approve") {
      await this.applyRoadmapProposal(ws, item.projectId, item.roadmapProposalId, { operatorId });
    } else {
      const proposal = await this.store.getRoadmapProposal(item.roadmapProposalId);
      if (!proposal || proposal.projectId !== item.projectId) throw new NotFoundError("Roadmap proposal");
      if (proposal.state !== "open") throw new RoadmapProposalNotOpenError(proposal.state);
      await this.store.putRoadmapProposal({ ...proposal, state: "rejected" });
    }
    const resolution: Resolution = {
      action,
      optionIndex: null,
      guidance: null,
      targetBranch: null,
      memoryNote: null,
      resetWork: false,
      by: operatorId,
      at: now(),
    };
    const resolved = await this.hub.resolveHitl(item.id, resolution);
    return resolved ?? item;
  }

  /**
   * A held_conflict roadmap_edit HITL's resolution — TASK 30's conflict
   * card. "choose" applies the picked proposal's diff (flipped back to
   * "open" first: applyRoadmapProposal only accepts an open proposal, and
   * Rule 4 leaves BOTH sides `held_conflict`) and rejects the other side;
   * "write_own" rejects both, freeing the section for a human's own edit —
   * today that means the existing Steward-dock/Roadmap-tab manual-edit path
   * (updateProjectRoadmap), until TASK 29's inline SOURCE editor lands as
   * the card's real destination.
   */
  async resolveRoadmapConflict(ws: string, hitlId: string, input: RoadmapConflictResolveRequest, operatorId: string): Promise<HitlItem> {
    const item = await this.store.getHitl(hitlId);
    if (!item || item.workspaceId !== ws) throw new NotFoundError("HITL item");
    if (item.kind !== "roadmap_edit" || !item.projectId || !item.roadmapProposalId) throw new NotFoundError("Roadmap conflict");
    const anchor = await this.store.getRoadmapProposal(item.roadmapProposalId);
    if (!anchor || anchor.projectId !== item.projectId) throw new NotFoundError("Roadmap proposal");
    if (anchor.state !== "held_conflict") throw new RoadmapProposalNotOpenError(anchor.state);
    const other = anchor.conflictsWith[0] ? await this.store.getRoadmapProposal(anchor.conflictsWith[0]) : undefined;

    let action: "approve" | "reject";
    if (input.action === "write_own") {
      await this.store.putRoadmapProposal({ ...anchor, state: "rejected" });
      if (other) await this.store.putRoadmapProposal({ ...other, state: "rejected" });
      action = "reject";
    } else {
      const pair = [anchor, other].filter((p): p is RoadmapProposal => !!p);
      const chosen = pair.find((p) => p.id === input.chosenProposalId);
      if (!chosen) throw new NotFoundError("Roadmap proposal");
      const rejected = pair.find((p) => p.id !== input.chosenProposalId);
      if (rejected) await this.store.putRoadmapProposal({ ...rejected, state: "rejected" });
      await this.store.putRoadmapProposal({ ...chosen, state: "open" });
      await this.applyRoadmapProposal(ws, item.projectId, chosen.id, { operatorId });
      action = "approve";
    }

    const resolution: Resolution = {
      action,
      optionIndex: null,
      guidance: null,
      targetBranch: null,
      memoryNote: null,
      resetWork: false,
      by: operatorId,
      at: now(),
    };
    const resolved = await this.hub.resolveHitl(item.id, resolution);
    return resolved ?? item;
  }

  // ── memory v0, phase 1 (operator-authored facts) ──────────────────────────
  // docs/memory-format.md is the file format; memory-format-reader.ts parses
  // it; this is the write path (append + commit through the SAME TASK 28
  // attribution mechanism roadmap edits use — a repo write is a repo write)
  // plus the read path the Inbox/project UI lists facts from. Phase 1 is
  // operator-authored only: source is always "operator", confidence always
  // "stated" — the server sets both, never the caller (a hand-edited file can
  // already contain "decision"/"distilled" facts; this phase reads and lists
  // them like any other fact, it just never writes them itself).

  /** Turn a parsed reader-level fact into the flat wire summary, normalizing
   *  an unrecognized (hand-edited) source/confidence value to a safe default
   *  rather than erroring — matching the format's own "never error on an
   *  unrecognized value" compatibility rule. */
  private toMemoryFactSummary(f: MemoryFact, scope: MemoryScope, opts: { area?: string | null; agentFamily?: string | null }, superseded: Set<string>): MemoryFactSummary {
    const source = f.source === "operator" || f.source === "decision" || f.source === "distilled" ? f.source : "operator";
    const confidence = f.confidence === "stated" || f.confidence === "derived" || f.confidence === "distilled" ? f.confidence : "stated";
    const createdAt = Date.parse(f.created);
    return {
      id: f.id, scope, area: opts.area ?? null, agentFamily: opts.agentFamily ?? null,
      heading: f.heading, body: f.body, source, confidence, author: f.author,
      createdAt: Number.isFinite(createdAt) ? createdAt : 0,
      run: f.run ?? null, hitl: f.hitl ?? null, supersedes: f.supersedes ?? null,
      superseded: superseded.has(f.id),
    };
  }

  /**
   * Every fact this project's memory currently holds, across every scope —
   * a flat list (the UI groups by `.scope` itself) including superseded
   * facts (flagged, not hidden — the format keeps them as history).
   *
   * Full fidelity (workspace + every project/area/agent file) for a LOCAL
   * repoPath-bound project, via the existing readWorkspaceMemory — it already
   * enumerates the whole `.skynet/memory/` tree. A GitHub-only project has no
   * local checkout to enumerate directories in, so this reads just the two
   * fixed, known paths (workspace.md, projects/<slug>.md) via the same
   * generic readProjectDoc every other repo read in this codebase uses —
   * real, honest data, just missing area/agent-family facts until a
   * GitHub-directory-listing path is built. Never throws: an unbound project,
   * or one with no memory files yet, is just an empty list.
   */
  async listProjectMemory(ws: string, projectId: string): Promise<MemoryFactSummary[]> {
    const project = await this.store.getProject(projectId);
    if (!project || project.workspaceId !== ws) throw new NotFoundError("Project");
    if (!project.repoPath && !project.repo) return [];

    const out: MemoryFactSummary[] = [];
    const addFile = (raw: { facts: MemoryFact[]; frontmatter: { scope?: string; area?: string; agent_family?: string } }) => {
      const scope = (raw.frontmatter.scope === "workspace" || raw.frontmatter.scope === "project" || raw.frontmatter.scope === "area" || raw.frontmatter.scope === "agent"
        ? raw.frontmatter.scope
        : "project") as MemoryScope;
      const superseded = new Set(raw.facts.map((f) => f.supersedes).filter((id): id is string => Boolean(id)));
      for (const f of raw.facts) out.push(this.toMemoryFactSummary(f, scope, { area: raw.frontmatter.area ?? null, agentFamily: raw.frontmatter.agent_family ?? null }, superseded));
    };

    if (project.repoPath) {
      for (const file of await readWorkspaceMemory(project.repoPath)) addFile(file);
      return out;
    }
    // GitHub-only: the two fixed paths only (see doc comment above).
    const slug = memorySlug(project.name);
    for (const relPath of [memoryFilePath("workspace", slug), memoryFilePath("project", slug)]) {
      const doc = await readProjectDoc(ws, project, relPath).catch(() => null);
      if (doc) addFile(parseMemoryFile(doc.content, relPath));
    }
    return out;
  }

  /**
   * Append a new operator-authored fact and commit it — through the SAME
   * commitLocalRepoFile/githubService.commitRepoFile + operatorGitIdentity
   * path TASK 28's roadmap-proposal apply and TASK 32's scaffold already use.
   * No agent Co-authored-by trailer: nobody proposed this, the operator typed
   * it directly (mirrors scaffoldProjectRoadmap's own reasoning).
   */
  async addMemoryFact(ws: string, projectId: string, input: CreateMemoryFactRequest, operatorId: string): Promise<MemoryFactSummary> {
    const project = await this.store.getProject(projectId);
    if (!project || project.workspaceId !== ws) throw new NotFoundError("Project");
    if (!project.repoPath && !project.repo) throw new Error("This project has no bound repo to record memory in.");
    if (input.scope === "area" && !input.area) throw new Error("An area-scoped fact needs an area.");
    if (input.scope === "agent" && !input.agentFamily) throw new Error("An agent-scoped fact needs an agentFamily.");

    const slug = memorySlug(project.name);
    const areaSlug = input.area ? memorySlug(input.area) : null;
    const relPath = memoryFilePath(input.scope, slug, { areaSlug, agentFamily: input.agentFamily ?? null });

    const current = await readProjectDoc(ws, project, relPath).catch(() => null);
    const fact = {
      id: this.uid("fact"),
      heading: input.heading.trim(),
      body: input.body.trim(),
      source: "operator" as const,
      author: operatorId,
      created: new Date(now()).toISOString(),
      confidence: "stated" as const,
      supersedes: input.supersedes ?? undefined,
    };
    const header = current
      ? undefined
      : newMemoryFileHeader(input.scope, { project: input.scope === "project" || input.scope === "area" ? slug : undefined, area: input.area ?? undefined, agentFamily: input.agentFamily ?? undefined });
    const newContent = appendFact(current?.content ?? "", fact, header);
    const identity = operatorGitIdentity(operatorId);
    const message = `Skynet: record a memory fact (${input.scope}${input.area ? `/${input.area}` : input.agentFamily ? `/${input.agentFamily}` : ""})`;

    if (project.repoPath) {
      await commitLocalRepoFile(project.repoPath, relPath, newContent, current?.content ?? null, message, identity);
    } else {
      await githubService.commitRepoFile(ws, project.repo!, relPath, newContent, current?.sha, message, project.githubCredentialId, identity);
    }

    return this.toMemoryFactSummary(
      { heading: fact.heading, body: fact.body, id: fact.id, source: fact.source, author: fact.author, created: fact.created, confidence: fact.confidence, supersedes: fact.supersedes, extra: {} },
      input.scope,
      { area: input.area ?? null, agentFamily: input.agentFamily ?? null },
      new Set(),
    );
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
    const created = await this.hub.upsertAgent(runner);
    // Onboarding telemetry (PMF v1.5) — `fleet` was read before this runner
    // was added, so length 0 means this is the workspace's first-ever agent.
    if (fleet.length === 0) void fireOnboardingMilestone(this.store, ws, "runner_added");
    return created;
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
    // Passed NO key at all before, so it fell through to the ambient
    // environment and bypassed the secret store entirely — worse than using the
    // workspace default. Added in the project-driver work, after the credential
    // had already been threaded through every other site.
    const ask = this.replenishAsk ?? this.askForProject(ws, projectId, REPLENISH_MODEL);

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

  /**
   * Undo a merged run — one click, on the branch it landed on.
   *
   * This is what makes evidence-gated auto-merge tolerable: it converts
   * approval-before into review-after. If undo costs one click, most merges
   * don't need pre-clearance at all — and the ones that do can be waved through
   * knowing the tail is reversible.
   *
   * A revert COMMIT, never a history rewrite (see MergeEngine.revert): the
   * branch may already be pushed or built on. A conflicting revert is reported,
   * not forced — "this has been built on since" is a real decision for a human.
   */
  async revertRun(ws: string, runId: string, by: string): Promise<TaskRun> {
    const run = await this.store.getRun(runId);
    if (!run || run.workspaceId !== ws) throw new NotFoundError("Run");
    if (!run.merge) throw new Error("This run never merged, so there's nothing to undo.");
    if (run.merge.revertedAt) throw new Error("This merge was already reverted.");

    const project = await this.store.getProject(run.projectId);
    const revertCommit = await this.orchestrator.revertMerge(project, run.merge.commit, run.merge.branch);
    const updated = await this.hub.upsertRun({
      ...run,
      merge: { ...run.merge, revertedAt: now(), revertCommit, revertedBy: by },
    });
    await this.hub.runLog(runId, `merge reverted by ${by} — ${run.merge.commit.slice(0, 7)} undone on ${run.merge.branch} (${revertCommit.slice(0, 7)})`);
    return updated;
  }

  async retireRunner(ws: string, id: string): Promise<void> {
    const existing = await this.store.getAgent(id);
    if (!existing || existing.workspaceId !== ws) throw new NotFoundError("Agent");
    // Busy-runner guard — enforced server-side (Backend Brief §04).
    if (existing.status === "busy" || this.orchestrator.isBusy(id)) throw new RunnerBusyError();
    await this.hub.deleteAgent(id);
  }
}
