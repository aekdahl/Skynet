// Tower — app wiring, keyboard, live simulation, tweaks

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": "#FFB224",
  "density": "regular",
  "live": true
}/*EDITMODE-END*/;

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [agents, setAgents] = React.useState(AGENTS);
  const [queue, setQueue] = React.useState(QUEUE);
  const [view, setView] = React.useState('queue');          // queue | map | agent
  const [agentId, setAgentId] = React.useState(null);
  const [selIdx, setSelIdx] = React.useState(0);
  const [resolved, setResolved] = React.useState(0);
  const logIdx = React.useRef({});

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

  const openAgent = (id) => { setAgentId(id); setView('agent'); };

  /* ----- keyboard ----- */
  React.useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest('input, textarea, select')) return;
      const key = e.key.toLowerCase();
      if (key === 'q') { setView('queue'); return; }
      if (key === 'm') { setView('map'); return; }
      if (key === 'escape') { setView('queue'); return; }
      if (view !== 'queue' || liveQueue.length === 0) return;
      const sel = liveQueue[Math.min(selIdx, liveQueue.length - 1)];
      if (key === 'j' || key === 'arrowdown') { e.preventDefault(); setSelIdx(i => Math.min(i + 1, liveQueue.length - 1)); }
      else if (key === 'k' || key === 'arrowup') { e.preventDefault(); setSelIdx(i => Math.max(i - 1, 0)); }
      else if (key === 'a' && sel && !sel.options) resolve(sel.id, 'approve');
      else if (key === 'x' && sel && !sel.options) resolve(sel.id, 'reject');
      else if ((key === '1' || key === '2') && sel && sel.options) resolve(sel.id, 'option-' + (+key - 1));
      else if (key === 'enter' && sel) openAgent(sel.agentId);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view, selIdx, liveQueue]);

  const agent = agents.find(a => a.id === agentId);

  return (
    <div className="app" style={{ '--accent': t.accent }} data-density={t.density}>
      <TopBar view={view} setView={setView} queueCount={liveQueue.length} agents={agents} />
      <main className="main">
        <AgentRail agents={agents} queue={liveQueue} selectedId={view === 'agent' ? agentId : null} onSelect={openAgent} />
        <div className="content">
          {view === 'queue' && (
            <QueueView queue={queue} agents={agents} selectedIdx={selIdx}
                       onResolve={resolve} onOpen={openAgent} resolvedCount={resolved} />
          )}
          {view === 'map' && <MapView agents={agents} queue={liveQueue} onOpen={openAgent} />}
          {view === 'agent' && agent && (
            <AgentDetail agent={agent} queue={liveQueue} onResolve={resolve} onBack={() => setView('queue')} />
          )}
        </div>
      </main>

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
