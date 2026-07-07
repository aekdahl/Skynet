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
  Agent,
  Dependency,
  HitlItem,
  Module,
  Project,
  ProviderInfo,
  ResolveAction,
  Runner,
  ServerEvent,
  Snapshot,
  Task,
} from "@skynet/shared";
import * as api from "./client";

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
  agents: Agent[];
  queue: HitlItem[];
  projects: Project[];
  tasks: Task[];
  fleet: Runner[];
  modules: Module[];
  deps: Dependency[];
  providers: ProviderInfo[];
  connected: boolean;
  loaded: boolean;
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
    patch: { name?: string; goal?: string; status?: string },
  ) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  createTask: (projectId: string, text: string) => Promise<void>;
  updateTask: (
    projectId: string,
    taskId: string,
    patch: { text?: string; state?: string },
  ) => Promise<void>;
  deleteTask: (projectId: string, taskId: string) => Promise<void>;
  assignTask: (projectId: string, taskId: string) => Promise<Agent | null>;
  createRunner: (provider: string, model: string, name?: string) => Promise<void>;
  updateRunner: (id: string, patch: { model?: string; name?: string }) => Promise<void>;
  deleteRunner: (id: string) => Promise<void>;
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
    case "agent.started":
      return { ...state, agents: upsert(state.agents, ev.agent) };
    case "agent.log":
      return {
        ...state,
        agents: state.agents.map((a) =>
          a.id === ev.agentId
            ? { ...a, log: [...a.log, { at: ev.at, line: ev.line, detail: ev.detail }] }
            : a,
        ),
      };
    case "agent.progress":
      return {
        ...state,
        agents: state.agents.map((a) =>
          a.id === ev.agentId ? { ...a, progress: ev.progress, plan: ev.plan } : a,
        ),
      };
    case "agent.heartbeat":
      return {
        ...state,
        agents: state.agents.map((a) =>
          a.id === ev.agentId ? { ...a, lastHeartbeatAt: ev.at } : a,
        ),
      };
    case "agent.status":
      return {
        ...state,
        agents: state.agents.map((a) =>
          a.id === ev.agentId ? { ...a, status: ev.status } : a,
        ),
      };
    case "agent.completed":
      return {
        ...state,
        agents: state.agents.map((a) =>
          a.id === ev.agentId
            ? { ...a, status: "done", branch: ev.branch, progress: 1 }
            : a,
        ),
      };
    case "agent.archived":
      return {
        ...state,
        agents: state.agents.map((a) =>
          a.id === ev.agentId ? { ...a, archived: ev.archived } : a,
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
    case "runner.upserted":
      return { ...state, fleet: upsert(state.fleet, ev.runner) };
    case "runner.deleted":
      return { ...state, fleet: state.fleet.filter((r) => r.id !== ev.id) };
    default:
      return state;
  }
}

const EMPTY: StoreState = {
  agents: [],
  queue: [],
  projects: [],
  tasks: [],
  fleet: [],
  modules: [],
  deps: [],
  providers: [],
  connected: false,
  loaded: false,
};

function fromSnapshot(snap: Snapshot): StoreState {
  return {
    agents: snap.agents,
    queue: snap.queue,
    projects: snap.projects,
    tasks: snap.tasks,
    fleet: snap.fleet,
    modules: snap.modules,
    deps: snap.deps,
    providers: snap.providers,
    connected: true,
    loaded: true,
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
      .catch(() => {
        /* the WS snapshot will seed state if the REST seed fails */
      });

    const disconnect = api.connect((msg) => {
      if (msg.type === "snapshot") {
        setState(fromSnapshot(msg.state));
      } else {
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
            alert(serverMessage(e, "Can't fork — no runner available. Configure one in Fleet."));
            return;
          }
          throw e;
        }
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
      stopAgent: async (id) => {
        await api.stopAgent(id);
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
      createTask: async (projectId, text) => {
        await api.createTask(projectId, text);
      },
      updateTask: async (projectId, taskId, patch) => {
        await api.updateTask(projectId, taskId, patch);
      },
      deleteTask: async (projectId, taskId) => {
        await api.deleteTask(projectId, taskId);
      },
      assignTask: async (projectId, taskId) => {
        try {
          return await api.assignTask(projectId, taskId);
        } catch (e) {
          if (e instanceof api.ApiError && e.status === 409) {
            alert(serverMessage(e, "No idle runner available — configure or free one in Fleet."));
            return null;
          }
          throw e;
        }
      },
      createRunner: async (provider, model, name) => {
        await api.createRunner({ provider, model, name });
      },
      updateRunner: async (id, patch) => {
        await api.updateRunner(id, patch);
      },
      deleteRunner: async (id) => {
        try {
          await api.deleteRunner(id);
        } catch (e) {
          if (e instanceof api.ApiError && e.status === 409) {
            alert("Runner is busy — finish or reassign its task before retiring.");
            return;
          }
          throw e;
        }
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
