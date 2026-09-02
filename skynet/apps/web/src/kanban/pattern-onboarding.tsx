// ─── Pattern-spotted automation onboarding (Momentum Rollout Phase 8 — TASK 10) ─
// Closes the loop: a repeated MANUAL move (rules/engine.ts's
// sweepPatternDetection) becomes a `suggested_rule` Proposal instead of
// staying tribal knowledge. This renders that proposal as a 480px "pattern
// spotted" card — reusing rules.tsx's read-only rule-summary helpers and its
// BacktestCard verbatim (no separate chip component exists anywhere in the
// app; see rules.tsx's own export comments) — with three actions:
//   TURN IT ON  → accept + activate (rule created state:"live")
//   WATCH FIRST → accept, default (rule created state:"watch")
//   NEVER       → dismiss (the dismissed Proposal row IS the suppression
//                 record the detector checks before re-proposing the same
//                 {from,to} pattern — see dismissProposal's own doc comment)
import { useMemo, useState } from "react";
import type { Project, Proposal } from "@skynet/shared";
import { SuggestedRulePayload } from "@skynet/shared";
import { useStore } from "../lib/store";
import { BacktestCard, RULE_STATE_META, describeAction, describeCondition } from "./rules";
import { Chip } from "./primitives";

function PatternSpottedCard({ project, proposal }: { project: Project; proposal: Proposal }) {
  const { acceptProposal, dismissProposal } = useStore();
  const [busy, setBusy] = useState<"on" | "watch" | "never" | null>(null);

  const parsed = useMemo(() => SuggestedRulePayload.safeParse(proposal.payload), [proposal.payload]);

  const turnOn = async () => {
    setBusy("on");
    try {
      await acceptProposal(project.id, proposal.id, { activate: true });
    } finally {
      setBusy(null);
    }
  };
  const watchFirst = async () => {
    setBusy("watch");
    try {
      await acceptProposal(project.id, proposal.id);
    } finally {
      setBusy(null);
    }
  };
  const never = async () => {
    setBusy("never");
    try {
      await dismissProposal(project.id, proposal.id);
    } finally {
      setBusy(null);
    }
  };

  if (!parsed.success) return null; // a corrupt/foreign payload — never crash the tab over one bad row

  const { name, conditions, actions, safety, detected } = parsed.data;
  const undoWindowMin = safety?.undoWindowMin ?? 10;

  return (
    <div className="pso-card">
      <div className="pso-card-head">
        <span className="pso-card-title">Pattern spotted</span>
        <Chip label={RULE_STATE_META.watch.label} tone={RULE_STATE_META.watch.tone} />
      </div>
      <p className="pso-name">{name}</p>
      <div className="pso-chips">
        {conditions.map((c, i) => (
          <span key={`c${i}`} className="pso-chip pso-chip-condition">{describeCondition(c)}</span>
        ))}
        {actions.map((a, i) => (
          <span key={`a${i}`} className="pso-chip pso-chip-action">{describeAction(a)}</span>
        ))}
      </div>
      {detected && (
        <div className="pso-stats mono">
          {Math.round(detected.matchRate * 100)}% match rate · {detected.matchCount} time{detected.matchCount === 1 ? "" : "s"} in {detected.windowDays}d ·
          {" "}~{detected.estimatedMinutesSavedPerMonth}min/mo saved · {undoWindowMin}min undo window
        </div>
      )}
      <BacktestCard project={project} conditions={conditions} actions={actions} />
      <div className="pso-actions">
        <button className="btn btn-primary btn-sm" disabled={busy !== null} onClick={() => void turnOn()}>
          {busy === "on" ? "Turning on…" : "Turn it on"}
        </button>
        <button className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => void watchFirst()}>
          {busy === "watch" ? "Starting…" : "Watch first"}
        </button>
        <button className="btn btn-ghost btn-sm pso-never" disabled={busy !== null} onClick={() => void never()}>
          {busy === "never" ? "…" : "Never"}
        </button>
      </div>
    </div>
  );
}

/** The "pattern spotted" section — every pending suggested_rule Proposal for
 *  this project, newest first. Renders nothing (not even an empty state) when
 *  there's nothing pending, so it never clutters the Rules tab for a project
 *  the detector hasn't found anything in yet. */
export function PatternSpottedSection({ project }: { project: Project }) {
  const { proposals } = useStore();
  const pending = useMemo(
    () =>
      proposals
        .filter((p) => p.projectId === project.id && p.kind === "suggested_rule" && p.status === "pending")
        .sort((a, b) => b.createdAt - a.createdAt),
    [proposals, project.id],
  );
  if (pending.length === 0) return null;

  return (
    <div className="pso-section">
      {pending.map((p) => (
        <PatternSpottedCard key={p.id} project={project} proposal={p} />
      ))}
    </div>
  );
}
