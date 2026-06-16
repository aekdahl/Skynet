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

/* ---------- operator shell: title bar · sidebar · status bar ---------- */
function TitleBar() {
  return (
    <header className="op-titlebar">
      <div className="op-tl"><i className="r"></i><i className="y"></i><i className="g"></i></div>
      <div className="op-title">Tower — Mission Control</div>
      <div className="op-titleright">
        <span className="op-search">Search or run a command</span>
        <span className="op-avatar">JD</span>
      </div>
    </header>
  );
}

function OpSidebar({ view, lens, setView, setLens, projects, agents, queueCount, onOpenProject }) {
  const dotColor = (p) => {
    const pa = agents.filter(a => p.agentIds.includes(a.id));
    if (pa.length && pa.every(a => a.status === 'done')) return 'var(--faint)';
    if (pa.some(a => a.status === 'waiting' || a.status === 'review')) return 'var(--warn)';
    return 'var(--ok)';
  };
  const item = (label, ic, onClick, active, badge) => (
    <button className={'op-navitem' + (active ? ' on' : '')} onClick={onClick}>
      <span className="ic">{ic}</span> {label}
      {badge > 0 && <span className="badge">{badge}</span>}
    </button>
  );
  const live = projects.filter(p => !p.done);
  return (
    <aside className="op-side">
      <div className="op-ws"><span className="op-ws-logo">▣</span><span className="op-ws-name">Atlas</span><span className="op-ws-caret">▾</span></div>
      <nav className="op-nav">
        {item('Home', '⌂', () => { setLens('subway'); setView('home'); }, view === 'home' && lens !== 'timeline')}
        {item('Inbox', '⊙', () => setView('queue'), view === 'queue', queueCount)}
        {item('Projects', '▤', () => setView('projects'), view === 'projects' || view === 'project')}
        {item('Fleet', '◇', () => setView('fleet'), view === 'fleet')}
        {item('Timeline', '▭', () => { setLens('timeline'); setView('home'); }, view === 'home' && lens === 'timeline')}
      </nav>
      <div className="op-navsec">PROJECTS</div>
      <div className="op-plist">
        {live.map(p => (
          <button key={p.id} className="op-pitem" onClick={() => onOpenProject(p.id)}>
            <span className="op-pdot" style={{ background: dotColor(p) }}></span>
            <span className="nm">{p.name}</span>
          </button>
        ))}
      </div>
      <div className="op-side-foot"><span className="op-avatar">JD</span><div><div className="who">Jordan Diaz</div><div className="role">Pilot</div></div></div>
    </aside>
  );
}

function OpStatusBar({ agents, queue, fleet, onOpenAgent }) {
  const [open, setOpen] = React.useState(null);
  const running = agents.filter(a => a.status === 'running');
  const blocked = agents.filter(a => a.status === 'waiting' || a.status === 'review');
  const busy = agents.filter(a => a.status !== 'done');
  const idle = window.idleRunners ? window.idleRunners(fleet, agents) : [];
  const longest = queue.length ? Math.max(...queue.map(q => q.waited)) : 0;
  const stat = (key, list, label, dot) => (
    <span className="op-sb-wrap">
      <button className={'op-sb-stat' + (open === key ? ' on' : '')} onClick={() => setOpen(open === key ? null : key)}>
        <span className={'dot ' + dot}></span><b>{list.length}</b> {label}
      </button>
      {open === key && (
        <span className="op-sb-menu">
          {list.length === 0 && <span className="op-sb-empty">nothing here right now</span>}
          {list.map(a => (
            <button key={a.id} className="op-sb-item" onClick={() => { setOpen(null); onOpenAgent(a.id); }}>
              <StatusDot status={a.status} />
              <span className="nm">{a.name}</span>
              <span className="mono">{window.RUNNERS ? RUNNERS[a.id] : ''}</span>
            </button>
          ))}
        </span>
      )}
    </span>
  );
  return (
    <footer className="op-statusbar">
      {stat('running', running, 'running', 'dot-running')}
      {stat('blocked', blocked, 'need you', 'dot-waiting')}
      <span className="op-sb-text"><b>{busy.length}</b> busy · <b>{idle.length}</b> idle{queue.length > 0 && <React.Fragment> · longest <b>{fmtWait(longest)}</b></React.Fragment>}</span>
      {open && <span className="stat-backdrop" onClick={() => setOpen(null)}></span>}
      <span className="op-sb-r">atlas-app · main · <span className="ok">✓ synced</span> · v2.18.0</span>
    </footer>
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

/* ---------- overview ---------- */
function ProjectCard({ project, agents, queue, onOpen }) {
  const pa = agents.filter(a => project.agentIds.includes(a.id));
  const waiting = queue.filter(q => project.agentIds.includes(q.agentId));
  const conflict = pa.some(a => a.conflict && a.status !== 'done');
  const allDone = pa.length > 0 && pa.every(a => a.status === 'done');
  const empty = pa.length === 0;
  const prog = pa.length ? pa.reduce((n, a) => n + a.progress, 0) / pa.length : 0;
  return (
    <button className={'proj' + (allDone ? ' proj-done' : '')} onClick={onOpen}
            data-comment-anchor={'proj-' + project.id}>
      <div className="proj-top">
        <span className="proj-name">{project.name}</span>
        {waiting.length > 0 && <span className="needs-pill">⏸ {waiting.length} waiting on you</span>}
        {allDone && <span className="shipped-pill">✓ shipped</span>}
        {empty && <span className="shipped-pill">new</span>}
      </div>
      <p className="proj-goal">{project.goal}</p>
      <Bar value={prog} status={waiting.length > 0 ? 'waiting' : allDone ? 'done' : 'running'} />
      <div className="proj-agents">
        {pa.map(a => {
          const q = queue.find(it => it.agentId === a.id);
          return (
            <div key={a.id} className="proj-agent">
              <StatusDot status={a.status} />
              <span className="proj-agent-name">{a.name}</span>
              <span className="proj-agent-state mono">
                {q ? 'waiting ' + fmtWait(q.waited) : a.status === 'done' ? 'merged' : Math.round(a.progress * 100) + '%'}
              </span>
            </div>
          );
        })}
        {project.backlog.length > 0 && (
          <div className="proj-backlog mono">○ {project.backlog.length} in backlog</div>
        )}
        {empty && project.backlog.length === 0 && <div className="proj-backlog mono">No tasks yet — open to add some</div>}
      </div>
      {(() => { const cf = pa.find(a => a.conflict && a.status !== 'done');
        return cf && <div className="proj-conflict">⚠ overlaps another project in {modName(cf.conflict)}</div>; })()}
    </button>
  );
}

function NewProjectCard({ onCreate }) {
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [goal, setGoal] = React.useState('');
  if (!open) return <button className="proj proj-new" onClick={() => setOpen(true)}><span className="proj-new-plus">+</span> New project</button>;
  return (
    <div className="proj proj-new-form">
      <input className="qx-input" autoFocus placeholder="Project name" value={name} onChange={e => setName(e.target.value)}></input>
      <textarea className="qx-input" rows="2" placeholder="Goal — what does done look like?" value={goal} onChange={e => setGoal(e.target.value)}></textarea>
      <div className="qx-row">
        <button className="btn btn-primary" disabled={!name.trim()}
                onClick={() => { onCreate({ name: name.trim(), goal: goal.trim() || 'No goal set yet.' }); setOpen(false); setName(''); setGoal(''); }}>Create project</button>
        <button className="btn btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}

function OverviewView({ projects, agents, queue, onOpenProject, onCreate }) {
  const running = agents.filter(a => a.status === 'running').length;
  const longest = queue.length ? Math.max(...queue.map(q => q.waited)) : 0;
  const sorted = [...projects].sort((a, b) => {
    const w = p => queue.filter(q => p.agentIds.includes(q.agentId)).length;
    const d = p => p.agentIds.length > 0 && p.agentIds.every(id => { const ag = agents.find(x => x.id === id); return ag && ag.status === 'done'; });
    return (d(a) - d(b)) || (w(b) - w(a));
  });
  return (
    <section className="overview" data-screen-label="Overview">
      <div className="ov-head">
        <h1>Ongoing projects</h1>
        <p className="ov-sub">
          {running} agents running · {queue.length > 0
            ? <span className="ov-sub-warn">{queue.length} decisions waiting on you — longest {fmtWait(longest)}</span>
            : 'nothing waiting on you'}
        </p>
      </div>
      <div className="ov-grid">
        <NewProjectCard onCreate={onCreate} />
        {sorted.map(p => (
          <ProjectCard key={p.id} project={p} agents={agents} queue={queue} onOpen={() => onOpenProject(p.id)} />
        ))}
      </div>
    </section>
  );
}

/* ---------- project detail ---------- */
function ProjectAgentCard({ agent, queue, onOpen }) {
  const q = queue.find(it => it.agentId === agent.id);
  const now = agent.plan.find(p => p.s === 'now');
  const done = agent.plan.filter(p => p.s === 'done').length;
  return (
    <button className="pa-card" onClick={onOpen}>
      <div className="pa-top">
        <StatusDot status={agent.status} />
        <span className="pa-name">{agent.name}</span>
        <span className="status-word" style={{ color: STATUS_META[agent.status].color }}>{STATUS_META[agent.status].label}</span>
      </div>
      <Bar value={agent.progress} status={agent.status} />
      <div className="pa-step">
        {q ? <span className="wait-tag">⏸ {q.title}</span>
           : agent.status === 'done' ? <span className="done-tag">✓ merged</span>
           : <span className="step-tag">→ {now ? now.t : '…'}</span>}
      </div>
      <div className="pa-meta mono">{done}/{agent.plan.length} steps · {agent.branch}</div>
    </button>
  );
}

function BacklogCard({ text, onEdit, onDelete, onAssign }) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(text);
  if (editing) {
    return (
      <div className="kb-card kb-backlog">
        <textarea className="qx-input" rows="2" autoFocus value={draft} onChange={e => setDraft(e.target.value)}></textarea>
        <div className="qx-row">
          <button className="btn btn-primary" onClick={() => { if (draft.trim()) { onEdit(draft.trim()); setEditing(false); } }}>Save</button>
          <button className="btn btn-ghost" onClick={() => { setDraft(text); setEditing(false); }}>Cancel</button>
        </div>
      </div>
    );
  }
  return (
    <div className="kb-card kb-backlog">
      <div className="kb-card-top">
        <span className="kb-task">{text}</span>
        <span className="kb-card-tools">
          <button className="kb-tool" title="Edit task" onClick={() => setEditing(true)}>✎</button>
          <button className="kb-tool kb-tool-del" title="Delete task" onClick={onDelete}>×</button>
        </span>
      </div>
      <button className="kb-assign" onClick={onAssign}>Assign agent →</button>
    </div>
  );
}

function AddTaskCard({ onAdd }) {
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  if (!open) return <button className="kb-add" onClick={() => setOpen(true)}>+ Add task</button>;
  return (
    <div className="kb-card kb-backlog">
      <textarea className="qx-input" rows="2" autoFocus placeholder="Describe the task…" value={draft} onChange={e => setDraft(e.target.value)}></textarea>
      <div className="qx-row">
        <button className="btn btn-primary" disabled={!draft.trim()} onClick={() => { onAdd(draft.trim()); setDraft(''); setOpen(false); }}>Add to backlog</button>
        <button className="btn btn-ghost" onClick={() => { setDraft(''); setOpen(false); }}>Cancel</button>
      </div>
    </div>
  );
}

function ProjectView({ project, agents, queue, onResolve, onOpenAgent, onBack,
                       onUpdateProject, onDeleteProject, onAddTask, onUpdateTask, onDeleteTask, onAssignTask }) {
  const pa = agents.filter(a => project.agentIds.includes(a.id));
  const items = queue.filter(q => project.agentIds.includes(q.agentId));
  const inProgress = pa.filter(a => a.status !== 'done');
  const doneList = pa.filter(a => a.status === 'done');
  // one preview for the project's aimed delivery, shown only when there's a visual
  // deliverable to render. Backend / infra projects are skipped entirely.
  const lead = window.visualLeadOf ? window.visualLeadOf(project, agents) : null;
  const [folded, setFolded] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [confirmDel, setConfirmDel] = React.useState(false);
  const [name, setName] = React.useState(project.name);
  const [goal, setGoal] = React.useState(project.goal);
  React.useEffect(() => { setName(project.name); setGoal(project.goal); }, [project.id]);
  React.useEffect(() => { setFolded(false); }, [project.id]);
  return (
    <section className="projview" data-screen-label={'Project: ' + project.name}>
      <button className="btn btn-ghost btn-back" onClick={onBack}>← Back</button>
      {editing ? (
        <div className="projview-edit">
          <input className="qx-input" value={name} onChange={e => setName(e.target.value)}></input>
          <textarea className="qx-input" rows="2" value={goal} onChange={e => setGoal(e.target.value)}></textarea>
          <div className="qx-row">
            <button className="btn btn-primary" onClick={() => { onUpdateProject(project.id, { name: name.trim() || project.name, goal: goal.trim() }); setEditing(false); }}>Save</button>
            <button className="btn btn-ghost" onClick={() => { setName(project.name); setGoal(project.goal); setEditing(false); }}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="projview-head">
          <div className="projview-head-main">
            <h2>{project.name}</h2>
            <p>{project.goal}</p>
          </div>
          <div className="projview-head-tools">
            <button className="btn btn-ghost" onClick={() => setEditing(true)}>Edit</button>
            {confirmDel
              ? <span className="del-confirm">Delete project? <button className="btn btn-danger" onClick={() => onDeleteProject(project.id)}>Yes, delete</button><button className="btn btn-ghost" onClick={() => setConfirmDel(false)}>No</button></span>
              : <button className="btn btn-ghost btn-retire" onClick={() => setConfirmDel(true)}>Delete</button>}
          </div>
        </div>
      )}
      {lead && (
        <div className="proj-delivery">
          <button className="proj-delivery-head" onClick={() => setFolded(f => !f)}>
            <span className="fold-caret">{folded ? '▸' : '▾'}</span>
            <span className="proj-delivery-title">LIVE PREVIEW</span>
            <span className="proj-delivery-sub">aimed delivery · {lead.status === 'done' ? 'shipped' : 'building'} · {lead.name}</span>
          </button>
          {!folded && (
            <div className="proj-delivery-body">
              <ProjectDelivery project={project} agents={agents} />
            </div>
          )}
        </div>
      )}
      {items.length > 0 && (
        <div className="projview-queue">
          <div className="panel-head">WAITING ON YOU</div>
          {items.map(it => (
            <QueueCard key={it.id} item={it} agent={agents.find(a => a.id === it.agentId)} selected={false}
                       onResolve={(action) => onResolve(it.id, action)} onOpen={() => onOpenAgent(it.agentId)} />
          ))}
        </div>
      )}
      <div className="kb-cols">
        <div className="kb-col">
          <div className="kb-head">BACKLOG · {project.backlog.length}</div>
          {project.backlog.map((t2, i) => (
            <BacklogCard key={i} text={t2}
                         onEdit={(txt) => onUpdateTask(project.id, i, txt)}
                         onDelete={() => onDeleteTask(project.id, i)}
                         onAssign={() => onAssignTask(project.id, i)} />
          ))}
          <AddTaskCard onAdd={(txt) => onAddTask(project.id, txt)} />
        </div>
        <div className="kb-col">
          <div className="kb-head kb-head-active">IN PROGRESS · {inProgress.length}</div>
          {inProgress.length === 0 && <div className="kb-empty">No agents running.</div>}
          {inProgress.map(a => <ProjectAgentCard key={a.id} agent={a} queue={queue} onOpen={() => onOpenAgent(a.id)} />)}
        </div>
        <div className="kb-col">
          <div className="kb-head kb-head-done">DONE · {doneList.length}</div>
          {doneList.length === 0 && <div className="kb-empty">Nothing merged yet.</div>}
          {doneList.map(a => (
            <button key={a.id} className="kb-card kb-done" onClick={() => onOpenAgent(a.id)}>
              <span className="kb-task">✓ {a.name}</span>
              <span className="kb-done-meta mono">merged · {a.branch}</span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------- queue ---------- */
function QueueCard({ item, agent, selected, onResolve, onOpen }) {
  const k = KIND_META[item.kind];
  const [mode, setMode] = React.useState(null); // null | 'modify' | 'chat'
  const [draft, setDraft] = React.useState('');
  const [msgs, setMsgs] = React.useState([]);
  const send = () => {
    if (!draft.trim()) return;
    const mine = { who: 'you', text: draft.trim() };
    setMsgs(m => [...m, mine]);
    setDraft('');
    setTimeout(() => setMsgs(m => [...m, { who: 'agent', text: 'Got it — I’ll factor that in and continue. I’ll surface a new checkpoint if anything changes.' }]), 700);
  };
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
              “{opt}”{i === item.recommended && <span className="rec">rec</span>}
            </button>
          ))}
          <button className={'btn btn-ghost' + (mode === 'modify' ? ' btn-lit' : '')} onClick={() => setMode(mode === 'modify' ? null : 'modify')}>Modify</button>
          <button className={'btn btn-ghost' + (mode === 'chat' ? ' btn-lit' : '')} onClick={() => setMode(mode === 'chat' ? null : 'chat')}>Chat</button>
          <button className="btn btn-ghost" onClick={onOpen}>Open agent</button>
        </div>
      ) : (
        <div className="qcard-actions">
          <button className="btn btn-primary" onClick={() => onResolve('approve')}>Approve</button>
          <button className="btn btn-danger" onClick={() => onResolve('reject')}>Reject</button>
          <button className={'btn btn-ghost' + (mode === 'modify' ? ' btn-lit' : '')} onClick={() => setMode(mode === 'modify' ? null : 'modify')}>Modify</button>
          <button className={'btn btn-ghost' + (mode === 'chat' ? ' btn-lit' : '')} onClick={() => setMode(mode === 'chat' ? null : 'chat')}>Chat</button>
          <button className="btn btn-ghost" onClick={onOpen}>Open agent</button>
        </div>
      )}

      {mode === 'modify' && (
        <div className="qx">
          <textarea className="qx-input" rows="3" autoFocus
                    placeholder="Adjust the instruction — the agent resumes with this guidance…"
                    value={draft} onChange={e => setDraft(e.target.value)}></textarea>
          <div className="qx-row">
            <button className="btn btn-primary" onClick={() => onResolve('modify')}>Send &amp; resume</button>
            <button className="btn btn-ghost" onClick={() => setMode(null)}>Cancel</button>
          </div>
        </div>
      )}

      {mode === 'chat' && (
        <div className="qx">
          <div className="qx-thread">
            <div className="qx-msg qx-agent"><span className="qx-who mono">{agent.name}</span>{item.why}</div>
            {msgs.map((m, i) => (
              <div key={i} className={'qx-msg ' + (m.who === 'you' ? 'qx-you' : 'qx-agent')}>
                <span className="qx-who mono">{m.who === 'you' ? 'you' : agent.name}</span>{m.text}
              </div>
            ))}
          </div>
          <div className="qx-row">
            <input className="qx-input qx-line" placeholder="Ask or instruct…" value={draft} autoFocus
                   onChange={e => setDraft(e.target.value)} onKeyDown={e => e.key === 'Enter' && send()}></input>
            <button className="btn" onClick={send}>Send</button>
          </div>
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
        <div className="readout-hint"></div>
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
function AgentChat({ agent }) {
  const now = agent.plan.find(p => p.s === 'now');
  const [msgs, setMsgs] = React.useState([]);
  const [draft, setDraft] = React.useState('');
  const send = () => {
    if (!draft.trim()) return;
    setMsgs(m => [...m, { who: 'you', text: draft.trim() }]);
    setDraft('');
    setTimeout(() => setMsgs(m => [...m, {
      who: 'agent',
      text: m.length <= 1
        ? 'I’m on “' + (now ? now.t : 'wrap-up') + '” right now. I can adjust course — want me to fold that into the current step or add it to the plan?'
        : 'Understood — updating the plan. You’ll see it reflected in the next heartbeat.',
    }]), 700);
  };
  return (
    <div className="panel panel-chat">
      <div className="panel-head">CHAT <span className="panel-sub">discuss the task — agent keeps working</span></div>
      <div className="qx-thread">
        <div className="qx-msg qx-agent">
          <span className="qx-who mono">{agent.name}</span>
          {agent.status === 'done'
            ? 'This task is merged. Ask me anything about what shipped.'
            : 'Currently on “' + (now ? now.t : '…') + '”. Ask about my approach or redirect me — I’ll keep working meanwhile.'}
        </div>
        {msgs.map((m, i) => (
          <div key={i} className={'qx-msg ' + (m.who === 'you' ? 'qx-you' : 'qx-agent')}>
            <span className="qx-who mono">{m.who === 'you' ? 'you' : agent.name}</span>{m.text}
          </div>
        ))}
      </div>
      <div className="qx-row">
        <input className="qx-input qx-line" placeholder="Message the agent…" value={draft}
               onChange={e => setDraft(e.target.value)} onKeyDown={e => e.key === 'Enter' && send()}></input>
        <button className="btn" onClick={send}>Send</button>
      </div>
    </div>
  );
}

function AgentDetail({ agent, queue, onResolve, onBack, backLabel }) {
  const q = queue.find(it => it.agentId === agent.id);
  const doneCount = agent.plan.filter(p => p.s === 'done').length;
  const [mode, setMode] = React.useState(null); // null | 'modify' | 'chat'
  const [draft, setDraft] = React.useState('');
  const [msgs, setMsgs] = React.useState([]);
  const send = () => {
    if (!draft.trim()) return;
    setMsgs(m => [...m, { who: 'you', text: draft.trim() }]);
    setDraft('');
    setTimeout(() => setMsgs(m => [...m, { who: 'agent', text: 'Good question — happy to clarify before you decide. The checkpoint stays open until you approve or reject.' }]), 700);
  };
  return (
    <section className="detail" data-screen-label={'Agent: ' + agent.name}>
      <div className="detail-head">
        <button className="btn btn-ghost btn-back" onClick={onBack}>← {backLabel || 'Back'}</button>
        <div className="detail-title">
          <StatusDot status={agent.status} />
          <h2>{agent.name}</h2>
          <span className="status-word" style={{ color: STATUS_META[agent.status].color }}>
            {STATUS_META[agent.status].label}
          </span>
          <button className="btn btn-ghost btn-fork" title="Duplicate this agent with the same context to work on something else">⑂ Fork agent</button>
        </div>
        <div className="detail-meta">
          <span className="mono">{agent.branch}</span>
          <span>{agent.model}</span>
          <span>{Math.floor(agent.startedMin / 60) > 0 ? Math.floor(agent.startedMin / 60) + 'h ' : ''}{agent.startedMin % 60}m elapsed</span>
          <span className="hb">♥ heartbeat {q ? fmtWait(q.waited) : agent.hb + 's'} ago</span>
          {agent.fork && <span className="fork-tag">⑂ fork of {window.RUNNERS ? RUNNERS[agent.fork] : agent.fork} — shared context</span>}
        </div>
      </div>

      {q && (
        <div className="detail-blocked-wrap">
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
            <button className={'btn btn-ghost' + (mode === 'modify' ? ' btn-lit' : '')} onClick={() => setMode(mode === 'modify' ? null : 'modify')}>Modify</button>
            <button className={'btn btn-ghost' + (mode === 'chat' ? ' btn-lit' : '')} onClick={() => setMode(mode === 'chat' ? null : 'chat')}>Chat</button>
          </div>
          {mode === 'modify' && (
            <div className="qx detail-modify">
              <textarea className="qx-input" rows="3" autoFocus
                        placeholder="Adjust the instruction — the agent resumes with this guidance…"
                        value={draft} onChange={e => setDraft(e.target.value)}></textarea>
              <div className="qx-row">
                <button className="btn btn-primary" onClick={() => onResolve(q.id, 'modify')}>Send &amp; resume</button>
                <button className="btn btn-ghost" onClick={() => setMode(null)}>Cancel</button>
              </div>
            </div>
          )}
          {mode === 'chat' && (
            <div className="qx detail-modify">
              <div className="qx-thread">
                <div className="qx-msg qx-agent"><span className="qx-who mono">{agent.name}</span>{q.why}</div>
                {msgs.map((m, i) => (
                  <div key={i} className={'qx-msg ' + (m.who === 'you' ? 'qx-you' : 'qx-agent')}>
                    <span className="qx-who mono">{m.who === 'you' ? 'you' : agent.name}</span>{m.text}
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
      )}

      {agent.conflict && (
        <div className="detail-conflict">
          ⚠ Overlap in <b>{modName(agent.conflict)}</b> — also being modified by{' '}
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
          <div className="panel-head">MODIFIED MODULES <span className="panel-sub">{agent.areas.length}</span></div>
          <div className="modlist">
            {agent.areas.map((ar, i) => (
              <span key={i} className={'modchip' + (agent.conflict === ar ? ' modchip-conflict' : '')}>
                {modName(ar)}{agent.conflict === ar && ' ⚠'}
              </span>
            ))}
          </div>
          <AgentChat agent={agent} />
        </div>
        <div className="detail-right">
          <div className="panel panel-preview">
            <div className="panel-head">LIVE PREVIEW <span className="panel-sub">what's actually built right now</span></div>
            <PreviewFor agent={agent} />
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

Object.assign(window, { TitleBar, OpSidebar, OpStatusBar, AgentRail, OverviewView, ProjectView, QueueView, AgentDetail, MapView, fmtWait });
