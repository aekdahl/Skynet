import type {
  Agent,
  AgentStatus,
  HitlItem,
  HitlKind,
  Module,
  ProviderId,
  ProviderInfo,
  Runner,
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

export const heartbeatSecs = (agent: Agent, now: number) =>
  Math.max(0, (now - agent.lastHeartbeatAt) / 1000);

export const startedMins = (agent: Agent, now: number) =>
  Math.max(0, (now - agent.startedAt) / 60000);

export const waitedSecs = (hitl: HitlItem, now: number) =>
  Math.max(0, (now - hitl.raisedAt) / 1000);

export function fmtElapsed(agent: Agent, now: number): string {
  const mins = Math.floor(startedMins(agent, now));
  const h = Math.floor(mins / 60);
  return `${h > 0 ? `${h}h ` : ""}${mins % 60}m elapsed`;
}

export function runnerIdleLabel(runner: Runner, now: number): string {
  if (runner.idleSince == null) return "now";
  const mins = Math.floor((now - runner.idleSince) / 60000);
  if (mins <= 0) return "now";
  const h = Math.floor(mins / 60);
  return h > 0 ? `${h}h ${mins % 60}m` : `${mins}m`;
}

// ─── plan helpers ───────────────────────────────────────────────────────────

export const curStep = (a: Agent) => {
  const s = a.plan.find((p) => p.state === "now");
  return s ? s.text : "complete";
};
export const stepIdx = (a: Agent) => {
  const i = a.plan.findIndex((p) => p.state === "now");
  return i < 0 ? a.plan.length : i;
};
export const planDone = (a: Agent) => a.plan.filter((p) => p.state === "done").length;

// ─── collection lookups ──────────────────────────────────────────────────────

export const agentsForProject = (agents: Agent[], projectId: string) =>
  agents.filter((a) => a.projectId === projectId);

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

export const hitlFor = (queue: HitlItem[], agentId: string) =>
  queue.find((q) => q.agentId === agentId && q.resolvedAt == null);

export const openQueue = (queue: HitlItem[]) =>
  queue.filter((q) => q.resolvedAt == null);

// ─── runner / fleet derivations ──────────────────────────────────────────────

export const runnerIsBusy = (runner: Runner, agents: Agent[]) =>
  runner.status === "busy" ||
  agents.some((a) => a.status !== "done" && a.runnerId === runner.id);

export const idleRunners = (fleet: Runner[], agents: Agent[]) =>
  fleet.filter((r) => !runnerIsBusy(r, agents));

export const runnerName = (agent: Agent, fleet: Runner[]) => {
  const r = fleet.find((f) => f.id === agent.runnerId);
  return r ? r.name : agent.runnerId ?? agent.id;
};

export const providerOf = (agent: Agent, fleet: Runner[]): ProviderId => {
  const r = fleet.find((f) => f.id === agent.runnerId);
  return r ? r.provider : agent.provider;
};

// ─── module name lookup ──────────────────────────────────────────────────────

export const modName = (modules: Module[], id: string) =>
  modules.find((m) => m.id === id)?.name ?? id;

// ─── conflict detection (families share a parent) ───────────────────────────

export const familyOf = (a: Agent) => a.parentId ?? a.id;

export function conflictModulesForAgent(agent: Agent, agents: Agent[]): string[] {
  if (agent.status === "done") return [];
  return agent.modules.filter((mod) =>
    agents.some(
      (other) =>
        other.id !== agent.id &&
        other.status !== "done" &&
        familyOf(other) !== familyOf(agent) &&
        other.modules.includes(mod),
    ),
  );
}

export function conflicts(agents: Agent[]): Array<[string, Agent[]]> {
  const byMod: Record<string, Agent[]> = {};
  agents
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

export const STATUS_META: Record<AgentStatus, { label: string; color: string }> = {
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
