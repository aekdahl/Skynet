import { useEffect, useState } from "react";
import type { Feature, FeatureBrief, MergeBriefing, PrChecksStatus, TaskRun } from "@skynet/shared";
import { useStore } from "../lib/store";
import * as api from "../lib/client";
import { readyMerges, readyFeatureMerges, fmtCost, fmtNum, fleetAgentName, projectName } from "../lib/derive";
import { RiskChip } from "../components/hitl-context";
import { Blocked } from "../components/empty";
import { RefreshIcon } from "../components/icons";

// The recommendation the AI reviewer left, as a colored chip. Merge = the run
// satisfies the task; rework = a reviewer flagged it; hold = neither (unclear).
const REC_META: Record<string, { label: string; color: string }> = {
  merge: { label: "RECOMMEND MERGE", color: "var(--ok)" },
  rework: { label: "RECOMMEND REWORK", color: "var(--warn)" },
  hold: { label: "HOLD", color: "var(--muted)" },
};

const CHECKS_META: Record<PrChecksStatus["checks"], { label: string; cls: string }> = {
  passing: { label: "✓ Checks passing", cls: "checks-passing" },
  failing: { label: "✗ Checks failing", cls: "checks-failing" },
  pending: { label: "⏳ Checks pending", cls: "checks-pending" },
  none: { label: "", cls: "" }, // handled separately — no badge, a quieter note
};

const RUN_STATE_META: Record<PrChecksStatus["runs"][number]["state"], { mark: string; cls: string }> = {
  pass: { mark: "✓", cls: "check-run-pass" },
  fail: { mark: "✗", cls: "check-run-fail" },
  pending: { mark: "⏳", cls: "check-run-pending" },
};

/** The named CI jobs (e.g. lint/typecheck/test) behind the aggregate `checks`
 *  verdict — so a reviewer sees WHICH gate failed, not just that "checks" as a
 *  whole are red, without leaving this card for the GitHub Checks tab. */
function CheckRunList({ runs }: { runs: PrChecksStatus["runs"] }) {
  if (runs.length === 0) return null;
  return (
    <ul className="merge-check-runs">
      {runs.map((r) => {
        const meta = RUN_STATE_META[r.state];
        return (
          <li key={r.name} className={`merge-check-run ${meta.cls}`}>
            <span className="merge-check-run-mark">{meta.mark}</span> {r.name}
          </li>
        );
      })}
    </ul>
  );
}

/** Live GitHub check-run status, fetched by the CARD ITSELF on mount (a real
 *  GitHub API call — never baked into the polled snapshot). Lifted out of the
 *  badge so the same fetch backs both the head's compact pill AND the
 *  per-check breakdown shown in the card body — one fetch, two views of it. */
function usePrChecksStatus(fetchChecks: () => Promise<PrChecksStatus | null>) {
  const [status, setStatus] = useState<PrChecksStatus | null | "loading">("loading");
  const load = () => {
    setStatus("loading");
    fetchChecks()
      .then(setStatus)
      .catch(() => setStatus(null));
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps
  return { status, reload: load };
}

/** The compact head-row pill. Shown BEFORE a merge decision, not just after
 *  GitHub blocks an attempt: an operator deciding whether to trust "RECOMMEND
 *  MERGE" needs to know whether anything automated actually ran and passed.
 *  `checks:"none"` (no CI configured on the repo) is shown explicitly too —
 *  silence isn't the same as passing. */
function PrChecksBadge({ status, onRefresh }: { status: PrChecksStatus | null | "loading"; onRefresh: () => void }) {
  if (status === "loading") return <span className="merge-nocheck">checking CI…</span>;
  if (status === null) return null; // unreachable — fail silent, no misleading badge
  if (status.checks === "none") {
    return (
      <span className="merge-nocheck" title="No CI checks are configured on this repo — this isn't a pass, there's simply nothing to report.">
        no CI configured
      </span>
    );
  }
  const meta = CHECKS_META[status.checks];
  return (
    <span className={`merge-checks ${meta.cls}`}>
      {meta.label}
      <button className="merge-checks-refresh" onClick={onRefresh} title="Re-check CI status" aria-label="Re-check CI status"><RefreshIcon /></button>
    </span>
  );
}

/** The decision-relevant detail a bare "RECOMMEND MERGE" summary doesn't show:
 *  the real diff composition (not just a total), which files actually tripped
 *  the sensitive-area flag (not just the flag), and who authored vs. who
 *  independently reviewed this — plus the reviewer's own words. */
function MergeBriefingDetail({ b, fleet }: { b: MergeBriefing; fleet: import("@skynet/shared").Agent[] }) {
  const author = fleetAgentName(b.authoredBy, fleet);
  const reviewer = fleetAgentName(b.reviewedBy, fleet);
  return (
    <>
      <p className="merge-stat">
        <b className="add">+{b.add}</b> / <b className="del">-{b.del}</b> · {b.filesChanged} file{b.filesChanged === 1 ? "" : "s"}
        {b.modules.length > 0 && <> · touches {b.modules.join(", ")}</>}
        {b.modules.length === 0 && <> · no mapped module</>}
        {" · "}
        {b.testsChanged ? "tests changed" : "no test changes"}
      </p>
      {b.requiresHuman && (
        <div className="qcard-flags qcard-flags-human">
          <span className="qcard-flags-label">⚠ Requires human review</span>
          {b.requiresHumanGlobs.map((g) => (
            <span key={g} className="flag-chip flag-file">{g}</span>
          ))}
        </div>
      )}
      {b.sensitiveFiles.length > 0 && (
        <div className="qcard-flags">
          <span className="qcard-flags-label">Sensitive area</span>
          {b.sensitiveFiles.slice(0, 6).map((f) => (
            <span key={f} className="flag-chip flag-file">{f}</span>
          ))}
          {b.sensitiveFiles.length > 6 && <span className="flag-chip">+{b.sensitiveFiles.length - 6} more</span>}
        </div>
      )}
      <p className="merge-attribution">
        {author ? <>Authored by <b>{author}</b></> : "Author unknown"}
        {reviewer ? (
          <>
            {" → "}reviewed by <b>{reviewer}</b>
            {b.reviewDecision && <> ({b.reviewDecision === "flag" ? "flagged" : "approved"})</>}
          </>
        ) : (
          " — no independent AI review recorded"
        )}
      </p>
      <p className="qcard-reason">{b.rationale}</p>
    </>
  );
}

function MergeCard({ run, onOpenTask }: { run: TaskRun; onOpenTask: (id: string) => void }) {
  const { mergePr, updatePrBranch, reworkPr, dismissPr, fleet, projects } = useStore();
  const pr = run.pr!;
  const b = pr.briefing;
  const rec = REC_META[b?.recommendation ?? "hold"] ?? REC_META.hold!;
  const [mode, setMode] = useState<null | "rework">(null);
  const [guidance, setGuidance] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<null | string>(null);
  const [blocked, setBlocked] = useState<{ reason: string; kind?: "conflict" | "checks" | "protection" } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const checks = usePrChecksStatus(() => api.fetchPrChecks(run.id));

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
        <PrChecksBadge status={checks.status} onRefresh={checks.reload} />
        <span className="qcard-project" title="Project">{projectName(run.projectId, projects)}</span>
        <button className="qcard-agent" onClick={() => onOpenTask(run.id)}>{run.name}</button>
        <a className="merge-prlink mono" href={pr.url} target="_blank" rel="noreferrer" title="Open the pull request on GitHub">
          #{pr.number} ↗
        </a>
      </div>

      <h3 className="qcard-title">{b?.summary ?? `${run.name} — ready to merge`}</h3>
      {checks.status && checks.status !== "loading" && checks.status.runs.length > 0 && (
        <div className="merge-gate-results">
          <span className="qcard-flags-label mono">Gate results</span>
          <CheckRunList runs={checks.status.runs} />
        </div>
      )}
      {b && <MergeBriefingDetail b={b} fleet={fleet} />}
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
            <Blocked disabled={!guidance.trim()} reason={!guidance.trim() ? "Describe what should change before sending." : undefined}>
              <button className="btn btn-primary" disabled={busy != null || !guidance.trim()} onClick={doRework}>
                {busy === "rework" ? "Sending…" : "Send & rework"}
              </button>
            </Blocked>
            <button className="btn btn-ghost" onClick={() => setMode(null)}>Cancel</button>
          </div>
        </div>
      )}
    </article>
  );
}

// Makes approving a batched multi-task feature PR reviewable instead of a
// rubber stamp: what each bundled task did (+ its own reviewer verdict), the
// total spend across every run in the batch, what verified it, and a
// consult-drafted read of what the feature now does as a whole. Collapsed by
// default — a card with 30 tasks shouldn't force a wall of text on everyone;
// an operator who wants the detail expands it. `brief` is null for an older
// PR record opened before this existed, or when the composing consult
// couldn't reach a provider — the card just omits this section either way.
function FeatureBriefDetail({ brief }: { brief: FeatureBrief }) {
  const [open, setOpen] = useState(false);
  const flagged = brief.tasks.filter((t) => t.verdict === "flag").length;
  return (
    <div className="feature-brief">
      <button className="btn btn-ghost btn-sm feature-brief-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? "▾" : "▸"} {brief.tasks.length} task{brief.tasks.length === 1 ? "" : "s"}
        {flagged > 0 ? ` · ${flagged} flagged` : ""}
        {brief.spend && (brief.spend.costUsd != null ? ` · ${fmtCost(brief.spend.costUsd)}` : ` · ${fmtNum(brief.spend.inputTokens + brief.spend.outputTokens)} tok`)}
      </button>
      {open && (
        <div className="feature-brief-body">
          {brief.narrative && <p className="feature-brief-narrative">{brief.narrative}</p>}
          {brief.evidenceSummary.length > 0 && (
            <ul className="feature-brief-evidence">
              {brief.evidenceSummary.map((line, i) => <li key={i}>{line}</li>)}
            </ul>
          )}
          <ul className="feature-brief-tasks">
            {brief.tasks.map((t) => (
              <li key={t.taskId} className={t.verdict === "flag" ? "feature-brief-flagged" : undefined}>
                <span className="feature-brief-task-mark">{t.verdict === "flag" ? "⚑" : t.verdict === "approve" ? "✓" : "·"}</span>
                {t.text}
                {t.reviewedBy && <span className="feature-brief-reviewer mono"> — {t.reviewedBy}</span>}
              </li>
            ))}
          </ul>
          {brief.spend && (
            <p className="feature-brief-spend mono">
              {brief.spend.costUsd != null ? fmtCost(brief.spend.costUsd) : "cost unreported"}
              {" · "}{fmtNum(brief.spend.inputTokens)} in / {fmtNum(brief.spend.outputTokens)} out{" · "}{brief.spend.turns} turn{brief.spend.turns === 1 ? "" : "s"}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// Feature-scoped branch batching's aggregate PR — one card per completed
// Feature bundling several tasks, instead of one card per task. Same visual
// shape as MergeCard, minus Rework/Update-branch (not supported for a batch —
// a stale/conflicting feature PR surfaces as a normal GitHub conflict on the
// PR itself; changes go through a follow-up task under the same feature).
function FeatureMergeCard({ feature, taskNames }: { feature: Feature; taskNames: string[] }) {
  const { mergeFeaturePr, dismissFeaturePr, fleet, projects } = useStore();
  const pr = feature.pr!;
  const b = pr.briefing;
  const rec = REC_META[b?.recommendation ?? "hold"] ?? REC_META.hold!;
  const [busy, setBusy] = useState<null | string>(null);
  const [blocked, setBlocked] = useState<{ reason: string; kind?: "conflict" | "checks" | "protection" } | null>(null);
  const checks = usePrChecksStatus(() => api.fetchFeaturePrChecks(feature.id));

  const doMerge = async () => {
    setBusy("merge");
    setBlocked(null);
    try {
      const res = await mergeFeaturePr(feature.id, "squash");
      if (!res.merged) setBlocked({ reason: res.reason ?? "GitHub blocked the merge.", kind: res.blocked });
    } catch (e) {
      setBlocked({ reason: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className="qcard">
      <div className="qcard-head">
        <span className="kind-chip" style={{ color: rec.color, borderColor: rec.color }}>{rec.label}</span>
        {b && <RiskChip risk={b.risk} />}
        <PrChecksBadge status={checks.status} onRefresh={checks.reload} />
        <span className="qcard-project" title="Project">{projectName(feature.projectId, projects)}</span>
        <span className="qcard-agent">{feature.name}</span>
        <a className="merge-prlink mono" href={pr.url} target="_blank" rel="noreferrer" title="Open the pull request on GitHub">
          #{pr.number} ↗
        </a>
      </div>

      <h3 className="qcard-title">{b?.summary ?? `${feature.name} — ready to merge`}</h3>
      <p className="merge-branch">
        {taskNames.length} task{taskNames.length === 1 ? "" : "s"} batched: {taskNames.join(", ")}
      </p>
      {checks.status && checks.status !== "loading" && checks.status.runs.length > 0 && (
        <div className="merge-gate-results">
          <span className="qcard-flags-label mono">Gate results</span>
          <CheckRunList runs={checks.status.runs} />
        </div>
      )}
      {b && <MergeBriefingDetail b={b} fleet={fleet} />}
      {b?.featureBrief && <FeatureBriefDetail brief={b.featureBrief} />}
      <p className="merge-branch mono">{pr.branch} → {pr.base} · <a href={pr.url} target="_blank" rel="noreferrer">view diff on GitHub ↗</a></p>

      <div className="qcard-actions">
        <button className="btn btn-primary" disabled={busy != null} onClick={doMerge}>
          {busy === "merge" ? "Merging…" : "Merge"}
        </button>
        <button className="btn btn-ghost" disabled={busy != null} onClick={() => dismissFeaturePr(feature.id)} title="Set aside — hide from this list; the PR stays open on GitHub">
          No-op
        </button>
      </div>

      {blocked && <p className="merge-blocked">⚠ {blocked.reason}</p>}
    </article>
  );
}

export function MergesView({ onOpenTask }: { onOpenTask: (id: string) => void }) {
  const { runs, features, tasks } = useStore();
  const ready = readyMerges(runs);
  const readyFeatures = readyFeatureMerges(features);

  return (
    <section className="queue">
      <div className="vw-head">
        <h1>Ready to merge</h1>
        <p>
          PRs an AI reviewer approved and opened — the final merge is yours. Merge, send back for
          rework, or set aside. Skynet never auto-merges to your base branch.
        </p>
      </div>
      {ready.length === 0 && readyFeatures.length === 0 ? (
        <div className="queue-empty">
          <span className="queue-empty-mark">✓</span>
          <p>No PRs waiting — nothing to merge right now.</p>
        </div>
      ) : (
        <div className="queue-list">
          {readyFeatures.map((f) => (
            <FeatureMergeCard key={f.id} feature={f} taskNames={tasks.filter((t) => t.featureId === f.id && !t.archived).map((t) => t.text)} />
          ))}
          {ready.map((r) => (
            <MergeCard key={r.id} run={r} onOpenTask={onOpenTask} />
          ))}
        </div>
      )}
    </section>
  );
}
