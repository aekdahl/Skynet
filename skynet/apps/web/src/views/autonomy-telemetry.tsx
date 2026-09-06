import { useEffect, useState } from "react";
import type { AutonomyDetent, AutonomyTelemetryProjectRow, AutonomyTelemetryRollup } from "@skynet/shared";
import { AUTONOMY_DETENT_INFO } from "@skynet/shared";
import * as api from "../lib/client";
import { fmtDurMs } from "../lib/derive";
import "../kanban/autonomy-telemetry.css";

// Roadmap: "Autonomy telemetry dashboard — ZTMR, HITL volume, resolution
// time, broken down by project and by autonomy detent." A read-only rollup —
// see Operations.getAutonomyTelemetryRollup / autonomy-telemetry-rollup.ts
// for the actual computation and its documented caveats (detent breakdown
// uses each project's CURRENT notch only; ZTMR classifies a merged run by
// its whole gate history, not just the reporting window).

const WINDOW_OPTIONS = [7, 30, 90] as const;

function pct(n: number | null): string {
  return n == null ? "—" : `${Math.round(n * 100)}%`;
}

function ZtmrBadge({ ztmr }: { ztmr: number | null }) {
  if (ztmr == null) return <span className="atd-muted">—</span>;
  const cls = ztmr >= 0.7 ? "atd-badge-lime" : ztmr >= 0.4 ? "atd-badge-amber" : "atd-badge-warn";
  return <span className={`atd-badge ${cls}`}>{pct(ztmr)}</span>;
}

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="atd-tile">
      <div className="atd-tile-label">{label}</div>
      <div className="atd-tile-value">{value}</div>
      {sub && <div className="atd-tile-sub">{sub}</div>}
    </div>
  );
}

function VolumeChart({ series }: { series: AutonomyTelemetryRollup["gateVolumeSeries"] }) {
  if (series.length === 0) return <div className="atd-chart-empty">No gates raised or resolved in this window.</div>;
  const max = Math.max(1, ...series.map((b) => Math.max(b.raised, b.resolved)));
  return (
    <div className="atd-chart">
      {series.map((b) => (
        <div className="atd-chart-col" key={b.bucketStart}>
          <div className="atd-chart-track">
            <div className="atd-chart-bar atd-chart-bar-raised" style={{ height: `${(b.raised / max) * 100}%` }} title={`${b.raised} raised`} />
            <div className="atd-chart-bar atd-chart-bar-resolved" style={{ height: `${(b.resolved / max) * 100}%` }} title={`${b.resolved} resolved`} />
          </div>
          <div className="atd-chart-day">{new Date(b.bucketStart).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</div>
        </div>
      ))}
    </div>
  );
}

function DetentCards({ rows }: { rows: AutonomyTelemetryRollup["byDetent"] }) {
  return (
    <div className="atd-detents">
      {rows.map((row) => (
        <div className="atd-detent-card" key={row.detent}>
          <div className="atd-detent-head">
            <span className="atd-detent-name">{AUTONOMY_DETENT_INFO[row.detent as AutonomyDetent].name}</span>
            <span className="atd-detent-count">{row.projectCount} project{row.projectCount === 1 ? "" : "s"}</span>
          </div>
          <div className="atd-detent-body">
            <div className="atd-detent-stat">
              <span className="atd-detent-stat-label">ZTMR</span>
              <ZtmrBadge ztmr={row.ztmr} />
            </div>
            <div className="atd-detent-stat">
              <span className="atd-detent-stat-label">Gates</span>
              <span>{row.gateRaisedCount} raised / {row.gateResolvedCount} resolved</span>
            </div>
            <div className="atd-detent-stat">
              <span className="atd-detent-stat-label">Avg resolution</span>
              <span>{row.avgResolutionMs != null ? fmtDurMs(row.avgResolutionMs) : "—"}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function ProjectRow({ row }: { row: AutonomyTelemetryProjectRow }) {
  return (
    <tr>
      <td className="atd-repo-name">{row.projectName}</td>
      <td><span className="atd-badge atd-badge-neutral">{AUTONOMY_DETENT_INFO[row.detent].name}</span></td>
      <td>{row.mergedCount}</td>
      <td><ZtmrBadge ztmr={row.ztmr} /></td>
      <td>{row.gateRaisedCount}</td>
      <td>{row.gateResolvedCount}</td>
      <td>{row.avgResolutionMs != null ? fmtDurMs(row.avgResolutionMs) : <span className="atd-muted">—</span>}</td>
      <td>{row.breakerTrips > 0 ? <span className="atd-badge atd-badge-warn">{row.breakerTrips} tripped</span> : <span className="atd-muted">—</span>}</td>
    </tr>
  );
}

export function AutonomyTelemetryView() {
  const [windowDays, setWindowDays] = useState<number>(30);
  const [data, setData] = useState<AutonomyTelemetryRollup | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setErr(null);
    api
      .fetchAutonomyTelemetry(windowDays)
      .then((d) => live && setData(d))
      .catch((e: unknown) => live && setErr((e as Error)?.message || "Couldn't load autonomy telemetry."));
    return () => {
      live = false;
    };
  }, [windowDays]);

  if (err) return <div className="kb-empty">{err}</div>;
  if (!data) return <div className="kb-empty">Loading…</div>;

  if (data.byProject.length === 0) {
    return <div className="kb-empty">No accessible project yet.</div>;
  }

  return (
    <div className="atd">
      <div className="atd-topbar">
        <h2 className="atd-title">Autonomy Telemetry</h2>
        <span className="atd-sub">Zero-touch merge rate, HITL gate volume, and resolution time — last {data.windowDays} days.</span>
        <div className="atd-window-picker">
          {WINDOW_OPTIONS.map((d) => (
            <button key={d} className={`atd-window-btn${windowDays === d ? " atd-window-btn-on" : ""}`} onClick={() => setWindowDays(d)}>
              {d}d
            </button>
          ))}
        </div>
      </div>

      <div className="atd-tiles">
        <StatTile label="Zero-touch merge rate" value={pct(data.totals.ztmr)} sub={`${data.totals.zeroTouchCount} of ${data.totals.mergedCount} merged`} />
        <StatTile label="Gates raised" value={String(data.totals.gateRaisedCount)} sub={`${data.totals.gateResolvedCount} resolved`} />
        <StatTile label="Avg resolution time" value={data.totals.avgResolutionMs != null ? fmtDurMs(data.totals.avgResolutionMs) : "—"} />
        <StatTile label="Breaker trips" value={String(data.totals.breakerTrips)} sub={`${data.totals.breakerLifts} lifted`} />
      </div>

      <div className="atd-section">
        <h3 className="atd-section-title">Gate volume over time</h3>
        <VolumeChart series={data.gateVolumeSeries} />
        <div className="atd-legend">
          <span><i className="atd-legend-dot atd-legend-dot-raised" /> raised</span>
          <span><i className="atd-legend-dot atd-legend-dot-resolved" /> resolved</span>
        </div>
      </div>

      <div className="atd-section">
        <h3 className="atd-section-title">By autonomy detent</h3>
        <DetentCards rows={data.byDetent} />
      </div>

      <div className="atd-section">
        <h3 className="atd-section-title">By project</h3>
        <table className="atd-table">
          <thead>
            <tr>
              <th>PROJECT</th>
              <th>DETENT</th>
              <th>MERGED</th>
              <th>ZTMR</th>
              <th>RAISED</th>
              <th>RESOLVED</th>
              <th>AVG RESOLUTION</th>
              <th>BREAKER</th>
            </tr>
          </thead>
          <tbody>
            {data.byProject.map((row) => (
              <ProjectRow key={row.projectId} row={row} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
