import { Fragment, useEffect, useRef, useState } from "react";
import type { TaskRun, Project } from "@skynet/shared";
import { useStore } from "../lib/store";
import {
  agentsForProject,
  conflicts,
  curStep,
  fmtWait,
  heartbeatSecs,
  idleRunners,
  KIND_META,
  modName,
  openQueue,
  projectShipped,
  providerReadiness,
  runnerName,
  waitedSecs,
} from "../lib/derive";
import { EmptyState, PrimaryButton } from "../components/empty";
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

// ─── First-run checklist (live until first merge) ───────────────────────────
// A four-beat guide — create → task → assign → approve — pinned to Home while a
// workspace is finding its feet. Each beat ticks itself off from live state as
// the operator does it, and the whole strip retires for good once the first run
// merges (see `merged`). The current beat is a button that jumps you to where
// the next action happens.
function FirstRunChecklist({
  onOpenProject,
  onGoInbox,
}: {
  onOpenProject: (id: string) => void;
  onGoInbox: () => void;
}) {
  const { projects, tasks, runs } = useStore();
  // `run.status === "done"` alone is NOT "merged" — it also fires on a zero-diff
  // self-completion, an operator Stop, a reaper timeout, force-done, or a GitHub
  // PR that's merely been opened. `mergedAt` is set exactly once, only inside
  // orchestrator's `completeMerged`, which both the local merge queue and an
  // actual GitHub PR merge funnel through — the one accurate "code landed" signal.
  const merged = runs.some((r) => r.mergedAt != null);
  if (projects.length === 0 || merged) return null;

  const hasTask = tasks.length > 0;
  const assigned = runs.length > 0; // a task assigned to an agent spins up a run
  // Actionable beats jump to a project that hasn't shipped yet (a fresh one with
  // no tasks counts — projectShipped needs ≥1 task), else the first project.
  const target = projects.find((p) => !projectShipped(tasks, p.id)) ?? projects[0]!;

  const steps: { label: string; hint: string; done: boolean; onClick?: () => void }[] = [
    { label: "Create a project", hint: "Name it and set the goal.", done: true },
    { label: "Add a task", hint: "Break the goal into work an agent can pick up.", done: hasTask, onClick: () => onOpenProject(target.id) },
    { label: "Assign it to an agent", hint: "Move a task to Ongoing to start a run.", done: assigned, onClick: () => onOpenProject(target.id) },
    { label: "Approve the first merge", hint: "Review the finished work and merge it.", done: false, onClick: onGoInbox },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  const currentIdx = steps.findIndex((s) => !s.done); // first unfinished beat

  return (
    <div className="firstrun" role="status" aria-label="First-run checklist">
      <div className="firstrun-head">
        <span className="firstrun-title">GET TO YOUR FIRST MERGE</span>
        <span className="firstrun-sub mono">{doneCount}/{steps.length}</span>
      </div>
      <div className="firstrun-steps">
        {steps.map((s, i) => {
          const current = i === currentIdx;
          const cls =
            "firstrun-step" + (s.done ? " done" : "") + (current ? " current" : "");
          const inner = (
            <>
              <span className="firstrun-check" aria-hidden="true">{s.done ? "✓" : i + 1}</span>
              <span className="firstrun-step-txt">
                <b>{s.label}</b>
                <span>{s.hint}</span>
              </span>
              {current && s.onClick && <span className="firstrun-go">Go →</span>}
            </>
          );
          return current && s.onClick ? (
            <button key={s.label} className={cls} onClick={s.onClick}>
              {inner}
            </button>
          ) : (
            <div key={s.label} className={cls}>
              {inner}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Home shell ──────────────────────────────────────────────────────────────
// Home used to switch between four lenses (Subway / Timeline / Ledger /
// Roster) — four takes on the same underlying runs/tasks, none of them THE
// answer to "what's happening right now." Runs below replaces all four: one
// live board, sorted by what needs attention first. Per-project detail
// (the map, dependency lines) still lives on each project's own page.

export function HomeView({
  now,
  onOpenTask,
  onOpenAgent,
  onOpenProject,
  onCreate,
  onGoInbox,
  onConfigureFleet,
  onOpenSettings,
  onAssign,
}: {
  now: number;
  onOpenTask: (id: string) => void;
  onOpenAgent: (id: string) => void;
  onOpenProject: (id: string) => void;
  onCreate: (name: string, goal: string, opts?: { repo?: string; repoPath?: string }) => void;
  onGoInbox: () => void;
  onConfigureFleet: () => void;
  onOpenSettings: () => void;
  onAssign: () => void;
}) {
  const { projects, runs, queue, modules, fleet } = useStore();

  if (projects.length === 0)
    return (
      <GetStarted
        onCreate={onCreate}
        onConfigureFleet={onConfigureFleet}
        onOpenSettings={onOpenSettings}
      />
    );

  const blockers = openQueue(queue).sort(
    (a, b) => waitedSecs(b, now) - waitedSecs(a, now),
  );
  const conf = conflicts(runs);

  const projName = (runId: string) => {
    const a = runs.find((x) => x.id === runId);
    return projects.find((p) => p.id === a?.projectId)?.name ?? "—";
  };

  return (
    <div className="home">
      <FirstRunChecklist onOpenProject={onOpenProject} onGoInbox={onGoInbox} />
      <div className="home-bar">
        <FleetReadinessBanner onOpenSettings={onOpenSettings} />
        {blockers.length === 0 ? (
          <div className="needs-strip needs-clear">
            <span className="dot dot-running" /> No orders required — all agents
            running autonomously.
          </div>
        ) : (
          <div className="needs-strip">
            <div className="needs-strip-head">
              <span className="needs-strip-title">
                ⏸ NEEDS YOU · {blockers.length}{" "}
                <span className="needs-strip-hint">oldest first</span>
              </span>
              <button className="needs-strip-all" onClick={onGoInbox}>
                Open Inbox →
              </button>
            </div>
            <div className="needs-row">
              {blockers.map((item) => {
                const k = KIND_META[item.kind];
                const waited = waitedSecs(item, now);
                const a = runs.find((x) => x.id === item.runId);
                return (
                  <button
                    key={item.id}
                    className={"blocker" + (waited > 300 ? " blocker-hot" : "")}
                    onClick={() => onOpenTask(item.runId)}
                  >
                    <div className="blocker-top">
                      <span
                        className="blocker-kind"
                        style={{ color: k.color, borderColor: k.color }}
                      >
                        {k.label}
                      </span>
                      <span className="blocker-wait mono">{fmtWait(waited)}</span>
                    </div>
                    <span className="blocker-title">{item.title}</span>
                    <div className="blocker-meta mono">
                      {a ? runnerName(a, fleet) : item.runId} ·{" "}
                      {projName(item.runId)}
                    </div>
                    <div className="blocker-cta">Review &amp; decide →</div>
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {conf.map(([area, list]) => (
          <div key={area} className="home-conflict">
            ⚠ <b>{modName(modules, area)}</b> —{" "}
            {list
              .map((a) => runnerName(a, fleet) + " (" + a.name + ")")
              .join(" and ")}{" "}
            are both working here.
            <button
              className="home-conflict-link"
              onClick={() => list[0] && onOpenTask(list[0].id)}
            >
              Review →
            </button>
          </div>
        ))}
      </div>
      <RunsBoard
        now={now}
        onOpenTask={onOpenTask}
        onOpenAgent={onOpenAgent}
        onOpenProject={onOpenProject}
        onAssign={onAssign}
        onConfigureFleet={onConfigureFleet}
      />
    </div>
  );
}

// ─── Runs — the one live board (replaces Subway/Timeline/Ledger/Roster) ──────
// Every in-flight run, plus the most recently done ones, as one table sorted
// by what needs attention first: needs you (an open HITL — oldest-waiting
// first), then running (most recently started first), then done (most
// recently finished first). No per-project grouping, no separate idle-agent
// list — idle capacity and the unassigned backlog are single-number stats,
// not rows; drilling into a project's own page still shows that project's map.
const DONE_CAP = 8;
type RunTag = "running" | "blocked" | "paused" | "done";
interface RunRow {
  run: TaskRun;
  agentId: string | null;
  agentName: string;
  projectId: string;
  projectName: string;
  tag: RunTag;
  statusLabel: string;
  timeLabel: string;
  sortKey: number;
}
const TAG_RANK: Record<RunTag, number> = { blocked: 0, running: 1, paused: 2, done: 3 };

// ─── Parallelism nudge ────────────────────────────────────────────────────
// "idle runners + deep backlog → spin up more?" — the fleet's own idle state
// turned into a light suggestion, not a warning: accent-toned, dismissible for
// the session (no localStorage — it's a hint, and a fresh page load re-checks
// the live state rather than remembering a stale dismissal). Silent whenever
// the heuristic (derive/parallelism.ts, server-computed) isn't met.
function ParallelismNudgeBanner({ onConfigureFleet }: { onConfigureFleet: () => void }) {
  const { parallelismNudge } = useStore();
  const [dismissed, setDismissed] = useState(false);
  if (dismissed || !parallelismNudge?.shouldNudge) return null;
  return (
    <div className="parallel-nudge" role="status">
      <span className="parallel-nudge-txt">
        <b>{parallelismNudge.idleRunners} idle runners</b> and {parallelismNudge.eligibleBacklog} tasks waiting —
        spin up more agents to work them in parallel?
      </span>
      <button className="parallel-nudge-cta" onClick={onConfigureFleet}>
        Add agent →
      </button>
      <button className="approval-rule-x parallel-nudge-x" title="Dismiss" onClick={() => setDismissed(true)}>
        ×
      </button>
    </div>
  );
}

function RunsBoard({
  now,
  onOpenTask,
  onOpenAgent,
  onOpenProject,
  onAssign,
  onConfigureFleet,
}: {
  now: number;
  onOpenTask: (id: string) => void;
  onOpenAgent: (id: string) => void;
  onOpenProject: (id: string) => void;
  onAssign: () => void;
  onConfigureFleet: () => void;
}) {
  const { runs, tasks, projects, queue, fleet } = useStore();
  const oq = openQueue(queue);
  const idle = idleRunners(fleet, runs);
  const backlogCount = tasks.filter(
    (t) => !t.runId && !t.archived && (t.state === "backlog" || t.state === "triage" || t.state === "todo"),
  ).length;

  const toRow = (r: TaskRun): RunRow => {
    const hitl = oq.find((q) => q.runId === r.id);
    const project = projects.find((p) => p.id === r.projectId);
    let tag: RunTag, statusLabel: string, timeLabel: string, sortKey: number;
    if (r.status === "done") {
      tag = "done"; statusLabel = "done"; timeLabel = "—";
      sortKey = -r.lastHeartbeatAt; // most recently finished first
    } else if (hitl) {
      const waited = waitedSecs(hitl, now);
      tag = "blocked"; statusLabel = KIND_META[hitl.kind].label.toLowerCase(); timeLabel = fmtWait(waited) + " waiting";
      sortKey = -waited; // longest-waiting first
    } else if (r.status === "paused") {
      tag = "paused"; statusLabel = "paused"; timeLabel = fmtWait(heartbeatSecs(r, now)) + " ago";
      sortKey = heartbeatSecs(r, now);
    } else {
      const elapsed = (now - r.startedAt) / 1000;
      tag = "running"; statusLabel = curStep(r); timeLabel = fmtWait(elapsed) + " elapsed";
      sortKey = elapsed; // most recently started first
    }
    return {
      run: r,
      agentId: r.agentId,
      agentName: runnerName(r, fleet),
      projectId: r.projectId,
      projectName: project?.name ?? "—",
      tag, statusLabel, timeLabel, sortKey,
    };
  };

  const live = runs.filter((r) => r.status !== "done" && !r.archived);
  const done = runs
    .filter((r) => r.status === "done" && !r.archived)
    .sort((a, b) => b.lastHeartbeatAt - a.lastHeartbeatAt)
    .slice(0, DONE_CAP);
  const rows = [...live, ...done]
    .map(toRow)
    .sort((a, b) => TAG_RANK[a.tag] - TAG_RANK[b.tag] || a.sortKey - b.sortKey);

  const runningCount = rows.filter((r) => r.tag === "running").length;
  const blockedCount = rows.filter((r) => r.tag === "blocked").length;
  const doneCount = rows.filter((r) => r.tag === "done").length;

  // Split-flap flip: remember each row's last shown status text so the CSS
  // flip animation plays only on rows that actually changed since the last
  // render, not on every row every time the live snapshot ticks.
  const prevFlap = useRef<Record<string, string>>({});
  const flips = new Set<string>();
  rows.forEach((r) => { if (prevFlap.current[r.run.id] !== r.statusLabel) flips.add(r.run.id); });
  useEffect(() => {
    const next: Record<string, string> = {};
    rows.forEach((r) => { next[r.run.id] = r.statusLabel; });
    prevFlap.current = next;
  });

  return (
    <section className="vw">
      <ViewHead title="Runs" sub="Every project, one live view — sorted by what needs you first" />
      <ParallelismNudgeBanner onConfigureFleet={onConfigureFleet} />
      <div className="rb-card">
        <div className="rb-stats">
          <div className="rb-stat"><span className="rb-v">{rows.length}</span><span className="rb-k">runs</span></div>
          <div className="rb-stat rb-running"><span className="rb-v">{runningCount}</span><span className="rb-k">running</span></div>
          <div className="rb-stat rb-blocked"><span className="rb-v">{blockedCount}</span><span className="rb-k">needs you</span></div>
          <div className="rb-stat rb-done"><span className="rb-v">{doneCount}</span><span className="rb-k">done</span></div>
          {idle.length > 0 && (
            <button className="rb-stat rb-idle" onClick={onAssign} title="Assign work to an idle agent">
              <span className="rb-v">{idle.length}</span><span className="rb-k">idle · assign →</span>
            </button>
          )}
        </div>
        {rows.length === 0 ? (
          <EmptyState
            compact
            title="Nothing running"
            hint="Assign a task to an agent and it shows up here."
            cta={{ label: "Assign work →", onClick: onAssign }}
          />
        ) : (
          <div className="rb-table">
            <div className="rb-hcell">Task</div>
            <div className="rb-hcell">Project</div>
            <div className="rb-hcell">Agent</div>
            <div className="rb-hcell">Status</div>
            <div className="rb-hcell">Time</div>
            {rows.map((row) => (
              <Fragment key={row.run.id}>
                <button className="rb-cell rb-task" onClick={() => onOpenTask(row.run.id)}>
                  {row.run.name}
                </button>
                <button className="rb-cell rb-proj" onClick={() => onOpenProject(row.projectId)}>
                  {row.projectName}
                </button>
                <div className="rb-cell rb-agent">
                  {row.agentId ? (
                    <button className="rb-pill" onClick={() => onOpenAgent(row.agentId!)}>
                      {row.agentName}
                    </button>
                  ) : (
                    <span className="rb-off">—</span>
                  )}
                </div>
                <button className="rb-cell rb-statuscell" onClick={() => onOpenTask(row.run.id)}>
                  <span className={"rb-chip rb-tag-" + row.tag + (flips.has(row.run.id) ? " rb-flip" : "")}>
                    {row.statusLabel}
                  </span>
                </button>
                <div className="rb-cell rb-time mono">{row.timeLabel}</div>
              </Fragment>
            ))}
          </div>
        )}
        {backlogCount > 0 && (
          <div className="rb-backlog-note">
            {backlogCount} more queued, not yet assigned —{" "}
            <button onClick={onAssign}>open a project to assign →</button>
          </div>
        )}
      </div>
    </section>
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
