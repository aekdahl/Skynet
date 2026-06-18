import { useState } from "react";
import { useNow, useStore } from "./lib/store";
import { TitleBar, OpSidebar, OpStatusBar } from "./components/shell";
import {
  TweaksPanel,
  TweakSection,
  TweakColor,
  TweakRadio,
  TweakToggle,
  useTweaks,
} from "./components/tweaks";
import { HomeView } from "./views/home";
import { OverviewView } from "./views/overview";
import { FleetView } from "./views/fleet";
import { ProjectView } from "./views/project";
import { QueueView } from "./views/queue";
import { AuditView } from "./views/audit";
import { AgentDetail } from "./views/agent";

export type ViewName =
  | "home"
  | "queue"
  | "audit"
  | "projects"
  | "fleet"
  | "project"
  | "agent";
export type Lens = "subway" | "timeline" | "ledger" | "roster";

const VIEW_LABEL: Record<string, string> = {
  home: "Home",
  projects: "Projects",
  fleet: "Fleet",
  queue: "Inbox",
  audit: "Audit",
  project: "Project",
};

export function App() {
  const store = useStore();
  const now = useNow(1000);
  const [t, setTweak] = useTweaks();

  const [view, setView] = useState<ViewName>("home");
  const [lens, setLens] = useState<Lens>("subway");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [from, setFrom] = useState<ViewName>("home");
  const [fromP, setFromP] = useState<ViewName>("home");
  const [selIdx] = useState(0);

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

      <TweaksPanel>
        <TweakSection label="Theme" />
        <TweakColor
          label="Signal accent"
          value={t.accent}
          options={["#FFB224", "#FF6B4A", "#5EA2FF", "#3DD68C"]}
          onChange={(v) => setTweak("accent", v)}
        />
        <TweakSection label="Layout" />
        <TweakRadio
          label="Density"
          value={t.density}
          options={["compact", "regular", "comfy"] as const}
          onChange={(v) => setTweak("density", v)}
        />
        <TweakSection label="Simulation" />
        <TweakToggle
          label="Live activity"
          value={t.live}
          onChange={(v) => setTweak("live", v)}
        />
      </TweaksPanel>
    </div>
  );
}
