// Tower — Reimagined: shells B — Canvas (spatial OS), Columns (TweetDeck)

/* ============ V4 · CANVAS ============ */
function Win({ x, y, w, h, title, mod, focus, children }) {
  return (
    <div className={'v4-win' + (focus ? ' focus' : '')} style={{ left: x, top: y, width: w, height: h }}>
      <div className="v4-win-bar">
        <div className="tl dotsm"><i className="r"></i><i className="y"></i><i className="g"></i></div>
        <span className="v4-win-title">{title}{mod && <span className="mod">{mod}</span>}</span>
      </div>
      <div className="v4-win-body">{children}</div>
    </div>
  );
}

function Canvas() {
  const dash = ag('a7'), tok = ag('a6'), onb = ag('a3'), bill = ag('a1');
  return (
    <div className="shell v4">
      <div className="v4-menubar">
        <span className="brand">⬢ Tower</span>
        <span className="mi">File</span><span className="mi">View</span><span className="mi">Fleet</span><span className="mi">Window</span><span className="mi">Help</span>
        <span className="r"><span><Live /> 7 running</span><span>⌥⌘ space</span><span>14:32</span></span>
      </div>
      <div className="v4-space">
        {/* Frontend platform window — visual, with live preview */}
        <Win x={32} y={26} w={360} h={300} title="Frontend platform" mod="Shared UI · Dashboard">
          <div className="v4-goal">Design tokens everywhere; dashboard p95 under 300ms.</div>
          <div className="v4-prev"><MiniProduct kind="Dashboard" /></div>
          <div className="v4-agent-row"><Dot s={dash.status} /><span className="nm"><G p={dash.prov} /> {dash.task}</span><span className="pct">31%</span></div>
          <div className="v4-agent-row"><Dot s={tok.status} /><span className="nm"><G p={tok.prov} /> {tok.task} ⚠</span><span className="pct">77%</span></div>
        </Win>

        {/* Onboarding window — visual */}
        <Win x={416} y={150} w={300} h={296} title="Onboarding revamp" mod="Onboarding">
          <div className="v4-prev" style={{ flex: '0 0 150px' }}><MiniProduct kind="Onboarding" /></div>
          <div className="v4-agent-row"><Dot s={onb.status} /><span className="nm"><G p={onb.prov} /> {onb.task}</span><span className="pct">58%</span></div>
          <div className="v4-goal">⏸ Waiting: CTA copy decision — 4:11</div>
        </Win>

        {/* Needs-you / blocker window — focused */}
        <Win x={742} y={40} w={328} h={244} title="Needs you" focus>
          <div className="v4-bw-wait">12:22 <span style={{ fontSize: '10px', color: 'var(--faint)', fontWeight: 400 }}>WAITING</span></div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}><span className="kchip" style={{ color: bill.status === 'waiting' ? '#FFB224' : '#fff', borderColor: '#FFB224' }}>APPROVAL</span><span style={{ fontSize: '11px', color: 'var(--faint)', fontFamily: 'var(--mono)' }}>{bill.rn} · Billing</span></div>
          <div style={{ fontSize: '14px', fontWeight: 600 }}>Run database migration on staging</div>
          <div className="v4-bw-why">Migration 0142 dry-run passed (2.1M rows, lock est. 2.4s).</div>
          <div className="v4-bw-act"><button className="rbtn rbtn-primary rbtn-sm">Approve</button><button className="rbtn rbtn-danger rbtn-sm">Reject</button><button className="rbtn rbtn-ghost rbtn-sm">Open</button></div>
        </Win>

        {/* Backend window — no visual, terminal-ish */}
        <Win x={742} y={300} w={328} h={150} title="API hardening" mod="API · Auth">
          <div className="v4-agent-row"><Dot s="review" /><span className="nm"><G p="codex" /> API rate limiting</span><span className="pct">+142 −38</span></div>
          <div className="v4-agent-row"><Dot s="running" /><span className="nm"><G p="claude" /> Token refresh rotation</span><span className="pct">62%</span></div>
        </Win>

        {/* dock */}
        <div className="v4-dock">
          <div className="v4-dock-ic" title="Home">⌂</div>
          <div className="v4-dock-ic accent" title="Inbox">⊙<span className="v4-dock-badge">4</span></div>
          <div className="v4-dock-ic" title="Projects">▤</div>
          <div className="v4-dock-sep"></div>
          <div className="v4-dock-ic" title="Fleet">◇</div>
          <div className="v4-dock-ic" title="Timeline">▭</div>
          <div className="v4-dock-ic" title="Activity">≋</div>
        </div>
      </div>
    </div>
  );
}

/* ============ V5 · COLUMNS ============ */
function Columns() {
  const running = AGENTS.filter(a => a.status === 'running');
  return (
    <div className="shell v5">
      <div className="v5-rail">
        <div className="v5-rail-logo">▣</div>
        <button className="v5-rail-ic on" title="Board">▦</button>
        <button className="v5-rail-ic" title="Inbox">⊙<span className="badge">4</span></button>
        <button className="v5-rail-ic" title="Projects">▤</button>
        <button className="v5-rail-ic" title="Fleet">◇</button>
        <button className="v5-rail-ic" title="Timeline">▭</button>
        <button className="v5-rail-ic v5-rail-foot" title="Settings">⚙</button>
      </div>
      <div className="v5-wrap">
        <div className="v5-toolbar">
          <span className="t">Workspace</span>
          <span className="searchpill">Search or run a command <kbd>⌘K</kbd></span>
          <span className="r"><button className="rbtn rbtn-ghost rbtn-sm">+ Add column</button><span className="avatar">JD</span></span>
        </div>
        <div className="v5-cols">
          {/* INBOX */}
          <div className="v5-col">
            <div className="v5-col-h"><span className="v5-col-ic">⊙</span><span className="v5-col-t">Inbox</span><span className="v5-col-c">4</span></div>
            <div className="v5-col-b">
              {BLOCKERS.map(b => {
                const ba = ag(b.id);
                return (
                  <div key={b.id} className="v5-card hot">
                    <div className="v5-card-top"><span className="kchip" style={{ color: b.kc, borderColor: b.kc }}>{b.kind}</span><span className="v5-card-wait">{b.wait}</span></div>
                    <div className="v5-card-title">{b.title}</div>
                    <div className="v5-card-meta"><G p={ba.prov} /> {ba.rn} · {ba.module}</div>
                    <div className="v5-card-act"><button className="rbtn rbtn-primary rbtn-sm">Approve</button><button className="rbtn rbtn-danger rbtn-sm">Reject</button><button className="rbtn rbtn-ghost rbtn-sm">Open</button></div>
                  </div>
                );
              })}
            </div>
          </div>
          {/* RUNNING */}
          <div className="v5-col">
            <div className="v5-col-h"><span className="v5-col-ic" style={{ color: 'var(--ok)' }}>▸</span><span className="v5-col-t">Running</span><span className="v5-col-c">{running.length}</span></div>
            <div className="v5-col-b">
              {running.map(a => (
                <div key={a.id} className="v5-card">
                  <div className="v5-card-top"><Dot s={a.status} /><span className="v5-card-title" style={{ fontSize: '12.5px' }}>{a.task}</span></div>
                  <div className="v5-card-meta"><G p={a.prov} /> {a.rn} · {a.module}{a.conflict && <span style={{ color: 'var(--danger)' }}> ⚠</span>}</div>
                  <Bar v={a.prog} s={a.status} />
                  <div className="v5-run-step"><span>→ {a.cur}</span><span className="mono">{a.step}/{a.steps}</span></div>
                </div>
              ))}
            </div>
          </div>
          {/* FLEET */}
          <div className="v5-col">
            <div className="v5-col-h"><span className="v5-col-ic">◇</span><span className="v5-col-t">Fleet</span><span className="v5-col-c">9</span></div>
            <div className="v5-col-b">
              {AGENTS.filter(a => a.status !== 'done').map(a => (
                <div key={a.id} className="v5-card v5-fleet-card">
                  <G p={a.prov} /><span className="v5-fleet-rn">{a.rn}</span><span className="v5-fleet-model">{a.model}</span>
                </div>
              ))}
              {IDLE.map(r => (
                <div key={r.rn} className="v5-card v5-fleet-card idle">
                  <span className="rdot rdot-idle"></span><span className="v5-fleet-rn" style={{ color: 'var(--faint)' }}>{r.rn}</span><span className="v5-fleet-model">idle {r.idle}</span>
                </div>
              ))}
            </div>
          </div>
          {/* TIMELINE */}
          <div className="v5-col">
            <div className="v5-col-h"><span className="v5-col-ic">▭</span><span className="v5-col-t">Timeline</span><span className="v5-col-c">today</span></div>
            <div className="v5-col-b">
              {AGENTS.map(a => (
                <div key={a.id} className="v5-tl-row">
                  <div className="v5-card-meta" style={{ color: 'var(--muted)' }}>{a.proj}</div>
                  <div className="v5-tl-bar">
                    <span className={'v5-tl-fill rbar-' + a.status} style={{ width: Math.round(a.prog * 100) + '%' }}></span>
                    <span className="v5-tl-label"><span className="mono" style={{ color: 'var(--faint)', marginRight: '6px' }}>{a.rn}</span>{a.task}{a.status === 'done' ? ' ✓' : (a.status === 'waiting' || a.status === 'review') ? ' ⏸' : ''}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { Canvas, Columns });
