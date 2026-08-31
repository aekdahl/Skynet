// ─── Momentum Board (Phase 4 — TASK 05) ────────────────────────────────────
// The new 4-column kanban view: intake → queued → in flight → landed. A pure
// PRESENTATION layer over the same Task/TaskRun data the existing board reads
// (see project.tsx) — columnBucket() (packages/shared/src/kanban.ts) maps
// each task's real six-state TaskState onto one of the 4 buckets; nothing
// here writes a new state machine. Gated behind Project.newBoardEnabled —
// project.tsx renders this INSTEAD of the old board only when that flag is on.
import { useEffect, useMemo, useState } from "react";
import type { Feature, HitlItem, Project, Task, TaskRun, Transition } from "@skynet/shared";
import { columnBucket, type ColumnBucket, type TaskCheckpoints } from "@skynet/shared";
import * as api from "../lib/client";
import { useStore } from "../lib/store";
import type { CheckpointState, CheckpointStep } from "./primitives";
import { CHECKPOINT_RAIL_KEYS } from "./primitives";
import { DraftCard, HeldCard, InFlightCard, LandedCard, QueuedCard, StalledCard } from "./cards";

// The rule engine's stall-escalate threshold (apps/server/src/rules/engine.ts,
// SKYNET_STALL_ESCALATE_HOURS, default 96) isn't exposed over the API — the
// server only ever ships an ALREADY-ELAPSED `staleHours` snapshot on a
// stall_nudge Proposal, never a target timestamp (see kanban.ts's Proposal
// payload comments). Mirroring the server default here is the pragmatic
// choice for a live countdown; if an operator overrides the env var this
// drifts out of sync with the real threshold — acceptable for a Phase 4
// display-only countdown, not worth a new endpoint for one constant.
const STALL_ESCALATE_HOURS_DEFAULT = 96;

const COLUMN_META: Record<ColumnBucket, { label: string; hint: string }> = {
  intake: { label: "Intake", hint: "Backlog + triage — not yet queued." },
  queued: { label: "Queued", hint: "Ready to start." },
  in_flight: { label: "In Flight", hint: "An agent is actively working this, or it's in review." },
  landed: { label: "Landed", hint: "Done." },
};

// No persisted per-task checkpoint record exists yet (kanban.ts's
// TaskCheckpoints is explicitly "resolved by the caller each time, never
// stored") — columnBucket() ALSO currently ignores this param entirely (pure
// state→bucket mapping), so a stub satisfies the signature without lying
// about anything the board actually renders (the real per-task checkpoint
// steps for the in-flight card come from deriveCheckpointSteps() below,
// grounded in the task's own TaskRun fields, not this stub).
const STUB_CHECKPOINTS: TaskCheckpoints = { branch: false, pr: false, review: false, merged: false, deployed: false, lastSignalAt: 0 };

/** The in-flight focus card's 5-stage rail, derived from real TaskRun/Task
 *  fields (branch/pr/review/merge/deploy) — there's no persisted checkpoint
 *  record to read (see STUB_CHECKPOINTS above), so this is the board's own
 *  best-effort reading of the same signals a later phase would formalize.
 *  `review` has no reviewer-count data anywhere in the model (Task.reviewVerdict
 *  is a single decision, not an approval count) — deliberately NOT fabricated
 *  as "2/2"; the label stays plain "review". */
function deriveCheckpointSteps(run: TaskRun | undefined, task: Task): CheckpointStep[] {
  const state = (key: (typeof CHECKPOINT_RAIL_KEYS)[number]): CheckpointState => {
    if (!run) return "pending";
    switch (key) {
      case "branch":
        return "done"; // a run always has a branch the moment it exists
      case "pr":
        return run.pr ? "done" : run.status === "done" ? "pending" : "active";
      case "review":
        if (task.reviewVerdict?.decision === "approve") return "done";
        if (task.reviewVerdict?.decision === "flag") return "blocked";
        return run.pr || run.status === "review" ? "active" : "pending";
      case "merge":
        if (run.mergedAt != null) return "done";
        return task.reviewVerdict?.decision === "approve" ? "active" : "pending";
      case "deploy":
        return run.flyDeployment ? "done" : "pending";
    }
  };
  return CHECKPOINT_RAIL_KEYS.map((key) => ({ key, label: key, state: state(key) }));
}

function startOfTodayMs(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function MomentumBoard({
  project,
  tasks,
  runs,
  queue,
  features,
  now,
  onOpenTask,
}: {
  project: Project;
  tasks: Task[];
  runs: TaskRun[];
  queue: HitlItem[];
  features: Feature[];
  now: number;
  onOpenTask: (id: string) => void;
}) {
  const { rules, proposals, transitions: liveTransitions } = useStore();
  void queue; // reserved for a later phase's inline HITL status on the focus card

  const runById = useMemo(() => new Map(runs.map((r) => [r.id, r])), [runs]);
  const featureById = useMemo(() => new Map(features.map((f) => [f.id, f])), [features]);

  const projectTasks = useMemo(
    () => tasks.filter((t) => t.projectId === project.id && !t.archived),
    [tasks, project.id],
  );

  // Historical transitions for this project — Snapshot doesn't carry them
  // (see store.tsx), so fetch once per project and merge with whatever's
  // arrived live since (dedup by id; a live one may also appear in a refetch).
  const [fetchedTransitions, setFetchedTransitions] = useState<Transition[]>([]);
  useEffect(() => {
    let live = true;
    api.fetchProjectTransitions(project.id, { limit: 500 }).then((t) => {
      if (live) setFetchedTransitions(t);
    }).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [project.id]);
  const transitions = useMemo(() => {
    const byId = new Map(fetchedTransitions.map((t) => [t.id, t]));
    for (const t of liveTransitions) if (t.projectId === project.id) byId.set(t.id, t);
    return [...byId.values()];
  }, [fetchedTransitions, liveTransitions, project.id]);

  // ── bucketing ────────────────────────────────────────────────────────────
  const byBucket = useMemo(() => {
    const out: Record<ColumnBucket, Task[]> = { intake: [], queued: [], in_flight: [], landed: [] };
    for (const t of projectTasks) out[columnBucket(t, STUB_CHECKPOINTS)].push(t);
    for (const bucket of Object.keys(out) as ColumnBucket[]) {
      out[bucket] = out[bucket].slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    }
    return out;
  }, [projectTasks]);

  // Queued WIP split: past the configured limit, a task renders as "held"
  // rather than silently queuing — purely a derived split of the same live
  // list, so a task auto-promotes the instant a slot frees (nothing to
  // persist: the very next render recomputes who's under the limit).
  const wipLimit = project.queuedWipLimit;
  const queuedVisible = wipLimit != null ? byBucket.queued.slice(0, wipLimit) : byBucket.queued;
  const queuedHeld = wipLimit != null ? byBucket.queued.slice(wipLimit) : [];

  // Stall proposals: a PENDING stall_nudge names a task by id in its payload
  // (kanban.ts's proposal payloads are untyped — safe-read defensively).
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

  // ── automation pill ──────────────────────────────────────────────────────
  const rulesLive = rules.filter((r) => r.projectId === project.id && r.state === "live" && !r.archived).length;
  const todayStart = startOfTodayMs(now);
  const movesToday = transitions.filter((t) => t.at >= todayStart);
  const handMoves = movesToday.filter((t) => t.actor === "human").length;
  const pctHand = movesToday.length > 0 ? Math.round((handMoves / movesToday.length) * 100) : null;

  // ── landed sparkline: 6 bars, last 6 days' landing count ────────────────
  const sparkline = useMemo(() => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const bars = Array.from({ length: 6 }, (_, i) => {
      const dayStart = startOfTodayMs(now) - (5 - i) * DAY_MS;
      const dayEnd = dayStart + DAY_MS;
      return transitions.filter((t) => t.to === "done" && t.at >= dayStart && t.at < dayEnd).length;
    });
    const max = Math.max(1, ...bars);
    return bars.map((n) => ({ count: n, pct: Math.round((n / max) * 100) }));
  }, [transitions, now]);

  return (
    <div className="mb-board">
      <div className="mb-pill">
        <span className="mb-pill-stat">{rulesLive} RULES LIVE</span>
        <span className="mb-pill-sep">·</span>
        <span className="mb-pill-stat">{movesToday.length} MOVES TODAY</span>
        {pctHand != null && (
          <>
            <span className="mb-pill-sep">·</span>
            <span className="mb-pill-stat mb-pill-hand">{pctHand}% touched by hand</span>
          </>
        )}
      </div>
      <div className="mb-cols">
        {(["intake", "queued", "in_flight", "landed"] as ColumnBucket[]).map((bucket) => (
          <MomentumColumn
            key={bucket}
            bucket={bucket}
            count={byBucket[bucket].length}
            wipLimit={bucket === "queued" ? wipLimit : undefined}
            wipCurrent={bucket === "queued" ? queuedVisible.length : undefined}
            sparkline={bucket === "landed" ? sparkline : undefined}
          >
            {bucket === "intake" &&
              byBucket.intake.map((t) => (
                <DraftCard key={t.id} task={t} feature={t.featureId ? featureById.get(t.featureId) : undefined} onOpen={() => onOpenTask(t.id)} />
              ))}
            {bucket === "queued" && (
              <>
                {queuedVisible.map((t) => (
                  <QueuedCard key={t.id} task={t} feature={t.featureId ? featureById.get(t.featureId) : undefined} onOpen={() => onOpenTask(t.id)} />
                ))}
                {queuedHeld.map((t, i) => (
                  <HeldCard
                    key={t.id}
                    task={t}
                    feature={t.featureId ? featureById.get(t.featureId) : undefined}
                    position={i + 1}
                    limit={wipLimit ?? 0}
                    onOpen={() => onOpenTask(t.id)}
                  />
                ))}
              </>
            )}
            {bucket === "in_flight" &&
              byBucket.in_flight.map((t) => {
                const run = t.runId ? runById.get(t.runId) : undefined;
                const stall = stallByTaskId.get(t.id);
                const feature = t.featureId ? featureById.get(t.featureId) : undefined;
                if (stall) {
                  return (
                    <StalledCard
                      key={t.id}
                      task={t}
                      feature={feature}
                      staleHours={stall.staleHours}
                      hoursToEscalate={STALL_ESCALATE_HOURS_DEFAULT - stall.staleHours}
                      onOpen={() => onOpenTask(t.id)}
                    />
                  );
                }
                return <InFlightCard key={t.id} task={t} run={run} feature={feature} steps={deriveCheckpointSteps(run, t)} onOpen={() => onOpenTask(t.id)} />;
              })}
            {bucket === "landed" &&
              byBucket.landed.map((t) => {
                const run = t.runId ? runById.get(t.runId) : undefined;
                return (
                  <LandedCard
                    key={t.id}
                    task={t}
                    feature={t.featureId ? featureById.get(t.featureId) : undefined}
                    mergedAt={run?.mergedAt ?? null}
                    now={now}
                    onOpen={() => onOpenTask(t.id)}
                  />
                );
              })}
          </MomentumColumn>
        ))}
      </div>
    </div>
  );
}

function MomentumColumn({
  bucket,
  count,
  wipLimit,
  wipCurrent,
  sparkline,
  children,
}: {
  bucket: ColumnBucket;
  count: number;
  wipLimit?: number | null;
  wipCurrent?: number;
  sparkline?: Array<{ count: number; pct: number }>;
  children: React.ReactNode;
}) {
  const meta = COLUMN_META[bucket];
  return (
    <div className={"mb-col mb-col-" + bucket}>
      <div className="mb-col-indicator" aria-hidden="true">
        {bucket === "intake" && <span className="mb-col-indicator-bar mb-col-indicator-dashed" />}
        {bucket === "queued" && <span className="mb-col-indicator-bar mb-col-indicator-human" />}
        {bucket === "in_flight" && <span className="mb-col-indicator-bar ak-sweep-bar" />}
        {bucket === "landed" && sparkline && (
          <span className="mb-sparkline">
            {sparkline.map((bar, i) => (
              <span key={i} className="mb-sparkline-bar" style={{ height: `${Math.max(8, bar.pct)}%` }} title={`${bar.count} landed`} />
            ))}
          </span>
        )}
      </div>
      <div className="mb-col-head">
        <span className="mb-col-title">{meta.label}</span>
        <span className="mb-col-hint" title={meta.hint}>ⓘ</span>
        <span className="mb-col-count">
          {wipLimit != null ? `${wipCurrent ?? 0}/${wipLimit}` : count}
        </span>
      </div>
      <div className="mb-col-body">
        {count > 0 ? children : <div className="mb-col-empty">No tasks</div>}
      </div>
    </div>
  );
}
