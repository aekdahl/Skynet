// Option 1 — Task Ledger: every ongoing task in one flat list

function ExLedger() {
  const groups = [
    { h: 'WAITING ON YOU', s: 'blocked', items: EX_TASKS.filter(t => t.s === 'blocked') },
    { h: 'IN REVIEW', s: 'review', items: EX_TASKS.filter(t => t.s === 'review') },
    { h: 'RUNNING', s: 'active', items: EX_TASKS.filter(t => t.s === 'active') },
  ];
  return (
    <div className="ex-board">
      <ExHead title="Ongoing tasks" sub="7 in flight · 3 waiting on you · 2 agents idle" />
      <div className="lg-table">
        {groups.map(g => (
          <div key={g.h} className="lg-group">
            <div className={'lg-group-head lg-gh-' + g.s}>{g.h} · {g.items.length}</div>
            {g.items.map(t => (
              <div key={t.t} className="lg-row">
                <ExDot s={t.s} />
                <span className="lg-task">{t.t}{t.conflict && <span className="ex-conflict"> ⚠</span>}</span>
                <span className="lg-proj">{t.proj}</span>
                <span className="lg-step">{t.n}/{t.of} · {t.step}</span>
                <ExBar v={t.p} s={t.s} />
                <span className={'lg-state lg-state-' + t.s}>{t.wait ? '⏸ ' + t.wait : Math.round(t.p * 100) + '%'}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
      <footer className="ex-pool">
        <span className="ex-pool-label">AGENTS</span>
        {EX_AGENTS.map(a => (
          <span key={a.n} className={'ex-chip' + (a.s === 'idle' ? ' ex-chip-idle' : '')}>
            <ExDot s={a.s} />
            <span className="mono">{a.n}</span>
            <span className="ex-chip-sub">{a.s === 'idle' ? 'idle ' + a.idle : a.task}</span>
          </span>
        ))}
      </footer>
    </div>
  );
}

// Option 2 — Subway board: each project is a line; stations are steps

function SwLine({ task }) {
  const ringClass = task.s === 'done' ? 'done' : task.s;
  return (
    <div className="sw-task">
      <div className="sw-task-name">
        <ExDot s={task.s} />
        <span>{task.t}</span>
      </div>
      <div className="sw-track">
        {task.steps.map((st, i) => {
          const state = task.s === 'done' || i < task.cur ? 'done' : i === task.cur ? 'cur' : 'todo';
          return (
            <React.Fragment key={i}>
              {i > 0 && <span className={'sw-seg' + (i <= task.cur || task.s === 'done' ? ' sw-seg-done' : '')}></span>}
              <span className={'sw-station sw-' + state + (state === 'cur' ? ' sw-cur-' + ringClass : '')} title={st}>
                {state === 'cur' && <span className={'sw-label sw-label-' + ringClass}>{st}</span>}
                {state === 'done' && i === task.steps.length - 1 && task.s === 'done' && <span className="sw-label sw-label-done">merged ✓</span>}
              </span>
            </React.Fragment>
          );
        })}
      </div>
      <span className="sw-count mono">{task.s === 'done' ? '✓' : (task.cur) + '/' + task.steps.length}</span>
    </div>
  );
}

function ExSubway() {
  return (
    <div className="ex-board">
      <ExHead title="Project lines" sub="Each line is a project · filled stops are done · the lit stop is where the agent is right now" />
      <div className="sw-list">
        {EX_PROJECTS.map(p => (
          <div key={p.name} className={'sw-proj' + (p.done ? ' sw-proj-done' : '')}>
            <div className="sw-proj-head">
              <span className="sw-proj-name">{p.name}</span>
              {p.wait && <ExPill s="blocked">⏸ waiting {p.wait}</ExPill>}
              {p.conflict && <ExPill s="conflict">⚠ overlap · {p.conflict}</ExPill>}
              {p.done && <ExPill s="done">✓ shipped</ExPill>}
            </div>
            {p.tasks.map(t => <SwLine key={t.t} task={t} />)}
          </div>
        ))}
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

Object.assign(window, { ExLedger, ExSubway });
