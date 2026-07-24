import { useEffect, useState } from "react";
import { useNow, useStore } from "./lib/store";
import { initialView, onNavigate } from "./pwa/launch"; // [pwa] Inbox-first launch + push deep-link
import { parseHash, toHash } from "./lib/routing"; // [w7] deep links
import { TitleBar, OpSidebar, OpStatusBar, ConnectingShell } from "./components/shell";
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
import { AcceptanceView } from "./views/acceptance";
import { SimulationView } from "./views/simulation";
import { RoadmapView } from "./views/roadmap";

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
  | "roadmap";
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
};

export function App() {
  const store = useStore();
  const now = useNow(1000);
  const [t] = useTweaks();

  // [w7] A URL hash deep-link wins over the PWA launch default.
  const route0 = parseHash();
  const [view, setView] = useState<ViewName>(() => route0?.view ?? initialView() ?? "home");
  const [lens, setLens] = useState<Lens>(() => route0?.lens ?? "subway");
  const [projectId, setProjectId] = useState<string | null>(() => route0?.projectId ?? null);
  const [runId, setRunId] = useState<string | null>(() => route0?.runId ?? null);
  const [from, setFrom] = useState<ViewName>("home");
  const [fromP, setFromP] = useState<ViewName>("home");
  const [selIdx] = useState(0);
  const [onboarded, setOnboarded] = useState(isOnboarded);
  // Re-run setup on demand (from Settings), even after it's been completed/skipped.
  const [rerunSetup, setRerunSetup] = useState(false);

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
    const desired = toHash({ view, lens, projectId, runId });
    if (location.hash !== desired) location.hash = desired;
  }, [view, lens, projectId, runId]);

  // [w7] Apply hash changes (back/forward, manual edits, shared links).
  useEffect(() => {
    const onHash = () => {
      const r = parseHash();
      if (!r) return;
      if (r.view) setView(r.view);
      if (r.lens) setLens(r.lens);
      setProjectId(r.projectId ?? null);
      setRunId(r.runId ?? null);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const openTask = (id: string) => {
    setFrom(view === "task" ? from : view);
    setRunId(id);
    setView("task");
  };
  const openProject = (id: string) => {
    setFromP(view === "project" || view === "task" ? fromP : view);
    setProjectId(id);
    setView("project");
  };

  const createProject = async (name: string, goal: string, opts?: { repo?: string; repoPath?: string }) => {
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
            {store.loaded && view === "fleet" && <FleetView onOpenTask={openTask} />}
            {store.loaded && view === "integrations" && <IntegrationsView />}
            {store.loaded && view === "project" && project && (
              <ProjectView
                project={project}
                now={now}
                onOpenTask={openTask}
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
      <OpStatusBar onOpenTask={openTask} />
    </div>
  );
}
