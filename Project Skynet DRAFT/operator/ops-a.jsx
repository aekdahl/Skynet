// Tower — Operator variations A: B · Rail/Pro, C · Focus

/* ============ B · RAIL / PRO ============ */
function OpRail() {
  const sel = BLOCKERS[0];
  const a = ag(sel.id);
  const waiting = BLOCKERS.filter(b => b.kind !== 'DIFF REVIEW');
  const review = BLOCKERS.filter(b => b.kind === 'DIFF REVIEW');
  const Row = (b, i) => {
    const ba = ag(b.id);
    return (
      <div key={b.id} className={'op2-row' + (b.id === sel.id ? ' sel' : '')}>
        <span className={'rdot rdot-' + ba.status}></span>
        <span className="op2-row-main">
          <span className="op2-row-title">{b.title}</span>
          <span className="op2-row-meta"><G p={ba.prov} /> {ba.rn} · {ba.module}</span>
        </span>
        <span className="op2-row-wait">{b.wait}</span>
      </div>
    );
  };
  return (
    <div className="shell op2">
      <div className="op2-bar">
        <span className="op2-crumb"><span>Atlas</span><span className="sep">/</span><span className="muted">Inbox</span></span>
        <span className="op2-search"><span className="searchpill">Search or run a command <kbd>⌘K</kbd></span></span>
        <span className="op2-bar-r"><span className="op2-chip">Oldest ▾</span><span className="avatar">JD</span></span>
      </div>
      <div className="op2-body">
        <nav className="op-rail">
          <div className="op-rail-logo">▣</div>
          <button className="op-rail-ic" title="Home">⌂</button>
          <button className="op-rail-ic on" title="Inbox">⊙<span className="badge">4</span></button>
          <button className="op-rail-ic" title="Projects">▤</button>
          <button className="op-rail-ic" title="Fleet">◇</button>
          <button className="op-rail-ic" title="Timeline">▭</button>
          <div className="op-rail-foot"><button className="op-rail-ic" title="Settings">⚙</button><span className="avatar">JD</span></div>
        </nav>
        <section className="op2-list">
          <div className="op2-list-head">
            <span className="op2-list-title">Inbox <small>4 need you</small></span>
            <span className="op2-seg"><button className="on">Oldest</button><button>Kind</button></span>
          </div>
          <div className="op2-rows">
            <div className="op2-grp">WAITING · {waiting.length}</div>
            {waiting.map(Row)}
            <div className="op2-grp">IN REVIEW · {review.length}</div>
            {review.map(Row)}
          </div>
        </section>
        <section className="op2-detail">
          <div className="op2-det-head">
            <div className="op2-det-headmain">
              <div className="op2-det-kind"><span className="kchip" style={{ color: sel.kc, borderColor: sel.kc }}>{sel.kind}</span><span style={{ fontFamily: 'var(--mono)', fontSize: '11px', color: 'var(--warn)' }}>waiting {sel.wait}</span></div>
              <div className="op2-det-title">{sel.title}</div>
              <div className="op2-det-sub"><span><G p={a.prov} /> {a.rn} · {a.model}</span><span>{a.proj}</span><span>{a.branch}</span></div>
            </div>
            <div className="op2-det-actions">
              <button className="rbtn rbtn-primary rbtn-sm">Approve</button>
              <button className="rbtn rbtn-danger rbtn-sm">Reject</button>
              <button className="rbtn rbtn-ghost rbtn-sm">Modify</button>
              <button className="rbtn rbtn-ghost rbtn-sm">Chat</button>
            </div>
          </div>
          <div className="op2-det-body">
            <div className="op2-card wide">
              <div className="op2-card-h">WHY THIS STOPPED</div>
              <div className="op2-why">{sel.why}</div>
              <div className="op2-code">$ psql atlas_staging &lt; migrations/0142_reconcile.sql</div>
            </div>
            <div className="op2-card">
              <div className="op2-card-h">PROGRESS</div>
              <div className="op2-kv">
                <div className="op2-kv-row"><span className="k">Current step</span><span className="v">{a.step}/{a.steps}</span></div>
                <div className="op2-kv-row"><span className="k">{a.cur}</span><span className="v">{Math.round(a.prog * 100)}%</span></div>
                <Bar v={a.prog} s={a.status} />
              </div>
            </div>
            <div className="op2-card">
              <div className="op2-card-h">CONTEXT</div>
              <div className="op2-kv">
                <div className="op2-kv-row"><span className="k">Module</span><span className="v">{a.module}</span></div>
                <div className="op2-kv-row"><span className="k">Heartbeat</span><span className="v" style={{ color: 'var(--ok)' }}>♥ {a.hb}s ago</span></div>
                <div className="op2-kv-row"><span className="k">Provider</span><span className="v"><G p={a.prov} /> {PROV[a.prov].n}</span></div>
              </div>
            </div>
          </div>
        </section>
      </div>
      <div className="op-statusbar">
        <span><b>9</b> runners · <b className="ok">7</b> busy · <b>2</b> idle</span>
        <span><b className="ok">4</b> need you · longest <b>12:22</b></span>
        <span className="r">main · <span className="ok">✓ synced</span> · v2.18.0</span>
      </div>
    </div>
  );
}

/* ============ C · FOCUS ============ */
function OpFocus() {
  const sel = BLOCKERS[0];
  const a = ag(sel.id);
  return (
    <div className="shell op3">
      <div className="op3-top">
        <span></span>
        <span className="op3-top-c"><b>Needs you</b> · 4 waiting · oldest first</span>
        <span className="op3-top-r"><span className="searchpill">⌘K</span></span>
      </div>
      <div className="op3-body">
        <nav className="op-rail">
          <div className="op-rail-logo">▣</div>
          <button className="op-rail-ic" title="Home">⌂</button>
          <button className="op-rail-ic on" title="Inbox">⊙<span className="badge">4</span></button>
          <button className="op-rail-ic" title="Projects">▤</button>
          <button className="op-rail-ic" title="Fleet">◇</button>
          <div className="op-rail-foot"><span className="avatar">JD</span></div>
        </nav>
        <div className="op3-queue">
          <div className="op3-qlabel">QUEUE</div>
          {BLOCKERS.map((b, i) => (
            <button key={b.id} className={'op3-qitem' + (b.id === sel.id ? ' sel' : '')}>
              <span className={'rdot rdot-' + ag(b.id).status}></span>
              <span className="qwait">{b.wait}</span>
              <span className="qttl">{b.title.split(' ').slice(0, 2).join(' ')}…</span>
            </button>
          ))}
        </div>
        <div className="op3-stage">
          <div className="op3-card">
            <div className="op3-kindrow">
              <span className="kchip" style={{ color: sel.kc, borderColor: sel.kc, fontSize: '10px', padding: '3px 9px' }}>{sel.kind}</span>
              <span className="op3-wait">⏸ {sel.wait}</span>
            </div>
            <div className="op3-title">{sel.title}</div>
            <div className="op3-meta"><span><G p={a.prov} /> {a.rn} · {a.model}</span><span>{a.proj}</span><span>step {a.step}/{a.steps}</span></div>
            <div className="op3-why">{sel.why}</div>
            <div className="op3-code">$ psql atlas_staging &lt; migrations/0142_reconcile.sql</div>
            <div className="op3-actions">
              <button className="rbtn rbtn-primary grow">Approve</button>
              <button className="rbtn rbtn-danger">Reject</button>
              <button className="rbtn rbtn-ghost">Modify</button>
              <button className="rbtn rbtn-ghost">Chat</button>
            </div>
            <div className="op3-foot"><kbd>J</kbd> <kbd>K</kbd> move through queue · 3 more after this · runner-01 waits until you act</div>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { OpRail, OpFocus });
