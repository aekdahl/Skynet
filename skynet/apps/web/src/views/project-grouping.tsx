// ─── Feature + Roadmap lenses ─────────────────────────────────────────────
// Two views that sit above the task grain, reworked from row-lists into
// visualizations: Features renders each feature as a "pipeline bar" (where its
// tasks sit across the 6 states), and Roadmap lays milestones out as columns on
// a time line — ordered by target date with a TODAY divider — each a completion
// ring + its features' pipeline bars. Both derive from the same store, share the
// pipeline-bar primitive, and keep every create/edit/delete affordance (folded
// into the cards). No server call to render.

import { Fragment, useState, type CSSProperties } from "react";
import type { Feature, Milestone, Project, Task, TaskRun, TaskState } from "@skynet/shared";
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

/** Human summary of a state breakdown: "5 done · 1 ongoing · 2 backlog". */
function countsSummary(counts: Record<TaskState, number>): string {
  return TASK_STATES.filter((s) => counts[s] > 0)
    .map((s) => `${counts[s]} ${TASK_STATE_META[s].label.toLowerCase()}`)
    .join(" · ");
}

// ── Shared visual primitives ────────────────────────────────────────────

/** A segmented bar showing WHERE a group's tasks sit across the pipeline
 *  (backlog → done), sized by count. The core primitive of both lenses. Colors
 *  come from a dedicated `s-<state>` ramp (styles.css) chosen to be mutually
 *  distinguishable — more so than the kanban chip colors, which repeat hues. */
function PipelineBar({ counts, dim }: { counts: Record<TaskState, number>; dim?: boolean }) {
  const total = TASK_STATES.reduce((n, s) => n + counts[s], 0);
  const label = total ? countsSummary(counts) : "no tasks";
  return (
    <div className={"pipebar" + (dim ? " pipebar-dim" : "")} role="img" aria-label={label} title={label}>
      {total === 0
        ? <span className="pipebar-empty" />
        : TASK_STATES.map((s) =>
            counts[s] > 0 ? <span key={s} className={"pipebar-seg s-" + s} style={{ flexGrow: counts[s] }} /> : null,
          )}
    </div>
  );
}

function StateLegend() {
  return (
    <div className="state-legend">
      {TASK_STATES.map((s) => (
        <span key={s} className="state-lg">
          <span className={"state-dot s-" + s} aria-hidden="true" />
          {TASK_STATE_META[s].label.toLowerCase()}
        </span>
      ))}
    </div>
  );
}

/** A conic-gradient completion donut. */
function Ring({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="ring" style={{ "--p": pct, "--c": color } as CSSProperties}>
      <span className="mono">{pct}%</span>
    </div>
  );
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
        {features.length > 0 && <StateLegend />}
        {!adding && <button className="btn btn-sm" onClick={() => setAdding(true)}>+ New feature</button>}
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
      <div className="fgrid">
        {features.map((f) => {
          const inF = tasks.filter((t) => t.featureId === f.id);
          const milestone = f.milestoneId ? milestones.find((m) => m.id === f.milestoneId) : undefined;
          return (
            <FeatureCard
              key={f.id}
              feature={f}
              tasks={inF}
              counts={stateCounts(inF)}
              progress={progressOf(inF)}
              milestone={milestone}
              milestones={milestones}
              runs={runs}
              onOpenTask={onOpenTask}
              onUpdate={(patch) => onUpdate(f.id, patch)}
              onDelete={() => onDelete(f.id)}
            />
          );
        })}
      </div>
      {orphan.length > 0 && (
        <div className="pf-orphan">
          <div className="pf-orphan-head">Tasks with no feature ({orphan.length})</div>
          <PipelineBar counts={stateCounts(orphan)} />
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

function FeatureCard({
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
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(feature.name);
  const [desc, setDesc] = useState(feature.description ?? "");
  const pct = Math.round(progress * 100);
  const save = () => {
    const n = name.trim();
    if (!n) return;
    onUpdate({ name: n, description: desc.trim() || null });
    setEditing(false);
  };
  return (
    <div className={"fcard fcard-" + feature.status}>
      <button className="fcard-head" onClick={() => setOpen((v) => !v)} title={open ? "Collapse" : "Details, edit & tasks"}>
        <span className="fcard-name">{feature.name}</span>
        {milestone && (
          <span className="fcard-ms" title={milestone.targetAt ? `Target ${fmtDate(milestone.targetAt)}` : "Milestone"}>◉ {milestone.name}</span>
        )}
        {feature.status === "shipped" && <span className="tag tag-ship">✓ shipped</span>}
        {feature.status === "paused" && <span className="tag tag-pause">⏸ paused</span>}
        <span className="fcard-pct mono">{pct}%</span>
      </button>
      <PipelineBar counts={counts} dim={feature.status === "paused"} />
      <div className="fcard-sum">
        <span className="mono">{tasks.length} {tasks.length === 1 ? "task" : "tasks"}</span>
        {tasks.length > 0 ? <span> · {countsSummary(counts)}</span> : <span className="fcard-sum-empty"> · empty</span>}
      </div>
      {open && (
        <div className="fcard-body">
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
              {feature.description ? <p className="pf-desc">{feature.description}</p> : <p className="pf-desc pf-desc-empty">No description.</p>}
              <div className="pf-controls">
                <label className="pf-ms-picker">
                  <span>Milestone</span>
                  <select className="pf-select" value={feature.milestoneId ?? ""} onChange={(e) => onUpdate({ milestoneId: e.target.value || null })}>
                    <option value="">— none —</option>
                    {milestones.map((m) => (
                      <option key={m.id} value={m.id}>{m.name}{m.targetAt ? ` · ${fmtDate(m.targetAt)}` : ""}</option>
                    ))}
                  </select>
                </label>
                <label className="pf-ms-picker">
                  <span>Status</span>
                  <select className="pf-select" value={feature.status} onChange={(e) => onUpdate({ status: e.target.value as "active" | "paused" | "shipped" })}>
                    <option value="active">Active</option>
                    <option value="paused">Paused</option>
                    <option value="shipped">Shipped</option>
                  </select>
                </label>
                <button className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>Edit</button>
                <button className="btn btn-ghost btn-sm pf-del" onClick={() => {
                  if (confirm(`Delete feature "${feature.name}"? Tasks in it will keep existing but lose the grouping.`)) onDelete();
                }}>Delete</button>
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
    onCreate(n, desc.trim() || undefined, target ? new Date(target).getTime() : null);
    setName(""); setDesc(""); setTarget(""); setAdding(false);
  };
  // Ordered by target date (dateless last), then creation.
  const sorted = [...milestones].sort((a, b) => {
    if (a.targetAt == null && b.targetAt == null) return a.createdAt - b.createdAt;
    if (a.targetAt == null) return 1;
    if (b.targetAt == null) return -1;
    return a.targetAt - b.targetAt;
  });
  // Rollup: a milestone's tasks = tasks with milestoneId==mid OR under a feature
  // in that milestone (deduped).
  const rollup = (mid: string): Task[] => {
    const featIds = new Set(features.filter((f) => f.milestoneId === mid).map((f) => f.id));
    const seen = new Set<string>();
    const out: Task[] = [];
    for (const t of tasks) {
      if ((t.milestoneId === mid || (t.featureId && featIds.has(t.featureId))) && !seen.has(t.id)) { seen.add(t.id); out.push(t); }
    }
    return out;
  };
  const unassignedTasks = tasks.filter((t) => {
    if (t.milestoneId) return false;
    if (t.featureId) { const f = features.find((x) => x.id === t.featureId); if (f?.milestoneId) return false; }
    return true;
  });
  const unassignedFeatures = features.filter((f) => !f.milestoneId);
  // TODAY divider position among the DATED milestones (those already past sit
  // left of it). Only meaningful when at least one has a date.
  const dated = sorted.filter((m) => m.targetAt != null);
  const now = Date.now();
  const nowIdx = dated.filter((m) => (m.targetAt as number) <= now).length;
  const datedIds = new Set(dated.map((m) => m.id));
  const dateless = sorted.filter((m) => !datedIds.has(m.id));

  const card = (m: Milestone) => (
    <MilestoneCard
      key={m.id}
      milestone={m}
      features={features.filter((f) => f.milestoneId === m.id)}
      tasks={rollup(m.id)}
      runs={runs}
      onOpenTask={onOpenTask}
      onUpdate={(patch) => onUpdate(m.id, patch)}
      onDelete={() => onDelete(m.id)}
    />
  );

  return (
    <div className="projview-roadmap">
      <div className="pf-head">
        <h3 className="pf-title">{project.name} — roadmap</h3>
        {sorted.length > 0 && <StateLegend />}
        {!adding && <button className="btn btn-sm" onClick={() => setAdding(true)}>+ New milestone</button>}
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
          <textarea className="qx-input pf-addcard-desc" rows={2} placeholder="Description (optional) — what ships in this milestone." value={desc} onChange={(e) => setDesc(e.target.value)} />
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
      {sorted.length === 0 && !adding ? (
        <div className="pf-empty">
          No milestones yet. Create one to group features + tasks into a planned release or checkpoint.
        </div>
      ) : (
        <div className="rm-track">
          {dated.map((m, i) => (
            <Fragment key={m.id}>
              {i === nowIdx && <div className="rm-today" aria-label="today"><span className="rm-today-lbl mono">TODAY</span></div>}
              {card(m)}
            </Fragment>
          ))}
          {dated.length > 0 && nowIdx === dated.length && <div className="rm-today" aria-label="today"><span className="rm-today-lbl mono">TODAY</span></div>}
          {dateless.map((m) => card(m))}
          {(unassignedTasks.length > 0 || unassignedFeatures.length > 0) && (
            <div className="mcard mcard-unassigned">
              <div className="mcard-top">
                <div className="mcard-id">
                  <span className="mcard-diamond d-none" aria-hidden="true" />
                  <div>
                    <div className="mcard-name">No milestone</div>
                    <span className="mcard-when">{unassignedTasks.length + unassignedFeatures.length} unplaced</span>
                  </div>
                </div>
              </div>
              <div className="mcard-feats">
                <PipelineBar counts={stateCounts(unassignedTasks)} />
                {unassignedFeatures.length > 0 && (
                  <div className="mcard-chips">
                    {unassignedFeatures.map((f) => <span key={f.id} className="kb-feat-chip">⊞ {f.name}</span>)}
                  </div>
                )}
              </div>
              <div className="pf-tasklist">
                {unassignedTasks.map((t) => (
                  <TaskLink key={t.id} task={t} run={t.runId ? runs.get(t.runId) : undefined} onOpen={onOpenTask} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MilestoneCard({
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
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(milestone.name);
  const [desc, setDesc] = useState(milestone.description ?? "");
  const [target, setTarget] = useState(milestone.targetAt ? new Date(milestone.targetAt).toISOString().slice(0, 10) : "");
  const pct = Math.round(progressOf(tasks) * 100);
  const daysUntil = milestone.targetAt ? Math.round((milestone.targetAt - Date.now()) / 86400000) : null;
  const ringColor = milestone.status === "shipped" ? "var(--ok)" : milestone.status === "in-progress" ? "var(--accent)" : "var(--info)";
  const late = daysUntil != null && daysUntil < 0 && milestone.status !== "shipped";
  // Tasks under this milestone directly (not via a feature) — shown as their own
  // pipeline bar so nothing is hidden.
  const featIds = new Set(features.map((f) => f.id));
  const directTasks = tasks.filter((t) => !(t.featureId && featIds.has(t.featureId)));
  const save = () => {
    const n = name.trim();
    if (!n) return;
    onUpdate({ name: n, description: desc.trim() || null, targetAt: target ? new Date(target).getTime() : null });
    setEditing(false);
  };
  return (
    <div className={"mcard mcard-" + milestone.status}>
      <div className="mcard-top">
        <div className="mcard-id">
          <span className={"mcard-diamond d-" + milestone.status} aria-hidden="true" />
          <div>
            <div className="mcard-name">{milestone.name}</div>
            <span className={"mcard-when" + (milestone.status === "shipped" ? " ship" : late ? " late" : daysUntil != null && daysUntil <= 14 ? " soon" : "")}>
              {milestone.status === "shipped"
                ? milestone.targetAt ? `✓ shipped · ${fmtDate(milestone.targetAt)}` : "✓ shipped"
                : milestone.targetAt
                  ? `◆ ${fmtDate(milestone.targetAt)}${daysUntil != null ? (daysUntil > 0 ? ` · in ${daysUntil}d` : daysUntil === 0 ? " · today" : ` · ${Math.abs(daysUntil)}d late`) : ""}`
                  : "no target date"}
            </span>
          </div>
        </div>
        <Ring pct={pct} color={ringColor} />
      </div>

      <div className="mcard-feats">
        {features.map((f) => {
          const fTasks = tasks.filter((t) => t.featureId === f.id);
          const done = fTasks.filter((t) => t.state === "done").length;
          return (
            <div key={f.id} className="feat-mini">
              <div className="feat-mini-lbl">
                <span className="feat-mini-name">{f.name}</span>
                <span className="mono">{done}/{fTasks.length}</span>
              </div>
              <PipelineBar counts={stateCounts(fTasks)} dim={f.status === "paused"} />
            </div>
          );
        })}
        {directTasks.length > 0 && (
          <div className="feat-mini">
            <div className="feat-mini-lbl">
              <span className="feat-mini-name feat-mini-direct">Ungrouped tasks</span>
              <span className="mono">{directTasks.filter((t) => t.state === "done").length}/{directTasks.length}</span>
            </div>
            <PipelineBar counts={stateCounts(directTasks)} />
          </div>
        )}
        {tasks.length === 0 && features.length === 0 && <div className="mcard-empty">No tasks or features yet.</div>}
      </div>

      <button className="mcard-expand" onClick={() => setOpen((v) => !v)}>
        {open ? "Hide details" : `Details · edit · ${tasks.length} ${tasks.length === 1 ? "task" : "tasks"}`}
      </button>

      {open && (
        <div className="mcard-body">
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
              {milestone.description ? <p className="pf-desc">{milestone.description}</p> : <p className="pf-desc pf-desc-empty">No description.</p>}
              <div className="pf-controls">
                <label className="pf-ms-picker">
                  <span>Status</span>
                  <select className="pf-select" value={milestone.status} onChange={(e) => onUpdate({ status: e.target.value as "planned" | "in-progress" | "shipped" })}>
                    <option value="planned">Planned</option>
                    <option value="in-progress">In-progress</option>
                    <option value="shipped">Shipped</option>
                  </select>
                </label>
                <button className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>Edit</button>
                <button className="btn btn-ghost btn-sm pf-del" onClick={() => {
                  if (confirm(`Delete milestone "${milestone.name}"? Features + tasks in it keep existing but lose the grouping.`)) onDelete();
                }}>Delete</button>
              </div>
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
  const meta = TASK_STATE_META[task.state];
  const canOpen = !!run;
  return (
    <button className="pf-task" title={canOpen ? "Open the run" : task.text} disabled={!canOpen} onClick={() => run && onOpen(run.id)}>
      <span className="pf-task-state mono" style={{ color: meta.color }}>{meta.label}</span>
      <span className="pf-task-text">{task.text}</span>
    </button>
  );
}
