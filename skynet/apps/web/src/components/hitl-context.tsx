import type { ReactNode } from "react";
import type { HitlItem } from "@skynet/shared";
import { DiffView } from "./diff-view";

// The context an operator needs to decide on a HITL gate, laid out plainly:
//   • Working on   — the task/run the agent is doing (intent)
//   • What runs    — the concrete action to allow (the command / edit)
//   • Agent's reason — the agent's OWN stated reasoning for this action (q.rationale)
//   • Why you're asked — the system's impact/risk framing (q.why)
//   • The real diff — for diff/merge gates, the actual change (lazily fetched)
// Rendered in both the run-detail blocked banner and the queue card.
export function HitlContext({ q, runName, openDiff = false }: { q: HitlItem; runName?: string; openDiff?: boolean }) {
  const rows: Array<{ label: string; value: ReactNode; cls?: string }> = [];
  if (runName) rows.push({ label: "Working on", value: runName });
  if (q.command)
    rows.push({
      label: q.kind === "approval" ? "What runs" : "Details",
      value: <pre className="hitl-ctx-cmd mono">{q.command}</pre>,
      cls: "hitl-ctx-what",
    });
  if (q.rationale) rows.push({ label: "Agent's reason", value: q.rationale, cls: "hitl-ctx-reason" });
  if (q.why) rows.push({ label: "Why you're asked", value: q.why });

  const showDiff = !!q.diff && (q.kind === "diff" || q.kind === "merge");
  if (rows.length === 0 && !showDiff) return null;
  return (
    <div className="hitl-ctx">
      {rows.map((r, i) => (
        <div key={i} className={"hitl-ctx-row" + (r.cls ? " " + r.cls : "")}>
          <span className="hitl-ctx-label">{r.label}</span>
          <span className="hitl-ctx-val">{r.value}</span>
        </div>
      ))}
      {showDiff && q.diff && (
        <div className="hitl-ctx-row hitl-ctx-diff">
          <span className="hitl-ctx-label">Change</span>
          <span className="hitl-ctx-val">
            <DiffView runId={q.runId} add={q.diff.add} del={q.diff.del} defaultOpen={openDiff} />
          </span>
        </div>
      )}
    </div>
  );
}

/** A small severity chip for a gate's risk level. */
export function RiskChip({ risk }: { risk: HitlItem["risk"] }) {
  return <span className={"risk-chip risk-" + risk}>{risk} risk</span>;
}
