import { useCallback, useEffect, useState } from "react";
import { useNow, useStore } from "./lib/store";
import { initialView, onNavigate } from "./pwa/launch"; // [pwa] Inbox-first launch + push deep-link
import { parseHash, toHash } from "./lib/routing"; // [w7] deep links
import { gateView } from "./lib/dev"; // dev-only pages hidden from release builds
import { TitleBar, OpSidebar, OpStatusBar, ConnectingShell } from "./components/shell";
import { StewardDock } from "./components/steward-dock";
import { useTweaks } from "./components/tweaks";
import { HomeView } from "./views/home";
import { OverviewView } from "./views/overview";
import { FleetView } from "./views/fleet";
import { ProjectView } from "./views/project";
import { QueueView } from "./views/queue";
import { AuditView } from "./views/audit";
import { TaskDetail } from "./views/task";
import { IntegrationsView } from "./views/integrations";
import { Onboarding } from "./views/onboarding";
import { isOnboarded } from "./lib/firstrun";
import { SettingsView } from "./views/settings";
import { LoginView } from "./views/login";
import { AcceptanceView } from "./views/acceptance";
import { SimulationView } from "./views/simulation";
import { RoadmapView } from "./views/roadmap";
import { AgentDetailView } from "./views/agent-detail";

export type ViewName =
  | "home"
  | "queue"
  | "audit"
  | "projects"
  | "fleet"
  | "integrations"
  | "project"
  | "task"
  | "settings"
  | "acceptance"
  | "simulation"
  | "roadmap"
  | "agentDetail";
export type Lens = "subway" | "timeline" | "ledger" | "roster";

const VIEW_LABEL: Record<string, string> = {
  home: "Home",
  projects: "Projects",
  fleet: "Fleet",
  queue: "Inbox",
  audit: "Audit",
  integrations: "Integrations",
  project: "Project",
  settings: "Settings",
  acceptance: "Acceptance",
  simulation: "Simulation",
  roadmap: "Roadmap",
  agentDetail: "Agent",
};

export function App() {
  const store = useStore();
  const now = useNow(1000);
  const [t] = useTweaks();

  // [w7] A URL hash deep-link wins over the PWA launch default.
  const route0 = parseHash();
  // setView is gated: a dev-only view (see lib/dev) coerces to "home" on a
  // release build, so a deep link / stale hash / PWA nav can't reach it. Every
  // navigation path flows through here, so guarding it once covers them all.
  const [view, setViewRaw] = useState<ViewName>(() => gateView(route0?.view ?? initialView() ?? "home"));
  const setView = useCallback((v: ViewName) => setViewRaw(gateView(v)), []);
  const [lens, setLens] = useState<Lens>(() => route0?.lens ?? "subway");
  const [projectId, setProjectId] = useState<string | null>(() => route0?.projectId ?? null);
  const [runId, setRunId] = useState<string | null>(() => route0?.runId ?? null);
  const [agentId, setAgentId] = useState<string | null>(() => route0?.agentId ?? null);
  const [from, setFrom] = useState<ViewName>("home");
  const [fromP, setFromP] = useState<ViewName>("home");
  const [selIdx] = useState(0);
  const [onboarded, setOnboarded] = useState(isOnboarded);
  // Re-run setup on demand (from Settings), even after it's been completed/skipped.
  const [rerunSetup, setRerunSetup] = useState(false);
  // Steward dock — a chat available on every page. When open it collapses the left
  // nav to an icon rail (root class), reclaiming width for the conversation.
  const [stewardOpen, setStewardOpen] = useState(false);
  useEffect(() => {
    document.documentElement.classList.toggle("steward-open", stewardOpen);
    return () => document.documentElement.classList.remove("steward-open");
  }, [stewardOpen]);

  // [pwa] A push / notification click (relayed by the service worker) or a
  // manifest shortcut navigates the app in-place — usually to the Inbox.
  useEffect(
    () =>
      onNavigate((v, navRunId) => {
        if (navRunId) {
          setFrom(v);
          setRunId(navRunId);
          setView("task");
        } else {
          setView(v);
        }
      }),
    [],
  );

  // [w7] Keep the URL hash in sync with router state (shareable deep links).
  useEffect(() => {
    const desired = toHash({ view, lens, projectId, runId, agentId });
    if (location.hash !== desired) location.hash = desired;
  }, [view, lens, projectId, runId, agentId]);

  // [w7] Apply hash changes (back/forward, manual edits, shared links).
  useEffect(() => {
    const onHash = () => {
      const r = parseHash();
      if (!r) return;
      if (r.view) setView(r.view);
      if (r.lens) setLens(r.lens);
      setProjectId(r.projectId ?? null);
      setRunId(r.runId ?? null);
      setAgentId(r.agentId ?? null);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const openTask = (id: string) => {
    setFrom(view === "task" ? from : view);
    setRunId(id);
    setView("task");
  };
  const openAgent = (id: string) => {
    setAgentId(id);
    setView("agentDetail");
  };
  const openProject = (id: string) => {
    setFromP(view === "project" || view === "task" ? fromP : view);
    setProjectId(id);
    setView("project");
  };

  const createProject = async (
    name: string,
    goal: string,
    opts?: {
      repo?: string;
      repoPath?: string;
      createRepo?: { name: string; private: boolean; owner?: string };
      autonomy?: boolean;
      approvalLevel?: string;
    },
  ) => {
    await store.createProject(name, goal, opts);
    setFromP("projects");
    setView("projects");
  };

  const agent = store.runs.find((a) => a.id === runId);
  const project = store.projects.find((p) => p.id === projectId);

  // Before the first snapshot lands, render a skeleton of the shell with a real
  // connect→connected lifecycle and a retry affordance — never a dead-end
  // "Connecting…" message. The socket auto-reconnects; ConnectingShell surfaces
  // that state and lets the operator force a retry.
  // The server rejected our token (dev token in production, or a wiped/expired
  // session) — sign in rather than spinning on reconnect.
  if (store.wsPhase === "unauthorized") {
    return <LoginView onLogin={store.login} onVerifyMfa={store.verifyMfa} />;
  }

  if (!store.loaded) {
    return <ConnectingShell phase={store.wsPhase} onRetry={store.retry} />;
  }

  // First run: a loaded, empty workspace that hasn't been set up yet → the
  // onboarding wizard (sets up GitHub + fleet against the real backend). All
  // hooks above run unconditionally; only the render branches here.
  if (
    store.loaded &&
    (rerunSetup ||
      (!onboarded && store.projects.length === 0 && store.fleet.length === 0))
  ) {
    return (
      <Onboarding
        onDone={() => {
          setOnboarded(true);
          setRerunSetup(false);
        }}
      />
    );
  }

  // Steward auto-focuses whatever project you're viewing (project page, or the
  // project behind an open run) so it can manage it; elsewhere it's workspace-wide.
  const stewardFocus =
    project ??
    (view === "task" && agent ? store.projects.find((p) => p.id === agent.projectId) : undefined) ??
    null;

  return (
    <div className="app" style={{ "--accent": t.accent } as React.CSSProperties} data-density={t.density}>
      <TitleBar />
      <div className="op-shell">
        <OpSidebar
          view={view}
          lens={lens}
          setView={setView}
          setLens={setLens}
          onOpenProject={openProject}
        />
        <main className="main">
          <div className="content">
            {store.wsPhase === "closed" && (
              <div className="reconnect-bar" role="status" aria-live="polite">
                <span className="reconnect-dot" />
                Connection lost — reconnecting… data may be stale.
                <button className="reconnect-retry" onClick={store.retry}>
                  Retry now
                </button>
              </div>
            )}
            {store.loaded && view === "home" && (
              <HomeView
                lens={lens}
                setLens={setLens}
                now={now}
                onOpenTask={openTask}
                onOpenAgent={openAgent}
                onOpenProject={openProject}
                onCreate={createProject}
                onGoInbox={() => setView("queue")}
                onConfigureFleet={() => setView("fleet")}
                onOpenSettings={() => setView("settings")}
                onAssign={() => setView("projects")}
              />
            )}
            {store.loaded && view === "projects" && (
              <OverviewView
                now={now}
                onOpenProject={openProject}
                onCreate={createProject}
              />
            )}
            {store.loaded && view === "fleet" && (
              <FleetView onOpenTask={openTask} onOpenAgent={openAgent} />
            )}
            {store.loaded && view === "agentDetail" && agentId && (
              <AgentDetailView
                agentId={agentId}
                now={now}
                onBack={() => setView("fleet")}
                onOpenTask={openTask}
              />
            )}
            {store.loaded && view === "integrations" && <IntegrationsView />}
            {store.loaded && view === "project" && project && (
              <ProjectView
                project={project}
                now={now}
                onOpenTask={openTask}
                onOpenAgent={openAgent}
                onBack={() => setView(fromP)}
              />
            )}
            {store.loaded && view === "project" && !project && (
              <div className="vw">
                <div className="kb-empty">
                  This project was removed.{" "}
                  <button className="kb-assign" onClick={() => setView("projects")}>
                    Back to projects →
                  </button>
                </div>
              </div>
            )}
            {store.loaded && view === "queue" && (
              <QueueView selectedIdx={selIdx} onOpen={openTask} now={now} />
            )}
            {store.loaded && view === "audit" && (
              <AuditView now={now} onOpenTask={openTask} />
            )}
            {store.loaded && view === "settings" && (
              <SettingsView onRerunSetup={() => setRerunSetup(true)} />
            )}
            {store.loaded && view === "acceptance" && <AcceptanceView />}
            {store.loaded && view === "simulation" && <SimulationView />}
            {store.loaded && view === "roadmap" && <RoadmapView />}
            {store.loaded && view === "task" && agent && (
              <TaskDetail
                agent={agent}
                now={now}
                onBack={() => setView(from === "task" ? "home" : from)}
                backLabel={VIEW_LABEL[from] || "Back"}
              />
            )}
            {store.loaded && view === "task" && !agent && (
              <div className="vw">
                <div className="kb-empty">
                  This agent was retired or completed.{" "}
                  <button className="kb-assign" onClick={() => setView("home")}>
                    Back to home →
                  </button>
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
      {store.loaded && stewardOpen && (
        <StewardDock
          focusProjectId={stewardFocus?.id ?? null}
          focusProjectName={stewardFocus?.name ?? null}
          onClose={() => setStewardOpen(false)}
        />
      )}
      {store.loaded && !stewardOpen && (
        <button className="steward-fab" onClick={() => setStewardOpen(true)} title="Ask Steward (available on every page)">
          <span className="steward-fab-mark" aria-hidden="true">✦</span> Steward
        </button>
      )}
      <OpStatusBar onOpenTask={openTask} />
    </div>
  );
}
