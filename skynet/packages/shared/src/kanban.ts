// ─── Momentum Rollout — kanban data model, Phase 0 ──────────────────────────
// New entities the rebuilt kanban board (per the "Automated Kanban" design
// handoff) needs, plus the pure scoring/mapping functions the new board's
// presentation layer derives from. This phase adds SCHEMA ONLY — no UI, no
// behavior change to the existing board. `columnBucket` is a presentation
// mapping over the existing six-state TaskState machine (contracts.ts), not a
// new state machine: every task's real state is still exactly one of
// backlog/triage/todo/ongoing/review/done.

import { z } from "zod";
import { TaskState, Timestamp, type Task } from "./contracts.js";

// ─── Transition: kanban move history ────────────────────────────────────────
// One record per state change — the append-only feed the new board reads for
// "how did this task get here" and later phases' automation rules read for
// "did a rule already act on this." Distinct from the existing AuditRecord
// (contracts.ts, hitlId/runId-keyed, a tamper-evident HITL decision log) —
// this is a lighter, task-keyed transition feed; AuditRecord is untouched.
export const TransitionActor = z.enum(["human", "machine"]);
export type TransitionActor = z.infer<typeof TransitionActor>;

export const Transition = z.object({
  id: z.string(),
  workspaceId: z.string(),
  projectId: z.string(),
  taskId: z.string(),
  from: TaskState,
  to: TaskState,
  actor: TransitionActor,
  // Who/what did it: a human operator id, an agent/run id, or null. Null +
  // actor:"machine" means Skynet's own orchestrator made this move directly
  // (e.g. autonomy's triage→todo auto-promote) — NOT a rule-engine action.
  // That distinction is load-bearing for later phases (a rule's own move
  // always carries a ruleId; the orchestrator's never does), so it's encoded
  // now rather than inferred later from absence.
  actorId: z.string().nullable(),
  // Set only when a Rule (below) made this move; null for every human move
  // and every plain orchestrator move (see actorId's note above).
  ruleId: z.string().nullable(),
  // Freeform evidence strings backing the move (a PR url, a check name, a
  // quoted rule condition) — surfaced later for "why did this move" UI.
  evidence: z.array(z.string()).default([]),
  at: Timestamp,
});
export type Transition = z.infer<typeof Transition>;

// ─── Rule: kanban automation ─────────────────────────────────────────────────
// A project-scoped "when X, do Y" automation the new board can run against
// incoming transitions/signals. Phase 0 ships the schema only — no rule
// engine reads or writes these yet.
export const RuleCondition = z.object({
  field: z.string(),
  op: z.string(),
  value: z.unknown(),
});
export type RuleCondition = z.infer<typeof RuleCondition>;

export const RuleAction = z.object({
  type: z.string(),
  params: z.unknown(),
});
export type RuleAction = z.infer<typeof RuleAction>;

// Guardrails every rule carries so an automated move is never a silent
// surprise: announce before acting, a window to undo it, and a circuit
// breaker that pauses the rule after too many undos in a row (later phase
// reads `stats.undos` against this). `excludePriorities` lets an operator
// carve out e.g. "never touch P0" without disabling the rule entirely.
export const RuleSafety = z.object({
  announceBeforeActing: z.boolean().default(true),
  undoWindowMin: z.number().default(10),
  pauseAfterUndos: z.number().default(3),
  excludePriorities: z.array(z.string()).default([]),
});
export type RuleSafety = z.infer<typeof RuleSafety>;

export const RuleStats = z.object({
  moves: z.number().default(0),
  undos: z.number().default(0),
});
export type RuleStats = z.infer<typeof RuleStats>;

// live = actively acting; paused = disabled (operator or the undo breaker);
// watch = evaluated and logged, never acts — a dry-run mode for building
// confidence in a new rule before flipping it live.
export const RuleLifecycleState = z.enum(["live", "paused", "watch"]);
export type RuleLifecycleState = z.infer<typeof RuleLifecycleState>;

export const Rule = z.object({
  id: z.string(),
  workspaceId: z.string(),
  projectId: z.string(),
  name: z.string(),
  // Freeform trigger description (e.g. a natural-language or DSL condition
  // the later rule engine parses) — kept a plain string in Phase 0 rather
  // than a structured trigger shape, since that grammar isn't designed yet.
  when: z.string(),
  conditions: z.array(RuleCondition).default([]),
  actions: z.array(RuleAction).default([]),
  safety: RuleSafety.default({ announceBeforeActing: true, undoWindowMin: 10, pauseAfterUndos: 3, excludePriorities: [] }),
  stats: RuleStats.default({ moves: 0, undos: 0 }),
  state: RuleLifecycleState.default("live"),
  // Set only when the auto-pause breaker flips `state` to "paused" on its
  // own (undo count crossed `safety.pauseAfterUndos` within a rolling
  // window) — distinct from an operator manually pausing, which leaves this
  // null. Null whenever `state !== "paused"` or a human paused it.
  pausedReason: z.string().nullable().default(null),
  createdAt: Timestamp,
  archived: z.boolean().default(false),
});
export type Rule = z.infer<typeof Rule>;

// ─── Proposal: drafts & suggestions ──────────────────────────────────────────
// A pending suggestion surfaced to an operator — a draft task, a suggested
// subtask/rule/reassignment — that hasn't been accepted onto the board yet.
// `payload` is intentionally unknown/untyped: its shape is per-`kind`  and
// owned by whichever later phase produces/consumes it, not this foundation.
export const ProposalKind = z.enum([
  "draft_task",
  "suggested_subtask",
  "suggested_rule",
  "suggested_reassignment",
  // Phase 1b's stall-detection sweep (see RuleEngine): a lighter-weight, non-
  // escalating heads-up that a task has sat with no signal for a while —
  // distinct from `suggested_reassignment`, which is reserved for the LATER,
  // more urgent escalation step once a stalled task has gone unaddressed even
  // longer. Additive — existing Proposal rows are unaffected.
  "stall_nudge",
]);
export type ProposalKind = z.infer<typeof ProposalKind>;

export const ProposalStatus = z.enum(["pending", "accepted", "dismissed"]);
export type ProposalStatus = z.infer<typeof ProposalStatus>;

export const Proposal = z.object({
  id: z.string(),
  workspaceId: z.string(),
  projectId: z.string(),
  kind: ProposalKind,
  payload: z.unknown(),
  status: ProposalStatus.default("pending"),
  createdAt: Timestamp,
  resolvedAt: Timestamp.nullable().default(null),
});
export type Proposal = z.infer<typeof Proposal>;

// ─── Proposal.payload shapes, per kind (Phase 1c — API surface) ─────────────
// `Proposal.payload` stays z.unknown() on the entity itself (see its comment
// above — the shape is owned by whichever phase produces/consumes it, not the
// foundation), but accepting a proposal DOES need to know what it's holding.
// These are that per-kind contract, safe-parsed at accept time so a
// corrupt/hand-crafted payload fails with a clear error rather than a raw
// destructure crash.
export const DraftTaskPayload = z.object({
  text: z.string().min(1),
  description: z.string().nullable().optional(),
});
export type DraftTaskPayload = z.infer<typeof DraftTaskPayload>;

export const SuggestedSubtaskPayload = z.object({
  parentTaskId: z.string(),
  text: z.string().min(1),
  description: z.string().nullable().optional(),
});
export type SuggestedSubtaskPayload = z.infer<typeof SuggestedSubtaskPayload>;

// Accepting a SUGGESTED rule lands it in `state: "watch"` (never "live") —
// see RuleLifecycleState's own doc comment: a suggestion hasn't earned an
// operator's trust to act yet, only to be evaluated and logged. Promoting it
// to live is a deliberate, separate updateRule call.
export const SuggestedRulePayload = z.object({
  name: z.string().min(1),
  when: z.string(),
  conditions: z.array(RuleCondition).default([]),
  actions: z.array(RuleAction).default([]),
  safety: RuleSafety.optional(),
});
export type SuggestedRulePayload = z.infer<typeof SuggestedRulePayload>;

// ─── Rule CRUD requests ──────────────────────────────────────────────────────
export const CreateRuleRequest = z.object({
  name: z.string().min(1),
  when: z.string(),
  conditions: z.array(RuleCondition).default([]),
  actions: z.array(RuleAction).default([]),
  safety: RuleSafety.optional(),
  state: RuleLifecycleState.optional(),
});
export type CreateRuleRequest = z.infer<typeof CreateRuleRequest>;

export const UpdateRuleRequest = z.object({
  name: z.string().min(1).optional(),
  when: z.string().optional(),
  conditions: z.array(RuleCondition).optional(),
  actions: z.array(RuleAction).optional(),
  safety: RuleSafety.optional(),
  state: RuleLifecycleState.optional(),
  archived: z.boolean().optional(),
});
export type UpdateRuleRequest = z.infer<typeof UpdateRuleRequest>;

// A DRAFT rule's matchable half — not yet saved, so no id/workspaceId/
// projectId/stats/createdAt exist yet. `actions`/`safety` are accepted (a
// future Automation Builder naturally has a full draft in hand) but ignored
// by the backtest itself, which only ever checks whether `conditions` would
// have matched — it never applies an action.
export const BacktestRuleRequest = z.object({
  conditions: z.array(RuleCondition).default([]),
  actions: z.array(RuleAction).default([]),
  safety: RuleSafety.optional(),
});
export type BacktestRuleRequest = z.infer<typeof BacktestRuleRequest>;

export const AcceptSubtaskRequest = z.object({
  proposalId: z.string(),
});
export type AcceptSubtaskRequest = z.infer<typeof AcceptSubtaskRequest>;

// ─── PendingRuleAction: the announce-before-acting hold (Phase 1b's rule
// engine) ─────────────────────────────────────────────────────────────────
// A Rule action deferred by `safety.announceBeforeActing` — recorded the
// moment a rule matches, BEFORE the task actually moves, so an operator has
// `undoWindowMin` minutes to cancel it. A scheduled resolver sweep (mirroring
// orchestrator.ts's `reapStaleAgents`) finalizes it once `readyAt` passes
// with no undo — at which point the action actually executes, a Transition
// is written, and the SAME action stays undoable for one more
// `undoWindowMin`-long grace window (`undoableUntil`) in case the operator
// only notices after the fact. Persisted (not an in-memory map like the
// orchestrator's own live-run bookkeeping) so a deferred action genuinely
// survives a restart rather than silently vanishing mid-window.
export const PendingRuleActionStatus = z.enum(["pending", "finalized", "undone"]);
export type PendingRuleActionStatus = z.infer<typeof PendingRuleActionStatus>;

export const PendingRuleAction = z.object({
  id: z.string(),
  workspaceId: z.string(),
  projectId: z.string(),
  taskId: z.string(),
  ruleId: z.string(),
  action: RuleAction,
  fromState: TaskState,
  // Null for a non-move action (add_label / post_slack_nudge / create_proposal)
  // — there's no target TaskState to apply once the window elapses.
  toState: TaskState.nullable(),
  // Evidence captured at match time (the event/signal that triggered this) —
  // carried onto the eventual Transition once finalized.
  evidence: z.array(z.string()).default([]),
  status: PendingRuleActionStatus.default("pending"),
  createdAt: Timestamp,
  /** `createdAt` + `safety.undoWindowMin` — when the resolver sweep finalizes this. */
  readyAt: Timestamp,
  /** Set once finalized: `finalizedAt` + `safety.undoWindowMin` — the SAME
   *  window length, extended past finalization so a still-fresh move stays
   *  undoable a little longer. Null while still pending. */
  undoableUntil: Timestamp.nullable().default(null),
  /** The Transition this action produced once finalized. Null while pending. */
  transitionId: z.string().nullable().default(null),
});
export type PendingRuleAction = z.infer<typeof PendingRuleAction>;

// ─── readiness() / columnBucket(): pure board-presentation functions ────────
// Neither reads nor writes anything — callers (a later phase's API/UI layer)
// resolve `TaskCheckpoints` from wherever the real signals live (branch push,
// PR state, review state, merge, deploy) and pass it in.

/** Per-task progress signal `readiness()`/`columnBucket()` score against.
 *  NOT a persisted entity in this phase — a later phase decides where these
 *  booleans actually come from (webhook, poll, orchestrator event) and how
 *  they're stored; Phase 0 only needs the shape pure functions can score. */
export interface TaskCheckpoints {
  branch: boolean;
  pr: boolean;
  review: boolean;
  merged: boolean;
  deployed: boolean;
  /** epoch ms of the most recent signal on ANY stage above — `readiness()`
   *  decays its score from here when nothing has moved in a while. */
  lastSignalAt: number;
}

const READINESS_STAGES = ["branch", "pr", "review", "merged", "deployed"] as const;
const READINESS_STAGE_WEIGHT = 0.2;
// No decay for the first day of silence — a task can sit untouched overnight
// without reading as "going stale".
const READINESS_GRACE_MS = 24 * 60 * 60 * 1000;
// Decay ramps linearly from the end of the grace period to full decay a week
// later, then holds — staleness alone should never keep eating the score.
const READINESS_DECAY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
// Staleness alone can never zero out real, already-earned progress.
const READINESS_MAX_DECAY = 0.3;

/** Each stage's raw (pre-decay) contribution — 0.2 if reached, else 0. Kept
 *  alongside the score (not collapsed into it) since a later phase surfaces
 *  this breakdown directly in the UI for explainability — "why is this at
 *  60%" needs to answer with the actual stages, not just the number. */
export interface ReadinessBreakdown {
  branch: number;
  pr: number;
  review: number;
  merged: number;
  deployed: number;
}

export interface ReadinessResult {
  /** 0..1, clamped — the weighted stage sum minus the staleness decay. */
  score: number;
  breakdown: ReadinessBreakdown;
  /** Subtracted from the stage sum for time since `checkpoints.lastSignalAt`.
   *  0 while still inside the grace window. */
  decay: number;
}

/** A task's readiness score: a weighted sum over 5 checkpoint stages (0.2
 *  each) minus a staleness decay term based on time since the checkpoints'
 *  last signal. `now` is a required, explicit param (never `Date.now()`
 *  inside) so the function stays pure and its decay behavior is exactly
 *  reproducible in a test. `task` is accepted for context — later phases may
 *  weight scoring by task state/priority — but this phase's formula scores
 *  purely off `checkpoints`, matching the spec exactly. */
export function readiness(task: Task, checkpoints: TaskCheckpoints, now: number): ReadinessResult {
  void task;
  const breakdown: ReadinessBreakdown = {
    branch: checkpoints.branch ? READINESS_STAGE_WEIGHT : 0,
    pr: checkpoints.pr ? READINESS_STAGE_WEIGHT : 0,
    review: checkpoints.review ? READINESS_STAGE_WEIGHT : 0,
    merged: checkpoints.merged ? READINESS_STAGE_WEIGHT : 0,
    deployed: checkpoints.deployed ? READINESS_STAGE_WEIGHT : 0,
  };
  const stageSum = READINESS_STAGES.reduce((sum, stage) => sum + breakdown[stage], 0);
  const staleMs = Math.max(0, now - checkpoints.lastSignalAt);
  const decay =
    staleMs <= READINESS_GRACE_MS
      ? 0
      : Math.min(READINESS_MAX_DECAY, ((staleMs - READINESS_GRACE_MS) / READINESS_DECAY_WINDOW_MS) * READINESS_MAX_DECAY);
  const score = Math.max(0, Math.min(1, stageSum - decay));
  return { score, breakdown, decay };
}

export type ColumnBucket = "intake" | "queued" | "in_flight" | "landed";

const COLUMN_BUCKET_BY_STATE: Record<TaskState, ColumnBucket> = {
  backlog: "intake",
  triage: "intake",
  todo: "queued",
  ongoing: "in_flight",
  review: "in_flight",
  done: "landed",
};

/** Maps a task onto the new board's four columns — a pure PRESENTATION
 *  mapping over the existing six-state TaskState (see contracts.ts), not a
 *  new state machine: backlog/triage → intake, todo → queued, ongoing/review
 *  → in_flight, done → landed. `checkpoints` isn't consulted by this phase's
 *  mapping (state alone decides the bucket) but is part of the signature so
 *  a later phase can refine bucket placement without changing every call
 *  site — see readiness()'s own doc comment for the same reasoning. */
export function columnBucket(task: Task, checkpoints: TaskCheckpoints): ColumnBucket {
  void checkpoints;
  return COLUMN_BUCKET_BY_STATE[task.state];
}
