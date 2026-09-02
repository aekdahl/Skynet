// ─── Board Health dashboard (Momentum Rollout Phase 7 — TASK 09) ──────────
// A read-only dashboard proving the automation is trustworthy — no new
// backend inputs; everything here is derived from Task + Transition + Rule
// data already exposed by TASK 03 (see health-metrics.ts for the actual
// math, kept pure/testable and separate from this rendering layer).
import { useEffect, useMemo, useState } from "react";
import type { Project, Task, Transition } from "@skynet/shared";
import * as api from "../lib/client";
import { useStore } from "../lib/store";
import { fmtDurMs } from "../lib/derive";
import {
  automationRate,
  cycleTimeMedianMs,
  stalledTasks,
  forecastBacklogClear,
  medianTimePerBucket,
  rulePerformance,
  type ColumnBucketId,
} from "./health-metrics";

const BUCKET_LABEL: Record<ColumnBucketId, string> = {
  intake: "Intake",
  queued: "Queued",
  in_flight: "In Flight",
  landed: "Landed",
};

function fmtDur(ms: number | null): string {
  return ms == null ? "—" : fmtDurMs(ms);
}
function fmtPct(pct: number | null): string {
  return pct == null ? "—" : `${pct}%`;
}
function fmtDays(days: number | null): string {
  if (days == null) return "—";
  return days < 1 ? "<1" : String(Math.round(days));
}

export function BoardHealth({
  project,
  tasks,
  now,
  onOpenTask,
}: {
  project: Project;
  tasks: Task[];
  now: number;
  onOpenTask: (id: string) => void;
}) {
  const { rules, transitions: liveTransitions } = useStore();

  // Same fetch-once-then-merge-live pattern as board.tsx — Snapshot doesn't
  // carry historical transitions (store.tsx), and Health needs the FULL
  // history (cycle time / per-bucket time / the forecast's trailing windows
  // all reach back further than the live session has been connected), so a
  // generous limit, not board.tsx's 500.
  const [fetchedTransitions, setFetchedTransitions] = useState<Transition[]>([]);
  // TASK 13 hardening — every stat below is computed over `transitions`;
  // without this, "still loading" and "genuinely no history" both rendered
  // identically (a confident-looking 0%/— set of stats), silently
  // understating a project that just hasn't finished its initial fetch yet.
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    setLoading(true);
    api.fetchProjectTransitions(project.id, { limit: 5000 })
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

  const projectTasks = useMemo(() => tasks.filter((t) => t.projectId === project.id && !t.archived), [tasks, project.id]);
  const projectRules = useMemo(() => rules.filter((r) => r.projectId === project.id && !r.archived), [rules, project.id]);

  const automation = useMemo(() => automationRate(transitions, now), [transitions, now]);
  const cycle = useMemo(() => cycleTimeMedianMs(transitions), [transitions]);
  const stalled = useMemo(() => stalledTasks(projectTasks, transitions, now), [projectTasks, transitions, now]);
  const forecast = useMemo(() => forecastBacklogClear(projectTasks, transitions, now), [projectTasks, transitions, now]);
  const perBucket = useMemo(() => medianTimePerBucket(transitions), [transitions]);
  const rulesPerf = useMemo(() => rulePerformance(projectRules), [projectRules]);

  if (loading) {
    return (
      <div className="hd-health" aria-busy="true">
        <div className="hd-grid">
          {Array.from({ length: 4 }, (_, i) => <HealthCardSkeleton key={i} />)}
        </div>
        <div className="hd-grid hd-second-row">
          <HealthCardSkeleton wide />
          <HealthCardSkeleton wide />
        </div>
      </div>
    );
  }

  return (
    <div className="hd-health">
      <div className="hd-grid">
        {/* ── Top row: repeat(4,1fr) ── */}
        <StatCard
          label="Automated"
          hint="Machine-driven transitions ÷ all transitions, last 7 days"
          value={fmtPct(automation.pct)}
          sub={automation.totalCount > 0 ? `${automation.machineCount} of ${automation.totalCount} transitions` : "No transitions in the last 7d"}
        />
        <StatCard
          label="Cycle time"
          hint="Median time from first queued to first landed, per task"
          value={fmtDur(cycle.medianMs)}
          sub={cycle.sampleSize > 0 ? `${cycle.sampleSize} task${cycle.sampleSize === 1 ? "" : "s"}` : "No completed cycles yet"}
        />
        <StalledPanel stalled={stalled} onOpenTask={onOpenTask} />
        <ForecastCard forecast={forecast} />
      </div>
      <div className="hd-grid hd-second-row">
        <BucketTimeChart perBucket={perBucket} />
        <RuleTable rulesPerf={rulesPerf} />
      </div>
    </div>
  );
}

function HealthCardSkeleton({ wide }: { wide?: boolean }) {
  return (
    <div className={"hd-card" + (wide ? " hd-span-2" : "")}>
      <span className="ak-skel-row" style={{ width: "50%", height: 11 }} />
      <span className="ak-skel-row" style={{ width: "35%", height: 28 }} />
      <span className="ak-skel-row" style={{ width: "70%" }} />
    </div>
  );
}

function StatCard({ label, hint, value, sub }: { label: string; hint: string; value: string; sub: string }) {
  return (
    <div className="hd-card">
      <div className="hd-card-label" title={hint}>{label}</div>
      <div className="hd-card-value">{value}</div>
      <div className="hd-card-sub">{sub}</div>
    </div>
  );
}

function StalledPanel({
  stalled,
  onOpenTask,
}: {
  stalled: ReturnType<typeof stalledTasks>;
  onOpenTask: (id: string) => void;
}) {
  return (
    <div className={"hd-card hd-stalled" + (stalled.length > 0 ? " hd-stalled-active" : "")}>
      <div className="hd-card-label">Stalled &gt;48h</div>
      <div className="hd-card-value hd-stalled-count">{stalled.length}</div>
      {stalled.length === 0 ? (
        <div className="hd-card-sub">No tasks stalled past 48h.</div>
      ) : (
        <ul className="hd-stalled-list">
          {stalled.slice(0, 5).map(({ task, staleMs }) => (
            <li key={task.id}>
              <button className="hd-stalled-row" onClick={() => onOpenTask(task.id)}>
                <span className="hd-stalled-title">{task.text}</span>
                <span className="hd-stalled-time">{fmtDurMs(staleMs)}</span>
              </button>
            </li>
          ))}
          {stalled.length > 5 && <li className="hd-stalled-more">+{stalled.length - 5} more</li>}
        </ul>
      )}
    </div>
  );
}

function ForecastCard({ forecast }: { forecast: ReturnType<typeof forecastBacklogClear> }) {
  const canProject = forecast.daysEstimate != null;
  return (
    <div className="hd-card">
      <div className="hd-card-label" title="Linear projection from the trailing landing rate — a directional estimate, not a commitment">
        Backlog forecast
      </div>
      {canProject ? (
        <>
          <div className="hd-card-value">~{fmtDays(forecast.daysEstimate)}d</div>
          <div className="hd-card-sub">
            {fmtDays(forecast.daysLow)}–{fmtDays(forecast.daysHigh)}d band · {forecast.backlogCount} open
          </div>
        </>
      ) : (
        <>
          <div className="hd-card-value hd-forecast-unknown">—</div>
          <div className="hd-card-sub">No recent landings to project from ({forecast.backlogCount} open)</div>
        </>
      )}
    </div>
  );
}

function BucketTimeChart({ perBucket }: { perBucket: ReturnType<typeof medianTimePerBucket> }) {
  const buckets: ColumnBucketId[] = ["intake", "queued", "in_flight", "landed"];
  const maxMs = Math.max(1, ...buckets.map((b) => perBucket[b].medianMs ?? 0));
  return (
    <div className="hd-card hd-span-2">
      <div className="hd-card-label" title="Median completed-stay duration per column — open/current stays aren't counted">
        Where work actually waits
      </div>
      <div className="hd-bars">
        {buckets.map((b) => {
          const { medianMs, sampleSize } = perBucket[b];
          const pct = medianMs != null ? Math.max(4, Math.round((medianMs / maxMs) * 100)) : 0;
          return (
            <div className="hd-bar-col" key={b}>
              <div className="hd-bar-track">
                <div className="hd-bar-fill" style={{ height: `${pct}%` }} title={sampleSize > 0 ? `${fmtDurMs(medianMs!)} median (${sampleSize})` : "no completed stays"} />
              </div>
              <div className="hd-bar-value">{fmtDur(medianMs)}</div>
              <div className="hd-bar-label">{BUCKET_LABEL[b]}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RuleTable({ rulesPerf }: { rulesPerf: ReturnType<typeof rulePerformance> }) {
  return (
    <div className="hd-card hd-span-2">
      <div className="hd-card-label">Rule performance</div>
      {rulesPerf.length === 0 ? (
        <div className="hd-card-sub">No rules on this project yet.</div>
      ) : (
        <div className="hd-rule-table">
          <div className="hd-rule-row hd-rule-head">
            <span>Rule</span>
            <span>Moves</span>
            <span>Undos</span>
            <span>Undo rate</span>
          </div>
          {rulesPerf.map(({ rule, undoRate, flagged, flagReason }) => (
            <div className={"hd-rule-row" + (flagged ? " hd-rule-flagged" : "")} key={rule.id}>
              <span className="hd-rule-name">
                {flagged && <span className="hd-rule-flag-dot" aria-hidden="true" />}
                {rule.name}
              </span>
              <span>{rule.stats.moves}</span>
              <span>{rule.stats.undos}</span>
              <span className={flagged ? "hd-rule-rate-flagged" : undefined}>
                {undoRate == null ? "—" : `${Math.round(undoRate * 100)}%`}
                {flagged && (
                  <span className="hd-rule-flag-label">
                    {flagReason === "auto-paused" ? " · auto-paused" : " · high undo rate"}
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
