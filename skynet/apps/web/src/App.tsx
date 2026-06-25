import { useEffect, useState } from "react";
import { useNow, useStore } from "./lib/store";
import { initialView, onNavigate } from "./pwa/launch"; // [pwa] Inbox-first launch + push deep-link
import { parseHash, toHash } from "./lib/routing"; // [w7] deep links
import { TitleBar, OpSidebar, OpStatusBar } from "./components/shell";
import { useTweaks } from "./components/tweaks";
import { HomeView } from "./views/home";
import { OverviewView } from "./views/overview";
import { FleetView } from "./views/fleet";
import { ProjectView } from "./views/project";
import { QueueView } from "./views/queue";
import { AuditView } from "./views/audit";
import { AgentDetail } from "./views/agent";
import { SettingsView } from "./views/settings";

export type ViewName =
  | "home"
  | "queue"
  | "audit"
  | "projects"
  | "fleet"
  | "project"
  | "agent"
  | "settings";
export type Lens = "subway" | "timeline" | "ledger" | "roster";

const VIEW_LABEL: Record<string, string> = {
  home: "Home",
  projects: "Projects",
  fleet: "Fleet",
  queue: "Inbox",
  audit: "Audit",
  project: "Project",
  settings: "Settings",
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
  const [agentId, setAgentId] = useState<string | null>(() => route0?.agentId ?? null);
  const [from, setFrom] = useState<ViewName>("home");
  const [fromP, setFromP] = useState<ViewName>("home");
  const [selIdx] = useState(0);

  // [pwa] A push / notification click (relayed by the service worker) or a
  // manifest shortcut navigates the app in-place — usually to the Inbox.
  useEffect(
    () =>
      onNavigate((v, navAgentId) => {
        if (navAgentId) {
          setFrom(v);
          setAgentId(navAgentId);
          setView("agent");
        } else {
          setView(v);
        }
      }),
    [],
  );

  // [w7] Keep the URL hash in sync with router state (shareable deep links).
  useEffect(() => {
    const desired = toHash({ view, lens, projectId, agentId });
    if (location.hash !== desired) location.hash = desired;
  }, [view, lens, projectId, agentId]);

  // [w7] Apply hash changes (back/forward, manual edits, shared links).
  useEffect(() => {
    const onHash = () => {
      const r = parseHash();
      if (!r) return;
      if (r.view) setView(r.view);
      if (r.lens) setLens(r.lens);
      setProjectId(r.projectId ?? null);
      setAgentId(r.agentId ?? null);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const openAgent = (id: string) => {
    setFrom(view === "agent" ? from : view);
    setAgentId(id);
    setView("agent");
  };
  const openProject = (id: string) => {
    setFromP(view === "project" || view === "agent" ? fromP : view);
    setProjectId(id);
    setView("project");
  };

  const createProject = async (name: string, goal: string) => {
    await store.createProject(name, goal);
    setFromP("projects");
    setView("projects");
  };

  const agent = store.agents.find((a) => a.id === agentId);
  const project = store.projects.find((p) => p.id === projectId);

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
            {!store.loaded && (
              <div className="getstarted">
                <div className="gs-inner">
                  <p className="gs-sub">Connecting to mission control…</p>
                </div>
              </div>
            )}
            {store.loaded && view === "home" && (
              <HomeView
                lens={lens}
                setLens={setLens}
                now={now}
                onOpenAgent={openAgent}
                onOpenProject={openProject}
                onCreate={createProject}
                onGoInbox={() => setView("queue")}
                onConfigureFleet={() => setView("fleet")}
              />
            )}
            {store.loaded && view === "projects" && (
              <OverviewView
                now={now}
                onOpenProject={openProject}
                onCreate={createProject}
              />
            )}
            {store.loaded && view === "fleet" && <FleetView />}
            {store.loaded && view === "project" && project && (
              <ProjectView
                project={project}
                now={now}
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
              <QueueView selectedIdx={selIdx} onOpen={openAgent} now={now} />
            )}
            {store.loaded && view === "audit" && (
              <AuditView now={now} onOpenAgent={openAgent} />
            )}
            {store.loaded && view === "settings" && <SettingsView />}
            {store.loaded && view === "agent" && agent && (
              <AgentDetail
                agent={agent}
                now={now}
                onBack={() => setView(from === "agent" ? "home" : from)}
                backLabel={VIEW_LABEL[from] || "Back"}
              />
            )}
            {store.loaded && view === "agent" && !agent && (
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
      <OpStatusBar onOpenAgent={openAgent} />
    </div>
  );
}
