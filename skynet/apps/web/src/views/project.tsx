import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { TaskRun, Project, Task, TaskAssignment, Agent } from "@skynet/shared";
import { useStore } from "../lib/store";
import * as api from "../lib/client";
import {
  agentsForProject,
  curStep,
  openQueue,
  STATUS_META,
  TASK_STATES,
  TASK_STATE_META,
  tasksInState,
} from "../lib/derive";
import { Bar, StatusDot } from "../components/common";
import { ProjectDelivery, visualLeadOf } from "../components/preview";
import { Markdown } from "../components/markdown";
import { SwDiagram } from "../components/subway-diagram";
import { QueueCard } from "./queue";
import { TimelineView } from "./home";

const stop = (e: React.MouseEvent) => e.stopPropagation();

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
  const now = Date.now();
  const dSec = Math.round((at - now) / 1000);
  if (Math.abs(dSec) < 60) return dSec >= 0 ? "in <1m" : "started";
  if (Math.abs(dSec) < 3600) {
    const m = Math.round(dSec / 60);
    return m >= 0 ? `in ${m}m` : `${-m}m ago`;
  }
  if (Math.abs(dSec) < 86400) {
    const h = Math.round(dSec / 3600);
    return h >= 0 ? `in ${h}h` : `${-h}h ago`;
  }
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
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

// One card per Task. For pre-run states (backlog/triage/todo) it shows the task
// text + stage controls; for ongoing/review/done it joins the linked TaskRun to
// show live status/progress and opens the Task detail view on click.
function TaskCard({
  task,
  run,
  onOpenTask,
}: {
  task: Task;
  run?: TaskRun;
  onOpenTask: (id: string) => void;
}) {
  const {
    queue,
    fleet,
    updateTask,
    deleteTask,
    forceTaskDone,
    archiveTask,
  } = useStore();
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
      className={"kb-card kb-card-" + s + (dragging ? " kb-card-dragging" : "")}
      role="button"
      tabIndex={0}
      data-card-id={task.id}
      draggable
      onDragStart={(e) => {
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
        {(s === "backlog" || s === "triage" || s === "todo") && (
          <span className="kb-card-tools" onClick={stop}>
            <button className="kb-tool" title="Edit task" onClick={() => setEditing(true)}>✎</button>
            <button className="kb-tool" title="Archive — hide from the board (kept in the store, still read by Steward)" onClick={() => archiveTask(pid, task.id, true)}>⤓</button>
            <button className="kb-tool kb-tool-del" title="Delete task" onClick={() => deleteTask(pid, task.id)}>×</button>
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

      {s === "triage" && task.assessment && <div className="kb-assessment">{task.assessment}</div>}
      {s === "review" && task.reviewFlaggedReason && (
        <div className="kb-flag">⚠ flagged for you — {task.reviewFlaggedReason}</div>
      )}

      {(task.estimatedDurationMs != null || task.plannedStartAt != null) && (
        <div className="kb-sched" onClick={stop}>
          {task.estimatedDurationMs != null && (
            <span className="kb-sched-chip" title="Estimated duration">⏱ {fmtDurationChip(task.estimatedDurationMs)}</span>
          )}
          {task.plannedStartAt != null && (
            <span className="kb-sched-chip" title={new Date(task.plannedStartAt).toLocaleString()}>
              📅 {fmtStartChip(task.plannedStartAt)}
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
          <AgentEligibility task={task} fleet={fleet} editable={false} onChange={() => {}} />
        </div>
      )}

      {/* Non-move controls only — stage changes happen by dragging the card to
          another lane (todo→ongoing starts, review→done approves, backlog drags
          reorder). The escape hatches (Force done / Sync), Auto-pick, and Archive
          can't be expressed as a lane move, so they stay as buttons. */}
      {(s === "todo" || s === "ongoing" || s === "review" || s === "done") && (
        <div className="kb-actions" onClick={stop}>
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
                <p className="kb-detail-assess">{task.assessment}</p>
              </div>
            )}
            {task.reviewFlaggedReason && (
              <div className="kb-detail-section">
                <div className="kb-detail-label mono">FLAGGED FOR REVIEW</div>
                <p className="kb-detail-assess">⚠ {task.reviewFlaggedReason}</p>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

// Task NAME is deliberately short (scannable on the board/subway); the longer
// brief goes in the optional description, which rides the agent's prompt.
export const TASK_NAME_MAX = 80;

function AddTaskCard({ onAdd }: { onAdd: (text: string, description?: string) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [desc, setDesc] = useState("");
  if (!open)
    return (
      <button className="kb-add" onClick={() => setOpen(true)}>
        + Add task
      </button>
    );
  const submit = () => {
    onAdd(draft.trim(), desc.trim() || undefined);
    setDraft("");
    setDesc("");
    setOpen(false);
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
          onKeyDown={(e) => e.key === "Enter" && draft.trim() && submit()}
        />
        <span className={"task-name-count mono" + (draft.length >= TASK_NAME_MAX ? " task-name-max" : "")}>
          {draft.length}/{TASK_NAME_MAX}
        </span>
      </div>
      <textarea
        className="qx-input kb-addcard-desc"
        rows={3}
        placeholder="Description (optional) — context, constraints, what “done” looks like…"
        value={desc}
        onChange={(e) => setDesc(e.target.value)}
      />
      <div className="qx-row kb-addcard-actions">
        <button className="btn btn-primary btn-sm" disabled={!draft.trim()} onClick={submit}>
          Add task
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => { setDraft(""); setDesc(""); setOpen(false); }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── Project assistant ──────────────────────────────────────────────────────
// A repo-aware chat: ask about the project's current status or its content
// (the assistant reads files like ROADMAP.md). Uses the same general-purpose
// LLM as the rest of Skynet, via POST /api/projects/:id/chat.

// `action` carries a project/task change the assistant offered; the operator
// confirms (or dismisses) via a chip under the message — mirrors Telegram's
// confirm-before-execute. `actionState` tracks the chip once acted on.
type AsstMsg = {
  role: "user" | "assistant";
  content: string;
  action?: api.AssistantAction;
  actionState?: "pending" | "done" | "dismissed";
};

// Steward's project chat is kept per-project in memory so it survives navigating
// away and back within a session (the panel is remounted on each visit). A full
// reload / new session starts fresh — persisting across sessions isn't required.
type ChatState = { open: boolean; msgs: AsstMsg[]; input: string };
const chatCache = new Map<string, ChatState>();
const ASSISTANT_SUGGESTIONS = [
  "What's the current status of this project?",
  "Summarize the roadmap",
  "Add a task to write onboarding docs",
];

function ProjectAssistant({ projectId }: { projectId: string }) {
  const { createTask, transitionTask, updateTask, deleteTask, moveTask, updateProject, archiveTask } = useStore();
  // Restore this project's chat if we've talked here already this session (the
  // component is keyed by projectId, so this read is correct on every mount).
  const cached = chatCache.get(projectId);
  const [open, setOpen] = useState(cached?.open ?? false);
  const [msgs, setMsgs] = useState<AsstMsg[]>(cached?.msgs ?? []);
  const [input, setInput] = useState(cached?.input ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Typewriter smoothing: the server streams in coarse chunks (often whole
  // sentences), which reads as a stutter. We collect the received text in a ref
  // and reveal it a few characters per frame, so the bubble fills in smoothly
  // regardless of chunk size. `target` is everything received; `shown` is how
  // much is currently visible; `done` flips when the stream ends so the loop can
  // stop once it has caught up.
  const targetRef = useRef("");
  const shownRef = useRef(0);
  const doneRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [msgs, busy]);

  // Persist the chat per-project so it's restored on the next visit this session.
  useEffect(() => {
    chatCache.set(projectId, { open, msgs, input });
  }, [projectId, open, msgs, input]);

  // On unmount: stop the typewriter loop, and if we leave mid-reveal, persist the
  // FULL received reply (not the partially typed-out text) so returning shows the
  // complete message rather than a truncated one.
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const target = targetRef.current;
    if (target && shownRef.current < target.length) {
      const prev = chatCache.get(projectId);
      if (prev && prev.msgs.length) {
        const m = prev.msgs.slice();
        const last = m[m.length - 1];
        if (last && last.role === "assistant") {
          m[m.length - 1] = { ...last, content: target };
          chatCache.set(projectId, { ...prev, msgs: m });
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Auto-grow was set on the DOM element imperatively (style.height); when the
  // controlled value clears after send, reset it so the textarea snaps back to
  // one row instead of staying tall.
  useEffect(() => {
    if (input === "" && inputRef.current) inputRef.current.style.height = "";
  }, [input]);

  const paintLast = (content: string) =>
    setMsgs((m) => {
      const next = m.slice();
      const last = next[next.length - 1];
      // Preserve any proposed action attached to the bubble while the reveal loop
      // fills in its text.
      if (last && last.role === "assistant") next[next.length - 1] = { ...last, content };
      return next;
    });

  const tick = () => {
    const target = targetRef.current;
    if (shownRef.current < target.length) {
      // Reveal faster when we're further behind, so we never lag the stream.
      const backlog = target.length - shownRef.current;
      const step = Math.max(2, Math.ceil(backlog / 8));
      shownRef.current = Math.min(target.length, shownRef.current + step);
      paintLast(target.slice(0, shownRef.current));
    }
    if (shownRef.current >= target.length && doneRef.current) {
      timerRef.current = null;
      return;
    }
    timerRef.current = setTimeout(tick, 16);
  };

  const ask = async (q: string) => {
    const question = q.trim();
    if (!question || busy) return;
    setErr(null);
    // Strip any attached action fields from history — the API takes plain turns.
    const history = msgs.slice().map(({ role, content }) => ({ role, content }));
    // Add the operator line + an empty assistant bubble the reveal loop fills in.
    setMsgs([...msgs, { role: "user", content: question }, { role: "assistant", content: "" }]);
    setInput("");
    setBusy(true);
    // Reset + start the reveal loop.
    targetRef.current = "";
    shownRef.current = 0;
    doneRef.current = false;
    if (timerRef.current) clearTimeout(timerRef.current);
    tick();
    try {
      // Non-streaming so we also get any proposed action (confirm-first). The
      // reply is fed into the reveal loop to animate in-place, and the action (if
      // any) is attached to the same assistant bubble.
      const { reply, action } = await api.projectChat(projectId, question, history);
      targetRef.current = reply;
      if (timerRef.current === null) tick(); // loop had parked — restart it
      if (action) {
        setMsgs((m) => {
          const next = m.slice();
          const last = next[next.length - 1];
          if (last && last.role === "assistant")
            next[next.length - 1] = { ...last, action, actionState: "pending" as const };
          return next;
        });
      }

    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't reach the assistant — try again.");
      // Drop the assistant bubble on failure if nothing was received.
      if (targetRef.current === "") setMsgs((m) => m.slice(0, -1));
    } finally {
      doneRef.current = true; // let the reveal loop finish and park itself
      setBusy(false);
    }
  };

  // Execute a confirmed action via the SAME guarded store methods the board uses
  // (transitionTask enforces legal moves; updateProject/updateTask are validated
  // server-side). The assistant only ever proposes — nothing runs without this.
  const runAction = async (a: api.AssistantAction): Promise<void> => {
    switch (a.kind) {
      case "add_task": return createTask(projectId, a.text ?? "", a.description);
      case "move_task": return transitionTask(projectId, a.taskId!, a.to!);
      case "rename_task": return updateTask(projectId, a.taskId!, { text: a.text });
      case "set_task_desc": return updateTask(projectId, a.taskId!, { description: a.description });
      case "remove_task": return deleteTask(projectId, a.taskId!);
      case "archive_task": return archiveTask(projectId, a.taskId!, true);
      case "reorder_task": return moveTask(projectId, a.taskId!, a.direction!);
      case "rename_project": return updateProject(projectId, { name: a.name });
      case "set_goal": return updateProject(projectId, { goal: a.goal });
      case "set_autonomy": return updateProject(projectId, { autonomy: a.autonomy });
      case "set_status": return updateProject(projectId, { status: a.status });
      case "set_schedule": {
        // Only include fields the assistant actually set — updateTask treats
        // omission as "leave as-is" and `null` as "clear".
        const patch: { estimatedDurationMs?: number | null; plannedStartAt?: number | null } = {};
        if (a.estimatedDurationMs !== undefined) patch.estimatedDurationMs = a.estimatedDurationMs;
        if (a.plannedStartAt !== undefined) patch.plannedStartAt = a.plannedStartAt;
        return updateTask(projectId, a.taskId!, patch);
      }
    }
  };

  // Confirm (or dismiss) a proposed action.
  const resolveAction = async (idx: number, accept: boolean) => {
    const msg = msgs[idx];
    if (!msg?.action || msg.actionState !== "pending") return;
    if (!accept) {
      setMsgs((m) => m.map((x, i) => (i === idx ? { ...x, actionState: "dismissed" } : x)));
      return;
    }
    try {
      await runAction(msg.action);
      setMsgs((m) => m.map((x, i) => (i === idx ? { ...x, actionState: "done" } : x)));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't apply that — try again.");
    }
  };

  return (
    <div className="proj-assistant">
      <button className="proj-assistant-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="fold-caret">{open ? "▾" : "▸"}</span>
        <span className="proj-assistant-title">ASK ABOUT THIS PROJECT</span>
        <span className="proj-assistant-sub">status &amp; repo content · reads files like ROADMAP.md · manages tasks &amp; project settings</span>
      </button>
      {open && (
        <div className="proj-assistant-body">
          <div className="proj-assistant-thread" ref={threadRef}>
            {msgs.length === 0 && (
              <div className="asst-welcome">
                <p>Ask about this project’s status or repository — or tell me to add, move, rename tasks, or change project settings. I’ll confirm before anything changes.</p>
                <div className="asst-sugg">
                  {ASSISTANT_SUGGESTIONS.map((s) => (
                    <button key={s} className="asst-chip" onClick={() => void ask(s)}>{s}</button>
                  ))}
                </div>
              </div>
            )}
            {msgs.map((m, i) => (
              <div key={i} className={"asst-msg asst-" + m.role}>
                <span className="asst-who mono">{m.role === "user" ? "you" : "assistant"}</span>
                {m.role === "assistant" ? (
                  m.content === "" ? (
                    <div className="asst-text asst-think">reading the project…</div>
                  ) : (
                    <div className="asst-text asst-md">
                      <Markdown text={m.content} />
                    </div>
                  )
                ) : (
                  <div className="asst-text">{m.content}</div>
                )}
                {m.action && (
                  <div className="asst-propose">
                    {m.actionState === "done" ? (
                      <span className="asst-propose-done">✓ {m.action.summary}</span>
                    ) : m.actionState === "dismissed" ? (
                      <span className="asst-propose-done muted">Dismissed: {m.action.summary}</span>
                    ) : (
                      <>
                        <span className="asst-propose-label">{m.action.summary}</span>
                        <span className="asst-propose-actions">
                          <button className="btn btn-primary btn-sm" onClick={() => void resolveAction(i, true)}>
                            Confirm
                          </button>
                          <button className="btn btn-ghost btn-sm" onClick={() => void resolveAction(i, false)}>
                            Dismiss
                          </button>
                        </span>
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
          {err && <div className="asst-err">{err}</div>}
          <form
            className="asst-input"
            onSubmit={(e) => {
              e.preventDefault();
              void ask(input);
            }}
          >
            <textarea
              ref={inputRef}
              // Enter submits (matches every other chat convention); Shift+Enter
              // inserts a newline. rows=1 makes it start as a single-line input;
              // auto-resize on change grows it into a text block as more lines
              // are typed (capped so long paste doesn't eat the pane).
              className="qx-input asst-textarea"
              placeholder="Ask about status, the roadmap, a file…  (Shift+Enter for a new line)"
              value={input}
              rows={1}
              onChange={(e) => {
                setInput(e.target.value);
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = Math.min(el.scrollHeight, 200) + "px";
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  if (!busy && input.trim()) void ask(input);
                }
              }}
              disabled={busy}
            />
            <button className="btn btn-primary" type="submit" disabled={busy || !input.trim()}>
              Ask
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

// ─── Project stats ──────────────────────────────────────────────────────────
// Compact per-project numbers derived from the runs + tasks the store already
// holds — no extra fetch. Shown above the kanban/timeline lens toggle. Cells
// that have no data (vendor didn't report tokens/cost) render as "—", not 0,
// so a missing signal doesn't look like a zeroed real one.

function fmtNum(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return (n / 1_000).toFixed(n < 10_000 ? 1 : 0) + "k";
  return (n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0) + "M";
}
function fmtCost(usd: number): string {
  if (usd < 0.01) return "<$0.01";
  if (usd < 1) return "$" + usd.toFixed(2);
  if (usd < 100) return "$" + usd.toFixed(2);
  return "$" + Math.round(usd).toLocaleString();
}
function fmtDurationMs(ms: number): string {
  if (ms < 60_000) return Math.round(ms / 1000) + "s";
  if (ms < 3_600_000) return Math.round(ms / 60_000) + "m";
  return (ms / 3_600_000).toFixed(1) + "h";
}

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
  let inTok = 0, outTok = 0, dur = 0, usdKnown = false, usdTotal = 0, durKnown = false;
  for (const r of projRuns) {
    const u = r.usage;
    if (!u) continue;
    inTok += u.inputTokens;
    outTok += u.outputTokens;
    if (u.costUsd != null) { usdKnown = true; usdTotal += u.costUsd; }
    if (u.durationMs != null) { durKnown = true; dur += u.durationMs; }
  }
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
    { label: "Run time", value: durKnown ? fmtDurationMs(dur) : "—", title: "Cumulative wall-clock across runs (vendor-reported)" },
    {
      label: "Models used",
      value: modelPairs.size ? String(modelPairs.size) : "—",
      title: modelPairs.size ? [...modelPairs].join("\n") : "No runs yet",
    },
  ];

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

export function ProjectView({
  project,
  now,
  onOpenTask,
  onOpenAgent,
  onBack,
}: {
  project: Project;
  now: number;
  onOpenTask: (id: string) => void;
  onOpenAgent: (id: string) => void;
  onBack: () => void;
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
  } = useStore();
  const noFleet = fleet.length === 0;
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
  // Per-project lens (Kanban is the default; Timeline mirrors Home's timeline
  // scoped to just this project). Persisted per-project in sessionStorage so
  // switching back to the project restores the last chosen lens.
  const [lens, setLens] = useState<"kanban" | "timeline">(() => {
    if (typeof sessionStorage === "undefined") return "kanban";
    return sessionStorage.getItem(`skynet.proj.lens.${project.id}`) === "timeline" ? "timeline" : "kanban";
  });
  useEffect(() => {
    if (typeof sessionStorage !== "undefined")
      sessionStorage.setItem(`skynet.proj.lens.${project.id}`, lens);
  }, [lens, project.id]);
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
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [name, setName] = useState(project.name);
  const [goal, setGoal] = useState(project.goal);

  useEffect(() => {
    setName(project.name);
    setGoal(project.goal);
    setFolded(false);
  }, [project.id, project.name, project.goal]);

  return (
    <section className="projview">
      <button className="btn btn-ghost btn-back" onClick={onBack}>
        ← Back
      </button>
      {editing ? (
        <div className="projview-edit">
          <input className="qx-input" value={name} onChange={(e) => setName(e.target.value)} />
          <textarea className="qx-input" rows={2} value={goal} onChange={(e) => setGoal(e.target.value)} />
          <div className="qx-row">
            <button
              className="btn btn-primary"
              onClick={() => {
                updateProject(project.id, { name: name.trim() || project.name, goal: goal.trim() });
                setEditing(false);
              }}
            >
              Save
            </button>
            <button className="btn btn-ghost" onClick={() => { setName(project.name); setGoal(project.goal); setEditing(false); }}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="projview-head">
          <div className="projview-head-main">
            <h2>{project.name}</h2>
            <p>{project.goal}</p>
            {project.repoPath && (
              <div className="mono proj-repo-line" title={project.repoPath}>
                {project.gitBacked ? "◈ git" : "📁"} {project.repoPath}
                {project.gitBacked && " · runs work in auto worktrees here"}
              </div>
            )}
            {project.repo && (
              <div className="mono proj-repo-line">⑂ {project.repo} · runs branch &amp; PR here</div>
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
              className="proj-approval"
              title="How much an agent may run without asking. Dangerous or outward-facing steps (git push, merge, infra, destructive commands) always ask, regardless of this setting."
            >
              <span className="proj-approval-label mono">Approvals</span>
              <select
                className="proj-approval-select"
                value={project.approvalLevel ?? "trusted"}
                onChange={(e) => updateProject(project.id, { approvalLevel: e.target.value })}
              >
                <option value="manual">Manual · ask for everything</option>
                <option value="assisted">Assisted · auto-approve low-risk</option>
                <option value="trusted">Trusted · auto-approve low + medium</option>
              </select>
            </label>
            <label className="proj-autonomy" title="When on, agents autonomously triage backlog items, pick up auto-pick tasks, and review finished work.">
              <input
                type="checkbox"
                className="proj-autonomy-cb"
                checked={project.autonomy}
                onChange={(e) => updateProject(project.id, { autonomy: e.target.checked })}
              />
              <span className="proj-autonomy-switch" aria-hidden="true" />
              <span className="proj-autonomy-label">Autonomy</span>
            </label>
            {project.repoPath && (
              <button className="btn" onClick={() => setPreviewOpen(true)} title="Run the app and preview it live — it refreshes as the fleet merges changes.">
                ▶ Preview app
              </button>
            )}
            <button className="btn btn-ghost" onClick={() => setEditing(true)}>Edit</button>
            {confirmDel ? (
              <span className="del-confirm">
                Delete project?{" "}
                <button className="btn btn-danger" onClick={() => { deleteProject(project.id); onBack(); }}>Yes, delete</button>
                <button className="btn btn-ghost" onClick={() => setConfirmDel(false)}>No</button>
              </span>
            ) : (
              <button className="btn btn-ghost btn-retire" onClick={() => setConfirmDel(true)}>Delete</button>
            )}
          </div>
        </div>
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
          <button className="proj-delivery-head" onClick={() => setFolded((f) => !f)}>
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
          {(["kanban", "timeline"] as const).map((id) => (
            <button
              key={id}
              className={"lens-btn" + (lens === id ? " on" : "")}
              onClick={() => setLens(id)}
            >
              {id === "kanban" ? "Kanban" : "Timeline"}
            </button>
          ))}
        </div>
      </div>

      {lens === "timeline" ? (
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
                {colTasks.map((t) => (
                  <TaskCard
                    key={t.id}
                    task={t}
                    run={t.runId ? runById.get(t.runId) : undefined}
                    onOpenTask={onOpenTask}
                  />
                ))}
                {st === "backlog" && drag?.from === "backlog" && dropBeforeId === null && <div className="kb-drop-line" aria-hidden="true" />}
                {st === "backlog" && <AddTaskCard onAdd={(text, description) => createTask(project.id, text, description)} />}
                {colTasks.length === 0 && st !== "backlog" && <div className="kb-empty">{accepts ? "Drop here" : "No tasks"}</div>}
              </div>
            </div>
          );
        })}
      </div>
      </BoardDnd.Provider>
      )}

      <ProjectAssistant key={project.id} projectId={project.id} />

      {archivedTasks.length > 0 && (
        <div className="kb-archive-sec">
          <button className="kb-archive-head" onClick={() => setShowArchived((s) => !s)}>
            {showArchived ? "▾" : "▸"} ARCHIVED · {archivedTasks.length}
          </button>
          {showArchived && (
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
      )}

      {previewOpen && <LivePreviewModal id={project.id} title={"Live preview · " + project.name} onClose={() => setPreviewOpen(false)} />}
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
  const ctl = { status: () => api.previewStatus(id), start: () => api.previewStart(id), stop: () => api.previewStop(id), restart: () => api.previewRestart(id) };
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

  const inner = (
      <div className={"lp-modal lp-mode-" + mode} onClick={(e) => e.stopPropagation()}>
        <div className="lp-bar">
          <span className="lp-title">{title}</span>
          <span
            className="lp-scope mono"
            title="Reflects the integration branch — merged changes only. An in-flight run's work appears here after it's approved and merged; unmerged/uncommitted changes aren't shown."
          >
            merged · integration branch
          </span>
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
