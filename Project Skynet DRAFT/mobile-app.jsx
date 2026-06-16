// Tower Mobile — Push to Approve flow
// Lock-screen notification → one-tap review card → approved confirmation.

const M_RUNNERS = { billing: 'runner-01', deploy: 'runner-02', onboard: 'runner-03', ratelimit: 'runner-04' };

function fmtW(sec) { const m = Math.floor(sec / 60); return m > 0 ? m + 'm' : sec + 's'; }

function LockScreen({ items, onOpen }) {
  return (
    <div className="m-lock">
      <div className="m-clock">14:06</div>
      <div className="m-date">Friday, June 12</div>
      <div className="m-notifs">
        {items.map((it, i) => (
          <button key={it.id} className="m-notif" onClick={() => onOpen(i)}>
            <span className="m-notif-head">
              <span className="m-notif-app"><span className="m-notif-icon">▣</span> TOWER</span>
              <span className="m-notif-when">{fmtW(it.waited)} ago</span>
            </span>
            <span className="m-notif-title">{M_RUNNERS[it.agentId]} is blocked — {KIND_META[it.kind].label.toLowerCase()}</span>
            <span className="m-notif-body">{it.title}</span>
            <span className="m-notif-hint">Tap to review · agent waits until you act</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ApprovalCard({ item, remaining, onResolve, onBack }) {
  const k = KIND_META[item.kind];
  return (
    <div className="m-card">
      <div className="m-nav">
        <button className="m-back" onClick={onBack}>‹ Inbox</button>
        <span className="m-nav-count">{remaining} waiting</span>
      </div>
      <div className="m-kind" style={{ color: k.color, borderColor: k.color }}>{k.label}</div>
      <h1 className="m-title">{item.title}</h1>
      <div className="m-agentline mono">{M_RUNNERS[item.agentId]} · waiting {fmtW(item.waited)}</div>
      <p className="m-why">{item.why}</p>
      {item.command && <pre className="m-code">$ {item.command}</pre>}
      {item.steps && <ol className="m-steps">{item.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>}
      {item.diff && (
        <div className="m-diff"><span className="m-add">+{item.diff.add}</span><span className="m-del">−{item.diff.del}</span><span className="m-dfiles">{item.diff.files.length} files</span></div>
      )}
      <div className="m-actions">
        {item.options ? item.options.map((opt, i) => (
          <button key={i} className={'m-btn' + (i === item.recommended ? ' m-btn-primary' : '')}
                  onClick={() => onResolve('approve')}>“{opt}”</button>
        )) : (
          <button className="m-btn m-btn-primary" onClick={() => onResolve('approve')}>Approve</button>
        )}
        {!item.options && <button className="m-btn m-btn-danger" onClick={() => onResolve('reject')}>Reject</button>}
        <button className="m-btn m-btn-ghost" onClick={onBack}>Decide at my desk</button>
      </div>
    </div>
  );
}

function DoneScreen({ item, remaining, onNext, onLock }) {
  return (
    <div className="m-done">
      <div className="m-done-mark">✓</div>
      <div className="m-done-title">{M_RUNNERS[item.agentId]} resumed</div>
      <p className="m-done-sub">{item.title}</p>
      {remaining > 0
        ? <button className="m-btn m-btn-primary" onClick={onNext}>Next — {remaining} still waiting →</button>
        : <div className="m-done-clear">Inbox clear — every agent is working.</div>}
      <button className="m-btn m-btn-ghost" onClick={onLock}>Done for now</button>
    </div>
  );
}

function MobileApp() {
  const [items, setItems] = React.useState(QUEUE.slice(0, 3));
  const [screen, setScreen] = React.useState('lock'); // lock | card | done
  const [idx, setIdx] = React.useState(0);
  const [last, setLast] = React.useState(null);

  const resolve = () => {
    setLast(items[idx]);
    setItems(list => list.filter((_, i) => i !== idx));
    setIdx(0);
    setScreen('done');
  };

  return (
    <div className="m-stage">
      <IOSDevice dark title="">
        {screen === 'lock' && (items.length > 0
          ? <LockScreen items={items} onOpen={(i) => { setIdx(i); setScreen('card'); }} />
          : <div className="m-lock"><div className="m-clock">14:09</div><div className="m-date">Friday, June 12</div><div className="m-done-clear" style={{ marginTop: '40px' }}>No notifications — all agents working.</div></div>)}
        {screen === 'card' && items[idx] && (
          <ApprovalCard item={items[idx]} remaining={items.length}
                        onResolve={resolve} onBack={() => setScreen('lock')} />
        )}
        {screen === 'done' && last && (
          <DoneScreen item={last} remaining={items.length}
                      onNext={() => setScreen('card')} onLock={() => setScreen('lock')} />
        )}
      </IOSDevice>
      <aside className="m-note">
        <h2>Push to Approve</h2>
        <p>When an agent pauses for input, the pilot gets a push. The whole loop — read context, approve, agent resumes — is one tap from the lock screen.</p>
        <ol>
          <li>Notification carries the blocker, not just an alert</li>
          <li>Card shows why + the exact command or plan</li>
          <li>Approve / reject / defer to desk — then straight to the next one</li>
        </ol>
        <a className="m-link" href="Tower — Mission Control.html">← Back to Mission Control</a>
      </aside>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<MobileApp />);
