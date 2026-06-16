// Option 3 — Roster split: agent pool on the left, ongoing tasks by project on the right

function ExRoster() {
  const busy = EX_AGENTS.filter(a => a.s !== 'idle').length;
  const byProj = {};
  EX_TASKS.forEach(t => { (byProj[t.proj] = byProj[t.proj] || []).push(t); });
  return (
    <div className="ex-board">
      <ExHead title="Mission control" sub="Who's working — and on what" />
      <div className="rs-cols">
        <div className="rs-left">
          <div className="ex-sec-head">AGENT POOL · {busy} busy / {EX_AGENTS.length - busy} idle</div>
          <div className="rs-cards">
            {EX_AGENTS.map(a => (
              <div key={a.n} className={'rs-card' + (a.s === 'idle' ? ' rs-card-idle' : '')}>
                <div className="rs-card-top">
                  <ExDot s={a.s} />
                  <span className="mono rs-id">{a.n}</span>
                  <span className="rs-model">{a.model}</span>
                </div>
                {a.s === 'idle'
                  ? <div className="rs-idle-row"><span>idle {a.idle}</span><span className="rs-assign">Assign task →</span></div>
                  : <div className="rs-task">{a.task}</div>}
              </div>
            ))}
          </div>
        </div>
        <div className="rs-right">
          <div className="ex-sec-head">ONGOING TASKS · {EX_TASKS.length}</div>
          <div className="rs-tasks">
            {Object.entries(byProj).map(([proj, tasks]) => (
              <div key={proj} className="rs-proj">
                <div className="rs-proj-name">{proj}</div>
                {tasks.map(t => (
                  <div key={t.t} className="rs-task-row">
                    <ExDot s={t.s} />
                    <div className="rs-task-main">
                      <span className="rs-task-name">{t.t}</span>
                      <span className="rs-task-step">{t.n}/{t.of} · {t.step}</span>
                    </div>
                    <ExBar v={t.p} s={t.s} />
                    <span className={'lg-state lg-state-' + t.s}>{t.wait ? '⏸ ' + t.wait : Math.round(t.p * 100) + '%'}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// Option 4 (rethought) — Control Tower: what's stopping work, front and center;
// agent capacity and conflicts at a glance. No tiles, no map.

function ExWall() {
  const needs = [
    { timer: '12:22', kind: 'APPROVAL', kc: 'var(--warn)', hot: true, title: 'Run database migration on staging', meta: 'runner-01 · Payments reliability', actions: [{ l: 'Approve', p: true }, { l: 'Reject' }] },
    { timer: '09:23', kind: 'PLAN REVIEW', kc: 'var(--violet)', hot: true, title: 'Approve blue-green rollout plan', meta: 'runner-02 · Deploy pipeline', actions: [{ l: 'Approve plan', p: true }, { l: 'Request changes' }] },
    { timer: '04:11', kind: 'DECISION', kc: 'var(--info)', title: 'CTA copy for onboarding step 3', meta: 'runner-03 · Onboarding revamp', actions: [{ l: '“Invite your team”', p: true }, { l: '“Add teammates…”' }] },
    { timer: '02:18', kind: 'DIFF REVIEW', kc: 'var(--ok)', title: 'Token-bucket rate limiting · +142 −38', meta: 'runner-04 · API hardening', actions: [{ l: 'Approve & merge', p: true }, { l: 'Open diff' }] },
  ];
  const running = EX_TASKS.filter(t => t.s === 'active');
  return (
    <div className="ex-board">
      <ExHead title="Control tower" sub="First question answered first: what is stopping work right now?" />
      <div className="ct-cols">
        <div>
          <div className="ex-sec-head">NEEDS YOU · 4 — oldest first</div>
          <div className="ct-cards">
            {needs.map(n => (
              <div key={n.title} className={'ct-card' + (n.hot ? ' ct-card-hot' : '')}>
                <div className="ct-timer">{n.timer}<small>WAITING</small></div>
                <div className="ct-main">
                  <div className="ct-head-row">
                    <span className="ct-chip" style={{ color: n.kc, borderColor: n.kc }}>{n.kind}</span>
                    <span className="ct-meta">{n.meta}</span>
                  </div>
                  <span className="ct-title">{n.title}</span>
                  <div className="ct-actions">
                    {n.actions.map(a => <span key={a.l} className={'ct-btn' + (a.p ? ' ct-btn-p' : '')}>{a.l}</span>)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="ct-right">
          <div>
            <div className="ex-sec-head">AGENT CAPACITY · 7/9 BUSY</div>
            <div className="ct-cap">
              {EX_AGENTS.map(a => (
                <span key={a.n} className={'ct-seg ct-seg-' + (a.s === 'blocked' ? 'blocked' : a.s === 'review' ? 'review' : a.s)} title={a.n + (a.task ? ' · ' + a.task : ' · idle')}>
                  {a.n.slice(-2)}
                </span>
              ))}
            </div>
            <p className="ct-cap-note">2 idle — runner-08 (41m) and runner-09 (18m) can take new tasks.</p>
          </div>
          <div>
            <div className="ex-sec-head">RUNNING · {running.length}</div>
            <div className="ct-run">
              {running.map(t => (
                <div key={t.t} className="ct-run-row">
                  <ExDot s={t.s} />
                  <div className="ct-run-main">
                    <span className="ct-run-name">{t.t}</span>
                    <span className="ct-run-step">{t.n}/{t.of} · {t.step}</span>
                  </div>
                  <ExBar v={t.p} s={t.s} />
                  <span className="ct-run-pct mono">{Math.round(t.p * 100)}%</span>
                </div>
              ))}
            </div>
          </div>
          <div>
            <div className="ex-sec-head">CONFLICTS · 1</div>
            <div className="ct-conflict">
              <b>shared/ui</b> — runner-03 (onboarding) and runner-06 (token migration) are both editing <span className="mono">Button.tsx</span>. Sequence the merges or reassign one.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { ExRoster, ExWall });
