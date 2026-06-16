// Shared mock data + atoms for the overview explorations

const EX_TASKS = [
  { t: 'Stripe webhook reconciliation', proj: 'Payments reliability', step: 'Apply migration on staging', n: 4, of: 6, p: 0.45, s: 'blocked', wait: '12m 22s', agent: 'runner-01' },
  { t: 'Zero-downtime deploy pipeline', proj: 'Deploy pipeline', step: 'Rollout plan review', n: 2, of: 5, p: 0.12, s: 'blocked', wait: '9m 23s', agent: 'runner-02' },
  { t: 'Onboarding flow redesign', proj: 'Onboarding revamp', step: 'CTA copy decision', n: 3, of: 5, p: 0.58, s: 'blocked', wait: '4m 11s', agent: 'runner-03' },
  { t: 'API rate limiting', proj: 'API hardening', step: 'Diff review & merge', n: 4, of: 4, p: 0.92, s: 'review', wait: '2m 18s', agent: 'runner-04' },
  { t: 'Rotate auth token refresh', proj: 'API hardening', step: 'Update session middleware', n: 4, of: 6, p: 0.62, s: 'active', agent: 'runner-05' },
  { t: 'Design token migration', proj: 'Frontend platform', step: 'Migrate Button + Input', n: 3, of: 4, p: 0.77, s: 'active', conflict: true, agent: 'runner-06' },
  { t: 'Dashboard query performance', proj: 'Frontend platform', step: 'Batch widget loaders', n: 2, of: 4, p: 0.31, s: 'active', agent: 'runner-07' },
];

const EX_AGENTS = [
  { n: 'runner-01', model: 'opus-4.5',   s: 'blocked', task: 'Stripe webhook reconciliation' },
  { n: 'runner-02', model: 'opus-4.5',   s: 'blocked', task: 'Zero-downtime deploy pipeline' },
  { n: 'runner-03', model: 'sonnet-4.6', s: 'blocked', task: 'Onboarding flow redesign' },
  { n: 'runner-04', model: 'sonnet-4.6', s: 'review',  task: 'API rate limiting' },
  { n: 'runner-05', model: 'opus-4.5',   s: 'active',  task: 'Rotate auth token refresh' },
  { n: 'runner-06', model: 'sonnet-4.6', s: 'active',  task: 'Design token migration' },
  { n: 'runner-07', model: 'sonnet-4.6', s: 'active',  task: 'Dashboard query performance' },
  { n: 'runner-08', model: 'haiku-4.5',  s: 'idle', idle: '41m' },
  { n: 'runner-09', model: 'haiku-4.5',  s: 'idle', idle: '18m' },
];

const EX_PROJECTS = [
  { name: 'Payments reliability', wait: '12m', tasks: [
    { t: 'Stripe webhook reconciliation', s: 'blocked', steps: ['Map events', 'Build worker', 'Write migration', 'Apply on staging', 'Backfill 30d', 'Open PR'], cur: 3 } ] },
  { name: 'Deploy pipeline', wait: '9m', tasks: [
    { t: 'Zero-downtime deploys', s: 'blocked', steps: ['Audit script', 'Rollout plan', 'Health gating', 'Auto-rollback', 'Dry-run'], cur: 1 } ] },
  { name: 'Onboarding revamp', wait: '4m', tasks: [
    { t: 'Onboarding flow redesign', s: 'blocked', steps: ['Step container', 'Invite step', 'CTA copy', 'Illustrations', 'A/B flag'], cur: 2 } ] },
  { name: 'API hardening', wait: '2m', tasks: [
    { t: 'API rate limiting', s: 'review', steps: ['Middleware', 'Tenant config', 'Load test', 'Review & merge'], cur: 3 },
    { t: 'Token refresh rotation', s: 'active', steps: ['Audit flow', 'Endpoint', 'Rotate keys', 'Middleware', 'Tests', 'PR'], cur: 3 } ] },
  { name: 'Frontend platform', conflict: 'shared/ui', tasks: [
    { t: 'Design token migration', s: 'active', steps: ['Extract tokens', 'Codemod', 'Button + Input', 'Visual QA'], cur: 2 },
    { t: 'Dashboard performance', s: 'active', steps: ['Profile', 'Batch loaders', 'Cache', 'Verify p95'], cur: 1 } ] },
  { name: 'Docs automation', done: true, tasks: [
    { t: 'Changelog automation', s: 'done', steps: ['Parse PRs', 'Digest', 'CI + Slack'], cur: 3 } ] },
];

const EX_AREAS = [
  { id: 'api/auth', files: 23, owners: ['runner-05'], s: 'active' },
  { id: 'api/billing', files: 31, owners: ['runner-01'], s: 'blocked' },
  { id: 'api/middleware', files: 14, owners: ['runner-04'], s: 'review' },
  { id: 'web/dashboard', files: 47, owners: ['runner-07'], s: 'active' },
  { id: 'web/onboarding', files: 26, owners: ['runner-03'], s: 'blocked' },
  { id: 'shared/ui', files: 58, owners: ['runner-03', 'runner-06'], s: 'conflict' },
  { id: 'infra/deploy', files: 9, owners: ['runner-02'], s: 'blocked' },
  { id: 'db/migrations', files: 32, owners: ['runner-01'], s: 'blocked' },
  { id: 'docs', files: 38, owners: [], s: 'idle' },
];

function ExDot({ s }) { return <span className={'exdot exdot-' + s}></span>; }
function ExBar({ v, s }) {
  return <div className="exbar"><div className={'exbar-f exbar-' + (s || 'active')} style={{ width: Math.round(v * 100) + '%' }}></div></div>;
}
function ExHead({ title, sub }) {
  return (
    <header className="exhead">
      <div>
        <h1>{title}</h1>
        <p>{sub}</p>
      </div>
      <span className="exbrand">TOWER</span>
    </header>
  );
}
function ExPill({ s, children }) { return <span className={'expill expill-' + s}>{children}</span>; }

Object.assign(window, { EX_TASKS, EX_AGENTS, EX_PROJECTS, EX_AREAS, ExDot, ExBar, ExHead, ExPill });
