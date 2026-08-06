import { useState } from "react";
import type { TaskRun } from "@skynet/shared";
import { useStore } from "../lib/store";
import { readyMerges } from "../lib/derive";
import { RiskChip } from "../components/hitl-context";

// The recommendation the AI reviewer left, as a colored chip. Merge = the run
// satisfies the task; rework = a reviewer flagged it; hold = neither (unclear).
const REC_META: Record<string, { label: string; color: string }> = {
  merge: { label: "RECOMMEND MERGE", color: "var(--ok)" },
  rework: { label: "RECOMMEND REWORK", color: "var(--warn)" },
  hold: { label: "HOLD", color: "var(--muted)" },
};

function MergeCard({ run, onOpenTask }: { run: TaskRun; onOpenTask: (id: string) => void }) {
  const { mergePr, updatePrBranch, reworkPr, dismissPr } = useStore();
  const pr = run.pr!;
  const b = pr.briefing;
  const rec = REC_META[b?.recommendation ?? "hold"] ?? REC_META.hold!;
  const [mode, setMode] = useState<null | "rework">(null);
  const [guidance, setGuidance] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<null | string>(null);
  const [blocked, setBlocked] = useState<{ reason: string; kind?: "conflict" | "checks" | "protection" } | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const doMerge = async () => {
    setBusy("merge");
    setBlocked(null);
    setNote(null);
    try {
      const res = await mergePr(run.id, "squash");
      if (!res.merged) setBlocked({ reason: res.reason ?? "GitHub blocked the merge.", kind: res.blocked });
    } catch (e) {
      setBlocked({ reason: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const doUpdateBranch = async () => {
    setBusy("update");
    setNote(null);
    try {
      const res = await updatePrBranch(run.id);
      if (res.updated) {
        setBlocked(null);
        setNote(`Branch updated to the latest ${pr.base}. Try Merge again.`);
      } else {
        const files = res.conflicts?.length ? `: ${res.conflicts.join(", ")}` : "";
        setBlocked({ reason: `Real conflict with ${pr.base}${files} — can't auto-resolve. Use "Rework" so the agent fixes it.`, kind: "conflict" });
      }
    } catch (e) {
      setBlocked({ reason: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const doRework = async () => {
    if (!guidance.trim()) return;
    setBusy("rework");
    try {
      await reworkPr(run.id, guidance.trim(), comment.trim() || undefined);
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className="qcard">
      <div className="qcard-head">
        <span className="kind-chip" style={{ color: rec.color, borderColor: rec.color }}>{rec.label}</span>
        {b && <RiskChip risk={b.risk} />}
        <button className="qcard-agent" onClick={() => onOpenTask(run.id)}>{run.name}</button>
        <a className="merge-prlink mono" href={pr.url} target="_blank" rel="noreferrer" title="Open the pull request on GitHub">
          #{pr.number} ↗
        </a>
      </div>

      <h3 className="qcard-title">{b?.summary ?? `${run.name} — ready to merge`}</h3>
      {b && (
        <dl className="merge-brief">
          <dt>Impact</dt>
          <dd>{b.impact}</dd>
          <dt>Review</dt>
          <dd>{b.rationale}</dd>
        </dl>
      )}
      <p className="merge-branch mono">{pr.branch} → {pr.base} · <a href={pr.url} target="_blank" rel="noreferrer">view diff on GitHub ↗</a></p>

      <div className="qcard-actions">
        <button className="btn btn-primary" disabled={busy != null} onClick={doMerge}>
          {busy === "merge" ? "Merging…" : "Merge"}
        </button>
        {/* Offered once a merge is blocked by a stale base — re-syncs without the agent. */}
        {blocked?.kind === "conflict" && (
          <button className="btn" disabled={busy != null} onClick={doUpdateBranch} title={`Fold the latest ${pr.base} into this branch and re-push`}>
            {busy === "update" ? "Updating…" : "Update branch"}
          </button>
        )}
        <button
          className={"btn btn-ghost" + (mode === "rework" ? " btn-lit" : "")}
          disabled={busy != null}
          onClick={() => setMode(mode === "rework" ? null : "rework")}
        >
          Rework with comment
        </button>
        <button className="btn btn-ghost" disabled={busy != null} onClick={() => dismissPr(run.id)} title="Set aside — hide from this list; the PR stays open on GitHub">
          No-op
        </button>
      </div>

      {blocked && <p className="merge-blocked">⚠ {blocked.reason}</p>}
      {note && <p className="merge-note">✓ {note}</p>}

      {mode === "rework" && (
        <div className="qx">
          <textarea
            className="qx-input"
            rows={3}
            autoFocus
            placeholder="What should change before this can merge? The agent resumes with this guidance and pushes new commits to the same PR."
            value={guidance}
            onChange={(e) => setGuidance(e.target.value)}
          />
          <input
            className="qx-input qx-line"
            placeholder="Optional — also post this as a comment on the PR"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          <div className="qx-row">
            <button className="btn btn-primary" disabled={busy != null || !guidance.trim()} onClick={doRework}>
              {busy === "rework" ? "Sending…" : "Send & rework"}
            </button>
            <button className="btn btn-ghost" onClick={() => setMode(null)}>Cancel</button>
          </div>
        </div>
      )}
    </article>
  );
}

export function MergesView({ onOpenTask }: { onOpenTask: (id: string) => void }) {
  const { runs } = useStore();
  const ready = readyMerges(runs);

  return (
    <section className="queue">
      <div className="vw-head">
        <h1>Ready to merge</h1>
        <p>
          PRs an AI reviewer approved and opened — the final merge is yours. Merge, send back for
          rework, or set aside. Skynet never auto-merges to your base branch.
        </p>
      </div>
      {ready.length === 0 ? (
        <div className="queue-empty">
          <span className="queue-empty-mark">✓</span>
          <p>No PRs waiting — nothing to merge right now.</p>
        </div>
      ) : (
        <div className="queue-list">
          {ready.map((r) => (
            <MergeCard key={r.id} run={r} onOpenTask={onOpenTask} />
          ))}
        </div>
      )}
    </section>
  );
}
