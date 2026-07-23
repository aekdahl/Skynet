import { Fragment, useState, type ReactNode } from "react";
import type { TaskRun, Task, Project } from "@skynet/shared";
import { useStore } from "../lib/store";
import {
  agentsForProject,
  conflicts,
  curStep,
  familyOf,
  fmtWait,
  heartbeatSecs,
  idleRunners,
  KIND_META,
  modName,
  openQueue,
  projectQueue,
  providerOf,
  providerInfo,
  runnerIdleLabel,
  runnerName,
  stepIdx,
  waitedSecs,
} from "../lib/derive";
import { Bar, Prov, StatusDot } from "../components/common";
import { RepoPicker, useConnectedRepos } from "../components/repo-picker";
import { FolderPicker } from "../components/folder-picker";
import type { Lens } from "../App";

function ViewHead({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="vw-head">
      <h1>{title}</h1>
      <p>{sub}</p>
    </div>
  );
}

// ─── Get started (first run) ────────────────────────────────────────────────

function GetStarted({
  onCreate,
  onConfigureFleet,
}: {
  onCreate: (name: string, goal: string, opts?: { repo?: string; repoPath?: string }) => void;
  onConfigureFleet: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [repo, setRepo] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const repos = useConnectedRepos();
  const hasRepos = (repos?.length ?? 0) > 0;
  return (
    <div className="getstarted">
      <div className="gs-inner">
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
            <div className="rp-label">Local folder <span className="rp-hint">· agents work here</span></div>
            <FolderPicker value={repoPath} onChange={setRepoPath} />
            {!repoPath && <RepoPicker repos={repos} value={repo} onChange={setRepo} />}
            <div className="qx-row">
              <button
                className="btn btn-primary"
                disabled={!name.trim() || (!repoPath && hasRepos && !repo)}
                onClick={() =>
                  onCreate(name.trim(), goal.trim() || "No goal set yet.", {
                    repo: repoPath ? undefined : repo || undefined,
                    repoPath: repoPath || undefined,
                  })
                }
              >
                Create project
              </button>
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

// ─── Home shell ──────────────────────────────────────────────────────────────

const LENSES: Array<[Lens, string]> = [
  ["subway", "Subway"],
  ["timeline", "Timeline"],
  ["ledger", "Ledger"],
  ["roster", "Roster"],
];

export function HomeView({
  lens,
  setLens,
  now,
  onOpenTask,
  onOpenProject,
  onCreate,
  onGoInbox,
  onConfigureFleet,
  onAssign,
}: {
  lens: Lens;
  setLens: (l: Lens) => void;
  now: number;
  onOpenTask: (id: string) => void;
  onOpenProject: (id: string) => void;
  onCreate: (name: string, goal: string, opts?: { repo?: string; repoPath?: string }) => void;
  onGoInbox: () => void;
  onConfigureFleet: () => void;
  onAssign: () => void;
}) {
  const { projects, runs, queue, modules, fleet } = useStore();

  if (projects.length === 0)
    return <GetStarted onCreate={onCreate} onConfigureFleet={onConfigureFleet} />;

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
      <div className="home-bar">
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
        <div className="lens-switch">
          {LENSES.map(([id, label]) => (
            <button
              key={id}
              className={"lens-btn" + (lens === id ? " on" : "")}
              onClick={() => setLens(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="home-lens">
        {lens === "subway" && (
          <SubwayView now={now} onOpenTask={onOpenTask} onOpenProject={onOpenProject} />
        )}
        {lens === "timeline" && <TimelineView now={now} onOpenTask={onOpenTask} />}
        {lens === "ledger" && (
          <LedgerView now={now} onOpenTask={onOpenTask} onAssign={onAssign} />
        )}
        {lens === "roster" && (
          <RosterView
            now={now}
            onOpenTask={onOpenTask}
            onOpenProject={onOpenProject}
            onAssign={onAssign}
          />
        )}
      </div>
    </div>
  );
}

// ─── Ledger lens ─────────────────────────────────────────────────────────────

function LedgerView({
  now,
  onOpenTask,
  onAssign,
}: {
  now: number;
  onOpenTask: (id: string) => void;
  onAssign: () => void;
}) {
  const { runs, queue, fleet, projects, providers } = useStore();
  const idle = idleRunners(fleet, runs);
  const oq = openQueue(queue);
  const projName = (a: TaskRun) =>
    projects.find((p) => p.id === a.projectId)?.name ?? "—";

  const groups = [
    { h: "WAITING ON YOU", s: "waiting", list: runs.filter((a) => a.status === "waiting") },
    { h: "IN REVIEW", s: "review", list: runs.filter((a) => a.status === "review") },
    { h: "RUNNING", s: "running", list: runs.filter((a) => a.status === "running") },
  ].filter((g) => g.list.length > 0);
  const ongoing = runs.filter((a) => a.status !== "done");

  return (
    <section className="vw">
      <ViewHead
        title="Ongoing tasks"
        sub={`${ongoing.length} in flight · ${oq.length} waiting on you · ${idle.length} runs idle`}
      />
      <div className="lg-table">
        {groups.map((g) => (
          <div key={g.h} className="lg-group">
            <div className={"lg-group-head lg-gh-" + g.s}>
              {g.h} · {g.list.length}
            </div>
            {g.list.map((a) => {
              const q = oq.find((it) => it.runId === a.id);
              return (
                <button key={a.id} className="lg-row" onClick={() => onOpenTask(a.id)}>
                  <StatusDot status={a.status} />
                  <span className="lg-task">{a.name}</span>
                  <span className="lg-agent mono">{runnerName(a, fleet)}</span>
                  <span className="lg-proj">{projName(a)}</span>
                  <span className="lg-step">
                    {stepIdx(a)}/{a.plan.length} · {curStep(a)}
                  </span>
                  <Bar value={a.progress} status={a.status} />
                  <span className={"lg-state lg-state-" + a.status}>
                    {q
                      ? "⏸ " + fmtWait(waitedSecs(q, now))
                      : Math.round(a.progress * 100) + "%"}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
        <div className="lg-group">
          <div className="lg-group-head lg-gh-runs">
            ACTIVE AGENTS · {ongoing.length} — {idle.length} IDLE
          </div>
          {ongoing.map((a) => {
            const q = oq.find((it) => it.runId === a.id);
            return (
              <button key={a.id} className="lg-arow" onClick={() => onOpenTask(a.id)}>
                <StatusDot status={a.status} />
                <span className="lg-agent-id mono">{runnerName(a, fleet)}</span>
                <span className="lg-model mono">{a.model}</span>
                <span className="lg-step">{a.name}</span>
                <Bar value={a.progress} status={a.status} />
                <span className={"lg-state lg-state-" + a.status}>
                  {q
                    ? "⏸ " + fmtWait(waitedSecs(q, now))
                    : Math.round(a.progress * 100) + "%"}
                </span>
              </button>
            );
          })}
          {idle.map((r) => (
            <div key={r.id} className="lg-arow lg-arow-idle">
              <span className="dot dot-idle" />
              <span className="lg-agent-id mono">{r.name}</span>
              <span className="lg-model mono">
                <Prov info={providerInfo(providers, r.provider)} /> {r.model}
              </span>
              <span className="lg-step">idle — available for work</span>
              <button className="lg-assign" onClick={onAssign}>
                Assign task →
              </button>
              <span className="lg-state lg-state-idle">{runnerIdleLabel(r, now)}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── Subway lens ─────────────────────────────────────────────────────────────

// Subway — ONE MAP PER PROJECT (docs/subway-model.md). The first agent assigned
// anchors a START and an END node; every other agent lives between them. A track
// = an AGENT (fleet runner); its stations are the tasks it worked (its runs,
// left→right) followed by the tasks QUEUED ahead of it — hollow "up next" stops —
// so the line reads done → current → queued → ship: what's ahead and what's left.
// A path fans out from START (a fork branches at the station it forked from) and,
// once its whole subtree is work-done AND its queue is empty, MERGES back into END
// (leaf-first). Merging here is VISUAL only — real merges are per-task and
// human-gated. Tasks any agent could take (any / unassigned) ride a shared
// "up next" lane rather than being pinned to one line.
type SwTrack = { agentId: string; runs: TaskRun[]; queued: Task[]; parentRunId: string | null };

const swShort = (s: string) => (s.length > 18 ? s.slice(0, 17).trimEnd() + "…" : s);

function SwDiagram({
  project,
  onOpenTask,
}: {
  project: Project;
  onOpenTask: (id: string) => void;
}) {
  const { runs, tasks, fleet } = useStore();
  const mine = agentsForProject(runs, project.id);
  // Upcoming (not-yet-run) work: per-agent queues + a shared "up next" lane.
  const { pinned, shared } = projectQueue(tasks, project.id);
  if (mine.length === 0 && pinned.size === 0 && shared.length === 0) return null;

  // Group runs into tracks by agent; order each track's stations by start time.
  const byAgent = new Map<string, TaskRun[]>();
  for (const r of mine) {
    const k = r.agentId ?? r.id;
    const list = byAgent.get(k) ?? [];
    list.push(r);
    byAgent.set(k, list);
  }
  const tracks: SwTrack[] = [];
  byAgent.forEach((list, agentId) => {
    list.sort((a, b) => a.startedAt - b.startedAt);
    tracks.push({ agentId, runs: list, queued: pinned.get(agentId) ?? [], parentRunId: list[0]!.parentId ?? null });
  });
  // An agent with a pinned queue but no runs yet still gets a track, so its
  // upcoming work is visible before it has started anything.
  pinned.forEach((queued, agentId) => {
    if (!byAgent.has(agentId)) tracks.push({ agentId, runs: [], queued, parentRunId: null });
  });
  const trackOfRun = (runId: string) => tracks.find((t) => t.runs.some((r) => r.id === runId));
  const parentOf = (t: SwTrack) => (t.parentRunId ? trackOfRun(t.parentRunId) : undefined);
  const childrenOf = (t: SwTrack) => tracks.filter((x) => parentOf(x) === t);

  // Row 0 = the first agent assigned (the backbone: START → its tasks → END).
  // DFS pre-order: each root — earliest first — followed by its fork descendants.
  const bornAt = (t: SwTrack) => t.runs[0]?.startedAt ?? Infinity; // queue-only tracks sort last
  const order: SwTrack[] = [];
  const walk = (t: SwTrack) => {
    order.push(t);
    childrenOf(t)
      .sort((a, b) => bornAt(a) - bornAt(b))
      .forEach(walk);
  };
  tracks
    .filter((t) => !parentOf(t))
    .sort((a, b) => bornAt(a) - bornAt(b))
    .forEach(walk);
  tracks.filter((t) => !order.includes(t)).forEach((t) => order.push(t)); // orphaned forks
  const rowOf = (t: SwTrack) => order.indexOf(t);

  // Columns: START = col 0; every track fans from START at col 1, except a fork
  // which starts one column past its junction (the parent run's station).
  const baseCol = new Map<SwTrack, number>();
  const junctionCol = new Map<SwTrack, number>();
  for (const t of order) {
    const p = parentOf(t);
    if (!p) {
      baseCol.set(t, 1);
      continue;
    }
    const j = Math.max(0, p.runs.findIndex((r) => r.id === t.parentRunId));
    const jc = (baseCol.get(p) ?? 1) + j;
    junctionCol.set(t, jc);
    baseCol.set(t, jc + 1);
  }
  // Merge is leaf-first: a track merges into END only when its own runs AND every
  // child track are complete.
  const completeMemo = new Map<SwTrack, boolean>();
  const isComplete = (t: SwTrack): boolean => {
    const m = completeMemo.get(t);
    if (m !== undefined) return m;
    const v =
      t.queued.length === 0 &&
      t.runs.length > 0 &&
      t.runs.every((r) => r.status === "done") &&
      childrenOf(t).every(isComplete);
    completeMemo.set(t, v);
    return v;
  };
  // Parent stations a fork branched from → mark "re-pointed".
  const junctions = new Set<string>();
  for (const t of order) {
    const p = parentOf(t);
    if (p) junctions.add(p.agentId + ":" + ((junctionCol.get(t) ?? 0) - (baseCol.get(p) ?? 0)));
  }

  // Stations on a track = its runs (worked) + its queued tasks (up next).
  const stationCount = (t: SwTrack) => t.runs.length + t.queued.length;
  const lastColOf = (t: SwTrack) => (baseCol.get(t) ?? 1) + Math.max(1, stationCount(t)) - 1;
  // The shared "up next" lane fans from START at col 1 → one station per task.
  const sharedLastCol = shared.length;
  const END_COL = Math.max(2, sharedLastCol, ...order.map(lastColOf)) + 1;
  const totalCols = END_COL + 1;
  const X = (c: number) => (c / (totalCols - 1)) * 100;
  const ROW0 = 44,
    ROW_H = 76,
    TY = 28;
  const rowY = (r: number) => ROW0 + r * ROW_H + TY;
  const y0 = rowY(0);

  const laneRow = order.length; // the shared "up next" lane sits below the agents
  const totalRows = order.length + (shared.length ? 1 : 0);
  return (
    <div className="swb" style={{ height: ROW0 + totalRows * ROW_H + 6 + "px" }}>
      {order.map((t, r) => {
        const head = t.runs.find((x) => x.status !== "done") ?? t.runs[t.runs.length - 1];
        const p = parentOf(t);
        const rn = head ? runnerName(head, fleet) : fleet.find((a) => a.id === t.agentId)?.name ?? t.agentId;
        const parentRn = p ? runnerName(p.runs[0]!, fleet) : "";
        const done = t.runs.filter((x) => x.status === "done").length;
        // Sub-line: fork origin / model, else "N queued" for an idle agent with only a queue.
        const sub = p
          ? "⑂ fork of " + parentRn
          : head
            ? head.model
            : t.queued.length + " queued";
        return (
          <div key={t.agentId} className="swb-row" style={{ top: ROW0 + r * ROW_H + "px", height: ROW_H + "px" }}>
            <button className="swb-name" onClick={() => head && onOpenTask(head.id)} disabled={!head}>
              {head ? <StatusDot status={head.status} /> : <span className="sw-dot-idle" title="idle — nothing running yet" />}
              <span className="sw-task-text">
                <span className="sw-tname">{rn}</span>
                <span className={"sw-trunner mono" + (p ? " sw-fork" : "")}>
                  {sub + (isComplete(t) ? " · merged ✓" : "")}
                </span>
              </span>
            </button>
            <span className="swb-count mono">
              {done}/{stationCount(t)}
            </span>
          </div>
        );
      })}
      {shared.length > 0 && (
        <div className="swb-row swb-row-lane" style={{ top: ROW0 + laneRow * ROW_H + "px", height: ROW_H + "px" }}>
          <span className="swb-name swb-name-lane">
            <span className="sw-dot-idle" title="unassigned — any agent may take these" />
            <span className="sw-task-text">
              <span className="sw-tname">up next</span>
              <span className="sw-trunner mono">any agent · backlog</span>
            </span>
          </span>
          <span className="swb-count mono">0/{shared.length}</span>
        </div>
      )}
      <div className="swb-canvas">
        {/* START + END anchors — the first agent's frame; everything lives between them */}
        <span className="swb-anchor swb-start" style={{ left: X(0) + "%", top: y0 + "px" }} title="Project start" />
        <span className="swb-anchor-label mono" style={{ left: X(0) + "%", top: y0 + 13 + "px" }}>
          start
        </span>
        <span
          className={"swb-anchor swb-end" + (order.some(isComplete) ? " swb-end-live" : "")}
          style={{ left: X(END_COL) + "%", top: y0 + "px" }}
          title="Work merges here when done"
        />
        <span className="swb-anchor-label mono" style={{ left: X(END_COL) + "%", top: y0 + 13 + "px" }}>
          ship
        </span>
        {order.map((t, r) => {
          const base = baseCol.get(t) ?? 1;
          const p = parentOf(t);
          const isBackbone = r === 0 && !p;
          const yr = rowY(r);
          const els: ReactNode[] = [];
          // branch in — backbone starts at START; a fork branches at its junction; other agents fan from START
          if (isBackbone) {
            els.push(<span key="in" className="swb-seg" style={{ left: X(0) + "%", width: X(base) - X(0) + "%", top: yr + "px" }} />);
          } else {
            const depCol = p ? (junctionCol.get(t) ?? 0) : 0;
            const depY = p ? rowY(rowOf(p)) : y0;
            els.push(
              <span
                key="in"
                className="swb-elbow"
                style={{ left: X(depCol) + "%", width: X(base) - X(depCol) + "%", top: depY + "px", height: yr - depY + "px" }}
              />,
            );
          }
          // Segments across ALL stations (worked runs, then queued tasks). A
          // segment leading into a queued station is dashed/pending.
          const nStations = stationCount(t);
          for (let i = 1; i < nStations; i++) {
            const prevDone = i - 1 < t.runs.length && t.runs[i - 1]!.status === "done";
            const pending = i >= t.runs.length; // this segment leads into a queued stop
            els.push(
              <span
                key={"seg" + i}
                className={"swb-seg" + (prevDone ? " swb-seg-done" : "") + (pending ? " swb-seg-pending" : "")}
                style={{ left: X(base + i - 1) + "%", width: X(base + i) - X(base + i - 1) + "%", top: yr + "px" }}
              />,
            );
          }
          t.runs.forEach((run, i) => {
            const st = run.status === "done" ? "done" : "cur";
            const rp = junctions.has(t.agentId + ":" + i);
            els.push(
              <button
                key={"st" + i}
                className={"swb-st sw-" + st + (st === "cur" ? " sw-cur-" + run.status : "") + (rp ? " sw-repoint" : "")}
                title={run.name + (rp ? " · forked from here" : "") + " — open task"}
                onClick={() => onOpenTask(run.id)}
                style={{ left: X(base + i) + "%", top: yr + "px" }}
              >
                <span className={"sw-label " + (st === "cur" ? "sw-label-" + run.status : "sw-label-muted")}>{swShort(run.name)}</span>
              </button>,
            );
          });
          // Queued tasks — hollow "up next" stops after the worked runs; not yet a
          // run, so not clickable, but titled with the task and its position.
          t.queued.forEach((task, j) => {
            const col = base + t.runs.length + j;
            els.push(
              <span
                key={"q" + task.id}
                className="swb-st sw-queued"
                title={`${task.text} — queued (#${j + 1} up${task.autoPick ? ", auto-pick" : ""})`}
                style={{ left: X(col) + "%", top: yr + "px" }}
              >
                <span className="sw-label sw-label-queued">{swShort(task.text)}</span>
              </span>,
            );
          });
          // rejoin the main path (END) — ALWAYS drawn so start↔end is connected;
          // grey while the track's subtree is unfinished, green once it merges.
          {
            const done = isComplete(t);
            const lc = lastColOf(t);
            if (isBackbone) {
              els.push(
                <span
                  key="merge"
                  className={"swb-seg" + (done ? " swb-seg-done" : "")}
                  style={{ left: X(lc) + "%", width: X(END_COL) - X(lc) + "%", top: yr + "px" }}
                />,
              );
            } else {
              els.push(
                <span
                  key="merge"
                  className={"swb-fold" + (done ? "" : " swb-fold-pending")}
                  style={{ left: X(lc) + "%", width: X(END_COL) - X(lc) + "%", top: y0 + "px", height: yr - y0 + "px" }}
                />,
              );
            }
          }
          return <Fragment key={t.agentId}>{els}</Fragment>;
        })}
        {/* shared "up next" lane — tasks any agent could take, not pinned to a line */}
        {shared.length > 0 && (() => {
          const yl = rowY(laneRow);
          const els: ReactNode[] = [];
          els.push(
            <span key="lin" className="swb-seg swb-seg-pending" style={{ left: X(0) + "%", width: X(1) - X(0) + "%", top: yl + "px" }} />,
          );
          for (let j = 1; j < shared.length; j++) {
            els.push(
              <span
                key={"lseg" + j}
                className="swb-seg swb-seg-pending"
                style={{ left: X(j) + "%", width: X(j + 1) - X(j) + "%", top: yl + "px" }}
              />,
            );
          }
          shared.forEach((task, j) => {
            els.push(
              <span
                key={"ls" + task.id}
                className="swb-st sw-queued"
                title={`${task.text} — up next (#${j + 1}, any agent${task.autoPick ? ", auto-pick" : ""})`}
                style={{ left: X(1 + j) + "%", top: yl + "px" }}
              >
                <span className="sw-label sw-label-queued">{swShort(task.text)}</span>
              </span>,
            );
          });
          return <Fragment key="lane">{els}</Fragment>;
        })()}
      </div>
    </div>
  );
}

function SubwayView({
  now,
  onOpenTask,
  onOpenProject,
}: {
  now: number;
  onOpenTask: (id: string) => void;
  onOpenProject: (id: string) => void;
}) {
  const { runs, tasks, queue, projects, modules } = useStore();
  const oq = openQueue(queue);
  return (
    <section className="vw">
      <ViewHead
        title="Project lines"
        sub="Every agent fans out from start and merges into end · one line per agent · stations are its tasks · ⑂ a fork branches to a new agent"
      />
      <div className="sw-list">
        {projects.map((p) => {
          const pa = agentsForProject(runs, p.id);
          const allDone = pa.length > 0 && pa.every((a) => a.status === "done");
          const q = oq.find((it) => pa.some((a) => a.id === it.runId));
          const conflictAgent = pa.find(
            (a) =>
              a.status !== "done" &&
              a.modules.some((mod) =>
                runs.some(
                  (o) =>
                    o.id !== a.id &&
                    o.status !== "done" &&
                    familyOf(o) !== familyOf(a) &&
                    o.modules.includes(mod),
                ),
              ),
          );
          const conflictMod = conflictAgent?.modules.find((mod) =>
            runs.some(
              (o) =>
                o.id !== conflictAgent.id &&
                o.status !== "done" &&
                familyOf(o) !== familyOf(conflictAgent) &&
                o.modules.includes(mod),
            ),
          );
          const backlog = tasks.filter((t) => t.projectId === p.id && !t.runId).length;
          return (
            <div key={p.id} className={"sw-proj" + (allDone ? " sw-proj-done" : "")}>
              <div className="sw-proj-head">
                <span className="sw-proj-title">
                  <button className="sw-proj-name" onClick={() => onOpenProject(p.id)}>
                    {p.name} →
                  </button>
                  {backlog > 0 && <span className="sw-proj-sub mono">{backlog} in backlog</span>}
                </span>
                {q && (
                  <span className="expill expill-waiting">
                    ⏸ waiting {fmtWait(waitedSecs(q, now))}
                  </span>
                )}
                {conflictMod && (
                  <span className="expill expill-conflict">
                    ⚠ overlap · {modName(modules, conflictMod)}
                  </span>
                )}
                {allDone && <span className="expill expill-done">✓ shipped</span>}
              </div>
              {pa.length > 0 ? (
                <SwDiagram project={p} onOpenTask={onOpenTask} />
              ) : (
                <div className="kb-empty">
                  {tasks.some((t) => t.projectId === p.id)
                    ? "Tasks in the backlog — assign one to see its run line."
                    : "No tasks yet — add one in the project."}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ─── Roster lens ─────────────────────────────────────────────────────────────

function RosterView({
  now,
  onOpenTask,
  onOpenProject,
  onAssign,
}: {
  now: number;
  onOpenTask: (id: string) => void;
  onOpenProject: (id: string) => void;
  onAssign: () => void;
}) {
  const { runs, queue, fleet, projects, providers } = useStore();
  const busy = runs.filter((a) => a.status !== "done");
  const idle = idleRunners(fleet, runs);
  const oq = openQueue(queue);
  return (
    <section className="vw">
      <ViewHead title="Mission control" sub="Who's working — and on what" />
      <div className="rs-cols">
        <div>
          <div className="ex-sec-head">
            AGENT POOL · {busy.length} busy / {idle.length} idle
          </div>
          <div className="rs-cards">
            {busy.map((a) => {
              const q = oq.find((it) => it.runId === a.id);
              return (
                <button key={a.id} className="rs-card" onClick={() => onOpenTask(a.id)}>
                  <span className="rs-card-top">
                    <StatusDot status={a.status} />
                    <span className="mono rs-id">
                      <Prov info={providerInfo(providers, providerOf(a, fleet))} />{" "}
                      {runnerName(a, fleet)}
                    </span>
                    <span className="rs-model">{a.model}</span>
                  </span>
                  <span className="rs-task">{a.name}</span>
                  <span className="rs-hb mono">
                    ♥{" "}
                    {q
                      ? fmtWait(waitedSecs(q, now))
                      : Math.floor(heartbeatSecs(a, now)) + "s"}{" "}
                    · {a.branch}
                  </span>
                </button>
              );
            })}
            {idle.map((r) => (
              <div key={r.id} className="rs-card rs-card-idle">
                <span className="rs-card-top">
                  <span className="dot dot-idle" />
                  <span className="mono rs-id">
                    <Prov info={providerInfo(providers, r.provider)} /> {r.name}
                  </span>
                  <span className="rs-model">{r.model}</span>
                </span>
                <span className="rs-idle-row">
                  <span>idle {runnerIdleLabel(r, now)}</span>
                  <button className="rs-assign" onClick={onAssign}>
                    Assign task →
                  </button>
                </span>
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="ex-sec-head">ONGOING TASKS · {busy.length}</div>
          <div className="rs-tasks">
            {projects
              .filter((p) =>
                agentsForProject(runs, p.id).some((a) => a.status !== "done"),
              )
              .map((p) => (
                <div key={p.id} className="rs-proj">
                  <button className="rs-proj-name" onClick={() => onOpenProject(p.id)}>
                    {p.name} →
                  </button>
                  {agentsForProject(runs, p.id)
                    .filter((a) => a.status !== "done")
                    .map((a) => {
                      const q = oq.find((it) => it.runId === a.id);
                      return (
                        <button
                          key={a.id}
                          className="rs-task-row"
                          onClick={() => onOpenTask(a.id)}
                        >
                          <StatusDot status={a.status} />
                          <span className="rs-task-main">
                            <span className="rs-task-name">{a.name}</span>
                            <span className="rs-task-step">
                              {stepIdx(a)}/{a.plan.length} · {curStep(a)}
                            </span>
                          </span>
                          <Bar value={a.progress} status={a.status} />
                          <span className={"lg-state lg-state-" + a.status}>
                            {q
                              ? "⏸ " + fmtWait(waitedSecs(q, now))
                              : Math.round(a.progress * 100) + "%"}
                          </span>
                        </button>
                      );
                    })}
                </div>
              ))}
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── Timeline lens ───────────────────────────────────────────────────────────

function TimelineView({
  now,
  onOpenTask,
}: {
  now: number;
  onOpenTask: (id: string) => void;
}) {
  const { runs, queue, projects, deps, fleet } = useStore();
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
      <ViewHead
        title="Today's run"
        sub="What each agent has been doing, where it stalled, and where it's headed"
      />
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
