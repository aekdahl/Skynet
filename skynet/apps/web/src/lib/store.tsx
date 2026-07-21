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
  Dependency,
  HitlItem,
  Module,
  Project,
  ProviderInfo,
  ResolveAction,
  Agent,
  ServerEvent,
  Snapshot,
  Task,
} from "@skynet/shared";
import * as api from "./client";
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
  fleet: Agent[];
  modules: Module[];
  deps: Dependency[];
  providers: ProviderInfo[];
  connected: boolean;
  loaded: boolean;
  // Bumps on any audit.* delta. The trail isn't held in the store (it's fetched
  // over HTTP by the Audit view), so this is the signal the view watches to
  // re-pull after an archive/delete/clear lands — from any operator or tab.
  auditRev: number;
}

export interface Store extends StoreState {
  // mutations — call the API, let the echoed WS delta update state
  resolveHitl: (
    id: string,
    action: ResolveAction,
    extra?: { optionIndex?: number; guidance?: string },
  ) => Promise<void>;
  sendAgentMessage: (id: string, text: string) => Promise<string>;
  forkAgent: (id: string) => Promise<void>;
  archiveAgent: (id: string, archived: boolean) => Promise<void>;
  pauseAgent: (id: string) => Promise<void>;
  resumeAgent: (id: string) => Promise<void>;
  stopAgent: (id: string) => Promise<void>;
  // Local optimistic flip after a key is set/cleared in Settings (the snapshot
  // recomputes availability from the secret store on next load).
  setProviderAvailable: (id: string, available: boolean) => void;
  createProject: (name: string, goal: string, opts?: { repo?: string; repoPath?: string }) => Promise<void>;
  updateProject: (
    id: string,
    patch: { name?: string; goal?: string; status?: string; autonomy?: boolean },
  ) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  createTask: (projectId: string, text: string, description?: string) => Promise<void>;
  updateTask: (
    projectId: string,
    taskId: string,
    patch: { text?: string; description?: string | null; autoPick?: boolean },
  ) => Promise<void>;
  deleteTask: (projectId: string, taskId: string) => Promise<void>;
  moveTask: (projectId: string, taskId: string, direction: "up" | "down") => Promise<void>;
  transitionTask: (projectId: string, taskId: string, to: string) => Promise<void>;
  assignTask: (projectId: string, taskId: string) => Promise<TaskRun | null>;
  createAgent: (provider: string, model: string, name?: string) => Promise<void>;
  updateAgent: (id: string, patch: { model?: string; name?: string }) => Promise<void>;
  deleteAgent: (id: string) => Promise<void>;
  // audit trail maintenance — mirror archive (agent) + delete (project/task/runner)
  archiveAudit: (hitlId: string, archived: boolean) => Promise<void>;
  deleteAudit: (hitlId: string) => Promise<void>;
  archiveAllAudit: () => Promise<void>;
  clearAudit: () => Promise<void>;
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
      };
    case "run.archived":
      return {
        ...state,
        runs: state.runs.map((a) =>
          a.id === ev.runId ? { ...a, archived: ev.archived } : a,
        ),
      };
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
  fleet: [],
  modules: [],
  deps: [],
  providers: [],
  connected: false,
  loaded: false,
  auditRev: 0,
};

function fromSnapshot(snap: Snapshot): StoreState {
  return {
    runs: snap.runs,
    queue: snap.queue,
    projects: snap.projects,
    tasks: snap.tasks,
    fleet: snap.fleet,
    modules: snap.modules,
    deps: snap.deps,
    providers: snap.providers,
    connected: true,
    loaded: true,
    // A fresh snapshot supersedes any prior trail state; the Audit view re-pulls
    // on mount anyway, so reset the revision rather than carrying it across.
    auditRev: 0,
  };
}

// ─── provider ────────────────────────────────────────────────────────────────

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<StoreState>(EMPTY);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    let cancelled = false;

    api
      .fetchSnapshot()
      .then((snap) => {
        if (!cancelled) setState(fromSnapshot(snap));
      })
      .catch((err) => {
        // The WS snapshot will seed state if the REST seed fails — but never
        // swallow silently: a schema/contract drift makes fetchSnapshot reject
        // here, and without a log the app just hangs on "Connecting…" with no
        // clue why. Surface it so the next drift is diagnosable in seconds.
        console.error("[store] initial snapshot fetch failed (will retry via WS):", err);
      });

    const disconnect = api.connect((msg) => {
      if (msg.type === "snapshot") {
        setState(fromSnapshot(msg.state));
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
    });

    return () => {
      cancelled = true;
      disconnect();
    };
  }, []);

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
      forkAgent: async (id) => {
        try {
          await api.forkAgent(id);
        } catch (e) {
          if (e instanceof api.ApiError && e.status === 409) {
            alert(serverMessage(e, "Can't fork — no agent available. Configure one in Fleet."));
            return;
          }
          throw e;
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
      setProviderAvailable: (id, available) => {
        setState((s) => ({
          ...s,
          providers: s.providers.map((p) => (p.id === id ? { ...p, available } : p)),
        }));
      },
      createProject: async (name, goal, opts) => {
        await api.createProject({ name, goal, repo: opts?.repo, repoPath: opts?.repoPath });
      },
      updateProject: async (id, patch) => {
        await api.updateProject(id, patch);
      },
      deleteProject: async (id) => {
        await api.deleteProject(id);
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
      transitionTask: async (projectId, taskId, to) => {
        try {
          await api.transitionTask(projectId, taskId, to);
        } catch (e) {
          if (e instanceof api.ApiError) alert(serverMessage(e, "Couldn't move the task."));
        }
      },
      deleteTask: async (projectId, taskId) => {
        await api.deleteTask(projectId, taskId);
      },
      assignTask: async (projectId, taskId) => {
        try {
          return await api.assignTask(projectId, taskId);
        } catch (e) {
          if (e instanceof api.ApiError && e.status === 409) {
            alert(serverMessage(e, "No idle agent available — configure or free one in Fleet."));
            return null;
          }
          throw e;
        }
      },
      createAgent: async (provider, model, name) => {
        await api.createAgent({ provider, model, name });
      },
      updateAgent: async (id, patch) => {
        await api.updateAgent(id, patch);
      },
      deleteAgent: async (id) => {
        try {
          await api.deleteAgent(id);
        } catch (e) {
          if (e instanceof api.ApiError && e.status === 409) {
            alert("Agent is busy — finish or reassign its task before retiring.");
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
