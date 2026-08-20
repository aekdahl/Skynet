import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { TaskRun, Project, Task, TaskAssignment, Agent, SecretMeta, ProviderId, ProviderInfo } from "@skynet/shared";
import { computeDailySpend, committedUsd } from "@skynet/shared";
import { useStore } from "../lib/store";
import * as api from "../lib/client";
import { Blocked, PrimaryButton } from "../components/empty";
import {
  agentsForProject,
  computeUsageRollup,
  curStep,
  fmtCost,
  fmtDurMs,
  fmtNum,
  fmtWait,
  openQueue,
  STATUS_META,
  TASK_STATES,
  TASK_STATE_META,
  tasksInState,
} from "../lib/derive";
import { Bar, StatusDot } from "../components/common";
import { useConfirm } from "../components/confirm";
import { ProjectDelivery, visualLeadOf } from "../components/preview";
import { Markdown } from "../components/markdown";
import { SwDiagram } from "../components/subway-diagram";
import { QueueCard } from "./queue";
import { TimelineView } from "./home";
import { RoadmapDocView } from "./project-roadmap";
import { InformComposer, toastInformResult } from "./fleet";

const stop = (e: React.MouseEvent) => e.stopPropagation();

// Task linter v0 (assistive) — short label per concern kind, shown before the
// model's own one-line note. See apps/server/src/task-linter.ts.
const LINT_KIND_LABEL: Record<string, string> = {
  vague: "Vague",
  "multi-module": "Spans modules",
  "no-done-definition": "No done definition",
};

// ─── Board drag & drop ───────────────────────────────────────────────────────
// Cards are dragged between lanes instead of clicking move buttons. A drop that's
// a legal human transition applies it; todo→ongoing starts the run; review→done
// approves; a drop inside the backlog reorders. Illegal targets don't accept the
// drop (validated here + enforced server-side).
const KB_TRANSITIONS: Record<string, string[]> = {
  backlog: ["triage"],
  triage: ["todo", "backlog"],
  todo: ["triage", "backlog"],
  ongoing: ["todo"],
  review: ["done", "todo"],
  done: ["triage", "backlog"],
};
type DragInfo = { taskId: string; from: string; mode: TaskAssignment["mode"] };
/** Whether the current drag may drop into lane `to`. Mirrors the server rules so
 *  invalid lanes simply don't accept the drop (no bad request round-trip). */
function laneAccepts(drag: DragInfo | null, to: string, noFleet: boolean): boolean {
  if (!drag) return false;
  const from = drag.from;
  if (to === from) return from === "backlog"; // same lane → reorder (backlog only)
  if (from === "todo" && to === "ongoing") return !noFleet; // "Start" needs an agent
  if (from === "backlog" && to === "triage" && drag.mode === "unassigned") return false;
  return (KB_TRANSITIONS[from] ?? []).includes(to);
}
const BoardDnd = createContext<{
  drag: DragInfo | null;
  begin: (d: DragInfo) => void;
  end: () => void;
  dropBeforeId: string | null;
} | null>(null);

/** Human-readable duration for the task-card ⏱ chip. Small ms values render
 *  as seconds; up to an hour as minutes; then hours (one decimal). */
function fmtDurationChip(ms: number): string {
  if (ms < 60_000) return Math.max(1, Math.round(ms / 1000)) + "s";
  if (ms < 3_600_000) return Math.round(ms / 60_000) + "m";
  const h = ms / 3_600_000;
  return (h < 10 ? h.toFixed(1) : Math.round(h)) + "h";
}
/** Relative-when-close, absolute-when-not planned-start chip. */
function fmtStartChip(at: number): string {
  const dSec = Math.round((at - Date.now()) / 1000);
  const abs = Math.abs(dSec);
  if (abs < 1) return "now";
  if (abs >= 86400) return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return dSec >= 0 ? `in ${fmtWait(abs)}` : `${fmtWait(abs)} ago`;
}

// Agent-eligibility picker: who may take this task. `unassigned` blocks leaving
// backlog; `any` = whole fleet; `agents` = a chosen pool (≥1). Editable in the
// pre-run stages; a compact read-only chip once a run exists.
function AgentEligibility({
  task,
  fleet,
  onChange,
  editable,
}: {
  task: Task;
  fleet: Agent[];
  onChange: (a: TaskAssignment) => void;
  editable: boolean;
}) {
  const a = task.assignment;
  if (!editable) {
    const label =
      a.mode === "any" ? "any agent" : a.mode === "agents" ? `${a.agentIds.length} agent(s)` : "unassigned";
    return (
      <span className={"kb-elig-chip mono" + (a.mode === "unassigned" ? " kb-elig-unset" : "")} title="Agent eligibility">
        👤 {label}
      </span>
    );
  }
  return (
    <div className="kb-elig" onClick={stop}>
      <label className="kb-elig-row">
        <span className="kb-elig-lbl">Agent</span>
        <select
          className="kb-elig-select"
          value={a.mode}
          onChange={(e) => {
            const mode = e.target.value as TaskAssignment["mode"];
            if (mode === "agents") {
              const seed = a.agentIds.length ? a.agentIds : fleet[0] ? [fleet[0].id] : [];
              onChange({ mode, agentIds: seed });
            } else {
              onChange({ mode, agentIds: [] });
            }
          }}
        >
          <option value="unassigned">Unassigned</option>
          <option value="any">Any agent</option>
          <option value="agents" disabled={fleet.length === 0}>
            Specific agents…
          </option>
        </select>
      </label>
      {a.mode === "agents" && (
        <div className="kb-elig-list">
          {fleet.map((ag) => {
            const on = a.agentIds.includes(ag.id);
            return (
              <label key={ag.id} className="kb-elig-opt">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => {
                    const next = on ? a.agentIds.filter((id) => id !== ag.id) : [...a.agentIds, ag.id];
                    if (next.length === 0) return; // schema requires ≥1 in `agents` mode
                    onChange({ mode: "agents", agentIds: next });
                  }}
                />{" "}
                {ag.name}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Structured triage read-out: an effort pill + a full-contrast summary line +
// a short risks list — replaces the old single muted paragraph. `assessment`
// (the summary) is the only field a PRE-this-change task carries, so a legacy
// task still renders sanely here: just its summary line, no pill, no risks —
// never blank, never broken.
function TriageCard({ task }: { task: Task }) {
  if (!task.assessment) return null;
  return (
    <div className="triage-card">
      <div className="triage-card-head">
        {task.assessmentEffort && (
          <span className={"effort-pill effort-" + task.assessmentEffort}>{task.assessmentEffort}</span>
        )}
        <span className="triage-summary">{task.assessment}</span>
      </div>
      {task.assessmentRisks.length > 0 && (
        <ul className="triage-risks">
          {task.assessmentRisks.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Saved provider/model preference for auto-pick — a SOFT hint the server tries
// first, not a hard requirement (see Orchestrator.acquireAgent): unlike
// AgentEligibility (who's even ALLOWED to take it), this never blocks Start,
// it just steers which idle runner gets picked when more than one qualifies.
// "Auto-pick" (the default, empty selection) leaves today's behavior alone.
function AgentPreference({
  task,
  providers,
  onChange,
}: {
  task: Task;
  providers: ProviderInfo[];
  onChange: (patch: { preferredProvider: ProviderId | null; preferredModel: string | null }) => void;
}) {
  const models = task.preferredProvider
    ? (providers.find((p) => p.id === task.preferredProvider)?.models ?? [])
    : [];
  return (
    <div className="kb-pref" onClick={stop}>
      <select
        className="kb-pref-select"
        value={task.preferredProvider ?? ""}
        title="Prefer this provider when starting — falls back to auto-pick if none is idle"
        onChange={(e) => {
          const preferredProvider = (e.target.value || null) as ProviderId | null;
          onChange({ preferredProvider, preferredModel: null }); // provider change invalidates any saved model
        }}
      >
        <option value="">Auto-pick</option>
        {providers.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
      {task.preferredProvider && models.length > 0 && (
        <select
          className="kb-pref-select"
          value={task.preferredModel ?? ""}
          title="Prefer this model too — leave as “any” to match the provider alone"
          onChange={(e) => onChange({ preferredProvider: task.preferredProvider ?? null, preferredModel: e.target.value || null })}
        >
          <option value="">Any model</option>
          {models.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      )}
    </div>
  );
}

// One card per Task. For pre-run states (backlog/triage/todo) it shows the task
// text + stage controls; for ongoing/review/done it joins the linked TaskRun to
// show live status/progress and opens the Task detail view on click.
function TaskCard({
  task,
  run,
  onOpenTask,
  canMoveUp,
  canMoveDown,
}: {
  task: Task;
  run?: TaskRun;
  onOpenTask: (id: string) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}) {
  const {
    queue,
    fleet,
    providers,
    features,
    milestones,
    updateTask,
    deleteTask,
    forceTaskDone,
    archiveTask,
    assignTask,
    transitionTask,
    moveTask,
    dismissTaskLint,
  } = useStore();
  const confirm = useConfirm();
  // Features + milestones available to this task (same project, not archived).
  const projFeatures = features.filter((f) => f.projectId === task.projectId && !f.archived);
  const projMilestones = milestones.filter((m) => m.projectId === task.projectId && !m.archived);
  const feature = task.featureId ? projFeatures.find((f) => f.id === task.featureId) : undefined;
  // Effective milestone: the task's own, or (fallback) the feature's roll-up.
  const effectiveMilestoneId = task.milestoneId ?? feature?.milestoneId ?? null;
  const milestone = effectiveMilestoneId
    ? projMilestones.find((m) => m.id === effectiveMilestoneId)
    : undefined;
  const [editing, setEditing] = useState(false);
  const [detail, setDetail] = useState(false); // full-detail modal for a card with no run
  const [draft, setDraft] = useState(task.text);
  const [descDraft, setDescDraft] = useState(task.description ?? "");
  const pid = task.projectId;
  const s = task.state;
  const q = run ? openQueue(queue).find((it) => it.runId === run.id) : undefined;
  const openRun = run ? () => onOpenTask(run.id) : undefined;
  // A card is always openable: a run card opens its live activity; a card with no
  // run opens a read-only detail modal (the card itself clamps title/description).
  const openCard = openRun ?? (() => setDetail(true));
  const noFleet = fleet.length === 0;
  const dnd = useContext(BoardDnd);
  const dragging = dnd?.drag?.taskId === task.id;
  // Once a run exists, the eligibility ("any agent") is moot — surface WHO is
  // actually doing the work: the fleet runner the run executes on. Falls back to
  // the run's provider·model if that runner was since retired, and only reverts
  // to the eligibility chip when nothing has picked the task up yet.
  const runner = run?.agentId ? fleet.find((f) => f.id === run.agentId) : undefined;
  const workedBy = runner?.name ?? (run?.agentId ? `${run.provider} · ${run.model}` : undefined);
  const workedByPinfo = workedBy ? providers.find((p) => p.id === (runner?.provider ?? run?.provider)) : undefined;
  // An agent has actively taken this task once it's `ongoing` (the invariant:
  // an ongoing task always carries a live run). Lock the card so no one can
  // move, edit, or reassign it out from under the running agent — only the
  // run's emergency controls remain (open the card → pause/stop/resume) plus
  // the Force-done escape hatch. `review`/`done` are human-decision states and
  // stay interactive.
  const locked = s === "ongoing";

  if (editing) {
    return (
      <div className={"kb-card kb-addcard kb-card-" + s}>
        <div className="task-name-wrap">
          <input
            className="qx-input"
            autoFocus
            maxLength={TASK_NAME_MAX}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <span className={"task-name-count mono" + (draft.length >= TASK_NAME_MAX ? " task-name-max" : "")}>
            {draft.length}/{TASK_NAME_MAX}
          </span>
        </div>
        <textarea
          className="qx-input kb-addcard-desc"
          rows={3}
          placeholder="Description (optional) — the full brief the agent gets…"
          value={descDraft}
          onChange={(e) => setDescDraft(e.target.value)}
        />
        <div className="qx-row kb-addcard-actions">
          <button
            className="btn btn-primary btn-sm"
            onClick={() => {
              if (draft.trim())
                updateTask(pid, task.id, { text: draft.trim(), description: descDraft.trim() || null });
              setEditing(false);
            }}
          >
            Save
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => { setDraft(task.text); setDescDraft(task.description ?? ""); setEditing(false); }}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
    {dnd?.dropBeforeId === task.id && <div className="kb-drop-line" aria-hidden="true" />}
    <div
      className={"kb-card kb-card-" + s + (dragging ? " kb-card-dragging" : "") + (locked ? " kb-card-locked" : "")}
      role="button"
      tabIndex={0}
      data-card-id={task.id}
      draggable={!locked}
      onDragStart={(e) => {
        // A locked (agent-owned) card never drags — no one moves it off the
        // running agent. draggable=false already blocks it; guard here too.
        if (locked) {
          e.preventDefault();
          return;
        }
        // Don't hijack drags that begin on an inner control (select, buttons,
        // inputs) — those stay clickable; only the card body starts a drag.
        if ((e.target as HTMLElement).closest("input,select,textarea,button,label,a")) {
          e.preventDefault();
          return;
        }
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", task.id);
        dnd?.begin({ taskId: task.id, from: s, mode: task.assignment.mode });
      }}
      onDragEnd={() => dnd?.end()}
      onClick={openCard}
      onKeyDown={(e: React.KeyboardEvent) => (e.key === "Enter" || e.key === " ") && openCard()}
    >
      <div className="kb-card-top">
        {run && <StatusDot status={run.status} />}
        <span className="kb-task" title={task.description ?? undefined}>{task.text}</span>
        {task.source?.kind === "github_issue" && (
          <a
            className="kb-source mono"
            href={task.source.url || undefined}
            target="_blank"
            rel="noreferrer"
            onClick={stop}
            title={`Imported from GitHub issue ${task.source.repo}#${task.source.number} — status syncs back when enabled`}
          >
            #{task.source.number} ↗
          </a>
        )}
        {task.source?.kind === "repo_file" && (
          <span
            className="kb-source mono"
            title={`Imported from ${task.source.path} — completing this checks its box when sync is enabled`}
          >
            📄 {task.source.path.split("/").pop()}
          </span>
        )}
        {task.source?.kind === "fleet" && (
          <span
            className="kb-source mono"
            title={`Proposed by the fleet while reviewing run ${task.source.byRun}${task.source.reason ? ` — ${task.source.reason}` : ""}`}
          >
            🤖 fleet-proposed
          </span>
        )}
        {locked && (
          <span
            className="kb-lock"
            title="An agent is working on this — the card is locked, so it can't be moved or edited. Open it for emergency controls (pause · stop)."
            aria-label="Locked — an agent is working on this task"
          >
            🔒
          </span>
        )}
        {(s === "backlog" || s === "triage" || s === "todo") && (
          <span className="kb-card-tools" onClick={stop}>
            {(s === "backlog" || s === "todo") && (
              <>
                <button
                  className="kb-tool"
                  title="Move up — higher priority (also the auto-pick order when Autonomy is on)"
                  disabled={!canMoveUp}
                  onClick={() => void moveTask(pid, task.id, "up")}
                >
                  ↑
                </button>
                <button
                  className="kb-tool"
                  title="Move down — lower priority"
                  disabled={!canMoveDown}
                  onClick={() => void moveTask(pid, task.id, "down")}
                >
                  ↓
                </button>
              </>
            )}
            <button className="kb-tool" title="Edit task" aria-label="Edit task" onClick={() => setEditing(true)}>✎</button>
            <button className="kb-tool" title="Archive — hide from the board (kept in the store, still read by Steward)" aria-label="Archive task" onClick={() => archiveTask(pid, task.id, true)}>⤓</button>
            <button className="kb-tool kb-tool-del" title="Delete task" aria-label="Delete task" onClick={() => deleteTask(pid, task.id)}>×</button>
          </span>
        )}
      </div>

      {task.description && !run && <p className="kb-desc">{task.description}</p>}

      {run && (
        <>
          <Bar value={run.progress} status={run.status} />
          <div className="pa-step">
            {q ? (
              <span className="wait-tag">⏸ {q.title}</span>
            ) : s === "done" ? (
              <span className="done-tag">✓ merged · {run.branch}</span>
            ) : (
              <span className="step-tag">
                <span style={{ color: STATUS_META[run.status].color }}>{STATUS_META[run.status].label}</span> · → {curStep(run)}
              </span>
            )}
          </div>
        </>
      )}

      {s === "triage" && <TriageCard task={task} />}
      {(s === "backlog" || s === "triage" || s === "todo") &&
        task.lint &&
        !task.lint.dismissed &&
        task.lint.concerns.length > 0 && (
          <div className="kb-lint" onClick={stop}>
            <div className="kb-lint-items">
              {task.lint.concerns.map((c, i) => (
                <span key={i} className="kb-lint-item" title={c.note}>
                  ⚑ {LINT_KIND_LABEL[c.kind] ?? c.kind} — {c.note}
                </span>
              ))}
            </div>
            <button
              className="kb-lint-dismiss"
              title="Dismiss — this is just a hint, not a blocker"
              onClick={() => void dismissTaskLint(pid, task.id)}
            >
              ×
            </button>
          </div>
        )}
      {s === "review" && task.reviewVerdict && (
        task.reviewVerdict.decision === "flag" ? (
          <div className="kb-flag">⚠ flagged for you — {task.reviewVerdict.reason}</div>
        ) : (
          <div className="kb-review-ok">✓ reviewer approved — awaiting you</div>
        )
      )}

      {(task.estimatedDurationMs != null || task.plannedStartAt != null) && (
        <div className="kb-sched" onClick={stop}>
          {task.estimatedDurationMs != null && (
            <span className="kb-sched-chip" title="Estimated duration">⏱ {fmtDurMs(task.estimatedDurationMs)}</span>
          )}
          {task.plannedStartAt != null && (
            <span className="kb-sched-chip" title={new Date(task.plannedStartAt).toLocaleString()}>
              📅 {fmtStartChip(task.plannedStartAt)}
            </span>
          )}
        </div>
      )}

      {(feature || milestone) && (
        <div className="kb-tags" onClick={stop}>
          {feature && (
            <span className="kb-feat-chip" title={`Feature — ${feature.description ?? feature.name}`}>
              ⊞ {feature.name}
            </span>
          )}
          {milestone && (
            <span
              className="kb-ms-chip"
              title={milestone.targetAt ? `Milestone — target ${new Date(milestone.targetAt).toLocaleDateString()}` : "Milestone"}
            >
              ◉ {milestone.name}
            </span>
          )}
        </div>
      )}

      {(s === "backlog" || s === "triage" || s === "todo") ? (
        <AgentEligibility
          task={task}
          fleet={fleet}
          editable
          onChange={(assignment) => updateTask(pid, task.id, { assignment })}
        />
      ) : (
        <div className="kb-elig-ro">
          {workedBy ? (
            <span
              className="kb-elig-chip kb-elig-agent mono"
              title={s === "done" ? "Completed by this agent" : "Agent working on this task"}
            >
              <span className="kb-elig-glyph" style={workedByPinfo ? { color: workedByPinfo.color } : undefined}>
                {workedByPinfo?.glyph ?? "◆"}
              </span>{" "}
              {workedBy}
            </span>
          ) : (
            <AgentEligibility task={task} fleet={fleet} editable={false} onChange={() => {}} />
          )}
        </div>
      )}

      {/* Start → is the primary affordance for starting work: an explicit button
          on backlog/todo cards that acquires an idle agent and moves the task to
          Ongoing (the same effect as dragging todo→ongoing, but discoverable up
          front). Named "Start", not "Assign" — it doesn't just hand the task to
          an agent, it kicks the run off immediately. Other stage changes still
          happen by dragging the card to another lane (review→done approves,
          backlog drags reorder). The escape hatches (Force done / Sync),
          Auto-pick, and Archive can't be expressed as a lane move, so they stay
          as buttons. */}
      {(s === "backlog" || s === "todo" || s === "ongoing" || s === "review" || s === "done") && (
        <div className="kb-actions" onClick={stop}>
          {(s === "backlog" || s === "todo") && (
            <AgentPreference
              task={task}
              providers={providers}
              onChange={(patch) => updateTask(pid, task.id, patch)}
            />
          )}
          {(s === "backlog" || s === "todo") && (
            <Blocked disabled={noFleet} reason={noFleet ? "No agents configured — add one in Fleet before starting." : undefined}>
              <button
                className="kb-move kb-move-primary kb-assign"
                disabled={noFleet}
                title={noFleet ? undefined : "Start now — grabs an idle agent and moves this task to Ongoing."}
                onClick={() => void assignTask(pid, task.id)}
              >
                Start →
              </button>
            </Blocked>
          )}
          {s === "backlog" && (
            <button
              className="kb-move"
              title="Open Steward, focused on this project, to talk through this task before it's picked up."
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("skynet:open-steward", { detail: { text: `Let's talk through this task: "${task.text}"` } }),
                )
              }
            >
              💬 Discuss
            </button>
          )}
          {s === "todo" && (
            <label className="kb-autopick" title="When on, an idle agent starts this task autonomously.">
              <input
                type="checkbox"
                checked={task.autoPick}
                onChange={(e) => updateTask(pid, task.id, { autoPick: e.target.checked })}
              />{" "}
              Auto-pick
            </label>
          )}
          {s === "ongoing" && (
            // An ongoing card is locked (undraggable) so the running agent can't
            // be yanked off it by a stray drag — but `ongoing → todo` is a legal,
            // safe move (stops + detaches the run, task returns clean). Expose it
            // as an explicit button since there's no lane to drag to. `ongoing →
            // review/done` is agent-driven (it advances itself when finished), so
            // there's no human control for those.
            <button
              className="kb-move"
              title="Stop the agent working on this and send the task back to To-do. Its in-progress (uncommitted) work is discarded."
              onClick={async () => {
                if (
                  await confirm({
                    title: "Send back to To-do?",
                    body: `“${task.text}” stops the agent working on it — its in-progress (uncommitted) work is discarded.`,
                    confirmLabel: "Send to To-do",
                    danger: true,
                  })
                )
                  void transitionTask(pid, task.id, "todo");
              }}
            >
              ↩ Send to To-do
            </button>
          )}
          {(s === "ongoing" || s === "review") && (
            <button
              className="kb-move kb-move-force"
              title="Skip the normal approval path — mark this task done and sync the run's status. Use when the run finished the work out-of-band or is stuck."
              onClick={() => forceTaskDone(pid, task.id)}
            >
              ⚡ Force done
            </button>
          )}
          {s === "done" && (
            <>
              {run && run.status !== "done" && (
                <button
                  className="kb-move kb-move-force"
                  title={`Task is Done but the run's status is "${run.status}" — click to resync.`}
                  onClick={() => forceTaskDone(pid, task.id)}
                >
                  ⚡ Sync run → done
                </button>
              )}
              <button className="kb-archive" title="Archive — hide from the board (kept in the store, still read by Steward)" onClick={() => archiveTask(pid, task.id, true)}>⤓ Archive</button>
            </>
          )}
        </div>
      )}
      </div>
      {detail && (
        <div className="kb-detail-overlay" onClick={() => setDetail(false)}>
          <div className="kb-detail" role="dialog" aria-modal="true" onClick={stop}>
            <div className="kb-detail-head">
              <span className="kb-detail-state mono">{s}</span>
              <button className="kb-detail-close" onClick={() => setDetail(false)} aria-label="Close">
                ×
              </button>
            </div>
            <h3 className="kb-detail-title">{task.text}</h3>
            {task.description ? (
              <p className="kb-detail-desc">{task.description}</p>
            ) : (
              <p className="kb-detail-desc kb-detail-empty">No description.</p>
            )}
            {task.assessment && (
              <div className="kb-detail-section">
                <div className="kb-detail-label mono">TRIAGE</div>
                <TriageCard task={task} />
              </div>
            )}
            {task.lint && !task.lint.dismissed && task.lint.concerns.length > 0 && (
              <div className="kb-detail-section">
                <div className="kb-detail-label mono">
                  LINT{" "}
                  <button
                    className="kb-detail-lint-dismiss"
                    title="Dismiss — this is just a hint, not a blocker"
                    onClick={() => void dismissTaskLint(pid, task.id)}
                  >
                    dismiss
                  </button>
                </div>
                {task.lint.concerns.map((c, i) => (
                  <p key={i} className="kb-detail-assess">
                    ⚑ {LINT_KIND_LABEL[c.kind] ?? c.kind} — {c.note}
                  </p>
                ))}
              </div>
            )}
            {task.reviewVerdict && (
              <div className="kb-detail-section">
                <div className="kb-detail-label mono">
                  REVIEW ·{" "}
                  <span className={task.reviewVerdict.decision === "flag" ? "kb-verdict-flag" : "kb-verdict-approve"}>
                    {task.reviewVerdict.decision === "flag" ? "⚠ FLAGGED" : "✓ APPROVED"}
                  </span>
                </div>
                <p className="kb-detail-assess">{task.reviewVerdict.reason}</p>
                <div className="kb-detail-meta mono">
                  by {task.reviewVerdict.by} · {new Date(task.reviewVerdict.at).toLocaleString()}
                </div>
              </div>
            )}
            <div className="kb-detail-section kb-detail-grouping">
              <div className="kb-detail-label mono">GROUPING</div>
              <label className="kb-detail-row">
                <span className="kb-detail-row-lbl">Feature</span>
                <select
                  className="kb-detail-select"
                  value={task.featureId ?? ""}
                  onChange={(e) => updateTask(pid, task.id, { featureId: e.target.value || null })}
                >
                  <option value="">— none —</option>
                  {projFeatures.map((f) => (
                    <option key={f.id} value={f.id}>{f.name}</option>
                  ))}
                </select>
              </label>
              <label className="kb-detail-row">
                <span className="kb-detail-row-lbl">Milestone</span>
                <select
                  className="kb-detail-select"
                  value={task.milestoneId ?? ""}
                  onChange={(e) => updateTask(pid, task.id, { milestoneId: e.target.value || null })}
                  title={
                    feature?.milestoneId && !task.milestoneId
                      ? `Inherits from feature — ${projMilestones.find((m) => m.id === feature.milestoneId)?.name ?? ""}`
                      : undefined
                  }
                >
                  <option value="">
                    {feature?.milestoneId ? "— inherit from feature —" : "— none —"}
                  </option>
                  {projMilestones.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                      {m.targetAt ? ` · ${new Date(m.targetAt).toLocaleDateString()}` : ""}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// Task NAME is deliberately short (scannable on the board/subway); the longer
// brief goes in the optional description, which rides the agent's prompt.
export const TASK_NAME_MAX = 80;

function AddTaskCard({
  onAdd,
  open,
  setOpen,
}: {
  onAdd: (text: string, description?: string) => void;
  // Controlled open state — lifted so landing on a freshly-created project can
  // open + focus the composer (the input auto-focuses when it mounts).
  open: boolean;
  setOpen: (v: boolean) => void;
}) {
  const [draft, setDraft] = useState("");
  const [desc, setDesc] = useState("");
  if (!open)
    return (
      <button className="kb-add" onClick={() => setOpen(true)}>
        + Add task
      </button>
    );
  const canSubmit = !!draft.trim();
  const submit = () => {
    if (!canSubmit) return;
    onAdd(draft.trim(), desc.trim() || undefined);
    setDraft("");
    setDesc("");
    setOpen(false);
  };
  // ⌘↵ / Ctrl↵ submits from anywhere in the composer; a bare Enter in the
  // single-line name field also submits (it can't hold a newline anyway).
  const cmdEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSubmit) {
      e.preventDefault();
      submit();
    }
  };
  return (
    <div className="kb-card kb-card-backlog kb-addcard">
      <div className="task-name-wrap">
        <input
          className="qx-input"
          autoFocus
          maxLength={TASK_NAME_MAX}
          placeholder="Task name — like a commit subject"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canSubmit) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <span className={"task-name-count mono" + (draft.length >= TASK_NAME_MAX ? " task-name-max" : "")}>
          {draft.length}/{TASK_NAME_MAX}
        </span>
      </div>
      <textarea
        className="qx-input kb-addcard-desc"
        rows={3}
        placeholder="description (optional — the full brief the agent receives)"
        value={desc}
        onChange={(e) => setDesc(e.target.value)}
        onKeyDown={cmdEnter}
      />
      <div className="qx-row kb-addcard-actions">
        <PrimaryButton
          className="btn-sm"
          disabled={!canSubmit}
          reason="Enter a task name to add it."
          onClick={submit}
        >
          Add task
        </PrimaryButton>
        <button className="btn btn-ghost btn-sm" onClick={() => { setDraft(""); setDesc(""); setOpen(false); }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── Project stats ──────────────────────────────────────────────────────────
// Compact per-project numbers derived from the runs + tasks the store already
// holds — no extra fetch. Shown above the kanban/timeline lens toggle. Cells
// that have no data (vendor didn't report tokens/cost) render as "—", not 0,
// so a missing signal doesn't look like a zeroed real one.
function ProjectStats({
  project,
  runs,
  tasks,
  fleet,
}: {
  project: Project;
  runs: TaskRun[];
  tasks: Task[];
  fleet: Agent[];
}) {
  const projTasks = tasks.filter((t) => t.projectId === project.id && !t.archived);
  const projRuns = runs.filter((r) => r.projectId === project.id && !r.archived);
  // Vendor-reported usage sums (nulls stay nulls — a missing signal, not 0).
  // computeUsageRollup already excludes archived runs; passing all `runs` (not
  // projRuns) keeps its own filter as the single source of truth.
  const roll = computeUsageRollup(runs).byProject[project.id];
  const inTok = roll?.tokensIn ?? 0;
  const outTok = roll?.tokensOut ?? 0;
  const usdKnown = roll?.costUsd != null;
  const usdTotal = roll?.costUsd ?? 0;
  const durKnown = roll?.durationMs != null;
  const dur = roll?.durationMs ?? 0;
  // Which provider · model pairs actually ran on this project (dedup for the
  // "Models used" tile). Empty for a fresh project — display renders "—" then.
  const modelPairs = new Set<string>();
  for (const r of projRuns) modelPairs.add(`${r.provider} · ${r.model}`);
  void fleet; // reserved for future name-based grouping; unused today.
  const activeRuns = projRuns.filter((r) => r.status === "running" || r.status === "waiting").length;
  const doneRuns = projRuns.filter((r) => r.status === "done").length;
  const openTasks = projTasks.filter((t) => t.state !== "done").length;
  const doneTasks = projTasks.filter((t) => t.state === "done").length;

  const cells: { label: string; value: string; title?: string }[] = [
    { label: "Tasks", value: `${openTasks} open · ${doneTasks} done` },
    { label: "Runs", value: `${activeRuns} active · ${doneRuns} done` },
    { label: "Tokens in", value: inTok ? fmtNum(inTok) : "—", title: "Prompt tokens sent to the model, summed across runs" },
    { label: "Tokens out", value: outTok ? fmtNum(outTok) : "—", title: "Completion tokens the model generated" },
    { label: "Spend", value: usdKnown ? fmtCost(usdTotal) : "—", title: "Cost in USD (vendor-reported; may be — if the provider didn't include it)" },
    { label: "Run time", value: durKnown ? fmtDurMs(dur) : "—", title: "Cumulative wall-clock across runs (vendor-reported)" },
    {
      label: "Models used",
      value: modelPairs.size ? String(modelPairs.size) : "—",
      title: modelPairs.size ? [...modelPairs].join("\n") : "No runs yet",
    },
  ];
  // Only shown once a daily budget is set — same number the autonomy gate
  // acts on (computeDailySpend, shared with the server), archived runs
  // included, so a run's spend can't be hidden from the budget by archiving it.
  if (project.dailyBudgetUsd != null) {
    const spend = computeDailySpend(runs, project.id, Date.now());
    const paused = spend.spentUsd >= project.dailyBudgetUsd;
    // fmtCost renders any nonzero-but-tiny amount as "<$0.01" (correct for real
    // spend that rounds to nothing) — special-case exact zero so a project with
    // no runs yet today reads as "$0.00", not the confusingly-nonzero-looking "<$0.01".
    const spentLabel = spend.spentUsd === 0 ? "$0.00" : fmtCost(spend.spentUsd);
    // Rough $ estimate for tasks already IN FLIGHT (ongoing, no reported cost
    // yet) — forward-looking, not real spend, so it's called out as "≈" and
    // kept visually distinct from the known-spend number above.
    const committed = committedUsd(tasks, project.id);
    cells.push({
      label: "Budget today",
      value: `${spentLabel} / ${fmtCost(project.dailyBudgetUsd)}${committed > 0 ? ` (≈${fmtCost(committed)} committed)` : ""}${paused ? " ⏸" : ""}`,
      title:
        (paused ? "Auto-pick is paused for the rest of today — you can still assign tasks manually. " : "") +
        (spend.unknownCostRuns > 0
          ? `Known spend only — ${spend.unknownCostRuns} run(s) today didn't report a cost, so the real total may be higher. `
          : "Known spend today vs. the daily budget. ") +
        (committed > 0 ? `≈${fmtCost(committed)} is a rough estimate for tasks currently in flight, not yet reported — not counted toward the ceiling itself.` : ""),
    });
  }

  return (
    <div className="proj-stats">
      {cells.map((c) => (
        <div key={c.label} className="proj-stat" title={c.title}>
          <span className="proj-stat-lbl">{c.label}</span>
          <span className="proj-stat-val">{c.value}</span>
        </div>
      ))}
    </div>
  );
}

// A daily USD ceiling on the project's known spend — once reached, the
// autonomy loop stops auto-picking new work for the rest of the day (manual
// assignment is never affected). Local draft state + commit-on-blur (same
// pattern as the numeric fields in settings.tsx) so a PATCH doesn't fire on
// every keystroke; re-syncs from the project when it changes elsewhere (e.g.
// another tab, or the WS snapshot) and the field isn't mid-edit.
function ProjectDailyBudget({ project, onChange }: { project: Project; onChange: (usd: number | null) => void }) {
  const [draft, setDraft] = useState(project.dailyBudgetUsd == null ? "" : String(project.dailyBudgetUsd));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(project.dailyBudgetUsd == null ? "" : String(project.dailyBudgetUsd));
  }, [project.dailyBudgetUsd, editing]);
  const commit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed === "") return onChange(null);
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 0) return setDraft(project.dailyBudgetUsd == null ? "" : String(project.dailyBudgetUsd)); // reject — revert to the last real value
    onChange(n);
  };
  return (
    <label
      className="proj-approval"
      title="A daily USD ceiling on this project's known spend. Once today's spend reaches it, the autonomy loop stops picking up new work for the rest of the day — in-flight runs finish, and you can still assign tasks manually at any time. Empty = no limit."
    >
      <span className="proj-approval-label mono">Daily budget</span>
      <span className="proj-budget-prefix mono">$</span>
      <input
        type="number"
        min={0}
        step="0.01"
        className="proj-budget-input"
        placeholder="No limit"
        value={draft}
        onFocus={() => setEditing(true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
      />
    </label>
  );
}

// Which GitHub account this project's clone/push/PR use. Only meaningful once
// extra accounts exist (added in Integrations); until then it's hidden to keep
// the header clean. "Default" → the workspace's default GitHub connection.
function ProjectGithubAccount({ project, onChange }: { project: Project; onChange: (id: string | null) => void }) {
  const [accounts, setAccounts] = useState<SecretMeta[]>([]);
  useEffect(() => {
    api.fetchSecrets().then(({ secrets }) => setAccounts(secrets.filter((s) => s.provider === "github"))).catch(() => setAccounts([]));
  }, []);
  if (accounts.length === 0) return null; // nothing to choose between yet
  return (
    <label className="proj-approval" title="Which GitHub account this project's repos push to and are stored under (e.g. business vs personal). Manage accounts in Integrations.">
      <span className="proj-approval-label mono">GitHub</span>
      <select
        className="proj-approval-select"
        value={project.githubCredentialId ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">Default connection</option>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>{a.name || "account"} · ····{a.last4}</option>
        ))}
      </select>
    </label>
  );
}

// Which Fly.io account this project's "Deploy to Fly.io" action authenticates
// with. Same pattern as ProjectGithubAccount — hidden until there's a real
// choice (at least one Fly account added in Integrations).
function ProjectFlyAccount({ project, onChange }: { project: Project; onChange: (id: string | null) => void }) {
  const [accounts, setAccounts] = useState<SecretMeta[]>([]);
  useEffect(() => {
    api.fetchSecrets().then(({ secrets }) => setAccounts(secrets.filter((s) => s.provider === "fly"))).catch(() => setAccounts([]));
  }, []);
  if (accounts.length === 0) return null;
  return (
    <label className="proj-approval" title="Which Fly.io account this project's 'Deploy to Fly.io' action uses. Manage accounts in Integrations.">
      <span className="proj-approval-label mono">Fly</span>
      <select
        className="proj-approval-select"
        value={project.flyCredentialId ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">Default connection</option>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>{a.name || "account"} · ····{a.last4}</option>
        ))}
      </select>
    </label>
  );
}

// Which provider keys this project may run agents on. Empty = any workspace key
// (the default). Narrowing it confines BOTH what the fleet assigns here and what
// a project-scoped MCP token may spin up. Hidden until there's a real choice
// (at least one usable key), to keep the header clean.
function ProjectRunnerKeys({ project, onChange }: { project: Project; onChange: (ids: string[]) => void }) {
  const { providers } = useStore();
  const [secrets, setSecrets] = useState<SecretMeta[]>([]);
  useEffect(() => {
    api.fetchSecrets().then(({ secrets }) => setSecrets(secrets.filter((s) => s.provider !== "github"))).catch(() => setSecrets([]));
  }, []);
  const provName = (id: string) => providers.find((p) => p.id === id)?.name ?? id;
  // Candidates = every stored runner key, plus each available provider's DEFAULT
  // key (id === provider) that isn't already a stored row (covers env-only keys).
  const seen = new Set(secrets.map((s) => s.id));
  const candidates = [
    ...secrets.map((s) => ({ id: s.id, label: s.name || `${provName(s.provider)}${s.isDefault ? " default" : " key"}`, last4: s.last4 as string | undefined })),
    ...providers.filter((p) => p.available && !seen.has(p.id)).map((p) => ({ id: p.id, label: `${p.name} default`, last4: undefined })),
  ];
  if (candidates.length === 0) return null; // nothing to confine to yet

  const enabled = project.enabledRunnerCredentialIds;
  const toggle = (id: string) => onChange(enabled.includes(id) ? enabled.filter((x) => x !== id) : [...enabled, id]);
  const summary = enabled.length === 0 ? "All keys" : `${enabled.length} key${enabled.length === 1 ? "" : "s"}`;
  return (
    <details className="proj-keys">
      <summary className="proj-keys-summary" title="Which provider keys this project may run agents on. All keys = any key in the workspace; narrowing confines assignment (and project-scoped MCP tokens) to the chosen keys.">
        <span className="proj-approval-label mono">Keys</span>
        <span className="proj-keys-value">{summary}</span>
      </summary>
      <div className="proj-keys-menu">
        <div className="proj-keys-hint">
          {enabled.length === 0
            ? "Runs on any workspace key. Pick keys to confine this project."
            : "Only runners on these keys are assignable here."}
        </div>
        {candidates.map((c) => (
          <label key={c.id} className="proj-keys-item">
            <input type="checkbox" checked={enabled.includes(c.id)} onChange={() => toggle(c.id)} />
            <span className="proj-keys-name">{c.label}</span>
            {c.last4 && <span className="proj-keys-fp mono">····{c.last4}</span>}
          </label>
        ))}
      </div>
    </details>
  );
}

// Built-in tools sensible to offer as a checkbox deny-list — the risky/mutating
// surface (shell, file writes, network egress). Read-only tools (Read/Glob/
// Grep/LS/NotebookRead) and Skynet's own control-flow tools (TodoWrite/
// TaskCreate/TaskUpdate/AskUserQuestion/ExitPlanMode — the PLAN panel and HITL
// question/plan gates depend on them) are deliberately left off: blocking one
// of those wouldn't just remove a capability, it'd break Skynet's own
// machinery for this project's runs.
const DENYABLE_TOOLS: Array<{ id: string; hint: string }> = [
  { id: "Bash", hint: "shell commands" },
  { id: "Write", hint: "create/overwrite files" },
  { id: "Edit", hint: "modify files" },
  { id: "MultiEdit", hint: "batch file edits" },
  { id: "NotebookEdit", hint: "edit Jupyter notebooks" },
  { id: "WebFetch", hint: "fetch a URL" },
  { id: "WebSearch", hint: "search the web" },
];

// Which tools this project's agents may never use (see Project.disallowedTools)
// — passed straight to the SDK's own disallowedTools, which removes the tool
// from the model's context entirely (not a per-call HITL gate). Claude runner
// only. Empty/null = no restriction (the default).
function ProjectToolAccess({ project, onChange }: { project: Project; onChange: (tools: string[] | null) => void }) {
  const denied = project.disallowedTools ?? [];
  // A tool set via the API/MCP that isn't in the curated list — still shown
  // (and removable) so toggling a curated checkbox never silently drops it.
  const extra = denied.filter((id) => !DENYABLE_TOOLS.some((t) => t.id === id));
  const toggle = (id: string) => {
    const next = denied.includes(id) ? denied.filter((x) => x !== id) : [...denied, id];
    onChange(next.length ? next : null);
  };
  const summary = denied.length === 0 ? "All tools" : `${denied.length} blocked`;
  return (
    <details className="proj-keys">
      <summary
        className="proj-keys-summary"
        title="Tool names this project's agents may never use — removed from the model entirely, not just gated per call. Claude runner only."
      >
        <span className="proj-approval-label mono">Tools</span>
        <span className="proj-keys-value">{summary}</span>
      </summary>
      <div className="proj-keys-menu">
        <div className="proj-keys-hint">
          {denied.length === 0
            ? "Agents may use every tool. Block a tool to make it categorically unavailable."
            : "These tools are unavailable to this project's agents (Claude runner only)."}
        </div>
        {DENYABLE_TOOLS.map((t) => (
          <label key={t.id} className="proj-keys-item">
            <input type="checkbox" checked={denied.includes(t.id)} onChange={() => toggle(t.id)} />
            <span className="proj-keys-name">{t.id}</span>
            <span className="proj-keys-fp">{t.hint}</span>
          </label>
        ))}
        {extra.map((id) => (
          <label key={id} className="proj-keys-item" title="Set outside this list (API/MCP) — uncheck to remove.">
            <input type="checkbox" checked onChange={() => toggle(id)} />
            <span className="proj-keys-name mono">{id}</span>
          </label>
        ))}
      </div>
    </details>
  );
}

export function ProjectView({
  project,
  now,
  onOpenTask,
  onOpenAgent,
  onBack,
  autoCompose = false,
  onComposeConsumed,
}: {
  project: Project;
  now: number;
  onOpenTask: (id: string) => void;
  onOpenAgent: (id: string) => void;
  onBack: () => void;
  // Set right after Create project → open the task composer focused on land.
  autoCompose?: boolean;
  onComposeConsumed?: () => void;
}) {
  const {
    runs,
    queue,
    tasks,
    fleet,
    updateProject,
    removeApprovalRule,
    deleteProject,
    cloneProjectRepo,
    createTask,
    archiveAgent,
    archiveTask,
    transitionTask,
    assignTask,
    reorderTask,
    informRuns,
  } = useStore();
  const confirm = useConfirm();
  const noFleet = fleet.length === 0;
  // Mass inform, whole-project mode: attach a note to every currently live run
  // in this project — see InformComposer (fleet.tsx) for the shared UI.
  const [informOpen, setInformOpen] = useState(false);
  const liveProjectRunCount = runs.filter((r) => r.projectId === project.id && r.status !== "done").length;
  // Full autonomy merges every run's OWN diff with no review at all — even a
  // multi-agent "Trusted" project only merges unattended when a DIFFERENT
  // fleet agent LLM-reviews it favorably first. Switching to Full (but not
  // away) asks for an explicit confirm rather than a stray dropdown click
  // silently enabling it.
  const onApprovalLevelChange = async (level: string) => {
    if (
      level === "full" &&
      !(await confirm({
        title: "Turn on Full autonomy?",
        body: "Finished diffs merge straight into the base branch with no review at all — not even from another agent. Turn Autonomy off or switch back to Trusted anytime to stop it.",
        confirmLabel: "Enable full autonomy",
        danger: true,
      }))
    )
      return;
    await updateProject(project.id, { approvalLevel: level });
  };
  // Board drag state: the card being dragged + (for backlog reorder) the card it
  // would drop before. Held here so lanes highlight + cards show the drop line.
  const [drag, setDrag] = useState<DragInfo | null>(null);
  const [dropBeforeId, setDropBeforeId] = useState<string | null>(null);
  // The backlog card the pointer sits above → new task is inserted before it
  // (null = end). Excludes the dragged card so it doesn't target itself.
  const beforeIdAt = (laneEl: HTMLElement, clientY: number, draggedId: string): string | null => {
    const cards = Array.from(laneEl.querySelectorAll<HTMLElement>("[data-card-id]")).filter(
      (el) => el.getAttribute("data-card-id") !== draggedId,
    );
    for (const el of cards) {
      const r = el.getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return el.getAttribute("data-card-id");
    }
    return null;
  };
  const performDrop = (to: string, e: React.DragEvent) => {
    const d = drag;
    if (!d || !laneAccepts(d, to, noFleet)) return;
    if (to === d.from) {
      if (d.from === "backlog") void reorderTask(project.id, d.taskId, beforeIdAt(e.currentTarget as HTMLElement, e.clientY, d.taskId));
    } else if (d.from === "todo" && to === "ongoing") {
      void assignTask(project.id, d.taskId); // "Start" on an idle agent
    } else {
      void transitionTask(project.id, d.taskId, to);
    }
    setDrag(null);
    setDropBeforeId(null);
  };
  // Per-project lens (Kanban is the default; Archived shows soft-hidden tasks +
  // restore; Roadmap renders ROADMAP.md from the repo). Persisted per-project in
  // sessionStorage so switching back restores the last chosen lens.
  const [lens, setLens] = useState<"kanban" | "roadmap" | "archived">(() => {
    if (typeof sessionStorage === "undefined") return "kanban";
    const v = sessionStorage.getItem(`skynet.proj.lens.${project.id}`);
    return v === "roadmap" || v === "archived" ? v : "kanban";
  });
  useEffect(() => {
    if (typeof sessionStorage !== "undefined")
      sessionStorage.setItem(`skynet.proj.lens.${project.id}`, lens);
  }, [lens, project.id]);
  // Kanban's own board-vs-timeline sub-view (Timeline used to be a top-level
  // lens; it's a toggle within Kanban now). Independently persisted.
  const [kanbanView, setKanbanView] = useState<"board" | "timeline">(() => {
    if (typeof sessionStorage === "undefined") return "board";
    return sessionStorage.getItem(`skynet.proj.kview.${project.id}`) === "timeline" ? "timeline" : "board";
  });
  useEffect(() => {
    if (typeof sessionStorage !== "undefined")
      sessionStorage.setItem(`skynet.proj.kview.${project.id}`, kanbanView);
  }, [kanbanView, project.id]);
  // The backlog task composer's open state (lifted from AddTaskCard so a fresh
  // "Create project" landing can pop it open + focused). Landing with autoCompose
  // forces the Kanban lens (where the composer lives) and opens it once.
  const [composeOpen, setComposeOpen] = useState(false);
  useEffect(() => {
    if (!autoCompose) return;
    setLens("kanban");
    setComposeOpen(true);
    onComposeConsumed?.();
  }, [autoCompose, project.id, onComposeConsumed]);
  const [cloning, setCloning] = useState(false);
  const [cloneErr, setCloneErr] = useState<string | null>(null);
  const cloneRepo = async () => {
    setCloning(true);
    setCloneErr(null);
    try {
      await cloneProjectRepo(project.id);
    } catch (e) {
      setCloneErr(e instanceof Error ? e.message : "Clone failed");
    } finally {
      setCloning(false);
    }
  };
  const runById = new Map(runs.map((r) => [r.id, r]));
  const pa = agentsForProject(runs, project.id);
  const items = openQueue(queue).filter((q) => pa.some((a) => a.id === q.runId));
  const lead = visualLeadOf(project, runs);
  // A card leaves the board when the TASK is archived, or (legacy) its run is —
  // it moves to the Archived section, stays in the store, and Steward still reads it.
  const hidden = (t: Task) => t.archived || !!(t.runId && runById.get(t.runId)?.archived);
  const archivedTasks = tasks.filter((t) => t.projectId === project.id && hidden(t));
  // Restore un-archives the task and, if its run was archived too, the run.
  const restoreTask = (t: Task) => {
    if (t.archived) void archiveTask(project.id, t.id, false);
    const r = t.runId ? runById.get(t.runId) : undefined;
    if (r?.archived) void archiveAgent(r.id, false);
  };

  const [folded, setFolded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [flyOpen, setFlyOpen] = useState(false);
  const [name, setName] = useState(project.name);
  const [goal, setGoal] = useState(project.goal);
  // The "house rules" — rides every agent prompt on this project (and Steward's
  // grounding). Kept as its own local state so Cancel restores the pristine
  // value if the operator opened the editor and changed their mind.
  const [instructions, setInstructions] = useState(project.instructions ?? "");
  // Which branch this project stacks its runs/PRs onto. Blank = the global default
  // (usually main). Only meaningful for a git-backed / repo-bound project.
  const [baseBranch, setBaseBranch] = useState(project.baseBranch ?? "");
  // Verifier gate: run in the scratch integration worktree after a successful
  // merge, before it's committed. Blank = the global default (SKYNET_CHECK_CMD).
  const [checkCmd, setCheckCmd] = useState(project.checkCmd ?? "");
  // Write task status back to the source (e.g. close/comment the linked GitHub
  // issue on done). Lives in this settings panel now; only meaningful with a repo.
  const [syncToSource, setSyncToSource] = useState(project.syncSourceStatus);
  const hasRepo = !!(project.gitBacked || project.repo);

  useEffect(() => {
    setName(project.name);
    setGoal(project.goal);
    setInstructions(project.instructions ?? "");
    setBaseBranch(project.baseBranch ?? "");
    setCheckCmd(project.checkCmd ?? "");
    setSyncToSource(project.syncSourceStatus);
    setFolded(false);
  }, [project.id, project.name, project.goal, project.instructions, project.baseBranch, project.checkCmd, project.syncSourceStatus]);

  return (
    <section className="projview">
      <button className="btn btn-ghost btn-back" onClick={onBack}>
        ← Back
      </button>
      {editing ? (
        <div className="projview-edit">
          <input className="qx-input" value={name} onChange={(e) => setName(e.target.value)} />
          <textarea
            className="qx-input"
            rows={2}
            placeholder="Goal — what does done look like?"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
          />
          <label className="projview-instructions-label mono">
            Instructions <span className="projview-instructions-hint">— house rules every agent on this project sees. Packages to use, code structure, conventions. Markdown OK.</span>
          </label>
          <textarea
            className="qx-input projview-instructions"
            rows={8}
            placeholder={"e.g.\n- Use the @acme/agents SDK for all agent scaffolding.\n- Follow src/agents/<name>/{index.ts,tools.ts,prompt.md}.\n- Reuse buildTool() from lib/tools; don't hand-roll tool schemas."}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
          />
          {hasRepo && (
            <label className="projview-instructions-label mono">
              Base branch <span className="projview-instructions-hint">— the branch runs cut from and open PRs against. Blank = the default (main). Set a feature branch to stack this project's work onto it.</span>
              <input
                className="qx-input"
                placeholder="main (default)"
                value={baseBranch}
                onChange={(e) => setBaseBranch(e.target.value)}
              />
            </label>
          )}
          {hasRepo && (
            <label className="projview-instructions-label mono">
              Verifier gate — check command <span className="projview-instructions-hint">— run after a merge, before it's committed. A failing check undoes the merge and raises a gate with the full output instead of landing broken code. Blank = the workspace default, if one is set.</span>
              <input
                className="qx-input"
                placeholder="e.g. pnpm test (workspace default, if any)"
                value={checkCmd}
                onChange={(e) => setCheckCmd(e.target.value)}
              />
            </label>
          )}
          {project.repo && (
            <div className="projview-setting">
              <div className="projview-instructions-label mono">
                Sync to source <span className="projview-instructions-hint">— write task status back to its GitHub issue: comment + close on done, reopen if it moves back out.</span>
              </div>
              <label className="proj-autonomy" title="Write task status changes back to the source of truth.">
                <input type="checkbox" className="proj-autonomy-cb" checked={syncToSource} onChange={(e) => setSyncToSource(e.target.checked)} />
                <span className="proj-autonomy-switch" aria-hidden="true" />
                <span className="proj-autonomy-label">{syncToSource ? "On — status flows back to GitHub" : "Off"}</span>
              </label>
            </div>
          )}
          <div className="qx-row">
            <button
              className="btn btn-primary"
              onClick={() => {
                // Trim to detect real content; blank clears the field on the server.
                const nextInstructions = instructions.trim() ? instructions.trim() : null;
                updateProject(project.id, {
                  name: name.trim() || project.name,
                  goal: goal.trim(),
                  instructions: nextInstructions,
                  baseBranch: baseBranch.trim() || null,
                  checkCmd: checkCmd.trim() || null,
                  syncSourceStatus: syncToSource,
                });
                setEditing(false);
              }}
            >
              Save
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => {
                setName(project.name);
                setGoal(project.goal);
                setInstructions(project.instructions ?? "");
                setBaseBranch(project.baseBranch ?? "");
                setCheckCmd(project.checkCmd ?? "");
                setSyncToSource(project.syncSourceStatus);
                setEditing(false);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="projview-head">
          <div className="projview-head-main">
            <h2>{project.name}</h2>
            <p>{project.goal}</p>
            {project.instructions && (
              <button
                className="proj-instructions-chip mono"
                title={project.instructions}
                onClick={() => setEditing(true)}
              >
                ⓘ Instructions active — click to view/edit
              </button>
            )}
            {/* Identity first: the GitHub repo (a human recognizes "org/repo";
                a raw server clone path never reads as an identity). The local
                checkout, when there's also a repo, is just where that repo's
                working copy happens to live, not a second fact worth leading
                with — so it renders second and, in that case, without the raw
                path. A repoPath with NO repo (the desktop "point at a folder"
                case) has no other identity to defer to, so it stays primary
                and keeps its real path. */}
            {project.repo && (
              <div className="mono proj-repo-line">⑂ {project.repo} · runs branch &amp; PR here</div>
            )}
            {project.repoPath && (
              <div className="mono proj-repo-line" title={project.repoPath}>
                {project.gitBacked ? (
                  project.repo ? (
                    <>◈ working copy ready · runs work in auto worktrees here</>
                  ) : (
                    <>◈ git {project.repoPath} · runs work in auto worktrees here</>
                  )
                ) : (
                  <>📁 {project.repoPath}</>
                )}
              </div>
            )}
            {project.baseBranch && (
              <div className="mono proj-repo-line" title="Runs cut from and open PRs against this branch instead of the default.">
                ⎇ stacks onto <b>{project.baseBranch}</b> · runs branch from it &amp; PR into it
              </div>
            )}
            {!hasRepo && (
              <div
                className="mono proj-repo-line proj-chatonly-line"
                title="No worktree, no diff review, no merge — an agent just runs and reports back."
              >
                💬 chat only — no repo connected
              </div>
            )}
            {project.checkCmd && (
              <div className="mono proj-repo-line" title="Runs after a merge, before it's committed — a failure undoes the merge and raises a gate.">
                ✓ verifier gate: <b>{project.checkCmd}</b>
              </div>
            )}
            {/* Repo bound but no local checkout → offer a server-side clone so
                agents have code to work on (needed on a headless/GCP instance;
                also handy on desktop instead of the folder picker). */}
            {project.repo && !project.gitBacked && (
              <div className="proj-clone">
                <button className="btn" disabled={cloning} onClick={() => void cloneRepo()}>
                  {cloning ? "Cloning…" : "⬇ Clone repo to work locally"}
                </button>
                {cloneErr && <span className="proj-clone-err">{cloneErr}</span>}
              </div>
            )}
          </div>
          <div className="projview-head-tools">
            <label
              className={"proj-approval" + (project.approvalLevel === "full" ? " proj-approval-danger" : "")}
              title="How much an agent may run commands without asking. Diff review needs a human unless Autonomy lets another fleet agent LLM-review and merge it — Full autonomy skips even that: every run's own diff merges immediately, no second opinion."
            >
              <span className="proj-approval-label mono">
                {project.approvalLevel === "full" && <span aria-hidden="true">⚠ </span>}
                Approvals
              </span>
              <select
                className="proj-approval-select"
                value={project.approvalLevel ?? "trusted"}
                onChange={(e) => void onApprovalLevelChange(e.target.value)}
              >
                <option value="manual">Manual · ask for everything</option>
                <option value="assisted">Assisted · auto-approve low-risk commands</option>
                <option value="trusted">Trusted · auto-approve low + medium-risk commands</option>
                <option value="full">⚠ Full autonomy · merges to main unattended</option>
              </select>
            </label>
            <label
              className="proj-autonomy"
              title="Whether work starts and gets reviewed on its own: picks up backlog tasks flagged auto-pick, and lets another agent review + resolve a finished diff. Approvals (left) is a different axis — how much of an already-running agent's OWN commands get auto-approved."
            >
              <input
                type="checkbox"
                className="proj-autonomy-cb"
                checked={project.autonomy}
                onChange={(e) => updateProject(project.id, { autonomy: e.target.checked })}
              />
              <span className="proj-autonomy-switch" aria-hidden="true" />
              <span className="proj-autonomy-text">
                <span className="proj-autonomy-label">Autonomy</span>
                <span className="proj-autonomy-hint">Agents triage, auto-pick, and review tasks on their own — off, the board is fully human-driven.</span>
              </span>
            </label>
            <ProjectDailyBudget project={project} onChange={(v) => updateProject(project.id, { dailyBudgetUsd: v })} />
            {project.dailyBudgetUsd != null && (
              <label
                className="proj-autonomy"
                title="Spread today's budget across a working window instead of committing it all to the first tasks the tick sees — early in the day only a fraction is available to new work, growing toward the full budget as the window elapses. Off by default: with it off, the whole remaining budget is available immediately."
              >
                <input
                  type="checkbox"
                  className="proj-autonomy-cb"
                  checked={project.budgetPacing}
                  onChange={(e) => updateProject(project.id, { budgetPacing: e.target.checked })}
                />
                <span className="proj-autonomy-switch" aria-hidden="true" />
                <span className="proj-autonomy-text">
                  <span className="proj-autonomy-label">Pace spend</span>
                  <span className="proj-autonomy-hint">Spread the daily budget across the day instead of the first tasks picked.</span>
                </span>
              </label>
            )}
            <label
              className="proj-autonomy"
              title="Every run proposes a plan first and pauses for your approval before making any changes. Off by default; Claude runners only for now."
            >
              <input
                type="checkbox"
                className="proj-autonomy-cb"
                checked={project.planModeGate}
                onChange={(e) => updateProject(project.id, { planModeGate: e.target.checked })}
              />
              <span className="proj-autonomy-switch" aria-hidden="true" />
              <span className="proj-autonomy-text">
                <span className="proj-autonomy-label">Plan mode</span>
                <span className="proj-autonomy-hint">Agents propose a plan and pause for approval before writing any changes.</span>
              </span>
            </label>
            <label
              className="proj-autonomy"
              title="At review time, a second bounded Claude agent opens a live preview of the changed branch and actually clicks through the behavior before writing its verdict — instead of a stateless one-shot text consult. Off by default (a real agent run, not a cheap call); falls back to the plain consult if the preview can't start or the reviewer times out."
            >
              <input
                type="checkbox"
                className="proj-autonomy-cb"
                checked={project.deepReview}
                onChange={(e) => updateProject(project.id, { deepReview: e.target.checked })}
              />
              <span className="proj-autonomy-switch" aria-hidden="true" />
              <span className="proj-autonomy-text">
                <span className="proj-autonomy-label">Deep review</span>
                <span className="proj-autonomy-hint">A second agent actually runs the change in a live preview before approving — not just reading the diff.</span>
              </span>
            </label>
            {project.deepReview && (
              <label
                className="proj-autonomy"
                title="After the deep reviewer approves, a third agent tries to BREAK the change — malformed input, edge cases, auth boundaries, concurrent actions. Any reproduced medium+ severity finding flips the verdict to flag. Requires deep review on. Off by default."
              >
                <input
                  type="checkbox"
                  className="proj-autonomy-cb"
                  checked={project.breakerReview}
                  onChange={(e) => updateProject(project.id, { breakerReview: e.target.checked })}
                />
                <span className="proj-autonomy-switch" aria-hidden="true" />
                <span className="proj-autonomy-text">
                  <span className="proj-autonomy-label">Breaker review</span>
                  <span className="proj-autonomy-hint">After the verifier approves, an adversarial agent tries to reproduce failures before it passes.</span>
                </span>
              </label>
            )}
            <ProjectGithubAccount project={project} onChange={(id) => updateProject(project.id, { githubCredentialId: id })} />
            <ProjectFlyAccount project={project} onChange={(id) => updateProject(project.id, { flyCredentialId: id })} />
            <ProjectRunnerKeys project={project} onChange={(ids) => updateProject(project.id, { enabledRunnerCredentialIds: ids })} />
            <ProjectToolAccess project={project} onChange={(tools) => updateProject(project.id, { disallowedTools: tools })} />
            {project.repoPath && (
              <button className="btn" onClick={() => setPreviewOpen(true)} title="Run the app and preview it live — it refreshes as the fleet merges changes.">
                ▶ Preview app
              </button>
            )}
            {project.repoPath && (
              <button
                className={"btn" + (project.flyDeployment?.status === "live" ? " proj-fly-live" : "")}
                onClick={() => setFlyOpen(true)}
                title="Deploy the integration branch to Fly.io — a REAL, persistent app with a shareable URL that keeps running independent of Skynet, until you stop it."
              >
                {project.flyDeployment?.status === "live" ? "● Live on Fly" : "⇪ Deploy to Fly.io"}
              </button>
            )}
            {liveProjectRunCount > 0 && (
              <button
                className={"btn btn-ghost" + (informOpen ? " on" : "")}
                title="Attach a note to every currently live run in this project — no extra turn, no reply expected."
                onClick={() => setInformOpen((v) => !v)}
              >
                📣 Inform active agents
              </button>
            )}
            <button className="btn proj-config-btn" onClick={() => setEditing(true)} title="Project settings" aria-label="Project settings">⚙</button>
            {confirmDel ? (
              <span className="del-confirm">
                Delete project?{" "}
                <button className="btn btn-danger" onClick={() => { deleteProject(project.id); onBack(); }}>Yes, delete</button>
                <button className="btn btn-ghost" onClick={() => setConfirmDel(false)}>No</button>
              </span>
            ) : (
              <button className="btn btn-retire" onClick={() => setConfirmDel(true)}>Delete</button>
            )}
          </div>
        </div>
      )}

      {informOpen && (
        <InformComposer
          count={liveProjectRunCount}
          countLabel={`this project's ${liveProjectRunCount} active agent${liveProjectRunCount === 1 ? "" : "s"}`}
          onCancel={() => setInformOpen(false)}
          onSend={async (note) => {
            const { informed, skipped } = await informRuns({ note, projectId: project.id });
            toastInformResult(informed.length, skipped.length);
            setInformOpen(false);
          }}
        />
      )}

      {(project.approvalRules?.length ?? 0) > 0 && (
        <div className="proj-approval-rules">
          <span className="proj-approval-rules-label mono">Always allowed</span>
          {project.approvalRules!.map((r) => (
            <span key={r.id} className="approval-rule-chip mono" title={`auto-approved (${r.riskCap}-risk) in this project`}>
              <span className="approval-rule-cmd">$ {r.command}</span>
              <button
                className="approval-rule-x"
                title="Revoke — this command will ask again"
                aria-label={`Revoke auto-approval for ${r.command}`}
                onClick={() => removeApprovalRule(project.id, r.id)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {lead && (
        <div className="proj-delivery">
          <button className="proj-delivery-head" onClick={() => setFolded((f) => !f)} aria-expanded={!folded}>
            <span className="fold-caret">{folded ? "▸" : "▾"}</span>
            <span className="proj-delivery-title">LIVE PREVIEW</span>
            <span className="proj-delivery-sub">
              merged work · {lead.status === "done" ? "shipped" : "building"} · {lead.name}
            </span>
          </button>
          {!folded && (
            <div className="proj-delivery-body">
              <ProjectDelivery project={project} />
            </div>
          )}
        </div>
      )}

      {items.length > 0 && (
        <div className="projview-queue">
          <div className="panel-head">WAITING ON YOU</div>
          {items.map((it) => (
            <QueueCard
              key={it.id}
              item={it}
              agent={runs.find((a) => a.id === it.runId)}
              now={now}
              selected={false}
              onOpen={() => onOpenTask(it.runId)}
            />
          ))}
        </div>
      )}

      {agentsForProject(runs, project.id).length > 0 && (
        <div className="projview-line">
          <div className="panel-head">PROJECT LINE</div>
          <SwDiagram project={project} onOpenTask={onOpenTask} onOpenAgent={onOpenAgent} />
        </div>
      )}

      <ProjectStats project={project} runs={runs} tasks={tasks} fleet={fleet} />

      <div className="projview-lens">
        <div className="lens-switch">
          {(["kanban", "roadmap", "archived"] as const).map((id) => (
            <button
              key={id}
              className={"lens-btn" + (lens === id ? " on" : "")}
              onClick={() => setLens(id)}
            >
              {id === "kanban" ? "Kanban" : id === "roadmap" ? "Roadmap" : "Archived"}
              {id === "archived" && archivedTasks.length > 0 && (
                <span className="lens-btn-count">{archivedTasks.length}</span>
              )}
            </button>
          ))}
        </div>
        {lens === "kanban" && (
          <div className="lens-switch lens-switch-sub">
            {(["board", "timeline"] as const).map((id) => (
              <button
                key={id}
                className={"lens-btn" + (kanbanView === id ? " on" : "")}
                onClick={() => setKanbanView(id)}
              >
                {id === "board" ? "Board" : "Timeline"}
              </button>
            ))}
          </div>
        )}
      </div>

      {lens === "roadmap" ? (
        <RoadmapDocView project={project} />
      ) : lens === "archived" ? (
        <div className="projview-archived">
          {archivedTasks.length === 0 ? (
            <div className="kb-empty">No archived tasks. Archive a task from its ⤓ button to soft-hide it — it stays in the store and can be restored from here.</div>
          ) : (
            <div className="kb-archive-list">
              {archivedTasks.map((t) => {
                const r = t.runId ? runById.get(t.runId) : undefined;
                return (
                  <div key={t.id} className="kb-archive-row">
                    <button
                      className="kb-archive-name"
                      title={r ? "Open the run" : "Archived task"}
                      disabled={!r}
                      onClick={() => r && onOpenTask(r.id)}
                    >
                      {t.state === "done" ? "✓ " : ""}
                      {t.text}
                    </button>
                    <span className="kb-archive-branch mono">{t.state}{r ? " · " + r.branch : ""}</span>
                    <button className="btn btn-ghost btn-sm" onClick={() => restoreTask(t)}>
                      Restore
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : kanbanView === "timeline" ? (
        <div className="projview-timeline">
          <TimelineView now={now} onOpenTask={onOpenTask} projectId={project.id} hideHeader />
        </div>
      ) : (
      <BoardDnd.Provider value={{ drag, begin: setDrag, end: () => { setDrag(null); setDropBeforeId(null); }, dropBeforeId }}>
      <div className={"kb-cols kb-cols-6" + (drag ? " kb-dragging" : "")}>
        {TASK_STATES.map((st) => {
          const colTasks = tasksInState(tasks, project.id, st).filter((t) => !hidden(t));
          const meta = TASK_STATE_META[st];
          const accepts = laneAccepts(drag, st, noFleet);
          return (
            <div
              className={
                "kb-col kb-col-" + st +
                (drag && accepts ? " kb-col-drop-ok" : "") +
                (drag && !accepts && drag.from !== st ? " kb-col-drop-no" : "")
              }
              key={st}
              onDragOver={(e) => {
                if (!accepts) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (st === "backlog" && drag!.from === "backlog") {
                  setDropBeforeId(beforeIdAt(e.currentTarget, e.clientY, drag!.taskId));
                }
              }}
              onDrop={(e) => {
                if (!accepts) return;
                e.preventDefault();
                performDrop(st, e);
              }}
            >
              <div className="kb-head" style={{ color: meta.color }}>
                <span className="kb-pip" style={{ background: meta.color }} aria-hidden="true" />
                {meta.label}
                <span className="kb-count">{colTasks.length}</span>
              </div>
              <div className="kb-lane-body">
                {colTasks.map((t, i) => (
                  <TaskCard
                    key={t.id}
                    task={t}
                    run={t.runId ? runById.get(t.runId) : undefined}
                    onOpenTask={onOpenTask}
                    canMoveUp={i > 0}
                    canMoveDown={i < colTasks.length - 1}
                  />
                ))}
                {st === "backlog" && drag?.from === "backlog" && dropBeforeId === null && <div className="kb-drop-line" aria-hidden="true" />}
                {st === "backlog" && <AddTaskCard open={composeOpen} setOpen={setComposeOpen} onAdd={(text, description) => createTask(project.id, text, description)} />}
                {colTasks.length === 0 && st !== "backlog" && <div className="kb-empty">{accepts ? "Drop here" : "No tasks"}</div>}
              </div>
            </div>
          );
        })}
      </div>
      </BoardDnd.Provider>
      )}


      {previewOpen && <LivePreviewModal id={project.id} title={"Live preview · " + project.name} onClose={() => setPreviewOpen(false)} />}
      {flyOpen && <FlyDeployModal project={project} onClose={() => setFlyOpen(false)} />}
    </section>
  );
}

// ─── Live preview modal (Phase-1 v0) ────────────────────────────────────────
// Runs the PROJECT's web app (server-side, sandboxed) and iframes it here — the
// integration branch, refreshing as the fleet merges. It shows MERGED work only:
// an in-flight run's changes appear once that run is approved and merged (there's
// no per-run pre-merge preview — project level is the single, unambiguous view).
// Polls status while open; the app runs on its own localhost origin so its code
// can't reach the console. See docs/live-preview.md.
const DEVICES: Record<string, number | null> = { Desktop: null, Tablet: 768, Mobile: 390 };

export function LivePreviewModal({
  id,
  title,
  onClose,
}: {
  id: string;
  title: string;
  onClose: () => void;
}) {
  // Which slice to preview: main (base branch) · merged (integration branch) ·
  // latest (merged + review-ready changes combined). Drives start().
  const [source, setSource] = useState<api.PreviewSource>("merged");
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const ctl = { status: () => api.previewStatus(id), start: () => api.previewStart(id, sourceRef.current), stop: () => api.previewStop(id), restart: () => api.previewRestart(id) };
  const ctlRef = useRef(ctl);
  ctlRef.current = ctl;

  const [st, setSt] = useState<api.PreviewState | null>(null);
  const [device, setDevice] = useState<string>("Desktop");
  const [showLogs, setShowLogs] = useState(false);
  const [nonce, setNonce] = useState(0); // bump to reload the iframe
  // Split-screen dock (default — watch the board + the app together) vs a
  // full-bleed modal. Dock reserves board space via a root class (see CSS).
  const [mode, setMode] = useState<"dock" | "modal">("dock");
  const startedRef = useRef(false);

  // Start on open (once), then poll status while the pane is mounted.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const s = startedRef.current ? await ctlRef.current.status() : (startedRef.current = true, await ctlRef.current.start());
        if (alive) setSt(s);
      } catch {
        /* transient */
      }
    };
    void tick();
    const iv = setInterval(tick, 1500);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [id]);

  // Reserve right-hand board space while docked (removed on close / when modal).
  useEffect(() => {
    const root = document.documentElement;
    if (mode === "dock") root.classList.add("lp-docked");
    else root.classList.remove("lp-docked");
    return () => root.classList.remove("lp-docked");
  }, [mode]);

  // Drag the dock's left edge to resize it. Writes --lp-dock-w on :root, which
  // both the dock width and the board's reserved padding read (see CSS).
  const onResizeStart = (e: React.PointerEvent) => {
    e.preventDefault();
    const move = (ev: PointerEvent) => {
      const w = Math.min(Math.max(window.innerWidth - ev.clientX, 360), window.innerWidth * 0.85);
      document.documentElement.style.setProperty("--lp-dock-w", w + "px");
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.userSelect = "";
    };
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Keep the log view pinned to the newest line as output streams in — but only
  // when the operator is already near the bottom, so it never yanks the view
  // while they've scrolled up to read an earlier error.
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) el.scrollTop = el.scrollHeight;
  }, [st?.logs, showLogs]);

  const width = DEVICES[device];
  const live = st?.status === "live" && st.url;
  // Switch the previewed slice — re-(re)starts the server against the new source
  // (keeps node_modules warm; see startSpec's soft-replace).
  const switchSource = (next: api.PreviewSource) => {
    if (next === source) return;
    setSource(next);
    startedRef.current = true;
    void api.previewStart(id, next).then(setSt).catch(() => undefined);
  };
  const SRC_LABEL: Record<api.PreviewSource, string> = { main: "Main", merged: "Merged", latest: "Latest" };
  const SRC_HINT: Record<api.PreviewSource, string> = {
    main: "The base branch — what's actually shipped/stable. No in-flight work.",
    merged: "The integration branch — approved + merged changes only.",
    latest: "Merged + every review-ready change, combined into one preview (conflicting ones skipped).",
  };

  const inner = (
      <div className={"lp-modal lp-mode-" + mode} onClick={(e) => e.stopPropagation()}>
        <div className="lp-bar">
          <span className="lp-title">{title}</span>
          <div className="lp-source" role="group" aria-label="Preview source">
            {(["main", "merged", "latest"] as const).map((s) => (
              <button key={s} className={"lp-src" + (source === s ? " on" : "")} title={SRC_HINT[s]} onClick={() => switchSource(s)}>
                {SRC_LABEL[s]}
              </button>
            ))}
          </div>
          {source === "latest" && st?.combined && (
            <span className="lp-combined mono" title="Review-ready changes folded into this preview">
              {st.combined.included}/{st.combined.total} combined{st.combined.skipped > 0 ? ` · ${st.combined.skipped} skipped` : ""}
            </span>
          )}
          <span className={"lp-status lp-status-" + (st?.status ?? "idle")}>
            {st?.status === "live" ? "● live" : st?.status === "starting" ? "◐ starting…" : st?.status === "failed" ? "✕ failed" : st?.status ?? "…"}
          </span>
          {live && <span className="lp-url mono">{st!.url}</span>}
          <span className="lp-spacer" />
          <div className="lp-devices">
            {Object.keys(DEVICES).map((d) => (
              <button key={d} className={"lp-dev" + (d === device ? " on" : "")} onClick={() => setDevice(d)}>{d}</button>
            ))}
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => setMode((m) => (m === "dock" ? "modal" : "dock"))} title={mode === "dock" ? "Expand to full screen" : "Dock beside the board"}>
            {mode === "dock" ? "⤢ Expand" : "⇔ Dock"}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => setNonce((n) => n + 1)} title="Reload the app in the frame">↻ Reload</button>
          <button className="btn btn-ghost btn-sm" onClick={() => { startedRef.current = false; void ctl.restart().then(setSt); }} title="Restart the preview server">⟳ Restart</button>
          <button className="btn btn-ghost btn-sm" onClick={() => { setShowLogs((s) => !s); }}>Logs</button>
          <button className="btn btn-ghost btn-sm" onClick={() => { void ctl.stop(); onClose(); }}>✕ Close</button>
        </div>

        <div className="lp-body">
          {live ? (
            <div className="lp-frame-wrap">
              <iframe
                key={nonce}
                className="lp-frame"
                style={width ? { width, margin: "0 auto" } : undefined}
                src={st!.url!}
                title="app preview"
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              />
            </div>
          ) : (
            <div className="lp-placeholder">
              <div className={"lp-ph-dot lp-status-" + (st?.status ?? "idle")} />
              <div className="lp-ph-msg">
                {st?.status === "failed" ? (st.error ?? "Preview failed.") : st?.status === "starting" ? "Starting the app…" : "Preparing preview…"}
              </div>
              {st?.recipe && <div className="lp-ph-cmd mono">$ {st.recipe.cmd}</div>}
              {st?.status === "failed" && (
                <button className="btn btn-primary btn-sm" onClick={() => { startedRef.current = false; void ctl.restart().then(setSt); }}>Retry</button>
              )}
            </div>
          )}
          {showLogs && (
            <pre ref={logRef} className="lp-logs mono">{(st?.logs ?? []).join("\n") || "(no output yet)"}</pre>
          )}
        </div>
      </div>
  );

  // Modal dims the board behind it; dock sits beside it (no backdrop) so the
  // operator can keep working while the app updates live.
  return mode === "modal" ? (
    <div className="lp-backdrop" onClick={onClose}>{inner}</div>
  ) : (
    <div className="lp-dock">
      <div className="lp-resize" onPointerDown={onResizeStart} title="Drag to resize" />
      {inner}
    </div>
  );
}

// ─── Deploy to Fly.io modal (persistent, human-triggered) ──────────────────
// Deploys the project's integration branch to a REAL Fly.io app — a
// shareable https://…fly.dev URL that keeps running independent of the local
// Skynet process, until an operator explicitly stops it (never on restart,
// never auto-torn-down). Distinct from "Preview app" above (that one is
// ephemeral: a local dev server, gone the moment Skynet stops). Not iframed —
// a real external app, meant to be opened and shared, not sandboxed.
// See docs/live-preview.md §"Deploy to Fly.io".
const FLY_STATUS_LABEL: Record<api.FlyDeployState["status"], string> = {
  idle: "Not deployed",
  deploying: "◐ Deploying…",
  live: "● Live",
  failed: "✕ Failed",
  stopped: "Stopped",
};

function FlyDeployModal({ project, onClose }: { project: Project; onClose: () => void }) {
  const confirm = useConfirm();
  const [st, setSt] = useState<api.FlyDeployState | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const s = await api.flyDeployStatus(project.id);
        if (alive) setSt(s);
      } catch {
        /* transient */
      }
    };
    void tick();
    const iv = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [project.id]);

  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) el.scrollTop = el.scrollHeight;
  }, [st?.logs, showLogs]);

  const deploy = async () => {
    setBusy(true);
    setErr(null);
    try {
      setSt(await api.flyDeployStart(project.id));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const destroy = async () => {
    const ok = await confirm({
      title: "Stop & destroy this deployment?",
      body: `This permanently destroys the Fly app "${st?.appName ?? ""}" — the URL stops resolving immediately. This can't be undone; redeploying creates a fresh app.`,
      confirmLabel: "Destroy",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setErr(null);
    try {
      setSt(await api.flyDeployStop(project.id));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const status = st?.status ?? "idle";
  const deployed = status === "live" || status === "failed" || status === "stopped";

  return (
    <div className="lp-backdrop" onClick={onClose}>
      <div className="lp-modal fly-modal" onClick={(e) => e.stopPropagation()}>
        <div className="lp-bar">
          <span className="lp-title">Deploy to Fly.io · {project.name}</span>
          <span className={"lp-status fly-status-" + status}>{FLY_STATUS_LABEL[status]}</span>
          <span className="lp-spacer" />
          <button className="btn btn-ghost btn-sm" onClick={() => setShowLogs((s) => !s)}>Logs</button>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>✕ Close</button>
        </div>
        <div className="lp-body fly-body">
          <p className="fly-note">
            A <strong>real, persistent</strong> deployment — separate from "Preview app" (which is ephemeral: a local
            dev server that stops the moment Skynet does). This one keeps running on Fly.io, with a real shareable
            URL, until you explicitly stop it below.
          </p>
          {err && <div className="gh-warn">{err}</div>}
          {status === "idle" && !busy && (
            <div className="lp-placeholder">
              <div className="lp-ph-msg">Not deployed yet. Deploys the integration branch (the fleet's merged, approved work).</div>
              <button className="btn btn-primary" disabled={busy} onClick={() => void deploy()}>⇪ Deploy to Fly.io</button>
            </div>
          )}
          {status === "deploying" && (
            <div className="lp-placeholder">
              <div className={"lp-ph-dot fly-status-" + status} />
              <div className="lp-ph-msg">Building and deploying — this can take a minute or two.</div>
            </div>
          )}
          {deployed && (
            <div className="fly-details">
              {st?.url && (
                <div className="fly-row">
                  <span className="fly-row-label">URL</span>
                  <a className="fly-url mono" href={st.url} target="_blank" rel="noreferrer">{st.url} ↗</a>
                </div>
              )}
              {st?.appName && (
                <div className="fly-row"><span className="fly-row-label">App</span><span className="mono">{st.appName}</span></div>
              )}
              {st?.region && (
                <div className="fly-row"><span className="fly-row-label">Region</span><span className="mono">{st.region}</span></div>
              )}
              {st?.branch && (
                <div className="fly-row"><span className="fly-row-label">Branch</span><span className="mono">{st.branch}{st.sha ? ` @ ${st.sha.slice(0, 7)}` : ""}</span></div>
              )}
              {st?.deployedAt && (
                <div className="fly-row"><span className="fly-row-label">Deployed</span><span>{new Date(st.deployedAt).toLocaleString()}</span></div>
              )}
              {status === "failed" && st?.error && <div className="gh-warn">{st.error}</div>}
              <div className="fly-actions">
                <button className="btn btn-primary" disabled={busy} onClick={() => void deploy()}>
                  {status === "failed" ? "Retry deploy" : "↻ Redeploy"}
                </button>
                {st?.appName && (
                  <button className="btn btn-danger" disabled={busy} onClick={() => void destroy()}>
                    Stop & destroy
                  </button>
                )}
              </div>
            </div>
          )}
          {showLogs && (
            <pre ref={logRef} className="lp-logs mono">{(st?.logs ?? []).join("\n") || "(no output yet)"}</pre>
          )}
        </div>
      </div>
    </div>
  );
}
