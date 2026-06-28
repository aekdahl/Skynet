// Skynet — GitHub integration (FE surface).
//
// SOTA model: a GitHub *App* (not OAuth/PAT). The operator installs the Skynet
// app on an org/account, grants it least-privilege fine-grained permissions on
// selected repos, and Skynet mints short-lived installation tokens to act on the
// fleet's behalf. Agents work PR-first (branch → PR → checks → review/merge).
//
// This file is the client surface: the connect flow, the safety-policy panel,
// and the Integrations view. The real token exchange / git operations / webhook
// handling live server-side — see docs/github-integration.md for that contract.
// Backend calls here are mocked, consistent with the rest of the prototype.

(function () {
  const GH_KEY = 'tower.github';

  // Least-privilege permissions the Skynet GitHub App requests.
  const APP_PERMISSIONS = [
    { scope: 'Contents', level: 'Read & write', why: 'branch, commit, push agent work' },
    { scope: 'Pull requests', level: 'Read & write', why: 'open & update PRs for review' },
    { scope: 'Checks', level: 'Read', why: 'surface CI status on the agent' },
    { scope: 'Metadata', level: 'Read', why: 'required baseline' },
  ];

  // Safety policy — every guardrail is a toggle, active by default.
  const SAFETY_DEFAULTS = { prOnly: true, noForcePush: true, moduleAllowlist: true, approveBeforePush: true };
  const SAFETY_RULES = [
    { key: 'prOnly', label: 'PR-only writes',
      on: 'Agents branch and open PRs — never push to the default branch directly. Branch protection & required reviews are respected.',
      off: 'Agents may push directly to the default branch. Not recommended.' },
    { key: 'noForcePush', label: 'No force-push / no rewrite',
      on: 'Force-pushes and history rewrites on agent branches are blocked — commits are append-only.',
      off: 'Agents may force-push and rewrite branch history.' },
    { key: 'moduleAllowlist', label: 'Module / path allowlist',
      on: 'An agent may only modify files in its assigned modules (from .skynet/modules.json). Out-of-scope writes are rejected before push.',
      off: 'Agents may modify any path in the repo.' },
    { key: 'approveBeforePush', label: 'Human approval before push / merge',
      on: 'A push or merge is held as an Inbox decision until an operator approves it.',
      off: 'Agents push and merge without an approval gate.' },
  ];

  // ----- persistence (mirrors the workspace store) -----
  function loadGithub() {
    try { const raw = window.localStorage.getItem(GH_KEY); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  }
  function saveGithub(cfg) { try { window.localStorage.setItem(GH_KEY, JSON.stringify(cfg)); } catch (e) {} }
  function clearGithub() { try { window.localStorage.removeItem(GH_KEY); } catch (e) {} }

  function emptyGithub() {
    return { connected: false, installation: null, repos: [], safety: { ...SAFETY_DEFAULTS } };
  }
  const selectedRepos = (gh) => (gh && gh.repos ? gh.repos.filter(r => r.selected) : []);

  // ----- mock GitHub data (stands in for the App-installation API) -----
  const MOCK_ACCOUNTS = [
    { login: 'acme', type: 'Organization', glyph: '▣' },
    { login: 'jordan-diaz', type: 'User', glyph: '◍' },
  ];
  const MOCK_REPOS = {
    acme: [
      { id: 1, name: 'acme/monolith', default_branch: 'main', private: true },
      { id: 2, name: 'acme/web', default_branch: 'main', private: true },
      { id: 3, name: 'acme/infra', default_branch: 'main', private: true },
      { id: 4, name: 'acme/docs', default_branch: 'main', private: false },
    ],
    'jordan-diaz': [
      { id: 5, name: 'jordan-diaz/dotfiles', default_branch: 'main', private: false },
      { id: 6, name: 'jordan-diaz/sandbox', default_branch: 'main', private: true },
    ],
  };

  const GH_CSS = `
    .gh-octi { width: 16px; height: 16px; vertical-align: -3px; fill: currentColor; }
    .gh-card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 20px; }
    .gh-card + .gh-card { margin-top: 16px; }
    .gh-card-head { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
    .gh-card-title { font-size: 15px; font-weight: 600; }
    .gh-card-sub { color: var(--muted); font-size: 12.5px; line-height: 1.6; margin-bottom: 16px; }
    .gh-pill { font-family: var(--font-mono); font-size: 10px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase;
               border-radius: 20px; padding: 3px 9px; border: 1px solid; }
    .gh-pill-ok { color: var(--ok); border-color: rgba(61,214,140,0.4); background: rgba(61,214,140,0.08); }
    .gh-pill-off { color: var(--faint); border-color: var(--line); }
    .gh-perm { display: grid; grid-template-columns: auto auto 1fr; gap: 6px 14px; font-size: 12px; margin: 12px 0 4px; align-items: baseline; }
    .gh-perm .mono { color: var(--accent); }
    .gh-perm-why { color: var(--faint); font-size: 11px; }
    .gh-acct { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; cursor: pointer;
               background: var(--raised); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; color: var(--text);
               font-family: var(--font-ui); font-size: 13px; margin-bottom: 8px; }
    .gh-acct:hover { border-color: var(--faint); }
    .gh-acct-glyph { font-size: 17px; color: var(--accent); }
    .gh-acct-type { margin-left: auto; font-family: var(--font-mono); font-size: 11px; color: var(--faint); }
    .gh-repo { display: flex; align-items: center; gap: 10px; padding: 9px 4px; border-bottom: 1px solid var(--line-soft); cursor: pointer; }
    .gh-repo:last-child { border-bottom: none; }
    .gh-repo-name { font-family: var(--font-mono); font-size: 12.5px; }
    .gh-repo-tags { margin-left: auto; display: flex; gap: 8px; align-items: center; font-family: var(--font-mono); font-size: 10px; color: var(--faint); }
    .gh-check { width: 16px; height: 16px; border-radius: 4px; border: 1px solid var(--line); display: inline-flex; align-items: center; justify-content: center; flex: none; }
    .gh-check.on { background: var(--accent); border-color: var(--accent); color: #0B0D11; font-size: 11px; }
    .gh-conn { display: flex; align-items: center; gap: 12px; }
    .gh-conn-glyph { font-size: 22px; color: var(--accent); }
    .gh-conn-meta { font-family: var(--font-mono); font-size: 11.5px; color: var(--muted); }
    .gh-token { font-family: var(--font-mono); font-size: 11px; color: var(--faint); margin-top: 14px; display: flex; align-items: center; gap: 8px; }
    .gh-token .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ok); display: inline-block; }
    .gh-rule { display: flex; gap: 14px; align-items: flex-start; padding: 14px 0; border-bottom: 1px solid var(--line-soft); }
    .gh-rule:last-child { border-bottom: none; }
    .gh-rule-body { flex: 1; }
    .gh-rule-label { font-size: 13.5px; font-weight: 500; margin-bottom: 3px; }
    .gh-rule-desc { color: var(--muted); font-size: 12px; line-height: 1.55; }
    .gh-rule-desc.is-off { color: var(--danger); }
    .gh-switch { flex: none; width: 38px; height: 22px; border-radius: 12px; border: none; cursor: pointer; position: relative;
                 background: var(--line); transition: background .15s; margin-top: 2px; }
    .gh-switch.on { background: var(--accent); }
    .gh-switch::after { content: ''; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%;
                        background: #fff; transition: transform .15s; }
    .gh-switch.on::after { transform: translateX(16px); }
    .gh-warn { font-size: 11.5px; color: var(--warn); margin-top: 10px; }
    .gh-row { display: flex; gap: 10px; align-items: center; margin-top: 16px; }
    .gh-row .gh-spacer { flex: 1; }
    .gh-back { background: none; border: none; color: var(--muted); font-family: var(--font-ui); font-size: 12px; cursor: pointer; }
    .gh-back:hover { color: var(--text); }
  `;

  function Octicon() {
    return (
      <svg className="gh-octi" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path>
      </svg>
    );
  }

  // The install / repo-selection flow. Renders inline (onboarding) or in settings.
  // Calls onConnected(connection) once an installation + at least one repo is chosen.
  function GithubConnect({ github, onConnected, onDisconnect, manage }) {
    const connected = github && github.connected;
    const [phase, setPhase] = React.useState('idle');   // idle → account → repos
    const [account, setAccount] = React.useState(null);
    const [picked, setPicked] = React.useState({});       // repoId → bool

    if (connected && phase === 'idle') {
      const inst = github.installation; const repos = selectedRepos(github);
      return (
        <div className="gh-card">
          <style>{GH_CSS}</style>
          <div className="gh-card-head">
            <Octicon /><span className="gh-card-title">GitHub</span>
            <span className="gh-pill gh-pill-ok">Connected</span>
          </div>
          <div className="gh-conn">
            <span className="gh-conn-glyph">{inst.glyph}</span>
            <div>
              <div style={{ fontWeight: 600 }}>{inst.account} <span style={{ color: 'var(--faint)', fontWeight: 400, fontSize: 12 }}>· {inst.type}</span></div>
              <div className="gh-conn-meta">Skynet App · installation #{inst.id} · {repos.length} repo{repos.length === 1 ? '' : 's'}</div>
            </div>
          </div>
          <div className="gh-token"><span className="dot"></span> Acting via short-lived installation tokens (auto-refreshed hourly) — no long-lived secrets stored.</div>
          {manage && (
            <div className="gh-row">
              <button className="btn btn-ghost" onClick={() => { setPicked(Object.fromEntries(github.repos.map(r => [r.id, r.selected]))); setAccount(MOCK_ACCOUNTS.find(a => a.login === inst.account)); setPhase('repos'); }}>Edit repository access</button>
              <span className="gh-spacer"></span>
              <button className="btn btn-danger" onClick={onDisconnect}>Disconnect</button>
            </div>
          )}
        </div>
      );
    }

    if (phase === 'idle') {
      return (
        <div className="gh-card">
          <style>{GH_CSS}</style>
          <div className="gh-card-head"><Octicon /><span className="gh-card-title">Connect GitHub</span></div>
          <p className="gh-card-sub">Install the Skynet GitHub App on the account that owns your repositories. Skynet acts through least-privilege, short-lived installation tokens — never your personal credentials.</p>
          <div className="gh-perm">
            {APP_PERMISSIONS.map(p => (
              <React.Fragment key={p.scope}>
                <span>{p.scope}</span><span className="mono">{p.level}</span><span className="gh-perm-why">{p.why}</span>
              </React.Fragment>
            ))}
          </div>
          <div className="gh-row">
            <button className="btn btn-primary" onClick={() => setPhase('account')}><Octicon /> &nbsp;Install Skynet GitHub App</button>
          </div>
        </div>
      );
    }

    if (phase === 'account') {
      return (
        <div className="gh-card">
          <style>{GH_CSS}</style>
          <div className="gh-card-head"><Octicon /><span className="gh-card-title">Choose where to install</span></div>
          <p className="gh-card-sub">Pick the organization or account to install the Skynet App on.</p>
          {MOCK_ACCOUNTS.map(a => (
            <button key={a.login} className="gh-acct" onClick={() => { setAccount(a); setPicked({}); setPhase('repos'); }}>
              <span className="gh-acct-glyph">{a.glyph}</span> {a.login}
              <span className="gh-acct-type">{a.type}</span>
            </button>
          ))}
          <div className="gh-row"><button className="gh-back" onClick={() => setPhase('idle')}>← Back</button></div>
        </div>
      );
    }

    // phase === 'repos'
    const repos = MOCK_REPOS[account.login] || [];
    const anyPicked = Object.values(picked).some(Boolean);
    const confirm = () => {
      const chosen = repos.map(r => ({ id: r.id, name: r.name, default_branch: r.default_branch, private: r.private, selected: !!picked[r.id] }));
      onConnected({
        connected: true,
        installation: { id: 42, account: account.login, type: account.type, glyph: account.glyph, app: 'skynet' },
        repos: chosen,
        safety: (github && github.safety) || { ...SAFETY_DEFAULTS },
      });
      setPhase('idle');
    };
    return (
      <div className="gh-card">
        <style>{GH_CSS}</style>
        <div className="gh-card-head"><Octicon /><span className="gh-card-title">Select repositories</span></div>
        <p className="gh-card-sub">Grant the Skynet App access to the repos the fleet will work in. You can change this anytime on GitHub.</p>
        {repos.map(r => (
          <div key={r.id} className="gh-repo" onClick={() => setPicked(p => ({ ...p, [r.id]: !p[r.id] }))}>
            <span className={'gh-check' + (picked[r.id] ? ' on' : '')}>{picked[r.id] ? '✓' : ''}</span>
            <span className="gh-repo-name">{r.name}</span>
            <span className="gh-repo-tags">
              <span>{r.private ? 'private' : 'public'}</span><span>{r.default_branch}</span>
            </span>
          </div>
        ))}
        <div className="gh-row">
          <button className="gh-back" onClick={() => setPhase(connected ? 'idle' : 'account')}>← Back</button>
          <span className="gh-spacer"></span>
          <button className="btn btn-primary" disabled={!anyPicked} onClick={confirm}>
            {connected ? 'Save access' : 'Connect ' + Object.values(picked).filter(Boolean).length + ' repo' + (Object.values(picked).filter(Boolean).length === 1 ? '' : 's')}
          </button>
        </div>
      </div>
    );
  }

  function SafetySettings({ safety, onChange }) {
    const s = safety || { ...SAFETY_DEFAULTS };
    return (
      <div className="gh-card">
        <style>{GH_CSS}</style>
        <div className="gh-card-head"><span className="gh-card-title">Safety guardrails</span></div>
        <p className="gh-card-sub">Enforced server-side before any write reaches GitHub. All on by default — toggle off only if you know why.</p>
        {SAFETY_RULES.map(rule => {
          const on = !!s[rule.key];
          return (
            <div className="gh-rule" key={rule.key}>
              <div className="gh-rule-body">
                <div className="gh-rule-label">{rule.label}</div>
                <div className={'gh-rule-desc' + (on ? '' : ' is-off')}>{on ? rule.on : rule.off}</div>
              </div>
              <button className={'gh-switch' + (on ? ' on' : '')} role="switch" aria-checked={on} aria-label={rule.label}
                      onClick={() => onChange({ ...s, [rule.key]: !on })}></button>
            </div>
          );
        })}
      </div>
    );
  }

  // Single-select repo picker — a project binds to exactly ONE repo, so all of its
  // agents branch/PR within the same repository (keeps branch-per-agent + merge clean).
  // The <select> structurally enforces the one-repo-per-project rule.
  function RepoSelect({ repos, value, onChange }) {
    const list = repos || [];
    if (list.length === 0) {
      return <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--faint)' }}>Connect GitHub to bind a repository to this project.</div>;
    }
    const selStyle = { width: '100%', background: 'var(--raised)', border: '1px solid var(--line)', borderRadius: 8,
                       color: 'var(--text)', fontFamily: 'var(--font-mono)', fontSize: 12.5, padding: '9px 11px' };
    return (
      <label style={{ display: 'block' }}>
        <span style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>
          Repository <span style={{ color: 'var(--faint)' }}>· one per project</span>
        </span>
        <select style={selStyle} value={value || ''} onChange={e => onChange(e.target.value)}>
          <option value="">Select repository…</option>
          {list.map(r => <option key={r.id} value={r.name}>{r.name}</option>)}
        </select>
      </label>
    );
  }

  // The settings page reachable from the sidebar.
  function IntegrationsView({ github, onConnect, onUpdateSafety, onDisconnect }) {
    const gh = github || emptyGithub();
    return (
      <section className="vw" data-screen-label="Integrations">
        <div className="vw-head"><h1>Integrations</h1><p>Connect GitHub and set the guardrails your agents operate under.</p></div>
        <div style={{ maxWidth: 640 }}>
          <GithubConnect github={gh} onConnected={onConnect} onDisconnect={onDisconnect} manage={true} />
          <SafetySettings safety={gh.safety} onChange={onUpdateSafety} />
          {!gh.connected && <div className="gh-warn">Connect GitHub to let agents branch, push, and open PRs.</div>}
        </div>
      </section>
    );
  }

  Object.assign(window, {
    GithubConnect, SafetySettings, IntegrationsView, RepoSelect,
    loadGithub, saveGithub, clearGithub, emptyGithub, selectedRepos,
    SAFETY_DEFAULTS, SAFETY_RULES, APP_PERMISSIONS,
  });
})();
