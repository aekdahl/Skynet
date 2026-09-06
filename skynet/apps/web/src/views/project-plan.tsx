import { useEffect, useMemo, useState } from "react";
import type { Milestone, MilestoneStatus, Plan, Project } from "@skynet/shared";
import * as api from "../lib/client";
import { useStore } from "../lib/store";
import { Markdown } from "../components/markdown";
import { fmtWait } from "../lib/derive";
import { rollupMilestones, type MilestoneRollup } from "../kanban/plan-metrics";
import "../kanban/plan.css";

// Product Steward Phase 1 (docs/product-steward.md) — the living Plan: a
// durable, versioned markdown roadmap per project, replacing the throwaway
// ROADMAP.md/PLAN.md scratch files an AI keeps in a repo today. Not
// repo-coupled (works for chat-only projects too, unlike the separate
// ROADMAP.md-backed Roadmap tab). Phase 1 is operator-maintained — no
// steward agent or `edit_plan` MCP tool yet (that's §3/§4 of the brief).
//
// Deliberately reuses the project's real Milestone entity rather than
// inventing a parallel structure embedded in the Plan document — see
// packages/shared/src/contracts.ts's Plan doc comment.

const STATUS_LABEL: Record<MilestoneStatus, string> = {
  planned: "Planned",
  "in-progress": "In progress",
  shipped: "Shipped",
};

function MilestoneRow({
  rollup,
  unlinkedTaskOptions,
  onUpdate,
  onDelete,
  onLinkTask,
  onUnlinkTask,
}: {
  rollup: MilestoneRollup;
  unlinkedTaskOptions: { id: string; text: string }[];
  onUpdate: (id: string, patch: { status?: MilestoneStatus }) => void;
  onDelete: (id: string) => void;
  onLinkTask: (taskId: string, milestoneId: string) => void;
  onUnlinkTask: (taskId: string) => void;
}) {
  const { milestone, tasks } = rollup;
  const [linking, setLinking] = useState(false);

  return (
    <div className="pplan-milestone">
      <div className="pplan-milestone-head">
        <select
          className="qx-input pplan-milestone-status"
          value={milestone.status}
          onChange={(e) => onUpdate(milestone.id, { status: e.target.value as MilestoneStatus })}
        >
          {(Object.keys(STATUS_LABEL) as MilestoneStatus[]).map((s) => (
            <option key={s} value={s}>{STATUS_LABEL[s]}</option>
          ))}
        </select>
        <span className="pplan-milestone-name">{milestone.name}</span>
        {milestone.targetAt && <span className="pplan-milestone-target mono">{new Date(milestone.targetAt).toLocaleDateString()}</span>}
        <button className="pplan-milestone-del" onClick={() => onDelete(milestone.id)} title="Delete milestone" aria-label="Delete milestone">✕</button>
      </div>
      <div className="pplan-milestone-tasks">
        {tasks.length === 0 && <span className="pplan-milestone-empty">No tasks linked yet.</span>}
        {tasks.map(({ task, direct }) => (
          <span key={task.id} className="pplan-task-chip" title={direct ? undefined : "Linked via this task's feature — unlink it from the feature instead"}>
            {task.text}
            {direct && (
              <span className="pplan-task-chip-x" role="button" aria-label={`Unlink ${task.text}`} onClick={() => onUnlinkTask(task.id)}>✕</span>
            )}
          </span>
        ))}
        {linking ? (
          <select
            className="qx-input pplan-link-select"
            autoFocus
            onChange={(e) => {
              if (e.target.value) onLinkTask(e.target.value, milestone.id);
              setLinking(false);
            }}
            onBlur={() => setLinking(false)}
          >
            <option value="">Pick a task…</option>
            {unlinkedTaskOptions.map((t) => (
              <option key={t.id} value={t.id}>{t.text}</option>
            ))}
          </select>
        ) : unlinkedTaskOptions.length > 0 ? (
          <button className="pplan-link-btn" onClick={() => setLinking(true)}>+ link a task</button>
        ) : null}
      </div>
    </div>
  );
}

function AddMilestoneForm({ onAdd }: { onAdd: (name: string) => void }) {
  const [name, setName] = useState("");
  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onAdd(trimmed);
    setName("");
  };
  return (
    <div className="pplan-add-milestone">
      <input
        className="qx-input"
        placeholder="New milestone name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
      />
      <button className="btn btn-ghost btn-sm" disabled={!name.trim()} onClick={submit}>+ Add milestone</button>
    </div>
  );
}

export function ProjectPlanView({ project }: { project: Project }) {
  const { milestones, tasks, features, planRev, createMilestone, updateMilestone, deleteMilestone, updateTask } = useStore();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);

  const load = () => {
    api.fetchProjectPlan(project.id).then(setPlan).catch((e: unknown) => setErr((e as Error)?.message || "Couldn't load the Plan."));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `load` is a fresh closure every render; only re-fetch on identity/live-signal changes
  useEffect(load, [project.id, planRev]);

  const projMilestones = useMemo(
    () => milestones.filter((m) => m.projectId === project.id && !m.archived).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [milestones, project.id],
  );
  const projTasks = useMemo(() => tasks.filter((t) => t.projectId === project.id), [tasks, project.id]);
  const projFeatures = useMemo(() => features.filter((f) => f.projectId === project.id), [features, project.id]);
  const rollups = useMemo(() => rollupMilestones(projMilestones, projTasks, projFeatures), [projMilestones, projTasks, projFeatures]);
  const unlinkedTaskOptions = useMemo(() => {
    const linked = new Set(rollups.flatMap((r) => r.tasks.map((l) => l.task.id)));
    return projTasks.filter((t) => !linked.has(t.id)).map((t) => ({ id: t.id, text: t.text }));
  }, [rollups, projTasks]);

  const startEdit = () => {
    if (!plan) return;
    setDraft(plan.markdown);
    setConflict(false);
    setEditing(true);
  };
  const save = async () => {
    if (!plan) return;
    setSaving(true);
    setErr(null);
    try {
      const saved = await api.updateProjectPlan(project.id, { markdown: draft, baseVersion: plan.version });
      setPlan(saved);
      setEditing(false);
    } catch (e) {
      if (e instanceof api.ApiError && e.status === 409) setConflict(true);
      else setErr((e as Error)?.message || "Couldn't save the Plan.");
    } finally {
      setSaving(false);
    }
  };

  if (err) return <div className="kb-empty">{err}</div>;
  if (!plan) return <div className="kb-empty">Loading…</div>;

  return (
    <div className="pplan">
      <div className="pplan-intro">
        The living Plan — the durable roadmap for this project, replacing throwaway ROADMAP.md/PLAN.md scratch files.
        Not tied to a repo; works for chat-only projects too.
      </div>

      <div className="pplan-doc">
        <div className="pplan-doc-head">
          <span className="pplan-doc-meta mono">
            v{plan.version}
            {plan.updatedBy ? ` · ${plan.updatedBy}` : ""}
            {plan.version > 0 ? ` · ${fmtWait((Date.now() - plan.updatedAt) / 1000)} ago` : ""}
          </span>
          {!editing && <button className="btn btn-ghost btn-sm" onClick={startEdit}>Edit</button>}
        </div>
        {conflict && (
          <div className="pplan-conflict">
            Someone else updated the Plan while you were editing.{" "}
            <button className="pplan-conflict-reload" onClick={() => { setConflict(false); setEditing(false); load(); }}>Reload to see it →</button>
          </div>
        )}
        {editing ? (
          <>
            <textarea className="qx-input pplan-editor" value={draft} onChange={(e) => setDraft(e.target.value)} rows={14} autoFocus />
            <div className="pplan-doc-actions">
              <button className="btn btn-primary btn-sm" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button>
              <button className="btn btn-ghost btn-sm" disabled={saving} onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </>
        ) : plan.markdown.trim() ? (
          <Markdown text={plan.markdown} />
        ) : (
          <div className="kb-empty">No Plan written yet. Click Edit to start one.</div>
        )}
      </div>

      <div className="pplan-milestones">
        <div className="pplan-section-head">Milestones</div>
        {rollups.length === 0 && <div className="kb-empty">No milestones yet.</div>}
        {rollups.map((r) => (
          <MilestoneRow
            key={r.milestone.id}
            rollup={r}
            unlinkedTaskOptions={unlinkedTaskOptions}
            onUpdate={(id, patch) => void updateMilestone(id, patch)}
            onDelete={(id) => void deleteMilestone(id)}
            onLinkTask={(taskId, milestoneId) => void updateTask(project.id, taskId, { milestoneId })}
            onUnlinkTask={(taskId) => void updateTask(project.id, taskId, { milestoneId: null })}
          />
        ))}
        <AddMilestoneForm onAdd={(name) => void createMilestone(project.id, name)} />
      </div>
    </div>
  );
}
