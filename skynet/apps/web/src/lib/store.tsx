import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  TaskRun,
  ApprovalLevel,
  AutonomyDetent,
  AutonomyOverride,
  Checkpoint,
  Dependency,
  Feature,
  HitlItem,
  Milestone,
  Module,
  ParallelismNudge,
  PendingRuleAction,
  Project,
  ProjectCharter,
  ProviderId,
  ProviderInfo,
  Proposal,
  ResolveAction,
  Rule,
  RuleAction,
  RuleCondition,
  RuleLifecycleState,
  RuleSafety,
  Agent,
  ServerEvent,
  Snapshot,
  SolutionBrief,
  Task,
  TaskAssignment,
  Transition,
  WorkspaceSettings,
} from "@skynet/shared";
import * as api from "./client";
import { toast } from "../components/toast";
import { notifyInbox } from "../pwa/pwa";

/** Pull the server's `{ error }` message out of an ApiError body, else fallback. */
function serverMessage(e: unknown, fallback: string): string {
  if (e instanceof api.ApiError) {
    try {
      const parsed = JSON.parse(e.message) as { error?: unknown };
      if (typeof parsed.error === "string") return parsed.error;
    } catch {
      /* body wasn't JSON — fall through */
    }
    if (e.message) return e.message;
  }
  return fallback;
}

// ─── store shape ─────────────────────────────────────────────────────────────

export interface StoreState {
  runs: TaskRun[];
  queue: HitlItem[];
  projects: Project[];
  tasks: Task[];
  features: Feature[];
  milestones: Milestone[];
  solutionBriefs: SolutionBrief[];
  fleet: Agent[];
  modules: Module[];
  deps: Dependency[];
  providers: ProviderInfo[];
  // Momentum Board (Phase 4) data — Rules/Proposals ride the Snapshot + WS
  // deltas like everything else above. Transitions don't (it's an append-only
  // feed, not current state, so Snapshot never carries a backlog of them) —
  // this only ever holds what's arrived LIVE via `transition.created` since
  // this session connected; a board fetches its own project's history over
  // REST (client.ts's fetchProjectTransitions) and merges it in locally.
  rules: Rule[];
  proposals: Proposal[];
  transitions: Transition[];
  connected: boolean;
  loaded: boolean;
  // Live socket lifecycle, so the shell can show connect→connected and a retry
  // affordance rather than a dead-end "Connecting…" message.
  wsPhase: api.WsPhase;
  // Bumps on any audit.* delta. The trail isn't held in the store (it's fetched
  // over HTTP by the Audit view), so this is the signal the view watches to
  // re-pull after an archive/delete/clear lands — from any operator or tab.
  auditRev: number;
  // Bumps on any autonomyBreaker.updated delta (TASK 19) — same reasoning as
  // auditRev: the breaker/override records aren't held in the store, so this
  // is what an open autonomy dial watches to re-pull after a trip/lift/
  // override lands, from any operator or tab.
  autonomyRev: number;
  // The server's default approval level, so the create-project form can
  // pre-select what a new project would otherwise get. Undefined until the first
  // snapshot lands (or an older server that doesn't send it).
  defaultApprovalLevel?: ApprovalLevel;
  // Live workspace settings (display name + fleet policy). Undefined until the
  // first snapshot lands (or an older server that doesn't send it) — read
  // workspaceSettings?.name, never firstrun.ts's old localStorage helper, so
  // the name is consistent across profiles/machines instead of per-browser.
  workspaceSettings?: WorkspaceSettings;
  // Live "typing" preview, keyed by runId — accumulated `run.log.delta` chunks
  // for the line currently being generated. Transient: NOT part of a TaskRun's
  // persisted `log[]`, cleared the moment the matching `run.log` lands (or the
  // run completes). A view renders `run.log` plus this tail so the log types
  // live instead of jumping in whole-message chunks.
  logDeltas: Record<string, string>;
  // "Idle runners + deep backlog → spin up more?" — a derived read, refreshed
  // whenever a snapshot lands (not on every live delta; it's a light hint, not
  // a real-time gate). Undefined until the first snapshot lands (or an older
  // server that doesn't send it).
  parallelismNudge?: ParallelismNudge;
  // A viewer-role session (read-only — see auth/operators.ts's role concept).
  // Undefined until GET /api/auth/me resolves at boot; the client-side mutation
  // guard (client.ts's req()) is the enforcement, this is just for UI greying.
  readOnly?: boolean;
  // Time-limited admin promotion (ROADMAP.md) — set while an elevation window
  // is live on this session (null otherwise). Drives the countdown + the
  // auto-revert timer below; `readOnly` itself already reflects the elevated
  // state (the server resolves an elevated principal with scopes: undefined),
  // this is only for the UI to show/count down/proactively re-check.
  elevatedUntil?: number | null;
}

export interface Store extends StoreState {
  // mutations — call the API, let the echoed WS delta update state
  resolveHitl: (
    id: string,
    action: ResolveAction,
    extra?: { optionIndex?: number; guidance?: string; remember?: boolean; targetBranch?: string; memoryNote?: string; resetWork?: boolean },
  ) => Promise<void>;
  // Gate batching — resolve several open decisions in one call. Returns what
  // actually happened (never throws for a partial batch) so the Inbox can
  // tell the operator if some of the N didn't go through.
  resolveHitlBatch: (
    ids: string[],
    action: ResolveAction,
    extra?: { optionIndex?: number; guidance?: string; remember?: boolean; targetBranch?: string; memoryNote?: string; resetWork?: boolean },
  ) => Promise<{ resolved: HitlItem[]; skipped: Array<{ id: string; reason: string }> }>;
  sendAgentMessage: (id: string, text: string) => Promise<string>;
  streamAgentMessage: (id: string, text: string, onDelta: (chunk: string) => void) => Promise<string>;
  // `inform` — mass-select runs (explicit ids and/or a whole project's live
  // runs) + a note that rides each one's next prompt, no extra turn.
  informRuns: (body: {
    note: string;
    runIds?: string[];
    projectId?: string;
  }) => Promise<{ informed: string[]; skipped: Array<{ runId: string; reason: string }> }>;
  forkAgent: (id: string) => Promise<void>;
  // Checkpoint / restore (extends fork/resume, W6). Checkpoints aren't part of
  // the WS-synced snapshot (per-run, lazily fetched like a diff) — create/
  // restore return their result directly rather than relying on an echoed delta.
  createCheckpoint: (id: string, label?: string) => Promise<Checkpoint | null>;
  restoreCheckpoint: (id: string, checkpointId: string) => Promise<void>;
  archiveAgent: (id: string, archived: boolean) => Promise<void>;
  pauseAgent: (id: string) => Promise<void>;
  resumeAgent: (id: string) => Promise<void>;
  stopAgent: (id: string) => Promise<void>;
  mergePr: (runId: string, method?: "merge" | "squash" | "rebase") => Promise<{ merged: boolean; reason?: string; blocked?: "conflict" | "checks" | "protection" }>;
  updatePrBranch: (runId: string) => Promise<{ updated: boolean; conflicts?: string[] }>;
  reworkPr: (runId: string, guidance: string, comment?: string) => Promise<void>;
  dismissPr: (runId: string) => Promise<void>;
  // Feature-scoped branch batching's aggregate PR — merge/dismiss only.
  mergeFeaturePr: (featureId: string, method?: "merge" | "squash" | "rebase") => Promise<{ merged: boolean; reason?: string; blocked?: "conflict" | "checks" | "protection" }>;
  dismissFeaturePr: (featureId: string) => Promise<void>;
  // Local optimistic flip after a key is set/cleared in Settings (the snapshot
  // recomputes availability from the secret store on next load).
  setProviderAvailable: (id: string, available: boolean) => void;
  createProject: (
    name: string,
    goal: string,
    opts?: {
      repo?: string;
      repoPath?: string;
      createRepo?: { name: string; private: boolean; owner?: string };
      autonomy?: boolean;
      approvalLevel?: string;
      instructions?: string;
      importGithubIssues?: boolean;
      charter?: ProjectCharter;
      githubCredentialId?: string;
    },
  ) => Promise<Project>;
  updateProject: (
    id: string,
    patch: {
      name?: string;
      goal?: string;
      status?: string;
      autonomy?: boolean;
      // A daily USD ceiling on known spend; null clears back to "no limit".
      dailyBudgetUsd?: number | null;
      // Spread the daily budget across a working window instead of committing
      // it all in the first tick. Ignored unless dailyBudgetUsd is also set.
      budgetPacing?: boolean;
      approvalLevel?: string;
      planModeGate?: boolean;
      // Tool names to block for this project's agents; null clears the restriction.
      disallowedTools?: string[] | null;
      repoPath?: string | null;
      // null clears the project's instructions back to "no rules".
      instructions?: string | null;
      githubCredentialId?: string | null;
      flyCredentialId?: string | null;
      // Which provider keys the project may run on (credential ids; empty = all).
      enabledRunnerCredentialIds?: string[];
      syncSourceStatus?: boolean;
      // Branch to stack runs/PRs onto; null clears back to the global default.
      baseBranch?: string | null;
      // Where the Roadmap tab reads its doc from; null clears back to the
      // default ROADMAP.md/docs/ROADMAP.md candidates.
      roadmapPath?: string | null;
      // Verifier gate command; null clears back to the global default.
      checkCmd?: string | null;
      deepReview?: boolean;
      breakerReview?: boolean;
      // Momentum Board opt-in; see Project.newBoardEnabled.
      newBoardEnabled?: boolean;
      // Momentum Board's Queued-column WIP limit; null clears back to no limit.
      queuedWipLimit?: number | null;
      // Exact commands that must ALWAYS gate for a human. See Project.alwaysGateCommands.
      alwaysGateCommands?: string[];
      // Project-level default for a NEW automation rule's safety rails.
      ruleSafetyDefaults?: RuleSafety;
    },
  ) => Promise<void>;
  addApprovalRule: (projectId: string, command: string) => Promise<void>;
  removeApprovalRule: (projectId: string, ruleId: string) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  cloneProjectRepo: (id: string) => Promise<void>;
  createTask: (projectId: string, text: string, description?: string) => Promise<void>;
  updateTask: (
    projectId: string,
    taskId: string,
    patch: {
      text?: string;
      description?: string | null;
      autoPick?: boolean;
      assignment?: TaskAssignment;
      estimatedDurationMs?: number | null;
      plannedStartAt?: number | null;
      featureId?: string | null;
      milestoneId?: string | null;
      preferredProvider?: ProviderId | null;
      preferredModel?: string | null;
    },
  ) => Promise<void>;
  createFeature: (projectId: string, name: string, description?: string, milestoneId?: string | null) => Promise<void>;
  updateFeature: (
    featureId: string,
    patch: {
      name?: string;
      description?: string | null;
      status?: "active" | "paused" | "shipped";
      milestoneId?: string | null;
      archived?: boolean;
    },
  ) => Promise<void>;
  deleteFeature: (featureId: string) => Promise<void>;
  // Automation Builder (Phase 6a) — mutations only; reads ride the Snapshot +
  // rule.upserted/rule.deleted WS deltas (see the reducer below), same as
  // features/milestones. createRule RETURNS the created Rule so the builder
  // can switch straight from "new" to "editing" without a re-fetch.
  createRule: (
    projectId: string,
    req: { name: string; when: string; conditions: RuleCondition[]; actions: RuleAction[]; safety?: RuleSafety; state?: RuleLifecycleState },
  ) => Promise<Rule | null>;
  updateRule: (
    projectId: string,
    ruleId: string,
    patch: { name?: string; when?: string; conditions?: RuleCondition[]; actions?: RuleAction[]; safety?: RuleSafety; state?: RuleLifecycleState; archived?: boolean },
  ) => Promise<void>;
  deleteRule: (projectId: string, ruleId: string) => Promise<void>;
  // Rail Graph (Phase 11, TASK 12) — bulk-pauses every live rule for a
  // project in one call. Returns the rules actually paused so the caller can
  // report a real count; each one also rides back live via rule.upserted.
  pauseAllRules: (projectId: string) => Promise<Rule[]>;
  createMilestone: (projectId: string, name: string, description?: string, targetAt?: number | null) => Promise<void>;
  updateMilestone: (
    milestoneId: string,
    patch: {
      name?: string;
      description?: string | null;
      targetAt?: number | null;
      status?: "planned" | "in-progress" | "shipped";
      archived?: boolean;
    },
  ) => Promise<void>;
  deleteMilestone: (milestoneId: string) => Promise<void>;
  deleteTask: (projectId: string, taskId: string) => Promise<void>;
  archiveTask: (projectId: string, taskId: string, archived: boolean) => Promise<void>;
  moveTask: (projectId: string, taskId: string, direction: "up" | "down") => Promise<void>;
  reorderTask: (projectId: string, taskId: string, beforeId: string | null) => Promise<void>;
  transitionTask: (projectId: string, taskId: string, to: string, preserve?: boolean) => Promise<void>;
  forceTaskDone: (projectId: string, taskId: string) => Promise<void>;
  organizeBoard: (projectId: string) => Promise<{ reordered: number; archived: number; assigned: number }>;
  requestReview: (projectId: string, taskId: string) => Promise<void>;
  requestRetriage: (projectId: string, taskId: string) => Promise<void>;
  forceReview: (projectId: string, taskId: string) => Promise<void>;
  reassignTaskAgent: (projectId: string, taskId: string, agentId: string) => Promise<void>;
  resyncProjectSource: (projectId: string) => Promise<void>;
  assignTask: (projectId: string, taskId: string) => Promise<TaskRun | null>;
  assignManager: (projectId: string, taskId: string, area: string[]) => Promise<TaskRun | null>;
  // Cross-vendor consensus run: fire the task at 2+ providers in parallel.
  startBakeoff: (projectId: string, taskId: string, providerIds: ProviderId[]) => Promise<TaskRun[] | null>;
  // Bake-off peer review: have an agent compare the siblings and pick a winner.
  requestBakeoffJudgment: (projectId: string, taskId: string) => Promise<void>;
  dismissTaskLint: (projectId: string, taskId: string) => Promise<void>;
  answerClarification: (projectId: string, taskId: string, answer: string) => Promise<void>;
  // Momentum Board (Phase 5) — accept a suggested_subtask Proposal into a real
  // Task (parentTaskId set) individually, or every pending one for this task
  // at once. The echoed task.upserted / proposal.upserted WS deltas update
  // state — same "call the API, let the delta land" pattern as everything else.
  acceptSubtask: (taskId: string, proposalId: string) => Promise<void>;
  acceptAllSubtasks: (taskId: string) => Promise<void>;
  // Activity Feed (Phase 6b) — cancel a rule-engine action within its undo
  // window. Returns the updated PendingRuleAction (status "undone") so the
  // feed can optimistically update the row immediately — no WS event exists
  // for a pending action's own lifecycle, only the Transition it produces.
  undoRuleAction: (pendingId: string) => Promise<PendingRuleAction | null>;
  // TASK 13 hardening — the Activity Feed's "retry" action on a
  // status:"failed" row: re-runs the rule's own current dispatch (respecting
  // its live announceBeforeActing setting, same as any fresh signal would),
  // so the outcome shows up live through whichever normal path that implies
  // — a new transition.created event, or a new PendingRuleAction the Feed's
  // own periodic refetch picks up. Nothing to apply optimistically here.
  retryRuleAction: (ruleId: string, taskId: string) => Promise<void>;
  // Generic proposal accept/dismiss (Phase 1c) — TASK 10's pattern-spotted
  // card is the first UI to call these. `activate` only matters for a
  // suggested_rule proposal (see client.ts's acceptProposal doc comment).
  // Both resolved states ride back on the `proposal.upserted` WS echo.
  acceptProposal: (projectId: string, proposalId: string, opts?: { activate?: boolean }) => Promise<Proposal | null>;
  dismissProposal: (projectId: string, proposalId: string) => Promise<void>;
  createAgent: (provider: string, model: string, name?: string, credentialId?: string, label?: string | null) => Promise<void>;
  updateAgent: (id: string, patch: { model?: string; name?: string; canReview?: boolean; label?: string | null; credentialId?: string | null }) => Promise<void>;
  deleteAgent: (id: string) => Promise<void>;
  // audit trail maintenance — mirror archive (agent) + delete (project/task/runner)
  archiveAudit: (hitlId: string, archived: boolean) => Promise<void>;
  deleteAudit: (hitlId: string) => Promise<void>;
  archiveAllAudit: () => Promise<void>;
  clearAudit: () => Promise<void>;
  // TASK 19 — autonomy dial mutations. GET (getAutonomyDetent) is called
  // directly from the dial component (same convention as the Audit view's
  // own api.fetchAudit) — only mutations get a store wrapper.
  setAutonomyDetent: (projectId: string, detent: AutonomyDetent) => Promise<Project>;
  createAutonomyOverride: (projectId: string) => Promise<AutonomyOverride>;
  // Persist the workspace display name. No WS delta announces this (settings
  // aren't part of the live event stream), so echo the response into local
  // state directly rather than waiting on the next snapshot.
  updateWorkspaceName: (name: string) => Promise<void>;
  // Re-fetch the snapshot and force the socket to reconnect now (Retry button).
  retry: () => void;
  // Exchange operator credentials for a session token, then reconnect with it.
  login: (email: string, password: string) => Promise<api.LoginResult>;
  verifyMfa: (challengeId: string, code: string) => Promise<void>;
  // Time-limited admin promotion (ROADMAP.md) — ADMIN-granted: promote a
  // named viewer to a bounded full-authority window. Only callable by an
  // admin session (the server enforces the caller's PERSISTED role). Doesn't
  // touch the CALLER's own readOnly/elevatedUntil — granting someone else a
  // promotion never changes your own session.
  promoteOperator: (operatorId: string, ttlMs?: number) => Promise<{ expiresAt: number }>;
  fetchOperators: () => Promise<api.OperatorSummary[]>;
  fetchElevations: () => Promise<api.ElevationEvent[]>;
}

const StoreContext = createContext<Store | null>(null);

// ─── reducer for a single ServerEvent ──────────────────────────────────────

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

function reduce(state: StoreState, ev: ServerEvent): StoreState {
  switch (ev.type) {
    case "run.started":
      return { ...state, runs: upsert(state.runs, ev.run) };
    case "run.log":
      return {
        ...state,
        runs: state.runs.map((a) =>
          a.id === ev.runId
            ? { ...a, log: [...a.log, { at: ev.at, line: ev.line, detail: ev.detail, verb: ev.verb, resultKind: ev.resultKind }] }
            : a,
        ),
        // The finalized line just landed — whatever was typing for it is now
        // redundant (see the delta case below: every stream_event for a turn is
        // fully drained before its onLog fires, so nothing still in flight gets
        // cut off here).
        logDeltas: { ...state.logDeltas, [ev.runId]: "" },
      };
    case "run.log.delta":
      return {
        ...state,
        logDeltas: { ...state.logDeltas, [ev.runId]: (state.logDeltas[ev.runId] ?? "") + ev.delta },
      };
    case "run.progress":
      return {
        ...state,
        runs: state.runs.map((a) =>
          a.id === ev.runId ? { ...a, progress: ev.progress, plan: ev.plan } : a,
        ),
      };
    case "run.heartbeat":
      return {
        ...state,
        runs: state.runs.map((a) =>
          a.id === ev.runId ? { ...a, lastHeartbeatAt: ev.at } : a,
        ),
      };
    case "run.usage":
      return {
        ...state,
        runs: state.runs.map((a) =>
          a.id === ev.runId ? { ...a, usage: ev.usage } : a,
        ),
      };
    case "run.status":
      return {
        ...state,
        runs: state.runs.map((a) =>
          a.id === ev.runId ? { ...a, status: ev.status } : a,
        ),
      };
    case "run.completed":
      return {
        ...state,
        runs: state.runs.map((a) =>
          a.id === ev.runId
            ? { ...a, status: "done", branch: ev.branch, progress: 1 }
            : a,
        ),
        logDeltas: { ...state.logDeltas, [ev.runId]: "" },
      };
    case "run.archived":
      return {
        ...state,
        runs: state.runs.map((a) =>
          a.id === ev.runId ? { ...a, archived: ev.archived } : a,
        ),
      };
    case "run.updated":
      return { ...state, runs: upsert(state.runs, ev.run) };
    case "hitl.raised":
      return { ...state, queue: upsert(state.queue, ev.item) };
    case "hitl.resolved":
      return {
        ...state,
        queue: state.queue.map((q) =>
          q.id === ev.id
            ? { ...q, resolvedAt: ev.resolution.at, resolution: ev.resolution }
            : q,
        ),
      };
    case "conflict.detected":
      return state; // conflicts are derived from agent.modules on the client
    case "file-collision.detected":
      return state; // ditto, from agent.modifiedFiles — see fileCollisionsForAgent
    case "project.upserted":
      return { ...state, projects: upsert(state.projects, ev.project) };
    case "project.deleted":
      return { ...state, projects: state.projects.filter((p) => p.id !== ev.id) };
    case "task.upserted":
      return { ...state, tasks: upsert(state.tasks, ev.task) };
    case "task.deleted":
      return { ...state, tasks: state.tasks.filter((t) => t.id !== ev.id) };
    case "feature.upserted":
      return { ...state, features: upsert(state.features, ev.feature) };
    case "feature.deleted":
      return { ...state, features: state.features.filter((f) => f.id !== ev.id) };
    case "milestone.upserted":
      return { ...state, milestones: upsert(state.milestones, ev.milestone) };
    case "milestone.deleted":
      return { ...state, milestones: state.milestones.filter((m) => m.id !== ev.id) };
    case "solutionBrief.upserted":
      return { ...state, solutionBriefs: upsert(state.solutionBriefs, ev.brief) };
    case "solutionBrief.deleted":
      return { ...state, solutionBriefs: state.solutionBriefs.filter((b) => b.id !== ev.id) };
    case "agent.upserted":
      return { ...state, fleet: upsert(state.fleet, ev.agent) };
    case "agent.deleted":
      return { ...state, fleet: state.fleet.filter((r) => r.id !== ev.id) };
    case "rule.upserted":
      return { ...state, rules: upsert(state.rules, ev.rule) };
    case "rule.deleted":
      return { ...state, rules: state.rules.filter((r) => r.id !== ev.id) };
    case "proposal.upserted":
      return { ...state, proposals: upsert(state.proposals, ev.proposal) };
    case "transition.created":
      // Unbounded growth guard: keep the most recent 500 — plenty for a live
      // board session (moves-today counts, a landed sparkline, a task's own
      // trail); a board's own initial history still comes from the REST fetch.
      return { ...state, transitions: [...state.transitions, ev.transition].slice(-500) };
    case "audit.archived":
    case "audit.deleted":
    case "audit.archived-all":
    case "audit.cleared":
      // The trail lives outside the store — nudge the Audit view to re-fetch.
      return { ...state, auditRev: state.auditRev + 1 };
    case "autonomyBreaker.updated":
      // The breaker/override records live outside the store too — nudge an
      // open autonomy dial to re-fetch (see client.ts's getAutonomyDetent).
      return { ...state, autonomyRev: state.autonomyRev + 1 };
    default:
      return state;
  }
}

const EMPTY: StoreState = {
  runs: [],
  queue: [],
  projects: [],
  tasks: [],
  features: [],
  milestones: [],
  solutionBriefs: [],
  fleet: [],
  modules: [],
  deps: [],
  providers: [],
  rules: [],
  proposals: [],
  transitions: [],
  connected: false,
  loaded: false,
  wsPhase: "connecting",
  auditRev: 0,
  autonomyRev: 0,
  logDeltas: {},
};

function fromSnapshot(snap: Snapshot): StoreState {
  return {
    runs: snap.runs,
    queue: snap.queue,
    projects: snap.projects,
    tasks: snap.tasks,
    features: snap.features,
    milestones: snap.milestones,
    solutionBriefs: snap.solutionBriefs,
    fleet: snap.fleet,
    modules: snap.modules,
    deps: snap.deps,
    providers: snap.providers,
    rules: snap.rules,
    proposals: snap.proposals,
    // A fresh snapshot has no transition backlog to seed from (see StoreState's
    // own comment) — a mounted board re-fetches its project's history itself.
    transitions: [],
    defaultApprovalLevel: snap.defaultApprovalLevel,
    workspaceSettings: snap.workspaceSettings,
    parallelismNudge: snap.parallelismNudge,
    connected: true,
    loaded: true,
    // A snapshot in hand means we're effectively online; a later socket close
    // will flip this back to "closed" via the phase callback.
    wsPhase: "open",
    // A fresh snapshot supersedes any prior trail state; the Audit view re-pulls
    // on mount anyway, so reset the revision rather than carrying it across.
    auditRev: 0,
    autonomyRev: 0,
    // Any in-flight typing preview predates this snapshot — drop it rather than
    // carry stale partial text across a reconnect.
    logDeltas: {},
  };
}

// ─── provider ────────────────────────────────────────────────────────────────

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<StoreState>(EMPTY);
  const stateRef = useRef(state);
  stateRef.current = state;
  const connRef = useRef<api.Connection | null>(null);

  // Seed state from the REST snapshot. Kept as a ref so the Retry button can
  // re-run it without re-subscribing the socket.
  const loadSnapshot = useRef(() => {
    api
      .fetchSnapshot()
      // fromSnapshot() is a wholesale replace — thread readOnly/elevatedUntil
      // through so a reload/retry doesn't drop them back to "unknown" between
      // fetchMe() calls.
      .then((snap) => setState((s) => ({ ...fromSnapshot(snap), readOnly: s.readOnly, elevatedUntil: s.elevatedUntil })))
      .catch((err) => {
        // The WS snapshot will seed state if the REST seed fails — but never
        // swallow silently: a schema/contract drift makes fetchSnapshot reject
        // here, and without a log the app just hangs on "Connecting…" with no
        // clue why. Surface it so the next drift is diagnosable in seconds.
        console.error("[store] snapshot fetch failed (will retry via WS):", err);
      });
  });

  useEffect(() => {
    let cancelled = false;

    loadSnapshot.current();
    // Resolve the session's principal once at boot — whether it's read-only
    // drives the client-side mutation guard (client.ts's req()) and the UI's
    // greying. Best-effort: a failure here just leaves mutations enabled
    // client-side (the server-side gate is still authoritative).
    api
      .fetchMe()
      .then((principal) => {
        const ro = api.isReadOnlyPrincipal(principal);
        api.setReadOnly(ro);
        if (!cancelled) setState((s) => ({ ...s, readOnly: ro, elevatedUntil: principal.elevatedUntil ?? null }));
      })
      .catch((err) => console.error("[store] fetchMe failed:", err));

    const conn = api.connect(
      (msg) => {
        if (cancelled) return;
        if (msg.type === "snapshot") {
          setState((s) => ({ ...fromSnapshot(msg.state), readOnly: s.readOnly, elevatedUntil: s.elevatedUntil }));
        } else {
          // A newly-raised HITL is the "needs you" moment → fire an Inbox alert.
          // notifyInbox no-ops unless the operator turned alerts on (lib/alerts).
          // Only live deltas fire this; the connect-time snapshot never does, so
          // reconnecting doesn't re-alert on the existing queue.
          if (msg.type === "hitl.raised") {
            void notifyInbox(`Needs you — ${msg.item.title}`, msg.item.why, msg.item.runId);
          }
          setState((s) => reduce(s, msg));
        }
      },
      (phase) => {
        if (!cancelled) setState((s) => ({ ...s, wsPhase: phase, connected: phase === "open" && s.loaded }));
      },
    );
    connRef.current = conn;

    return () => {
      cancelled = true;
      conn.disconnect();
      connRef.current = null;
    };
  }, []);

  // Time-limited admin promotion: schedule the auto-revert. The server is what
  // actually enforces the window (auth/elevations.ts's activeUntil() re-checks
  // it on every request regardless of this timer) — this only makes the
  // CLIENT proactively re-fetch /me and flip back to read-only the moment it
  // lapses, instead of the UI silently believing it's still elevated until
  // the next mutation attempt gets a surprise 403.
  useEffect(() => {
    if (!state.elevatedUntil) return;
    const ms = state.elevatedUntil - Date.now();
    if (ms <= 0) return; // already lapsed — the next fetchMe() naturally reflects it
    const t = setTimeout(() => {
      api
        .fetchMe()
        .then((principal) => {
          const ro = api.isReadOnlyPrincipal(principal);
          api.setReadOnly(ro);
          setState((s) => ({ ...s, readOnly: ro, elevatedUntil: principal.elevatedUntil ?? null }));
        })
        .catch(() => undefined);
    }, ms);
    return () => clearTimeout(t);
  }, [state.elevatedUntil]);

  // A promotion is ADMIN-granted, on a DIFFERENT browser session than the one
  // that grants it — unlike the revert above, there's no local action to hang
  // a proactive re-check off of. Poll /me while this session is read-only so a
  // just-promoted viewer sees it land without a manual reload; stops the
  // moment it's no longer read-only (the revert timer above takes over then).
  useEffect(() => {
    if (!state.readOnly) return;
    const t = setInterval(() => {
      api
        .fetchMe()
        .then((principal) => {
          const ro = api.isReadOnlyPrincipal(principal);
          api.setReadOnly(ro);
          setState((s) => (s.readOnly === ro && s.elevatedUntil === (principal.elevatedUntil ?? null)
            ? s
            : { ...s, readOnly: ro, elevatedUntil: principal.elevatedUntil ?? null }));
        })
        .catch(() => undefined);
    }, 20_000);
    return () => clearInterval(t);
  }, [state.readOnly]);

  const store = useMemo<Store>(() => {
    return {
      ...state,
      resolveHitl: async (id, action, extra) => {
        // TASK 16 (Decision Inbox) needs failure feedback — resolveHitl had no
        // error handling anywhere in the app before this (an already-resolved
        // gate, a network blip) became a silent unhandled rejection. Matches
        // the try/catch+toast idiom every other mutation here already uses.
        try {
          await api.resolveHitl(id, { action, ...extra });
        } catch (e) {
          toast(serverMessage(e, "Couldn't resolve that decision."));
        }
      },
      resolveHitlBatch: async (ids, action, extra) => {
        try {
          const result = await api.resolveHitlBatch(ids, { action, ...extra });
          if (result.skipped.length > 0) {
            toast(`${result.resolved.length} of ${ids.length} resolved — ${result.skipped.length} couldn't be (already handled?).`);
          }
          return result;
        } catch (e) {
          toast(serverMessage(e, "Couldn't resolve that batch."));
          return { resolved: [], skipped: ids.map((id) => ({ id, reason: "request failed" })) };
        }
      },
      sendAgentMessage: async (id, text) => {
        const { reply } = await api.sendAgentMessage(id, text);
        return reply;
      },
      streamAgentMessage: (id, text, onDelta) => api.streamAgentMessage(id, text, onDelta),
      informRuns: (body) => api.informRuns(body),
      forkAgent: async (id) => {
        try {
          await api.forkAgent(id);
        } catch (e) {
          if (e instanceof api.ApiError && e.status === 409) {
            toast(serverMessage(e, "Can't fork — no agent available. Configure one in Fleet."));
            return;
          }
          throw e;
        }
      },
      createCheckpoint: async (id, label) => {
        try {
          return await api.createCheckpoint(id, label);
        } catch (e) {
          toast(serverMessage(e, "Couldn't create the checkpoint."));
          return null;
        }
      },
      restoreCheckpoint: async (id, checkpointId) => {
        try {
          await api.restoreCheckpoint(id, checkpointId);
        } catch (e) {
          toast(serverMessage(e, "Couldn't restore the checkpoint."));
        }
      },
      stopAgent: async (id) => {
        await api.stopAgent(id);
      },
      archiveAgent: async (id, archived) => {
        await api.archiveAgent(id, archived);
      },
      pauseAgent: async (id) => {
        await api.pauseAgent(id);
      },
      resumeAgent: async (id) => {
        await api.resumeAgent(id);
      },
      mergePr: (runId, method) => api.mergePr(runId, method),
      updatePrBranch: (runId) => api.updatePrBranch(runId),
      reworkPr: async (runId, guidance, comment) => {
        await api.reworkPr(runId, guidance, comment);
      },
      dismissPr: async (runId) => {
        await api.dismissPr(runId);
      },
      mergeFeaturePr: (featureId, method) => api.mergeFeaturePr(featureId, method),
      dismissFeaturePr: async (featureId) => {
        await api.dismissFeaturePr(featureId);
      },
      setProviderAvailable: (id, available) => {
        setState((s) => ({
          ...s,
          providers: s.providers.map((p) => (p.id === id ? { ...p, available } : p)),
        }));
      },
      createProject: async (name, goal, opts) => {
        // Return the created project so callers can navigate straight into it.
        const created = await api.createProject({
          name,
          goal,
          repo: opts?.repo,
          repoPath: opts?.repoPath,
          createRepo: opts?.createRepo,
          autonomy: opts?.autonomy,
          approvalLevel: opts?.approvalLevel,
          instructions: opts?.instructions,
          importGithubIssues: opts?.importGithubIssues,
          charter: opts?.charter,
          githubCredentialId: opts?.githubCredentialId,
        });
        // Optimistically land it in the store so navigating into it renders
        // immediately (the WS project.upserted reconciles the same row shortly).
        setState((s) => ({ ...s, projects: upsert(s.projects, created) }));
        return created;
      },
      updateProject: async (id, patch) => {
        // Apply the server's response DIRECTLY instead of waiting for the WS
        // echo, and surface failures. Before this, a project-settings save
        // (Daily budget, Autonomy, Plan mode, …) had no feedback path at all:
        // no local apply (the field only changed when the `project.upserted`
        // echo arrived — a dropped/reconnecting socket made a SUCCESSFUL save
        // look like nothing happened, with the input snapping back on blur)
        // and no catch (a server rejection was a silent unhandled rejection).
        // Reported live as "budget cannot be set anymore — nothing happens
        // when I write in an amount."
        try {
          const updated = await api.updateProject(id, patch);
          setState((s) => ({ ...s, projects: upsert(s.projects, updated) }));
        } catch (e) {
          if (e instanceof api.ApiError) toast(serverMessage(e, "Couldn't save the project settings."));
          else throw e;
        }
      },
      addApprovalRule: async (projectId, command) => {
        try {
          const updated = await api.addApprovalRule(projectId, command);
          setState((s) => ({ ...s, projects: upsert(s.projects, updated) }));
        } catch (e) {
          if (e instanceof api.ApiError) toast(serverMessage(e, "Couldn't add that pattern."));
          else throw e;
        }
      },
      removeApprovalRule: async (projectId, ruleId) => {
        try {
          await api.removeApprovalRule(projectId, ruleId);
        } catch (e) {
          if (e instanceof api.ApiError) toast(serverMessage(e, "Couldn't remove that pattern."));
          else throw e;
        }
      },
      deleteProject: async (id) => {
        await api.deleteProject(id);
      },
      cloneProjectRepo: async (id) => {
        // Clones the project's GitHub repo into a local checkout server-side; the
        // updated project (repoPath + gitBacked) arrives via the WS upsert.
        await api.cloneProjectRepo(id);
      },
      createTask: async (projectId, text, description) => {
        await api.createTask(projectId, text, description);
      },
      updateTask: async (projectId, taskId, patch) => {
        await api.updateTask(projectId, taskId, patch);
      },
      moveTask: async (projectId, taskId, direction) => {
        await api.moveTask(projectId, taskId, direction);
      },
      reorderTask: async (projectId, taskId, beforeId) => {
        await api.reorderTask(projectId, taskId, beforeId);
      },
      transitionTask: async (projectId, taskId, to, preserve) => {
        try {
          await api.transitionTask(projectId, taskId, to, preserve);
        } catch (e) {
          if (e instanceof api.ApiError) toast(serverMessage(e, "Couldn't move the task."));
        }
      },
      forceTaskDone: async (projectId, taskId) => {
        try {
          await api.forceTaskDone(projectId, taskId);
        } catch (e) {
          if (e instanceof api.ApiError) toast(serverMessage(e, "Couldn't force the task done."));
        }
      },
      organizeBoard: async (projectId) => {
        try {
          return await api.organizeBoard(projectId);
        } catch (e) {
          if (e instanceof api.ApiError) toast(serverMessage(e, "Couldn't organize the board."));
          return { reordered: 0, archived: 0, assigned: 0 };
        }
      },
      requestReview: async (projectId, taskId) => {
        try {
          await api.requestReview(projectId, taskId);
        } catch (e) {
          if (e instanceof api.ApiError) toast(serverMessage(e, "Couldn't request a review."));
        }
      },
      requestRetriage: async (projectId, taskId) => {
        try {
          await api.requestRetriage(projectId, taskId);
        } catch (e) {
          if (e instanceof api.ApiError) toast(serverMessage(e, "Couldn't re-triage."));
        }
      },
      forceReview: async (projectId, taskId) => {
        try {
          await api.forceReview(projectId, taskId);
        } catch (e) {
          if (e instanceof api.ApiError) toast(serverMessage(e, "Couldn't force this to review."));
        }
      },
      reassignTaskAgent: async (projectId, taskId, agentId) => {
        try {
          await api.reassignTaskAgent(projectId, taskId, agentId);
        } catch (e) {
          if (e instanceof api.ApiError) toast(serverMessage(e, "Couldn't switch agent."));
        }
      },
      resyncProjectSource: async (projectId) => {
        try {
          const res = await api.resyncProjectSource(projectId);
          const parts = [
            res.imported ? `${res.imported} imported` : null,
            res.updated ? `${res.updated} updated` : null,
            res.pushed ? `${res.pushed} pushed` : null,
          ].filter((p): p is string => p !== null);
          toast(parts.length ? `Re-synced — ${parts.join(", ")}.` : "Re-synced — already up to date.");
        } catch (e) {
          if (e instanceof api.ApiError) toast(serverMessage(e, "Couldn't re-sync."));
        }
      },
      deleteTask: async (projectId, taskId) => {
        await api.deleteTask(projectId, taskId);
      },
      archiveTask: async (projectId, taskId, archived) => {
        await api.archiveTask(projectId, taskId, archived);
      },
      createFeature: async (projectId, name, description, milestoneId) => {
        await api.createFeature(projectId, { name, ...(description ? { description } : {}), ...(milestoneId !== undefined ? { milestoneId } : {}) });
      },
      updateFeature: async (featureId, patch) => {
        try {
          await api.updateFeature(featureId, patch);
        } catch (e) {
          if (e instanceof api.ApiError) toast(serverMessage(e, "Couldn't update the feature."));
        }
      },
      deleteFeature: async (featureId) => {
        await api.deleteFeature(featureId);
      },
      createRule: async (projectId, req) => {
        try {
          return await api.createRule(projectId, req);
        } catch (e) {
          if (e instanceof api.ApiError) toast(serverMessage(e, "Couldn't save the rule."));
          return null;
        }
      },
      updateRule: async (projectId, ruleId, patch) => {
        try {
          await api.updateRule(projectId, ruleId, patch);
        } catch (e) {
          if (e instanceof api.ApiError) toast(serverMessage(e, "Couldn't update the rule."));
        }
      },
      deleteRule: async (projectId, ruleId) => {
        await api.deleteRule(projectId, ruleId);
      },
      pauseAllRules: async (projectId) => {
        try {
          return await api.pauseAllRules(projectId);
        } catch (e) {
          toast(serverMessage(e, "Couldn't pause the rules."));
          return [];
        }
      },
      createMilestone: async (projectId, name, description, targetAt) => {
        await api.createMilestone(projectId, { name, ...(description ? { description } : {}), ...(targetAt !== undefined ? { targetAt } : {}) });
      },
      updateMilestone: async (milestoneId, patch) => {
        try {
          await api.updateMilestone(milestoneId, patch);
        } catch (e) {
          if (e instanceof api.ApiError) toast(serverMessage(e, "Couldn't update the milestone."));
        }
      },
      deleteMilestone: async (milestoneId) => {
        await api.deleteMilestone(milestoneId);
      },
      assignTask: async (projectId, taskId) => {
        try {
          return await api.assignTask(projectId, taskId);
        } catch (e) {
          if (e instanceof api.ApiError && e.status === 409) {
            toast(serverMessage(e, "No idle agent available — configure or free one in Fleet."));
            return null;
          }
          throw e;
        }
      },
      assignManager: async (projectId, taskId, area) => {
        try {
          return await api.assignManager(projectId, taskId, area);
        } catch (e) {
          if (e instanceof api.ApiError && e.status === 409) {
            toast(serverMessage(e, "No idle agent available — configure or free one in Fleet."));
            return null;
          }
          throw e;
        }
      },
      startBakeoff: async (projectId, taskId, providerIds) => {
        try {
          return await api.startBakeoff(projectId, taskId, providerIds);
        } catch (e) {
          if (e instanceof api.ApiError) {
            toast(serverMessage(e, "Couldn't start the bake-off."));
            return null;
          }
          throw e;
        }
      },
      requestBakeoffJudgment: async (projectId, taskId) => {
        try {
          await api.requestBakeoffJudgment(projectId, taskId);
        } catch (e) {
          if (e instanceof api.ApiError) toast(serverMessage(e, "Couldn't judge the bake-off."));
        }
      },
      dismissTaskLint: async (projectId, taskId) => {
        await api.dismissTaskLint(projectId, taskId);
      },
      // The updated task rides back on the `task.upserted` WS echo, same as
      // every other task mutation here — nothing to apply locally.
      answerClarification: async (projectId, taskId, answer) => {
        await api.answerClarification(projectId, taskId, answer);
      },
      acceptSubtask: async (taskId, proposalId) => {
        await api.acceptSubtask(taskId, proposalId);
      },
      acceptAllSubtasks: async (taskId) => {
        await api.acceptAllSubtasks(taskId);
      },
      undoRuleAction: async (pendingId) => {
        try {
          return await api.undoRuleAction(pendingId);
        } catch (e) {
          toast(serverMessage(e, "Couldn't undo that action — the window may have passed."));
          return null;
        }
      },
      retryRuleAction: async (ruleId, taskId) => {
        try {
          await api.retryRuleAction(ruleId, taskId);
        } catch (e) {
          toast(serverMessage(e, "Couldn't retry that action."));
        }
      },
      acceptProposal: async (projectId, proposalId, opts) => {
        try {
          return await api.acceptProposal(projectId, proposalId, opts);
        } catch (e) {
          toast(serverMessage(e, "Couldn't accept that proposal."));
          return null;
        }
      },
      dismissProposal: async (projectId, proposalId) => {
        try {
          await api.dismissProposal(projectId, proposalId);
        } catch (e) {
          toast(serverMessage(e, "Couldn't dismiss that proposal."));
        }
      },
      createAgent: async (provider, model, name, credentialId, label) => {
        await api.createAgent({ provider, model, name, credentialId, label });
      },
      updateAgent: async (id, patch) => {
        await api.updateAgent(id, patch);
      },
      deleteAgent: async (id) => {
        try {
          await api.deleteAgent(id);
        } catch (e) {
          if (e instanceof api.ApiError && e.status === 409) {
            toast("Agent is busy — finish or reassign its task before retiring.");
            return;
          }
          throw e;
        }
      },
      archiveAudit: async (hitlId, archived) => {
        await api.archiveAudit(hitlId, archived);
      },
      deleteAudit: async (hitlId) => {
        await api.deleteAudit(hitlId);
      },
      archiveAllAudit: async () => {
        await api.archiveAllAudit();
      },
      clearAudit: async () => {
        await api.clearAudit();
      },
      setAutonomyDetent: async (projectId, detent) => {
        return api.setAutonomyDetent(projectId, detent);
      },
      createAutonomyOverride: async (projectId) => {
        return api.createAutonomyOverride(projectId);
      },
      updateWorkspaceName: async (name) => {
        const settings = await api.updateWorkspaceSettings({ name });
        setState((s) => ({ ...s, workspaceSettings: settings }));
      },
      retry: () => {
        setState((s) => ({ ...s, wsPhase: "connecting" }));
        loadSnapshot.current();
        connRef.current?.reconnect();
      },
      login: async (email, password) => {
        const result = await api.login(email, password);
        // No MFA → session is set; re-init with the new token. MFA → the caller
        // (LoginView) collects the code and calls verifyMfa.
        if (!result.mfaRequired) location.reload();
        return result;
      },
      verifyMfa: async (challengeId, code) => {
        await api.verifyMfa(challengeId, code);
        // Session set — re-init the whole app with the new token.
        location.reload();
      },
      promoteOperator: (operatorId, ttlMs) => api.promoteOperator(operatorId, ttlMs),
      fetchOperators: () => api.fetchOperators(),
      fetchElevations: () => api.fetchElevations(),
    };
  }, [state]);

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used within StoreProvider");
  return ctx;
}

// 1s-ticking clock corrected against nothing fancy — wall clock is fine for the UI.
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
