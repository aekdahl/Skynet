// Tower — first-run onboarding.
//
// A workspace either exists (persisted in localStorage) or it doesn't. On a cold
// first run there is no workspace, so App() shows this wizard instead of the app:
//   1. Create workspace   — name it, claim an operator handle
//   2. Connect a repo      — point Tower at the codebase the fleet will work in
//   3. Module map          — review/edit .skynet/modules.json (glob → module)
//   4. Configure providers — pick which runners the fleet can spin up
// On finish we persist the config and hand off to the app, which starts EMPTY —
// the existing GetStarted screen then guides creating the first project.
//
// Demo fixtures (the seeded agents/projects/queue) live behind a "explore with
// demo data" link so the wizard is the real default entry point.

(function () {
  const WS_KEY = 'tower.workspace';

  function loadWorkspace() {
    try {
      const raw = window.localStorage.getItem(WS_KEY);
      const cfg = raw ? JSON.parse(raw) : null;
      return cfg && cfg.onboarded ? cfg : null;
    } catch (e) { return null; }
  }
  function saveWorkspace(cfg) {
    try { window.localStorage.setItem(WS_KEY, JSON.stringify(cfg)); } catch (e) {}
  }
  function clearWorkspace() {
    try { window.localStorage.removeItem(WS_KEY); } catch (e) {}
  }

  // Sensible starting module map — globs mapped to friendly module names.
  const DEFAULT_MODULES = [
    { glob: 'api/auth/**', name: 'Auth' },
    { glob: 'api/billing/**', name: 'Billing' },
    { glob: 'api/**', name: 'API Middleware' },
    { glob: 'web/**', name: 'Web' },
    { glob: 'shared/ui/**', name: 'Shared UI' },
    { glob: 'infra/**', name: 'Infra' },
    { glob: 'db/**', name: 'Data Migrations' },
    { glob: 'docs/**', name: 'Docs' },
  ];

  // Serialize the module rows into the .skynet/modules.json the wizard "commits".
  function modulesJson(rows) {
    const modules = {};
    rows.filter(r => r.glob.trim() && r.name.trim()).forEach(r => { modules[r.glob.trim()] = r.name.trim(); });
    return JSON.stringify({ version: 1, modules }, null, 2);
  }

  // Turn the chosen providers into a starting fleet (2 Claude runners, 1 of each other).
  function buildFleet(ids) {
    const P = window.PROVIDERS || {};
    const out = []; let n = 1;
    (ids || []).forEach(id => {
      const p = P[id]; if (!p) return;
      const count = id === 'claude' ? 2 : 1;
      for (let i = 0; i < count; i++) {
        out.push({ rn: 'runner-' + String(n++).padStart(2, '0'), provider: id, model: p.models[0], idle: 'now' });
      }
    });
    return out;
  }

  const OB_CSS = `
    .ob { position: fixed; inset: 0; z-index: 50; background: var(--bg); display: flex; flex-direction: column;
          align-items: center; justify-content: center; padding: 32px; overflow-y: auto; }
    .ob-card { width: 100%; max-width: 560px; }
    .ob-mark { display: block; margin: 0 auto 18px; }
    .ob-progress { display: flex; gap: 8px; justify-content: center; margin-bottom: 28px; }
    .ob-pip { width: 30px; height: 3px; border-radius: 2px; background: var(--line); transition: background .2s; }
    .ob-pip.on { background: var(--accent); }
    .ob-pip.done { background: var(--ok); }
    .ob-step-tag { font-family: var(--font-mono); font-size: 10px; font-weight: 600; letter-spacing: 0.14em;
                   text-transform: uppercase; color: var(--accent); text-align: center; }
    .ob-h { font-size: 22px; font-weight: 600; text-align: center; margin: 8px 0 6px; }
    .ob-sub { color: var(--muted); text-align: center; font-size: 13px; line-height: 1.6; margin: 0 auto 26px; max-width: 440px; }
    .ob-field { margin-bottom: 16px; }
    .ob-label { display: block; font-family: var(--font-mono); font-size: 11px; color: var(--muted); margin-bottom: 6px; }
    .ob-hint { font-family: var(--font-mono); font-size: 11px; color: var(--faint); margin-top: 6px; }
    .ob-prov-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 18px; }
    .ob-prov { display: flex; align-items: center; gap: 10px; padding: 12px 14px; text-align: left; cursor: pointer;
               background: var(--panel); border: 1px solid var(--line); border-radius: 10px; color: var(--text);
               font-family: var(--font-ui); font-size: 13px; transition: border-color .15s, background .15s; }
    .ob-prov:hover { border-color: var(--faint); }
    .ob-prov.on { background: var(--raised); }
    .ob-prov-glyph { font-size: 16px; width: 18px; text-align: center; }
    .ob-prov-models { display: block; font-family: var(--font-mono); font-size: 10px; color: var(--faint); margin-top: 2px; }
    .ob-prov-check { margin-left: auto; font-family: var(--font-mono); font-size: 12px; color: var(--ok); opacity: 0; }
    .ob-prov.on .ob-prov-check { opacity: 1; }
    .ob-mod-row { display: flex; gap: 8px; margin-bottom: 8px; align-items: center; }
    .ob-mod-row .qx-input { margin: 0; }
    .ob-mod-glob { flex: 1.2; }
    .ob-mod-name { flex: 1; }
    .ob-mod-del { background: none; border: none; color: var(--faint); cursor: pointer; font-size: 16px; line-height: 1; padding: 4px 8px; }
    .ob-mod-del:hover { color: var(--danger); }
    .ob-mod-add { background: none; border: 1px dashed var(--line); color: var(--muted); cursor: pointer;
                  font-family: var(--font-ui); font-size: 12px; border-radius: 8px; padding: 8px; width: 100%; margin-top: 4px; }
    .ob-mod-add:hover { border-color: var(--faint); color: var(--text); }
    .ob-json { background: #0B0D11; border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; margin-top: 16px;
               font-family: var(--font-mono); font-size: 11px; color: var(--muted); white-space: pre; overflow-x: auto; max-height: 180px; }
    .ob-json-head { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--faint); margin-bottom: 8px; }
    .ob-connected { display: flex; align-items: center; gap: 8px; font-family: var(--font-mono); font-size: 12px; color: var(--ok);
                    background: rgba(61,214,140,0.08); border: 1px solid rgba(61,214,140,0.3); border-radius: 8px; padding: 10px 12px; margin-top: 12px; }
    .ob-nav { display: flex; align-items: center; gap: 10px; margin-top: 28px; }
    .ob-nav .ob-spacer { flex: 1; }
    .ob-demo { display: block; margin: 22px auto 0; background: none; border: none; color: var(--faint);
               font-family: var(--font-ui); font-size: 12px; cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }
    .ob-demo:hover { color: var(--muted); }
  `;

  function Mark() {
    return (
      <svg className="ob-mark" width="44" height="44" viewBox="0 0 18 18" aria-hidden="true">
        <rect x="1" y="1" width="16" height="16" rx="3" fill="none" stroke="var(--accent)" strokeWidth="1.4"></rect>
        <path d="M5 6h8M9 6v7" stroke="var(--accent)" strokeWidth="1.4" strokeLinecap="round"></path>
      </svg>
    );
  }

  function Onboarding({ onComplete, onDemo }) {
    const [step, setStep] = React.useState(0);
    const [workspace, setWorkspace] = React.useState('');
    const [operator, setOperator] = React.useState('');
    const [github, setGithub] = React.useState(null);   // GitHub App connection (see github.jsx)
    const [mods, setMods] = React.useState(DEFAULT_MODULES.map(m => ({ ...m })));
    const [providers, setProviders] = React.useState(['claude']);

    const repos = window.selectedRepos ? window.selectedRepos(github) : [];
    const STEPS = ['Workspace', 'Repository', 'Module map', 'Providers'];
    const valid = [
      workspace.trim().length > 0,
      !!(github && github.connected && repos.length > 0),
      mods.some(m => m.glob.trim() && m.name.trim()),
      providers.length > 0,
    ];
    const canNext = valid[step];
    const last = step === STEPS.length - 1;

    const setMod = (i, key, v) => setMods(ms => ms.map((m, j) => j === i ? { ...m, [key]: v } : m));
    const addMod = () => setMods(ms => [...ms, { glob: '', name: '' }]);
    const delMod = (i) => setMods(ms => ms.filter((_, j) => j !== i));
    const toggleProv = (id) => setProviders(ps => ps.includes(id) ? ps.filter(p => p !== id) : [...ps, id]);

    const finish = () => onComplete({
      workspace: workspace.trim(),
      operator: operator.trim() || 'Operator',
      github,
      repo: (repos[0] && repos[0].name) || '',
      modules: mods.filter(m => m.glob.trim() && m.name.trim()),
      providers,
    });

    const next = () => { if (!canNext) return; last ? finish() : setStep(s => s + 1); };
    const back = () => setStep(s => Math.max(0, s - 1));

    const P = window.PROVIDERS || {};
    const runnerCount = buildFleet(providers).length;

    return (
      <div className="ob">
        <style>{OB_CSS}</style>
        <div className="ob-card">
          <Mark />
          <div className="ob-progress">
            {STEPS.map((_, i) => <span key={i} className={'ob-pip' + (i === step ? ' on' : i < step ? ' done' : '')}></span>)}
          </div>
          <div className="ob-step-tag">Step {step + 1} of {STEPS.length} · {STEPS[step]}</div>

          {step === 0 && (
            <React.Fragment>
              <h1 className="ob-h">Set up your workspace</h1>
              <p className="ob-sub">A workspace is your team's mission control — every project, agent, and decision is scoped to it.</p>
              <div className="ob-field">
                <label className="ob-label">Workspace name</label>
                <input className="qx-input" autoFocus placeholder="e.g. Acme Engineering" value={workspace}
                       onChange={e => setWorkspace(e.target.value)} onKeyDown={e => e.key === 'Enter' && next()} />
              </div>
              <div className="ob-field">
                <label className="ob-label">Your operator handle <span style={{ color: 'var(--faint)' }}>(optional)</span></label>
                <input className="qx-input" placeholder="e.g. jordan" value={operator}
                       onChange={e => setOperator(e.target.value)} onKeyDown={e => e.key === 'Enter' && next()} />
              </div>
            </React.Fragment>
          )}

          {step === 1 && (
            <React.Fragment>
              <h1 className="ob-h">Connect GitHub</h1>
              <p className="ob-sub">Install the Tower GitHub App on the repos your fleet will work in. Agents branch, push, and open PRs through least-privilege, short-lived tokens — you set the guardrails next.</p>
              <window.GithubConnect github={github} onConnected={setGithub} />
              {repos.length > 0 && <div className="ob-connected">✓ {repos.length} repo{repos.length === 1 ? '' : 's'} connected — {repos.map(r => r.name).join(', ')}</div>}
            </React.Fragment>
          )}

          {step === 2 && (
            <React.Fragment>
              <h1 className="ob-h">Map your modules</h1>
              <p className="ob-sub">Tower shows your codebase as modules, not file paths. This map (committed as <span className="mono">.skynet/modules.json</span>) tells it which globs belong to which module — and powers conflict detection.</p>
              {mods.map((m, i) => (
                <div className="ob-mod-row" key={i}>
                  <input className="qx-input ob-mod-glob mono" placeholder="glob (api/auth/**)" value={m.glob} onChange={e => setMod(i, 'glob', e.target.value)} />
                  <span style={{ color: 'var(--faint)' }}>→</span>
                  <input className="qx-input ob-mod-name" placeholder="Module name" value={m.name} onChange={e => setMod(i, 'name', e.target.value)} />
                  <button className="ob-mod-del" title="Remove" onClick={() => delMod(i)}>×</button>
                </div>
              ))}
              <button className="ob-mod-add" onClick={addMod}>+ Add module</button>
              <div className="ob-json">
                <div className="ob-json-head">.skynet/modules.json</div>
                {modulesJson(mods)}
              </div>
            </React.Fragment>
          )}

          {step === 3 && (
            <React.Fragment>
              <h1 className="ob-h">Configure providers</h1>
              <p className="ob-sub">Pick the agent providers your fleet can spin up. You can add, retire, and tune runners anytime from the Fleet tab.</p>
              <div className="ob-prov-grid">
                {Object.entries(P).map(([id, p]) => {
                  const on = providers.includes(id);
                  return (
                    <button key={id} className={'ob-prov' + (on ? ' on' : '')}
                            style={on ? { borderColor: p.color } : null} onClick={() => toggleProv(id)}>
                      <span className="ob-prov-glyph" style={{ color: p.color }}>{p.glyph}</span>
                      <span>{p.name}<span className="ob-prov-models">{p.models[0]}</span></span>
                      <span className="ob-prov-check">✓</span>
                    </button>
                  );
                })}
              </div>
              <div className="ob-hint" style={{ textAlign: 'center' }}>
                {providers.length === 0 ? 'Select at least one provider.' : `Starts your fleet with ${runnerCount} runner${runnerCount === 1 ? '' : 's'}.`}
              </div>
            </React.Fragment>
          )}

          <div className="ob-nav">
            {step > 0 && <button className="btn btn-ghost" onClick={back}>← Back</button>}
            <span className="ob-spacer"></span>
            <button className="btn btn-primary" disabled={!canNext} onClick={next}>
              {last ? 'Enter Tower →' : 'Continue →'}
            </button>
          </div>

          {step === 0 && (
            <button className="ob-demo" onClick={onDemo}>Skip — explore with demo data instead</button>
          )}
        </div>
      </div>
    );
  }

  Object.assign(window, { Onboarding, loadWorkspace, saveWorkspace, clearWorkspace, buildFleet, DEFAULT_MODULES });
})();
