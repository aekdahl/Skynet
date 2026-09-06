// ─── Rule engine (Momentum Rollout Phase 1b) ─────────────────────────────────
// Reacts to signals — Skynet's own existing automation (ServerEvents, already
// emitted for nearly every state change) and the new `github.signal` event
// (TASK 01) — and moves cards, writes Transitions, and enforces safety rails.
//
// This does NOT replace or compete with the orchestrator (orchestrator.ts,
// tickAutonomy): the orchestrator keeps doing what it does (agents writing
// code); this engine sits alongside it as a board-management layer, reacting
// to signals the orchestrator (and GitHub) already produce.
//
// Inert by construction until a project has at least one `state:"live"` Rule
// — `handleEvent`/the sweeps both read straight from the store and simply
// find nothing to do for a project that hasn't opted in.
import type { Bus } from "../bus.js";
import type { Hub } from "../hub.js";
import type { Store } from "../store/store.js";
import { config } from "../config.js";
import { now } from "../config.js";
import {
  ProposalKind,
  SuggestedRulePayload,
  TaskState,
  type PendingRuleAction,
  type Project,
  type Rule,
  type RuleAction,
  type RuleCondition,
  type ServerEvent,
  type Task,
  type Transition,
} from "@skynet/shared";

// ── v1 condition/action vocabulary — deliberately scoped, not the DSL's full
// open-ended surface. An operator/action name outside these lists is a no-op
// (logged as evidence, never silently ignored, never a thrown error — a
// misconfigured rule shouldn't crash the engine for every other rule too). ──
export const RULE_CONDITION_OPS = ["state_equals", "label_contains", "time_since_signal_gt", "pr_merged", "checks_green", "checks_red", "changes_requested"] as const;
export type RuleConditionOp = (typeof RULE_CONDITION_OPS)[number];

export const RULE_ACTION_TYPES = ["move_task", "add_label", "post_slack_nudge", "create_proposal", "reengage_run"] as const;
export type RuleActionType = (typeof RULE_ACTION_TYPES)[number];

// Exported for the backtest endpoint (operations.ts's backtestRule) — a
// draft, not-yet-saved Rule's conditions replayed against the project's
// historical Transition log, reusing the exact same per-condition matcher
// the live engine dispatches through, so a backtest result can never
// disagree with what the real engine would have done for the same input.
export interface EvalContext {
  task: Task;
  /** null for a periodic sweep tick (e.g. time_since_signal_gt) — every other
   *  condition needs a live event to have anything to check. Also null for a
   *  backtest replay: a historical Transition's `evidence` strings aren't a
   *  reconstructable ServerEvent, so event-shaped ops (label_contains,
   *  pr_merged, checks_green) honestly never match in a backtest — see
   *  matchCondition's own switch below, not a backtest-specific carve-out. */
  event: ServerEvent | null;
  now: number;
  lastSignalAt: number;
}

interface ActionResult {
  /** null when the action doesn't change the task's state (every action but
   *  move_task) — the resulting Transition then carries from===to, still
   *  feed-visible via listTransitionsForTask without pretending a real move
   *  happened. */
  toState: TaskState | null;
  evidence: string[];
}

export function matchCondition(cond: RuleCondition, ctx: EvalContext): boolean {
  switch (cond.op) {
    case "state_equals":
      return ctx.task.state === cond.value;
    case "label_contains":
      // Stateless by design (v1 has no persisted label set — see add_label's
      // own note below): matches only when the TRIGGERING event itself is a
      // label signal carrying this exact label. TASK 01's webhook ingestion
      // doesn't parse label events yet, so `payload.label` never appears
      // today — this stays forward-compatible for when it does.
      return ctx.event?.type === "github.signal" && ctx.event.payload.label === cond.value;
    case "time_since_signal_gt": {
      const hours = Number(cond.value);
      if (!Number.isFinite(hours)) return false;
      return ctx.now - ctx.lastSignalAt > hours * 60 * 60 * 1000;
    }
    case "pr_merged":
      return ctx.event?.type === "github.signal" && ctx.event.kind === "pr_merged";
    case "checks_green":
      return ctx.event?.type === "github.signal" && ctx.event.kind === "check_succeeded";
    case "checks_red":
      return ctx.event?.type === "github.signal" && ctx.event.kind === "check_failed";
    case "changes_requested":
      return ctx.event?.type === "github.signal" && ctx.event.kind === "review_changes_requested";
    default:
      return false; // unknown operator — never silently match
  }
}

/** Best-effort {projectId, taskId} a ServerEvent is about — null when the
 *  event type isn't one the v1 condition vocabulary reacts to (most events:
 *  not everything needs to trigger a rule) or the linked task can't be
 *  resolved. Scoped to exactly the event types the vocabulary above needs. */
async function resolveEventContext(
  event: ServerEvent,
  store: Store,
  workspaceId: string,
): Promise<{ projectId: string; taskId: string } | null> {
  switch (event.type) {
    case "task.upserted":
      return { projectId: event.task.projectId, taskId: event.task.id };
    case "github.signal": {
      // The real event (TASK 01's webhook ingestion) carries only `taskId` —
      // resolve `projectId` off the task itself, same as the run-keyed cases
      // below.
      const task = await store.getTask(event.taskId);
      return task ? { projectId: task.projectId, taskId: task.id } : null;
    }
    case "run.status":
    case "run.completed":
    case "run.updated": {
      const runId = event.type === "run.updated" ? event.run.id : event.runId;
      const run = await store.getRun(runId);
      if (!run) return null;
      const task = (await store.listTasks(workspaceId)).find((t) => t.runId === run.id);
      return task ? { projectId: run.projectId, taskId: task.id } : null;
    }
    default:
      return null;
  }
}

/** `{{field}}` substitution against the task — the only template surface v1
 *  needs (post_slack_nudge's own template param). Unknown fields render as
 *  the literal `{{field}}` rather than throwing or silently blanking, so a
 *  typo in a rule's template is visible instead of swallowed. */
function renderTemplate(template: string, task: Task): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, field: string) => {
    const value = (task as unknown as Record<string, unknown>)[field];
    return value == null ? whole : String(value);
  });
}

/** The one live-orchestration seam the rule engine is allowed to reach
 *  through — kept to exactly the method reengage_run needs, not the full
 *  Orchestrator class, so this file's dependency surface stays as narrow as
 *  its existing Store/Bus/Hub deps. */
export interface RuleEngineOrchestrator {
  reengageRun(runId: string, reason: string): Promise<void>;
}

export interface RuleEngineDeps {
  store: Store;
  hub: Hub;
  bus: Bus;
  orchestrator: RuleEngineOrchestrator;
}

export class RuleEngine {
  private store: Store;
  private hub: Hub;
  private bus: Bus;
  private orchestrator: RuleEngineOrchestrator;
  private unsub = new Map<string, () => void>(); // workspaceId → unsubscribe
  // Reentrancy guard: a taskId currently mid-evaluation in THIS call stack.
  // Executing an action (move_task) writes the task, which re-publishes
  // `task.upserted` on the SAME bus channel this engine is subscribed to —
  // without this, a rule whose action re-satisfies its own (or another
  // live rule's) condition would recurse forever. announceBeforeActing
  // rules never hit this at all (finalizing happens on a LATER sweep tick,
  // a fresh call stack) — this guard exists specifically for the immediate-
  // execution path.
  private inFlight = new Set<string>();
  // Rolling-window undo history per rule, for the auto-pause breaker — same
  // in-memory, restart-resets-open tradeoff as orchestrator.ts's own
  // `autonomyStreaks` circuit breaker (see its doc comment): a fresh undo
  // streak after a restart is the accepted cost of not persisting this.
  private undoHistory = new Map<string, number[]>();
  private seq = 0;

  constructor(deps: RuleEngineDeps) {
    this.store = deps.store;
    this.hub = deps.hub;
    this.bus = deps.bus;
    this.orchestrator = deps.orchestrator;
  }

  /** Subscribe to every workspace currently in use. Safe to call more than
   *  once — `ensureSubscribed` is idempotent per workspace. */
  async start(): Promise<void> {
    const projects = await this.store.listAllProjects().catch(() => [] as Project[]);
    for (const ws of new Set(projects.map((p) => p.workspaceId))) this.ensureSubscribed(ws);
  }

  /** Test/shutdown seam — unsubscribes everything. */
  stop(): void {
    for (const unsub of this.unsub.values()) unsub();
    this.unsub.clear();
  }

  /** Public so a workspace's FIRST-EVER project (created after boot, so
   *  `start()`'s own listAllProjects() scan never saw it) still gets live
   *  rule-engine reactivity — see Operations.createProject's call site.
   *  Idempotent, safe to call on every project creation regardless of
   *  whether the workspace is already subscribed. */
  ensureSubscribed(workspaceId: string): void {
    if (this.unsub.has(workspaceId)) return;
    const off = this.bus.subscribe(workspaceId, (event) => {
      void this.handleEvent(workspaceId, event).catch(() => undefined);
    });
    this.unsub.set(workspaceId, off);
  }

  // ── reactive path ──────────────────────────────────────────────────────

  private async handleEvent(ws: string, event: ServerEvent): Promise<void> {
    const ctx = await resolveEventContext(event, this.store, ws);
    if (!ctx) return;
    if (this.inFlight.has(ctx.taskId)) return; // reentrancy guard — see the field's own doc comment
    this.inFlight.add(ctx.taskId);
    try {
      const all = await this.store.listRulesForProject(ctx.projectId);
      const liveRules = all.filter((r) => r.state === "live");
      const watchRules = all.filter((r) => r.state === "watch");
      // Inert until the project has opted in — no behavior change otherwise.
      if (liveRules.length === 0 && watchRules.length === 0) return;
      let task = await this.store.getTask(ctx.taskId);
      if (!task) return;
      const lastSignalAt = await this.lastSignalAt(task);
      for (const rule of liveRules) {
        const evalCtx: EvalContext = { task, event, now: now(), lastSignalAt };
        if (rule.conditions.every((c) => matchCondition(c, evalCtx))) {
          task = await this.dispatch(rule, task, [describeTrigger(event)]);
        }
      }
      // TASK 10 — "watch = evaluated and logged, never acts" (RuleLifecycleState's
      // own doc comment, previously unimplemented — see the sweepPatternDetection
      // header comment for the fuller history). A match here bumps
      // stats.watchMatches only: no dispatch, no PendingRuleAction, no Transition,
      // task itself never re-read since a watch rule can never mutate it.
      for (const rule of watchRules) {
        const evalCtx: EvalContext = { task, event, now: now(), lastSignalAt };
        if (rule.conditions.every((c) => matchCondition(c, evalCtx))) {
          await this.hub.upsertRule({ ...rule, stats: { ...rule.stats, watchMatches: rule.stats.watchMatches + 1 } });
        }
      }
    } finally {
      this.inFlight.delete(ctx.taskId);
    }
  }

  /** Most recent real signal for a task: the latest Transition if this engine
   *  (or the orchestrator's own wired sites) has recorded one, else the
   *  linked run's own heartbeat/start (a human-started task with no
   *  Transition yet still has a genuine activity signal there) — never
   *  "no transitions exist yet" alone, which would read every fresh,
   *  perfectly healthy task as infinitely stale. */
  private async lastSignalAt(task: Task): Promise<number> {
    const transitions = await this.store.listTransitionsForTask(task.id);
    if (transitions.length > 0) return transitions[transitions.length - 1]!.at;
    if (task.runId) {
      const run = await this.store.getRun(task.runId);
      if (run) return Math.max(run.lastHeartbeatAt, run.startedAt);
    }
    return now(); // no signal source at all — never treat as stale by default
  }

  /** Safety rails + routing for one matched rule: excludePriorities can skip
   *  it outright; announceBeforeActing defers every one of its actions to a
   *  PendingRuleAction the resolver sweep finalizes later; otherwise every
   *  action executes immediately. Returns the (possibly updated) task so the
   *  caller's next rule in the same reactive pass sees a fresh state. */
  private async dispatch(rule: Rule, task: Task, evidence: string[]): Promise<Task> {
    if (task.priority && rule.safety.excludePriorities.includes(task.priority)) return task;
    if (rule.safety.announceBeforeActing) {
      for (const action of rule.actions) await this.createPendingAction(rule, task, action, evidence);
      return task; // nothing changes yet
    }
    let current = task;
    for (const action of rule.actions) current = await this.executeAction(rule, current, action, evidence);
    return current;
  }

  private async createPendingAction(rule: Rule, task: Task, action: RuleAction, evidence: string[]): Promise<void> {
    const toState = moveTargetState(action);
    const createdAt = now();
    const windowMs = Math.max(0, rule.safety.undoWindowMin) * 60_000;
    const pending: PendingRuleAction = {
      id: `pra-${task.id}-${++this.seq}`,
      workspaceId: task.workspaceId,
      projectId: task.projectId,
      taskId: task.id,
      ruleId: rule.id,
      action,
      fromState: task.state,
      toState,
      evidence,
      status: "pending",
      createdAt,
      readyAt: createdAt + windowMs,
      undoableUntil: null,
      transitionId: null,
    };
    await this.store.putPendingRuleAction(pending);
  }

  /** TASK 13 hardening — previously a throw anywhere in here (most realistically
   *  `applyAction`'s create_proposal → `hub.upsertProposal`, or any of the
   *  persistence calls below it) propagated straight out to `handleEvent`'s
   *  bus-callback `.catch(() => undefined)` (see `ensureSubscribed`) — silently
   *  discarded, no Transition, no log, no operator-visible trace, AND it
   *  aborted evaluation of every remaining rule for that same event. Now every
   *  failure is caught here and recorded as its own `status:"failed"`
   *  Transition (same `from===to` no-op shape the non-move actions already
   *  use) so it's Feed-visible with a reason and retryable — see
   *  `retryFailedAction`. A failure this late (after `recordTransition`
   *  itself succeeded) can leave both the real Transition and a failure
   *  Transition on record — an honest double-entry rather than a silently
   *  swallowed one. */
  private async executeAction(rule: Rule, task: Task, action: RuleAction, evidence: string[]): Promise<Task> {
    try {
      const result = await this.applyAction(action, task, task.projectId, task.workspaceId, rule, evidence);
      const transition: Transition = {
        id: `tr-${task.id}-${++this.seq}`,
        workspaceId: task.workspaceId,
        projectId: task.projectId,
        taskId: task.id,
        from: task.state,
        to: result.toState ?? task.state,
        actor: "machine",
        actorId: null,
        ruleId: rule.id,
        evidence: [...evidence, ...result.evidence],
        at: now(),
      };
      await this.hub.recordTransition(transition);
      await this.bumpRuleMoves(rule.id);
      const toState = result.toState;
      if (toState && toState !== task.state) {
        const updated = await this.hub.patchTask(task.id, (t) => (t.state !== toState ? { state: toState } : null));
        return updated ?? task;
      }
      return task;
    } catch (err) {
      await this.recordActionFailure(rule, task, evidence, err);
      return task;
    }
  }

  private async recordActionFailure(rule: Rule, task: Task, evidence: string[], err: unknown): Promise<void> {
    const reason = (err as Error)?.message || String(err);
    const failure: Transition = {
      id: `tr-${task.id}-failed-${++this.seq}`,
      workspaceId: task.workspaceId,
      projectId: task.projectId,
      taskId: task.id,
      from: task.state,
      to: task.state,
      actor: "machine",
      actorId: null,
      ruleId: rule.id,
      evidence: [...evidence, `action failed: ${reason}`],
      at: now(),
      status: "failed",
      failureReason: reason,
    };
    await this.hub.recordTransition(failure).catch(() => undefined); // last-resort: don't let the FAILURE record itself throw away the failure
  }

  /** The Activity Feed's "retry" action on a failed row — re-runs the SAME
   *  dispatch a fresh matching signal would have triggered (respects the
   *  rule's current announceBeforeActing/actions, not whatever they were at
   *  failure time — a retry should use today's rule, not a stale snapshot of
   *  it). Produces a normal success Transition/PendingRuleAction, or another
   *  `status:"failed"` one if the underlying problem persists — same path,
   *  no special-cased "retry" Transition shape. */
  async retryFailedAction(ruleId: string, taskId: string): Promise<Task> {
    const rule = await this.store.getRule(ruleId);
    if (!rule) throw new Error("This rule no longer exists.");
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error("This task no longer exists.");
    return this.dispatch(rule, task, ["retried after a failed action"]);
  }

  private async bumpRuleMoves(ruleId: string): Promise<void> {
    const rule = await this.store.getRule(ruleId);
    if (rule) await this.hub.upsertRule({ ...rule, stats: { ...rule.stats, moves: rule.stats.moves + 1 } });
  }

  /** The v1 action vocabulary. `add_label`/`post_slack_nudge` have no real
   *  transport in this phase — no GitHub label API and no Slack integration
   *  exist anywhere in this codebase yet (verified before choosing this
   *  scope). Both record their intent as Transition evidence so they're
   *  still feed-visible; wiring a real mutation/webhook is a documented
   *  follow-up, not silently dropped. */
  private async applyAction(action: RuleAction, task: Task, projectId: string, workspaceId: string, rule: Rule | undefined, evidence: string[]): Promise<ActionResult> {
    switch (action.type) {
      case "move_task": {
        const toState = moveTargetState(action);
        if (!toState) return { toState: null, evidence: [`move_task: invalid or missing toState`] };
        return { toState, evidence: [`moved to ${toState}`] };
      }
      case "add_label": {
        const label = paramString(action, "label");
        return { toState: null, evidence: [`would add label "${label}" — no GitHub label API wired yet, recorded only`] };
      }
      case "post_slack_nudge": {
        const channel = paramString(action, "channel");
        const template = paramString(action, "template");
        const rendered = renderTemplate(template, task);
        return { toState: null, evidence: [`slack nudge → #${channel}: ${rendered} — no Slack transport wired yet, recorded only`] };
      }
      case "reengage_run": {
        if (!task.runId) return { toState: null, evidence: [`reengage_run: task has no run to reengage — skipped`] };
        await this.orchestrator.reengageRun(task.runId, `Rule "${rule?.name ?? "unknown"}": ${evidence.join("; ")}`);
        return { toState: null, evidence: [`re-engaged the originating run (${task.runId})`] };
      }
      case "create_proposal": {
        const params = (action.params ?? {}) as Record<string, unknown>;
        const kindParsed = ProposalKind.safeParse(params.kind);
        if (!kindParsed.success) return { toState: null, evidence: [`create_proposal: invalid kind "${String(params.kind)}"`] };
        await this.hub.upsertProposal({
          id: `prop-${task.id}-${++this.seq}`,
          workspaceId,
          projectId,
          kind: kindParsed.data,
          payload: params.payload ?? {},
          status: "pending",
          createdAt: now(),
          resolvedAt: null,
        });
        return { toState: null, evidence: [`created a "${kindParsed.data}" proposal`] };
      }
      default:
        return { toState: null, evidence: [`unknown action type "${action.type}" — skipped`] };
    }
  }

  // ── resolver sweep: finalize announce-before-acting holds ────────────────
  // Mirrors orchestrator.ts's reapStaleAgents: a boot sweep + interval, driven
  // entirely off store state (never in-memory bookkeeping), so a pending
  // action genuinely survives a restart instead of silently vanishing.

  async sweepPendingActions(): Promise<void> {
    const nowMs = now();
    const ready = (await this.store.listAllPendingActions()).filter((a) => a.status === "pending" && a.readyAt <= nowMs);
    for (const action of ready) await this.finalizePendingAction(action).catch(() => undefined);
  }

  private async finalizePendingAction(pending: PendingRuleAction): Promise<void> {
    if (pending.status !== "pending") return; // an undo raced the sweep — nothing to finalize
    const windowMs = Math.max(0, pending.readyAt - pending.createdAt);
    const task = await this.store.getTask(pending.taskId);
    if (!task) {
      await this.store.putPendingRuleAction({
        ...pending,
        status: "finalized",
        undoableUntil: null,
        evidence: [...pending.evidence, "task no longer exists — nothing to finalize"],
      });
      return;
    }
    // Re-check the safety rail at finalize time too — priority may have
    // changed during the announce window (e.g. an operator escalated it).
    const rule = await this.store.getRule(pending.ruleId);
    if (rule && task.priority && rule.safety.excludePriorities.includes(task.priority)) {
      await this.store.putPendingRuleAction({
        ...pending,
        status: "undone",
        evidence: [...pending.evidence, `skipped at finalize — task priority "${task.priority}" is now excluded`],
      });
      return;
    }
    // TASK 13 hardening — this used to be a bare `await` chain: any throw here
    // propagated to sweepPendingActions()'s `.catch(() => undefined)`, leaving
    // this PendingRuleAction stuck at status:"pending" with its `readyAt`
    // already past — the NEXT sweep tick would pick it up and retry it again,
    // silently and forever, invisible to any operator. For create_proposal
    // specifically that also meant a duplicate proposal on every retry if the
    // first attempt got as far as `upsertProposal` before a later step threw.
    // Now a failure is caught, recorded as a `status:"failed"` Transition (so
    // it's Feed-visible with a reason + retry action), and the pending action
    // is finalized (not left dangling) — auto-retry becomes an explicit,
    // operator-triggered "retry" instead of an accidental side effect of
    // readyAt staying in the past.
    try {
      const result = await this.applyAction(pending.action, task, pending.projectId, task.workspaceId, rule, pending.evidence);
      const transitionId = `tr-${pending.id}`;
      const transition: Transition = {
        id: transitionId,
        workspaceId: task.workspaceId,
        projectId: pending.projectId,
        taskId: task.id,
        from: pending.fromState,
        to: result.toState ?? pending.fromState,
        actor: "machine",
        actorId: null,
        ruleId: pending.ruleId,
        evidence: [...pending.evidence, ...result.evidence],
        at: now(),
      };
      await this.hub.recordTransition(transition);
      const toState = result.toState;
      if (toState && toState !== task.state) {
        await this.hub.patchTask(task.id, (t) => (t.state !== toState ? { state: toState } : null));
      }
      if (rule) await this.bumpRuleMoves(rule.id);
      await this.store.putPendingRuleAction({ ...pending, status: "finalized", undoableUntil: now() + windowMs, transitionId });
    } catch (err) {
      const reason = (err as Error)?.message || String(err);
      const failureId = `tr-${pending.id}-failed-${++this.seq}`;
      await this.hub.recordTransition({
        id: failureId,
        workspaceId: task.workspaceId,
        projectId: pending.projectId,
        taskId: task.id,
        from: pending.fromState,
        to: pending.fromState,
        actor: "machine",
        actorId: null,
        ruleId: pending.ruleId,
        evidence: [...pending.evidence, `action failed: ${reason}`],
        at: now(),
        status: "failed",
        failureReason: reason,
      }).catch(() => undefined);
      await this.store.putPendingRuleAction({
        ...pending,
        status: "finalized",
        undoableUntil: null,
        transitionId: failureId,
        evidence: [...pending.evidence, `action failed: ${reason}`],
      });
    }
  }

  // ── undo ───────────────────────────────────────────────────────────────

  /** Undo a pending OR just-finalized action within its window: a pending
   *  action simply never applies; a finalized one has its move reverted (a
   *  non-move action has nothing state-wise to revert, but is still marked
   *  undone). Either way bumps `rule.stats.undos` and checks the rolling-
   *  window auto-pause breaker. Throws with a specific, honest reason
   *  (already undone / window passed / no such action) rather than a
   *  silent no-op. */
  async undo(pendingId: string, operatorId: string): Promise<PendingRuleAction> {
    const pending = await this.store.getPendingRuleAction(pendingId);
    if (!pending) throw new Error("No such pending rule action.");
    if (pending.status === "undone") throw new Error("This action was already undone.");
    const nowMs = now();
    if (pending.status === "finalized" && (pending.undoableUntil == null || nowMs > pending.undoableUntil)) {
      throw new Error("The undo window for this action has passed.");
    }

    if (pending.status === "finalized" && pending.toState != null) {
      // Only revert if the task is still where this action left it — if
      // something else moved it since, silently reverting would clobber
      // that later change, so we mark undone without touching task state.
      // Re-checked against the truly-current value at write time, not a
      // separate pre-write read (see Hub.patchTask).
      const toState = pending.toState;
      const reverted = await this.hub.patchTask(pending.taskId, (t) => (t.state === toState ? { state: pending.fromState } : null));
      if (reverted && reverted.state === pending.fromState) {
        await this.hub.recordTransition({
          id: `tr-undo-${pending.id}`,
          workspaceId: pending.workspaceId,
          projectId: pending.projectId,
          taskId: pending.taskId,
          from: pending.toState,
          to: pending.fromState,
          actor: "machine",
          actorId: operatorId,
          ruleId: pending.ruleId,
          evidence: [`undo of rule action ${pending.id}`],
          at: nowMs,
        });
      }
    }

    await this.store.putPendingRuleAction({ ...pending, status: "undone" });
    await this.recordUndo(pending.ruleId, nowMs);
    return (await this.store.getPendingRuleAction(pending.id))!;
  }

  /** Bumps stats.undos and — when undos within a rolling 24h window cross
   *  `safety.pauseAfterUndos` — flips the rule to paused with a recorded
   *  reason, mirroring orchestrator.ts's autonomy circuit breaker. */
  private async recordUndo(ruleId: string, at: number): Promise<void> {
    const rule = await this.store.getRule(ruleId);
    if (!rule) return;
    const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;
    const history = (this.undoHistory.get(ruleId) ?? []).filter((t) => at - t <= ROLLING_WINDOW_MS);
    history.push(at);
    this.undoHistory.set(ruleId, history);
    const shouldPause = rule.state === "live" && history.length >= rule.safety.pauseAfterUndos;
    await this.hub.upsertRule({
      ...rule,
      stats: { ...rule.stats, undos: rule.stats.undos + 1 },
      state: shouldPause ? "paused" : rule.state,
      pausedReason: shouldPause
        ? `Auto-paused: ${history.length} undo(s) within 24h (threshold ${rule.safety.pauseAfterUndos}).`
        : rule.pausedReason,
    });
  }

  // ── stall detection sweep (separate scheduled job) ───────────────────────
  // No Slack integration exists in this codebase (verified) — scoped to
  // creating a feed-visible Proposal rather than a real notification, per
  // the brief's own hedge. A lighter `stall_nudge` at stallNudgeHours, an
  // escalating `suggested_reassignment` at stallEscalateHours (surfaced via
  // the Proposal path rather than the orchestrator's own live-run escalation
  // machinery, which is tightly coupled to worktree/git bookkeeping this
  // engine has no business touching).

  async sweepStallDetection(): Promise<void> {
    const nowMs = now();
    const projects = await this.store.listAllProjects().catch(() => [] as Project[]);
    for (const project of projects) {
      const stale = (await this.store.listTasks(project.workspaceId))
        .filter((t) => t.projectId === project.id && !t.archived && (t.state === "ongoing" || t.state === "review"));
      for (const task of stale) await this.checkStall(project, task, nowMs).catch(() => undefined);
    }
  }

  private async checkStall(project: Project, task: Task, nowMs: number): Promise<void> {
    const lastSignalAt = await this.lastSignalAt(task);
    const staleHours = (nowMs - lastSignalAt) / (60 * 60 * 1000);
    if (staleHours < config.stallNudgeHours) return;

    const existing = await this.store.listProposalsForProject(project.id, { status: "pending" });
    const hasKind = (kind: string) => existing.some((p) => p.kind === kind && (p.payload as { taskId?: string } | null)?.taskId === task.id);

    if (staleHours >= config.stallEscalateHours) {
      if (hasKind("suggested_reassignment")) return;
      await this.hub.upsertProposal({
        id: `prop-stall-esc-${task.id}-${++this.seq}`,
        workspaceId: task.workspaceId,
        projectId: project.id,
        kind: "suggested_reassignment",
        payload: { taskId: task.id, taskText: task.text, staleHours: Math.round(staleHours) },
        status: "pending",
        createdAt: nowMs,
        resolvedAt: null,
      });
      return;
    }
    if (hasKind("stall_nudge")) return;
    await this.hub.upsertProposal({
      id: `prop-stall-nudge-${task.id}-${++this.seq}`,
      workspaceId: task.workspaceId,
      projectId: project.id,
      kind: "stall_nudge",
      payload: { taskId: task.id, taskText: task.text, staleHours: Math.round(staleHours) },
      status: "pending",
      createdAt: nowMs,
      resolvedAt: null,
    });
  }

  // ── pattern-spotted automation onboarding (TASK 10, Phase 8) ─────────────
  // Closes the loop: a repeated MANUAL move becomes a proposed rule instead of
  // staying tribal knowledge. Deliberately scoped down from the original
  // brief in one honest way — "similar triggering condition (e.g. same label
  // present)" has no backing data anywhere in this codebase (no `Task.labels`
  // field, no label webhook parsing — confirmed by reading the whole model
  // before writing this) and the engine's condition vocabulary
  // (RULE_CONDITION_OPS above) has no label/priority-equals operator to
  // express one even if it did. Rather than fabricate a "similar condition"
  // signal, the detector groups purely on {from,to} — the one dimension it
  // can honestly support end-to-end through the SAME `state_equals` operator
  // the engine already evaluates for real.
  private static readonly ASSUMED_MINUTES_PER_MANUAL_MOVE = 2;

  /** The pattern a draft/saved suggested_rule's conditions+actions encode —
   *  `state_equals` condition value → `move_task` action's toState. Null if
   *  the rule isn't shaped like a pattern-detector proposal (defensive: a
   *  hand-authored suggested_rule with a different shape shouldn't crash the
   *  dedup check, just never match one). Shared between the detector (to
   *  build a fresh proposal's key) and its own dedup check (to compare
   *  against every existing one) so they can never disagree. */
  private patternKeyOf(conditions: RuleCondition[], actions: RuleAction[]): string | null {
    const stateCond = conditions.find((c) => c.op === "state_equals");
    const toState = moveTargetState(actions.find((a) => a.type === "move_task") ?? { type: "", params: null });
    if (!stateCond || !toState) return null;
    return `${String(stateCond.value)}->${toState}`;
  }

  async sweepPatternDetection(): Promise<void> {
    const nowMs = now();
    const windowMs = Math.max(1, config.patternDetectWindowDays) * 24 * 60 * 60 * 1000;
    const threshold = Math.max(1, config.patternDetectThreshold);
    const projects = await this.store.listAllProjects().catch(() => [] as Project[]);
    for (const project of projects) await this.detectPatternsForProject(project, nowMs, windowMs, threshold).catch(() => undefined);
  }

  private async detectPatternsForProject(project: Project, nowMs: number, windowMs: number, threshold: number): Promise<void> {
    const since = nowMs - windowMs;
    // actor:"human" + ruleId:null is exactly "a human manually moved this
    // card" (see Transition's own doc comment) — a rule-driven move, even one
    // an operator later approved via the announce window, is never tribal
    // knowledge to rediscover.
    const manual = (await this.store.listTransitionsForProject(project.id))
      .filter((t) => t.actor === "human" && t.ruleId === null && t.at >= since);
    if (manual.length === 0) return;

    // Group by the exact {from,to} move. Distinct TASK count (not raw
    // transition count) is what has to clear the threshold — one task
    // bounced back and forth several times is noise, not a workflow pattern.
    const groups = new Map<string, Transition[]>();
    for (const t of manual) {
      const key = `${t.from}->${t.to}`;
      const g = groups.get(key);
      if (g) g.push(t);
      else groups.set(key, [t]);
    }

    // Suppression covers three cases, all keyed by the SAME {from,to} pattern
    // signature: (1) already pending — don't propose it twice; (2) explicitly
    // dismissed ("Never") — the dismissed row itself IS the suppression
    // record (see dismissProposal's own doc comment); (3) already ACCEPTED
    // into a real Rule — the historical Transitions that earned it a
    // proposal never expire from the window on their own, so without this
    // case every subsequent sweep would re-propose the exact pattern an
    // operator already turned on or is watching (caught live: "Turn it on"
    // a pattern, run the sweep again, get the identical proposal back).
    const existingProposals = await this.store.listProposalsForProject(project.id);
    const existingRules = await this.store.listRulesForProject(project.id);
    const suppressedKeys = new Set([
      ...existingProposals
        .filter((p) => p.kind === "suggested_rule" && (p.status === "pending" || p.status === "dismissed"))
        .map((p) => {
          const parsed = SuggestedRulePayload.safeParse(p.payload);
          return parsed.success ? this.patternKeyOf(parsed.data.conditions, parsed.data.actions) : null;
        }),
      ...existingRules.filter((r) => !r.archived).map((r) => this.patternKeyOf(r.conditions, r.actions)),
    ].filter((k): k is string => k !== null));

    for (const [key, transitions] of groups) {
      const distinctTaskIds = new Set(transitions.map((t) => t.taskId));
      if (distinctTaskIds.size < threshold) continue;
      if (suppressedKeys.has(key)) continue; // already proposed, dismissed, or already a real rule — don't re-propose

      const [from, to] = key.split("->") as [TaskState, TaskState];
      const matchCount = transitions.length;
      // Denominator: every human move OUT of `from` in the window, to ANY
      // destination — matchRate answers "of the times a task left `from`
      // under human control, how often did it land specifically on `to`."
      const leftFrom = manual.filter((t) => t.from === from).length;
      const matchRate = leftFrom > 0 ? matchCount / leftFrom : 0;
      const monthlyRate = matchCount * (30 / (windowMs / (24 * 60 * 60 * 1000)));
      const estimatedMinutesSavedPerMonth = Math.round(monthlyRate * RuleEngine.ASSUMED_MINUTES_PER_MANUAL_MOVE);

      const fromLabel = titleCase(from);
      const toLabel = titleCase(to);
      const conditions: RuleCondition[] = [{ field: "state", op: "state_equals", value: from }];
      const actions: RuleAction[] = [{ type: "move_task", params: { toState: to } }];
      const payload: SuggestedRulePayload = {
        name: `Auto: ${fromLabel} → ${toLabel}`,
        when: `WHEN task state is ${fromLabel} THEN move task to ${toLabel}`,
        conditions,
        actions,
        safety: { announceBeforeActing: true, undoWindowMin: 10, pauseAfterUndos: 3, excludePriorities: [] },
        detected: {
          sampleSize: matchCount,
          matchCount,
          matchRate,
          windowDays: config.patternDetectWindowDays,
          estimatedMinutesSavedPerMonth,
        },
      };
      await this.hub.upsertProposal({
        id: `prop-pattern-${project.id}-${++this.seq}`,
        workspaceId: project.workspaceId,
        projectId: project.id,
        kind: "suggested_rule",
        payload,
        status: "pending",
        createdAt: nowMs,
        resolvedAt: null,
      });
    }
  }

  /** A watch-state rule sitting unmodified for `config.watchPromoteAfterMs`
   *  since it last entered watch auto-promotes to live — the "WATCH FIRST"
   *  onboarding action's own promise. "Unmodified" = `updatedAt` (falling
   *  back to `createdAt` for a rule persisted before that field existed)
   *  never moved past `watchStartedAt` — an operator editing conditions/
   *  actions/safety/name/state during the week is read as active tuning,
   *  not silent approval, so it's left alone rather than flipped live behind
   *  their back. */
  async sweepWatchPromotion(): Promise<void> {
    const nowMs = now();
    const ageThreshold = Math.max(0, config.watchPromoteAfterMs);
    const projects = await this.store.listAllProjects().catch(() => [] as Project[]);
    for (const project of projects) {
      const watching = (await this.store.listRulesForProject(project.id))
        .filter((r) => r.state === "watch" && r.watchStartedAt != null && nowMs - r.watchStartedAt >= ageThreshold);
      for (const rule of watching) {
        const lastTouched = rule.updatedAt ?? rule.createdAt;
        if (lastTouched > rule.watchStartedAt!) continue; // edited during the watch week — leave it to the operator
        await this.hub.upsertRule({ ...rule, state: "live", watchStartedAt: null }).catch(() => undefined);
      }
    }
  }
}

function titleCase(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

function paramString(action: RuleAction, field: string): string {
  const params = (action.params ?? {}) as Record<string, unknown>;
  const v = params[field];
  return typeof v === "string" ? v : "";
}

function moveTargetState(action: RuleAction): TaskState | null {
  if (action.type !== "move_task") return null;
  const params = (action.params ?? {}) as Record<string, unknown>;
  const parsed = TaskState.safeParse(params.toState);
  return parsed.success ? parsed.data : null;
}

function describeTrigger(event: ServerEvent): string {
  switch (event.type) {
    case "github.signal": {
      const prNumber = event.payload.prNumber;
      return `github.signal:${event.kind}${prNumber != null ? ` (PR #${prNumber})` : ""}`;
    }
    case "task.upserted":
      return `task.upserted → ${event.task.state}`;
    default:
      return event.type;
  }
}
