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
import { MergesView } from "./views/merges";
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
  | "merges"
  | "project"
  | "task"
  | "settings"
  | "acceptance"
  | "simulation"
  | "roadmap"
  | "agentDetail";

const VIEW_LABEL: Record<string, string> = {
  home: "Home",
  projects: "Projects",
  fleet: "Fleet",
  queue: "Inbox",
  audit: "Audit",
  integrations: "Integrations",
  merges: "Ready to merge",
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
  const [projectId, setProjectId] = useState<string | null>(() => route0?.projectId ?? null);
  const [runId, setRunId] = useState<string | null>(() => route0?.runId ?? null);
  const [agentId, setAgentId] = useState<string | null>(() => route0?.agentId ?? null);
  const [from, setFrom] = useState<ViewName>("home");
  const [fromP, setFromP] = useState<ViewName>("home");
  // The project we just created and landed in — signals its view to open the
  // task composer focused, so the operator's next move (add a task) is one keystroke
  // away. Cleared once consumed so re-visiting the project doesn't re-open it.
  const [composeProjectId, setComposeProjectId] = useState<string | null>(null);
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
    const desired = toHash({ view, projectId, runId, agentId });
    if (location.hash !== desired) location.hash = desired;
  }, [view, projectId, runId, agentId]);

  // [w7] Apply hash changes (back/forward, manual edits, shared links).
  //
  // ADDITIVE only: apply the fields the parsed hash actually specifies. An
  // omitted id (`r.runId === undefined` for a `#/project/...` URL, or
  // `r.projectId === undefined` for a `#/agent/...` URL) must NOT null out
  // the corresponding state — the hash form for one view only names its own
  // identity, and the browser also fires hashchange for our OWN writes, so a
  // blanket `setProjectId(r.projectId ?? null)` would clear projectId every
  // time we open a task from a project. That broke the task→back navigation
  // (Back set view="project" but projectId was already null, so the project
  // view rendered the "This project was removed" fallback / bounced back to
  // the projects overview).
  useEffect(() => {
    const onHash = () => {
      const r = parseHash();
      if (!r) return;
      if (r.view) setView(r.view);
      if (r.projectId !== undefined) setProjectId(r.projectId);
      if (r.runId !== undefined) setRunId(r.runId);
      if (r.agentId !== undefined) setAgentId(r.agentId);
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
    const created = await store.createProject(name, goal, opts);
    // Land straight in the new project with its task composer focused — the
    // operator's next step is to fill the backlog. Back goes to the projects list.
    setFromP("projects");
    setComposeProjectId(created.id);
    setProjectId(created.id);
    setView("project");
  };

  const agent = store.runs.find((a) => a.id === runId);
  const project = store.projects.find((p) => p.id === projectId);

  // [w7] Reflect the current view (and its project / agent / run context) in the
  // window title so browser tabs, history, and bookmarks are legible. Declared
  // after agent/project so it can read their resolved names.
  useEffect(() => {
    const label = VIEW_LABEL[view] ?? "Home";
    let ctx: string | null = null;
    if (view === "project") ctx = project?.name ?? null;
    else if (view === "task") ctx = agent?.name ?? null;
    else if (view === "agentDetail")
      ctx = store.fleet.find((f) => f.id === agentId)?.name ?? null;
    document.title = ctx ? `${ctx} · ${label} — Skynet` : `${label} — Skynet`;
  }, [view, project, agent, agentId, store.fleet]);

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
  // onboarding wizard (names the workspace + stands up the fleet against the
  // real backend; GitHub is connected later from Integrations). All hooks above
  // run unconditionally; only the render branches here.
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
          setView={setView}
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
            {store.loaded && view === "merges" && <MergesView onOpenTask={openTask} />}
            {store.loaded && view === "project" && project && (
              <ProjectView
                project={project}
                now={now}
                onOpenTask={openTask}
                onOpenAgent={openAgent}
                onBack={() => setView(fromP)}
                autoCompose={composeProjectId === project.id}
                onComposeConsumed={() => setComposeProjectId(null)}
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
