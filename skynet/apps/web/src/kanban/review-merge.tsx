// ─── Review & Merge (Phase 15 — TASK 18) ───────────────────────────────────
// "The human reads argument before code." Reached the same way Run Detail is
// (App.tsx's view === "task" route) — for a run sitting on an open diff/
// merge/verifier gate, this replaces the live Run Detail screen with the
// review decision itself. Built entirely on data that already exists:
// HitlItem.diff (walkthrough/mergeBrief/groups), Task.reviewVerdict (the
// second agent's review), and the new GET /api/projects/:id/merge-queue.
import { useEffect, useState } from "react";
import type { PrChecksStatus, TaskRun } from "@skynet/shared";
import { useStore } from "../lib/store";
import { fetchMergeQueue, fetchPrChecks, type MergeQueueEntry } from "../lib/client";
import { contendedFileOwner, fileCollisionsForAgent, fmtCost, fmtElapsed, hitlFor } from "../lib/derive";
import { DiffView } from "../components/diff-view";
import { toast } from "../components/toast";

function useMergeQueue(projectId: string) {
  const [entries, setEntries] = useState<MergeQueueEntry[] | null>(null);
  useEffect(() => {
    let live = true;
    fetchMergeQueue(projectId)
      .then((e) => live && setEntries(e))
      .catch(() => live && setEntries([]));
    return () => {
      live = false;
    };
  }, [projectId]);
  return entries;
}

function usePrChecks(runId: string, hasPr: boolean) {
  const [status, setStatus] = useState<PrChecksStatus | null | "loading">(hasPr ? "loading" : null);
  useEffect(() => {
    if (!hasPr) return;
    fetchPrChecks(runId).then(setStatus).catch(() => setStatus(null));
  }, [runId, hasPr]);
  return status;
}

export function ReviewMergeView({
  agent,
  now,
  onBack,
  backLabel,
}: {
  agent: TaskRun;
  now: number;
  onBack: () => void;
  backLabel: string;
}) {
  const { runs, tasks, projects, resolveHitl, queue, readOnly, wsPhase } = useStore();
  const item = hitlFor(queue, agent.id);
  const task = tasks.find((t) => t.runId === agent.id);
  const project = projects.find((p) => p.id === agent.projectId);
  const verdict = task?.reviewVerdict;
  const collisions = fileCollisionsForAgent(agent, runs);
  const mergeQueue = useMergeQueue(agent.projectId);
  const checks = usePrChecks(agent.id, !!agent.pr);
  const [notesOpen, setNotesOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const [diffExpanded, setDiffExpanded] = useState(false);

  if (!item || !item.diff) {
    return (
      <div className="vw rv-review-merge">
        <button className="rv-back" onClick={onBack}>← {backLabel}</button>
        <div className="rv-empty">This run has no open review gate right now.</div>
      </div>
    );
  }
  const diff = item.diff;
  // Not every diff-carrying gate sets `groups` (e.g. a merge-conflict retry
  // gate's minimal carry-forward diff, raised well after grouping ever ran) —
  // defensive here rather than assuming every construction site does.
  const groups = diff.groups ?? [];

  const riskWord: "Low" | "Medium" | "High" | null = !verdict
    ? null
    : verdict.decision === "approve"
      ? "Low"
      : verdict.breaker?.verdict === "broken"
        ? "High"
        : "Medium";
  const riskCls = riskWord === "Low" ? "rv-verdict-lime" : "rv-verdict-amber";
  const findings =
    verdict?.breaker?.findings?.length
      ? verdict.breaker.findings.map((f) => f.what)
      : verdict?.evidence?.length
        ? verdict.evidence
        : verdict
          ? [verdict.reason]
          : [];

  const addToQueue = async () => {
    await resolveHitl(item.id, "approve", { targetBranch: diff.defaultTargetBranch ?? undefined });
  };
  const sendBack = async () => {
    if (!notes.trim()) return;
    await resolveHitl(item.id, "modify", { guidance: notes.trim() });
    setNotes("");
    setNotesOpen(false);
    toast("Sent back with notes.");
  };

  return (
    <div className="vw rv-review-merge">
      <button className="rv-back" onClick={onBack}>← {backLabel}</button>
      <div className="rv-header">
        <div className="rv-title">
          {agent.name}
          {wsPhase !== "open" && <span className="rv-disconnect-pill" role="status">⚠ RECONNECTING</span>}
        </div>
        <div className="rv-meta-row">
          <span>run #{agent.id.slice(-6)}</span>
          <span className="rv-meta-sep">·</span>
          <span>{agent.model}</span>
          <span className="rv-meta-sep">·</span>
          <span className="diff-add">+{diff.add}</span> <span className="diff-del">−{diff.del}</span>
          <span className="rv-meta-sep">·</span>
          <span>{diff.files.length} file{diff.files.length === 1 ? "" : "s"}</span>
          <span className="rv-meta-sep">·</span>
          <span>{fmtElapsed(agent, now)}</span>
          <span className="rv-meta-sep">·</span>
          <span>{fmtCost(agent.usage?.costUsd ?? 0)}</span>
        </div>
        <div className="rv-header-actions">
          <button className="btn btn-human" disabled={readOnly} onClick={() => void addToQueue()}>
            Add to merge queue
          </button>
          <button className="btn btn-ghost" disabled={readOnly} onClick={() => setNotesOpen((o) => !o)}>
            Send back with notes
          </button>
        </div>
        {notesOpen && (
          <div className="rv-notes">
            <textarea
              className="rv-notes-input"
              rows={3}
              autoFocus
              placeholder="What should change before this merges?"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
            <div className="rv-notes-actions">
              <button className="btn btn-primary" disabled={readOnly || !notes.trim()} onClick={() => void sendBack()}>
                Send
              </button>
              <button className="btn btn-ghost" onClick={() => setNotesOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="rv-grid">
        <div className="rv-col rv-main-col">
          <div className="rv-panel-title">WALKTHROUGH · WRITTEN BY THE AGENT</div>
          {diff.walkthrough ? (
            <div className="rv-walkthrough">
              <p className="rv-walkthrough-summary">{diff.walkthrough.summary}</p>
              <div className="rv-uncertainty">
                <span className="rv-uncertainty-label">What I'm least sure about:</span>
                <span className="rv-uncertainty-text">{diff.walkthrough.uncertainty ?? "Not stated by the agent."}</span>
              </div>
            </div>
          ) : (
            <div className="rv-empty">No walkthrough was drafted for this diff.</div>
          )}

          <div className="rv-panel-title rv-groups-title">
            DIFF · GROUPED BY INTENT, NOT BY FILE
            {collisions.length > 0 && (
              <span aria-live="polite"> · {collisions.length} file{collisions.length === 1 ? "" : "s"} also being edited elsewhere</span>
            )}
          </div>
          <div className="rv-groups">
            {groups.length === 0 && (
              <div className="rv-empty">Couldn't group this diff — see the raw changes below.</div>
            )}
            {groups.map((g) => {
              const contendedFiles = g.files.filter((f) => collisions.includes(f));
              const contended = contendedFiles.length > 0;
              const owner = contended ? contendedFileOwner(contendedFiles[0]!, agent, runs) : undefined;
              return (
                <button
                  key={g.title}
                  className={"rv-group" + (contended ? " rv-group-contended" : "")}
                  onClick={() => setDiffExpanded(true)}
                >
                  <span className="rv-group-title">{g.title}</span>
                  <span className="rv-group-meta">
                    {g.files.length} file{g.files.length === 1 ? "" : "s"} · <span className="diff-add">+{g.add}</span>{" "}
                    <span className="diff-del">−{g.del}</span>
                  </span>
                  {contended && (
                    <span className="rv-group-contended-note">
                      · also edited by run #{(owner?.id ?? "?").slice(-6)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <div key={diffExpanded ? "open" : "closed"}>
            <DiffView runId={agent.id} add={diff.add} del={diff.del} walkthrough={diff.walkthrough} mergeBrief={diff.mergeBrief} defaultOpen={diffExpanded} />
          </div>
        </div>

        <div className="rv-col rv-side-col">
          <div className="rv-panel-title">MERGE RISK · SECOND AGENT</div>
          {verdict ? (
            <div className="rv-risk">
              <div className={"rv-risk-word " + riskCls}>{riskWord}</div>
              <div className="rv-risk-by">reviewed by {verdict.by}</div>
              <ul className="rv-risk-findings">
                {findings.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="rv-empty">No second agent has reviewed this run yet.</div>
          )}

          <div className="rv-panel-title rv-evidence-title">EVIDENCE</div>
          <div className="rv-evidence">
            {agent.pr ? (
              checks === "loading" ? (
                <div className="rv-evidence-row rv-empty">checking CI…</div>
              ) : checks && checks.checks !== "none" ? (
                <div className="rv-evidence-row">
                  <span className={"rv-evidence-mark " + (checks.checks === "passing" ? "rv-mark-ok" : checks.checks === "failing" ? "rv-mark-fail" : "rv-mark-pending")}>
                    {checks.checks === "passing" ? "✓" : checks.checks === "failing" ? "✗" : "⏳"}
                  </span>
                  Tests / typecheck / lint — {checks.checks}
                </div>
              ) : (
                <div className="rv-evidence-row rv-empty">no CI configured</div>
              )
            ) : (
              <div className="rv-evidence-row rv-empty">no PR — nothing to check</div>
            )}
            <div className="rv-evidence-row rv-browser-check">
              <span className="rv-evidence-mark rv-mark-pending">▶</span>
              Browser check recording
              <span className="rv-thumbnail-placeholder" title="No player wired yet — see the PR description">
                (no recording player yet)
              </span>
            </div>
          </div>

          <div className="rv-panel-title rv-queue-title">READY TO MERGE · {mergeQueue?.length ?? 0}</div>
          <div className="rv-queue">
            {mergeQueue === null && <div className="rv-empty">Loading…</div>}
            {mergeQueue?.length === 0 && <div className="rv-empty">Nothing else is queued.</div>}
            {mergeQueue?.map((q) => (
              <div key={q.runId} className={"rv-queue-row" + (q.mode === "human" ? " rv-queue-human" : " rv-queue-auto")}>
                <span className="rv-queue-pos">#{q.position + 1}</span>
                <span className="rv-queue-run">run #{q.runId.slice(-6)}</span>
                <span className={"rv-queue-badge " + (q.mode === "human" ? "rv-badge-human" : "rv-badge-auto")}>
                  {q.mode === "human" ? "you" : "auto"}
                </span>
              </div>
            ))}
            {mergeQueue?.some((q) => q.mode === "human") && mergeQueue.some((q) => q.mode === "auto") && (
              <p className="rv-queue-footnote">
                {mergeQueue.find((q) => q.mode === "auto")?.reason ?? "Policy merges some of these on its own."} This one is
                yours because {project?.approvalLevel === "full" ? "it's high-risk." : "a policy value sits in code."}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
