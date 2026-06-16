// Tower — components: top bar, agent rail, queue, agent detail, map

function fmtWait(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}
function fmtClock(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function StatusDot({ status }) {
  return <span className={'dot dot-' + status}></span>;
}

function Bar({ value, status }) {
  return (
    <div className="bar">
      <div className={'bar-fill bar-' + status} style={{ width: Math.round(value * 100) + '%' }}></div>
    </div>
  );
}

/* ---------- top bar ---------- */
function TopBar({ view, setView, queueCount, agents }) {
  const running = agents.filter(a => a.status === 'running').length;
  const blocked = agents.filter(a => a.status === 'waiting' || a.status === 'review').length;
  return (
    <header className="topbar">
      <div className="brand">
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <rect x="1" y="1" width="16" height="16" rx="2" fill="none" stroke="var(--accent)" strokeWidth="1.5"></rect>
          <path d="M5 6h8M9 6v7" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round"></path>
        </svg>
        <span className="brand-name">TOWER</span>
        <span className="brand-repo">atlas-app · main</span>
      </div>
      <nav className="tabs">
        <button className={view === 'queue' ? 'tab on' : 'tab'} onClick={() => setView('queue')}>
          Queue {queueCount > 0 && <span className="tab-badge">{queueCount}</span>}
          <kbd>Q</kbd>
        </button>
        <button className={view === 'map' ? 'tab on' : 'tab'} onClick={() => setView('map')}>
          Map <kbd>M</kbd>
        </button>
      </nav>
      <div className="topstats">
        <span className="stat"><span className="dot dot-running"></span>{running} running</span>
        <span className="stat"><span className="dot dot-waiting"></span>{blocked} blocked</span>
      </div>
    </header>
  );
}

/* ---------- agent rail ---------- */
function AgentRail({ agents, queue, selectedId, onSelect }) {
  const order = { waiting: 0, review: 1, running: 2, done: 3 };
  const sorted = [...agents].sort((a, b) => order[a.status] - order[b.status]);
  return (
    <aside className="rail" data-screen-label="Agent rail">
      <div className="rail-head">
        <span>AGENTS</span><span className="rail-count">{agents.length}</span>
      </div>
      <div className="rail-list">
        {sorted.map(a => {
          const q = queue.find(it => it.agentId === a.id);
          const now = a.plan.find(p => p.s === 'now');
          return (
            <button key={a.id} className={'agent-row' + (selectedId === a.id ? ' sel' : '')}
                    onClick={() => onSelect(a.id)}>
              <div className="agent-row-top">
                <StatusDot status={a.status} />
                <span className="agent-name">{a.name}</span>
                {a.conflict && <span className="conflict-pip" title="Area conflict">⚠</span>}
              </div>
              <div className="agent-row-sub">
                {q
                  ? <span className="wait-tag">⏸ waiting {fmtWait(q.waited)}</span>
                  : a.status === 'done'
                    ? <span className="done-tag">✓ merged</span>
                    : <span className="step-tag">→ {now ? now.t : '…'}</span>}
              </div>
              <Bar value={a.progress} status={a.status} />
            </button>
          );
        })}
      </div>
    </aside>
  );
}

/* ---------- queue ---------- */
function QueueCard({ item, agent, selected, onResolve, onOpen }) {
  const k = KIND_META[item.kind];
  return (
    <article className={'qcard' + (selected ? ' sel' : '') + (item.leaving ? ' leaving' : '')}
             data-comment-anchor={'queue-' + item.id}>
      <div className="qcard-head">
        <span className="kind-chip" style={{ color: k.color, borderColor: k.color }}>{k.label}</span>
        <button className="qcard-agent" onClick={onOpen}>{agent.name}</button>
        <span className="qcard-wait">{fmtWait(item.waited)}</span>
      </div>
      <h3 className="qcard-title">{item.title}</h3>
      <p className="qcard-why">{item.why}</p>

      {item.command && <pre className="qcard-code">$ {item.command}</pre>}

      {item.steps && (
        <ol className="qcard-steps">
          {item.steps.map((s, i) => <li key={i}>{s}</li>)}
        </ol>
      )}

      {item.diff && (
        <div className="qcard-diff">
          <span className="diff-add">+{item.diff.add}</span>
          <span className="diff-del">−{item.diff.del}</span>
          <span className="diff-files">{item.diff.files.join('  ·  ')}</span>
        </div>
      )}

      {item.options ? (
        <div className="qcard-actions">
          {item.options.map((opt, i) => (
            <button key={i} className={'btn' + (i === item.recommended ? ' btn-primary' : '')}
                    onClick={() => onResolve('option-' + i)}>
              <kbd>{i + 1}</kbd> “{opt}”{i === item.recommended && <span className="rec">rec</span>}
            </button>
          ))}
          <button className="btn btn-ghost" onClick={onOpen}><kbd>↵</kbd> Open agent</button>
        </div>
      ) : (
        <div className="qcard-actions">
          <button className="btn btn-primary" onClick={() => onResolve('approve')}><kbd>A</kbd> Approve</button>
          <button className="btn btn-danger" onClick={() => onResolve('reject')}><kbd>X</kbd> Reject</button>
          <button className="btn btn-ghost" onClick={onOpen}><kbd>↵</kbd> Open agent</button>
        </div>
      )}
    </article>
  );
}

function QueueView({ queue, agents, selectedIdx, onResolve, onOpen, resolvedCount }) {
  const total = queue.reduce((n, it) => n + it.waited, 0);
  return (
    <section className="queue" data-screen-label="HITL Queue">
      <div className="queue-readout">
        <div className="readout-block">
          <span className="readout-num">{queue.length}</span>
          <span className="readout-label">agents waiting<br/>on you</span>
        </div>
        <div className="readout-block">
          <span className="readout-num readout-warn">{fmtClock(total)}</span>
          <span className="readout-label">cumulative<br/>wait time</span>
        </div>
        <div className="readout-block">
          <span className="readout-num readout-ok">{resolvedCount}</span>
          <span className="readout-label">resolved<br/>this session</span>
        </div>
        <div className="readout-hint">
          <kbd>J</kbd><kbd>K</kbd> navigate · <kbd>A</kbd> approve · <kbd>X</kbd> reject · <kbd>↵</kbd> open
        </div>
      </div>
      {queue.length === 0 ? (
        <div className="queue-empty">
          <span className="queue-empty-mark">✓</span>
          <p>Queue clear — every agent is working.</p>
        </div>
      ) : (
        <div className="queue-list">
          {queue.map((it, i) => (
            <QueueCard key={it.id} item={it} agent={agents.find(a => a.id === it.agentId)}
                       selected={i === selectedIdx}
                       onResolve={(action) => onResolve(it.id, action)}
                       onOpen={() => onOpen(it.agentId)} />
          ))}
        </div>
      )}
    </section>
  );
}

/* ---------- agent detail ---------- */
function AgentDetail({ agent, queue, onResolve, onBack }) {
  const q = queue.find(it => it.agentId === agent.id);
  const doneCount = agent.plan.filter(p => p.s === 'done').length;
  return (
    <section className="detail" data-screen-label={'Agent: ' + agent.name}>
      <div className="detail-head">
        <button className="btn btn-ghost btn-back" onClick={onBack}>← Queue</button>
        <div className="detail-title">
          <StatusDot status={agent.status} />
          <h2>{agent.name}</h2>
          <span className="status-word" style={{ color: STATUS_META[agent.status].color }}>
            {STATUS_META[agent.status].label}
          </span>
        </div>
        <div className="detail-meta">
          <span className="mono">{agent.branch}</span>
          <span>{agent.model}</span>
          <span>{Math.floor(agent.startedMin / 60) > 0 ? Math.floor(agent.startedMin / 60) + 'h ' : ''}{agent.startedMin % 60}m elapsed</span>
        </div>
      </div>

      {q && (
        <div className="detail-blocked">
          <span className="kind-chip" style={{ color: KIND_META[q.kind].color, borderColor: KIND_META[q.kind].color }}>
            {KIND_META[q.kind].label}
          </span>
          <span className="detail-blocked-title">{q.title}</span>
          <span className="qcard-wait">{fmtWait(q.waited)}</span>
          {q.options ? q.options.map((opt, i) => (
            <button key={i} className={'btn' + (i === q.recommended ? ' btn-primary' : '')}
                    onClick={() => onResolve(q.id, 'option-' + i)}>“{opt}”</button>
          )) : (<React.Fragment>
            <button className="btn btn-primary" onClick={() => onResolve(q.id, 'approve')}>Approve</button>
            <button className="btn btn-danger" onClick={() => onResolve(q.id, 'reject')}>Reject</button>
          </React.Fragment>)}
        </div>
      )}

      {agent.conflict && (
        <div className="detail-conflict">
          ⚠ Overlap in <span className="mono">{agent.conflict}</span> — also being modified by{' '}
          {AGENTS.filter(a => a.conflict === agent.conflict && a.id !== agent.id).map(a => a.name).join(', ')}.
          Coordinate before merge.
        </div>
      )}

      <div className="detail-cols">
        <div className="panel">
          <div className="panel-head">PLAN <span className="panel-sub">{doneCount}/{agent.plan.length}</span></div>
          <ol className="plan">
            {agent.plan.map((p, i) => (
              <li key={i} className={'plan-step ' + p.s}>
                <span className="plan-mark">{p.s === 'done' ? '✓' : p.s === 'now' ? '▸' : '·'}</span>
                {p.t}
              </li>
            ))}
          </ol>
          <div className="panel-head">FILES TOUCHED <span className="panel-sub">{agent.files.length}</span></div>
          <ul className="filelist">
            {agent.files.map((f, i) => (
              <li key={i} className="mono">
                {f}
                {agent.conflict && f.startsWith(agent.conflict) && <span className="conflict-pip"> ⚠</span>}
              </li>
            ))}
          </ul>
        </div>
        <div className="panel panel-log">
          <div className="panel-head">LIVE LOG</div>
          <div className="log">
            {agent.log.map((l, i) => (
              <div key={i} className={'log-line' + (l.includes('⏸') ? ' log-hitl' : l.includes('⚠') ? ' log-warn' : '')}>{l}</div>
            ))}
            {agent.status === 'running' && <div className="log-line log-cursor">▌</div>}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------- map ---------- */
function MapView({ agents, queue, onOpen }) {
  return (
    <section className="map" data-screen-label="Work map">
      <div className="map-head">
        <h2>Work map</h2>
        <p>Who owns what right now. Two agents in one area = potential double work.</p>
      </div>
      <div className="map-grid">
        {AREAS.map(area => {
          const owners = agents.filter(a => a.areas.includes(area.id) && a.status !== 'done');
          const conflict = owners.length > 1;
          return (
            <div key={area.id} className={'area' + (conflict ? ' area-conflict' : '') + (owners.length === 0 ? ' area-idle' : '')}
                 data-comment-anchor={'area-' + area.id}>
              <div className="area-top">
                <span className="area-name mono">{area.id}</span>
                <span className="area-files">{area.files} files</span>
              </div>
              {conflict && <div className="area-warn">⚠ CONFLICT — {owners.length} agents in this area</div>}
              {owners.length === 0
                ? <div className="area-free">unclaimed</div>
                : owners.map(a => {
                    const q = queue.find(it => it.agentId === a.id);
                    return (
                      <button key={a.id} className="area-agent" onClick={() => onOpen(a.id)}>
                        <StatusDot status={a.status} />
                        <span className="area-agent-name">{a.name}</span>
                        <span className="area-agent-state">{q ? '⏸ ' + fmtWait(q.waited) : Math.round(a.progress * 100) + '%'}</span>
                      </button>
                    );
                  })}
            </div>
          );
        })}
      </div>
    </section>
  );
}

Object.assign(window, { TopBar, AgentRail, QueueView, AgentDetail, MapView, fmtWait });
