import type { ReactNode } from "react";
import type { HitlItem } from "@skynet/shared";

// The context an operator needs to decide on a HITL gate, laid out plainly:
//   • Working on   — the task/run the agent is doing (intent)
//   • What runs    — the concrete action to allow (the command / edit)
//   • Change       — a diff summary (for diff-review gates)
//   • Agent's reason — the agent's OWN stated reasoning for this action (q.rationale)
//   • Why you're asked — the system's impact/risk framing (q.why)
// Rendered in both the run-detail blocked banner and the queue card.
export function HitlContext({ q, runName }: { q: HitlItem; runName?: string }) {
  const rows: Array<{ label: string; value: ReactNode; cls?: string }> = [];
  if (runName) rows.push({ label: "Working on", value: runName });
  if (q.command)
    rows.push({
      label: q.kind === "approval" ? "What runs" : "Details",
      value: <pre className="hitl-ctx-cmd mono">{q.command}</pre>,
      cls: "hitl-ctx-what",
    });
  if (q.diff)
    rows.push({
      label: "Change",
      value: (
        <span className="mono">
          +{q.diff.add} −{q.diff.del} · {q.diff.modules.join(", ") || "—"}
        </span>
      ),
    });
  if (q.rationale) rows.push({ label: "Agent's reason", value: q.rationale, cls: "hitl-ctx-reason" });
  if (q.why) rows.push({ label: "Why you're asked", value: q.why });

  if (rows.length === 0) return null;
  return (
    <div className="hitl-ctx">
      {rows.map((r, i) => (
        <div key={i} className={"hitl-ctx-row" + (r.cls ? " " + r.cls : "")}>
          <span className="hitl-ctx-label">{r.label}</span>
          <span className="hitl-ctx-val">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

/** A small severity chip for a gate's risk level. */
export function RiskChip({ risk }: { risk: HitlItem["risk"] }) {
  return <span className={"risk-chip risk-" + risk}>{risk} risk</span>;
}
