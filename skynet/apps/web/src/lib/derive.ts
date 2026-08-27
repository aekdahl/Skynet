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
  Feature,
  Project,
} from "@skynet/shared";

// ─── time formatting ───────────────────────────────────────────────────────

// The one duration formatter for user-facing "how long X has been running / X
// ago" text — SINGLE UNIT ONLY. Rolls up at each boundary:
//   < 1m  → seconds  ("42s")
//   < 1h  → minutes  ("15m")   — never "15m 30s"
//   < 1d  → hours    ("2h")    — never "2h 45m"
//   ≥ 1d  → days     ("3d")    — never "3d 04h"
// This is deliberate: readers glance at time indicators, and stitching two
// units together ("504m 02s") crossed into cognitive-load territory. Use
// fmtDurMs below when the input is milliseconds. If you need higher precision
// for a debug view, add a purpose-built formatter — don't relax this rule.
export function fmtWait(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Same single-unit rule for callers that already have milliseconds. */
export const fmtDurMs = (ms: number): string => fmtWait(ms / 1000);

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
  return `${fmtWait((now - agent.startedAt) / 1000)} elapsed`;
}

export function runnerIdleLabel(runner: Agent, now: number): string {
  if (runner.idleSince == null) return "now";
  const sec = (now - runner.idleSince) / 1000;
  if (sec < 1) return "now";
  return fmtWait(sec);
}

// ─── plan helpers ───────────────────────────────────────────────────────────

// "complete" as a fallback here reads as a terminal state and contradicts a
// still-running run's own status elsewhere in the UI (DEF: Runs board showed
// "complete" on a row it also counted under "running"). No step in "now"
// means one of two different things, not one — say which.
export const curStep = (a: TaskRun) => {
  const s = a.plan.find((p) => p.state === "now");
  if (s) return s.text;
  return a.plan.length === 0 ? "starting…" : "wrapping up";
};
export const stepIdx = (a: TaskRun) => {
  const i = a.plan.findIndex((p) => p.state === "now");
  return i < 0 ? a.plan.length : i;
};
export const planDone = (a: TaskRun) => a.plan.filter((p) => p.state === "done").length;

// ─── collection lookups ──────────────────────────────────────────────────────

export const agentsForProject = (runs: TaskRun[], projectId: string) =>
  runs.filter((a) => a.projectId === projectId);

// Each task's CURRENT run is the one its `runId` points to. Re-running a task
// orphans its previous run — assignTask only mints a new run once the old one is
// `done`, and moves the task's runId to the new run — and the subway would draw
// that superseded original as a SECOND station for the same task (the "reassigned
// task duplicated" bug). Keep only current runs, plus fork runs, which are real
// branches on the map (a fork child carries `parentId`; its parent is referenced
// by that id). PURE — unit-tested.
export const activeProjectRuns = (runs: TaskRun[], tasks: Task[], projectId: string): TaskRun[] => {
  const mine = runs.filter((r) => r.projectId === projectId);
  const current = new Set(
    tasks.filter((t) => t.projectId === projectId && t.runId).map((t) => t.runId as string),
  );
  const forkParents = new Set(mine.filter((r) => r.parentId).map((r) => r.parentId as string));
  return mine.filter((r) => current.has(r.id) || r.parentId != null || forkParents.has(r.id));
};

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

// A project is "shipped" only when it HAS tasks and EVERY one is done — not
// merely when its runs are done. Unstarted backlog tasks have no run, so a
// runs-all-done check would badge a project shipped with work still in backlog.
export const projectShipped = (tasks: Task[], projectId: string): boolean => {
  const t = tasksForProject(tasks, projectId);
  return t.length > 0 && t.every((x) => x.state === "done");
};

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

/** Approving a `diff`/`merge` gate merges the run's work — this is true when
 *  no OTHER agent has recorded a review verdict on it yet, so Approve is
 *  worth a confirm ("merge without a review?") rather than silent one-click
 *  merging of completely unreviewed work. `verifier`/`approval`/`question`/
 *  `plan` gates don't represent a merge decision, so they're never flagged. */
export function needsReviewConfirm(item: HitlItem, tasks: Task[]): boolean {
  if (item.kind !== "diff" && item.kind !== "merge") return false;
  const task = tasks.find((t) => t.runId === item.runId);
  return !task?.reviewVerdict;
}

export const openQueue = (queue: HitlItem[]) =>
  queue.filter((q) => q.resolvedAt == null);

/** Inbox ordering: approvals (a live gate is blocking a run's own progress —
 *  approve/reject/modify unblocks it right now) before escalations (the
 *  agent already handed back its compute — see orchestrator.ts's escalate()
 *  — so nothing is actively held up, including a stuck-review card that's
 *  already "done, awaiting review"), each sorted longest-waiting-first
 *  within its group. A single flat array, not two separately-indexed lists —
 *  QueueView's keyboard nav (j/k/a/r/m) and `selectedIdx` index straight into
 *  it; callers detect the group boundary from `item.kind` themselves to
 *  render section headers. */
export function sortForInbox(items: HitlItem[], now: number): HitlItem[] {
  return items.slice().sort((a, b) => {
    const ag = a.kind === "escalation" ? 1 : 0;
    const bg = b.kind === "escalation" ? 1 : 0;
    return ag !== bg ? ag - bg : waitedSecs(b, now) - waitedSecs(a, now);
  });
}

// Runs whose PR is open and awaiting a human merge decision (not set aside) —
// the ready-to-merge list. Newest PR first.
export const readyMerges = (runs: TaskRun[]) =>
  runs
    .filter((r) => r.pr?.state === "open" && !r.pr.dismissed)
    .sort((a, b) => (b.pr!.openedAt ?? 0) - (a.pr!.openedAt ?? 0));

// Features whose aggregate PR is open and awaiting a human merge decision
// (feature-scoped branch batching — one PR per completed Feature, not per
// task). Same shape/sort as readyMerges, over the already-synced store list.
export const readyFeatureMerges = (features: Feature[]) =>
  features
    .filter((f) => f.pr?.state === "open" && !f.pr.dismissed)
    .sort((a, b) => (b.pr!.openedAt ?? 0) - (a.pr!.openedAt ?? 0));

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

// Resolve an arbitrary fleet agent id (e.g. MergeBriefing.authoredBy/
// reviewedBy — not tied to a TaskRun the way `runnerName` is) to its display
// name. Falls back to the id itself when the agent isn't found (retired,
// archived) or "heuristic" is passed through unchanged (not an agent id).
export const fleetAgentName = (id: string | null | undefined, fleet: Agent[]): string | null => {
  if (!id) return null;
  return fleet.find((f) => f.id === id)?.name ?? id;
};

// Resolve a project id to its display name (e.g. for a cross-project list —
// Ready to merge, Audit — where a card needs to say which project it's from).
export const projectName = (id: string, projects: Project[]): string =>
  projects.find((p) => p.id === id)?.name ?? id;

export const providerOf = (agent: TaskRun, fleet: Agent[]): ProviderId => {
  const r = fleet.find((f) => f.id === agent.agentId);
  return r ? r.provider : agent.provider;
};

// ─── cost/usage roll-ups (per-project header, per-runner in Fleet) ──────────
// PURE, unit-tested — computed client-side from `runs` (not server-derived on
// the snapshot, unlike e.g. parallelismNudge) because `runs` is kept live by
// per-delta patches (run.usage, run.status, …; see store.tsx's reducer), while
// a snapshot only lands at connect/reconnect. A snapshot-only rollup would
// freeze mid-session — wrong for a running cost meter, and a regression from
// ProjectStats' existing live per-project total (project.tsx), which this
// replaces to share one tested implementation instead of two.
//
// `costUsd`/`durationMs` are null when NO run in the group reported one — kept
// separate from `uncostedRuns` (runs with no report at all) so a caller can
// render "$0.00" only when that's really what happened, never for "unknown."
export interface UsageRollup {
  runCount: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
  durationMs: number | null;
  uncostedRuns: number;
}

function emptyRollup(): UsageRollup {
  return { runCount: 0, tokensIn: 0, tokensOut: 0, costUsd: null, durationMs: null, uncostedRuns: 0 };
}

function addRun(roll: UsageRollup, r: TaskRun): void {
  roll.runCount++;
  const u = r.usage;
  if (!u) {
    roll.uncostedRuns++;
    return;
  }
  roll.tokensIn += u.inputTokens;
  roll.tokensOut += u.outputTokens;
  if (u.costUsd != null) roll.costUsd = (roll.costUsd ?? 0) + u.costUsd;
  else roll.uncostedRuns++;
  if (u.durationMs != null) roll.durationMs = (roll.durationMs ?? 0) + u.durationMs;
}

/** Sums token/cost/duration usage across runs, grouped by project and by agent. Archived runs are excluded, matching the rest of the UI's roll-ups. */
export function computeUsageRollup(runs: TaskRun[]): {
  byProject: Record<string, UsageRollup>;
  byAgent: Record<string, UsageRollup>;
} {
  const byProject: Record<string, UsageRollup> = {};
  const byAgent: Record<string, UsageRollup> = {};
  for (const r of runs) {
    if (r.archived) continue;
    addRun((byProject[r.projectId] ??= emptyRollup()), r);
    if (r.agentId) addRun((byAgent[r.agentId] ??= emptyRollup()), r);
  }
  return { byProject, byAgent };
}

export function fmtNum(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return (n / 1_000).toFixed(n < 10_000 ? 1 : 0) + "k";
  return (n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0) + "M";
}
export function fmtCost(usd: number): string {
  if (usd < 0.01) return "<$0.01";
  if (usd < 1) return "$" + usd.toFixed(2);
  if (usd < 100) return "$" + usd.toFixed(2);
  return "$" + Math.round(usd).toLocaleString();
}

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
export const TASK_STATE_META: Record<TaskState, { label: string; color: string; hint?: string }> = {
  backlog: { label: "BACKLOG", color: "var(--muted)" },
  // A task lands here when autonomy's triage step read its assessment as
  // unclear (or backlog is being triaged with no clear signal at all) — it
  // does NOT get re-visited automatically: the triage step only ever looks at
  // `backlog`-state tasks, never `triage`-state ones. Moving it on to Todo (or
  // back to Backlog) is a human call every time.
  triage: {
    label: "TRIAGE",
    color: "var(--info)",
    hint: "Parked here because the autonomy assessment was unclear. Nothing re-checks a parked task automatically — move it to Todo (or back to Backlog) yourself when it's ready.",
  },
  todo: { label: "TODO", color: "var(--accent)" },
  ongoing: { label: "ONGOING", color: "var(--ok)" },
  review: { label: "REVIEW", color: "var(--warn)" },
  done: { label: "DONE", color: "var(--muted)" },
};

/** A project's tasks in one pipeline state, ordered by manual priority.
 *  Archived tasks are soft-hidden — kept in the store but excluded from the board. */
export function tasksInState(tasks: Task[], projectId: string, state: TaskState): Task[] {
  return tasks
    .filter((t) => t.projectId === projectId && t.state === state && !t.archived)
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
  escalation: { label: "NEEDS HELP", color: "var(--danger)" },
  verifier: { label: "CHECKS FAILED", color: "var(--danger)" },
};

/** A `stuck-review` escalation (orchestrator.ts's reapStuckReviews) means the
 *  run already finished and reached review — nothing failed, there's just no
 *  open gate pointing at it. It's the one `escalation` case that means "done,
 *  awaiting your review", not "something's wrong" — so it gets its own calm
 *  label instead of KIND_META's alarm-red "NEEDS HELP". */
export function isStuckReview(item: HitlItem): boolean {
  return item.kind === "escalation" && (item.flags ?? []).includes("stuck-review");
}

export function hitlHeadline(item: HitlItem): { label: string; color: string } {
  return isStuckReview(item) ? { label: "AWAITING REVIEW", color: "var(--ok)" } : KIND_META[item.kind];
}

// ─── runs board row classification ──────────────────────────────────────────

export type RunTag = "running" | "blocked" | "paused" | "done";

// A live run heartbeats every ~5s (CliRunnerHandle / the Claude runner's own
// interval); the server's own reaper (SKYNET_AGENT_REAP_MS) presumes a
// running/waiting agent dead after 180s of silence and escalates it. 60s is
// the visual early-warning line: 12x the normal cadence (so ordinary jitter
// never false-flags a healthy run), but a full two minutes' notice before the
// reaper would actually act — the operator sees "this looks stuck" before
// Skynet decides it IS stuck.
export const STALE_HEARTBEAT_SEC = 60;

// Classifies one run for the global Runs dashboard: which bucket it's in, what
// its status cell says, and how to sort it. PURE — unit-tested.
//
// The `r.status !== "running" && stale` branch exists for a run whose OWN
// status says it's no longer actively running (e.g. `review`) and whose
// heartbeat has gone stale — with no open HITL to explain why (the branch
// above would've caught it if there were one). That's a dead end: a run left
// in `review` with nothing pending a decision (see orchestrator.ts's
// fail()/gcWorktrees fix). Falling through to the generic "running" bucket
// there is actively misleading — reported live as a run reading "starting…"
// with a growing elapsed clock 20+ hours in. It isn't running and won't
// finish on its own, so it's classified with the same urgency as an open HITL.
export function classifyRun(
  r: TaskRun,
  hitl: HitlItem | undefined,
  now: number,
  staleAfterSec: number,
): { tag: RunTag; statusLabel: string; timeLabel: string; sortKey: number } {
  if (r.status === "done") {
    return { tag: "done", statusLabel: "done", timeLabel: "—", sortKey: -r.lastHeartbeatAt };
  }
  if (hitl) {
    const waited = waitedSecs(hitl, now);
    return {
      tag: "blocked",
      statusLabel: hitlHeadline(hitl).label.toLowerCase(),
      timeLabel: `${fmtWait(waited)} waiting`,
      sortKey: -waited, // longest-waiting first
    };
  }
  if (r.status === "paused") {
    const idle = heartbeatSecs(r, now);
    return { tag: "paused", statusLabel: "paused", timeLabel: `${fmtWait(idle)} ago`, sortKey: idle };
  }
  if (r.status !== "running" && heartbeatSecs(r, now) > staleAfterSec) {
    const stuckFor = heartbeatSecs(r, now);
    return {
      tag: "blocked",
      statusLabel: `stuck in ${r.status} — no pending decision`,
      timeLabel: `${fmtWait(stuckFor)} ago`,
      sortKey: -stuckFor, // longest-stuck first, same ordering as an open HITL
    };
  }
  const elapsed = (now - r.startedAt) / 1000;
  return { tag: "running", statusLabel: curStep(r), timeLabel: `${fmtWait(elapsed)} elapsed`, sortKey: elapsed };
}

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

// `credentialOverride` lets a caller that has a FRESHER credential signal than
// the snapshot (the Settings view re-fetches the secret store on mount) drive the
// badge from that instead of the snapshot's `available`. Without it, the snapshot
// and a just-set key can disagree — the card would show the stored key in its
// pill while the badge still claimed "needs a credential". Omit it to keep the
// snapshot-driven behavior (Fleet / Home have no fresher source).
export function providerReadiness(p: ProviderInfo, credentialOverride?: boolean): ProviderReadiness {
  const credentialSet = credentialOverride ?? p.available !== false;
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

// ─── Spend efficiency: how much of what we paid for actually shipped ────────
// Reconciling a month of real spend surfaced the number that matters most and
// wasn't anywhere in the UI: only a fraction of tokens paid for end up as
// merged work. The rest is runs that stalled, were stopped, or finished
// without ever landing. That ratio is the single best signal for whether the
// fleet is worth what it costs — and it's invisible unless it's shown.
//
// PURE derivation over runs already in the snapshot: no new API, no new
// storage. `costUsd` is null for runs whose provider didn't price them (and,
// before the accounting fix, for runs that never reported at all) — those
// contribute 0 to the totals but still count in `runs`, so a low
// `pricedShare` is the honest signal that these numbers are under-reported
// rather than a silently confident wrong answer.

export type SpendOutcome = "delivered" | "in-flight" | "abandoned";

export interface SpendBucket {
  outcome: SpendOutcome;
  runs: number;
  costUsd: number;
  /** Share of total attributed spend, 0..1. */
  share: number;
}

export interface SpendEfficiency {
  buckets: SpendBucket[];
  totalUsd: number;
  /** Share of spend that reached a merge, 0..1 — the headline number. */
  deliveredShare: number;
  /** How much of the spend we can actually see a price for, 0..1. Below ~1
   *  the other figures are a floor, not a total. */
  pricedShare: number;
  runs: number;
}

/** Which bucket a run falls in. A merge is the only evidence of delivery;
 *  anything still moving is in-flight; everything else was paid for and
 *  didn't land (stalled, reaped, stopped, or finished without merging). */
export function spendOutcomeOf(run: TaskRun): SpendOutcome {
  if (run.mergedAt) return "delivered";
  if (!run.archived && (run.status === "running" || run.status === "waiting" || run.status === "review")) {
    return "in-flight";
  }
  return "abandoned";
}

export function spendEfficiency(runs: TaskRun[]): SpendEfficiency {
  const order: SpendOutcome[] = ["delivered", "in-flight", "abandoned"];
  const tally = new Map<SpendOutcome, { runs: number; costUsd: number }>(
    order.map((o) => [o, { runs: 0, costUsd: 0 }]),
  );
  let priced = 0;
  for (const r of runs) {
    const b = tally.get(spendOutcomeOf(r))!;
    b.runs++;
    const c = r.usage?.costUsd;
    if (typeof c === "number") {
      b.costUsd += c;
      priced++;
    }
  }
  const totalUsd = order.reduce((n, o) => n + tally.get(o)!.costUsd, 0);
  const buckets = order.map((outcome) => {
    const t = tally.get(outcome)!;
    return { outcome, runs: t.runs, costUsd: t.costUsd, share: totalUsd > 0 ? t.costUsd / totalUsd : 0 };
  });
  return {
    buckets,
    totalUsd,
    deliveredShare: totalUsd > 0 ? tally.get("delivered")!.costUsd / totalUsd : 0,
    pricedShare: runs.length > 0 ? priced / runs.length : 1,
    runs: runs.length,
  };
}
