import { Fragment, type ReactNode } from "react";
import type { Project, Task, TaskRun } from "@skynet/shared";
import { useStore } from "../lib/store";
import { agentsForProject, projectQueue, runnerName } from "../lib/derive";
import { StatusDot } from "./common";

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
//
// Rendered on the Home "Subway" lens (one per project) and at the top of the
// project detail page (that project's line, above the kanban).
type SwTrack = { agentId: string; runs: TaskRun[]; queued: Task[]; parentRunId: string | null };

const swShort = (s: string) => (s.length > 18 ? s.slice(0, 17).trimEnd() + "…" : s);

export function SwDiagram({
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
        <span
          className={"swb-anchor swb-start" + (order.length > 0 && order.every(isComplete) ? " swb-start-done" : "")}
          style={{ left: X(0) + "%", top: y0 + "px" }}
          title="Project start"
        />
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
            // The leg out of START is traversed once the agent has left it (has a
            // run), so it greens like any segment whose preceding stop is done —
            // START is the always-done origin. (Was stuck grey even when shipped.)
            const departed = t.runs.length > 0;
            els.push(<span key="in" className={"swb-seg" + (departed ? " swb-seg-done" : "")} style={{ left: X(0) + "%", width: X(base) - X(0) + "%", top: yr + "px" }} />);
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
