// ─── Momentum Board — Task Detail panel (Phase 5 — TASK 06) ────────────────
// The panel every card in the new board clicks through to. A 760px-wide
// right-side drawer (see board.tsx, which owns the "which task is open"
// state) — task-CENTRIC, not run-centric, so it works for a queued/held task
// with no run yet, unlike the existing agent/run detail view (views/task.tsx,
// keyed by TaskRun). MERGE/HOLD below call the SAME resolveHitl the old
// board's diff-approval UI uses (views/queue.tsx) — no new merge logic here.
import { useEffect, useState } from "react";
import type { Agent, Feature, HitlItem, Project, Proposal, Rule, Task, TaskRun, Transition } from "@skynet/shared";
import * as api from "../lib/client";
import { useStore } from "../lib/store";
import { openQueue } from "../lib/derive";
import { Chip, TrailRow, type ActorType, type ChipTone } from "./primitives";

const STATE_CHIP_TONE: Record<Task["state"], ChipTone> = {
  backlog: "machine",
  triage: "machine",
  todo: "human",
  ongoing: "machine",
  review: "machine",
  done: "machine-deep",
};

interface CheckpointDetail {
  key: string;
  label: string;
  state: "done" | "active" | "blocked" | "pending";
  signal: string | null;
}

/** Same 5-stage derivation as board.tsx's deriveCheckpointSteps, plus the
 *  resolving signal text each stage's state is actually grounded in — kept
 *  local (not shared) since this is the one place that needs the extra
 *  detail; board.tsx's own rail stays untouched. */
function deriveCheckpointDetails(run: TaskRun | undefined, task: Task): CheckpointDetail[] {
  const steps: Array<[string, string]> = [
    ["branch", "Branch"],
    ["pr", "PR"],
    ["review", "Review"],
    ["merge", "Merge"],
    ["deploy", "Deploy"],
  ];
  return steps.map(([key, label]) => {
    if (!run) return { key, label, state: "pending", signal: null };
    switch (key) {
      case "branch":
        return { key, label, state: "done", signal: run.branch };
      case "pr":
        return run.pr
          ? { key, label, state: "done", signal: `PR #${run.pr.number} ${run.pr.state === "merged" ? "merged" : run.pr.state === "closed" ? "closed" : "opened"}` }
          : { key, label, state: run.status === "done" ? "pending" : "active", signal: null };
      case "review":
        if (task.reviewVerdict?.decision === "approve") return { key, label, state: "done", signal: `Approved — ${task.reviewVerdict.reason}` };
        if (task.reviewVerdict?.decision === "flag") return { key, label, state: "blocked", signal: `Flagged — ${task.reviewVerdict.reason}` };
        return { key, label, state: run.pr || run.status === "review" ? "active" : "pending", signal: run.pr ? "Awaiting review" : null };
      case "merge":
        if (run.mergedAt != null) return { key, label, state: "done", signal: `Merged ${new Date(run.mergedAt).toLocaleString()}` };
        return { key, label, state: task.reviewVerdict?.decision === "approve" ? "active" : "pending", signal: null };
      case "deploy":
        return run.flyDeployment
          ? { key, label, state: "done", signal: "Deployed" }
          : { key, label, state: "pending", signal: null };
      default:
        return { key, label, state: "pending", signal: null };
    }
  });
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function MomentumTaskDetail({
  task,
  project,
  tasks,
  runs,
  queue,
  features,
  fleet,
  rules,
  proposals,
  now,
  onClose,
  onOpenTask,
}: {
  task: Task;
  project: Project;
  tasks: Task[];
  runs: TaskRun[];
  queue: HitlItem[];
  features: Feature[];
  fleet: Agent[];
  rules: Rule[];
  proposals: Proposal[];
  now: number;
  onClose: () => void;
  onOpenTask: (id: string) => void;
}) {
  const { resolveHitl, acceptSubtask, acceptAllSubtasks } = useStore();
  const run = task.runId ? runs.find((r) => r.id === task.runId) : undefined;
  const feature = task.featureId ? features.find((f) => f.id === task.featureId) : undefined;
  const parent = task.parentTaskId ? tasks.find((t) => t.id === task.parentTaskId) : undefined;

  // Real, already-accepted subtasks — a plain task-list filter.
  const subtasks = tasks.filter((t) => t.parentTaskId === task.id);

  // Suggested-but-not-yet-accepted subtasks: PENDING suggested_subtask
  // Proposals whose (untyped) payload names THIS task as parent.
  const suggestedSubtasks = proposals.filter((p) => {
    if (p.kind !== "suggested_subtask" || p.status !== "pending") return false;
    const payload = p.payload as { parentTaskId?: unknown } | null;
    return payload && payload.parentTaskId === task.id;
  });

  const [accepting, setAccepting] = useState<string | null>(null); // proposalId, or "*" for accept-all
  const acceptOne = async (proposalId: string) => {
    setAccepting(proposalId);
    try {
      await acceptSubtask(task.id, proposalId);
    } finally {
      setAccepting(null);
    }
  };
  const acceptAll = async () => {
    setAccepting("*");
    try {
      await acceptAllSubtasks(task.id);
    } finally {
      setAccepting(null);
    }
  };

  // Trail: every Transition for this task, newest first.
  const [transitions, setTransitions] = useState<Transition[] | null>(null);
  useEffect(() => {
    let live = true;
    setTransitions(null);
    api.fetchTaskTransitions(task.id).then((t) => {
      if (live) setTransitions([...t].sort((a, b) => b.at - a.at));
    }).catch(() => live && setTransitions([]));
    return () => {
      live = false;
    };
  }, [task.id]);

  const ruleName = (ruleId: string | null): string | null => (ruleId ? rules.find((r) => r.id === ruleId)?.name ?? null : null);

  // Owner block.
  const assignee = run?.agentId ? fleet.find((a) => a.id === run.agentId) : undefined;
  const assignmentLabel =
    task.assignment.mode === "unassigned"
      ? "Unassigned"
      : task.assignment.mode === "any"
        ? "Any agent"
        : task.assignment.agentIds.map((id) => fleet.find((a) => a.id === id)?.name ?? id).join(", ") || "Any agent";

  // Decision block: the one open diff/merge review for this task's run, if any.
  const decisionItem = run ? openQueue(queue).find((it) => it.runId === run.id && (it.kind === "diff" || it.kind === "merge")) : undefined;
  const [deciding, setDeciding] = useState<"merge" | "hold" | null>(null);
  const decide = async (action: "approve" | "reject") => {
    if (!decisionItem) return;
    setDeciding(action === "approve" ? "merge" : "hold");
    try {
      await resolveHitl(decisionItem.id, action);
    } finally {
      setDeciding(null);
    }
  };

  const checkpoints = deriveCheckpointDetails(run, task);

  return (
    <div className="mb-detail-backdrop" onClick={onClose}>
      <div className="mb-detail-panel" onClick={(e) => e.stopPropagation()}>
        <div className="mb-detail-header">
          <div className="mb-detail-breadcrumb mono">
            <span>{project.name}</span>
            {feature && (
              <>
                <span className="mb-detail-crumb-sep">/</span>
                <span>{feature.name}</span>
              </>
            )}
            <span className="mb-detail-crumb-sep">/</span>
            <span className="mb-detail-crumb-current">{task.text}</span>
          </div>
          <div className="mb-detail-head-row">
            <h2 className="mb-detail-title">{task.text}</h2>
            <Chip label={task.state} tone={STATE_CHIP_TONE[task.state]} />
          </div>
          <button className="btn btn-ghost btn-sm mb-detail-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="mb-detail-body">
          <div className="mb-detail-main">
            {task.description && <p className="mb-detail-desc">{task.description}</p>}

            {parent && (
              <button className="mb-detail-parent-link" onClick={() => onOpenTask(parent.id)}>
                ↑ Subtask of “{parent.text}”
              </button>
            )}

            <section className="mb-detail-section">
              <div className="mb-detail-section-head">
                <h3>Subtasks</h3>
                {suggestedSubtasks.length > 0 && (
                  <button className="btn btn-ghost btn-sm" disabled={accepting != null} onClick={acceptAll}>
                    {accepting === "*" ? "Accepting…" : `Accept all (${suggestedSubtasks.length})`}
                  </button>
                )}
              </div>
              {subtasks.length === 0 && suggestedSubtasks.length === 0 && <div className="mb-detail-empty">No subtasks.</div>}
              {subtasks.map((st) => (
                <button key={st.id} className="mb-detail-subtask" onClick={() => onOpenTask(st.id)}>
                  <span className="mb-detail-subtask-text">{st.text}</span>
                  <Chip label={st.state} tone={STATE_CHIP_TONE[st.state]} />
                </button>
              ))}
              {suggestedSubtasks.map((p) => {
                const payload = p.payload as { text?: string; description?: string | null } | null;
                return (
                  <div key={p.id} className="mb-detail-subtask mb-detail-subtask-suggested">
                    <span className="mb-detail-subtask-text">{payload?.text ?? "(untitled suggestion)"}</span>
                    <button className="btn btn-ghost btn-sm" disabled={accepting != null} onClick={() => acceptOne(p.id)}>
                      {accepting === p.id ? "Accepting…" : "Accept"}
                    </button>
                  </div>
                );
              })}
            </section>

            <section className="mb-detail-section">
              <h3>Trail</h3>
              {transitions == null && (
                <div className="mb-detail-skel" aria-busy="true">
                  <span className="ak-skel-row" style={{ width: "85%" }} />
                  <span className="ak-skel-row" style={{ width: "60%" }} />
                </div>
              )}
              {transitions != null && transitions.length === 0 && <div className="mb-detail-empty">No moves recorded yet.</div>}
              {transitions?.map((t) => (
                <TrailRow
                  key={t.id}
                  actor={t.actor === "human" ? t.actorId ?? "an operator" : ruleName(t.ruleId) ? `rule: ${ruleName(t.ruleId)}` : "Skynet"}
                  actorType={t.actor as ActorType}
                  action={`${t.from} → ${t.to}`}
                  timestamp={fmtTime(t.at)}
                />
              ))}
            </section>
          </div>

          <div className="mb-detail-rail">
            <section className="mb-detail-section">
              <h3>Checkpoints</h3>
              {checkpoints.map((c) => (
                <div key={c.key} className={"mb-detail-checkpoint mb-detail-checkpoint-" + c.state}>
                  <span className={"mb-detail-checkpoint-dot mb-detail-checkpoint-dot-" + c.state} aria-hidden="true" />
                  <span className="mb-detail-checkpoint-label">{c.label}</span>
                  <span className="mb-detail-checkpoint-signal">{c.signal ?? "—"}</span>
                </div>
              ))}
            </section>

            <section className="mb-detail-section">
              <h3>Owner</h3>
              <div className="mb-detail-owner-line">{assignmentLabel}</div>
              {assignee && <div className="mb-detail-owner-line mb-detail-owner-running">Running on {assignee.name}</div>}
            </section>

            {decisionItem && (
              <div className="mb-detail-decision">
                <div className="mb-detail-decision-copy">One decision left: merge now and ship in the next train?</div>
                <div className="mb-detail-decision-actions">
                  <button className="btn mb-detail-merge" disabled={deciding != null} onClick={() => decide("approve")}>
                    {deciding === "merge" ? "Merging…" : "Merge"}
                  </button>
                  <button className="btn btn-ghost" disabled={deciding != null} onClick={() => decide("reject")}>
                    {deciding === "hold" ? "Holding…" : "Hold"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
