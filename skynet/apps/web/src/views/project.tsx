import { useEffect, useRef, useState } from "react";
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
import { QueueCard } from "./queue";

const stop = (e: React.MouseEvent) => e.stopPropagation();

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
    moveTask,
    transitionTask,
    assignTask,
    archiveAgent,
  } = useStore();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.text);
  const [descDraft, setDescDraft] = useState(task.description ?? "");
  const pid = task.projectId;
  const s = task.state;
  const move = (to: string) => transitionTask(pid, task.id, to);
  const q = run ? openQueue(queue).find((it) => it.runId === run.id) : undefined;
  const openRun = run ? () => onOpenTask(run.id) : undefined;
  const noFleet = fleet.length === 0;

  if (editing) {
    return (
      <div className={"kb-card kb-card-" + s}>
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
          className="qx-input"
          rows={3}
          placeholder="Description (optional) — the full brief the agent gets…"
          value={descDraft}
          onChange={(e) => setDescDraft(e.target.value)}
        />
        <div className="qx-row">
          <button
            className="btn btn-primary"
            onClick={() => {
              if (draft.trim())
                updateTask(pid, task.id, { text: draft.trim(), description: descDraft.trim() || null });
              setEditing(false);
            }}
          >
            Save
          </button>
          <button className="btn btn-ghost" onClick={() => { setDraft(task.text); setDescDraft(task.description ?? ""); setEditing(false); }}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={"kb-card kb-card-" + s}
      {...(openRun
        ? {
            role: "button",
            tabIndex: 0,
            onClick: openRun,
            onKeyDown: (e: React.KeyboardEvent) =>
              (e.key === "Enter" || e.key === " ") && openRun(),
          }
        : {})}
    >
      <div className="kb-card-top">
        {run && <StatusDot status={run.status} />}
        <span className="kb-task" title={task.description ?? undefined}>{task.text}</span>
        {(s === "backlog" || s === "triage" || s === "todo") && (
          <span className="kb-card-tools" onClick={stop}>
            {s === "backlog" && (
              <>
                <button className="kb-tool" title="Move up" onClick={() => moveTask(pid, task.id, "up")}>↑</button>
                <button className="kb-tool" title="Move down" onClick={() => moveTask(pid, task.id, "down")}>↓</button>
              </>
            )}
            <button className="kb-tool" title="Edit task" onClick={() => setEditing(true)}>✎</button>
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

      <div className="kb-actions" onClick={stop}>
        {s === "backlog" && (
          <button
            className="kb-move"
            disabled={task.assignment.mode === "unassigned"}
            title={
              task.assignment.mode === "unassigned"
                ? "Pick an agent (Any, or specific agents) before moving out of backlog."
                : "Move to Triage"
            }
            onClick={() => move("triage")}
          >
            → Triage
          </button>
        )}
        {s === "triage" && (
          <>
            <button className="kb-move kb-move-primary" onClick={() => move("todo")}>Approve → Todo</button>
            <button className="kb-move" onClick={() => move("backlog")}>↩ Backlog</button>
          </>
        )}
        {s === "todo" && (
          <>
            <label className="kb-autopick" title="When on, an idle agent starts this task autonomously.">
              <input
                type="checkbox"
                checked={task.autoPick}
                onChange={(e) => updateTask(pid, task.id, { autoPick: e.target.checked })}
              />{" "}
              Auto-pick
            </label>
            <button
              className="kb-move kb-move-primary"
              disabled={noFleet}
              title={noFleet ? "Configure an agent in Fleet first." : "Start now on an idle agent"}
              onClick={() => assignTask(pid, task.id)}
            >
              ▶ Start
            </button>
            <button className="kb-move" onClick={() => move("triage")}>↩ Triage</button>
          </>
        )}
        {s === "ongoing" && (
          <button className="kb-move" onClick={() => move("todo")}>↩ Abandon</button>
        )}
        {s === "review" && (
          <>
            <button className="kb-move kb-move-primary" onClick={() => move("done")}>✓ Approve → Done</button>
            <button className="kb-move" onClick={() => move("todo")}>↩ Redo</button>
          </>
        )}
        {s === "done" && (
          <>
            <button className="kb-move" onClick={() => move("triage")}>↩ Triage</button>
            <button className="kb-move" onClick={() => move("backlog")}>↩ Backlog</button>
            {run && (
              <button className="kb-archive" title="Archive — hide from the board" onClick={() => archiveAgent(run.id, true)}>⤓</button>
            )}
          </>
        )}
      </div>
    </div>
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
    <div className="kb-card kb-card-backlog">
      <div className="task-name-wrap">
        <input
          className="qx-input"
          autoFocus
          maxLength={TASK_NAME_MAX}
          placeholder="Task name — short, like a commit subject"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && draft.trim() && submit()}
        />
        <span className={"task-name-count mono" + (draft.length >= TASK_NAME_MAX ? " task-name-max" : "")}>
          {draft.length}/{TASK_NAME_MAX}
        </span>
      </div>
      <textarea
        className="qx-input"
        rows={3}
        placeholder="Description (optional) — the full brief the agent gets: context, constraints, what done looks like…"
        value={desc}
        onChange={(e) => setDesc(e.target.value)}
      />
      <div className="qx-row">
        <button className="btn btn-primary" disabled={!draft.trim()} onClick={submit}>
          Add to backlog
        </button>
        <button className="btn btn-ghost" onClick={() => { setDraft(""); setDesc(""); setOpen(false); }}>
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

type AsstMsg = { role: "user" | "assistant"; content: string };
const ASSISTANT_SUGGESTIONS = [
  "What's the current status of this project?",
  "Summarize the roadmap",
  "What's blocked or waiting on me?",
];

function ProjectAssistant({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<AsstMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [msgs, busy]);

  const ask = async (q: string) => {
    const question = q.trim();
    if (!question || busy) return;
    setErr(null);
    const history = msgs.slice();
    setMsgs([...msgs, { role: "user", content: question }]);
    setInput("");
    setBusy(true);
    try {
      const { reply } = await api.projectChat(projectId, question, history);
      setMsgs((m) => [...m, { role: "assistant", content: reply }]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't reach the assistant — try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="proj-assistant">
      <button className="proj-assistant-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="fold-caret">{open ? "▾" : "▸"}</span>
        <span className="proj-assistant-title">ASK ABOUT THIS PROJECT</span>
        <span className="proj-assistant-sub">status &amp; repo content · reads files like ROADMAP.md</span>
      </button>
      {open && (
        <div className="proj-assistant-body">
          <div className="proj-assistant-thread" ref={threadRef}>
            {msgs.length === 0 && (
              <div className="asst-welcome">
                <p>Ask about this project’s current status, or what’s in the repository.</p>
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
                <div className="asst-text">{m.content}</div>
              </div>
            ))}
            {busy && (
              <div className="asst-msg asst-assistant">
                <span className="asst-who mono">assistant</span>
                <div className="asst-text asst-think">reading the project…</div>
              </div>
            )}
          </div>
          {err && <div className="asst-err">{err}</div>}
          <form
            className="asst-input"
            onSubmit={(e) => {
              e.preventDefault();
              void ask(input);
            }}
          >
            <input
              className="qx-input"
              placeholder="Ask about status, the roadmap, a file…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
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

export function ProjectView({
  project,
  now,
  onOpenTask,
  onBack,
}: {
  project: Project;
  now: number;
  onOpenTask: (id: string) => void;
  onBack: () => void;
}) {
  const {
    runs,
    queue,
    tasks,
    updateProject,
    deleteProject,
    cloneProjectRepo,
    createTask,
    archiveAgent,
  } = useStore();
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
  const archived = pa.filter((a) => a.archived);
  const lead = visualLeadOf(project, runs);
  // A card is hidden from its column when its run has been archived (it shows in
  // the Archived section instead).
  const hidden = (t: Task) => !!(t.runId && runById.get(t.runId)?.archived);

  const [folded, setFolded] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
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

      {lead && (
        <div className="proj-delivery">
          <button className="proj-delivery-head" onClick={() => setFolded((f) => !f)}>
            <span className="fold-caret">{folded ? "▸" : "▾"}</span>
            <span className="proj-delivery-title">LIVE PREVIEW</span>
            <span className="proj-delivery-sub">
              aimed delivery · {lead.status === "done" ? "shipped" : "building"} · {lead.name}
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

      <div className="kb-cols kb-cols-6">
        {TASK_STATES.map((st) => {
          const colTasks = tasksInState(tasks, project.id, st).filter((t) => !hidden(t));
          const meta = TASK_STATE_META[st];
          return (
            <div className={"kb-col kb-col-" + st} key={st}>
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
                {st === "backlog" && <AddTaskCard onAdd={(text, description) => createTask(project.id, text, description)} />}
                {colTasks.length === 0 && st !== "backlog" && <div className="kb-empty">No tasks</div>}
              </div>
            </div>
          );
        })}
      </div>

      <ProjectAssistant projectId={project.id} />

      {archived.length > 0 && (
        <div className="kb-archive-sec">
          <button className="kb-archive-head" onClick={() => setShowArchived((s) => !s)}>
            {showArchived ? "▾" : "▸"} ARCHIVED · {archived.length}
          </button>
          {showArchived && (
            <div className="kb-archive-list">
              {archived.map((a) => (
                <div key={a.id} className="kb-archive-row">
                  <button className="kb-archive-name" onClick={() => onOpenTask(a.id)}>
                    {a.status === "done" ? "✓ " : ""}
                    {a.name}
                  </button>
                  <span className="kb-archive-branch mono">{a.branch}</span>
                  <button className="btn btn-ghost btn-sm" onClick={() => archiveAgent(a.id, false)}>
                    Restore
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
