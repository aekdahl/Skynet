// Tower — the five top-level views: Ledger, Subway, Roster, Control, Timeline
// All driven by live state; every row/card drills down to project or agent.

const RUNNERS = {
  billing: 'runner-01', deploy: 'runner-02', onboard: 'runner-03', ratelimit: 'runner-04',
  auth: 'runner-05', tokens: 'runner-06', dashperf: 'runner-07', changelog: 'runner-08',
  'billing-replay': 'runner-01·f1', 'auth-audit': 'runner-05·f1',
};

const runnerBusy = (rn, agents) => agents.some(a => a.status !== 'done' && (RUNNERS[a.id] || '').split('·')[0] === rn);
const idleRunners = (fleet, agents) => fleet.filter(r => !runnerBusy(r.rn, agents));
const provOf = (a, fleet) => {
  const rn = (RUNNERS[a.id] || '').split('·')[0];
  const r = fleet.find(f => f.rn === rn);
  return r ? r.provider : 'claude';
};
function Prov({ p }) {
  const meta = PROVIDERS[p] || PROVIDERS.claude;
  return <span className="prov" style={{ color: meta.color }} title={meta.name}>{meta.glyph}</span>;
}

const projNameOf = (id) => { const ps = window.LIVE_PROJECTS || PROJECTS; const p = ps.find(p => p.agentIds.includes(id)); return p ? p.name : '—'; };
const curStepOf = (a) => { const s = a.plan.find(p => p.s === 'now'); return s ? s.t : 'complete'; };
const stepIdxOf = (a) => { const i = a.plan.findIndex(p => p.s === 'now'); return i < 0 ? a.plan.length : i; };

function ViewHead({ title, sub }) {
  return (
    <div className="vw-head">
      <h1>{title}</h1>
      <p>{sub}</p>
    </div>
  );
}

const VIEW_HELPERS_READY = true;

/* ===== 0 · Home (monitor) — needs-you strip + conflicts + lens switcher ===== */
function GetStarted({ onCreate, onConfigureFleet, repos }) {
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [goal, setGoal] = React.useState('');
  const [repo, setRepo] = React.useState('');
  const hasRepos = (repos || []).length > 0;
  return (
    <div className="getstarted" data-screen-label="Get started">
      <div className="gs-inner">
        <svg className="gs-mark" width="46" height="46" viewBox="0 0 18 18" aria-hidden="true">
          <rect x="1" y="1" width="16" height="16" rx="3" fill="none" stroke="var(--accent)" strokeWidth="1.4"></rect>
          <path d="M5 6h8M9 6v7" stroke="var(--accent)" strokeWidth="1.4" strokeLinecap="round"></path>
        </svg>
        <h1 className="gs-title">Welcome to Tower</h1>
        <p className="gs-sub">Mission control for a team of coding agents. Start with a project — a goal you want the fleet to deliver — then break it into tasks and assign them to runners. Progress shows up here on the home map.</p>
        <div className="gs-steps">
          <div className="gs-step"><span className="gs-num">1</span><div className="gs-step-txt"><b>Create a project</b><span>Name it and describe what “done” looks like.</span></div></div>
          <div className="gs-step"><span className="gs-num">2</span><div className="gs-step-txt"><b>Fill the backlog</b><span>Break the goal into assignable tasks.</span></div></div>
          <div className="gs-step"><span className="gs-num">3</span><div className="gs-step-txt"><b>Assign & monitor</b><span>Spin up agents and watch the lines move.</span></div></div>
        </div>
        {open ? (
          <div className="gs-form">
            <input className="qx-input" autoFocus placeholder="Project name" value={name} onChange={e => setName(e.target.value)}></input>
            <textarea className="qx-input" rows="2" placeholder="Goal — what does done look like?" value={goal} onChange={e => setGoal(e.target.value)}></textarea>
            <window.RepoSelect repos={repos} value={repo} onChange={setRepo} />
            <div className="qx-row">
              <button className="btn btn-primary" disabled={!name.trim() || (hasRepos && !repo)}
                      onClick={() => onCreate({ name: name.trim(), goal: goal.trim() || 'No goal set yet.', repo })}>Create project</button>
              <button className="btn btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <button className="btn btn-primary gs-cta" onClick={() => setOpen(true)}>+ Create your first project</button>
        )}
        <button className="gs-secondary" onClick={onConfigureFleet}>or configure your agent fleet first →</button>
      </div>
    </div>
  );
}

function HomeView({ projects, agents, queue, fleet, lens, setLens, onResolve, onOpenAgent, onOpenProject, onCreate, onGoInbox, onConfigureFleet, repos }) {
  if (projects.length === 0) return <GetStarted onCreate={onCreate} onConfigureFleet={onConfigureFleet} repos={repos} />;

  const blockers = [...queue].sort((a, b) => b.waited - a.waited);
  const areaMap = {};
  agents.filter(a => a.status !== 'done').forEach(a => a.areas.forEach(ar => { (areaMap[ar] = areaMap[ar] || []).push(a); }));
  const famOf = (a) => a.fork || a.id;
  const conflicts = Object.entries(areaMap).filter(([, list]) => new Set(list.map(famOf)).size > 1);
  const LENSES = [['subway', 'Subway'], ['timeline', 'Timeline'], ['ledger', 'Ledger'], ['roster', 'Roster']];

  return (
    <div className="home" data-screen-label="Home">
      <div className="home-bar">
        {blockers.length === 0 ? (
          <div className="needs-strip needs-clear"><span className="dot dot-running"></span> Nothing waiting on you — all agents working.</div>
        ) : (
          <div className="needs-strip">
            <div className="needs-strip-head">
              <span className="needs-strip-title">⏸ NEEDS YOU · {blockers.length} <span className="needs-strip-hint">oldest first</span></span>
              <button className="needs-strip-all" onClick={onGoInbox}>Open Inbox →</button>
            </div>
            <div className="needs-row">
              {blockers.map(item => {
                const k = KIND_META[item.kind];
                return (
                  <button key={item.id} className={'blocker' + (item.waited > 300 ? ' blocker-hot' : '')}
                          onClick={() => onOpenAgent(item.agentId)}>
                    <div className="blocker-top">
                      <span className="blocker-kind" style={{ color: k.color, borderColor: k.color }}>{k.label}</span>
                      <span className="blocker-wait mono">{fmtWait(item.waited)}</span>
                    </div>
                    <span className="blocker-title">{item.title}</span>
                    <div className="blocker-meta mono">{RUNNERS[item.agentId]} · {projNameOf(item.agentId)}</div>
                    <div className="blocker-cta">Review &amp; decide →</div>
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {conflicts.map(([area, list]) => (
          <div key={area} className="home-conflict">
            ⚠ <b>{modName(area)}</b> — {list.map(a => RUNNERS[a.id] + ' (' + a.name + ')').join(' and ')} are both working here.
            <button className="home-conflict-link" onClick={() => onOpenAgent(list[0].id)}>Review →</button>
          </div>
        ))}
        <div className="lens-switch">
          {LENSES.map(([id, label]) => (
            <button key={id} className={'lens-btn' + (lens === id ? ' on' : '')} onClick={() => setLens(id)}>{label}</button>
          ))}
        </div>
      </div>
      <div className="home-lens">
        {lens === 'subway' && <SubwayView agents={agents} queue={queue} projects={projects} onOpenAgent={onOpenAgent} onOpenProject={onOpenProject} />}
        {lens === 'timeline' && <TimelineView agents={agents} queue={queue} projects={projects} onOpenAgent={onOpenAgent} />}
        {lens === 'ledger' && <LedgerView agents={agents} queue={queue} fleet={fleet} onOpenAgent={onOpenAgent} />}
        {lens === 'roster' && <RosterView agents={agents} queue={queue} fleet={fleet} projects={projects} onOpenAgent={onOpenAgent} onOpenProject={onOpenProject} />}
      </div>
    </div>
  );
}

/* ===== 1 · Ledger ===== */
function LedgerView({ agents, queue, fleet, onOpenAgent }) {
  const idle = idleRunners(fleet, agents);
  const groups = [
    { h: 'WAITING ON YOU', s: 'waiting', list: agents.filter(a => a.status === 'waiting') },
    { h: 'IN REVIEW', s: 'review', list: agents.filter(a => a.status === 'review') },
    { h: 'RUNNING', s: 'running', list: agents.filter(a => a.status === 'running') },
  ].filter(g => g.list.length > 0);
  const ongoing = agents.filter(a => a.status !== 'done');
  return (
    <section className="vw" data-screen-label="Ledger">
      <ViewHead title="Ongoing tasks" sub={ongoing.length + ' in flight · ' + queue.length + ' waiting on you · ' + idle.length + ' agents idle'} />
      <div className="lg-table">
        {groups.map(g => (
          <div key={g.h} className="lg-group">
            <div className={'lg-group-head lg-gh-' + g.s}>{g.h} · {g.list.length}</div>
            {g.list.map(a => {
              const q = queue.find(it => it.agentId === a.id);
              return (
                <button key={a.id} className="lg-row" onClick={() => onOpenAgent(a.id)}>
                  <StatusDot status={a.status} />
                  <span className="lg-task">{a.name}{a.conflict && <span className="conflict-pip"> ⚠</span>}</span>
                  <span className="lg-agent mono">{RUNNERS[a.id]}</span>
                  <span className="lg-proj">{projNameOf(a.id)}</span>
                  <span className="lg-step">{stepIdxOf(a)}/{a.plan.length} · {curStepOf(a)}</span>
                  <Bar value={a.progress} status={a.status} />
                  <span className={'lg-state lg-state-' + a.status}>{q ? '⏸ ' + fmtWait(q.waited) : Math.round(a.progress * 100) + '%'}</span>
                </button>
              );
            })}
          </div>
        ))}
        <div className="lg-group">
          <div className="lg-group-head lg-gh-agents">ACTIVE AGENTS · {ongoing.length} — {idle.length} IDLE</div>
          {ongoing.map(a => {
            const q = queue.find(it => it.agentId === a.id);
            return (
              <button key={a.id} className="lg-arow" onClick={() => onOpenAgent(a.id)}>
                <StatusDot status={a.status} />
                <span className="lg-agent-id mono">{RUNNERS[a.id]}</span>
                <span className="lg-model mono">{a.model}</span>
                <span className="lg-step">{a.name}</span>
                <Bar value={a.progress} status={a.status} />
                <span className={'lg-state lg-state-' + a.status}>{q ? '⏸ ' + fmtWait(q.waited) : Math.round(a.progress * 100) + '%'}</span>
              </button>
            );
          })}
          {idle.map(r => (
            <div key={r.rn} className="lg-arow lg-arow-idle">
              <span className="dot dot-idle"></span>
              <span className="lg-agent-id mono">{r.rn}</span>
              <span className="lg-model mono"><Prov p={r.provider} /> {r.model}</span>
              <span className="lg-step">idle — available for work</span>
              <span className="lg-assign">Assign task →</span>
              <span className="lg-state lg-state-idle">{r.idle || 'now'}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ===== 2 · Subway ===== */
function SwDiagram({ project, agents, onOpenAgent }) {
  const tasks = project.agentIds.map(id => agents.find(a => a.id === id));
  const rows = [];
  tasks.filter(t => !t.branchFrom).forEach(m => {
    rows.push(m);
    tasks.filter(t => t.branchFrom && t.branchFrom.parent === m.id).forEach(b => rows.push(b));
  });
  const colsOf = (t) => (t.branchFrom ? t.branchFrom.step + 1 : 0) + t.plan.length;
  const totalCols = Math.max(2, ...rows.map(colsOf));
  const X = (c) => (c / (totalCols - 1)) * 100;
  const ROW_H = 80, TY = 34;
  return (
    <div className="swb" style={{ height: rows.length * ROW_H + 'px' }}>
      {rows.map((t, r) => {
        const cur = stepIdxOf(t);
        const done = t.status === 'done';
        return (
          <div key={t.id} className="swb-row" style={{ top: r * ROW_H + 'px', height: ROW_H + 'px' }}>
            <button className="swb-name" onClick={() => onOpenAgent(t.id)}>
              <StatusDot status={t.status} />
              <span className="sw-task-text">
                <span className="sw-tname">{t.name}</span>
                <span className={'sw-trunner mono' + (t.fork ? ' sw-fork' : '')}>
                  {t.fork ? '⑂ ' + RUNNERS[t.id] + ' · fork of ' + RUNNERS[t.fork] : RUNNERS[t.id] + ' · ' + t.model}
                </span>
              </span>
            </button>
            <span className="swb-count mono">{done ? '✓' : cur + '/' + t.plan.length}</span>
          </div>
        );
      })}
      <div className="swb-canvas">
        {rows.map((t, r) => {
          const off = t.branchFrom ? t.branchFrom.step + 1 : 0;
          const cur = stepIdxOf(t);
          const done = t.status === 'done';
          const els = [];
          if (t.branchFrom) {
            const p = rows.findIndex(x => x.id === t.branchFrom.parent);
            els.push(<span key="el" className="swb-elbow" style={{
              left: X(t.branchFrom.step) + '%',
              width: (X(off) - X(t.branchFrom.step)) + '%',
              top: p * ROW_H + TY + 5 + 'px',
              height: (r - p) * ROW_H - 5 + 'px',
            }}></span>);
          }
          for (let i = 1; i < t.plan.length; i++) {
            els.push(<span key={'s' + i} className={'swb-seg' + (done || i <= cur ? ' swb-seg-done' : '')} style={{
              left: X(off + i - 1) + '%', width: (X(off + i) - X(off + i - 1)) + '%', top: r * ROW_H + TY + 'px',
            }}></span>);
          }
          t.plan.forEach((st, i) => {
            const state = done || i < cur ? 'done' : i === cur ? 'cur' : 'todo';
            els.push(
              <span key={'st' + i}
                    className={'swb-st sw-' + state + (state === 'cur' ? ' sw-cur-' + t.status : '')}
                    title={st.t + ' — new tasks can branch from this step'}
                    style={{ left: X(off + i) + '%', top: r * ROW_H + TY + 'px' }}>
                {state === 'cur' && <span className={'sw-label sw-label-' + t.status}>{st.t}</span>}
                {done && i === t.plan.length - 1 && <span className="sw-label sw-label-done">merged ✓</span>}
              </span>
            );
          });
          return <React.Fragment key={t.id}>{els}</React.Fragment>;
        })}
      </div>
    </div>
  );
}

function SubwayView({ agents, queue, projects, onOpenAgent, onOpenProject }) {
  return (
    <section className="vw" data-screen-label="Subway">
      <ViewHead title="Project lines" sub="Filled stops are done · the lit stop is now · ⑂ branches split off the step they originated from" />
      <div className="sw-list">
        {projects.map(p => {
          const pa = p.agentIds.map(id => agents.find(a => a.id === id)).filter(Boolean);
          const allDone = pa.length > 0 && pa.every(a => a.status === 'done');
          const q = queue.find(it => p.agentIds.includes(it.agentId));
          const conflict = pa.find(a => a.conflict && a.status !== 'done');
          return (
            <div key={p.id} className={'sw-proj' + (allDone ? ' sw-proj-done' : '')}>
              <div className="sw-proj-head">
                <button className="sw-proj-name" onClick={() => onOpenProject(p.id)}>{p.name} →</button>
                {q && <span className="expill expill-waiting">⏸ waiting {fmtWait(q.waited)}</span>}
                {conflict && <span className="expill expill-conflict">⚠ overlap · {modName(conflict.conflict)}</span>}
                {allDone && <span className="expill expill-done">✓ shipped</span>}
              </div>
              {pa.length > 0 && <SwDiagram project={p} agents={agents} onOpenAgent={onOpenAgent} />}
              {pa.length === 0 && <div className="kb-empty">No tasks running yet — assign one from the project's backlog.</div>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* ===== 3 · Roster ===== */
function RosterView({ agents, queue, fleet, projects, onOpenAgent, onOpenProject }) {
  const busy = agents.filter(a => a.status !== 'done');
  const idle = idleRunners(fleet, agents);
  return (
    <section className="vw" data-screen-label="Roster">
      <ViewHead title="Mission control" sub="Who's working — and on what" />
      <div className="rs-cols">
        <div>
          <div className="ex-sec-head">AGENT POOL · {busy.length} busy / {idle.length} idle</div>
          <div className="rs-cards">
            {busy.map(a => {
              const q = queue.find(it => it.agentId === a.id);
              return (
                <button key={a.id} className="rs-card" onClick={() => onOpenAgent(a.id)}>
                  <span className="rs-card-top">
                    <StatusDot status={a.status} />
                    <span className="mono rs-id"><Prov p={provOf(a, fleet)} /> {RUNNERS[a.id]}</span>
                    <span className="rs-model">{a.model}</span>
                  </span>
                  <span className="rs-task">{a.name}</span>
                  <span className="rs-hb mono">♥ {q ? fmtWait(q.waited) : a.hb + 's'} · {a.branch}</span>
                </button>
              );
            })}
            {idle.map(r => (
              <div key={r.rn} className="rs-card rs-card-idle">
                <span className="rs-card-top">
                  <span className="dot dot-idle"></span>
                  <span className="mono rs-id"><Prov p={r.provider} /> {r.rn}</span>
                  <span className="rs-model">{r.model}</span>
                </span>
                <span className="rs-idle-row"><span>idle {r.idle || 'now'}</span><span className="rs-assign">Assign task →</span></span>
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="ex-sec-head">ONGOING TASKS · {busy.length}</div>
          <div className="rs-tasks">
            {projects.filter(p => p.agentIds.some(id => { const a = agents.find(x => x.id === id); return a && a.status !== 'done'; })).map(p => (
              <div key={p.id} className="rs-proj">
                <button className="rs-proj-name" onClick={() => onOpenProject(p.id)}>{p.name} →</button>
                {p.agentIds.map(id => agents.find(a => a.id === id)).filter(a => a && a.status !== 'done').map(a => {
                  const q = queue.find(it => it.agentId === a.id);
                  return (
                    <button key={a.id} className="rs-task-row" onClick={() => onOpenAgent(a.id)}>
                      <StatusDot status={a.status} />
                      <span className="rs-task-main">
                        <span className="rs-task-name">{a.name}</span>
                        <span className="rs-task-step">{stepIdxOf(a)}/{a.plan.length} · {curStepOf(a)}</span>
                      </span>
                      <Bar value={a.progress} status={a.status} />
                      <span className={'lg-state lg-state-' + a.status}>{q ? '⏸ ' + fmtWait(q.waited) : Math.round(a.progress * 100) + '%'}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ===== 4 · Flight Deck ===== */
function CtCard({ item, k, onResolve, onOpenAgent }) {
  const [mode, setMode] = React.useState(null); // null | 'modify' | 'chat'
  const [draft, setDraft] = React.useState('');
  const [msgs, setMsgs] = React.useState([]);
  const send = () => {
    if (!draft.trim()) return;
    setMsgs(m => [...m, { who: 'you', text: draft.trim() }]);
    setDraft('');
    setTimeout(() => setMsgs(m => [...m, { who: 'agent', text: 'To clarify: ' + item.why + ' The checkpoint stays open until you decide.' }]), 700);
  };
  return (
    <div className={'ct-card' + (item.waited > 300 ? ' ct-card-hot' : '')}>
      <div className="ct-timer">{fmtWait(item.waited)}<small>WAITING</small></div>
      <div className="ct-main">
        <div className="ct-head-row">
          <span className="ct-chip" style={{ color: k.color, borderColor: k.color }}>{k.label}</span>
          <button className="ct-meta" onClick={() => onOpenAgent(item.agentId)}>
            {RUNNERS[item.agentId]} · {projNameOf(item.agentId)}
          </button>
        </div>
        <span className="ct-title">{item.title}</span>
        <div className="ct-actions">
          {item.options ? item.options.map((opt, i) => (
            <button key={i} className={'btn' + (i === item.recommended ? ' btn-primary' : '')}
                    onClick={() => onResolve(item.id, 'option-' + i)}>“{opt}”</button>
          )) : (<React.Fragment>
            <button className="btn btn-primary" onClick={() => onResolve(item.id, 'approve')}>Approve</button>
            <button className="btn btn-danger" onClick={() => onResolve(item.id, 'reject')}>Reject</button>
          </React.Fragment>)}
          <button className={'btn btn-ghost' + (mode === 'modify' ? ' btn-lit' : '')} onClick={() => setMode(mode === 'modify' ? null : 'modify')}>Modify</button>
          <button className={'btn btn-ghost' + (mode === 'chat' ? ' btn-lit' : '')} onClick={() => setMode(mode === 'chat' ? null : 'chat')}>Chat</button>
          <button className="btn btn-ghost" onClick={() => onOpenAgent(item.agentId)}>Open agent</button>
        </div>
        {mode === 'modify' && (
          <div className="qx">
            <textarea className="qx-input" rows="2" autoFocus
                      placeholder="Adjust the instruction — the agent resumes with this guidance…"
                      value={draft} onChange={e => setDraft(e.target.value)}></textarea>
            <div className="qx-row">
              <button className="btn btn-primary" onClick={() => onResolve(item.id, 'modify')}>Send &amp; resume</button>
              <button className="btn btn-ghost" onClick={() => setMode(null)}>Cancel</button>
            </div>
          </div>
        )}
        {mode === 'chat' && (
          <div className="qx">
            <div className="qx-thread">
              <div className="qx-msg qx-agent"><span className="qx-who mono">{RUNNERS[item.agentId]}</span>{item.why}</div>
              {msgs.map((m, i) => (
                <div key={i} className={'qx-msg ' + (m.who === 'you' ? 'qx-you' : 'qx-agent')}>
                  <span className="qx-who mono">{m.who === 'you' ? 'you' : RUNNERS[item.agentId]}</span>{m.text}
                </div>
              ))}
            </div>
            <div className="qx-row">
              <input className="qx-input qx-line" placeholder="Discuss before deciding…" value={draft} autoFocus
                     onChange={e => setDraft(e.target.value)} onKeyDown={e => e.key === 'Enter' && send()}></input>
              <button className="btn" onClick={send}>Send</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ControlView({ agents, queue, fleet, onResolve, onOpenAgent }) {
  const running = agents.filter(a => a.status === 'running');
  const idle = idleRunners(fleet, agents);
  const areaMap = {};
  agents.filter(a => a.status !== 'done').forEach(a => a.areas.forEach(ar => { (areaMap[ar] = areaMap[ar] || []).push(a); }));
  const famOf = (a) => a.fork || a.id;
  const conflicts = Object.entries(areaMap).filter(([, list]) => new Set(list.map(famOf)).size > 1);
  const busy = agents.filter(a => a.status !== 'done');
  return (
    <section className="vw" data-screen-label="Control">
      <ViewHead title="Flight deck" sub="First question answered first: what is stopping work right now?" />
      <div className="ct-cols">
        <div>
          <div className="ex-sec-head">NEEDS YOU · {queue.length} — OLDEST FIRST</div>
          <div className="ct-cards">
            {queue.length === 0 && <div className="ct-empty">✓ Nothing waiting — every agent is working.</div>}
            {queue.map(item => {
              const k = KIND_META[item.kind];
              return <CtCard key={item.id} item={item} k={k} onResolve={onResolve} onOpenAgent={onOpenAgent} />;
            })}
          </div>
        </div>
        <div className="ct-right">
          <div>
            <div className="ex-sec-head">AGENT CAPACITY · {busy.length}/{busy.length + idle.length} BUSY</div>
            <div className="ct-cap">
              {busy.map(a => (
                <button key={a.id} className={'ct-seg ct-seg-' + a.status} title={RUNNERS[a.id] + ' · ' + a.name}
                        onClick={() => onOpenAgent(a.id)}>{RUNNERS[a.id].slice(-2)}</button>
              ))}
              {idle.map(r => (
                <span key={r.rn} className="ct-seg ct-seg-idle" title={r.rn + ' · idle ' + (r.idle || 'now')}>{r.rn.slice(-2)}</span>
              ))}
            </div>
            <p className="ct-cap-note">{idle.length} idle — {idle.map(r => r.rn).join(', ') || 'none'} can take new tasks.</p>
          </div>
          <div>
            <div className="ex-sec-head">RUNNING · {running.length}</div>
            <div className="ct-run">
              {running.map(a => (
                <button key={a.id} className="ct-run-row" onClick={() => onOpenAgent(a.id)}>
                  <StatusDot status={a.status} />
                  <span className="ct-run-main">
                    <span className="ct-run-name">{a.name}</span>
                    <span className="ct-run-step">{stepIdxOf(a)}/{a.plan.length} · {curStepOf(a)}</span>
                  </span>
                  <Bar value={a.progress} status={a.status} />
                  <span className="ct-run-pct mono">{Math.round(a.progress * 100)}%</span>
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="ex-sec-head">CONFLICTS · {conflicts.length}</div>
            {conflicts.length === 0
              ? <p className="ct-cap-note">No overlapping areas right now.</p>
              : conflicts.map(([area, list]) => (
                <div key={area} className="ct-conflict">
                  <b>{modName(area)}</b> — {list.map(a => RUNNERS[a.id] + ' (' + a.name + ')').join(' and ')} are both working here. Sequence the merges or reassign one.
                </div>
              ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ===== 5 · Timeline ===== */
function TimelineView({ agents, queue, projects, onOpenAgent }) {
  const W = 185, NOW = 144; // minutes: window width, "now" offset from window start
  const pct = (m) => Math.max(0, Math.min(100, m / W * 100));
  const ticks = [{ m: 54, l: '13:00' }, { m: 84, l: '13:30' }, { m: 114, l: '14:00' }, { m: 174, l: '15:00' }];
  // lane geometry (mirrors CSS: lane pad 10, bar 30, gap 8, border 1)
  const laneTops = []; let acc = 0;
  projects.forEach(p => { laneTops.push(acc); acc += 13 + 38 * Math.max(1, p.agentIds.length); });
  const rowCenter = (id) => {
    for (let li = 0; li < projects.length; li++) {
      const ri = projects[li].agentIds.indexOf(id);
      if (ri >= 0) return laneTops[li] + 25 + 38 * ri;
    }
    return 0;
  };
  const barStartX = (id) => { const a = agents.find(x => x.id === id); return pct(Math.max(0, NOW - (a ? a.startedMin : 0))); };
  return (
    <section className="vw" data-screen-label="Timeline">
      <ViewHead title="Today's run" sub="What each agent has been doing, where it stalled, and where it's headed" />
      <div className="tl-wrap">
        <div className="tl-axis">
          {ticks.map(t => <span key={t.l} className="tl-tick" style={{ left: pct(t.m) + '%' }}>{t.l}</span>)}
          <span className="tl-now-label" style={{ left: pct(NOW) + '%' }}>now</span>
        </div>
        <div className="tl-lanes">
          <div className="tl-now" style={{ left: pct(NOW) + '%' }}></div>
          {ticks.map(t => <div key={t.l} className="tl-grid" style={{ left: pct(t.m) + '%' }}></div>)}
          {DEPS.map(d => {
            const x = barStartX(d.to), y1 = rowCenter(d.from), y2 = rowCenter(d.to);
            const fa = agents.find(a => a.id === d.from);
            if (!fa || !agents.find(a => a.id === d.to)) return null;
            return (
              <React.Fragment key={d.from + d.to}>
                <span className="tl-dep" style={{ left: x + '%', top: y1 + 'px', height: (y2 - 15 - y1) + 'px' }}></span>
                <span className="tl-dep-arrow" style={{ left: x + '%', top: (y2 - 23) + 'px' }}>▾</span>
                <span className="tl-dep-tag" style={{ left: x + '%', top: (y1 + (y2 - y1) / 2 - 8) + 'px' }}>⛓ after {fa.name}</span>
              </React.Fragment>
            );
          })}
          {projects.map(p => (
            <div key={p.id} className="tl-lane">
              <span className="tl-proj">{p.name}</span>
              <div className="tl-bars">
                {p.agentIds.map(id => agents.find(x => x.id === id)).filter(Boolean).map(a => {
                  const start = Math.max(0, NOW - a.startedMin);
                  const total = a.status === 'done' ? (NOW - 102) - start : a.startedMin / Math.max(a.progress, 0.08);
                  const x = pct(start);
                  const w = Math.max(7, pct(Math.min(start + total, W)) - x);
                  return (
                    <div key={a.id} className="tl-canvas">
                      <button className={'tl-bar tl-bar-' + a.status} style={{ left: x + '%', width: w + '%' }}
                              onClick={() => onOpenAgent(a.id)}>
                        <span className="tl-fill" style={{ width: Math.round(a.progress * 100) + '%' }}></span>
                        <span className="tl-bar-label"><span className="tl-runner mono">{RUNNERS[a.id]}</span>{a.name}{a.conflict ? ' ⚠' : ''}{a.status === 'done' ? ' ✓' : ''}</span>
                        {(a.status === 'waiting' || a.status === 'review') &&
                          <span className="tl-mark" style={{ left: Math.round(a.progress * 100) + '%' }}>⏸</span>}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="tl-legend">
        <span><i className="dot dot-running"></i> working</span>
        <span><i className="dot dot-waiting"></i> blocked — ⏸ marks where it stopped</span>
        <span><i className="dot dot-review"></i> awaiting review</span>
        <span><i className="dot dot-done"></i> merged</span>
        <span className="tl-legend-dep">┊ dependency — gated on an upstream task</span>
      </div>
    </section>
  );
}

/* ===== 6 · Fleet (configure & retire agents) ===== */
function ConfigForm({ initial, onSave, onCancel }) {
  const [name, setName] = React.useState(initial ? initial.rn : '');
  const [provider, setProvider] = React.useState(initial ? initial.provider : 'claude');
  const [model, setModel] = React.useState(initial ? initial.model : PROVIDERS.claude.models[0]);
  const models = PROVIDERS[provider].models;
  React.useEffect(() => { if (!models.includes(model)) setModel(models[0]); }, [provider]);
  return (
    <div className="cfg">
      <div className="cfg-row">
        <label className="cfg-label">Runner name</label>
        <input className="qx-input" value={name} placeholder="runner-10"
               onChange={e => setName(e.target.value)}></input>
      </div>
      <div className="cfg-row">
        <label className="cfg-label">Provider</label>
        <div className="cfg-prov">
          {Object.entries(PROVIDERS).map(([id, p]) => (
            <button key={id} className={'cfg-prov-btn' + (provider === id ? ' on' : '')}
                    style={provider === id ? { borderColor: p.color, color: p.color } : null}
                    onClick={() => setProvider(id)}>
              <span style={{ color: p.color }}>{p.glyph}</span> {p.name}
            </button>
          ))}
        </div>
      </div>
      <div className="cfg-row">
        <label className="cfg-label">Model</label>
        <div className="cfg-models">
          {models.map(m => (
            <button key={m} className={'cfg-model-btn' + (model === m ? ' on' : '')} onClick={() => setModel(m)}>{m}</button>
          ))}
        </div>
      </div>
      <div className="qx-row">
        <button className="btn btn-primary" onClick={() => onSave({ rn: name.trim() || ('runner-' + Math.floor(10 + Math.random() * 89)), provider, model, idle: 'now' })}>
          {initial ? 'Save changes' : 'Add to fleet'}
        </button>
        <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function FleetView({ agents, fleet, onConfigure, onUpdate, onRetire }) {
  const [adding, setAdding] = React.useState(false);
  const [editing, setEditing] = React.useState(null);
  const busyOf = (rn) => agents.find(a => a.status !== 'done' && (RUNNERS[a.id] || '').split('·')[0] === rn);
  return (
    <section className="vw" data-screen-label="Fleet">
      <div className="fleet-head">
        <ViewHead title="Agent fleet" sub={fleet.length + ' runners configured · Claude, Codex, Gemini, Cursor, Copilot'} />
        <button className="btn btn-primary" onClick={() => { setAdding(true); setEditing(null); }}>+ Configure agent</button>
      </div>
      {adding && (
        <div className="panel cfg-panel">
          <div className="panel-head">NEW AGENT</div>
          <ConfigForm onSave={(r) => { onConfigure(r); setAdding(false); }} onCancel={() => setAdding(false)} />
        </div>
      )}
      <div className="fleet-grid">
        {fleet.map(r => {
          const busy = busyOf(r.rn);
          const p = PROVIDERS[r.provider] || PROVIDERS.claude;
          const isEditing = editing === r.rn;
          return (
            <div key={r.rn} className={'fleet-card' + (busy ? ' fleet-busy' : '')}>
              {isEditing ? (
                <ConfigForm initial={r} onSave={(u) => { onUpdate(r.rn, u); setEditing(null); }} onCancel={() => setEditing(null)} />
              ) : (
                <React.Fragment>
                  <div className="fleet-top">
                    <span className="fleet-prov" style={{ color: p.color }}>{p.glyph}</span>
                    <span className="fleet-rn mono">{r.rn}</span>
                    {busy
                      ? <span className="fleet-state fleet-state-busy"><span className="dot dot-running"></span>busy</span>
                      : <span className="fleet-state fleet-state-idle"><span className="dot dot-idle"></span>idle {r.idle || 'now'}</span>}
                  </div>
                  <div className="fleet-meta">
                    <span className="fleet-pname">{p.name}</span>
                    <span className="fleet-model mono">{r.model}</span>
                  </div>
                  {busy && <div className="fleet-task">▸ {busy.name}</div>}
                  <div className="fleet-actions">
                    <button className="btn btn-ghost" onClick={() => { setEditing(r.rn); setAdding(false); }}>Configure</button>
                    <button className="btn btn-ghost btn-retire" disabled={!!busy}
                            title={busy ? 'Finish or reassign its task before retiring' : 'Retire this agent'}
                            onClick={() => onRetire(r.rn)}>Retire</button>
                  </div>
                </React.Fragment>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

Object.assign(window, { HomeView, GetStarted, LedgerView, SubwayView, RosterView, ControlView, TimelineView, FleetView, RUNNERS, Prov, idleRunners });
