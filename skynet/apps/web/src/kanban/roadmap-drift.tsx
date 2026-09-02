// ─── Roadmap drift dashboard (Phase 28 — TASK 31) ───────────────────────────
// Promise vs. measured delivery, per roadmap line — a new mode inside the
// Roadmap tab (project-roadmap.tsx), rendering roadmap-drift-metrics.ts's
// pure math. Fetches its own tasks/transitions the same lazy,
// fetch-once-then-merge-live way health.tsx does — only paid for when this
// mode is actually open.
import { useEffect, useMemo, useState } from "react";
import type { Project, RoadmapDoc, Task, Transition } from "@skynet/shared";
import * as api from "../lib/client";
import { useStore } from "../lib/store";
import {
  driftRows,
  roadmapHealthMetrics,
  oneDecision,
  type DriftRow,
  type DriftVerdict,
} from "./roadmap-drift-metrics";

const DAY_MS = 24 * 60 * 60 * 1000;

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function fmtWeeksLate(lateDays: number): string {
  const weeks = Math.max(1, Math.round(lateDays / 7));
  return `+${weeks} week${weeks === 1 ? "" : "s"} late`;
}

const VERDICT_CLASS: Record<DriftVerdict, string> = {
  "landed early": "rdd-verdict-early",
  "on the date": "rdd-verdict-ontime",
  "cut or re-date": "rdd-verdict-late",
  "write the brief": "rdd-verdict-brief",
  "no date yet": "rdd-verdict-none",
};

// ─── one drift row ─────────────────────────────────────────────────────────
// The track's two layers use independent units on the SAME 0–100% width:
// the lime/blue fill is task-completion fraction (delivered/in-flight % of
// the line's own linked tasks); the promise tick + forecast bar are a
// separate calendar-time axis (a fixed 90d lookback through whichever of
// {promise, forecast, today} sits furthest out), so a line whose work is
// half done but way behind schedule shows BOTH honestly at once.
function RowTrack({ row, now }: { row: DriftRow; now: number }) {
  const { forecast, line } = row;

  if (!forecast.forecastable) {
    return (
      <div className="rdd-track rdd-track-unforecastable">
        <span className="rdd-track-unforecastable-label">no linked tasks — nothing to forecast</span>
      </div>
    );
  }

  const promisedDate = line.promisedDate;
  const windowStart = now - 90 * DAY_MS;
  const windowEnd = Math.max(promisedDate ?? now, forecast.etaAt ?? now, now) + 7 * DAY_MS;
  const span = Math.max(1, windowEnd - windowStart);
  const pctAt = (t: number) => Math.min(100, Math.max(0, ((t - windowStart) / span) * 100));

  const showForecastBar = forecast.etaAt != null && forecast.doneTasks < forecast.totalTasks;
  const late = promisedDate != null && showForecastBar && forecast.etaAt! > promisedDate;

  return (
    <div className="rdd-track">
      <div className="rdd-track-fill rdd-track-delivered" style={{ width: `${forecast.deliveredPct}%` }} />
      <div
        className="rdd-track-fill rdd-track-inflight"
        style={{ left: `${forecast.deliveredPct}%`, width: `${forecast.inFlightPct}%` }}
      />
      {promisedDate != null && (
        <div
          className="rdd-track-tick"
          style={{ left: `${pctAt(promisedDate)}%` }}
          title={`Promised ${fmtDate(promisedDate)}`}
        />
      )}
      {showForecastBar && (
        <div
          className={"rdd-track-forecast" + (late ? " rdd-track-forecast-late" : "")}
          style={{ left: `${pctAt(now)}%`, width: `${Math.max(0, pctAt(forecast.etaAt!) - pctAt(now))}%` }}
        >
          {late && row.lateDays != null && <span className="rdd-track-forecast-label">{fmtWeeksLate(row.lateDays)}</span>}
        </div>
      )}
    </div>
  );
}

function DriftTableRow({ row, now }: { row: DriftRow; now: number }) {
  const { line, forecast } = row;
  // Item 21 — the track's lime/blue segments are color-only; this restates
  // the exact same delivered/in-flight split as text on the same row, never
  // relying on the color alone to carry that information.
  const todoTasks = forecast.forecastable ? forecast.totalTasks - forecast.doneTasks - forecast.inFlightTasks : 0;
  const fact = !forecast.forecastable
    ? "no tasks linked"
    : `${forecast.doneTasks} done${forecast.inFlightTasks > 0 ? `, ${forecast.inFlightTasks} in flight` : ""}${todoTasks > 0 ? `, ${todoTasks} todo` : ""} of ${forecast.totalTasks}` +
      (line.promisedDate != null ? ` · promised ${fmtDate(line.promisedDate)}` : "");
  return (
    <div className="rdd-row">
      <div className="rdd-row-label">
        <div className="rdd-row-title">{line.text}</div>
        <div className="rdd-row-fact mono">{fact}</div>
      </div>
      <RowTrack row={row} now={now} />
      <div className={"rdd-row-verdict " + VERDICT_CLASS[row.verdict]}>{row.verdict}</div>
    </div>
  );
}

// ─── ROADMAP HEALTH panel ───────────────────────────────────────────────────
function RoadmapHealthPanel({ metrics }: { metrics: ReturnType<typeof roadmapHealthMetrics> }) {
  const thinLines = metrics.totalLines - metrics.linesWithTasks;
  return (
    <div className="rdd-panel">
      <div className="rdd-panel-title">Roadmap health</div>
      <div className="rdd-health-stats">
        <div className="rdd-health-stat">
          <span className="rdd-health-stat-value">{metrics.linesWithTasks}/{metrics.totalLines}</span>
          <span className="rdd-health-stat-label">lines with linked tasks</span>
        </div>
        <div className="rdd-health-stat">
          <span className="rdd-health-stat-value">{metrics.linesWithCriteria}/{metrics.totalLines}</span>
          <span className="rdd-health-stat-label">lines with acceptance criteria</span>
        </div>
        <div className="rdd-health-stat">
          <span className="rdd-health-stat-value">{metrics.staleLines.length}</span>
          <span className="rdd-health-stat-label">stale &gt;30d</span>
        </div>
      </div>
      <p className="rdd-panel-reading">
        {thinLines > 0
          ? `${thinLines} line${thinLines === 1 ? "" : "s"} still have no linked task at all — thin lines are the bottleneck: a promise with nothing tracking it is where drift starts.`
          : "Every line has at least one linked task — the roadmap's promises are all grounded in tracked work."}
      </p>
    </div>
  );
}

// ─── ORPHANS panel ───────────────────────────────────────────────────────────
function OrphansPanel({
  orphanTasks,
  project,
  doc,
  onProposed,
}: {
  orphanTasks: Task[];
  project: Project;
  doc: RoadmapDoc;
  onProposed: () => void;
}) {
  const { fleet } = useStore();
  const projectAgents = fleet.filter((a) => a.workspaceId === project.workspaceId);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const propose = async () => {
    const agent = projectAgents[0];
    if (!agent || orphanTasks.length === 0) return;
    setBusy(true);
    setErr(null);
    // The preamble section (or the first real section if the doc has none) —
    // a reasonable default landing spot; a human reviewing the resulting
    // Inbox card can always redirect it via "EDIT THE WORDING FIRST".
    const section = doc.sections[0]?.id ?? "";
    const added = orphanTasks.map((t) => `- [ ] **${t.text}** (linked task, no roadmap line yet)`);
    try {
      await api.proposeRoadmapChange(project.id, {
        agentId: agent.id,
        section,
        headline: `Cover ${orphanTasks.length} orphan task${orphanTasks.length === 1 ? "" : "s"} with a roadmap line`,
        diff: { added, removed: [], context: "" },
        reasoning: `${orphanTasks.length} task${orphanTasks.length === 1 ? "" : "s"} in this project have no roadmap line pointing at them — proposing a line for each so the roadmap reflects the real work in flight.`,
        respectedBoundaries: ["only adding new lines — nothing existing was touched or removed"],
      });
      onProposed();
    } catch (e) {
      setErr((e as Error)?.message || "Couldn't propose those lines — try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rdd-panel">
      <div className="rdd-panel-title">Orphans</div>
      {orphanTasks.length === 0 ? (
        <div className="rdd-panel-empty">Every task in this project is linked from a roadmap line.</div>
      ) : (
        <>
          <ul className="rdd-orphan-list">
            {orphanTasks.slice(0, 8).map((t) => (
              <li key={t.id} className="rdd-orphan-row">
                <span className="rdd-orphan-title">{t.text}</span>
                <span className="rdd-orphan-origin mono">{t.state}</span>
              </li>
            ))}
            {orphanTasks.length > 8 && <li className="rdd-orphan-more">+{orphanTasks.length - 8} more</li>}
          </ul>
          <button
            className="btn btn-primary btn-sm"
            disabled={busy || projectAgents.length === 0}
            title={projectAgents.length === 0 ? "This project has no fleet agent configured to attribute the proposal to." : undefined}
            onClick={propose}
          >
            {busy ? "Proposing…" : `Propose ${orphanTasks.length} roadmap line${orphanTasks.length === 1 ? "" : "s"} to cover these`}
          </button>
          {err && <div className="rdd-panel-err">{err}</div>}
        </>
      )}
    </div>
  );
}

// ─── ONE DECISION panel ──────────────────────────────────────────────────────
function OneDecisionPanel({
  decision,
  project,
  onCommitted,
}: {
  decision: ReturnType<typeof oneDecision>;
  project: Project;
  onCommitted: () => void;
}) {
  const [busy, setBusy] = useState<"q4" | "redate" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (!decision) {
    return (
      <div className="rdd-panel">
        <div className="rdd-panel-title">One decision would fix the quarter</div>
        <div className="rdd-panel-empty">Nothing is currently forecast to miss its promised date.</div>
      </div>
    );
  }

  const { row, lateDays, blockingTaskCount } = decision;
  const raw = row.line.raw;
  const lateText = lateDays >= 3650 ? "stalled with no recent progress at all" : fmtWeeksLate(lateDays);

  const commit = async (kind: "q4" | "redate") => {
    setBusy(kind);
    setErr(null);
    const newDateLabel = kind === "q4" ? "Q4 2026" : "Q3 2026 (re-dated)";
    const newLine = `${raw.replace(/\n+$/, "")} — promised: ${newDateLabel}\n`;
    try {
      await api.commitRoadmapLineEdit(project.id, {
        diff: { added: [newLine], removed: [raw], context: raw },
        message: `Skynet: ${kind === "q4" ? "move" : "re-date"} "${row.line.text}" (Drift dashboard)`,
      });
      onCommitted();
    } catch (e) {
      setErr((e as Error)?.message || "Couldn't commit that change — try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rdd-panel rdd-panel-decision">
      <div className="rdd-panel-title">One decision would fix the quarter</div>
      <p className="rdd-panel-reading">
        <strong>{row.line.text}</strong> is {lateText}
        {blockingTaskCount > 0 ? ` and blocks ${blockingTaskCount} other task${blockingTaskCount === 1 ? "" : "s"} downstream` : ""} —
        of everything drifting, this is the one call that matters most this quarter.
      </p>
      <div className="rdd-decision-actions">
        <button className="btn btn-primary btn-sm" disabled={busy != null} onClick={() => commit("q4")}>
          {busy === "q4" ? "Committing…" : "Move it to Q4"}
        </button>
        <button className="btn btn-ghost btn-sm" disabled={busy != null} onClick={() => commit("redate")}>
          {busy === "redate" ? "Committing…" : "Keep and re-date Q3"}
        </button>
      </div>
      {err && <div className="rdd-panel-err">{err}</div>}
    </div>
  );
}

// ─── shell ───────────────────────────────────────────────────────────────────
export function RoadmapDrift({ project, doc, tasks }: { project: Project; doc: RoadmapDoc; tasks: Task[] }) {
  const { transitions: liveTransitions } = useStore();
  const [fetchedTransitions, setFetchedTransitions] = useState<Transition[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    api
      .fetchProjectTransitions(project.id, { limit: 5000 })
      .then((t) => { if (live) setFetchedTransitions(t); })
      .catch(() => undefined)
      .finally(() => { if (live) setLoading(false); });
    return () => {
      live = false;
    };
  }, [project.id]);

  const transitions = useMemo(() => {
    const byId = new Map(fetchedTransitions.map((t) => [t.id, t]));
    for (const t of liveTransitions) if (t.projectId === project.id) byId.set(t.id, t);
    return [...byId.values()];
  }, [fetchedTransitions, liveTransitions, project.id]);

  const now = Date.now();
  const projectTasks = useMemo(() => tasks.filter((t) => t.projectId === project.id), [tasks, project.id]);
  const rows = useMemo(() => driftRows(doc, projectTasks, transitions, now), [doc, projectTasks, transitions, now]);
  const metrics = useMemo(() => roadmapHealthMetrics(doc, projectTasks, transitions, now), [doc, projectTasks, transitions, now]);
  const decision = useMemo(() => oneDecision(rows, projectTasks), [rows, projectTasks]);

  // Same event RoadmapSource's own save dispatches (project-roadmap.tsx
  // listens for it and refetches the doc + proposals) — a propose/commit
  // here is just another roadmap write, so it reflects the same way.
  const refresh = () => window.dispatchEvent(new CustomEvent("skynet:roadmap-updated", { detail: { projectId: project.id } }));

  if (loading) return <div className="kb-empty">Loading drift…</div>;
  if (rows.length === 0) return <div className="kb-empty">No roadmap lines to measure drift against yet.</div>;

  return (
    <div className="rdd">
      <div className="rdd-table">
        <div className="rdd-row rdd-row-head">
          <div className="rdd-row-label">Line</div>
          <div>Delivery</div>
          <div className="rdd-row-verdict">Verdict</div>
        </div>
        {rows.map((row) => <DriftTableRow key={row.line.id} row={row} now={now} />)}
      </div>
      <div className="rdd-panels">
        <RoadmapHealthPanel metrics={metrics} />
        <OrphansPanel orphanTasks={metrics.orphanTasks} project={project} doc={doc} onProposed={refresh} />
        <OneDecisionPanel decision={decision} project={project} onCommitted={refresh} />
      </div>
    </div>
  );
}
