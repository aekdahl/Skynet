// Tower — Reimagined: shells A — Operator, Cockpit, Studio

const MOD_COLOR = {
  'Billing': '#3DD68C', 'Deploy Infra': '#FF6B4A', 'Onboarding': '#5EA2FF', 'API': '#19C2A8',
  'Auth': '#19C2A8', 'Shared UI': '#A78BFA', 'Dashboard': '#FFB224', 'Docs': '#8B93A5',
};
const modColor = (m) => MOD_COLOR[m] || '#8B93A5';

// tiny rendered product preview for visual projects (light surface)
function MiniProduct({ kind }) {
  if (kind === 'Dashboard' || kind === 'Frontend platform') {
    return (
      <div className="mp mp-light">
        <div className="mp-bar"><i></i><i></i><i></i><span>app.atlas.io/dashboard</span></div>
        <div className="mp-pad">
          <div className="mp-row"><span className="mp-h">Usage</span><span className="mp-p95">p95 287ms</span></div>
          <div className="mp-chart">{[34, 52, 41, 68, 75, 58, 82, 91, 73, 88, 79, 94].map((h, i) => <i key={i} style={{ height: h + '%' }}></i>)}</div>
        </div>
      </div>
    );
  }
  if (kind === 'Onboarding' || kind === 'Onboarding revamp') {
    return (
      <div className="mp mp-light">
        <div className="mp-bar"><i></i><i></i><i></i><span>app.atlas.io/welcome</span></div>
        <div className="mp-pad mp-center">
          <div className="mp-dots"><b></b><b></b><b></b><i></i></div>
          <div className="mp-h2">Bring your team along</div>
          <div className="mp-field">name@company.com</div>
          <div className="mp-cta">Invite your team</div>
        </div>
      </div>
    );
  }
  return (
    <div className="mp mp-light">
      <div className="mp-bar"><i></i><i></i><i></i><span>atlas.io/changelog</span></div>
      <div className="mp-pad"><div className="mp-h2">Week 24</div><div className="mp-line"></div><div className="mp-line short"></div><div className="mp-line"></div></div>
    </div>
  );
}

/* ============ V1 · OPERATOR ============ */
function Operator() {
  const sel = BLOCKERS[0];
  const a = ag(sel.id);
  return (
    <div className="shell v1">
      <div className="v1-titlebar">
        <div className="tl"><i className="r"></i><i className="y"></i><i className="g"></i></div>
        <div className="v1-title">Tower — Mission Control</div>
        <div className="v1-titleright">
          <span className="searchpill">Search or run a command <kbd>⌘K</kbd></span>
          <span className="avatar">JD</span>
        </div>
      </div>
      <div className="v1-body">
        {/* sidebar */}
        <aside className="v1-side">
          <div className="v1-ws"><span className="v1-ws-logo">▣</span><span className="v1-ws-name">Atlas</span><span className="v1-ws-caret">▾</span></div>
          <nav className="v1-nav">
            <button className="v1-navitem"><span className="ic">⌂</span> Home</button>
            <button className="v1-navitem on"><span className="ic">⊙</span> Inbox <span className="badge">4</span></button>
            <button className="v1-navitem"><span className="ic">▤</span> Projects</button>
            <button className="v1-navitem"><span className="ic">◇</span> Fleet</button>
            <button className="v1-navitem"><span className="ic">▭</span> Timeline</button>
          </nav>
          <div className="v1-navsec">PROJECTS</div>
          <div className="v1-plist">
            {PROJECTS.filter(p => !p.done).map(p => (
              <div key={p.name} className="v1-pitem"><span className="rdot rdot-running" style={{ background: modColor(p.module) }}></span><span className="nm">{p.name}</span></div>
            ))}
          </div>
          <div className="v1-side-foot"><span className="avatar">JD</span><div><div className="who">Jordan Diaz</div><div className="role">Pilot</div></div></div>
        </aside>
        {/* list */}
        <section className="v1-list">
          <div className="v1-list-head">
            <div className="v1-list-title">Inbox <small>4 need you</small></div>
            <div className="v1-seg"><button className="on">Oldest</button><button>Kind</button></div>
          </div>
          <div className="v1-rows">
            {BLOCKERS.map((b, i) => {
              const ba = ag(b.id);
              return (
                <div key={b.id} className={'v1-row' + (i === 0 ? ' sel' : '')}>
                  <div className="v1-row-top">
                    <span className="kchip" style={{ color: b.kc, borderColor: b.kc }}>{b.kind}</span>
                    <span className="v1-row-wait">{b.wait}</span>
                  </div>
                  <div className="v1-row-title">{b.title}</div>
                  <div className="v1-row-meta"><G p={ba.prov} /> {ba.rn} · {ba.proj}</div>
                </div>
              );
            })}
          </div>
        </section>
        {/* detail / inspector */}
        <section className="v1-detail">
          <div className="v1-det-head">
            <div className="v1-det-kind"><span className="kchip" style={{ color: sel.kc, borderColor: sel.kc }}>{sel.kind}</span><Dot s={a.status} /><span style={{ fontSize: '11px', color: 'var(--faint)', fontFamily: 'var(--mono)' }}>waiting {sel.wait}</span></div>
            <div className="v1-det-title">{sel.title}</div>
            <div className="v1-det-sub"><span><G p={a.prov} /> {a.rn} · {a.model}</span><span>{a.proj}</span><span>{a.branch}</span></div>
          </div>
          <div className="v1-det-body">
            <div className="v1-card">
              <div className="v1-card-h">WHY THIS STOPPED</div>
              <div className="v1-why">{sel.why}</div>
              <div className="v1-code">$ psql atlas_staging &lt; migrations/0142_reconcile.sql</div>
            </div>
            <div className="v1-card">
              <div className="v1-card-h">PROGRESS · STEP {a.step}/{a.steps}</div>
              <div className="v1-why" style={{ fontSize: '13px', color: 'var(--muted)' }}>→ {a.cur}</div>
              <div style={{ marginTop: '11px' }}><Bar v={a.prog} s={a.status} /></div>
            </div>
            <div className="v1-card">
              <div className="v1-card-h">MODIFIED MODULES</div>
              <div style={{ display: 'flex', gap: '8px' }}><span className="kchip" style={{ color: 'var(--text)', borderColor: 'var(--line)' }}>{a.module}</span></div>
            </div>
          </div>
          <div className="v1-actbar">
            <button className="rbtn rbtn-primary">Approve</button>
            <button className="rbtn rbtn-danger">Reject</button>
            <button className="rbtn rbtn-ghost">Modify</button>
            <button className="rbtn rbtn-ghost">Chat</button>
          </div>
        </section>
      </div>
      <div className="statusbar">
        <span><b>9</b> runners · <b className="ok">7</b> busy · <b>2</b> idle</span>
        <span><b className="ok">4</b> need you · longest <b>12:22</b></span>
        <span className="sb-r">main · <span className="ok">✓ synced</span> · v2.18.0</span>
      </div>
    </div>
  );
}

/* ============ V2 · COCKPIT ============ */
function Cockpit() {
  const busy = AGENTS.filter(a => a.status !== 'done');
  return (
    <div className="shell v2">
      <div className="v2-menu">
        <span className="brand">TOWER</span>
        <span className="mi">Fleet</span><span className="mi">Projects</span><span className="mi">View</span>
        <span className="r"><span><Live /> realtime</span><span>14:32:41</span><span style={{ color: 'var(--ok)' }}>● connected</span></span>
      </div>
      <div className="v2-kpis">
        <div className="v2-kpi"><span className="v2-kpi-n">7</span><span className="v2-kpi-l">in flight</span></div>
        <div className="v2-kpi"><span className="v2-kpi-n v2-warn">4</span><span className="v2-kpi-l">need you</span></div>
        <div className="v2-kpi"><span className="v2-kpi-n v2-warn">12<small>m</small></span><span className="v2-kpi-l">longest wait</span></div>
        <div className="v2-kpi"><span className="v2-kpi-n v2-ok">7<small>/9</small></span><span className="v2-kpi-l">agents busy</span></div>
        <div className="v2-kpi"><span className="v2-kpi-n v2-danger">1</span><span className="v2-kpi-l">conflict</span></div>
      </div>
      <div className="v2-grid">
        {/* needs you */}
        <div className="v2-panel v2-needs">
          <div className="v2-ph"><span className="v2-ph-t">NEEDS YOU</span><span className="v2-ph-c">4 · oldest first</span></div>
          <div className="v2-pb">
            {BLOCKERS.map(b => {
              const ba = ag(b.id);
              return (
                <div key={b.id} className="v2-bcard">
                  <div className="v2-bcard-top"><span className="kchip" style={{ color: b.kc, borderColor: b.kc }}>{b.kind}</span><span className="v2-bcard-wait">{b.wait}</span></div>
                  <div className="v2-bcard-title">{b.title}</div>
                  <div className="v2-bcard-meta"><G p={ba.prov} /> {ba.rn} · {ba.module}</div>
                  <div className="v2-bcard-act"><button className="rbtn rbtn-primary rbtn-sm">Approve</button><button className="rbtn rbtn-danger rbtn-sm">Reject</button></div>
                </div>
              );
            })}
          </div>
        </div>
        {/* project lines */}
        <div className="v2-panel v2-lines">
          <div className="v2-ph"><span className="v2-ph-t">PROJECT LINES</span><span className="v2-ph-c">6 projects</span></div>
          <div className="v2-pb" style={{ padding: 0, gap: 0 }}>
            {PROJECTS.map(p => {
              const pa = p.ids.map(ag);
              const lead = pa[0];
              return (
                <div key={p.name} className="v2-line">
                  <div className="v2-line-h"><Dot s={p.done ? 'done' : lead.status} /><span className="v2-line-nm">{p.name}</span><span className="v2-line-mod">{p.module}</span></div>
                  <div className="v2-track">
                    {Array.from({ length: lead.steps }).map((_, i) => {
                      const st = p.done || i < lead.step ? 'done' : i === lead.step ? 'cur' : 'todo';
                      return (
                        <React.Fragment key={i}>
                          {i > 0 && <span className={'v2-seg' + (p.done || i <= lead.step ? ' done' : '')}></span>}
                          <span className={'v2-st v2-st-' + st + (st === 'cur' && lead.status === 'running' ? ' run' : '')}></span>
                        </React.Fragment>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        {/* fleet capacity */}
        <div className="v2-panel">
          <div className="v2-ph"><span className="v2-ph-t">FLEET CAPACITY</span><span className="v2-ph-c">7/9 busy</span></div>
          <div className="v2-cap">
            {busy.map(a => <span key={a.id} className={'v2-seg-cell v2-cell-' + a.status} title={a.rn}>{a.rn.slice(-2)}</span>)}
            {IDLE.map(r => <span key={r.rn} className="v2-seg-cell v2-cell-idle" title={r.rn}>{r.rn.slice(-2)}</span>)}
          </div>
        </div>
        {/* activity */}
        <div className="v2-panel">
          <div className="v2-ph"><span className="v2-ph-t">ACTIVITY</span><span className="v2-ph-c"><Live /></span></div>
          <div className="v2-feed">
            {ACTIVITY.map((l, i) => (
              <div key={i} className="v2-feed-l"><span className="v2-feed-t">{l.t}</span><span className={'v2-feed-m ' + l.s}>{l.rn} {l.m}</span></div>
            ))}
          </div>
        </div>
      </div>
      <div className="v2-ticker"><span>◢ runner-01 waiting 12:22</span><span>◢ runner-06 ⚠ Shared UI overlap</span><span>◢ runner-04 diff ready +142 −38</span><span>◢ runner-08 ✓ merged</span><span>◢ p95 287ms</span></div>
    </div>
  );
}

/* ============ V3 · STUDIO ============ */
function Studio() {
  const selProj = PROJECTS.find(p => p.name === 'Frontend platform');
  const selAgents = selProj.ids.map(ag);
  return (
    <div className="shell v3">
      <div className="v3-top">
        <aside className="v3-side">
          <div className="v3-side-h"><span className="logo">▣</span><span className="nm">Tower</span></div>
          <div className="v3-search"><span className="searchpill" style={{ width: '100%' }}>Search projects <kbd>⌘K</kbd></span></div>
          <div className="v3-seclabel">PROJECTS</div>
          <div className="v3-plist">
            {PROJECTS.map(p => {
              const pa = p.ids.map(ag);
              const on = p.name === selProj.name;
              return (
                <button key={p.name} className={'v3-pcard' + (on ? ' on' : '')}>
                  <span className="v3-pcover" style={{ background: modColor(p.module) }}>{p.name[0]}</span>
                  <span className="v3-pinfo"><span className="v3-pname">{p.name}</span><span className="v3-pmeta">{p.done ? 'shipped' : pa.length + ' agent' + (pa.length > 1 ? 's' : '') + ' · ' + p.module}</span></span>
                  {pa.some(a => a.status === 'waiting' || a.status === 'review') && <span className="rdot rdot-waiting"></span>}
                </button>
              );
            })}
          </div>
        </aside>
        <main className="v3-main">
          <div className="v3-hero">
            <div className="v3-hero-cover" style={{ background: 'linear-gradient(145deg, ' + modColor(selProj.module) + ', #11141A)' }}>{selProj.name[0]}</div>
            <div className="v3-hero-info">
              <span className="v3-hero-kind">Project · in progress</span>
              <span className="v3-hero-name">{selProj.name}</span>
              <span className="v3-hero-goal">{selProj.goal}</span>
              <span className="v3-hero-stats"><span>2 agents</span><span className="v3-hero-dot"></span><span>1 backlog</span><span className="v3-hero-dot"></span><span style={{ color: 'var(--danger)' }}>⚠ Shared UI overlap</span></span>
            </div>
          </div>
          <div className="v3-actions">
            <button className="v3-play">▶</button>
            <button className="rbtn">Assign agent</button>
            <button className="rbtn rbtn-ghost">Edit goal</button>
          </div>
          <div className="v3-tasks">
            {[...selAgents, { id: 'b1', rn: '', task: 'Empty-states audit', status: 'backlog', cur: 'In backlog', prog: 0, step: 0, steps: 0 }].map((a, i) => (
              <div key={a.id} className="v3-task">
                <span className="v3-task-i">{a.status === 'backlog' ? '+' : i + 1}</span>
                <span className="v3-task-nm">{a.task}</span>
                <span className="v3-task-rn">{a.rn ? <React.Fragment><G p={a.prov} /> {a.rn}</React.Fragment> : <span style={{ color: 'var(--accent)' }}>Assign →</span>}</span>
                <span className="v3-task-st">{a.status === 'backlog' ? '—' : a.cur}</span>
                <span className="v3-task-pct">{a.status === 'backlog' ? '' : Math.round(a.prog * 100) + '%'}</span>
              </div>
            ))}
          </div>
        </main>
      </div>
      {/* transport dock */}
      <div className="v3-dock">
        <div className="v3-dock-now">
          <span className="v3-dock-cover" style={{ background: modColor('Dashboard') }}>D</span>
          <div className="v3-dock-meta">
            <div className="v3-dock-task">Dashboard query performance</div>
            <div className="v3-dock-sub"><G p="gemini" /> runner-07 · building · live 4s ago</div>
          </div>
        </div>
        <div className="v3-dock-transport">
          <div className="v3-transport-btns"><span>⏮</span><span className="main">▶</span><span>⏭</span></div>
          <div className="v3-scrub"><span>step 2/4</span><span className="track"><span className="fill" style={{ width: '31%' }}></span><span className="knob" style={{ left: '31%' }}></span></span><span>~6m</span></div>
        </div>
        <div className="v3-dock-right">
          <span className="v3-needs-pill">⏸ 4 need you</span>
          <div className="v3-fleet-mini">
            {AGENTS.filter(a => a.status === 'running').slice(0, 4).map(a => <span key={a.id} className="av" style={{ color: PROV[a.prov].c }}>{PROV[a.prov].g}</span>)}
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { Operator, Cockpit, Studio, MiniProduct, modColor });
