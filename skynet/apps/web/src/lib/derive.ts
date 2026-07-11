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
  tasks.filter((t) => t.projectId === projectId && t.state === "backlog");

export const doneTasks = (tasks: Task[], projectId: string) =>
  tasks.filter((t) => t.projectId === projectId && t.state === "done");

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
