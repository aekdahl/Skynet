// Tower — live previews: the actual artifact each agent is building, rendered live.
// 'app' previews render a light mini-mock of real UI; 'term' shows live command output;
// 'doc' shows generated text. Each is stamped with freshness.

function PvShell({ label, fresh, children, tone }) {
  return (
    <div className="pv">
      <div className="pv-bar">
        <span className="pv-label mono">{label}</span>
        <span className="pv-fresh"><span className="pv-live"></span>live · {fresh}</span>
      </div>
      <div className={'pv-body' + (tone === 'light' ? ' pv-light' : '')}>{children}</div>
    </div>
  );
}

function PvTerm({ lines }) {
  return (
    <div className="pv-term">
      {lines.map((l, i) => <div key={i} className={'pv-tline' + (l.startsWith('✓') ? ' pv-ok' : l.startsWith('▸') ? ' pv-act' : '')}>{l}</div>)}
      <div className="pv-tline pv-cursor">▌</div>
    </div>
  );
}

function PvDoc({ title, lines }) {
  return (
    <div className="pv-doc">
      <div className="pv-doc-title">{title}</div>
      {lines.map((l, i) => <p key={i}>{l}</p>)}
    </div>
  );
}

function PreviewFor({ agent }) {
  switch (agent.id) {
    case 'onboard':
      return (
        <PvShell label="Onboarding · step 3 of 4" fresh="14s ago" tone="light">
          <div className="pv-ob">
            <div className="pv-ob-dots"><i className="on"></i><i className="on"></i><i className="on"></i><i></i></div>
            <div className="pv-ob-h">Bring your team along</div>
            <div className="pv-ob-sub">Projects with 2+ teammates activate 3× more often.</div>
            <div className="pv-ob-field">name@company.com</div>
            <div className="pv-ob-cta">Invite your team</div>
            <div className="pv-ob-skip">Skip for now</div>
          </div>
        </PvShell>
      );
    case 'tokens':
      return (
        <PvShell label="Shared UI · Button + Input on tokens" fresh="9s ago" tone="light">
          <div className="pv-tk">
            <div className="pv-tk-row">
              <span className="pv-tk-cap">before</span>
              <span className="pv-tk-btn pv-tk-old">Save changes</span>
              <span className="pv-tk-input pv-tk-old">Search…</span>
            </div>
            <div className="pv-tk-row">
              <span className="pv-tk-cap">tokens</span>
              <span className="pv-tk-btn pv-tk-new">Save changes</span>
              <span className="pv-tk-input pv-tk-new">Search…</span>
            </div>
            <div className="pv-tk-note">31/34 components migrated · 0 visual regressions</div>
          </div>
        </PvShell>
      );
    case 'dashperf':
      return (
        <PvShell label="Dashboard · usage widget" fresh="4s ago" tone="light">
          <div className="pv-dp">
            <div className="pv-dp-head">Usage <span className="pv-dp-p95">p95 287ms <small>was 612ms</small></span></div>
            <div className="pv-dp-chart">
              {[34, 52, 41, 68, 75, 58, 82, 91, 73, 88].map((h, i) => <i key={i} style={{ height: h + '%' }}></i>)}
            </div>
            <div className="pv-dp-note">9 queries → 2 · cache layer next</div>
          </div>
        </PvShell>
      );
    case 'deploy':
      return (
        <PvShell label="Deploy Infra · blue-green pipeline" fresh="33s ago">
          <div className="pv-pipe">
            {[['Build image', 'done'], ['Green env', 'now'], ['Health gate', 'todo'], ['Cutover', 'todo'], ['Rollback guard', 'todo']].map(([n, s], i) => (
              <React.Fragment key={n}>
                {i > 0 && <span className={'pv-pipe-seg' + (s === 'done' ? ' on' : '')}></span>}
                <span className={'pv-pipe-st pv-pipe-' + s}>{s === 'done' ? '✓ ' : s === 'now' ? '⟳ ' : ''}{n}</span>
              </React.Fragment>
            ))}
          </div>
          <div className="pv-pipe-note">⏸ paused at plan review — nothing executed yet</div>
        </PvShell>
      );
    case 'billing':
      return (
        <PvShell label="Billing · reconciliation worker" fresh="2m ago">
          <PvTerm lines={[
            '✓ replay suite — 412/412 events reconciled',
            '✓ migration 0142 dry-run OK (2.1M rows, lock est. 2.4s)',
            '▸ waiting: approval to apply on staging',
          ]} />
        </PvShell>
      );
    case 'billing-replay':
      return (
        <PvShell label="Billing · replay CLI" fresh="6s ago">
          <PvTerm lines={[
            '$ tower replay --fixture stripe-30d',
            '✓ 412 events loaded · 0 schema drift',
            '▸ generating fixture set 2/5 (disputes)',
          ]} />
        </PvShell>
      );
    case 'ratelimit':
      return (
        <PvShell label="API Middleware · load test" fresh="1m ago">
          <PvTerm lines={[
            '$ k6 run burst-10k.js',
            '✓ p99 +0.4ms @ 10,000 rps · 0 dropped',
            '✓ per-tenant overrides honored (32/32)',
            '▸ diff ready for review: +142 −38',
          ]} />
        </PvShell>
      );
    case 'auth':
      return (
        <PvShell label="Auth · session middleware" fresh="2s ago">
          <PvTerm lines={[
            '✓ session.ts — 14/14 unit tests',
            '▸ swapping verify path to rotating keys',
            '▸ integration suite queued',
          ]} />
        </PvShell>
      );
    case 'auth-audit':
      return (
        <PvShell label="Auth · audit_events schema (draft)" fresh="18s ago">
          <PvDoc title="audit_events" lines={[
            'id · ulid — event id',
            'session_id · fk sessions — rotated session',
            'kind · enum(refresh, revoke, rotate)',
            'actor · service | user — origin of change',
          ]} />
        </PvShell>
      );
    case 'changelog':
      return (
        <PvShell label="Docs · weekly digest (shipped)" fresh="merged 12:48">
          <PvDoc title="Week 24 — what shipped" lines={[
            '• Rate limiting groundwork behind flag',
            '• Onboarding step container rebuilt',
            '• 14 fixes across Dashboard and Billing',
          ]} />
        </PvShell>
      );
    default: {
      const now = (agent.plan || []).find(p => p.s === 'now');
      const done = (agent.plan || []).filter(p => p.s === 'done').length;
      return (
        <PvShell label={agent.name} fresh="just now">
          <PvTerm lines={[
            '$ tower run "' + agent.name + '"',
            '✓ workspace ready on ' + (agent.branch || 'agent branch'),
            done > 0 ? '✓ ' + done + ' step' + (done > 1 ? 's' : '') + ' complete' : '▸ planning approach',
            '▸ ' + (now ? now.t : 'working…'),
          ]} />
        </PvShell>
      );
    }
  }
}

Object.assign(window, { PreviewFor });

/* ===== project-level delivery previews — the actual product the project ships ===== */
// Only projects with a visual deliverable (a real rendered UI) get a preview.
// Backend / infra projects have nothing visual to show, so the panel is skipped.
function visualLeadOf(project, agents) {
  const pa = agents.filter(a => project.agentIds.includes(a.id) && a.visual);
  const live = pa.filter(a => a.status !== 'done').sort((x, y) => y.progress - x.progress);
  return live[0] || pa.find(a => a.status === 'done') || null;
}
const hasVisualDelivery = (project, agents) => !!visualLeadOf(project, agents);

function ProjectDelivery({ project, agents }) {
  if (!hasVisualDelivery(project, agents)) return null;
  const fresh = (() => {
    const pa = agents.filter(a => project.agentIds.includes(a.id) && a.status !== 'done');
    if (!pa.length) return 'just now';
    const hb = Math.min(...pa.map(a => a.hb != null ? a.hb : 60));
    return hb < 60 ? hb + 's ago' : Math.round(hb / 60) + 'm ago';
  })();

  switch (project.id) {
    case 'onboardp':
      return (
        <PvShell label="Onboarding · live flow" fresh={fresh} tone="light">
          <div className="dlv-app">
            <div className="dlv-appbar"><span className="dlv-dotrow"><i></i><i></i><i></i></span><span className="dlv-url">app.atlas.io/welcome</span></div>
            <div className="dlv-pad dlv-center">
              <div className="pv-ob-dots"><i className="on"></i><i className="on"></i><i className="on"></i><i></i></div>
              <div className="dlv-h1">Bring your team along</div>
              <div className="dlv-sub">Projects with 2+ teammates activate 3× more often.</div>
              <div className="dlv-input">name@company.com</div>
              <div className="dlv-cta">Invite your team</div>
              <div className="dlv-skip">Skip for now</div>
            </div>
          </div>
        </PvShell>
      );
    case 'feplat':
      return (
        <PvShell label="Dashboard · usage" fresh={fresh} tone="light">
          <div className="dlv-app">
            <div className="dlv-appbar"><span className="dlv-dotrow"><i></i><i></i><i></i></span><span className="dlv-url">app.atlas.io/dashboard</span></div>
            <div className="dlv-pad">
              <div className="dlv-row-between"><div className="dlv-h1">Usage</div><span className="dlv-p95">p95 287ms <small>was 612ms</small></span></div>
              <div className="dlv-chart">{[34, 52, 41, 68, 75, 58, 82, 91, 73, 88, 79, 94].map((h, i) => <i key={i} style={{ height: h + '%' }}></i>)}</div>
              <div className="dlv-swatches">
                <span className="dlv-sw" style={{ background: '#2E5BE0' }}></span>
                <span className="dlv-sw" style={{ background: '#3DD68C' }}></span>
                <span className="dlv-sw" style={{ background: '#FFB224' }}></span>
                <span className="dlv-swl">design tokens · 31/34 migrated</span>
              </div>
            </div>
          </div>
        </PvShell>
      );
    case 'docsauto':
      return (
        <PvShell label="Docs · changelog (rendered)" fresh="shipped 12:48" tone="light">
          <div className="dlv-app">
            <div className="dlv-appbar"><span className="dlv-dotrow"><i></i><i></i><i></i></span><span className="dlv-url">atlas.io/changelog</span></div>
            <div className="dlv-pad dlv-doc">
              <div className="dlv-h1">Week 24</div>
              <div className="dlv-sub">What shipped this week</div>
              <ul className="dlv-list">
                <li><b>Rate limiting</b> groundwork behind a flag</li>
                <li><b>Onboarding</b> step container rebuilt</li>
                <li>14 fixes across Dashboard and Billing</li>
              </ul>
            </div>
          </div>
        </PvShell>
      );
    default: {
      // user-created project: render a generic rendered app surface (never a terminal)
      const lead = agents.filter(a => project.agentIds.includes(a.id) && a.status !== 'done')[0];
      return (
        <PvShell label={project.name + ' · preview'} fresh={fresh} tone="light">
          <div className="dlv-app">
            <div className="dlv-appbar"><span className="dlv-dotrow"><i></i><i></i><i></i></span><span className="dlv-url">app.atlas.io/{project.id}</span></div>
            <div className="dlv-pad dlv-center">
              <div className="dlv-buildspin"></div>
              <div className="dlv-h1">{project.name}</div>
              <div className="dlv-sub">{lead ? 'Building: ' + lead.name : 'Rendering preview as the first task runs…'}</div>
            </div>
          </div>
        </PvShell>
      );
    }
  }
}

Object.assign(window, { PreviewFor, ProjectDelivery, visualLeadOf, hasVisualDelivery });
