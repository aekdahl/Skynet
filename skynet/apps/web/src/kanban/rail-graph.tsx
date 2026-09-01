// ─── Rail Graph (Phase 11 — TASK 12) ───────────────────────────────────────
// The third board metaphor: the SAME Transition/Rule/Proposal data Momentum
// (board.tsx) and Gravity (gravity.tsx) already read, rendered as a
// commit-graph-style stream — one colored vertical "trunk" per Feature, a
// node on that trunk for every Transition affecting one of its tasks. The
// Transition log is already shaped like a commit graph (taskId, from, to,
// actor, ruleId, evidence, at) — this renders it directly, it doesn't derive
// a separate graph structure from scratch.
import { useEffect, useMemo, useState } from "react";
import type { Task, TaskRun, TaskState, Transition } from "@skynet/shared";
import { readiness, type TaskCheckpoints } from "@skynet/shared";
import * as api from "../lib/client";
import { useStore } from "../lib/store";
import { fmtDurMs, TASK_STATE_META } from "../lib/derive";
import type { MomentumBoardProps } from "./board";

// ── pure helpers ─────────────────────────────────────────────────────────

function startOfDayMs(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const DAY_MS = 24 * 60 * 60 * 1000;

function dayLabel(dayStartMs: number, now: number): string {
  const today = startOfDayMs(now);
  if (dayStartMs === today) return "Today";
  if (dayStartMs === today - DAY_MS) return "Yesterday";
  return new Date(dayStartMs).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const STATE_ORDER: Record<TaskState, number> = { backlog: 0, triage: 1, todo: 2, ongoing: 3, review: 4, done: 5 };

/** Real checkpoint booleans from the same TaskRun/Task fields Momentum's
 *  deriveCheckpointSteps and Gravity's own deriveTaskCheckpoints read — no
 *  persisted checkpoint record exists (TaskCheckpoints is resolved by the
 *  caller each time, never stored), so this is the Rail Graph's own reading
 *  of the same signals, same small local copy gravity.tsx's own comment
 *  already justifies ("duplicated here rather than shared, since it's a
 *  handful of lines"). */
function deriveTaskCheckpoints(run: TaskRun | undefined, task: Task, lastSignalAt: number): TaskCheckpoints {
  return {
    branch: !!run,
    pr: !!run?.pr,
    review: task.reviewVerdict?.decision === "approve",
    merged: run?.mergedAt != null,
    deployed: !!run?.flyDeployment,
    lastSignalAt,
  };
}

/** Mirrors the rule engine's own lastSignalAt / Gravity's lastSignalAtFor. */
function lastSignalAtFor(taskId: string, transitions: Transition[], run: TaskRun | undefined, fallbackNow: number): number {
  let latest = 0;
  for (const t of transitions) if (t.taskId === taskId && t.at > latest) latest = t.at;
  if (latest > 0) return latest;
  if (run) return Math.max(run.lastHeartbeatAt ?? 0, run.startedAt ?? 0);
  return fallbackNow;
}

const NO_EPIC_LANE_ID = "__no_epic__";
// Feature.color is nullable (kanban.ts) — a real epic with no assigned color,
// and the synthetic "No epic" lane, both fall back to this neutral token
// rather than fabricating a color the operator never picked.
const FALLBACK_LANE_COLOR = "var(--ak-track)";

interface Lane {
  id: string;
  name: string;
  color: string;
}

type StreamRowKind = "advance" | "stall" | "auto-split" | "note";

interface StreamRow {
  key: string;
  at: number;
  laneId: string;
  kind: StreamRowKind;
  transition?: Transition;
  task?: Task;
  autoSplit?: { parent: Task; children: Task[] };
}

/** The row's one-sentence description — mirrors feed.tsx's own describe():
 *  a real move reads "moved from X to Y"; a non-move (add_label/
 *  post_slack_nudge/create_proposal/failed) falls back to the LAST evidence
 *  entry, which is the action's own result text (evidence[0] is always just
 *  the generic trigger — see feed.tsx's own doc comment on this exact gap). */
function describeTransition(t: Transition, taskText: string): string {
  if (t.from !== t.to) {
    const fromLabel = TASK_STATE_META[t.from]?.label ?? t.from;
    const toLabel = TASK_STATE_META[t.to]?.label ?? t.to;
    return `${taskText} moved from ${fromLabel} to ${toLabel}`;
  }
  return `${taskText} — ${t.evidence[t.evidence.length - 1] ?? "action recorded"}`;
}

// ── board ────────────────────────────────────────────────────────────────

export function RailGraphBoard({ project, tasks, runs, features, now, onOpenTask, onOpenFeed }: MomentumBoardProps & { onOpenFeed: () => void }) {
  const { proposals, transitions: liveTransitions, rules, pauseAllRules } = useStore();

  const runById = useMemo(() => new Map(runs.map((r) => [r.id, r])), [runs]);
  const projectTasks = useMemo(() => tasks.filter((t) => t.projectId === project.id && !t.archived), [tasks, project.id]);
  const taskById = useMemo(() => new Map(projectTasks.map((t) => [t.id, t])), [projectTasks]);
  const projectFeatures = useMemo(() => features.filter((f) => f.projectId === project.id && !f.archived), [features, project.id]);

  // Same fetch-once-then-merge-with-live pattern as Momentum/Gravity —
  // Snapshot doesn't carry Transitions (see store.tsx). TASK 13's loading
  // gate: without it, "still loading" and "genuinely no history" would both
  // render as an identical empty stream.
  const [fetchedTransitions, setFetchedTransitions] = useState<Transition[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    setLoading(true);
    api.fetchProjectTransitions(project.id, { limit: 500 })
      .then((t) => { if (live) setFetchedTransitions(t); })
      .catch(() => undefined)
      .finally(() => { if (live) setLoading(false); });
    return () => {
      live = false;
    };
  }, [project.id]);
  const transitions = useMemo(() => {
    const byId = new Map(fetchedTransitions.map((t) => [t.id, t]));
    for (const t of liveTransitions) if (t.projectId === project.id) byId.set(t.id, t);
    return [...byId.values()];
  }, [fetchedTransitions, liveTransitions, project.id]);

  // Stalled tasks: same derivation as board.tsx's own stallByTaskId — a
  // pending stall_nudge Proposal names its task by id in its payload.
  const stallByTaskId = useMemo(() => {
    const map = new Map<string, { staleHours: number }>();
    for (const p of proposals) {
      if (p.kind !== "stall_nudge" || p.status !== "pending" || p.projectId !== project.id) continue;
      const payload = p.payload as { taskId?: unknown; staleHours?: unknown } | null;
      if (payload && typeof payload.taskId === "string" && typeof payload.staleHours === "number") {
        map.set(payload.taskId, { staleHours: payload.staleHours });
      }
    }
    return map;
  }, [proposals, project.id]);

  // ── lanes: one trunk per Feature, plus a synthetic "No epic" trunk for
  // tasks with no featureId — real historical data always has some. ────────
  const lanes: Lane[] = useMemo(() => {
    const featureLanes = projectFeatures.map((f) => ({ id: f.id, name: f.name, color: f.color ?? FALLBACK_LANE_COLOR }));
    return [...featureLanes, { id: NO_EPIC_LANE_ID, name: "No epic", color: FALLBACK_LANE_COLOR }];
  }, [projectFeatures]);
  const laneIndexById = useMemo(() => new Map(lanes.map((l, i) => [l.id, i])), [lanes]);

  // ── stream rows: every Transition, plus a synthetic "auto-split" row per
  // parent task that has gained children (Task.parentTaskId), positioned at
  // the parent's own most recent Transition (or `now`, if it has none yet —
  // still renders, just at the top of the stream rather than unpositioned). ─
  const rows: StreamRow[] = useMemo(() => {
    const out: StreamRow[] = [];
    for (const t of transitions) {
      const task = taskById.get(t.taskId);
      const laneId = task?.featureId && laneIndexById.has(task.featureId) ? task.featureId : NO_EPIC_LANE_ID;
      out.push({ key: t.id, at: t.at, laneId, kind: stallByTaskId.has(t.taskId) ? "stall" : "advance", transition: t, task });
    }
    const childrenByParent = new Map<string, Task[]>();
    for (const t of projectTasks) {
      if (!t.parentTaskId) continue;
      const arr = childrenByParent.get(t.parentTaskId) ?? [];
      arr.push(t);
      childrenByParent.set(t.parentTaskId, arr);
    }
    for (const [parentId, children] of childrenByParent) {
      const parent = taskById.get(parentId);
      if (!parent) continue; // parent archived/deleted since — nothing to anchor this row on
      const laneId = parent.featureId && laneIndexById.has(parent.featureId) ? parent.featureId : NO_EPIC_LANE_ID;
      const parentTransitionTimes = transitions.filter((t) => t.taskId === parentId).map((t) => t.at);
      const at = parentTransitionTimes.length > 0 ? Math.max(...parentTransitionTimes) : now;
      out.push({ key: `split-${parentId}`, at, laneId, kind: "auto-split", task: parent, autoSplit: { parent, children } });
    }
    return out.sort((a, b) => b.at - a.at);
  }, [transitions, taskById, laneIndexById, stallByTaskId, projectTasks, now]);

  const grouped = useMemo(() => {
    const byDay = new Map<number, StreamRow[]>();
    for (const r of rows) {
      const day = startOfDayMs(r.at);
      const arr = byDay.get(day) ?? [];
      arr.push(r);
      byDay.set(day, arr);
    }
    return [...byDay.entries()].sort((a, b) => b[0] - a[0]).map(([day, dayRows]) => ({ key: day, label: dayLabel(day, now), rows: dayRows }));
  }, [rows, now]);

  // ── right rail: per-epic health (avg readiness across constituent tasks —
  // computed on render, nothing stored) + today's "what the board did" tally.
  const healthByLane = useMemo(() => {
    const map = new Map<string, { pct: number | null; taskCount: number }>();
    for (const lane of lanes) {
      const laneTasks = projectTasks.filter((t) => (t.featureId && laneIndexById.has(t.featureId) ? t.featureId : NO_EPIC_LANE_ID) === lane.id);
      if (laneTasks.length === 0) {
        map.set(lane.id, { pct: null, taskCount: 0 });
        continue;
      }
      let sum = 0;
      for (const t of laneTasks) {
        const run = t.runId ? runById.get(t.runId) : undefined;
        const lastSignalAt = lastSignalAtFor(t.id, transitions, run, now);
        sum += readiness(t, deriveTaskCheckpoints(run, t, lastSignalAt), now).score;
      }
      map.set(lane.id, { pct: Math.round((sum / laneTasks.length) * 100), taskCount: laneTasks.length });
    }
    return map;
  }, [lanes, projectTasks, laneIndexById, runById, transitions, now]);

  const todayStart = startOfDayMs(now);
  const machineToday = transitions.filter((t) => t.actor === "machine" && t.at >= todayStart).length;
  const liveRuleCount = useMemo(() => rules.filter((r) => r.projectId === project.id && r.state === "live" && !r.archived).length, [rules, project.id]);

  const [confirmingPause, setConfirmingPause] = useState(false);
  const [pausing, setPausing] = useState(false);
  const handlePauseAll = async () => {
    setPausing(true);
    try {
      await pauseAllRules(project.id);
    } finally {
      setPausing(false);
      setConfirmingPause(false);
    }
  };

  return (
    <div className="rg-wrap">
      <div className="rg-grid">
        {loading ? (
          <div className="rg-skel" aria-busy="true">
            <span className="ak-skel-row" style={{ width: "70%" }} />
            <span className="ak-skel-row" style={{ width: "50%" }} />
            <span className="ak-skel-row" style={{ width: "60%" }} />
          </div>
        ) : grouped.length === 0 ? (
          <div className="rg-empty kb-empty">No activity yet.</div>
        ) : (
          grouped.map((g) => (
            <div key={g.key} className="rg-day-group">
              <div className="rg-rail-date mono">{g.label}</div>
              <div className="rg-stream">
                {g.rows.map((row) => (
                  <RailEntry key={row.key} row={row} lanes={lanes} laneIndexById={laneIndexById} now={now} onOpenTask={onOpenTask} />
                ))}
              </div>
            </div>
          ))
        )}

        <div className="rg-side">
          <div className="rg-side-card">
            <div className="rg-side-head">Epic health</div>
            {lanes.every((l) => (healthByLane.get(l.id)?.taskCount ?? 0) === 0) ? (
              <p className="rg-side-hint">No tasks yet.</p>
            ) : (
              lanes.map((l) => {
                const h = healthByLane.get(l.id);
                if (!h || h.taskCount === 0) return null;
                return (
                  <div key={l.id} className="rg-health-row">
                    <span className="rg-health-label" style={{ color: l.color }} title={`${h.taskCount} task${h.taskCount === 1 ? "" : "s"}`}>
                      {l.name}
                    </span>
                    <div className="rg-health-track">
                      <div className="rg-health-fill" style={{ width: `${h.pct ?? 0}%`, background: l.color }} />
                    </div>
                    <span className="rg-health-pct mono">{h.pct}%</span>
                  </div>
                );
              })
            )}
          </div>

          <div className="rg-side-card">
            <div className="rg-side-head">What the board did for you</div>
            <p className="rg-side-summary">
              <strong>{machineToday}</strong> machine move{machineToday === 1 ? "" : "s"} today · <strong>{liveRuleCount}</strong> rule{liveRuleCount === 1 ? "" : "s"} live
            </p>
            <div className="rg-side-actions">
              <button className="btn btn-primary btn-sm" onClick={onOpenFeed}>
                open feed
              </button>
              {!confirmingPause ? (
                <button className="btn btn-ghost btn-sm" disabled={liveRuleCount === 0} onClick={() => setConfirmingPause(true)}>
                  pause rules
                </button>
              ) : (
                <span className="rg-pause-confirm">
                  <span className="rg-pause-confirm-copy">Pause {liveRuleCount} live rule{liveRuleCount === 1 ? "" : "s"}?</span>
                  <button className="btn btn-danger btn-sm" disabled={pausing} onClick={() => void handlePauseAll()}>
                    {pausing ? "pausing…" : "confirm"}
                  </button>
                  <button className="btn btn-ghost btn-sm" disabled={pausing} onClick={() => setConfirmingPause(false)}>
                    cancel
                  </button>
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** `onOpenTask` (MomentumBoardProps, ultimately App.tsx's `openTask`) is a
 *  misleading name — it always navigates by RUN id (`setRunId(id);
 *  setView("task")`, apps/views/task.tsx resolves everything off that id,
 *  no task-id fallback exists). GravityCard's own onClick
 *  (`onOpenTask(task.id)`, gravity.tsx) passes a raw TASK id into it — a
 *  pre-existing bug in already-shipped Gravity (TASK 11), out of scope to
 *  fix here (see this task's own constraints), but not one to copy: every
 *  call site below uses `task.runId` and degrades to plain, non-interactive
 *  content when a task has none — the common case for anything that hasn't
 *  started a run yet, which is most of a fresh project's history. */
function RailEntry({
  row,
  lanes,
  laneIndexById,
  now,
  onOpenTask,
}: {
  row: StreamRow;
  lanes: Lane[];
  laneIndexById: Map<string, number>;
  now: number;
  onOpenTask: (id: string) => void;
}) {
  const laneIndex = laneIndexById.get(row.laneId) ?? 0;
  const lane = lanes[laneIndex];
  const ago = fmtDurMs(Math.max(0, now - row.at));

  return (
    <div className="rg-entry">
      <div className="rg-lanes" style={{ width: lanes.length * 20 }}>
        {lanes.map((l, i) => (
          <span key={l.id} className="rg-lane-line" style={i === laneIndex ? { borderColor: l.color } : undefined}>
            {i === laneIndex && <span className="rg-lane-node" style={{ background: lane?.color }} />}
          </span>
        ))}
      </div>

      {row.kind === "auto-split" && row.autoSplit ? (
        <div className="rg-card rg-card-split">
          <div className="rg-card-head">
            <span className="rg-card-kind mono">EPIC AUTO-SPLIT</span>
            <span className="rg-card-time mono">{ago}</span>
          </div>
          <p className="rg-card-sentence">
            <strong>{row.autoSplit.parent.text}</strong> split into {row.autoSplit.children.length} subtask{row.autoSplit.children.length === 1 ? "" : "s"}
          </p>
          <div className="rg-split-pills">
            {row.autoSplit.children.map((c) =>
              c.runId ? (
                <button key={c.id} className="rg-split-pill" onClick={() => onOpenTask(c.runId!)}>
                  {c.text}
                </button>
              ) : (
                <span key={c.id} className="rg-split-pill rg-split-pill-static" title="No run started yet">
                  {c.text}
                </span>
              ),
            )}
          </div>
        </div>
      ) : row.kind === "stall" && row.task ? (
        <div className="rg-card rg-card-stall">
          <div className="rg-card-head">
            <span className="rg-card-kind mono rg-card-kind-warn">STALLED</span>
            <span className="rg-card-time mono">{ago}</span>
          </div>
          <p className="rg-card-sentence">{row.transition ? describeTransition(row.transition, row.task.text) : row.task.text}</p>
          <button
            className="rg-reassign-btn"
            disabled={!row.task.runId}
            title={row.task.runId ? undefined : "No run started yet — nothing to reassign"}
            onClick={() => row.task!.runId && onOpenTask(row.task!.runId)}
          >
            REASSIGN?
          </button>
        </div>
      ) : row.transition && row.task ? (
        <div
          className={
            "rg-card" +
            (row.transition.status === "failed"
              ? " rg-card-failed"
              : STATE_ORDER[row.transition.to] > STATE_ORDER[row.transition.from]
                ? " rg-card-advance"
                : "")
          }
        >
          <div className="rg-card-head">
            <span className="rg-card-kind mono">{row.transition.actor === "machine" ? "MACHINE" : "HUMAN"}</span>
            <span className="rg-card-time mono">{ago}</span>
          </div>
          <p className="rg-card-sentence">
            {row.task.runId ? (
              <button className="rg-card-link" onClick={() => onOpenTask(row.task!.runId!)}>
                {describeTransition(row.transition, row.task.text)}
              </button>
            ) : (
              describeTransition(row.transition, row.task.text)
            )}
          </p>
          {row.transition.status === "failed" && row.transition.failureReason && (
            <p className="rg-card-fail-reason">{row.transition.failureReason}</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
