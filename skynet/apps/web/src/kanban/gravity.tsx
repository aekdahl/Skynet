// ─── Gravity Board (Phase 9a — TASK 11) ────────────────────────────────────
// The first of two alternate board metaphors: no columns, card position
// reflects readiness. A pure PRESENTATION layer over the same Task/TaskRun
// data Momentum reads (board.tsx) — readiness() (packages/shared/src/kanban.ts)
// scores each task from real checkpoint signals; nothing here writes a new
// state machine or persists anything new.
//
// Radius reconciles two requirements that look contradictory at first read:
// "closer to center = more ready" AND "the OUTERMOST ring is merge-ready".
// The resolution: a task that has reached the review checkpoint but hasn't
// merged yet doesn't keep converging toward the core — it graduates to a
// dedicated, stable holding ring at the field's outer edge (400px), styled
// distinctly (dashed lime) as "done with the active work, waiting on the
// merge click". Every task BELOW that threshold follows the plain
// continuous rule: higher score → smaller radius → closer to the core.
import { useEffect, useMemo, useState } from "react";
import type { Feature, Project, Task, TaskRun, Transition } from "@skynet/shared";
import { readiness, type TaskCheckpoints } from "@skynet/shared";
import * as api from "../lib/client";
import { useStore } from "../lib/store";
import { Chip } from "./primitives";
import { MomentumBoard, type MomentumBoardProps } from "./board";

// ── position math (pure — no I/O, no store/context reads) ──────────────────

/** A task's position never depends on its index in any list, list length, or
 *  render order — ONLY on its own id and its own readiness — so it can't
 *  jump when an UNRELATED task is added/removed/reordered. Deterministic
 *  FNV-1a-style string hash, normalized to a full turn. */
export function hashAngle(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) / 4294967296) * Math.PI * 2;
}

// Radii, all in px — matched to the three concentric guide rings rendered
// below (130 / 260 / 400). INNER_MAX sits inside ring 2 on purpose, so the
// continuous field never visually collides with the merge-ready ring.
const INNER_MAX_RADIUS = 300;
export const RING_RADII = [130, 260, 400] as const;
export const MERGE_READY_RADIUS = 400;
// review checkpoint reached (branch+pr+review = 3 × the 0.2 per-stage weight,
// see readiness()'s own breakdown) — the natural "done with active work,
// just needs the merge click" threshold, grounded in the SAME checkpoint
// data readiness() already computed, not a separate signal.
const MERGE_READY_SCORE = 0.6;

export function computeRadius(score: number): { radius: number; mergeReady: boolean } {
  if (score >= MERGE_READY_SCORE) return { radius: MERGE_READY_RADIUS, mergeReady: true };
  return { radius: INNER_MAX_RADIUS * (1 - score / MERGE_READY_SCORE), mergeReady: false };
}

export function cardXY(id: string, radius: number): { x: number; y: number } {
  const angle = hashAngle(id);
  return { x: Math.round(Math.cos(angle) * radius), y: Math.round(Math.sin(angle) * radius) };
}

/** Real checkpoint booleans from the same TaskRun/Task fields Momentum's
 *  deriveCheckpointSteps reads (board.tsx) — there's no persisted checkpoint
 *  record (TaskCheckpoints is resolved by the caller each time, never
 *  stored), so this is Gravity's own reading of the same signals. */
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

/** Mirrors the rule engine's own lastSignalAt (apps/server/src/rules/engine.ts):
 *  the task's most recent Transition, else its run's heartbeat/start, else
 *  "now" — never "no Transition yet" alone, which would read a fresh, healthy
 *  task as infinitely stale and shove it to the field's outer edge. */
function lastSignalAtFor(taskId: string, transitions: Transition[], run: TaskRun | undefined, fallbackNow: number): number {
  let latest = 0;
  for (const t of transitions) if (t.taskId === taskId && t.at > latest) latest = t.at;
  if (latest > 0) return latest;
  if (run) return Math.max(run.lastHeartbeatAt ?? 0, run.startedAt ?? 0);
  return fallbackNow;
}

// ── board ────────────────────────────────────────────────────────────────

export function GravityBoard({ project, tasks, runs, features, now, onOpenTask }: MomentumBoardProps) {
  const { transitions: liveTransitions } = useStore();

  const runById = useMemo(() => new Map(runs.map((r) => [r.id, r])), [runs]);
  const featureById = useMemo(() => new Map(features.map((f) => [f.id, f])), [features]);
  const projectTasks = useMemo(() => tasks.filter((t) => t.projectId === project.id && !t.archived), [tasks, project.id]);

  // Same fetch-once-then-merge-with-live pattern as Momentum (board.tsx) —
  // Snapshot doesn't carry Transitions (see store.tsx); duplicated here
  // rather than shared, since it's a handful of lines and this is only the
  // second use.
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

  const positioned = useMemo(() => {
    return projectTasks.map((task) => {
      const run = task.runId ? runById.get(task.runId) : undefined;
      const lastSignalAt = lastSignalAtFor(task.id, transitions, run, now);
      const checkpoints = deriveTaskCheckpoints(run, task, lastSignalAt);
      const result = readiness(task, checkpoints, now);
      const { radius, mergeReady } = computeRadius(result.score);
      const { x, y } = cardXY(task.id, radius);
      return {
        task,
        run,
        feature: task.featureId ? featureById.get(task.featureId) : undefined,
        score: result.score,
        mergeReady,
        x,
        y,
      };
    });
  }, [projectTasks, runById, featureById, transitions, now]);

  return (
    <div className="gv-field">
      <div className="gv-ring gv-ring-1" aria-hidden="true" />
      <div className="gv-ring gv-ring-2" aria-hidden="true" />
      <div className="gv-ring gv-ring-3 gv-ring-merge" aria-hidden="true">
        <span className="gv-ring-label">MERGE READY</span>
      </div>
      <div className="gv-core" aria-hidden="true">
        <span className="gv-core-label">CORE</span>
      </div>
      {positioned.map(({ task, run, feature, score, mergeReady, x, y }) => (
        // Both `translate` (kanban.css's ak-drift-card, ambient wobble) and
        // this inline `transform` (radial position) apply to the SAME
        // element on purpose — they're separate CSS properties and compose
        // without conflict (see kanban.css's own comment on @keyframes
        // ak-drift). A merge-ready card skips the drift class: it's docked
        // in a stable holding orbit, not still converging.
        <div
          key={task.id}
          className={"gv-slot" + (mergeReady ? "" : " ak-drift-card")}
          style={{ transform: `translate(-50%,-50%) translate(${x}px,${y}px)` }}
        >
          <GravityCard task={task} run={run} feature={feature} score={score} mergeReady={mergeReady} onOpen={() => onOpenTask(task.id)} />
        </div>
      ))}
    </div>
  );
}

function GravityCard({
  task,
  run,
  feature,
  score,
  mergeReady,
  onOpen,
}: {
  task: Task;
  run: TaskRun | undefined;
  feature: Feature | undefined;
  score: number;
  mergeReady: boolean;
  onOpen: () => void;
}) {
  const pct = Math.round(score * 100);
  return (
    <button
      className={"gv-card" + (mergeReady ? " gv-card-merge-ready" : "")}
      onClick={onOpen}
      title={`${task.text} — ${pct}% ready${run ? ` · ${run.branch}` : ""}`}
    >
      <div className="gv-card-title">{task.text}</div>
      <div className="gv-card-meta">
        {feature && <Chip label={feature.name} tone="epic" />}
        <span className="gv-card-score mono">{pct}%</span>
      </div>
    </button>
  );
}

// ── responsive host: swaps to Momentum below GRAVITY_MIN_WIDTH ─────────────

const GRAVITY_MIN_WIDTH = 1100;

function useViewportWidth(): number {
  const [width, setWidth] = useState(() => (typeof window !== "undefined" ? window.innerWidth : GRAVITY_MIN_WIDTH));
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

/** What project.tsx renders instead of <MomentumBoard> directly once the new
 *  board is enabled — owns the Momentum/Gravity view-mode choice and the
 *  width-gated fallback ("silently fall back to rendering Momentum below
 *  1100px — don't show a broken/cramped radial layout on a narrow screen").
 *  Below the threshold there's only one real option, so the switcher itself
 *  hides rather than offering a choice that would just bounce back. */
export function NewBoardView(props: MomentumBoardProps) {
  const [mode, setMode] = useState<"momentum" | "gravity">("momentum");
  const wide = useViewportWidth() >= GRAVITY_MIN_WIDTH;
  const effectiveMode = wide ? mode : "momentum";
  return (
    <div className="gv-wrap">
      {wide && (
        <div className="gv-mode-switch" role="tablist" aria-label="Board view">
          <button
            role="tab"
            aria-selected={effectiveMode === "momentum"}
            className={"gv-mode-btn" + (effectiveMode === "momentum" ? " on" : "")}
            onClick={() => setMode("momentum")}
          >
            Momentum
          </button>
          <button
            role="tab"
            aria-selected={effectiveMode === "gravity"}
            className={"gv-mode-btn" + (effectiveMode === "gravity" ? " on" : "")}
            onClick={() => setMode("gravity")}
          >
            Gravity
          </button>
        </div>
      )}
      {effectiveMode === "gravity" ? <GravityBoard {...props} /> : <MomentumBoard {...props} />}
    </div>
  );
}
