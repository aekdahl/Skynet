import { useCallback, useEffect, useState } from "react";
import { useNow, useStore } from "./lib/store";
import { initialView, onNavigate } from "./pwa/launch"; // [pwa] Inbox-first launch + push deep-link
import { setDesktopBadge, focusDesktopWindow } from "./lib/desktop"; // [desktop] dock badge + window focus, no-op outside Electron
import { openQueue, hitlFor } from "./lib/derive";
import { parseHash, toHash } from "./lib/routing"; // [w7] deep links
import { gateView } from "./lib/dev"; // dev-only pages hidden from release builds
import { TitleBar, OpSidebar, OpStatusBar, ConnectingShell, DepletedKeyBanner } from "./components/shell";
import { StewardDock } from "./components/steward-dock";
import { CommandPalette } from "./components/command-palette";
import { useTweaks } from "./components/tweaks";
import { isTypingTarget } from "./lib/keys";
import { HomeView } from "./views/home";
import { OverviewView } from "./views/overview";
import { FleetView } from "./views/fleet";
import { ProjectView } from "./views/project";
import { QueueView } from "./views/queue";
import { AuditView } from "./views/audit";
import { TaskDetail } from "./views/task";
import { RunDetailView } from "./kanban/run-detail";
import { ReviewMergeView } from "./kanban/review-merge";
import { IntegrationsView } from "./views/integrations";
import { MergesView } from "./views/merges";
import { Onboarding } from "./views/onboarding";
import { isOnboarded } from "./lib/firstrun";
import { SettingsView } from "./views/settings";
import { LoginView } from "./views/login";
import { AcceptanceView } from "./views/acceptance";
import { SimulationView } from "./views/simulation";
import { RoadmapView } from "./views/roadmap";
import { WorkspaceRoadmapView } from "./views/workspace-roadmap";
import { AutonomyTelemetryView } from "./views/autonomy-telemetry";
import { AgentDetailView } from "./views/agent-detail";
import { BakeoffView } from "./views/bakeoff";
import { DesignTokensPreview } from "./views/design-tokens-preview";
import { DecisionInboxView } from "./kanban/inbox";

export type ViewName =
  | "home"
  | "queue"
  | "decisionInbox"
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
  | "workspaceRoadmap"
  | "autonomyTelemetry"
  | "agentDetail"
  | "designTokens"
  | "bakeoff";

const VIEW_LABEL: Record<string, string> = {
  home: "Home",
  projects: "Projects",
  fleet: "Fleet",
  queue: "Inbox",
  decisionInbox: "Decisions",
  audit: "Audit",
  integrations: "Integrations",
  merges: "Ready to merge",
  project: "Project",
  settings: "Settings",
  acceptance: "Acceptance",
  simulation: "Simulation",
  roadmap: "Roadmap",
  workspaceRoadmap: "Roadmap Roll-up",
  autonomyTelemetry: "Autonomy Telemetry",
  agentDetail: "Agent",
  designTokens: "Design tokens",
  bakeoff: "Bake-off",
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
  // Agent chat tabs live HERE, not in the dock, so they survive every navigation
  // — the whole point is that a conversation follows the operator around
  // instead of dying when they click through to look at something.
  const [agentTabs, setAgentTabs] = useState<string[]>([]);
  const [dockTab, setDockTab] = useState<string>("steward");
  const closeAgentTab = useCallback((runId: string) => {
    setAgentTabs((t) => t.filter((id) => id !== runId));
    // Closing the tab you're looking at should land somewhere sensible rather
    // than on a blank pane.
    setDockTab((cur) => (cur === runId ? "steward" : cur));
  }, []);
  // Opened from anywhere (the run page's "Chat in dock") via a custom event —
  // the same idiom the roadmap refresh already uses, and it avoids threading a
  // callback through every view that might want to start a conversation.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const runId = (e as CustomEvent<{ runId?: string }>).detail?.runId;
      if (!runId) return;
      setAgentTabs((t) => (t.includes(runId) ? t : [...t, runId]));
      setDockTab(runId);
      setStewardOpen(true);
    };
    window.addEventListener("skynet:open-agent-chat", onOpen);
    return () => window.removeEventListener("skynet:open-agent-chat", onOpen);
  }, []);

  const [view, setViewRaw] = useState<ViewName>(() => gateView(route0?.view ?? initialView() ?? "home"));
  const setView = useCallback((v: ViewName) => setViewRaw(gateView(v)), []);
  const [projectId, setProjectId] = useState<string | null>(() => route0?.projectId ?? null);
  const [runId, setRunId] = useState<string | null>(() => route0?.runId ?? null);
  const [agentId, setAgentId] = useState<string | null>(() => route0?.agentId ?? null);
  const [bakeoffId, setBakeoffId] = useState<string | null>(() => route0?.bakeoffId ?? null);
  const [from, setFrom] = useState<ViewName>("home");
  const [fromP, setFromP] = useState<ViewName>("home");
  // The project we just created and landed in — signals its view to open the
  // task composer focused, so the operator's next move (add a task) is one keystroke
  // away. Cleared once consumed so re-visiting the project doesn't re-open it.
  const [composeProjectId, setComposeProjectId] = useState<string | null>(null);
  // TASK 21 — a breaker-event source chip's target: `#/project/<id>/autonomy`
  // pre-opens TASK 19's autonomy dial modal, same consume-once pattern as
  // composeProjectId above (the modal's own open/close state takes over
  // once it's mounted).
  const [autonomyOpenProjectId, setAutonomyOpenProjectId] = useState<string | null>(
    () => (route0?.autonomyOpen && route0.projectId ? route0.projectId : null),
  );
  const [selIdx, setSelIdx] = useState(0);
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
  // A "discuss this" button anywhere in the app (e.g. a backlog task card) opens
  // the dock pre-filled with a question — see dispatch in project.tsx's TaskCard.
  const [stewardSeed, setStewardSeed] = useState<{ text: string; nonce: number } | null>(null);
  useEffect(() => {
    const onOpen = (e: Event) => {
      const text = (e as CustomEvent<{ text: string }>).detail?.text ?? "";
      setStewardOpen(true);
      setStewardSeed((prev) => ({ text, nonce: (prev?.nonce ?? 0) + 1 }));
    };
    window.addEventListener("skynet:open-steward", onOpen);
    return () => window.removeEventListener("skynet:open-steward", onOpen);
  }, []);

  // Global keyboard model (Phase 30 hardening) — all skipped while the
  // operator is typing in a text field (isTypingTarget guard):
  //   ⌘K / Ctrl+K  → toggle the command palette
  //   ⌘J / Ctrl+J  → toggle the Steward dock
  //   g then a second key → a page-jump chord, mnemonic off each
  //     destination's real ViewName: i=Inbox(queue), a=Audit, p=Projects,
  //     f=Fleet, m=Merges("ready to merge"). `g` alone arms a ~800ms window
  //     for the second key; any other key (or another modifier combo) in
  //     that window cancels it rather than falling through as a stray "g".
  //   Alt/Option+Left → back, from any detail view that has a "back"
  //     (task/agentDetail) — project.tsx keeps its OWN Alt+Left (skipped
  //     here) since it additionally guards against its own local overlays
  //     (edit forms, confirm dialogs) this global handler has no way to see.
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => {
    let gArmed = false;
    let gTimer: ReturnType<typeof setTimeout> | undefined;
    const disarmG = () => {
      gArmed = false;
      if (gTimer) clearTimeout(gTimer);
      gTimer = undefined;
    };
    const G_CHORD_DESTINATIONS: Record<string, ViewName> = { i: "queue", a: "audit", p: "projects", f: "fleet", m: "merges" };

    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) {
        disarmG();
        return;
      }
      const key = e.key.toLowerCase();
      if (key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        disarmG();
        setPaletteOpen((o) => !o);
        return;
      }
      if (key === "j" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        disarmG();
        setStewardOpen((o) => !o);
        return;
      }
      if (e.altKey && e.key === "ArrowLeft") {
        disarmG();
        setViewRaw((v) => {
          if (v === "task") { e.preventDefault(); return gateView(from === "task" ? "home" : from); }
          if (v === "agentDetail") { e.preventDefault(); return gateView("fleet"); }
          if (v === "bakeoff") { e.preventDefault(); return gateView(from === "bakeoff" ? "home" : from); }
          return v; // project (and every top-level view) handles its own Alt+Left, or has no "back"
        });
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) {
        disarmG();
        return;
      }
      if (gArmed) {
        disarmG();
        const dest = G_CHORD_DESTINATIONS[key];
        if (dest) {
          e.preventDefault();
          setView(dest);
        }
        return;
      }
      if (key === "g") {
        gArmed = true;
        gTimer = setTimeout(disarmG, 800);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      disarmG();
    };
  }, [from, setView]);

  // [pwa] A push / notification click (relayed by the service worker) or a
  // manifest shortcut navigates the app in-place — usually to the Inbox.
  // [desktop] Also ask the Electron shell to restore/focus the window — a
  // clicked OS notification lands here whether or not the app was foregrounded,
  // and only the main process can un-minimize/raise it. No-op outside Electron.
  useEffect(
    () =>
      onNavigate((v, navRunId) => {
        focusDesktopWindow();
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

  // [desktop] Keep the dock/taskbar badge in sync with the open HITL count —
  // "waiting-minutes are the product's core currency," so the badge should
  // reflect it live, not just at connect. No-op outside Electron.
  useEffect(() => {
    setDesktopBadge(openQueue(store.queue).length);
  }, [store.queue]);

  // [w7] Keep the URL hash in sync with router state (shareable deep links).
  useEffect(() => {
    const desired = toHash({ view, projectId, runId, agentId, bakeoffId });
    if (location.hash !== desired) location.hash = desired;
  }, [view, projectId, runId, agentId, bakeoffId]);

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
      if (r.bakeoffId !== undefined) setBakeoffId(r.bakeoffId);
      if (r.autonomyOpen && r.projectId) setAutonomyOpenProjectId(r.projectId);
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
  const openBakeoff = (id: string) => {
    setFrom(view === "bakeoff" ? from : view);
    setBakeoffId(id);
    setView("bakeoff");
  };
  // A bake-off started from anywhere in the board (TaskCard, deep inside
  // ProjectView's tree) jumps straight to the comparison view — same
  // dispatch-a-custom-event idiom as "skynet:open-steward"/"skynet:open-agent-chat"
  // above, so this doesn't need a new prop threaded through every intermediate
  // board/column component between here and there.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const id = (e as CustomEvent<{ bakeoffId?: string }>).detail?.bakeoffId;
      if (id) openBakeoff(id);
    };
    window.addEventListener("skynet:open-bakeoff", onOpen);
    return () => window.removeEventListener("skynet:open-bakeoff", onOpen);
  }, [view, from]);
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
      importGithubIssues?: boolean;
      charter?: import("@skynet/shared").ProjectCharter;
      githubCredentialId?: string;
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
            <DepletedKeyBanner />
            {store.loaded && view === "home" && (
              <HomeView
                now={now}
                onOpenTask={openTask}
                onCreate={createProject}
                onConfigureFleet={() => setView("fleet")}
                onOpenSettings={() => setView("settings")}
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
                autoOpenAutonomy={autonomyOpenProjectId === project.id}
                onAutonomyOpenConsumed={() => setAutonomyOpenProjectId(null)}
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
              <QueueView selectedIdx={selIdx} onSelectIdx={setSelIdx} onOpen={openTask} now={now} />
            )}
            {store.loaded && view === "decisionInbox" && (
              <DecisionInboxView onOpenTask={openTask} onOpenProject={openProject} onOpenAudit={() => setView("audit")} now={now} />
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
            {store.loaded && view === "workspaceRoadmap" && <WorkspaceRoadmapView />}
            {store.loaded && view === "autonomyTelemetry" && <AutonomyTelemetryView />}
            {store.loaded && view === "designTokens" && <DesignTokensPreview />}
            {store.loaded && view === "bakeoff" && bakeoffId && (
              <BakeoffView
                bakeoffId={bakeoffId}
                onBack={() => setView(from === "bakeoff" ? "home" : from)}
                onOpenTask={openTask}
              />
            )}
            {store.loaded && view === "task" && agent && (
              store.projects.find((p) => p.id === agent.projectId)?.newBoardEnabled ? (
                (() => {
                  const gate = hitlFor(store.queue, agent.id);
                  const reviewing = gate && (gate.kind === "diff" || gate.kind === "merge" || gate.kind === "verifier");
                  return reviewing ? (
                    <ReviewMergeView
                      agent={agent}
                      now={now}
                      onBack={() => setView(from === "task" ? "home" : from)}
                      backLabel={VIEW_LABEL[from] || "Back"}
                    />
                  ) : (
                    <RunDetailView
                      agent={agent}
                      now={now}
                      onBack={() => setView(from === "task" ? "home" : from)}
                      backLabel={VIEW_LABEL[from] || "Back"}
                    />
                  );
                })()
              ) : (
                <TaskDetail
                  agent={agent}
                  now={now}
                  onBack={() => setView(from === "task" ? "home" : from)}
                  backLabel={VIEW_LABEL[from] || "Back"}
                />
              )
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
      {store.loaded && (
        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          setView={setView}
          onOpenProject={openProject}
        />
      )}
      {store.loaded && stewardOpen && (
        <StewardDock
          focusProjectId={stewardFocus?.id ?? null}
          focusProjectName={stewardFocus?.name ?? null}
          onClose={() => setStewardOpen(false)}
          seedText={stewardSeed?.text}
          seedNonce={stewardSeed?.nonce}
          agentTabs={agentTabs}
          activeTab={dockTab}
          onActivateTab={setDockTab}
          onCloseTab={closeAgentTab}
          onOpenTask={openTask}
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
