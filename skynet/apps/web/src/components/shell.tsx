import { useState } from "react";
import type { Agent, Project } from "@skynet/shared";
import { useStore } from "../lib/store";
import {
  fmtWait,
  idleRunners,
  openQueue,
  runnerName,
  waitedSecs,
} from "../lib/derive";
import { StatusDot } from "./common";
import type { ViewName, Lens } from "../App";

export function TitleBar() {
  return (
    <header className="op-titlebar">
      <div className="op-tl">
        <i className="r" />
        <i className="y" />
        <i className="g" />
      </div>
      <div className="op-title">Skynet — Agent Network</div>
      <div className="op-titleright">
        <span className="op-avatar">JD</span>
      </div>
    </header>
  );
}

export function OpSidebar({
  view,
  lens,
  setView,
  setLens,
  onOpenProject,
}: {
  view: ViewName;
  lens: Lens;
  setView: (v: ViewName) => void;
  setLens: (l: Lens) => void;
  onOpenProject: (id: string) => void;
}) {
  const { projects, agents, queue } = useStore();
  const queueCount = openQueue(queue).length;

  const dotColor = (p: Project) => {
    const pa = agents.filter((a) => a.projectId === p.id);
    if (pa.length && pa.every((a) => a.status === "done")) return "var(--faint)";
    if (pa.some((a) => a.status === "waiting" || a.status === "review"))
      return "var(--warn)";
    return "var(--ok)";
  };

  const item = (
    label: string,
    ic: string,
    onClick: () => void,
    active: boolean,
    badge?: number,
  ) => (
    <button className={"op-navitem" + (active ? " on" : "")} onClick={onClick}>
      <span className="ic">{ic}</span> {label}
      {badge != null && badge > 0 && <span className="badge">{badge}</span>}
    </button>
  );

  const live = projects.filter((p) => p.status !== "done");

  return (
    <aside className="op-side">
      <div className="op-ws">
        <span className="op-ws-logo">S</span>
        <span className="op-ws-name">Skynet</span>
        <span className="op-ws-caret">▾</span>
      </div>
      <nav className="op-nav">
        {item(
          "Home",
          "⌂",
          () => {
            setLens("subway");
            setView("home");
          },
          view === "home" && lens !== "timeline",
        )}
        {item("Inbox", "⊙", () => setView("queue"), view === "queue", queueCount)}
        {item("Audit", "❑", () => setView("audit"), view === "audit")}
        {item(
          "Projects",
          "▤",
          () => setView("projects"),
          view === "projects" || view === "project",
        )}
        {item("Fleet", "◇", () => setView("fleet"), view === "fleet")}
        {item("Integrations", "⑂", () => setView("integrations"), view === "integrations")}
        {item(
          "Timeline",
          "▭",
          () => {
            setLens("timeline");
            setView("home");
          },
          view === "home" && lens === "timeline",
        )}
      </nav>
      <div className="op-navsec">PROJECTS</div>
      <div className="op-plist">
        {live.map((p) => (
          <button
            key={p.id}
            className="op-pitem"
            onClick={() => onOpenProject(p.id)}
          >
            <span className="op-pdot" style={{ background: dotColor(p) }} />
            <span className="nm">{p.name}</span>
          </button>
        ))}
      </div>
      <div className="op-side-foot">
        <span className="op-avatar">JD</span>
        <div>
          <div className="who">Jordan Diaz</div>
          <div className="role">Pilot</div>
        </div>
      </div>
    </aside>
  );
}

export function OpStatusBar({
  onOpenAgent,
}: {
  onOpenAgent: (id: string) => void;
}) {
  const { agents, queue, fleet } = useStore();
  const [open, setOpen] = useState<string | null>(null);
  const now = Date.now();

  const running = agents.filter((a) => a.status === "running");
  const blocked = agents.filter(
    (a) => a.status === "waiting" || a.status === "review",
  );
  const busy = agents.filter((a) => a.status !== "done");
  const idle = idleRunners(fleet, agents);
  const oq = openQueue(queue);
  const longest = oq.length ? Math.max(...oq.map((q) => waitedSecs(q, now))) : 0;

  const stat = (key: string, list: Agent[], label: string, dot: string) => (
    <span className="op-sb-wrap">
      <button
        className={"op-sb-stat" + (open === key ? " on" : "")}
        onClick={() => setOpen(open === key ? null : key)}
      >
        <span className={"dot " + dot} />
        <b>{list.length}</b> {label}
      </button>
      {open === key && (
        <span className="op-sb-menu">
          {list.length === 0 && (
            <span className="op-sb-empty">nothing here right now</span>
          )}
          {list.map((a) => (
            <button
              key={a.id}
              className="op-sb-item"
              onClick={() => {
                setOpen(null);
                onOpenAgent(a.id);
              }}
            >
              <StatusDot status={a.status} />
              <span className="nm">{a.name}</span>
              <span className="mono">{runnerName(a, fleet)}</span>
            </button>
          ))}
        </span>
      )}
    </span>
  );

  return (
    <footer className="op-statusbar">
      {stat("running", running, "running", "dot-running")}
      {stat("blocked", blocked, "need you", "dot-waiting")}
      <span className="op-sb-text">
        <b>{busy.length}</b> busy · <b>{idle.length}</b> idle
        {oq.length > 0 && (
          <>
            {" "}
            · longest <b>{fmtWait(longest)}</b>
          </>
        )}
      </span>
      {open && <span className="stat-backdrop" onClick={() => setOpen(null)} />}
      <span className="op-sb-r">
        skynet-net · main · <span className="ok">✓ synced</span> · v2.18.0
      </span>
    </footer>
  );
}
