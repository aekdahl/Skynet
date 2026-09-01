// ─── Automation Builder (Momentum Rollout Phase 6a — TASK 07) ─────────────
// Turns the rule engine (apps/server/src/rules/engine.ts, TASK 02) from
// something only seeded via script into something a human can author and
// watch: a sentence-builder chip UI over EXACTLY the operator/action
// vocabulary the engine implements (RULE_CONDITION_OPS / RULE_ACTION_TYPES) —
// no UI for anything the backend doesn't support yet — plus a live backtest
// against the project's real Transition history, a safety-rails card bound
// directly to Rule.safety, and a live-updated rules list (rule.upserted WS
// delta, already wired into store.tsx's reducer).
import { useEffect, useMemo, useState } from "react";
import type { Project, Rule, RuleAction, RuleCondition, RuleLifecycleState, RuleSafety, TaskState, Transition, ProposalKind } from "@skynet/shared";
import { fmtDurMs } from "../lib/derive";
import * as api from "../lib/client";
import { useStore, useNow } from "../lib/store";
import { Chip, type ChipTone } from "./primitives";
import { PatternSpottedSection } from "./pattern-onboarding";

// ── v1 vocabulary — mirrors apps/server/src/rules/engine.ts's
// RULE_CONDITION_OPS / RULE_ACTION_TYPES exactly. Do NOT add an operator or
// action here the engine doesn't implement (matchCondition/applyAction would
// silently no-op it) — extend that file first, then this list. ──────────────
const CONDITION_OPS: Array<{ op: RuleCondition["op"]; label: string; needsValue: "state" | "text" | "hours" | null }> = [
  { op: "state_equals", label: "task state is", needsValue: "state" },
  { op: "label_contains", label: "label contains", needsValue: "text" },
  { op: "time_since_signal_gt", label: "hours since last signal >", needsValue: "hours" },
  { op: "pr_merged", label: "PR merged", needsValue: null },
  { op: "checks_green", label: "checks passed", needsValue: null },
];

const ACTION_TYPES: Array<{ type: RuleAction["type"]; label: string }> = [
  { type: "move_task", label: "move task to" },
  { type: "add_label", label: "add label" },
  { type: "post_slack_nudge", label: "post Slack nudge" },
  { type: "create_proposal", label: "create proposal" },
];

const PROPOSAL_KINDS: ProposalKind[] = ["draft_task", "suggested_subtask", "suggested_rule", "suggested_reassignment", "stall_nudge"];

const TASK_STATE_LIST: TaskState[] = ["backlog", "triage", "todo", "ongoing", "review", "done"];
const TASK_STATE_LABEL: Record<TaskState, string> = {
  backlog: "Backlog", triage: "Triage", todo: "To-do", ongoing: "Ongoing", review: "Review", done: "Done",
};

const DEFAULT_SAFETY: RuleSafety = { announceBeforeActing: true, undoWindowMin: 10, pauseAfterUndos: 3, excludePriorities: [] };

export const RULE_STATE_META: Record<RuleLifecycleState, { label: string; tone: ChipTone }> = {
  live: { label: "Live", tone: "machine" },
  watch: { label: "Watch", tone: "neutral" },
  paused: { label: "Paused", tone: "warn" },
};

// ── pure helpers ─────────────────────────────────────────────────────────

function paramStr(action: RuleAction, key: string): string {
  const p = (action.params ?? {}) as Record<string, unknown>;
  const v = p[key];
  return typeof v === "string" ? v : "";
}

/** The move_task action's target state, if the draft has one — used both to
 *  default a fresh action's params and to compute the backtest's
 *  false-positive callout (a match already in the target state). */
function moveTargetOf(actions: RuleAction[]): TaskState | null {
  const move = actions.find((a) => a.type === "move_task");
  if (!move) return null;
  const p = (move.params ?? {}) as Record<string, unknown>;
  return TASK_STATE_LIST.includes(p.toState as TaskState) ? (p.toState as TaskState) : null;
}

// Exported: TASK 10's pattern-spotted card reuses these as a read-only
// "rule in full" summary — there's no separate componentized chip display
// anywhere else in the app, only this tab's editable ConditionChip/ActionChip
// rows, so the plain-sentence describers are the actual reuse surface.
export function describeCondition(cond: RuleCondition): string {
  switch (cond.op) {
    case "state_equals":
      return `task state is ${TASK_STATE_LABEL[cond.value as TaskState] ?? String(cond.value)}`;
    case "label_contains":
      return `label contains "${String(cond.value ?? "")}"`;
    case "time_since_signal_gt":
      return `hours since last signal > ${String(cond.value ?? "")}`;
    case "pr_merged":
      return "PR merged";
    case "checks_green":
      return "checks passed";
    default:
      return cond.op;
  }
}

export function describeAction(action: RuleAction): string {
  switch (action.type) {
    case "move_task":
      return `move task to ${TASK_STATE_LABEL[(action.params as { toState?: TaskState } | null)?.toState as TaskState] ?? "…"}`;
    case "add_label":
      return `add label "${paramStr(action, "label")}"`;
    case "post_slack_nudge":
      return `post Slack nudge to #${paramStr(action, "channel")}`;
    case "create_proposal":
      return `create a "${((action.params as { kind?: string } | null)?.kind) ?? "…"}" proposal`;
    default:
      return action.type;
  }
}

/** Auto-composed WHEN…AND…THEN…AND… sentence — persisted as Rule.when (a
 *  plain freeform string in the schema; see kanban.ts's own comment). The
 *  chip UI is the source of truth for the actual conditions/actions arrays —
 *  this sentence is a readable label derived FROM them, never typed by hand,
 *  so it can never drift out of sync with what the rule actually does. */
export function composeWhen(conditions: RuleCondition[], actions: RuleAction[]): string {
  if (conditions.length === 0 && actions.length === 0) return "";
  const when = conditions.length > 0
    ? "WHEN " + conditions.map(describeCondition).join(" AND ")
    : "WHEN (no conditions set)";
  const then = actions.length > 0
    ? "THEN " + actions.map(describeAction).join(" AND ")
    : "THEN (no actions set)";
  return `${when} ${then}`;
}

function defaultCondition(op: RuleCondition["op"]): RuleCondition {
  switch (op) {
    case "state_equals":
      return { field: op, op, value: "todo" };
    case "label_contains":
      return { field: op, op, value: "" };
    case "time_since_signal_gt":
      return { field: op, op, value: 24 };
    default:
      return { field: op, op, value: null };
  }
}

function defaultAction(type: RuleAction["type"]): RuleAction {
  switch (type) {
    case "move_task":
      return { type, params: { toState: "review" } };
    case "add_label":
      return { type, params: { label: "" } };
    case "post_slack_nudge":
      return { type, params: { channel: "", template: "{{text}} needs a look" } };
    case "create_proposal":
      return { type, params: { kind: "stall_nudge", payload: {} } };
    default:
      return { type, params: {} };
  }
}

// ── ConditionChip / ActionChip ───────────────────────────────────────────

function ConditionChip({
  cond, index, onChange, onRemove,
}: {
  cond: RuleCondition; index: number; onChange: (next: RuleCondition) => void; onRemove: () => void;
}) {
  const meta = CONDITION_OPS.find((c) => c.op === cond.op);
  return (
    <div className="rb-chip-row">
      <span className="rb-chip-connector mono">{index === 0 ? "WHEN" : "AND"}</span>
      <select
        className="rb-chip-select"
        value={cond.op}
        onChange={(e) => onChange(defaultCondition(e.target.value as RuleCondition["op"]))}
      >
        {CONDITION_OPS.map((c) => <option key={c.op} value={c.op}>{c.label}</option>)}
      </select>
      {meta?.needsValue === "state" && (
        <select className="rb-chip-select" value={String(cond.value ?? "")} onChange={(e) => onChange({ ...cond, value: e.target.value })}>
          {TASK_STATE_LIST.map((s) => <option key={s} value={s}>{TASK_STATE_LABEL[s]}</option>)}
        </select>
      )}
      {meta?.needsValue === "text" && (
        <input
          className="rb-chip-input qx-input"
          placeholder="label text"
          value={String(cond.value ?? "")}
          onChange={(e) => onChange({ ...cond, value: e.target.value })}
        />
      )}
      {meta?.needsValue === "hours" && (
        <input
          className="rb-chip-input rb-chip-input-num qx-input"
          type="number"
          min={0}
          step={1}
          value={String(cond.value ?? "")}
          onChange={(e) => onChange({ ...cond, value: Number(e.target.value) })}
        />
      )}
      {meta?.needsValue === "hours" && <span className="rb-chip-unit mono">h</span>}
      <button className="rb-chip-remove" title="Remove condition" aria-label="Remove condition" onClick={onRemove}>×</button>
    </div>
  );
}

function ActionChip({
  action, index, onChange, onRemove,
}: {
  action: RuleAction; index: number; onChange: (next: RuleAction) => void; onRemove: () => void;
}) {
  const setParams = (patch: Record<string, unknown>) => onChange({ ...action, params: { ...(action.params as Record<string, unknown> ?? {}), ...patch } });
  return (
    <div className="rb-chip-row">
      <span className="rb-chip-connector mono">{index === 0 ? "THEN" : "AND"}</span>
      <select
        className="rb-chip-select"
        value={action.type}
        onChange={(e) => onChange(defaultAction(e.target.value as RuleAction["type"]))}
      >
        {ACTION_TYPES.map((a) => <option key={a.type} value={a.type}>{a.label}</option>)}
      </select>
      {action.type === "move_task" && (
        <select className="rb-chip-select" value={paramStr(action, "toState") || "review"} onChange={(e) => setParams({ toState: e.target.value })}>
          {TASK_STATE_LIST.map((s) => <option key={s} value={s}>{TASK_STATE_LABEL[s]}</option>)}
        </select>
      )}
      {action.type === "add_label" && (
        <input className="rb-chip-input qx-input" placeholder="label" value={paramStr(action, "label")} onChange={(e) => setParams({ label: e.target.value })} />
      )}
      {action.type === "post_slack_nudge" && (
        <>
          <input className="rb-chip-input qx-input" placeholder="channel" value={paramStr(action, "channel")} onChange={(e) => setParams({ channel: e.target.value })} />
          <input
            className="rb-chip-input rb-chip-input-wide qx-input"
            placeholder="message — {{field}} substitutes a task field"
            value={paramStr(action, "template")}
            onChange={(e) => setParams({ template: e.target.value })}
          />
        </>
      )}
      {action.type === "create_proposal" && (
        <select
          className="rb-chip-select"
          value={((action.params as { kind?: string } | null)?.kind) ?? "stall_nudge"}
          onChange={(e) => setParams({ kind: e.target.value })}
        >
          {PROPOSAL_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
      )}
      <button className="rb-chip-remove" title="Remove action" aria-label="Remove action" onClick={onRemove}>×</button>
    </div>
  );
}

// ── Backtest card ────────────────────────────────────────────────────────
// Live: POST /rules/backtest on every conditions edit (debounced) — "would
// have moved N tasks" + a 6-day sparkline of when (reusing the Momentum
// Board's own .mb-sparkline — see board.tsx) + a false-positive callout when
// the visible sample looks noisy (>30% of matches were already in the
// move_task action's own target state — i.e. the action would be a no-op).
export function BacktestCard({ project, conditions, actions }: { project: Project; conditions: RuleCondition[]; actions: RuleAction[] }) {
  const [result, setResult] = useState<{ wouldHaveMoved: number; sample: Transition[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const now = useNow(60_000);

  useEffect(() => {
    if (conditions.length === 0) {
      setResult(null);
      setErr(null);
      return;
    }
    let live = true;
    setLoading(true);
    const t = setTimeout(() => {
      api.backtestRule(project.id, { conditions, actions })
        .then((r) => { if (live) { setResult(r); setErr(null); } })
        .catch((e: unknown) => { if (live) setErr((e as Error)?.message || "Backtest failed."); })
        .finally(() => { if (live) setLoading(false); });
    }, 450);
    return () => { live = false; clearTimeout(t); };
    // Only conditions actually affect the backtest server-side (see
    // backtestRule's own doc comment) — actions/safety ride along in the
    // request for a forward-compatible shape but never change the result,
    // so they're deliberately not in this effect's dependency list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, JSON.stringify(conditions)]);

  const sparkline = useMemo(() => {
    if (!result) return [];
    const DAY_MS = 24 * 60 * 60 * 1000;
    const todayStart = (() => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); })();
    const bars = Array.from({ length: 6 }, (_, i) => {
      const start = todayStart - (5 - i) * DAY_MS;
      const end = start + DAY_MS;
      return result.sample.filter((t) => t.at >= start && t.at < end).length;
    });
    const max = Math.max(1, ...bars);
    return bars.map((n) => ({ count: n, pct: Math.round((n / max) * 100) }));
  }, [result, now]);

  const targetState = moveTargetOf(actions);
  const falsePositive = useMemo(() => {
    if (!result || !targetState || result.sample.length === 0) return null;
    const already = result.sample.filter((t) => t.to === targetState).length;
    const pct = already / result.sample.length;
    if (pct <= 0.3) return null;
    return { pct: Math.round(pct * 100), already, of: result.sample.length };
  }, [result, targetState]);

  return (
    <div className="rb-card">
      <div className="rb-card-head">Backtest</div>
      {conditions.length === 0 ? (
        <p className="rb-card-hint">Add a condition above to see how this rule would have performed against this project's history.</p>
      ) : err ? (
        <p className="rb-card-hint rb-card-err">{err}</p>
      ) : (
        <>
          <div className="rb-backtest-headline">
            <span className="rb-backtest-count">{loading ? "…" : (result?.wouldHaveMoved ?? 0)}</span>
            <span className="rb-backtest-label">would have matched{loading ? " (checking…)" : ""}</span>
            {sparkline.length > 0 && (
              <span className="mb-sparkline rb-backtest-spark" aria-hidden="true">
                {sparkline.map((bar, i) => (
                  <span key={i} className="mb-sparkline-bar" style={{ height: `${Math.max(8, bar.pct)}%` }} title={`${bar.count} on this day`} />
                ))}
              </span>
            )}
          </div>
          {falsePositive && (
            <p className="rb-card-warn">
              ⚠ {falsePositive.pct}% of the visible sample ({falsePositive.already} of {falsePositive.of}) were already in the
              target state — this rule's move action would often be a no-op. Consider a tighter condition.
            </p>
          )}
        </>
      )}
    </div>
  );
}

// ── Safety-rails card ────────────────────────────────────────────────────
// Exported: reused as-is by the Keys & Budget panel (keys-budget.tsx) to edit
// Project.ruleSafetyDefaults — same 4 controls, same shape, so a rule's own
// safety rails and the project-level default that seeds new ones look and
// behave identically.
export function SafetyRailsCard({ safety, onChange }: { safety: RuleSafety; onChange: (next: RuleSafety) => void }) {
  const [priorityDraft, setPriorityDraft] = useState("");
  const addPriority = (p: string) => {
    const v = p.trim();
    if (!v || safety.excludePriorities.includes(v)) return;
    onChange({ ...safety, excludePriorities: [...safety.excludePriorities, v] });
    setPriorityDraft("");
  };
  return (
    <div className="rb-card">
      <div className="rb-card-head">Safety rails</div>
      <label className="rb-safety-row">
        <input
          type="checkbox"
          checked={safety.announceBeforeActing}
          onChange={(e) => onChange({ ...safety, announceBeforeActing: e.target.checked })}
        />
        <span>
          <strong>Announce before acting</strong> — hold each match for the undo window before it actually applies.
        </span>
      </label>
      <label className="rb-safety-row">
        <span className="rb-safety-label">Undo window</span>
        <input
          className="rb-safety-num qx-input"
          type="number"
          min={0}
          step={1}
          value={safety.undoWindowMin}
          onChange={(e) => onChange({ ...safety, undoWindowMin: Math.max(0, Number(e.target.value)) })}
        />
        <span className="mono">min</span>
      </label>
      <label className="rb-safety-row">
        <span className="rb-safety-label">Pause after</span>
        <input
          className="rb-safety-num qx-input"
          type="number"
          min={1}
          step={1}
          value={safety.pauseAfterUndos}
          onChange={(e) => onChange({ ...safety, pauseAfterUndos: Math.max(1, Number(e.target.value)) })}
        />
        <span className="mono">undos within 24h</span>
      </label>
      <div className="rb-safety-row rb-safety-priorities">
        <span className="rb-safety-label">Never touch</span>
        <div className="rb-priority-chips">
          {safety.excludePriorities.map((p) => (
            <span key={p} className="ak-chip ak-chip-warn rb-priority-chip">
              {p}
              <button
                className="rb-priority-remove"
                aria-label={`Stop excluding ${p}`}
                onClick={() => onChange({ ...safety, excludePriorities: safety.excludePriorities.filter((x) => x !== p) })}
              >
                ×
              </button>
            </span>
          ))}
          {["P0", "P1", "P2", "P3"].filter((p) => !safety.excludePriorities.includes(p)).map((p) => (
            <button key={p} className="rb-priority-suggest" onClick={() => addPriority(p)}>+ {p}</button>
          ))}
          <input
            className="rb-priority-input qx-input"
            placeholder="other priority…"
            value={priorityDraft}
            onChange={(e) => setPriorityDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addPriority(priorityDraft); } }}
          />
        </div>
      </div>
    </div>
  );
}

// ── Rule builder (create or edit) ────────────────────────────────────────
export function RuleBuilder({ project, existing, onDone, onCancel }: { project: Project; existing: Rule | null; onDone: () => void; onCancel: () => void }) {
  const { createRule, updateRule } = useStore();
  const [name, setName] = useState(existing?.name ?? "");
  const [conditions, setConditions] = useState<RuleCondition[]>(existing?.conditions ?? []);
  const [actions, setActions] = useState<RuleAction[]>(existing?.actions ?? []);
  // A NEW rule starts from the project's "boundaries set once" default (Keys &
  // Budget panel, Project.ruleSafetyDefaults) instead of a hardcoded constant,
  // so an operator doesn't re-type the same undo-window/pause-count on every
  // rule they build — DEFAULT_SAFETY is only the last-resort fallback for a
  // project fetched before this field existed.
  const [safety, setSafety] = useState<RuleSafety>(existing?.safety ?? project.ruleSafetyDefaults ?? DEFAULT_SAFETY);
  const [state, setState] = useState<RuleLifecycleState>(existing?.state ?? "watch");
  const [saving, setSaving] = useState(false);

  const when = useMemo(() => composeWhen(conditions, actions), [conditions, actions]);
  const canSave = name.trim().length > 0 && conditions.length > 0 && actions.length > 0 && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      if (existing) {
        await updateRule(project.id, existing.id, { name: name.trim(), when, conditions, actions, safety, state });
      } else {
        await createRule(project.id, { name: name.trim(), when, conditions, actions, safety, state });
      }
      onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rb-panel">
      <div className="rb-panel-head">
        <h3 className="rb-panel-title">{existing ? "Edit rule" : "New rule"}</h3>
        <button className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
      </div>

      <input
        className="rb-name-input qx-input"
        placeholder="Rule name — e.g. Move stale PRs to review"
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={120}
      />

      <div className="rb-card">
        <div className="rb-card-head">Trigger &amp; conditions</div>
        {conditions.map((c, i) => (
          <ConditionChip
            key={i}
            cond={c}
            index={i}
            onChange={(next) => setConditions(conditions.map((x, j) => (j === i ? next : x)))}
            onRemove={() => setConditions(conditions.filter((_, j) => j !== i))}
          />
        ))}
        <button className="rb-add-chip" onClick={() => setConditions([...conditions, defaultCondition("state_equals")])}>
          + Add condition
        </button>
      </div>

      <div className="rb-card">
        <div className="rb-card-head">Actions</div>
        {actions.map((a, i) => (
          <ActionChip
            key={i}
            action={a}
            index={i}
            onChange={(next) => setActions(actions.map((x, j) => (j === i ? next : x)))}
            onRemove={() => setActions(actions.filter((_, j) => j !== i))}
          />
        ))}
        <button className="rb-add-chip" onClick={() => setActions([...actions, defaultAction("move_task")])}>
          + Add action
        </button>
      </div>

      {when && <p className="rb-sentence mono">{when}</p>}

      <BacktestCard project={project} conditions={conditions} actions={actions} />
      <SafetyRailsCard safety={safety} onChange={setSafety} />

      <div className="rb-card">
        <div className="rb-card-head">Lifecycle</div>
        <div className="rb-state-picker">
          {(["watch", "live", "paused"] as RuleLifecycleState[]).map((s) => (
            <button
              key={s}
              className={"rb-state-btn" + (state === s ? " on" : "")}
              onClick={() => setState(s)}
              title={s === "watch" ? "Evaluated and logged, never acts — build confidence first." : s === "live" ? "Actively acting." : "Disabled."}
            >
              {RULE_STATE_META[s].label}
            </button>
          ))}
        </div>
        <p className="rb-card-hint">New rules default to Watch — a dry run that never acts. Flip to Live once you trust it.</p>
      </div>

      <div className="rb-panel-actions">
        <button className="btn btn-primary" disabled={!canSave} onClick={() => void save()}>
          {existing ? "Save changes" : "Create rule"}
        </button>
        <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// ── Live rules list ──────────────────────────────────────────────────────
function RuleRow({ rule, project, onEdit }: { rule: Rule; project: Project; onEdit: () => void }) {
  const { updateRule, deleteRule } = useStore();
  const now = useNow(30_000);
  const meta = RULE_STATE_META[rule.state];
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  return (
    <div className="rb-rule-row">
      <div className="rb-rule-main">
        <div className="rb-rule-top">
          <span className="rb-rule-name">{rule.name}</span>
          <Chip label={meta.label} tone={meta.tone} />
          {rule.pausedReason && <span className="rb-rule-paused-reason" title={rule.pausedReason}>ⓘ auto-paused</span>}
        </div>
        <p className="rb-rule-when">{rule.when || "(no conditions)"}</p>
        <div className="rb-rule-stats mono">
          {rule.state === "watch" ? (
            // TASK 10 — "evaluated and logged, never acts" (RuleLifecycleState's
            // own doc comment) means nothing to show as moves/undos yet; show
            // the ONE stat that IS real for a watch rule instead.
            <>{rule.stats.watchMatches} match{rule.stats.watchMatches === 1 ? "" : "es"} while watching · created {fmtDurMs(now - rule.createdAt)} ago</>
          ) : (
            <>{rule.stats.moves} move{rule.stats.moves === 1 ? "" : "s"} · {rule.stats.undos} undo{rule.stats.undos === 1 ? "" : "s"} · created {fmtDurMs(now - rule.createdAt)} ago</>
          )}
        </div>
      </div>
      <div className="rb-rule-actions">
        {(["watch", "live", "paused"] as RuleLifecycleState[]).map((s) => (
          <button
            key={s}
            className={"rb-state-btn rb-state-btn-sm" + (rule.state === s ? " on" : "")}
            disabled={rule.state === s}
            onClick={() => void updateRule(project.id, rule.id, { state: s })}
          >
            {RULE_STATE_META[s].label}
          </button>
        ))}
        <button className="btn btn-ghost btn-sm" onClick={onEdit}>Edit</button>
        {confirmingDelete ? (
          <>
            <button className="btn btn-danger btn-sm" onClick={() => void deleteRule(project.id, rule.id)}>Delete?</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setConfirmingDelete(false)}>No</button>
          </>
        ) : (
          <button className="btn btn-ghost btn-sm rb-del" onClick={() => setConfirmingDelete(true)}>Delete</button>
        )}
      </div>
    </div>
  );
}

// ── Top-level Rules tab ───────────────────────────────────────────────────
export function RulesTab({ project }: { project: Project }) {
  const { rules } = useStore();
  const [mode, setMode] = useState<{ kind: "list" } | { kind: "new" } | { kind: "edit"; rule: Rule }>({ kind: "list" });

  const projectRules = useMemo(
    () => rules.filter((r) => r.projectId === project.id && !r.archived).sort((a, b) => b.createdAt - a.createdAt),
    [rules, project.id],
  );

  if (mode.kind !== "list") {
    return (
      <div className="rb-wrap">
        <RuleBuilder
          project={project}
          existing={mode.kind === "edit" ? mode.rule : null}
          onDone={() => setMode({ kind: "list" })}
          onCancel={() => setMode({ kind: "list" })}
        />
      </div>
    );
  }

  return (
    <div className="rb-wrap">
      <PatternSpottedSection project={project} />
      <div className="rb-list-head">
        <h3 className="rb-panel-title">Rules</h3>
        <button className="btn btn-primary btn-sm" onClick={() => setMode({ kind: "new" })}>+ New rule</button>
      </div>
      {projectRules.length === 0 ? (
        <p className="rb-card-hint">
          No rules yet. A rule watches for a signal (a task's state, a GitHub PR/check event, staleness) and reacts —
          moving the card, adding a label, nudging Slack, or drafting a proposal. Build one above.
        </p>
      ) : (
        <div className="rb-rule-list">
          {projectRules.map((r) => (
            <RuleRow key={r.id} rule={r} project={project} onEdit={() => setMode({ kind: "edit", rule: r })} />
          ))}
        </div>
      )}
    </div>
  );
}
