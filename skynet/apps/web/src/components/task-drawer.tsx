import { useEffect, useState } from "react";
import type { TaskRun, Task } from "@skynet/shared";
import { useStore } from "../lib/store";
import { curStep, STATUS_META, TASK_STATE_META } from "../lib/derive";
import { Bar, StatusDot } from "./common";

// Side panel opened from a task card. Shows the task description (editable) and
// its assigned agent — the run executing it — with the fleet-runner picker to
// start it on a chosen runner, or reassign a live run onto a different one.
export function TaskDrawer({
  task,
  run,
  onClose,
  onOpenRun,
}: {
  task: Task;
  run?: TaskRun;
  onClose: () => void;
  onOpenRun: (runId: string) => void;
}) {
  const {
    fleet,
    updateTask,
    assignTask,
    reassignTask,
    pauseAgent,
    resumeAgent,
    stopAgent,
    forkAgent,
    archiveAgent,
  } = useStore();
  const pid = task.projectId;
  const [descEditing, setDescEditing] = useState(false);
  const [draft, setDraft] = useState(task.text);
  // "" = auto-pick any idle runner; otherwise a specific runner id.
  const [runnerSel, setRunnerSel] = useState("");

  // Reset local state when the drawer switches to a different task.
  useEffect(() => {
    setDraft(task.text);
    setDescEditing(false);
    setRunnerSel("");
  }, [task.id, task.text]);

  const idle = fleet.filter((r) => r.status === "idle");
  const noFleet = fleet.length === 0;
  // A run still doing work — pause/stop/reassign apply; a done run is history.
  const live = run && run.status !== "done" ? run : undefined;
  const stateMeta = TASK_STATE_META[task.state];

  const runnerLabel = (id: string) => {
    const r = fleet.find((x) => x.id === id);
    return r ? `${r.name} · ${r.provider}/${r.model}` : id;
  };

  return (
    <aside className="task-drawer" role="dialog" aria-label="Task detail">
      <div className="task-drawer-head">
        <span className="kind-chip" style={{ color: stateMeta.color, borderColor: stateMeta.color }}>
          {stateMeta.label}
        </span>
        <span className="task-drawer-title">Task</span>
        <button className="task-drawer-close" title="Close" onClick={onClose}>
          ×
        </button>
      </div>

      {/* ── description ─────────────────────────────────────────────── */}
      <div className="task-drawer-sec">
        <div className="panel-head">
          DESCRIPTION
          {!descEditing && (
            <button className="kb-tool task-drawer-edit" title="Edit description" onClick={() => setDescEditing(true)}>
              ✎
            </button>
          )}
        </div>
        {descEditing ? (
          <>
            <textarea
              className="qx-input"
              rows={4}
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <div className="qx-row">
              <button
                className="btn btn-primary"
                disabled={!draft.trim()}
                onClick={() => {
                  if (draft.trim() && draft.trim() !== task.text) updateTask(pid, task.id, { text: draft.trim() });
                  setDescEditing(false);
                }}
              >
                Save
              </button>
              <button className="btn btn-ghost" onClick={() => { setDraft(task.text); setDescEditing(false); }}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <p className="task-drawer-desc">{task.text}</p>
        )}
      </div>

      {/* ── assigned agent ──────────────────────────────────────────── */}
      <div className="task-drawer-sec">
        <div className="panel-head">ASSIGNED AGENT</div>

        {run ? (
          <div className="task-drawer-agent">
            <button className="task-drawer-agent-head" onClick={() => onOpenRun(run.id)} title="Open the full run view">
              <StatusDot status={run.status} />
              <span className="task-drawer-agent-name">{run.name}</span>
              <span className="status-word" style={{ color: STATUS_META[run.status].color }}>
                {STATUS_META[run.status].label}
              </span>
              <span className="task-drawer-open">Open →</span>
            </button>
            <div className="task-drawer-meta mono">
              <span>{run.model}</span>
              <span className="task-drawer-sep">·</span>
              <span>{run.branch}</span>
            </div>
            <Bar value={run.progress} status={run.status} />
            <div className="task-drawer-step">→ {curStep(run)}</div>

            <div className="task-drawer-actions">
              {live && (run.status === "paused" ? (
                <button className="btn btn-ghost btn-sm" onClick={() => resumeAgent(run.id)}>▶ Resume</button>
              ) : (
                <button className="btn btn-ghost btn-sm" onClick={() => pauseAgent(run.id)}>⏸ Pause</button>
              ))}
              {live && (
                <button
                  className="btn btn-ghost btn-sm btn-stop"
                  onClick={() => {
                    if (confirm(`Stop “${run.name}”? This frees its agent; the run won't resume.`)) void stopAgent(run.id);
                  }}
                >
                  ◼ Stop
                </button>
              )}
              <button className="btn btn-ghost btn-sm" disabled={noFleet} title={noFleet ? "Configure a runner in Fleet first." : "Duplicate this run with shared context"} onClick={() => forkAgent(run.id)}>
                ⑂ Fork
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => archiveAgent(run.id, !run.archived)}>
                {run.archived ? "⊕ Unarchive" : "⊘ Archive"}
              </button>
            </div>

            {/* Reassign a live run onto a different runner (abandon + restart). */}
            {live && idle.length > 0 && (
              <div className="task-drawer-reassign">
                <label className="task-drawer-label">Move to another agent</label>
                <div className="qx-row">
                  <select className="qx-input qx-select" value={runnerSel} onChange={(e) => setRunnerSel(e.target.value)}>
                    <option value="">Choose a runner…</option>
                    {idle.map((r) => (
                      <option key={r.id} value={r.id}>{runnerLabel(r.id)}</option>
                    ))}
                  </select>
                  <button
                    className="btn btn-sm"
                    disabled={!runnerSel}
                    onClick={() => {
                      if (runnerSel && confirm(`Reassign to ${runnerLabel(runnerSel)}? The current run is stopped and the task restarts fresh (context is not carried over).`))
                        void reassignTask(pid, task.id, runnerSel);
                    }}
                  >
                    Reassign
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="task-drawer-unassigned">
            <p className="task-drawer-none">No agent assigned yet.</p>
            {task.state === "done" ? (
              <p className="task-drawer-hint">This task is done.</p>
            ) : noFleet ? (
              <p className="task-drawer-hint">Configure a runner in Fleet before starting.</p>
            ) : (
              <div className="qx-row">
                <select className="qx-input qx-select" value={runnerSel} onChange={(e) => setRunnerSel(e.target.value)}>
                  <option value="">Auto — any idle runner</option>
                  {idle.map((r) => (
                    <option key={r.id} value={r.id}>{runnerLabel(r.id)}</option>
                  ))}
                </select>
                <button
                  className="btn btn-primary btn-sm"
                  disabled={idle.length === 0}
                  title={idle.length === 0 ? "No idle runner — free or add one in Fleet." : "Start this task on the selected runner"}
                  onClick={() => void assignTask(pid, task.id, runnerSel || undefined)}
                >
                  ▶ Start
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
