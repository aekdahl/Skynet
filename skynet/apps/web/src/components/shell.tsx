import { useEffect, useState, type ComponentType, type ReactNode, type SVGProps } from "react";
import type { TaskRun, Project } from "@skynet/shared";
import type { WsPhase } from "../lib/client";
import * as api from "../lib/client";
import { useStore, useNow } from "../lib/store";
import {
  fmtWait,
  idleRunners,
  openNowStatus,
  openQueue,
  readyMerges,
  runnerName,
  waitedSecs,
} from "../lib/derive";
import { StatusDot } from "./common";
import { operatorHandle } from "../lib/firstrun";
import { devToolsEnabled } from "../lib/dev";
import { isTypingTarget } from "../lib/keys";
import { useEscapeLayer } from "../lib/escape-stack";
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
  TelemetryIcon,
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
  | "decisionInbox"
  | "audit"
  | "projects"
  | "fleet"
  | "integrations"
  | "merges"
  | "roadmap"
  | "workspaceRoadmap"
  | "autonomyTelemetry"
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
    case "decisionInbox":
      return "decisionInbox";
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
    case "workspaceRoadmap":
      return "workspaceRoadmap";
    case "autonomyTelemetry":
      return "autonomyTelemetry";
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

// TASK 23 hardening — ONE fleet-level banner for "a provider key is out of
// credits/quota", so the operator gets a single signal instead of noticing
// it only as N duplicated per-run billing escalations. Additive: the
// per-run escalations still exist and are still each individually
// actionable (a run may need reassigning, not just a top-up); this is
// visibility on top, not a replacement. Polled — no WS event exists for a
// key-breaker trip/clear (it's in-memory on the Orchestrator, unlike the
// durable per-project autonomy breaker TASK 19 built).
const DEPLETED_KEYS_POLL_MS = 60_000;

export function DepletedKeyBanner() {
  const [keys, setKeys] = useState<api.DepletedKey[]>([]);
  useEffect(() => {
    let live = true;
    const poll = () => api.fetchDepletedKeys().then((k) => live && setKeys(k)).catch(() => undefined);
    poll();
    const id = setInterval(poll, DEPLETED_KEYS_POLL_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);
  if (keys.length === 0) return null;
  return (
    <div className="depleted-keys-bar" role="status" aria-live="polite">
      <span className="depleted-keys-dot" aria-hidden="true" />
      {keys.length === 1
        ? `A provider key is out of credits — ${keys[0]!.reason}. New work is paused on it until it's topped up.`
        : `${keys.length} provider keys are out of credits/quota. New work is paused on each until they're topped up.`}
    </div>
  );
}

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

// TASK 24 — the 4-state nav-row dot: lime (this page has live machine
// activity), human (something is waiting on YOU here), warn (needs a look —
// an anomaly, not a decision), track (nothing happening — the neutral
// default). Distinct from `--warn`'s own documented "rare, singular signal"
// rule (styles.css) — warn here is deliberately scoped to genuine anomalies
// (Integrations' org-owned flag), not ambient status, so it stays rare too.
type NavDot = "lime" | "human" | "warn" | "track";

// Workspace secrets aren't in the live snapshot (fetched on demand — see
// views/integrations.tsx's own `fetchSecrets` calls) — polled here the same
// way DepletedKeyBanner polls /api/depleted-keys, so the Integrations dot
// reflects live state without duplicating that view's own fetch-on-mount.
const INTEGRATIONS_ATTENTION_POLL_MS = 60_000;
function useIntegrationsAttention(): boolean {
  const [flagged, setFlagged] = useState(false);
  useEffect(() => {
    let live = true;
    const poll = () =>
      api
        .fetchSecrets()
        .then(({ secrets }) => {
          if (!live) return;
          // Scoped to what Integrations actually manages (GitHub/Fly), and to
          // the two real "look here" signals TASK 20 built — not orgOwned in
          // isolation, which defaults false on every credential and would be
          // permanently on, defeating the point of a rare warn signal.
          setFlagged(secrets.some((s) => (s.provider === "github" || s.provider === "fly") && (!s.orgOwned || !!s.paused)));
        })
        .catch(() => undefined);
    poll();
    const id = setInterval(poll, INTEGRATIONS_ATTENTION_POLL_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);
  return flagged;
}


// Alt+1..4 → jump to that OPEN NOW row. `e.code` (layout-independent
// "Digit1"..."Digit4"), not `e.key` — Option+1 produces "¡" on a macOS US
// keyboard, not "1", so keying off `.key` would silently never fire there.
const JUMP_KEY_CODE: Record<string, number> = { Digit1: 1, Digit2: 2, Digit3: 3, Digit4: 4 };

export function OpSidebar({
  view,
  setView,
  onOpenProject,
}: {
  view: ViewName;
  setView: (v: ViewName) => void;
  onOpenProject: (id: string) => void;
}) {
  const { projects, runs, queue, fleet, workspaceSettings, readOnly } = useStore();
  const now = useNow(15_000);
  const queueCount = openQueue(queue).length;
  const mergeCount = readyMerges(runs).length;
  const busyCount = fleet.filter((a) => a.status === "busy").length;
  const integrationsAttention = useIntegrationsAttention();
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

  const live = projects.filter((p) => p.status !== "done");
  const anyLiveRun = runs.some((r) => r.status === "running");
  const anyOpenProjectRun = live.some((p) => runs.some((r) => r.projectId === p.id && r.status === "running"));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || isTypingTarget(e.target)) return;
      const n = JUMP_KEY_CODE[e.code];
      const target = n ? live[n - 1] : undefined;
      if (target) {
        e.preventDefault();
        onOpenProject(target.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [live, onOpenProject]);

  const item = (
    label: string,
    Ic: ComponentType<SVGProps<SVGSVGElement>>,
    onClick: () => void,
    active: boolean,
    dot: NavDot,
    badge?: ReactNode,
  ) => (
    <button
      className={"op-navitem" + (active ? " on" : "")}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      // Below the ~1200px icon-rail breakpoint (styles.responsive.css) the
      // visible label collapses to font-size:0 — this native tooltip is
      // what "labels in tooltips" actually means there. Harmless at full
      // width too (a title only ever shows on hover, never alongside
      // already-visible text).
      title={label}
    >
      <span className={"op-navdot op-navdot-" + dot} aria-hidden="true" />
      <span className="ic" aria-hidden="true"><Ic /></span> {label}
      {badge}
    </button>
  );

  const humanBadge = (n: number) => (n > 0 ? <span className="badge badge-human" aria-label={`${n} waiting on you`}>{n}</span> : null);
  const limeOutlineBadge = (n: number) => (n > 0 ? <span className="badge badge-lime-outline" aria-label={`${n} ready to merge`}>{n}</span> : null);
  const monoCount = (n: number) => (n > 0 ? <span className="op-navcount mono">{n}</span> : null);
  const warnDot = (on: boolean) => (on ? <span className="op-navwarn-dot" aria-label="needs attention" title="A connected GitHub/Fly key isn't marked org-owned, or is paused" /> : null);

  return (
    <aside className="op-side">
      <div className="op-ws">
        <span className="op-ws-logo">S</span>
        <span className="op-ws-name">{workspaceSettings?.name || "Skynet"}</span>
      </div>
      <div className="op-navsec">OPERATE</div>
      <nav className="op-nav">
        {item("Home", HomeIcon, () => setView("home"), active === "home", anyLiveRun ? "lime" : "track")}
        {item("Inbox", InboxIcon, () => setView("queue"), active === "queue", queueCount > 0 ? "human" : "track", humanBadge(queueCount))}
        {/* TASK 16 — the new cross-project Decision Inbox, additive alongside
            the existing per-project Inbox above (same relationship Rail Graph
            had to Momentum/Gravity). Same underlying open-queue count — the
            dot is "human" exactly whenever GET /api/decisions would return
            anything open, since `queue` (live via WS) and that endpoint's
            join both read the same open-HitlItem set. */}
        {item("Decisions", InboxIcon, () => setView("decisionInbox"), active === "decisionInbox", queueCount > 0 ? "human" : "track", humanBadge(queueCount))}
        {item("Audit", AuditIcon, () => setView("audit"), active === "audit", "track")}
        {item("Projects", ProjectsIcon, () => setView("projects"), active === "projects", anyOpenProjectRun ? "lime" : "track", monoCount(live.length))}
        {item("Fleet", FleetIcon, () => setView("fleet"), active === "fleet", busyCount > 0 ? "lime" : "track", monoCount(busyCount))}
        {item("Ready to merge", MergeIcon, () => setView("merges"), active === "merges", mergeCount > 0 ? "human" : "track", limeOutlineBadge(mergeCount))}
        {/* TASK 32 — "six repos, one quarter": a workspace-wide roll-up over
            every project's ROADMAP.md the operator already has access to. */}
        {item("Roadmap Roll-up", RoadmapIcon, () => setView("workspaceRoadmap"), active === "workspaceRoadmap", "track")}
        {/* Autonomy telemetry dashboard — ZTMR / HITL gate volume / resolution
            time, read-only rollup over the audit trail + breaker records. */}
        {item("Autonomy Telemetry", TelemetryIcon, () => setView("autonomyTelemetry"), active === "autonomyTelemetry", "track")}
      </nav>
      <div className="op-navsec">CONFIGURE</div>
      <nav className="op-nav">
        {item("Integrations", IntegrationsIcon, () => setView("integrations"), active === "integrations", integrationsAttention ? "warn" : "track", warnDot(integrationsAttention))}
        {/* TEMP (pre-launch): Roadmap shown in ALL builds so it's visible on the
            deployed GCP release. Restore `devTools &&` here + re-add "roadmap" to
            DEV_ONLY_VIEWS (lib/dev) to hide it again before launch. */}
        {item("Roadmap", RoadmapIcon, () => setView("roadmap"), active === "roadmap", "track")}
        {item("Settings", SettingsIcon, () => setView("settings"), active === "settings", "track")}
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
              {item("Acceptance", AcceptanceIcon, () => setView("acceptance"), active === "acceptance", "track")}
              {item("Simulation", SimulationIcon, () => setView("simulation"), active === "simulation", "track")}
              {item("Design tokens", SwatchIcon, () => setView("designTokens"), active === "designTokens", "track")}
            </nav>
          )}
        </>
      )}
      <div className="op-navsec">OPEN NOW</div>
      <div className="op-plist">
        {live.map((p, i) => {
          const status = openNowStatus(p, runs, queue, now);
          return (
            <button key={p.id} className="op-pitem" onClick={() => onOpenProject(p.id)}>
              <span className="nm">{p.name}</span>
              {i < 4 && <span className="op-pkey mono">⌥{i + 1}</span>}
              <span className={"op-pstatus op-pstatus-" + status.dot}>{status.text}</span>
            </button>
          );
        })}
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
  const { runs, queue, fleet, wsPhase } = useStore();
  const [open, setOpen] = useState<string | null>(null);
  const now = Date.now();
  // Whichever per-stat popover is open rides the shared escape-stack
  // (lib/escape-stack.ts) — previously Escape did nothing here at all.
  useEscapeLayer(open !== null, () => setOpen(null));

  // The one shared "we're offline" signal for the whole shell — see this
  // task's own audit: before this, SEVEN separate pages (steward-dock,
  // inbox, autonomy-dial, keys-budget, review-merge, run-detail) each drew
  // their own independent "⚠ RECONNECTING" pill from the same `wsPhase`.
  // Consolidated to exactly one, here, in the always-visible status strip.
  const disconnected = wsPhase !== "open";

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
        {/* Frozen while disconnected — a stale count shouldn't keep pulsing
            as if it's live (the dot's CSS animation is suppressed via
            .op-statusbar--offline, see styles.css). */}
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

  // A single plain-English sentence for screen readers — kept separate from
  // the rich interactive markup above so a live-region announcement reads
  // as one clean update, not a re-read of every button's own state.
  const summary = disconnected
    ? "Reconnecting to mission control — counts frozen, live updates paused."
    : `${busy.length} agents busy, ${idle.length} idle` +
      (oq.length > 0 ? `, longest wait ${fmtWait(longest)}` : "");

  return (
    <footer className={"op-statusbar" + (disconnected ? " op-statusbar--offline" : "")}>
      {stat("running", running, "running", "dot-running")}
      {stat("blocked", blocked, "need you", "dot-waiting")}
      {disconnected ? (
        <span className="op-sb-text op-sb-reconnecting">
          <span className="op-sb-reconnect-dot" aria-hidden="true" /> reconnecting…
        </span>
      ) : (
        <span className="op-sb-text">
          <b>{busy.length}</b> busy · <b>{idle.length}</b> idle
          {oq.length > 0 && (
            <>
              {" "}
              · longest <b>{fmtWait(longest)}</b>
            </>
          )}
        </span>
      )}
      <span className="sr-only" role="status" aria-live="polite">{summary}</span>
      {open && <span className="stat-backdrop" onClick={() => setOpen(null)} aria-hidden="true" />}
    </footer>
  );
}
