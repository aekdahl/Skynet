// ─── Feature + Roadmap lenses ─────────────────────────────────────────────
// Two views that sit above the task grain: Features groups the project's tasks
// by their `featureId`, and Roadmap groups by milestone (with features rolled
// up via `Feature.milestoneId`). Both derive from the same store — no server
// call to render.

import { useState } from "react";
import type { Feature, Milestone, Project, Task, TaskRun, TaskState } from "@skynet/shared";
import { useStore } from "../lib/store";
import { useConfirm } from "../components/confirm";
import { TASK_STATES, TASK_STATE_META } from "../lib/derive";

function fmtDate(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Progress = fraction of grouped tasks that are done. Empty group ⇒ 0. */
function progressOf(tasks: readonly Task[]): number {
  if (tasks.length === 0) return 0;
  return tasks.filter((t) => t.state === "done").length / tasks.length;
}

/** Count of tasks in each 6-state column, in TASK_STATES order. */
function stateCounts(tasks: readonly Task[]): Record<TaskState, number> {
  const counts = Object.fromEntries(TASK_STATES.map((s) => [s, 0])) as Record<TaskState, number>;
  for (const t of tasks) counts[t.state]++;
  return counts;
}

// ── Features lens ───────────────────────────────────────────────────────

export function FeaturesLens({
  project,
  features,
  milestones,
  tasks,
  runs,
  onOpenTask,
  onCreate,
  onUpdate,
  onDelete,
}: {
  project: Project;
  features: Feature[];
  milestones: Milestone[];
  tasks: Task[];
  runs: Map<string, TaskRun>;
  onOpenTask: (id: string) => void;
  onCreate: (name: string, description?: string) => void;
  onUpdate: (fid: string, patch: { name?: string; description?: string | null; status?: "active" | "paused" | "shipped"; milestoneId?: string | null; archived?: boolean }) => void;
  onDelete: (fid: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  // Tasks not attached to any feature — the "unassigned" bucket at the bottom.
  const orphan = tasks.filter((t) => !t.featureId);
  const submit = () => {
    const n = name.trim();
    if (!n) return;
    onCreate(n, desc.trim() || undefined);
    setName("");
    setDesc("");
    setAdding(false);
  };
  return (
    <div className="projview-features">
      <div className="pf-head">
        <h3 className="pf-title">Features in {project.name}</h3>
        {!adding && (
          <button className="btn btn-sm" onClick={() => setAdding(true)}>+ New feature</button>
        )}
      </div>
      {adding && (
        <div className="pf-addcard">
          <input
            className="qx-input"
            autoFocus
            placeholder="Feature name (e.g. Onboarding, Auth, Search)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } if (e.key === "Escape") setAdding(false); }}
          />
          <textarea
            className="qx-input pf-addcard-desc"
            rows={2}
            placeholder="Description (optional) — the shared goal of this feature."
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
          />
          <div className="qx-row">
            <button className="btn btn-primary btn-sm" onClick={submit} disabled={!name.trim()}>Create</button>
            <button className="btn btn-ghost btn-sm" onClick={() => { setName(""); setDesc(""); setAdding(false); }}>Cancel</button>
          </div>
        </div>
      )}
      {features.length === 0 && !adding && (
        <div className="pf-empty">
          No features yet. Group related tasks under a feature so this project has a level between "individual task" and "whole project".
        </div>
      )}
      {features.map((f) => {
        const inF = tasks.filter((t) => t.featureId === f.id);
        const p = progressOf(inF);
        const counts = stateCounts(inF);
        const milestone = f.milestoneId ? milestones.find((m) => m.id === f.milestoneId) : undefined;
        return (
          <FeatureRow
            key={f.id}
            feature={f}
            tasks={inF}
            counts={counts}
            progress={p}
            milestone={milestone}
            milestones={milestones}
            runs={runs}
            onOpenTask={onOpenTask}
            onUpdate={(patch) => onUpdate(f.id, patch)}
            onDelete={() => onDelete(f.id)}
          />
        );
      })}
      {orphan.length > 0 && (
        <div className="pf-orphan">
          <div className="pf-orphan-head">Tasks with no feature ({orphan.length})</div>
          <div className="pf-tasklist">
            {orphan.map((t) => (
              <TaskLink key={t.id} task={t} run={t.runId ? runs.get(t.runId) : undefined} onOpen={onOpenTask} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function FeatureRow({
  feature,
  tasks,
  counts,
  progress,
  milestone,
  milestones,
  runs,
  onOpenTask,
  onUpdate,
  onDelete,
}: {
  feature: Feature;
  tasks: Task[];
  counts: Record<TaskState, number>;
  progress: number;
  milestone: Milestone | undefined;
  milestones: Milestone[];
  runs: Map<string, TaskRun>;
  onOpenTask: (id: string) => void;
  onUpdate: (patch: { name?: string; description?: string | null; status?: "active" | "paused" | "shipped"; milestoneId?: string | null; archived?: boolean }) => void;
  onDelete: () => void;
}) {
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(feature.name);
  const [desc, setDesc] = useState(feature.description ?? "");
  const save = () => {
    const n = name.trim();
    if (!n) return;
    onUpdate({ name: n, description: desc.trim() || null });
    setEditing(false);
  };
  return (
    <div className={"pf-row" + (feature.status === "shipped" ? " pf-row-shipped" : "")}>
      <div className="pf-row-head" onClick={() => setOpen((v) => !v)}>
        <button className="pf-fold" aria-label={open ? "Collapse" : "Expand"}>
          {open ? "▾" : "▸"}
        </button>
        <div className="pf-row-name">
          {feature.status === "shipped" && <span className="pf-shipped-tag">✓ shipped</span>}
          {feature.status === "paused" && <span className="pf-paused-tag">⏸ paused</span>}
          <span className="pf-name">{feature.name}</span>
          {milestone && (
            <span className="kb-ms-chip" title={milestone.targetAt ? `Target ${fmtDate(milestone.targetAt)}` : "Milestone"}>
              ◉ {milestone.name}
            </span>
          )}
        </div>
        <div className="pf-row-meta">
          <span className="pf-count mono">
            {tasks.length} {tasks.length === 1 ? "task" : "tasks"}
          </span>
          <div className="pf-progress" title={`${Math.round(progress * 100)}% done`}>
            <div className="pf-progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <span className="pf-progress-lbl mono">{Math.round(progress * 100)}%</span>
        </div>
      </div>
      {open && (
        <div className="pf-row-body">
          {editing ? (
            <div className="pf-edit">
              <input className="qx-input" value={name} onChange={(e) => setName(e.target.value)} />
              <textarea className="qx-input" rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} />
              <div className="qx-row">
                <button className="btn btn-primary btn-sm" onClick={save} disabled={!name.trim()}>Save</button>
                <button className="btn btn-ghost btn-sm" onClick={() => { setName(feature.name); setDesc(feature.description ?? ""); setEditing(false); }}>Cancel</button>
              </div>
            </div>
          ) : (
            <>
              {feature.description ? (
                <p className="pf-desc">{feature.description}</p>
              ) : (
                <p className="pf-desc pf-desc-empty">No description.</p>
              )}
              <div className="pf-controls">
                <label className="pf-ms-picker">
                  <span>Milestone</span>
                  <select
                    className="pf-select"
                    value={feature.milestoneId ?? ""}
                    onChange={(e) => onUpdate({ milestoneId: e.target.value || null })}
                  >
                    <option value="">— none —</option>
                    {milestones.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                        {m.targetAt ? ` · ${fmtDate(m.targetAt)}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="pf-ms-picker">
                  <span>Status</span>
                  <select
                    className="pf-select"
                    value={feature.status}
                    onChange={(e) => onUpdate({ status: e.target.value as "active" | "paused" | "shipped" })}
                  >
                    <option value="active">Active</option>
                    <option value="paused">Paused</option>
                    <option value="shipped">Shipped</option>
                  </select>
                </label>
                <button className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>Edit</button>
                <button className="btn btn-ghost btn-sm pf-del" onClick={async () => {
                  if (await confirm({
                    title: "Delete feature?",
                    body: `Delete “${feature.name}”? Tasks in it keep existing but lose the grouping.`,
                    confirmLabel: "Delete",
                    danger: true,
                  })) onDelete();
                }}>Delete</button>
              </div>
              <div className="pf-counts">
                {TASK_STATES.map((s) => (
                  counts[s] > 0 ? (
                    <span key={s} className="pf-count-chip mono" style={{ color: TASK_STATE_META[s].color }}>
                      {counts[s]} {TASK_STATE_META[s].label}
                    </span>
                  ) : null
                ))}
              </div>
              <div className="pf-tasklist">
                {tasks.length === 0 ? (
                  <div className="pf-empty pf-empty-inner">No tasks in this feature. Open a task and pick this feature to group it here.</div>
                ) : tasks.map((t) => (
                  <TaskLink key={t.id} task={t} run={t.runId ? runs.get(t.runId) : undefined} onOpen={onOpenTask} />
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Roadmap lens ────────────────────────────────────────────────────────

export function RoadmapLens({
  project,
  features,
  milestones,
  tasks,
  runs,
  onOpenTask,
  onCreate,
  onUpdate,
  onDelete,
}: {
  project: Project;
  features: Feature[];
  milestones: Milestone[];
  tasks: Task[];
  runs: Map<string, TaskRun>;
  onOpenTask: (id: string) => void;
  onCreate: (name: string, description?: string, targetAt?: number | null) => void;
  onUpdate: (mid: string, patch: { name?: string; description?: string | null; targetAt?: number | null; status?: "planned" | "in-progress" | "shipped"; archived?: boolean }) => void;
  onDelete: (mid: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [target, setTarget] = useState("");
  const submit = () => {
    const n = name.trim();
    if (!n) return;
    const targetAt = target ? new Date(target).getTime() : null;
    onCreate(n, desc.trim() || undefined, targetAt);
    setName("");
    setDesc("");
    setTarget("");
    setAdding(false);
  };
  // Sort milestones by targetAt (nulls at the end), then by creation.
  const sorted = [...milestones].sort((a, b) => {
    if (a.targetAt == null && b.targetAt == null) return a.createdAt - b.createdAt;
    if (a.targetAt == null) return 1;
    if (b.targetAt == null) return -1;
    return a.targetAt - b.targetAt;
  });
  // Rollup: for each milestone, tasks are the union of (a) tasks whose
  // milestoneId matches directly and (b) tasks under a feature whose
  // milestoneId matches. Dedup by id since a task may hit both branches.
  const rollup = (mid: string): Task[] => {
    const featIds = new Set(features.filter((f) => f.milestoneId === mid).map((f) => f.id));
    const seen = new Set<string>();
    const out: Task[] = [];
    for (const t of tasks) {
      const hit = t.milestoneId === mid || (t.featureId && featIds.has(t.featureId));
      if (hit && !seen.has(t.id)) { seen.add(t.id); out.push(t); }
    }
    return out;
  };
  const unassignedTasks = tasks.filter((t) => {
    if (t.milestoneId) return false;
    if (t.featureId) {
      const f = features.find((x) => x.id === t.featureId);
      if (f?.milestoneId) return false;
    }
    return true;
  });
  const unassignedFeatures = features.filter((f) => !f.milestoneId);
  return (
    <div className="projview-roadmap">
      <div className="pf-head">
        <h3 className="pf-title">{project.name} — roadmap</h3>
        {!adding && (
          <button className="btn btn-sm" onClick={() => setAdding(true)}>+ New milestone</button>
        )}
      </div>
      {adding && (
        <div className="pf-addcard">
          <input
            className="qx-input"
            autoFocus
            placeholder="Milestone name (e.g. v1.0, Beta, Q1 launch)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } if (e.key === "Escape") setAdding(false); }}
          />
          <textarea
            className="qx-input pf-addcard-desc"
            rows={2}
            placeholder="Description (optional) — what ships in this milestone."
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
          />
          <label className="pf-ms-picker">
            <span>Target date (optional)</span>
            <input type="date" className="qx-input" value={target} onChange={(e) => setTarget(e.target.value)} />
          </label>
          <div className="qx-row">
            <button className="btn btn-primary btn-sm" onClick={submit} disabled={!name.trim()}>Create</button>
            <button className="btn btn-ghost btn-sm" onClick={() => { setName(""); setDesc(""); setTarget(""); setAdding(false); }}>Cancel</button>
          </div>
        </div>
      )}
      {sorted.length === 0 && !adding && (
        <div className="pf-empty">
          No milestones yet. Create one to group features + tasks into a planned release or checkpoint.
        </div>
      )}
      {sorted.map((m) => {
        const inM = rollup(m.id);
        const featsInM = features.filter((f) => f.milestoneId === m.id);
        return (
          <MilestoneRow
            key={m.id}
            milestone={m}
            features={featsInM}
            tasks={inM}
            runs={runs}
            onOpenTask={onOpenTask}
            onUpdate={(patch) => onUpdate(m.id, patch)}
            onDelete={() => onDelete(m.id)}
          />
        );
      })}
      {(unassignedTasks.length > 0 || unassignedFeatures.length > 0) && (
        <div className="pf-orphan">
          <div className="pf-orphan-head">
            No milestone ({unassignedTasks.length + unassignedFeatures.length})
          </div>
          {unassignedFeatures.length > 0 && (
            <div className="pf-ms-feats">
              {unassignedFeatures.map((f) => (
                <span key={f.id} className="kb-feat-chip">⊞ {f.name}</span>
              ))}
            </div>
          )}
          <div className="pf-tasklist">
            {unassignedTasks.map((t) => (
              <TaskLink key={t.id} task={t} run={t.runId ? runs.get(t.runId) : undefined} onOpen={onOpenTask} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function MilestoneRow({
  milestone,
  features,
  tasks,
  runs,
  onOpenTask,
  onUpdate,
  onDelete,
}: {
  milestone: Milestone;
  features: Feature[];
  tasks: Task[];
  runs: Map<string, TaskRun>;
  onOpenTask: (id: string) => void;
  onUpdate: (patch: { name?: string; description?: string | null; targetAt?: number | null; status?: "planned" | "in-progress" | "shipped"; archived?: boolean }) => void;
  onDelete: () => void;
}) {
  const confirm = useConfirm();
  const [open, setOpen] = useState(true);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(milestone.name);
  const [desc, setDesc] = useState(milestone.description ?? "");
  const [target, setTarget] = useState(milestone.targetAt ? new Date(milestone.targetAt).toISOString().slice(0, 10) : "");
  const counts = stateCounts(tasks);
  const progress = progressOf(tasks);
  const daysUntil = milestone.targetAt ? Math.round((milestone.targetAt - Date.now()) / 86400000) : null;
  const save = () => {
    const n = name.trim();
    if (!n) return;
    const targetAt = target ? new Date(target).getTime() : null;
    onUpdate({ name: n, description: desc.trim() || null, targetAt });
    setEditing(false);
  };
  return (
    <div className={"pm-row" + (milestone.status === "shipped" ? " pm-row-shipped" : "")}>
      <div className="pm-row-head" onClick={() => setOpen((v) => !v)}>
        <button className="pf-fold" aria-label={open ? "Collapse" : "Expand"}>
          {open ? "▾" : "▸"}
        </button>
        <div className="pm-row-name">
          <span className="pm-name">◉ {milestone.name}</span>
          {milestone.status === "shipped" && <span className="pf-shipped-tag">✓ shipped</span>}
          {milestone.status === "in-progress" && <span className="pm-inprog-tag">▶ in-progress</span>}
        </div>
        <div className="pm-row-meta">
          {milestone.targetAt != null && (
            <span className="pm-target mono" title={new Date(milestone.targetAt).toLocaleString()}>
              {fmtDate(milestone.targetAt)}
              {daysUntil != null && (
                <span className={daysUntil < 0 && milestone.status !== "shipped" ? " pm-target-late" : ""}>
                  {daysUntil > 0 ? ` · in ${daysUntil}d` : daysUntil === 0 ? " · today" : ` · ${Math.abs(daysUntil)}d late`}
                </span>
              )}
            </span>
          )}
          <span className="pf-count mono">
            {tasks.length} {tasks.length === 1 ? "task" : "tasks"}
            {features.length > 0 && ` · ${features.length} ${features.length === 1 ? "feature" : "features"}`}
          </span>
          <div className="pf-progress" title={`${Math.round(progress * 100)}% done`}>
            <div className="pf-progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <span className="pf-progress-lbl mono">{Math.round(progress * 100)}%</span>
        </div>
      </div>
      {open && (
        <div className="pm-row-body">
          {editing ? (
            <div className="pf-edit">
              <input className="qx-input" value={name} onChange={(e) => setName(e.target.value)} />
              <textarea className="qx-input" rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} />
              <label className="pf-ms-picker">
                <span>Target date</span>
                <input type="date" className="qx-input" value={target} onChange={(e) => setTarget(e.target.value)} />
              </label>
              <div className="qx-row">
                <button className="btn btn-primary btn-sm" onClick={save} disabled={!name.trim()}>Save</button>
                <button className="btn btn-ghost btn-sm" onClick={() => { setName(milestone.name); setDesc(milestone.description ?? ""); setTarget(milestone.targetAt ? new Date(milestone.targetAt).toISOString().slice(0, 10) : ""); setEditing(false); }}>Cancel</button>
              </div>
            </div>
          ) : (
            <>
              {milestone.description ? (
                <p className="pf-desc">{milestone.description}</p>
              ) : (
                <p className="pf-desc pf-desc-empty">No description.</p>
              )}
              <div className="pf-controls">
                <label className="pf-ms-picker">
                  <span>Status</span>
                  <select
                    className="pf-select"
                    value={milestone.status}
                    onChange={(e) => onUpdate({ status: e.target.value as "planned" | "in-progress" | "shipped" })}
                  >
                    <option value="planned">Planned</option>
                    <option value="in-progress">In-progress</option>
                    <option value="shipped">Shipped</option>
                  </select>
                </label>
                <button className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>Edit</button>
                <button className="btn btn-ghost btn-sm pf-del" onClick={async () => {
                  if (await confirm({
                    title: "Delete milestone?",
                    body: `Delete “${milestone.name}”? Features + tasks in it keep existing but lose the grouping.`,
                    confirmLabel: "Delete",
                    danger: true,
                  })) onDelete();
                }}>Delete</button>
              </div>
              <div className="pf-counts">
                {TASK_STATES.map((s) => (
                  counts[s] > 0 ? (
                    <span key={s} className="pf-count-chip mono" style={{ color: TASK_STATE_META[s].color }}>
                      {counts[s]} {TASK_STATE_META[s].label}
                    </span>
                  ) : null
                ))}
              </div>
              {features.length > 0 && (
                <div className="pf-ms-feats">
                  <span className="pf-ms-feats-lbl mono">Features:</span>
                  {features.map((f) => (
                    <span key={f.id} className="kb-feat-chip">⊞ {f.name}</span>
                  ))}
                </div>
              )}
              <div className="pf-tasklist">
                {tasks.length === 0 ? (
                  <div className="pf-empty pf-empty-inner">No tasks under this milestone yet. Set a feature's milestone (or a task's) to add it here.</div>
                ) : tasks.map((t) => (
                  <TaskLink key={t.id} task={t} run={t.runId ? runs.get(t.runId) : undefined} onOpen={onOpenTask} />
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Shared task-link chip used in both lenses ──────────────────────────

function TaskLink({ task, run, onOpen }: { task: Task; run?: TaskRun; onOpen: (id: string) => void }) {
  // A task with a linked run opens the run view; otherwise the task detail can
  // be reached from the kanban itself. Here we just deep-link to the run when
  // there is one, so operators can click through to live activity.
  const meta = TASK_STATE_META[task.state];
  const canOpen = !!run;
  return (
    <button
      className="pf-task"
      title={canOpen ? "Open the run" : task.text}
      disabled={!canOpen}
      onClick={() => run && onOpen(run.id)}
    >
      <span className="pf-task-state mono" style={{ color: meta.color }}>{meta.label}</span>
      <span className="pf-task-text">{task.text}</span>
    </button>
  );
}

// A small pass-through so the store is usable without prop-drilling if we ever
// need it inside these components. Exported for possible future use.
export { useStore };
