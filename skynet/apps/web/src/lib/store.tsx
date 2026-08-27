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
  Checkpoint,
  Dependency,
  Feature,
  HitlItem,
  Milestone,
  Module,
  ParallelismNudge,
  Project,
  ProjectCharter,
  ProviderId,
  ProviderInfo,
  ResolveAction,
  Agent,
  ServerEvent,
  Snapshot,
  SolutionBrief,
  Task,
  TaskAssignment,
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
  connected: boolean;
  loaded: boolean;
  // Live socket lifecycle, so the shell can show connect→connected and a retry
  // affordance rather than a dead-end "Connecting…" message.
  wsPhase: api.WsPhase;
  // Bumps on any audit.* delta. The trail isn't held in the store (it's fetched
  // over HTTP by the Audit view), so this is the signal the view watches to
  // re-pull after an archive/delete/clear lands — from any operator or tab.
  auditRev: number;
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
    },
  ) => Promise<void>;
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
  organizeBoard: (projectId: string) => Promise<{ reordered: number; archived: number }>;
  requestReview: (projectId: string, taskId: string) => Promise<void>;
  requestRetriage: (projectId: string, taskId: string) => Promise<void>;
  forceReview: (projectId: string, taskId: string) => Promise<void>;
  resyncProjectSource: (projectId: string) => Promise<void>;
  assignTask: (projectId: string, taskId: string) => Promise<TaskRun | null>;
  dismissTaskLint: (projectId: string, taskId: string) => Promise<void>;
  answerClarification: (projectId: string, taskId: string, answer: string) => Promise<void>;
  createAgent: (provider: string, model: string, name?: string, credentialId?: string, label?: string | null) => Promise<void>;
  updateAgent: (id: string, patch: { model?: string; name?: string; canReview?: boolean; label?: string | null }) => Promise<void>;
  deleteAgent: (id: string) => Promise<void>;
  // audit trail maintenance — mirror archive (agent) + delete (project/task/runner)
  archiveAudit: (hitlId: string, archived: boolean) => Promise<void>;
  deleteAudit: (hitlId: string) => Promise<void>;
  archiveAllAudit: () => Promise<void>;
  clearAudit: () => Promise<void>;
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
            ? { ...a, log: [...a.log, { at: ev.at, line: ev.line, detail: ev.detail }] }
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
    case "audit.archived":
    case "audit.deleted":
    case "audit.archived-all":
    case "audit.cleared":
      // The trail lives outside the store — nudge the Audit view to re-fetch.
      return { ...state, auditRev: state.auditRev + 1 };
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
  connected: false,
  loaded: false,
  wsPhase: "connecting",
  auditRev: 0,
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
        await api.resolveHitl(id, { action, ...extra });
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
      removeApprovalRule: async (projectId, ruleId) => {
        await api.removeApprovalRule(projectId, ruleId);
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
          return { reordered: 0, archived: 0 };
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
      dismissTaskLint: async (projectId, taskId) => {
        await api.dismissTaskLint(projectId, taskId);
      },
      // The updated task rides back on the `task.upserted` WS echo, same as
      // every other task mutation here — nothing to apply locally.
      answerClarification: async (projectId, taskId, answer) => {
        await api.answerClarification(projectId, taskId, answer);
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
