import type {
  TaskRun,
  TaskRunStatus,
  HitlItem,
  HitlKind,
  Module,
  ProviderId,
  ProviderInfo,
  Agent,
  Task,
  TaskState,
} from "@skynet/shared";

// ─── time formatting ───────────────────────────────────────────────────────

export function fmtWait(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${String(r).padStart(2, "0")}s` : `${r}s`;
}

export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

// ─── epoch-ms → display counters (against a ticking `now`) ──────────────────

export const heartbeatSecs = (agent: TaskRun, now: number) =>
  Math.max(0, (now - agent.lastHeartbeatAt) / 1000);

export const startedMins = (agent: TaskRun, now: number) =>
  Math.max(0, (now - agent.startedAt) / 60000);

export const waitedSecs = (hitl: HitlItem, now: number) =>
  Math.max(0, (now - hitl.raisedAt) / 1000);

export function fmtElapsed(agent: TaskRun, now: number): string {
  const mins = Math.floor(startedMins(agent, now));
  const h = Math.floor(mins / 60);
  return `${h > 0 ? `${h}h ` : ""}${mins % 60}m elapsed`;
}

export function runnerIdleLabel(runner: Agent, now: number): string {
  if (runner.idleSince == null) return "now";
  const mins = Math.floor((now - runner.idleSince) / 60000);
  if (mins <= 0) return "now";
  const h = Math.floor(mins / 60);
  return h > 0 ? `${h}h ${mins % 60}m` : `${mins}m`;
}

// ─── plan helpers ───────────────────────────────────────────────────────────

export const curStep = (a: TaskRun) => {
  const s = a.plan.find((p) => p.state === "now");
  return s ? s.text : "complete";
};
export const stepIdx = (a: TaskRun) => {
  const i = a.plan.findIndex((p) => p.state === "now");
  return i < 0 ? a.plan.length : i;
};
export const planDone = (a: TaskRun) => a.plan.filter((p) => p.state === "done").length;

// ─── collection lookups ──────────────────────────────────────────────────────

export const agentsForProject = (runs: TaskRun[], projectId: string) =>
  runs.filter((a) => a.projectId === projectId);

export const tasksForProject = (tasks: Task[], projectId: string) =>
  tasks.filter((t) => t.projectId === projectId);

export const backlogTasks = (tasks: Task[], projectId: string) =>
  tasks
    .filter((t) => t.projectId === projectId && t.state === "backlog")
    // Manual priority: lower `order` sorts higher (top = next up). Stable by id
    // so legacy tasks with an unset order keep a deterministic position.
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));

export const doneTasks = (tasks: Task[], projectId: string) =>
  tasks.filter((t) => t.projectId === projectId && t.state === "done");

// A task is "queued" — a FUTURE station on the subway — when it has no run yet:
// not started and not done. (ongoing/review/done all carry a runId → already a
// station on the line.)
const isQueued = (t: Task) =>
  t.runId == null && (t.state === "backlog" || t.state === "triage" || t.state === "todo");
const byPriority = (a: Task, b: Task) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id);

export type ProjectQueue = {
  // Waiting tasks deterministically AHEAD of one agent (assignment.mode "agents"),
  // keyed by their primary (first-listed) eligible agent, in priority order.
  pinned: Map<string, Task[]>;
  // The shared "up next" lane: waiting tasks any agent could take (mode "any") or
  // that haven't chosen (legacy/unassigned) — not tied to a single line.
  shared: Task[];
};

// Split a project's not-yet-run work into per-agent queues (what's ahead of each
// agent) and a shared lane. Powers the subway lookahead: done → current → queued
// → ship. Legacy tasks with no `assignment` fall into the shared lane.
export function projectQueue(tasks: Task[], projectId: string): ProjectQueue {
  const queued = tasks.filter((t) => t.projectId === projectId && isQueued(t)).sort(byPriority);
  const pinned = new Map<string, Task[]>();
  const shared: Task[] = [];
  for (const t of queued) {
    const a = t.assignment;
    if (a?.mode === "agents" && a.agentIds.length > 0) {
      const primary = a.agentIds[0]!;
      pinned.set(primary, [...(pinned.get(primary) ?? []), t]);
    } else {
      shared.push(t);
    }
  }
  return { pinned, shared };
}

export const hitlFor = (queue: HitlItem[], runId: string) =>
  queue.find((q) => q.runId === runId && q.resolvedAt == null);

export const openQueue = (queue: HitlItem[]) =>
  queue.filter((q) => q.resolvedAt == null);

// ─── runner / fleet derivations ──────────────────────────────────────────────

export const runnerIsBusy = (runner: Agent, runs: TaskRun[]) =>
  runner.status === "busy" ||
  runs.some((a) => a.status !== "done" && a.agentId === runner.id);

export const idleRunners = (fleet: Agent[], runs: TaskRun[]) =>
  fleet.filter((r) => !runnerIsBusy(r, runs));

export const runnerName = (agent: TaskRun, fleet: Agent[]) => {
  const r = fleet.find((f) => f.id === agent.agentId);
  return r ? r.name : agent.agentId ?? agent.id;
};

export const providerOf = (agent: TaskRun, fleet: Agent[]): ProviderId => {
  const r = fleet.find((f) => f.id === agent.agentId);
  return r ? r.provider : agent.provider;
};

// ─── module name lookup ──────────────────────────────────────────────────────

export const modName = (modules: Module[], id: string) =>
  modules.find((m) => m.id === id)?.name ?? id;

// ─── conflict detection (families share a parent) ───────────────────────────

export const familyOf = (a: TaskRun) => a.parentId ?? a.id;

export function conflictModulesForAgent(agent: TaskRun, runs: TaskRun[]): string[] {
  if (agent.status === "done") return [];
  return agent.modules.filter((mod) =>
    runs.some(
      (other) =>
        other.id !== agent.id &&
        other.status !== "done" &&
        familyOf(other) !== familyOf(agent) &&
        other.modules.includes(mod),
    ),
  );
}

export function conflicts(runs: TaskRun[]): Array<[string, TaskRun[]]> {
  const byMod: Record<string, TaskRun[]> = {};
  runs
    .filter((a) => a.status !== "done")
    .forEach((a) => {
      a.modules.forEach((m) => {
        (byMod[m] = byMod[m] ?? []).push(a);
      });
    });
  return Object.entries(byMod).filter(
    ([, list]) => new Set(list.map(familyOf)).size > 1,
  );
}

// ─── status / kind metadata ──────────────────────────────────────────────────

// The kanban pipeline, in column order, with per-state label + accent.
export const TASK_STATES = ["backlog", "triage", "todo", "ongoing", "review", "done"] as const;
export const TASK_STATE_META: Record<TaskState, { label: string; color: string }> = {
  backlog: { label: "BACKLOG", color: "var(--muted)" },
  triage: { label: "TRIAGE", color: "var(--info)" },
  todo: { label: "TODO", color: "var(--accent)" },
  ongoing: { label: "ONGOING", color: "var(--ok)" },
  review: { label: "REVIEW", color: "var(--warn)" },
  done: { label: "DONE", color: "var(--muted)" },
};

/** A project's tasks in one pipeline state, ordered by manual priority. */
export function tasksInState(tasks: Task[], projectId: string, state: TaskState): Task[] {
  return tasks
    .filter((t) => t.projectId === projectId && t.state === state)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
}

export const STATUS_META: Record<TaskRunStatus, { label: string; color: string }> = {
  running: { label: "RUNNING", color: "var(--ok)" },
  waiting: { label: "BLOCKED", color: "var(--warn)" },
  paused: { label: "PAUSED", color: "var(--muted)" },
  review: { label: "REVIEW", color: "var(--info)" },
  done: { label: "DONE", color: "var(--muted)" },
};

export const KIND_META: Record<HitlKind, { label: string; color: string }> = {
  approval: { label: "APPROVAL", color: "var(--warn)" },
  question: { label: "DECISION", color: "var(--info)" },
  plan: { label: "PLAN REVIEW", color: "var(--violet)" },
  diff: { label: "DIFF REVIEW", color: "var(--ok)" },
  merge: { label: "MERGE CONFLICT", color: "var(--danger)" },
};

export const providerInfo = (
  providers: ProviderInfo[],
  id: ProviderId,
): ProviderInfo =>
  providers.find((p) => p.id === id) ??
  ({ id, name: id, glyph: "✱", color: "var(--accent)", models: [] } as ProviderInfo);

// ─── provider readiness ──────────────────────────────────────────────────────
// Whether a provider can actually run right now, and if not, exactly what's
// missing. Combines the static requirements descriptor with the live signals the
// server attaches: `available` (a credential is configured — env or stored key)
// and `binOnPath` (the CLI binary was found on the server's PATH). Mirrors the
// orchestrator's real usability rule so the UI never enables something that
// can't run — nor disables a CLI-login provider that can. Falls back to the
// legacy `available` flag when an older server sends no requirements.
export interface ProviderReadiness {
  ready: boolean;
  /** Plain-English list of what's still needed (empty when ready). */
  missing: string[];
  /** True while a credential is configured (env var or stored key). */
  credentialSet: boolean;
}

export function providerReadiness(p: ProviderInfo): ProviderReadiness {
  const credentialSet = p.available !== false;
  const req = p.requirements;
  if (!req) return { ready: credentialSet, missing: credentialSet ? [] : ["setup"], credentialSet };

  const missing: string[] = [];
  if (req.runtime === "cli" && p.binOnPath !== true) {
    missing.push(`the ${req.bin ?? "provider"} CLI on PATH`);
  }
  // A credential is required unless the provider can authenticate via its own
  // CLI login (cursor/copilot).
  const authOk = credentialSet || req.cliLogin;
  if (!authOk) {
    const keys = req.authEnvVars.slice(0, 3).join(" / ");
    missing.push(keys ? `a credential (${keys})` : "a credential");
  }
  return { ready: missing.length === 0, missing, credentialSet };
}
