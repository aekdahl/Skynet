import { useEffect, useState } from "react";
import type { RoadmapMilestoneGroup, RoadmapRollupRow, RoadmapWorkspaceRollup } from "@skynet/shared";
import * as api from "../lib/client";
import "../kanban/workspace-roadmap.css";

// Phase 29 (TASK 32) — "six repos, one quarter": a workspace-wide roll-up
// over every project's ROADMAP.md the operator already has access to (the
// server scopes this by the caller's own principal — see
// Operations.getWorkspaceRoadmapRollup's own doc comment; there's nothing to
// filter client-side). Three parts: cross-repo milestone cards (a heading
// shared by 2+ repos), a flat per-repo table, and a dashed "no roadmap file"
// row per unbound project with a one-click scaffold action.
//
// `drift`/`atRiskReason` read whatever real signal exists TODAY — mostly
// "unknown", since TASK 31's per-line forecasts don't populate anything yet
// (see RoadmapDriftVerdict's own doc comment) — never a fabricated verdict.

const SYNC_LABEL: Record<RoadmapRollupRow["syncState"], string> = {
  in_sync: "IN SYNC",
  repo_ahead: "EDITED IN REPO",
  unparseable: "UNPARSEABLE",
};

function SyncBadge({ state }: { state: RoadmapRollupRow["syncState"] }) {
  const cls = state === "in_sync" ? "wrr-badge-lime" : state === "repo_ahead" ? "wrr-badge-amber" : "wrr-badge-warn";
  return <span className={`wrr-badge ${cls}`}>{SYNC_LABEL[state]}</span>;
}

function DriftBadge({ row }: { row: Pick<RoadmapRollupRow, "drift" | "atRiskReason"> }) {
  if (row.drift === "at_risk") return <span className="wrr-badge wrr-badge-warn" title={row.atRiskReason ?? undefined}>AT RISK</span>;
  if (row.drift === "on_track") return <span className="wrr-badge wrr-badge-lime">ON TRACK</span>;
  if (row.atRiskReason) return <span className="wrr-badge wrr-badge-warn" title={row.atRiskReason}>⚠ {row.atRiskReason}</span>;
  return <span className="wrr-muted">—</span>;
}

function SegmentBar({ criteria, tasks, bare, total }: { criteria: number; tasks: number; bare: number; total: number }) {
  if (total === 0) return <div className="wrr-bar wrr-bar-empty" />;
  const pct = (n: number) => `${(n / total) * 100}%`;
  return (
    <div className="wrr-bar">
      <span className="wrr-bar-seg wrr-bar-criteria" style={{ width: pct(criteria) }} title={`${criteria} with acceptance criteria`} />
      <span className="wrr-bar-seg wrr-bar-tasks" style={{ width: pct(tasks) }} title={`${tasks} with a linked task`} />
      <span className="wrr-bar-seg wrr-bar-bare" style={{ width: pct(bare) }} title={`${bare} bare line(s)`} />
    </div>
  );
}

function MilestoneCard({ group }: { group: RoadmapMilestoneGroup }) {
  return (
    <div className="wrr-milestone">
      <div className="wrr-milestone-head">
        <h3 className="wrr-milestone-name">{group.name}</h3>
        <span className="wrr-milestone-count">{group.repos.length} repos</span>
      </div>
      <div className="wrr-milestone-repos">
        {group.repos.map((r) => {
          const pct = r.lineCount ? Math.round((r.doneCount / r.lineCount) * 100) : 0;
          const atRisk = r.projectId === group.mostAtRiskProjectId;
          return (
            <div key={r.projectId} className={`wrr-mrepo${atRisk ? " wrr-mrepo-warn" : ""}`}>
              <div className="wrr-mrepo-head">
                <span className="wrr-mrepo-name">{r.repo ?? r.projectName}</span>
                <span className="wrr-mrepo-count">{r.doneCount}/{r.lineCount}</span>
              </div>
              <div className="wrr-mrepo-track"><div className="wrr-mrepo-fill" style={{ width: `${pct}%` }} /></div>
              {atRisk && r.atRiskReason && <div className="wrr-mrepo-reason">⚠ {r.atRiskReason}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ScaffoldRow({ projectId, projectName, onScaffolded }: { projectId: string; projectName: string; onScaffolded: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const scaffold = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.scaffoldProjectRoadmap(projectId);
      onScaffolded();
    } catch (e) {
      setErr((e as Error)?.message || "Couldn't create one.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <tr className="wrr-dashed-row">
      <td colSpan={8}>
        <div className="wrr-dashed-content">
          <span>
            <b>{projectName}</b> — without a file there is no roadmap; agents work from the board alone here.
          </span>
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={scaffold}>
            {busy ? "Creating…" : "Create one from the board"}
          </button>
          {err && <span className="wrr-dashed-err">{err}</span>}
        </div>
      </td>
    </tr>
  );
}

export function WorkspaceRoadmapView() {
  const [data, setData] = useState<RoadmapWorkspaceRollup | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    api
      .fetchWorkspaceRoadmapRollup()
      .then((d) => live && setData(d))
      .catch((e: unknown) => live && setErr((e as Error)?.message || "Couldn't load the roll-up."));
    return () => {
      live = false;
    };
  }, [nonce]);

  if (err) return <div className="kb-empty">{err}</div>;
  if (!data) return <div className="kb-empty">Loading…</div>;

  if (data.rows.length === 0 && data.noRoadmapProjects.length === 0) {
    return <div className="kb-empty">No accessible project has a bound repo yet.</div>;
  }

  return (
    <div className="wrr">
      <div className="wrr-topbar">
        <h2 className="wrr-title">Roadmap Roll-up</h2>
        <span className="wrr-sub">Every project you already have access to — no separate cross-repo grant.</span>
      </div>

      {data.milestones.length > 0 && (
        <div className="wrr-milestones">
          {data.milestones.map((g) => (
            <MilestoneCard key={g.name} group={g} />
          ))}
        </div>
      )}

      <table className="wrr-table">
        <thead>
          <tr>
            <th>REPO</th>
            <th>FILE</th>
            <th>LINES</th>
            <th>WITH TASKS</th>
            <th>WITH CRITERIA</th>
            <th>DRIFT</th>
            <th>PROPOSALS</th>
            <th>BREAKDOWN</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row) => (
            <tr key={row.projectId}>
              <td>
                <div className="wrr-repo-cell">
                  <span className="wrr-repo-name">{row.repo ?? row.projectName}</span>
                  <SyncBadge state={row.syncState} />
                </div>
              </td>
              <td className="wrr-mono">{row.path}</td>
              <td>{row.lineCount}</td>
              <td>{row.withTasksCount}</td>
              <td>{row.withCriteriaCount}</td>
              <td><DriftBadge row={row} /></td>
              <td>{row.proposalCount || <span className="wrr-muted">—</span>}</td>
              <td className="wrr-bar-cell">
                <SegmentBar
                  criteria={row.withCriteriaCount}
                  tasks={Math.max(0, row.withTasksCount - row.withCriteriaCount)}
                  bare={Math.max(0, row.lineCount - row.withTasksCount - row.withCriteriaCount)}
                  total={row.lineCount}
                />
              </td>
            </tr>
          ))}
          {data.noRoadmapProjects.map((p) => (
            <ScaffoldRow key={p.projectId} projectId={p.projectId} projectName={p.projectName} onScaffolded={() => setNonce((n) => n + 1)} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
