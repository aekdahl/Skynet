// ─── Momentum Board card variants (Phase 4) ────────────────────────────────
// Six card variants, one per real board state a task can be in — draft/intake,
// queued, held (queued but over the WIP limit), in-flight (focus), stalled
// (in-flight but the rule engine's stall sweep raised a nudge), and landed.
// Pure presentation: every card takes plain props, no store/context reads —
// apps/web/src/kanban/board.tsx computes what each task's card needs.
import type { Feature, Task, TaskRun } from "@skynet/shared";
import { CheckpointRail, Chip, type CheckpointStep } from "./primitives";

function fmtRelative(ms: number, now: number): string {
  const diff = Math.max(0, now - ms);
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

// ── Draft / intake card ──────────────────────────────────────────────────
// backlog/triage tasks — the "board's front door". `.ak-intake-accent`
// (kanban.css) is the shared left-accent primitive every intake surface uses.
export function DraftCard({ task, feature, onOpen }: { task: Task; feature: Feature | undefined; onOpen: () => void }) {
  return (
    <button className="mb-card mb-card-draft ak-intake-accent" onClick={onOpen}>
      <div className="mb-card-title">{task.text}</div>
      <div className="mb-card-meta-row">
        {feature && <Chip label={feature.name} tone="epic" />}
        {task.priority && <Chip label={task.priority} tone="neutral" />}
      </div>
      {task.description && <div className="mb-card-desc">{task.description}</div>}
    </button>
  );
}

// ── Queued card ───────────────────────────────────────────────────────────
export function QueuedCard({ task, feature, onOpen }: { task: Task; feature: Feature | undefined; onOpen: () => void }) {
  return (
    <button className="mb-card mb-card-queued" onClick={onOpen}>
      <div className="mb-card-title">{task.text}</div>
      <div className="mb-card-meta-row">
        {feature && <Chip label={feature.name} tone="epic" />}
        {task.priority && <Chip label={task.priority} tone="neutral" />}
      </div>
    </button>
  );
}

// ── Held card ─────────────────────────────────────────────────────────────
// Queued but past the column's configured WIP limit — never silently queued,
// a visible "waiting on a slot" state that auto-promotes (see board.tsx —
// purely a re-derived split on every render, nothing is persisted as "held").
export function HeldCard({
  task,
  feature,
  position,
  limit,
  onOpen,
}: {
  task: Task;
  feature: Feature | undefined;
  position: number; // 1-based position in the held line, for "3rd in line"
  limit: number;
  onOpen: () => void;
}) {
  return (
    <button className="mb-card mb-card-held" onClick={onOpen}>
      <div className="mb-card-title">{task.text}</div>
      <div className="mb-card-meta-row">
        {feature && <Chip label={feature.name} tone="epic" />}
        {task.priority && <Chip label={task.priority} tone="neutral" />}
      </div>
      <div className="mb-held-note">Queued lane full ({limit}/{limit}) — #{position} in line, promotes when a slot frees</div>
    </button>
  );
}

// ── In-flight focus card ─────────────────────────────────────────────────
export function InFlightCard({
  task,
  run,
  feature,
  steps,
  onOpen,
}: {
  task: Task;
  run: TaskRun | undefined;
  feature: Feature | undefined;
  steps: CheckpointStep[];
  onOpen: () => void;
}) {
  return (
    <button className="mb-card mb-card-inflight" onClick={onOpen}>
      <div className="mb-card-title">{task.text}</div>
      <div className="mb-card-meta-row">
        {feature && <Chip label={feature.name} tone="epic" />}
        {run && <span className="mb-card-branch mono">{run.branch}</span>}
      </div>
      <CheckpointRail steps={steps} />
    </button>
  );
}

// ── Stalled card ──────────────────────────────────────────────────────────
// An in-flight task the stall sweep flagged — sourced from a pending
// `stall_nudge` Proposal (apps/server/src/rules/engine.ts). `staleHours` is
// the sweep's own elapsed-time snapshot (not a stored countdown — see
// board.tsx's countdown derivation, which combines it with the sweep's
// escalate threshold).
export function StalledCard({
  task,
  feature,
  staleHours,
  hoursToEscalate,
  onOpen,
  onNudge,
}: {
  task: Task;
  feature: Feature | undefined;
  staleHours: number;
  hoursToEscalate: number | null;
  onOpen: () => void;
  onNudge?: () => void;
}) {
  return (
    <div className="mb-card mb-card-stalled">
      <button className="mb-card-clickzone" onClick={onOpen}>
        <div className="mb-card-title">{task.text}</div>
        <div className="mb-card-meta-row">{feature && <Chip label={feature.name} tone="epic" />}</div>
      </button>
      <div className="mb-stall-panel">
        <div className="mb-stall-copy">
          No signal for {Math.round(staleHours)}h.{" "}
          {hoursToEscalate != null && hoursToEscalate > 0
            ? `Escalates to reassignment in ${Math.round(hoursToEscalate)}h unless nudged.`
            : "Escalation is due any moment."}
        </div>
        {onNudge && (
          <button className="btn btn-ghost btn-sm mb-stall-nudge" onClick={onNudge}>
            Nudge
          </button>
        )}
      </div>
    </div>
  );
}

// ── Landed card ───────────────────────────────────────────────────────────
export function LandedCard({ task, feature, mergedAt, now, onOpen }: { task: Task; feature: Feature | undefined; mergedAt: number | null; now: number; onOpen: () => void }) {
  return (
    <button className="mb-card mb-card-landed" onClick={onOpen}>
      <div className="mb-card-title">{task.text}</div>
      <div className="mb-card-meta-row">
        {feature && <Chip label={feature.name} tone="machine-deep" />}
        {mergedAt != null && <span className="mb-card-landed-time mono">{fmtRelative(mergedAt, now)}</span>}
      </div>
    </button>
  );
}
