import { useEffect, useState } from "react";
import type { TaskRun, Project, Task } from "@skynet/shared";
import { useStore } from "../lib/store";
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
import { TaskDrawer } from "../components/task-drawer";
import { QueueCard } from "./queue";

const stop = (e: React.MouseEvent) => e.stopPropagation();

// One card per Task. For pre-run states (backlog/triage/todo) it shows the task
// text + stage controls; for ongoing/review/done it joins the linked TaskRun to
// show live status/progress. Clicking any card opens the task drawer (its
// description + assigned agent); the stage controls/tools stopPropagation.
function TaskCard({
  task,
  run,
  onOpen,
}: {
  task: Task;
  run?: TaskRun;
  onOpen: (taskId: string) => void;
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
  const pid = task.projectId;
  const s = task.state;
  const move = (to: string) => transitionTask(pid, task.id, to);
  const q = run ? openQueue(queue).find((it) => it.runId === run.id) : undefined;
  const open = () => onOpen(task.id);
  const noFleet = fleet.length === 0;

  if (editing) {
    return (
      <div className={"kb-card kb-card-" + s}>
        <textarea
          className="qx-input"
          rows={2}
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <div className="qx-row">
          <button
            className="btn btn-primary"
            onClick={() => {
              if (draft.trim()) updateTask(pid, task.id, { text: draft.trim() });
              setEditing(false);
            }}
          >
            Save
          </button>
          <button className="btn btn-ghost" onClick={() => { setDraft(task.text); setEditing(false); }}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={"kb-card kb-card-" + s}
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e: React.KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
    >
      <div className="kb-card-top">
        {run && <StatusDot status={run.status} />}
        <span className="kb-task">{task.text}</span>
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

      <div className="kb-actions" onClick={stop}>
        {s === "backlog" && (
          <button className="kb-move" onClick={() => move("triage")}>→ Triage</button>
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

function AddTaskCard({ onAdd }: { onAdd: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  if (!open)
    return (
      <button className="kb-add" onClick={() => setOpen(true)}>
        + Add task
      </button>
    );
  return (
    <div className="kb-card kb-card-backlog">
      <textarea
        className="qx-input"
        rows={2}
        autoFocus
        placeholder="Describe the task…"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <div className="qx-row">
        <button
          className="btn btn-primary"
          disabled={!draft.trim()}
          onClick={() => { onAdd(draft.trim()); setDraft(""); setOpen(false); }}
        >
          Add to backlog
        </button>
        <button className="btn btn-ghost" onClick={() => { setDraft(""); setOpen(false); }}>
          Cancel
        </button>
      </div>
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
    createTask,
    archiveAgent,
  } = useStore();
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
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  // Resolve the drawer's task live from the store so edits/state changes reflect
  // (and it closes itself if the task is deleted out from under it).
  const openTask = openTaskId ? tasks.find((t) => t.id === openTaskId) : undefined;

  useEffect(() => {
    setName(project.name);
    setGoal(project.goal);
    setFolded(false);
    setOpenTaskId(null);
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
          </div>
          <div className="projview-head-tools">
            <label className="proj-autonomy" title="When on, agents autonomously triage backlog items, pick up auto-pick tasks, and review finished work.">
              <input
                type="checkbox"
                checked={project.autonomy}
                onChange={(e) => updateProject(project.id, { autonomy: e.target.checked })}
              />{" "}
              Autonomy
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
            <div className="kb-col" key={st}>
              <div className="kb-head" style={{ color: meta.color }}>
                {meta.label} · {colTasks.length}
              </div>
              {colTasks.map((t) => (
                <TaskCard
                  key={t.id}
                  task={t}
                  run={t.runId ? runById.get(t.runId) : undefined}
                  onOpen={setOpenTaskId}
                />
              ))}
              {st === "backlog" && <AddTaskCard onAdd={(text) => createTask(project.id, text)} />}
              {colTasks.length === 0 && st !== "backlog" && <div className="kb-empty">—</div>}
            </div>
          );
        })}
      </div>

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

      {openTask && (
        <>
          <div className="task-drawer-scrim" onClick={() => setOpenTaskId(null)} />
          <TaskDrawer
            task={openTask}
            run={openTask.runId ? runById.get(openTask.runId) : undefined}
            onClose={() => setOpenTaskId(null)}
            onOpenRun={(runId) => {
              setOpenTaskId(null);
              onOpenTask(runId);
            }}
          />
        </>
      )}
    </section>
  );
}
