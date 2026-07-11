import { useEffect, useState } from "react";
import type { Agent, Project, Task } from "@skynet/shared";
import { useStore } from "../lib/store";
import {
  agentsForProject,
  backlogTasks,
  curStep,
  fmtWait,
  openQueue,
  planDone,
  STATUS_META,
  waitedSecs,
} from "../lib/derive";
import { Bar, StatusDot } from "../components/common";
import { ProjectDelivery, visualLeadOf } from "../components/preview";
import { QueueCard } from "./queue";

function ProjectAgentCard({
  agent,
  onOpen,
  onArchive,
}: {
  agent: Agent;
  onOpen: () => void;
  onArchive: () => void;
}) {
  const { queue } = useStore();
  const q = openQueue(queue).find((it) => it.agentId === agent.id);
  const done = planDone(agent);
  return (
    <div
      className="pa-card"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onOpen()}
    >
      <div className="pa-top">
        <StatusDot status={agent.status} />
        <span className="pa-name">{agent.name}</span>
        <span className="status-word" style={{ color: STATUS_META[agent.status].color }}>
          {STATUS_META[agent.status].label}
        </span>
        <button
          className="kb-archive"
          title="Archive — hide from the board (kept in Archived)"
          onClick={(e) => {
            e.stopPropagation();
            onArchive();
          }}
        >
          ⤓
        </button>
      </div>
      <Bar value={agent.progress} status={agent.status} />
      <div className="pa-step">
        {q ? (
          <span className="wait-tag">⏸ {q.title}</span>
        ) : agent.status === "done" ? (
          <span className="done-tag">✓ merged</span>
        ) : (
          <span className="step-tag">→ {curStep(agent)}</span>
        )}
      </div>
      <div className="pa-meta mono">
        {done}/{agent.plan.length} steps · {agent.branch}
      </div>
    </div>
  );
}

function BacklogCard({
  task,
  onAssign,
  canPromote,
  canDemote,
}: {
  task: Task;
  onAssign: () => void;
  canPromote: boolean;
  canDemote: boolean;
}) {
  const { updateTask, deleteTask, moveTask, fleet } = useStore();
  const noRunner = fleet.length === 0;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.text);
  if (editing) {
    return (
      <div className="kb-card kb-backlog">
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
              if (draft.trim()) {
                updateTask(task.projectId, task.id, { text: draft.trim() });
                setEditing(false);
              }
            }}
          >
            Save
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => {
              setDraft(task.text);
              setEditing(false);
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="kb-card kb-backlog">
      <div className="kb-card-top">
        <span className="kb-task">{task.text}</span>
        <span className="kb-card-tools">
          <button
            className="kb-tool"
            title="Promote — move up the backlog"
            disabled={!canPromote}
            onClick={() => moveTask(task.projectId, task.id, "up")}
          >
            ↑
          </button>
          <button
            className="kb-tool"
            title="Demote — move down the backlog"
            disabled={!canDemote}
            onClick={() => moveTask(task.projectId, task.id, "down")}
          >
            ↓
          </button>
          <button className="kb-tool" title="Edit task" onClick={() => setEditing(true)}>
            ✎
          </button>
          <button
            className="kb-tool kb-tool-del"
            title="Delete task"
            onClick={() => deleteTask(task.projectId, task.id)}
          >
            ×
          </button>
        </span>
      </div>
      <button
        className="kb-assign"
        onClick={onAssign}
        disabled={noRunner}
        title={noRunner ? "Configure a runner in Fleet before assigning agents." : undefined}
      >
        {noRunner ? "Configure a runner to assign" : "Assign agent →"}
      </button>
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
    <div className="kb-card kb-backlog">
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
          onClick={() => {
            onAdd(draft.trim());
            setDraft("");
            setOpen(false);
          }}
        >
          Add to backlog
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => {
            setDraft("");
            setOpen(false);
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export function ProjectView({
  project,
  now,
  onOpenAgent,
  onBack,
}: {
  project: Project;
  now: number;
  onOpenAgent: (id: string) => void;
  onBack: () => void;
}) {
  const {
    agents,
    queue,
    tasks,
    updateProject,
    deleteProject,
    createTask,
    assignTask,
    archiveAgent,
  } = useStore();
  const pa = agentsForProject(agents, project.id);
  const items = openQueue(queue).filter((q) =>
    pa.some((a) => a.id === q.agentId),
  );
  const live = pa.filter((a) => !a.archived);
  const inProgress = live.filter((a) => a.status !== "done");
  const doneList = live.filter((a) => a.status === "done");
  const archived = pa.filter((a) => a.archived);
  const backlog = backlogTasks(tasks, project.id);
  const lead = visualLeadOf(project, agents);

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
          <input
            className="qx-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <textarea
            className="qx-input"
            rows={2}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
          />
          <div className="qx-row">
            <button
              className="btn btn-primary"
              onClick={() => {
                updateProject(project.id, {
                  name: name.trim() || project.name,
                  goal: goal.trim(),
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
            {project.repoPath && (
              <div className="mono proj-repo-line" title={project.repoPath}>
                {project.gitBacked ? "◈ git" : "📁"} {project.repoPath}
                {project.gitBacked && " · agents work in auto worktrees here"}
              </div>
            )}
            {project.repo && (
              <div className="mono proj-repo-line">⑂ {project.repo} · agents branch &amp; PR here</div>
            )}
          </div>
          <div className="projview-head-tools">
            <button className="btn btn-ghost" onClick={() => setEditing(true)}>
              Edit
            </button>
            {confirmDel ? (
              <span className="del-confirm">
                Delete project?{" "}
                <button
                  className="btn btn-danger"
                  onClick={() => {
                    deleteProject(project.id);
                    onBack();
                  }}
                >
                  Yes, delete
                </button>
                <button className="btn btn-ghost" onClick={() => setConfirmDel(false)}>
                  No
                </button>
              </span>
            ) : (
              <button
                className="btn btn-ghost btn-retire"
                onClick={() => setConfirmDel(true)}
              >
                Delete
              </button>
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
              aimed delivery · {lead.status === "done" ? "shipped" : "building"} ·{" "}
              {lead.name}
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
              agent={agents.find((a) => a.id === it.agentId)}
              now={now}
              selected={false}
              onOpen={() => onOpenAgent(it.agentId)}
            />
          ))}
        </div>
      )}

      <div className="kb-cols">
        <div className="kb-col">
          <div className="kb-head">BACKLOG · {backlog.length}</div>
          {backlog.map((t, i) => (
            <BacklogCard
              key={t.id}
              task={t}
              onAssign={() => assignTask(project.id, t.id)}
              canPromote={i > 0}
              canDemote={i < backlog.length - 1}
            />
          ))}
          <AddTaskCard onAdd={(text) => createTask(project.id, text)} />
        </div>
        <div className="kb-col">
          <div className="kb-head kb-head-active">IN PROGRESS · {inProgress.length}</div>
          {inProgress.length === 0 && <div className="kb-empty">No agents running.</div>}
          {inProgress.map((a) => (
            <ProjectAgentCard
              key={a.id}
              agent={a}
              onOpen={() => onOpenAgent(a.id)}
              onArchive={() => archiveAgent(a.id, true)}
            />
          ))}
        </div>
        <div className="kb-col">
          <div className="kb-head kb-head-done">DONE · {doneList.length}</div>
          {doneList.length === 0 && <div className="kb-empty">Nothing merged yet.</div>}
          {doneList.map((a) => (
            <div
              key={a.id}
              className="kb-card kb-done"
              role="button"
              tabIndex={0}
              onClick={() => onOpenAgent(a.id)}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onOpenAgent(a.id)}
            >
              <span className="kb-task">✓ {a.name}</span>
              <span className="kb-done-row">
                <span className="kb-done-meta mono">merged · {a.branch}</span>
                <button
                  className="kb-archive"
                  title="Archive — hide from the board (kept in Archived)"
                  onClick={(e) => {
                    e.stopPropagation();
                    archiveAgent(a.id, true);
                  }}
                >
                  ⤓
                </button>
              </span>
            </div>
          ))}
        </div>
      </div>

      {archived.length > 0 && (
        <div className="kb-archive-sec">
          <button
            className="kb-archive-head"
            onClick={() => setShowArchived((s) => !s)}
          >
            {showArchived ? "▾" : "▸"} ARCHIVED · {archived.length}
          </button>
          {showArchived && (
            <div className="kb-archive-list">
              {archived.map((a) => (
                <div key={a.id} className="kb-archive-row">
                  <button
                    className="kb-archive-name"
                    onClick={() => onOpenAgent(a.id)}
                  >
                    {a.status === "done" ? "✓ " : ""}
                    {a.name}
                  </button>
                  <span className="kb-archive-branch mono">{a.branch}</span>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => archiveAgent(a.id, false)}
                  >
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
