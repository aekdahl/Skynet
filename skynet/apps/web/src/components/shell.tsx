import { useState, type ComponentType, type SVGProps } from "react";
import type { TaskRun, Project } from "@skynet/shared";
import type { WsPhase } from "../lib/client";
import { useStore, useNow } from "../lib/store";
import {
  fmtWait,
  idleRunners,
  openQueue,
  readyMerges,
  runnerName,
  waitedSecs,
} from "../lib/derive";
import { StatusDot } from "./common";
import { operatorHandle } from "../lib/firstrun";
import { devToolsEnabled } from "../lib/dev";
import type { ViewName } from "../App";
import {
  HomeIcon,
  InboxIcon,
  AuditIcon,
  ProjectsIcon,
  FleetIcon,
  MergeIcon,
  IntegrationsIcon,
  RoadmapIcon,
  SettingsIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  AcceptanceIcon,
  SimulationIcon,
  SwatchIcon,
} from "./icons";

// The single source of truth for the sidebar highlight. Exactly one primary nav
// key is "current" for a given router state (or none), so highlights can never
// accumulate — every item derives its `.on` from `active === <key>`, not from
// its own ad-hoc predicate. Detail views fold onto their parent (project →
// Projects, agentDetail → Fleet) so the highlight is never orphaned.
type NavKey =
  | "home"
  | "queue"
  | "audit"
  | "projects"
  | "fleet"
  | "integrations"
  | "merges"
  | "roadmap"
  | "settings"
  | "acceptance"
  | "simulation"
  | "designTokens";

function activeNav(view: ViewName): NavKey | null {
  switch (view) {
    case "home":
      return "home";
    case "queue":
      return "queue";
    case "audit":
      return "audit";
    case "projects":
    case "project":
      return "projects";
    case "fleet":
    case "agentDetail":
      return "fleet";
    case "integrations":
      return "integrations";
    case "merges":
      return "merges";
    case "roadmap":
      return "roadmap";
    case "settings":
      return "settings";
    case "acceptance":
      return "acceptance";
    case "simulation":
      return "simulation";
    case "designTokens":
      return "designTokens";
    // task detail has no home in the primary nav
    default:
      return null;
  }
}

// In the desktop app the OS draws the real window controls over this bar, so we
// drop our decorative traffic lights and let it act as the window drag region.
const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
const isDesktop = /Electron/i.test(ua);
const isMac = /Mac/i.test(ua);
const isWin = /Windows/i.test(ua);

// Avatar/footer identity reflects the workspace the operator named at setup —
// no fabricated profile. Initials fall back to "S" (Skynet) before onboarding.
const wsInitials = (name: string): string =>
  (
    name
      .trim()
      .split(/\s+/)
      .map((w) => w[0])
      .join("")
      .slice(0, 2) || "S"
  ).toUpperCase();

export function TitleBar() {
  const { workspaceSettings } = useStore();
  const cls =
    "op-titlebar" +
    (isDesktop ? " is-desktop" : "") +
    (isDesktop && isMac ? " is-mac" : "") +
    (isDesktop && isWin ? " is-win" : "");
  return (
    <header className={cls}>
      {/* Column 1: our traffic-light dots in the browser; left empty in the
          desktop app where the OS draws the real controls here. Keep the div
          so the 3-column grid (1fr auto 1fr) stays balanced. */}
      <div className="op-tl">
        {!isDesktop && (
          <>
            <i className="r" />
            <i className="y" />
            <i className="g" />
          </>
        )}
      </div>
      <div className="op-title">Skynet — Agent Network</div>
      <div className="op-titleright">
        <span className="op-avatar">{wsInitials(workspaceSettings?.name ?? "")}</span>
      </div>
    </header>
  );
}

// First paint before the snapshot lands: a skeleton of the real shell plus an
// honest connect→connected lifecycle. When the socket can't be reached we say
// so and offer a Retry, rather than spinning on "Connecting…" forever.
export function ConnectingShell({
  phase,
  onRetry,
}: {
  phase: WsPhase;
  onRetry: () => void;
}) {
  const failed = phase === "closed";
  const status = failed
    ? "Can't reach mission control."
    : phase === "open"
      ? "Connected — loading your workspace…"
      : "Connecting to mission control…";
  const navSkeleton = ["44%", "38%", "34%", "46%", "36%", "40%", "32%"];
  return (
    <div className="app">
      <TitleBar />
      <div className="op-shell">
        <aside className="op-side" aria-hidden="true">
          <div className="op-ws">
            <span className="op-ws-logo">S</span>
            <span className="sk sk-line" style={{ width: "58%" }} />
          </div>
          <div className="op-nav">
            {navSkeleton.map((w, i) => (
              <div key={i} className="op-navitem sk-navitem">
                <span className="sk sk-ic" />
                <span className="sk sk-line" style={{ width: w }} />
              </div>
            ))}
          </div>
        </aside>
        <main className="main">
          <div className="content">
            <div className="connect-state" role="status" aria-live="polite">
              <span className={"connect-dot" + (failed ? " is-off" : "")} />
              <p className="connect-status">{status}</p>
              {failed ? (
                <>
                  <p className="connect-sub">
                    Reconnecting on its own — or retry now if it doesn't come back.
                  </p>
                  <button className="btn btn-primary" onClick={onRetry}>
                    Retry connection
                  </button>
                </>
              ) : (
                <div className="connect-skeleton" aria-hidden="true">
                  <span className="sk sk-block" />
                  <span className="sk sk-block" />
                  <span className="sk sk-block" />
                </div>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

// Time-limited admin promotion (ROADMAP.md) — ADMIN-granted, never
// self-service: shows a countdown when THIS session is currently under a
// live promotion (granted by an admin elsewhere — see settings.tsx's
// "Access" section for the grant UI), else the plain "· Viewer" badge. No
// button here: a viewer has no self-elevate action to trigger.
function ElevateBadge() {
  const { readOnly, elevatedUntil } = useStore();
  const now = useNow(1000);

  if (elevatedUntil && elevatedUntil > now) {
    const left = fmtWait(Math.round((elevatedUntil - now) / 1000));
    return (
      <span className="op-role-elevated" title="Time-limited admin promotion, granted by an admin — reverts to Viewer automatically">
        {" "}
        · Admin ({left} left)
      </span>
    );
  }
  if (!readOnly) return null;
  return <span className="op-role-viewer"> · Viewer</span>;
}

export function OpSidebar({
  view,
  setView,
  onOpenProject,
}: {
  view: ViewName;
  setView: (v: ViewName) => void;
  onOpenProject: (id: string) => void;
}) {
  const { projects, runs, queue, workspaceSettings, readOnly } = useStore();
  const queueCount = openQueue(queue).length;
  const mergeCount = readyMerges(runs).length;
  // Single source of truth for the highlight — see activeNav above.
  const active = activeNav(view);
  // QA & testing surfaces (Acceptance / Simulation) are internal tooling — they
  // stay OUT of the operator nav for GA. Shown only in a dev build, or when
  // opted in on any build via localStorage `skynet.devtools=1`, or when one of
  // their views is already active (a deep link) so the highlight is never
  // orphaned. Auto-expanded when active.
  const qaActive = active === "acceptance" || active === "simulation" || active === "designTokens";
  const devTools = devToolsEnabled();
  const showQa = devTools || qaActive;
  const [qaOpen, setQaOpen] = useState(qaActive);

  const dotColor = (p: Project) => {
    const pa = runs.filter((a) => a.projectId === p.id);
    if (pa.length && pa.every((a) => a.status === "done")) return "var(--faint)";
    if (pa.some((a) => a.status === "waiting" || a.status === "review"))
      return "var(--warn)";
    return "var(--ok)";
  };

  const item = (
    label: string,
    Ic: ComponentType<SVGProps<SVGSVGElement>>,
    onClick: () => void,
    active: boolean,
    badge?: number,
  ) => (
    <button className={"op-navitem" + (active ? " on" : "")} onClick={onClick} aria-current={active ? "page" : undefined}>
      <span className="ic" aria-hidden="true"><Ic /></span> {label}
      {badge != null && badge > 0 && <span className="badge" aria-label={`${badge} pending`}>{badge}</span>}
    </button>
  );

  const live = projects.filter((p) => p.status !== "done");

  return (
    <aside className="op-side">
      <div className="op-ws">
        <span className="op-ws-logo">S</span>
        <span className="op-ws-name">{workspaceSettings?.name || "Skynet"}</span>
      </div>
      <div className="op-navsec">OPERATE</div>
      <nav className="op-nav">
        {item(
          "Home",
          HomeIcon,
          () => setView("home"),
          active === "home",
        )}
        {item("Inbox", InboxIcon, () => setView("queue"), active === "queue", queueCount)}
        {item("Audit", AuditIcon, () => setView("audit"), active === "audit")}
        {item("Projects", ProjectsIcon, () => setView("projects"), active === "projects")}
        {item("Fleet", FleetIcon, () => setView("fleet"), active === "fleet")}
        {item("Ready to merge", MergeIcon, () => setView("merges"), active === "merges", mergeCount)}
      </nav>
      <div className="op-navsec">CONFIGURE</div>
      <nav className="op-nav">
        {item("Integrations", IntegrationsIcon, () => setView("integrations"), active === "integrations")}
        {/* TEMP (pre-launch): Roadmap shown in ALL builds so it's visible on the
            deployed GCP release. Restore `devTools &&` here + re-add "roadmap" to
            DEV_ONLY_VIEWS (lib/dev) to hide it again before launch. */}
        {item("Roadmap", RoadmapIcon, () => setView("roadmap"), active === "roadmap")}
        {item("Settings", SettingsIcon, () => setView("settings"), active === "settings")}
      </nav>
      {showQa && (
        <>
          <button
            className={"op-navsec op-navsec-toggle" + (qaActive ? " on" : "")}
            aria-expanded={qaOpen || qaActive}
            onClick={() => setQaOpen((o) => !o)}
          >
            QA &amp; TESTING
            <span className="op-navsec-caret">
              {qaOpen || qaActive ? <ChevronDownIcon /> : <ChevronRightIcon />}
            </span>
          </button>
          {(qaOpen || qaActive) && (
            <nav className="op-nav op-nav-sub">
              {item("Acceptance", AcceptanceIcon, () => setView("acceptance"), active === "acceptance")}
              {item("Simulation", SimulationIcon, () => setView("simulation"), active === "simulation")}
              {item("Design tokens", SwatchIcon, () => setView("designTokens"), active === "designTokens")}
            </nav>
          )}
        </>
      )}
      <div className="op-navsec">PROJECTS</div>
      <div className="op-plist">
        {live.map((p) => (
          <button
            key={p.id}
            className="op-pitem"
            onClick={() => onOpenProject(p.id)}
          >
            <span className="op-pdot" style={{ background: dotColor(p) }} aria-hidden="true" />
            <span className="nm">{p.name}</span>
          </button>
        ))}
      </div>
      <div
        className="op-side-foot"
        title={operatorHandle() ? `Operator: ${operatorHandle()}${readOnly ? " (read-only viewer)" : ""}` : undefined}
      >
        <span className="op-avatar">{wsInitials(workspaceSettings?.name ?? "")}</span>
        <div>
          <div className="who">{workspaceSettings?.name || "Skynet"}</div>
          <div className="role">
            {operatorHandle() || "Workspace"}
            <ElevateBadge />
          </div>
        </div>
      </div>
    </aside>
  );
}

export function OpStatusBar({
  onOpenTask,
}: {
  onOpenTask: (id: string) => void;
}) {
  const { runs, queue, fleet } = useStore();
  const [open, setOpen] = useState<string | null>(null);
  const now = Date.now();

  const running = runs.filter((a) => a.status === "running");
  const blocked = runs.filter(
    (a) => a.status === "waiting" || a.status === "review",
  );
  const busy = runs.filter((a) => a.status !== "done");
  const idle = idleRunners(fleet, runs);
  const oq = openQueue(queue);
  const longest = oq.length ? Math.max(...oq.map((q) => waitedSecs(q, now))) : 0;

  const stat = (key: string, list: TaskRun[], label: string, dot: string) => (
    <span className="op-sb-wrap">
      <button
        className={"op-sb-stat" + (open === key ? " on" : "")}
        onClick={() => setOpen(open === key ? null : key)}
        aria-expanded={open === key}
      >
        <span className={"dot " + dot} aria-hidden="true" />
        <b>{list.length}</b> {label}
      </button>
      {open === key && (
        <span className="op-sb-menu" role="listbox" aria-label={label}>
          {list.length === 0 && (
            <span className="op-sb-empty">nothing here right now</span>
          )}
          {list.map((a) => (
            <button
              key={a.id}
              className="op-sb-item"
              onClick={() => {
                setOpen(null);
                onOpenTask(a.id);
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
      {open && <span className="stat-backdrop" onClick={() => setOpen(null)} aria-hidden="true" />}
    </footer>
  );
}
