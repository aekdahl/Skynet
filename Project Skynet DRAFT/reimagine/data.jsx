// Tower — Reimagined: compact shared data + atoms for the 5 desktop-app shells

const PROV = {
  claude:  { n: 'Claude Code',    g: '✱', c: '#D97757' },
  codex:   { n: 'Codex',          g: '◌', c: '#19C2A8' },
  gemini:  { n: 'Gemini',         g: '✦', c: '#5EA2FF' },
  cursor:  { n: 'Cursor',         g: '▎', c: '#A78BFA' },
  copilot: { n: 'Copilot',        g: '◈', c: '#8B93A5' },
};

// status: running | waiting | review | done | idle
const AGENTS = [
  { id: 'a1', rn: 'runner-01', prov: 'claude',  model: 'opus-4.5',       proj: 'Payments reliability', module: 'Billing',    task: 'Stripe webhook reconciliation', status: 'waiting', prog: 0.45, step: 4, steps: 6, cur: 'Apply migration on staging', hb: 742, branch: 'agent/billing-reconcile' },
  { id: 'a2', rn: 'runner-02', prov: 'claude',  model: 'opus-4.5',       proj: 'Deploy pipeline',      module: 'Deploy Infra',task: 'Zero-downtime deploys',         status: 'waiting', prog: 0.12, step: 2, steps: 5, cur: 'Rollout plan review',        hb: 563, branch: 'agent/blue-green' },
  { id: 'a3', rn: 'runner-03', prov: 'claude',  model: 'sonnet-4.6',     proj: 'Onboarding revamp',    module: 'Onboarding',  task: 'Onboarding flow redesign',      status: 'waiting', prog: 0.58, step: 3, steps: 5, cur: 'CTA copy decision',          hb: 138, visual: true, branch: 'agent/onboard-v2' },
  { id: 'a4', rn: 'runner-04', prov: 'codex',   model: 'gpt-5.2-codex',  proj: 'API hardening',        module: 'API',         task: 'API rate limiting',             status: 'review',  prog: 0.92, step: 4, steps: 4, cur: 'Diff review & merge',        hb: 21,  diff: '+142 −38', branch: 'agent/ratelimit' },
  { id: 'a5', rn: 'runner-05', prov: 'claude',  model: 'opus-4.5',       proj: 'API hardening',        module: 'Auth',        task: 'Token refresh rotation',        status: 'running', prog: 0.62, step: 4, steps: 6, cur: 'Update session middleware',   hb: 2,   branch: 'agent/token-rotate' },
  { id: 'a6', rn: 'runner-06', prov: 'cursor',  model: 'composer-2',     proj: 'Frontend platform',    module: 'Shared UI',   task: 'Design token migration',        status: 'running', prog: 0.77, step: 3, steps: 4, cur: 'Migrate Button + Input',     hb: 9,   visual: true, conflict: 'Shared UI', branch: 'agent/tokens' },
  { id: 'a7', rn: 'runner-07', prov: 'gemini',  model: 'gemini-3-flash', proj: 'Frontend platform',    module: 'Dashboard',   task: 'Dashboard query performance',   status: 'running', prog: 0.31, step: 2, steps: 4, cur: 'Batch widget loaders',       hb: 4,   visual: true, branch: 'agent/dash-perf' },
  { id: 'a8', rn: 'runner-08', prov: 'claude',  model: 'haiku-4.5',      proj: 'Docs automation',      module: 'Docs',        task: 'Changelog automation',          status: 'done',    prog: 1,    step: 3, steps: 3, cur: 'Merged',                     hb: 0,   visual: true, branch: 'agent/changelog' },
];

const IDLE = [
  { rn: 'runner-09', prov: 'copilot', model: 'copilot-workspace', idle: '18m' },
  { rn: 'runner-10', prov: 'claude',  model: 'haiku-4.5',         idle: '41m' },
];

// blockers (needs you), oldest first
const BLOCKERS = [
  { id: 'a1', kind: 'APPROVAL',    kc: '#FFB224', title: 'Run database migration on staging', wait: '12:22', why: 'Migration 0142 dry-run passed (2.1M rows, lock est. 2.4s). Apply to staging?' },
  { id: 'a2', kind: 'PLAN REVIEW', kc: '#A78BFA', title: 'Approve blue-green rollout plan',    wait: '9:23',  why: 'Plan: stage green, gate on health, cut over, auto-rollback at 5xx > 0.5%.' },
  { id: 'a3', kind: 'DECISION',    kc: '#5EA2FF', title: 'CTA copy for onboarding step 3',     wait: '4:11',  why: 'Two options tested even. Pick the primary CTA label.', options: ['Invite your team', 'Add teammates…'] },
  { id: 'a4', kind: 'DIFF REVIEW', kc: '#3DD68C', title: 'Token-bucket rate limiting',          wait: '2:18',  why: 'Load test: p99 +0.4ms @ 10k rps, 0 dropped. Diff +142 −38 across 6 files.' },
];

const PROJECTS = [
  { name: 'Payments reliability', module: 'Billing',     goal: 'Stripe webhooks reconcile cleanly — zero dropped events.', ids: ['a1'],       backlog: 2 },
  { name: 'Deploy pipeline',      module: 'Deploy Infra', goal: 'Zero-downtime blue-green deploys with auto-rollback.',     ids: ['a2'],       backlog: 1 },
  { name: 'Onboarding revamp',    module: 'Onboarding',   goal: 'New 4-step flow; targeting +15% activation.',             ids: ['a3'],       backlog: 3, visual: true },
  { name: 'API hardening',        module: 'API',          goal: 'Rate limiting and token rotation across the public API.', ids: ['a4', 'a5'], backlog: 0 },
  { name: 'Frontend platform',    module: 'Shared UI',    goal: 'Design tokens everywhere; dashboard p95 under 300ms.',     ids: ['a6', 'a7'], backlog: 1, visual: true, conflict: true },
  { name: 'Docs automation',      module: 'Docs',         goal: 'Weekly changelog digest, hands-free.',                    ids: ['a8'],       backlog: 0, done: true, visual: true },
];

const ACTIVITY = [
  { t: '14:32:08', rn: 'runner-05', s: 'ok',   m: 'session.ts — 14/14 unit tests pass' },
  { t: '14:31:55', rn: 'runner-07', s: 'act',  m: 'batching dashboard widget loaders (9 → 2)' },
  { t: '14:31:40', rn: 'runner-06', s: 'warn', m: '⚠ Shared UI overlaps runner-03' },
  { t: '14:31:12', rn: 'runner-04', s: 'ok',   m: 'load test green — diff ready for review' },
  { t: '14:30:58', rn: 'runner-01', s: 'hitl', m: '⏸ waiting: approve migration on staging' },
  { t: '14:30:41', rn: 'runner-08', s: 'ok',   m: '✓ changelog merged to main' },
  { t: '14:30:19', rn: 'runner-03', s: 'hitl', m: '⏸ waiting: CTA copy decision' },
];

const ag = (id) => AGENTS.find(a => a.id === id);

/* ---- atoms ---- */
function Dot({ s }) { return <span className={'rdot rdot-' + s}></span>; }
function Bar({ v, s }) { return <span className="rbar"><span className={'rbar-f rbar-' + (s || 'running')} style={{ width: Math.round(v * 100) + '%' }}></span></span>; }
function G({ p }) { const m = PROV[p] || PROV.claude; return <span className="rg" style={{ color: m.c }} title={m.n}>{m.g}</span>; }
function Spark({ data, c }) {
  return <span className="rspark">{data.map((h, i) => <i key={i} style={{ height: h + '%', background: c || 'var(--accent)' }}></i>)}</span>;
}
function Live() { return <span className="rlive"></span>; }

Object.assign(window, { PROV, AGENTS, IDLE, BLOCKERS, PROJECTS, ACTIVITY, ag, Dot, Bar, G, Spark, Live });
