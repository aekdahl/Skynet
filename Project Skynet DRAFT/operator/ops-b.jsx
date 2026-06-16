// Tower — Operator variations B: D · Preview-forward, E · Workbench

/* ============ D · PREVIEW-FORWARD ============ */
function OpPreview() {
  const sel = BLOCKERS[2];          // CTA copy decision (onboarding, visual)
  const a = ag(sel.id);
  return (
    <div className="shell op4">
      <div className="op4-titlebar">
        <div className="tl"><i className="r"></i><i className="y"></i><i className="g"></i></div>
        <div className="op4-title">Tower — Mission Control</div>
        <div className="op4-titler"><span className="searchpill">Search <kbd>⌘K</kbd></span><span className="avatar">JD</span></div>
      </div>
      <div className="op4-body">
        <aside className="op4-side">
          <button className="op4-navitem"><span className="ic">⌂</span> Home</button>
          <button className="op4-navitem on"><span className="ic">⊙</span> Inbox</button>
          <button className="op4-navitem"><span className="ic">▤</span> Projects</button>
          <button className="op4-navitem"><span className="ic">◇</span> Fleet</button>
          <div className="op4-navsec">PROJECTS</div>
          {PROJECTS.filter(p => !p.done).map(p => (
            <div key={p.name} className="op4-pitem"><span className="op4-pdot" style={{ background: modColor(p.module) }}></span>{p.name}</div>
          ))}
        </aside>
        <section className="op4-list">
          <div className="op4-list-head">Inbox <small>4 need you</small></div>
          <div className="op4-rows">
            {BLOCKERS.map(b => {
              const ba = ag(b.id);
              return (
                <div key={b.id} className={'op4-row' + (b.id === sel.id ? ' sel' : '')} style={b.id === sel.id ? { borderLeftColor: modColor(ba.module) } : null}>
                  <div className="op4-row-top"><span className="kchip" style={{ color: b.kc, borderColor: b.kc }}>{b.kind}</span><span className="op4-row-wait">{b.wait}</span></div>
                  <div className="op4-row-title">{b.title}</div>
                  <div className="op4-row-meta"><G p={ba.prov} /> {ba.rn} · {ba.module}</div>
                </div>
              );
            })}
          </div>
        </section>
        <section className="op4-detail">
          <div className="op4-hero">
            <div className="op4-hero-prev"><MiniProduct kind="Onboarding" /></div>
            <div className="op4-hero-tag"><Live /> live preview · {a.rn} building · {a.hb}s ago · step {a.step}/{a.steps}</div>
          </div>
          <div className="op4-det-body">
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span className="kchip" style={{ color: sel.kc, borderColor: sel.kc }}>{sel.kind}</span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: '11px', color: 'var(--warn)' }}>⏸ {sel.wait}</span>
            </div>
            <div className="op4-det-title">{sel.title}</div>
            <div className="op4-det-sub"><span><G p={a.prov} /> {a.rn} · {a.model}</span><span>{a.proj}</span><span>{a.module}</span></div>
            <div className="op4-why">{sel.why}</div>
          </div>
          <div className="op4-actbar">
            {sel.options.map((o, i) => <button key={i} className={'rbtn' + (i === 0 ? ' rbtn-primary' : '')}>“{o}”</button>)}
            <button className="rbtn rbtn-ghost">Modify</button>
            <button className="rbtn rbtn-ghost">Chat</button>
          </div>
        </section>
      </div>
    </div>
  );
}

/* ============ E · WORKBENCH ============ */
function OpWorkbench() {
  const sel = BLOCKERS[3];          // diff review (API) — IDE-ish
  const a = ag(sel.id);
  const plan = [
    { t: 'Token-bucket middleware', s: 'done' },
    { t: 'Per-tenant config', s: 'done' },
    { t: 'Load test @ 10k rps', s: 'done' },
    { t: 'Review & merge', s: 'now' },
  ];
  return (
    <div className="shell op5">
      <div className="op5-titlebar">
        <div className="tl"><i className="r"></i><i className="y"></i><i className="g"></i></div>
        <span className="op5-title">Tower — Workbench</span>
        <span className="op5-titler"><span className="searchpill">Search or run <kbd>⌘K</kbd></span><span className="avatar">JD</span></span>
      </div>
      <div className="op5-body">
        <nav className="op-rail">
          <div className="op-rail-logo">▣</div>
          <button className="op-rail-ic" title="Home">⌂</button>
          <button className="op-rail-ic on" title="Inbox">⊙<span className="badge">4</span></button>
          <button className="op-rail-ic" title="Projects">▤</button>
          <button className="op-rail-ic" title="Fleet">◇</button>
          <button className="op-rail-ic" title="Timeline">▭</button>
          <div className="op-rail-foot"><button className="op-rail-ic" title="Settings">⚙</button></div>
        </nav>
        <section className="op5-list">
          <div className="op5-list-head"><span>INBOX</span><span>4</span></div>
          <div className="op5-rows">
            {BLOCKERS.map(b => {
              const ba = ag(b.id);
              return (
                <div key={b.id} className={'op5-row' + (b.id === sel.id ? ' sel' : '')}>
                  <span className={'rdot rdot-' + ba.status}></span>
                  <span className="op5-row-main">
                    <span className="op5-row-title">{b.title}</span>
                    <span className="op5-row-meta"><G p={ba.prov} /> {ba.rn} · {ba.module}</span>
                  </span>
                  <span className="op5-row-wait">{b.wait}</span>
                </div>
              );
            })}
          </div>
        </section>
        <section className="op5-detail">
          <div className="op5-tabbar">
            <button className="op5-tab on">Context</button>
            <button className="op5-tab">Plan <span className="ct">4</span></button>
            <button className="op5-tab">Diff <span className="ct">+142 −38</span></button>
            <button className="op5-tab">Chat</button>
            <button className="op5-tab">Preview</button>
          </div>
          <div className="op5-det-body">
            <div className="op5-det-title">{sel.title}</div>
            <div className="op5-det-sub"><span className="kchip" style={{ color: sel.kc, borderColor: sel.kc }}>{sel.kind}</span><span><G p={a.prov} /> {a.rn} · {a.model}</span><span>{a.branch}</span><span style={{ color: 'var(--warn)' }}>⏸ {sel.wait}</span></div>
            <div className="op5-sec">
              <div className="op5-sec-h">WHY THIS STOPPED</div>
              <div className="op5-why">{sel.why}</div>
              <div className="op5-code">api/middleware/ratelimit.ts · +142 −38 · 6 files changed</div>
            </div>
            <div className="op5-sec">
              <div className="op5-sec-h">PLAN · 3/4</div>
              <div className="op5-plan">
                {plan.map((p, i) => (
                  <div key={i} className={'op5-step ' + p.s}><span className="mk">{p.s === 'done' ? '✓' : '▸'}</span>{p.t}</div>
                ))}
              </div>
            </div>
            <div className="op5-sec">
              <div className="op5-sec-h">MODIFIED MODULES</div>
              <div style={{ display: 'flex', gap: '8px' }}><span className="kchip" style={{ color: 'var(--text)', borderColor: 'var(--line)' }}>API</span><span className="kchip" style={{ color: 'var(--text)', borderColor: 'var(--line)' }}>API Middleware</span></div>
            </div>
          </div>
          <div className="op5-actbar">
            <button className="rbtn rbtn-primary rbtn-sm">Approve &amp; merge</button>
            <button className="rbtn rbtn-danger rbtn-sm">Request changes</button>
            <button className="rbtn rbtn-ghost rbtn-sm">Modify</button>
            <button className="rbtn rbtn-ghost rbtn-sm">Chat</button>
          </div>
        </section>
      </div>
      <div className="op5-statusbar">
        <span><Live /> 7 running</span>
        <span>runner-04 · agent/ratelimit</span>
        <span className="r"><span className="warn">⏸ 4 need you</span><span className="ok">✓ tests 14/14</span><span>UTF-8 · main · v2.18.0</span></span>
      </div>
    </div>
  );
}

Object.assign(window, { OpPreview, OpWorkbench });
