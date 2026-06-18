// Tower — app wiring, live state, CRUD (projects, tasks, fleet), simulation, tweaks

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": "#FFB224",
  "density": "regular",
  "live": true
}/*EDITMODE-END*/;

const DEFAULT_PLAN = () => [
  { t: 'Scope & plan', s: 'now' },
  { t: 'Implement', s: 'todo' },
  { t: 'Verify', s: 'todo' },
  { t: 'Open PR', s: 'todo' },
];

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [agents, setAgents] = React.useState(AGENTS);
  const [queue, setQueue] = React.useState(QUEUE);
  const [projects, setProjects] = React.useState(PROJECTS);
  const [fleet, setFleet] = React.useState(FLEET);
  // Router state (view | queue | projects | fleet | project | agent) and the home lens
  // (subway | timeline | ledger | roster) are synced to the URL hash for shareable
  // deep links + browser back/forward; reloading a link restores the view. See routing.jsx.
  const { view, setView, lens, setLens, projectId, setProjectId, agentId, setAgentId } = useTowerRouter();
  const [from, setFrom] = React.useState('home');
  const [fromP, setFromP] = React.useState('home');
  const [selIdx, setSelIdx] = React.useState(0);
  const [resolved, setResolved] = React.useState(0);
  const logIdx = React.useRef({});
  const seq = React.useRef(1);

  // expose live projects so helpers (projNameOf) resolve against current state
  window.LIVE_PROJECTS = projects;

  const liveQueue = queue.filter(q => !q.leaving);

  /* ----- live simulation ----- */
  React.useEffect(() => {
    if (!t.live) return;
    const tick = setInterval(() => {
      setQueue(qs => qs.map(q => q.leaving ? q : { ...q, waited: q.waited + 1 }));
    }, 1000);
    const logs = setInterval(() => {
      setAgents(as => as.map(a => {
        if (a.status !== 'running' || !LOG_POOL[a.id]) return a;
        const pool = LOG_POOL[a.id];
        const i = (logIdx.current[a.id] || 0);
        if (i >= pool.length) return { ...a, progress: Math.min(0.97, a.progress + 0.002) };
        logIdx.current[a.id] = i + 1;
        return { ...a, log: [...a.log, pool[i]], progress: Math.min(0.97, a.progress + 0.015) };
      }));
    }, 4000);
    return () => { clearInterval(tick); clearInterval(logs); };
  }, [t.live]);

  /* ----- resolve a queue item ----- */
  const resolve = (id, action) => {
    const item = queue.find(q => q.id === id);
    if (!item || item.leaving) return;
    setQueue(qs => qs.map(q => q.id === id ? { ...q, leaving: true } : q));
    setResolved(n => n + 1);
    setAgents(as => as.map(a => {
      if (a.id !== item.agentId) return a;
      const stamp = '14:3' + Math.floor(Math.random() * 9) + ':0' + Math.floor(Math.random() * 9);
      let line, status = 'running';
      if (action === 'reject') line = stamp + '  ✗ rejected by operator — revising approach';
      else if (action === 'modify') line = stamp + '  ✎ operator adjusted the instruction — resuming';
      else if (action.startsWith('option-')) line = stamp + '  ✓ operator chose: “' + item.options[+action.split('-')[1]] + '” — resuming';
      else if (item.kind === 'diff') { line = stamp + '  ✓ diff approved — merging to main'; status = 'done'; }
      else line = stamp + '  ✓ approved by operator — resuming';
      const plan = status === 'done' ? a.plan.map(p => ({ ...p, s: 'done' })) : a.plan;
      return { ...a, status, log: [...a.log, line], plan, progress: status === 'done' ? 1 : a.progress };
    }));
    setTimeout(() => {
      setQueue(qs => qs.filter(q => q.id !== id));
      setSelIdx(i => Math.max(0, Math.min(i, liveQueue.length - 2)));
    }, 380);
  };

  /* ----- CRUD: projects ----- */
  const createProject = ({ name, goal }) => {
    const id = 'p' + (seq.current++);
    setProjects(ps => [{ id, name, goal, agentIds: [], backlog: [] }, ...ps]);
    setProjectId(id); setFromP('projects'); setView('project');
  };
  const updateProject = (id, patch) => setProjects(ps => ps.map(p => p.id === id ? { ...p, ...patch } : p));
  const deleteProject = (id) => {
    setProjects(ps => ps.filter(p => p.id !== id));
    setView('projects');
  };

  /* ----- CRUD: tasks (backlog) ----- */
  const addTask = (pid, text) => setProjects(ps => ps.map(p => p.id === pid ? { ...p, backlog: [...p.backlog, text] } : p));
  const updateTask = (pid, idx, text) => setProjects(ps => ps.map(p => p.id === pid ? { ...p, backlog: p.backlog.map((t2, i) => i === idx ? text : t2) } : p));
  const deleteTask = (pid, idx) => setProjects(ps => ps.map(p => p.id === pid ? { ...p, backlog: p.backlog.filter((_, i) => i !== idx) } : p));

  // assign a backlog task → spin up a real agent on an idle runner
  const assignTask = (pid, idx) => {
    const proj = projects.find(p => p.id === pid);
    if (!proj) return;
    const text = proj.backlog[idx];
    const idle = window.idleRunners ? window.idleRunners(fleet, agents) : [];
    const runner = idle[0] || fleet[0];
    const aid = 'task-' + (seq.current++);
    window.RUNNERS[aid] = runner ? runner.rn : 'runner-new';
    const newAgent = {
      id: aid, name: text, status: 'running', areas: [], progress: 0.03,
      branch: 'agent/' + text.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24),
      startedMin: 0, model: runner ? runner.model : 'opus-4.5', hb: 0,
      plan: DEFAULT_PLAN(), files: [],
      log: ['just now  ▸ spun up on ' + (runner ? runner.rn : 'runner') + ' — inheriting project context'],
    };
    setAgents(as => [...as, newAgent]);
    setProjects(ps => ps.map(p => p.id === pid ? { ...p, agentIds: [...p.agentIds, aid], backlog: p.backlog.filter((_, i) => i !== idx) } : p));
  };

  /* ----- CRUD: fleet (configure & retire agents) ----- */
  const configureAgent = (r) => setFleet(fs => fs.some(f => f.rn === r.rn) ? fs : [...fs, r]);
  const updateAgent = (rn, patch) => setFleet(fs => fs.map(f => f.rn === rn ? { ...f, ...patch } : f));
  const retireAgent = (rn) => setFleet(fs => fs.filter(f => f.rn !== rn));

  const openAgent = (id) => { setFrom(view === 'agent' ? from : view); setAgentId(id); setView('agent'); };
  const openProject = (id) => { setFromP(view === 'project' || view === 'agent' ? fromP : view); setProjectId(id); setView('project'); };

  const agent = agents.find(a => a.id === agentId);
  const project = projects.find(p => p.id === projectId);
  const VIEW_LABEL = { home: 'Home', projects: 'Projects', fleet: 'Fleet', queue: 'Inbox', project: 'Project' };

  return (
    <div className="app" style={{ '--accent': t.accent }} data-density={t.density}>
      <TitleBar />
      <div className="op-shell">
        <OpSidebar view={view} lens={lens} setView={setView} setLens={setLens}
                   projects={projects} agents={agents} queueCount={liveQueue.length} onOpenProject={openProject} />
        <main className="main">
          <div className="content">
            {view === 'home' && (
            <HomeView projects={projects} agents={agents} queue={liveQueue} fleet={fleet}
                      lens={lens} setLens={setLens} onResolve={resolve}
                      onOpenAgent={openAgent} onOpenProject={openProject} onCreate={createProject}
                      onGoInbox={() => setView('queue')} onConfigureFleet={() => setView('fleet')} />
          )}
          {view === 'projects' && (
            <OverviewView projects={projects} agents={agents} queue={liveQueue}
                          onOpenProject={openProject} onCreate={createProject} />
          )}
          {view === 'fleet' && (
            <FleetView agents={agents} fleet={fleet}
                       onConfigure={configureAgent} onUpdate={updateAgent} onRetire={retireAgent} />
          )}
          {view === 'project' && project && (
            <ProjectView project={project} agents={agents} queue={liveQueue}
                         onResolve={resolve} onOpenAgent={openAgent} onBack={() => setView(fromP)}
                         onUpdateProject={updateProject} onDeleteProject={deleteProject}
                         onAddTask={addTask} onUpdateTask={updateTask} onDeleteTask={deleteTask} onAssignTask={assignTask} />
          )}
          {view === 'project' && !project && (
            <div className="vw"><div className="kb-empty">This project doesn’t exist or was deleted. <button className="kb-assign" onClick={() => setView('projects')}>All projects →</button></div></div>
          )}
          {view === 'queue' && (
            <QueueView queue={queue} agents={agents} selectedIdx={selIdx}
                       onResolve={resolve} onOpen={openAgent} resolvedCount={resolved} />
          )}
          {view === 'agent' && agent && (
            <AgentDetail agent={agent} queue={liveQueue} onResolve={resolve}
                         onBack={() => setView(from === 'agent' ? 'home' : from)} backLabel={VIEW_LABEL[from] || 'Back'} />
          )}
          {view === 'agent' && !agent && (
            <div className="vw"><div className="kb-empty">This agent was retired or completed. <button className="kb-assign" onClick={() => setView('home')}>Back to home →</button></div></div>
          )}
          </div>
        </main>
      </div>
      <OpStatusBar agents={agents} queue={liveQueue} fleet={fleet} onOpenAgent={openAgent} />

      <TweaksPanel>
        <TweakSection label="Theme" />
        <TweakColor label="Signal accent" value={t.accent}
                    options={['#FFB224', '#FF6B4A', '#5EA2FF', '#3DD68C']}
                    onChange={(v) => setTweak('accent', v)} />
        <TweakSection label="Layout" />
        <TweakRadio label="Density" value={t.density} options={['compact', 'regular', 'comfy']}
                    onChange={(v) => setTweak('density', v)} />
        <TweakSection label="Simulation" />
        <TweakToggle label="Live activity" value={t.live} onChange={(v) => setTweak('live', v)} />
      </TweaksPanel>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
