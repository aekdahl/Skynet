// Option 5 — Timeline: tasks plotted against time, now-line, block markers

const TL_LANES = [
  { proj: 'Payments reliability', bars: [{ t: 'Webhook reconciliation', x: 16, w: 66, fill: 0.72, s: 'blocked', mark: 62 }] },
  { proj: 'Deploy pipeline', bars: [{ t: 'Zero-downtime deploys', x: 56, w: 38, fill: 0.55, s: 'blocked', mark: 76 }] },
  { proj: 'Onboarding revamp', bars: [{ t: 'Flow redesign', x: 8, w: 78, fill: 0.88, s: 'blocked', mark: 75 }] },
  { proj: 'API hardening', bars: [
    { t: 'Rate limiting', x: 4, w: 80, fill: 0.97, s: 'review', mark: 78 },
    { t: 'Token rotation', x: 36, w: 52, fill: 0.84, s: 'active' } ] },
  { proj: 'Frontend platform', bars: [
    { t: 'Token migration', x: 12, w: 76, fill: 0.9, s: 'active', conflict: true },
    { t: 'Dashboard perf', x: 62, w: 30, fill: 0.6, s: 'active' } ] },
  { proj: 'Docs automation', bars: [{ t: 'Changelog automation', x: 2, w: 38, fill: 1, s: 'done' }] },
];

function ExTimeline() {
  const ticks = [{ x: 20, l: '13:00' }, { x: 60, l: '14:00' }, { x: 100, l: '15:00' }];
  return (
    <div className="ex-board">
      <ExHead title="Today's run" sub="What each agent has been doing, where it stalled, and where it's headed" />
      <div className="tl-wrap">
        <div className="tl-axis">
          {ticks.map(t => <span key={t.l} className="tl-tick" style={{ left: t.x + '%' }}>{t.l}</span>)}
          <span className="tl-now-label" style={{ left: '80%' }}>now</span>
        </div>
        <div className="tl-lanes">
          <div className="tl-now" style={{ left: '80%' }}></div>
          {ticks.map(t => <div key={t.l} className="tl-grid" style={{ left: t.x + '%' }}></div>)}
          {TL_LANES.map(lane => (
            <div key={lane.proj} className="tl-lane">
              <span className="tl-proj">{lane.proj}</span>
              <div className="tl-canvas">
                {lane.bars.map(b => (
                  <div key={b.t} className={'tl-bar tl-bar-' + b.s} style={{ left: b.x + '%', width: b.w + '%' }}>
                    <div className="tl-fill" style={{ width: Math.round(b.fill * 100) + '%' }}></div>
                    <span className="tl-bar-label">{b.t}{b.conflict ? ' ⚠' : ''}{b.s === 'done' ? ' ✓' : ''}</span>
                    {b.mark && <span className="tl-mark" style={{ left: b.mark + '%' }} title="Blocked — waiting on you">⏸</span>}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="tl-legend">
        <span><i className="exdot exdot-active"></i> working</span>
        <span><i className="exdot exdot-blocked"></i> blocked — ⏸ marks where it stopped</span>
        <span><i className="exdot exdot-review"></i> awaiting review</span>
        <span><i className="exdot exdot-done"></i> merged</span>
      </div>
      <footer className="ex-pool">
        <span className="ex-pool-label">AGENTS</span>
        {EX_AGENTS.map(a => (
          <span key={a.n} className={'ex-chip' + (a.s === 'idle' ? ' ex-chip-idle' : '')}>
            <ExDot s={a.s} /><span className="mono">{a.n}</span>
            <span className="ex-chip-sub">{a.s === 'idle' ? 'idle ' + a.idle : a.task}</span>
          </span>
        ))}
      </footer>
    </div>
  );
}

function ExApp() {
  return (
    <DesignCanvas>
      <DCSection id="d1" title="1 · Task Ledger" subtitle="Every ongoing task in one flat, scannable list — grouped by what needs you first. Agents (incl. idle) live in a strip at the bottom.">
        <DCArtboard id="opt1" label="Task Ledger" width={1240} height={760}><ExLedger /></DCArtboard>
      </DCSection>
      <DCSection id="d2" title="2 · Subway Board" subtitle="Each project is a transit line: filled stops done, lit stop = current step. Two lines under one project = two agents in parallel.">
        <DCArtboard id="opt2" label="Subway Board" width={1240} height={1120}><ExSubway /></DCArtboard>
      </DCSection>
      <DCSection id="d3" title="3 · Roster Split" subtitle="Agent pool on the left (idle agents surfaced with an assign affordance), ongoing tasks grouped by project on the right.">
        <DCArtboard id="opt3" label="Roster Split" width={1240} height={860}><ExRoster /></DCArtboard>
      </DCSection>
      <DCSection id="d4" title="4 · Control Tower (rethought)" subtitle="What's stopping work, front and center with big wait timers — plus agent capacity, running tasks, and conflicts called out in plain words.">
        <DCArtboard id="opt4b" label="Control Tower" width={1240} height={760}><ExWall /></DCArtboard>
      </DCSection>
      <DCSection id="d5" title="5 · Timeline" subtitle="Tasks plotted against the clock — see how long things run, exactly where they stalled (⏸), and what's near the finish.">
        <DCArtboard id="opt5" label="Timeline" width={1240} height={840}><ExTimeline /></DCArtboard>
      </DCSection>
    </DesignCanvas>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<ExApp />);
