// ─── Activity Feed (Phase 6b — TASK 08) ────────────────────────────────────
// A live, readable log of every MACHINE action on this project — the same
// Transition feed the Momentum Board's automation pill counts from (see
// board.tsx), just read differently: every row here, not a rollup number.
// Fetched once per project (Snapshot doesn't carry Transition history — it's
// an append-only feed, not current state) and kept live via the
// `transition.created` WS delta (store.tsx's `transitions`), same pattern as
// board.tsx's own fetch+merge.
import { useEffect, useMemo, useState } from "react";
import type { PendingRuleAction, Project, Rule, Task, Transition } from "@skynet/shared";
import * as api from "../lib/client";
import { useStore } from "../lib/store";
import { fmtDurMs, TASK_STATE_META } from "../lib/derive";
import { STALL_ESCALATE_HOURS_DEFAULT } from "./board";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

function startOfDayMs(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dayGroup(at: number, now: number): "Today" | "Yesterday" | "Earlier" {
  const today = startOfDayMs(now);
  if (at >= today) return "Today";
  if (at >= today - DAY_MS) return "Yesterday";
  return "Earlier";
}

/** The row's one-sentence description — a real state move reads "moved from
 *  X to Y"; a non-move action (add_label / post_slack_nudge / create_proposal
 *  — see rules/engine.ts's applyAction) has `from === to` by construction
 *  (nothing to move), so it falls back to evidence text instead of claiming a
 *  move that didn't happen. `evidence` is always `[trigger, actionResult]`
 *  (createPendingAction/executeAction append the action's own result onto the
 *  trigger description) — the LAST entry is what the action actually did;
 *  evidence[0] is only ever the generic trigger ("task.upserted → backlog"),
 *  confirmed against a live create_proposal transition during manual testing. */
function describe(t: Transition, taskText: string): { subject: string; rest: string } {
  if (t.from !== t.to) {
    const fromLabel = TASK_STATE_META[t.from]?.label ?? t.from;
    const toLabel = TASK_STATE_META[t.to]?.label ?? t.to;
    return { subject: taskText, rest: `moved from ${fromLabel} to ${toLabel}` };
  }
  return { subject: taskText, rest: t.evidence[t.evidence.length - 1] ?? "action recorded" };
}

interface FeedRowProps {
  transition: Transition;
  task: Task | undefined;
  rule: Rule | undefined;
  pending: PendingRuleAction | undefined; // finalized + still-undoable, matched by transitionId
  stalled: { staleHours: number } | undefined;
  now: number;
  onOpenTask: (id: string) => void;
  onUndo: (pendingId: string) => void;
  undoing: boolean;
  onRetry: (ruleId: string, taskId: string) => void;
  retrying: boolean;
}

function FeedRow({ transition, task, rule, pending, stalled, now, onOpenTask, onUndo, undoing, onRetry, retrying }: FeedRowProps) {
  const failed = transition.status === "failed";
  const { subject, rest } = describe(transition, task?.text ?? "a task");
  const ruleLabel = rule ? rule.name : transition.ruleId ? "rule" : "Skynet";
  const ago = fmtDurMs(Math.max(0, now - transition.at));

  const undoable = !failed && pending && pending.status === "finalized" && pending.undoableUntil != null && pending.undoableUntil > now;
  const undoLeft = undoable ? fmtDurMs(Math.max(0, pending!.undoableUntil! - now)) : null;
  const escalateIn = !failed && !undoable && stalled ? STALL_ESCALATE_HOURS_DEFAULT - stalled.staleHours : null;

  return (
    <div className={"feed-row" + (failed ? " feed-row-failed" : "")}>
      <div className="feed-row-sentence">
        <strong>{subject}</strong> {failed ? <span className="feed-row-failtext">{rest}</span> : rest}
      </div>
      <div className="feed-row-meta mono">
        {ruleLabel} · {ago}
      </div>
      <div className="feed-row-action">
        {failed && transition.ruleId ? (
          <button className="feed-retry" disabled={retrying} onClick={() => onRetry(transition.ruleId!, transition.taskId)}>
            {retrying ? "retrying…" : "retry"}
          </button>
        ) : undoable ? (
          <button className="feed-undo" disabled={undoing} onClick={() => onUndo(pending!.id)}>
            {undoing ? "undoing…" : `undo · ${undoLeft} left`}
          </button>
        ) : escalateIn != null ? (
          <span className="feed-escalate">{escalateIn > 0 ? `escalates in ${fmtDurMs(escalateIn * HOUR_MS)}` : "escalating…"}</span>
        ) : transition.to === "review" && task ? (
          <button className="feed-review" onClick={() => onOpenTask(task.id)}>
            review
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function ActivityFeed({
  project,
  tasks,
  now,
  onOpenTask,
}: {
  project: Project;
  tasks: Task[];
  now: number;
  onOpenTask: (id: string) => void;
}) {
  const { rules, proposals, transitions: liveTransitions, undoRuleAction, retryRuleAction, wsPhase } = useStore();
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const ruleById = useMemo(() => new Map(rules.map((r) => [r.id, r])), [rules]);
  const signalsStale = wsPhase !== "open";

  // Every transition for this project (both actors — the footer needs the
  // human count too), fetched once + merged with whatever's arrived live
  // since. Same shape as board.tsx's own fetch+merge.
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
    return [...byId.values()].sort((a, b) => b.at - a.at);
  }, [fetchedTransitions, liveTransitions, project.id]);

  // Finalized pending actions — the ONLY ones that can produce a real,
  // undoable row (a still-"pending" one has no Transition yet, so it can't
  // be attached to a feed row at all). No WS push exists for this, so it's
  // refetched on an interval — cheap (one project-scoped GET) and correct
  // enough for a "Xm left" countdown that only needs to be roughly live.
  const [pendingActions, setPendingActions] = useState<PendingRuleAction[]>([]);
  useEffect(() => {
    let live = true;
    const load = () => api.fetchPendingActions(project.id, { status: "finalized" }).then((p) => live && setPendingActions(p)).catch(() => undefined);
    load();
    const interval = setInterval(load, 30_000);
    return () => {
      live = false;
      clearInterval(interval);
    };
  }, [project.id]);
  const pendingByTransitionId = useMemo(() => {
    const map = new Map<string, PendingRuleAction>();
    for (const p of pendingActions) if (p.transitionId) map.set(p.transitionId, p);
    return map;
  }, [pendingActions]);

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

  const [undoingId, setUndoingId] = useState<string | null>(null);
  const handleUndo = async (pendingId: string) => {
    setUndoingId(pendingId);
    try {
      const updated = await undoRuleAction(pendingId);
      // Optimistic: no WS push exists for a pending action's own status, so
      // apply the result locally right away rather than waiting on a refetch
      // that may be up to 30s away. The reverted Transition itself DOES ride
      // a real `transition.created` WS event (see rules/engine.ts's undo()),
      // so the new row appears live on its own.
      if (updated) setPendingActions((prev) => prev.map((p) => (p.id === pendingId ? updated : p)));
    } finally {
      setUndoingId(null);
    }
  };

  // TASK 13 hardening — retrying a failed row re-dispatches the rule; the
  // outcome (success or another failure) rides back on the SAME real
  // transition.created WS event every other rule action does, so there's
  // nothing to apply locally here beyond the busy indicator.
  const [retryingKey, setRetryingKey] = useState<string | null>(null);
  const handleRetry = async (ruleId: string, taskId: string) => {
    const key = `${ruleId}:${taskId}`;
    setRetryingKey(key);
    try {
      await retryRuleAction(ruleId, taskId);
    } finally {
      setRetryingKey(null);
    }
  };

  const machineTransitions = transitions.filter((t) => t.actor === "machine");
  const grouped = useMemo(() => {
    const groups: Record<"Today" | "Yesterday" | "Earlier", Transition[]> = { Today: [], Yesterday: [], Earlier: [] };
    for (const t of machineTransitions) groups[dayGroup(t.at, now)].push(t);
    return groups;
  }, [machineTransitions, now]);

  const todayStart = startOfDayMs(now);
  const todayAll = transitions.filter((t) => t.at >= todayStart);
  const machineToday = todayAll.filter((t) => t.actor === "machine").length;
  const humanToday = todayAll.filter((t) => t.actor === "human").length;

  return (
    <div className="feed-panel">
      <div className="feed-list">
        {loading ? (
          <div className="feed-skel" aria-busy="true">
            <span className="ak-skel-row" />
            <span className="ak-skel-row" style={{ width: "80%" }} />
            <span className="ak-skel-row" style={{ width: "65%" }} />
          </div>
        ) : (
          <>
            {(["Today", "Yesterday", "Earlier"] as const).map(
              (group) =>
                grouped[group].length > 0 && (
                  <div className="feed-group" key={group}>
                    <div className="feed-group-head mono">{group}</div>
                    {grouped[group].map((t) => (
                      <FeedRow
                        key={t.id}
                        transition={t}
                        task={taskById.get(t.taskId)}
                        rule={t.ruleId ? ruleById.get(t.ruleId) : undefined}
                        pending={pendingByTransitionId.get(t.id)}
                        stalled={stallByTaskId.get(t.taskId)}
                        now={now}
                        onOpenTask={onOpenTask}
                        onUndo={handleUndo}
                        undoing={undoingId === pendingByTransitionId.get(t.id)?.id}
                        onRetry={handleRetry}
                        retrying={t.ruleId != null && retryingKey === `${t.ruleId}:${t.taskId}`}
                      />
                    ))}
                  </div>
                ),
            )}
            {machineTransitions.length === 0 && <div className="kb-empty">No machine actions yet.</div>}
          </>
        )}
      </div>
      <div className="feed-footer mono">
        {machineToday} machine · {humanToday} human today
        {signalsStale && (
          <span className="ak-stale-marker" title="The live update stream isn't connected — these counts may be out of date."> · ⚠ stale</span>
        )}
      </div>
    </div>
  );
}
