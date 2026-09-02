import { Fragment, useEffect, useMemo, useState } from "react";
import type { AuditRecordWithActor, Decision, TaskRun, Transition } from "@skynet/shared";
import * as api from "../lib/client";
import { cardVariant } from "../kanban/inbox";
import { useStore } from "../lib/store";
import {
  agentsForProject,
  fmtCost,
  fmtWait,
  KIND_META,
  openQueue,
  providerReadiness,
  readyFeatureMerges,
  readyMerges,
  runnerName,
  waitedSecs,
} from "../lib/derive";
import {
  greetingSentence,
  handledWithoutYou,
  mergedStats,
  needsHumanLook,
  overnightActivity,
  spendVsWorkSeries,
  spendVsWorkTrend,
  topDecisions,
  waitingOnYou,
} from "../kanban/home-metrics";
import { PrimaryButton } from "../components/empty";
import { RepoPicker, useConnectedRepos } from "../components/repo-picker";
import { FolderPicker } from "../components/folder-picker";

function ViewHead({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="vw-head">
      <h1>{title}</h1>
      <p>{sub}</p>
    </div>
  );
}

// ─── Fleet readiness ─────────────────────────────────────────────────────────
// The one thing that makes the whole product inert: no provider has a working
// credential, so nothing an operator does can actually run. Surface it on the
// first screen with a single fix path into Settings. Renders nothing once at
// least one provider is ready (the common case), so it's silent when irrelevant.
function FleetReadinessBanner({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { providers } = useStore();
  if (providers.length === 0) return null;
  if (providers.some((p) => providerReadiness(p).ready)) return null;
  return (
    <div className="fleet-warn" role="status">
      <span className="fleet-warn-dot" />
      <span className="fleet-warn-txt">
        <b>No provider connected</b> — agents can't run until a key is added.
      </span>
      <button className="fleet-warn-cta" onClick={onOpenSettings}>
        Add a key →
      </button>
    </div>
  );
}

// ─── Get started (first run) ────────────────────────────────────────────────

function GetStarted({
  onCreate,
  onConfigureFleet,
  onOpenSettings,
}: {
  onCreate: (name: string, goal: string, opts?: { repo?: string; repoPath?: string }) => void;
  onConfigureFleet: () => void;
  onOpenSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [repo, setRepo] = useState("");
  const [repoPath, setRepoPath] = useState("");
  // Chat-only: no worktree, no diff review, no merge — an agent just runs and
  // reports back. Lets a brand-new operator try Skynet with zero git literacy
  // instead of connecting a repo first. Explicit opt-in (a checkbox), not just
  // a side effect of having nothing to pick — see the disabled/reason logic
  // below, which no longer depends on `hasRepos` once this is checked.
  const [chatOnly, setChatOnly] = useState(false);
  const repos = useConnectedRepos();
  const hasRepos = (repos?.length ?? 0) > 0;
  return (
    <div className="getstarted">
      <div className="gs-inner">
        <FleetReadinessBanner onOpenSettings={onOpenSettings} />
        <svg className="gs-mark" width="46" height="46" viewBox="0 0 18 18" aria-hidden="true">
          <rect x="1" y="1" width="16" height="16" rx="4" fill="var(--accent)" />
          <text x="9" y="9.6" textAnchor="middle" dominantBaseline="central" fontFamily="var(--font-ui)" fontWeight="700" fontSize="11" fill="var(--bg)">S</text>
        </svg>
        <h1 className="gs-title">Skynet is online.</h1>
        <p className="gs-sub">
          The Agent Network for a fleet of coding agents. Start with a project
          — a goal you want the fleet to deliver — then break it into tasks and
          assign them to agents. The machines do the rest; progress shows up
          here on the home map.
        </p>
        <div className="gs-steps">
          <div className="gs-step">
            <span className="gs-num">1</span>
            <div className="gs-step-txt">
              <b>Create a project</b>
              <span>Name it and describe what “done” looks like.</span>
            </div>
          </div>
          <div className="gs-step">
            <span className="gs-num">2</span>
            <div className="gs-step-txt">
              <b>Fill the backlog</b>
              <span>Break the goal into assignable tasks.</span>
            </div>
          </div>
          <div className="gs-step">
            <span className="gs-num">3</span>
            <div className="gs-step-txt">
              <b>Assign &amp; monitor</b>
              <span>Spin up agents and watch the lines move.</span>
            </div>
          </div>
        </div>
        {open ? (
          <div className="gs-form">
            <input
              className="qx-input"
              autoFocus
              placeholder="Project name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <textarea
              className="qx-input"
              rows={2}
              placeholder="Goal — what does done look like?"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
            />
            {!chatOnly && (
              <>
                <div className="rp-label">Local folder <span className="rp-hint">· agents work here</span></div>
                <FolderPicker value={repoPath} onChange={setRepoPath} />
                {!repoPath && <RepoPicker repos={repos} value={repo} onChange={setRepo} />}
              </>
            )}
            <label className="gs-chatonly">
              <input
                type="checkbox"
                checked={chatOnly}
                onChange={(e) => setChatOnly(e.target.checked)}
              />
              No repo — chat only <span className="rp-hint">· the agent just runs and reports back; no diff review, no merge</span>
            </label>
            <div className="qx-row">
              <PrimaryButton
                disabled={!name.trim() || (!chatOnly && !repoPath && hasRepos && !repo)}
                reason={
                  !name.trim()
                    ? "Name your project to continue."
                    : "Pick a local folder or a connected repo, or check “No repo — chat only”."
                }
                onClick={() =>
                  onCreate(name.trim(), goal.trim() || "No goal set yet.", {
                    repo: chatOnly || repoPath ? undefined : repo || undefined,
                    repoPath: chatOnly ? undefined : repoPath || undefined,
                  })
                }
              >
                Create project
              </PrimaryButton>
              <button className="btn btn-ghost" onClick={() => setOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button className="btn btn-primary gs-cta" onClick={() => setOpen(true)}>
            + Create your first project
          </button>
        )}
        <button className="gs-secondary" onClick={onConfigureFleet}>
          or configure your agent fleet first →
        </button>
      </div>
    </div>
  );
}

// ─── Home shell (Momentum Rollout Phase 22 — "replace, don't layer") ───────
// Home used to lead with a live runs board + a first-run checklist — useful
// on day one, noise every day after. This rebuild leads with what actually
// changed since the operator last looked: a real overnight summary, four
// stat cards, a 14-day spend-vs-work read, and the top 3 things costing the
// most while they wait. All the math lives in home-metrics.ts (pure,
// DOM-free, `now` always an explicit param) — kept separate from this
// rendering layer so it's testable, same rationale as health-metrics.ts.
// Per-project detail (the map, dependency lines) still lives on each
// project's own page; GetStarted (below, unchanged) still owns the
// genuinely-empty-workspace case — this rebuild only replaces what a
// non-empty workspace's Home showed.

// Short, prose-friendly (lowercase, singular) HITL kind names for the
// WAITING ON YOU breakdown — KIND_META's labels are UI category chips
// ("PLAN REVIEW", "NEEDS HELP"), not built for "N of these" sentence
// grammar, so this stays a separate small map rather than reusing them.
const KIND_SHORT: Record<string, string> = {
  approval: "approval",
  question: "question",
  plan: "plan review",
  diff: "diff review",
  merge: "merge conflict",
  escalation: "escalation",
  verifier: "check failure",
};

function waitingBreakdownText(byKind: Partial<Record<string, number>>): string {
  const entries = Object.entries(byKind) as [string, number][];
  if (entries.length === 0) return "nothing waiting";
  return entries
    .map(([k, n]) => `${n} ${KIND_SHORT[k] ?? k}${n === 1 ? "" : "s"}`)
    .join(" · ");
}

function HomeStatCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: number | string;
  sub: string;
  accent: string;
}) {
  return (
    <div className="hm-card" style={{ borderTopColor: accent }}>
      <div className="hm-card-label">{label}</div>
      <div className="hm-card-value" style={{ color: accent }}>{value}</div>
      <div className="hm-card-sub">{sub}</div>
    </div>
  );
}

function SpendVsWorkChart({
  series,
  trend,
}: {
  series: ReturnType<typeof spendVsWorkSeries>;
  trend: ReturnType<typeof spendVsWorkTrend>;
}) {
  const maxMerged = Math.max(1, ...series.map((d) => d.mergedCount));
  const maxCostPerMerge = Math.max(1, ...series.map((d) => d.costPerMerge ?? 0));
  return (
    <div className="hm-chart-card">
      <div className="hm-card-label" title="Bars: branches merged that day. Dot: cost per branch merged that day.">
        Spend vs. work — last 14 days
      </div>
      <div className="hm-chart">
        {series.map((d) => {
          const barPct = d.mergedCount > 0 ? Math.max(4, Math.round((d.mergedCount / maxMerged) * 100)) : 0;
          // Positioned via `bottom: <n>%` on a `position:relative` column
          // (below), never a percentage `margin-bottom` — that resolves
          // against the column's WIDTH, not height, and flattens this
          // series onto the baseline. See home-metrics.ts's own comment on
          // spendVsWorkSeries for why the marker and bar use independent
          // value domains (merge count vs. cost-per-merge) sharing one
          // column height.
          const markerPct = d.costPerMerge != null ? Math.max(2, Math.round((d.costPerMerge / maxCostPerMerge) * 100)) : null;
          return (
            <div className="hm-chart-col" key={d.dayStart}>
              <div className="hm-chart-track">
                <div className="hm-chart-bar" style={{ height: `${barPct}%` }} title={`${d.mergedCount} merged`} />
              </div>
              {markerPct != null && (
                <div
                  className="hm-chart-marker"
                  style={{ bottom: `${markerPct}%` }}
                  title={`${fmtCost(d.costPerMerge!)} / merge`}
                />
              )}
            </div>
          );
        })}
      </div>
      <div className="hm-chart-reading">
        {trend.kind === "insufficient-data"
          ? "Not enough merged work yet to read a trend."
          : `${trend.totalMerges} branch${trend.totalMerges === 1 ? "" : "es"} merged over 14 days, averaging ${fmtCost(trend.avgCostPerMerge)} each — cost per merge is ${trend.direction}.`}
      </div>
    </div>
  );
}

function FirstThreeThings({
  decisions,
  now,
  onOpenTask,
}: {
  decisions: Decision[];
  now: number;
  onOpenTask: (id: string) => void;
}) {
  if (decisions.length === 0) return null;
  return (
    <div className="hm-first3">
      <div className="hm-card-label">First three things</div>
      <div className="hm-first3-list">
        {decisions.map((d) => {
          const variant = cardVariant(d);
          const k = KIND_META[d.kind];
          return (
            <button
              key={d.id}
              className={
                "di-card hm-first3-card" +
                (variant === "escalation" ? " di-card-escalation" : "") +
                (variant === "conflict" ? " di-card-conflict" : "")
              }
              onClick={() => onOpenTask(d.runId)}
            >
              <div className="hm-first3-top">
                <span className="hm-first3-kind" style={{ color: k.color }}>{k.label}</span>
                <span className="hm-first3-wait mono">{fmtWait(waitedSecs(d, now))}</span>
              </div>
              <div className="hm-first3-title">{d.title}</div>
              <div className="hm-first3-meta mono">
                {d.projectName}{d.taskTitle ? ` · ${d.taskTitle}` : ""}
              </div>
            </button>
          );
        })}
      </div>
      <div className="hm-first3-footnote">ordered by what's costing you most while it waits</div>
    </div>
  );
}

export function HomeView({
  now,
  onOpenTask,
  onCreate,
  onConfigureFleet,
  onOpenSettings,
}: {
  now: number;
  onOpenTask: (id: string) => void;
  onCreate: (name: string, goal: string, opts?: { repo?: string; repoPath?: string }) => void;
  onConfigureFleet: () => void;
  onOpenSettings: () => void;
}) {
  const { projects, runs, queue, tasks, features, transitions: liveTransitions } = useStore();

  // Fetch-once-then-merge-live, same pattern as BoardHealth (health.tsx):
  // the Snapshot doesn't carry historical Decisions/audit/Transitions, and
  // this dashboard needs real history (the audit trail's 7-day window, the
  // spend chart's 14 days), not just what's arrived over this live session.
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [audit, setAudit] = useState<AuditRecordWithActor[]>([]);
  const [fetchedTransitions, setFetchedTransitions] = useState<Transition[]>([]);
  useEffect(() => {
    if (projects.length === 0) return; // nothing to fetch on the empty-workspace screen
    let live = true;
    Promise.all([api.fetchDecisions(), api.fetchAudit(), api.fetchTransitions({ limit: 5000 })])
      .then(([d, a, t]) => {
        if (!live) return;
        setDecisions(d);
        setAudit(a);
        setFetchedTransitions(t);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch once per mount, like BoardHealth's own effect
  }, []);
  const transitions = useMemo(() => {
    const byId = new Map(fetchedTransitions.map((t) => [t.id, t]));
    for (const t of liveTransitions) byId.set(t.id, t);
    return [...byId.values()];
  }, [fetchedTransitions, liveTransitions]);

  if (projects.length === 0)
    return (
      <GetStarted
        onCreate={onCreate}
        onConfigureFleet={onConfigureFleet}
        onOpenSettings={onOpenSettings}
      />
    );

  const readyToMergeCount = readyMerges(runs).length + readyFeatureMerges(features).length;
  const activity = overnightActivity(runs, queue, now);
  const greeting = greetingSentence(activity, readyToMergeCount);
  const waiting = waitingOnYou(openQueue(queue));
  const handled = handledWithoutYou(audit, now);
  const merged = mergedStats(runs, now);
  const needsLook = needsHumanLook(queue, tasks, transitions, now);
  const series = spendVsWorkSeries(runs, now);
  const trend = spendVsWorkTrend(series);
  const top3 = topDecisions(decisions);

  return (
    <div className="home">
      <div className="home-bar">
        <FleetReadinessBanner onOpenSettings={onOpenSettings} />
        <p className="hm-greeting">
          {greeting.before}
          {greeting.needsYou && <span className="hm-needsyou">{greeting.needsYou}</span>}
          {greeting.after}
        </p>
      </div>
      <div className="hm-grid">
        <HomeStatCard
          label="Waiting on you"
          value={waiting.total}
          sub={waitingBreakdownText(waiting.byKind)}
          accent="var(--info)"
        />
        <HomeStatCard
          label="Handled without you"
          value={handled.count}
          sub={handled.pct == null ? "no gates in the last 7d" : `${handled.pct}% of ${handled.totalGates} gates`}
          accent="var(--ok)"
        />
        <HomeStatCard
          label="Merged · 7 days"
          value={merged.merged}
          sub={merged.reverted > 0 ? `${merged.reverted} reverted` : "none reverted"}
          accent="var(--muted)"
        />
        <HomeStatCard
          label="Needs a human look"
          value={needsLook.total}
          sub={`${needsLook.escalations} escalation${needsLook.escalations === 1 ? "" : "s"} · ${needsLook.stalls} stalled`}
          accent="var(--warn)"
        />
      </div>
      <SpendVsWorkChart series={series} trend={trend} />
      <FirstThreeThings decisions={top3} now={now} onOpenTask={onOpenTask} />
    </div>
  );
}

// ─── Timeline lens ───────────────────────────────────────────────────────────

// Exported so the project page can reuse it in single-lane mode via `projectId`:
// the same layout, deps, and legend the workspace view uses — just filtered to
// one project's lane and one project's cross-run deps. Kept in-file to avoid
// duplicating the axis/tick/bar math (only place that owns it).
export function TimelineView({
  now,
  onOpenTask,
  projectId,
  hideHeader,
}: {
  now: number;
  onOpenTask: (id: string) => void;
  /** When set, filter to just this project's lane (used by the project page). */
  projectId?: string;
  /** When true, drop the "Today's run" panel head (the project page shows its
   *  own lens toggle instead). */
  hideHeader?: boolean;
}) {
  const store = useStore();
  const runs = store.runs;
  const queue = store.queue;
  const projects = projectId
    ? store.projects.filter((p) => p.id === projectId)
    : store.projects;
  const deps = projectId
    // Only cross-run deps within THIS project (a workspace-wide dep on a run in
    // another project's lane would render with no target here).
    ? store.deps.filter((d) =>
        runs.some((r) => r.id === d.fromAgentId && r.projectId === projectId) &&
        runs.some((r) => r.id === d.toAgentId && r.projectId === projectId),
      )
    : store.deps;
  const fleet = store.fleet;
  const oq = openQueue(queue);
  const W = 185;
  const NOW = 144;
  const pct = (m: number) => Math.max(0, Math.min(100, (m / W) * 100));
  const ticks = [
    { m: 54, l: "13:00" },
    { m: 84, l: "13:30" },
    { m: 114, l: "14:00" },
    { m: 174, l: "15:00" },
  ];

  const startedMin = (a: TaskRun) => Math.floor((now - a.startedAt) / 60000);

  const laneAgents = projects.map((p) =>
    agentsForProject(runs, p.id),
  );
  const laneTops: number[] = [];
  let acc = 0;
  laneAgents.forEach((la) => {
    laneTops.push(acc);
    acc += 13 + 38 * Math.max(1, la.length);
  });
  const rowCenter = (id: string) => {
    for (let li = 0; li < laneAgents.length; li++) {
      const ri = laneAgents[li]!.findIndex((a) => a.id === id);
      if (ri >= 0) return laneTops[li]! + 25 + 38 * ri;
    }
    return 0;
  };
  const barStartX = (id: string) => {
    const a = runs.find((x) => x.id === id);
    return pct(Math.max(0, NOW - (a ? startedMin(a) : 0)));
  };

  return (
    <section className="vw">
      {!hideHeader && (
        <ViewHead
          title="Today's run"
          sub="What each agent has been doing, where it stalled, and where it's headed"
        />
      )}
      <div className="tl-wrap">
        <div className="tl-axis">
          {ticks.map((t) => (
            <span key={t.l} className="tl-tick" style={{ left: pct(t.m) + "%" }}>
              {t.l}
            </span>
          ))}
          <span className="tl-now-label" style={{ left: pct(NOW) + "%" }}>
            now
          </span>
        </div>
        <div className="tl-lanes">
          <div className="tl-now" style={{ left: pct(NOW) + "%" }} />
          {ticks.map((t) => (
            <div key={t.l} className="tl-grid" style={{ left: pct(t.m) + "%" }} />
          ))}
          {deps.map((d) => {
            const fa = runs.find((a) => a.id === d.fromAgentId);
            const ta = runs.find((a) => a.id === d.toAgentId);
            if (!fa || !ta) return null;
            const x = barStartX(d.toAgentId);
            const y1 = rowCenter(d.fromAgentId);
            const y2 = rowCenter(d.toAgentId);
            return (
              <Fragment key={d.fromAgentId + d.toAgentId}>
                <span
                  className="tl-dep"
                  style={{ left: x + "%", top: y1 + "px", height: y2 - 15 - y1 + "px" }}
                />
                <span
                  className="tl-dep-arrow"
                  style={{ left: x + "%", top: y2 - 23 + "px" }}
                >
                  ▾
                </span>
                <span
                  className="tl-dep-tag"
                  style={{ left: x + "%", top: y1 + (y2 - y1) / 2 - 8 + "px" }}
                >
                  ⛓ after {fa.name}
                </span>
              </Fragment>
            );
          })}
          {projects.map((p) => {
            const pa = agentsForProject(runs, p.id);
            return (
              <div key={p.id} className="tl-lane">
                <span className="tl-proj">{p.name}</span>
                <div className="tl-bars">
                  {pa.map((a) => {
                    const sm = startedMin(a);
                    const start = Math.max(0, NOW - sm);
                    const total =
                      a.status === "done"
                        ? NOW - 102 - start
                        : sm / Math.max(a.progress, 0.08);
                    const x = pct(start);
                    const w = Math.max(7, pct(Math.min(start + total, W)) - x);
                    const q = oq.find((it) => it.runId === a.id);
                    return (
                      <div key={a.id} className="tl-canvas">
                        <button
                          className={"tl-bar tl-bar-" + a.status}
                          style={{ left: x + "%", width: w + "%" }}
                          onClick={() => onOpenTask(a.id)}
                        >
                          <span
                            className="tl-fill"
                            style={{ width: Math.round(a.progress * 100) + "%" }}
                          />
                          <span className="tl-bar-label">
                            <span className="tl-runner mono">{runnerName(a, fleet)}</span>
                            {a.name}
                            {a.status === "done" ? " ✓" : ""}
                          </span>
                          {(a.status === "waiting" || a.status === "review") && (
                            <span
                              className="tl-mark"
                              style={{ left: Math.round(a.progress * 100) + "%" }}
                            >
                              ⏸
                            </span>
                          )}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="tl-legend">
        <span>
          <i className="dot dot-running" /> working
        </span>
        <span>
          <i className="dot dot-waiting" /> blocked — ⏸ marks where it stopped
        </span>
        <span>
          <i className="dot dot-review" /> awaiting review
        </span>
        <span>
          <i className="dot dot-done" /> merged
        </span>
        <span className="tl-legend-dep">┊ dependency — gated on an upstream task</span>
      </div>
    </section>
  );
}
