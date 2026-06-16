// Tower — mock data: agents, HITL queue, codebase areas

const STATUS_META = {
  running: { label: 'RUNNING', color: 'var(--ok)' },
  waiting: { label: 'BLOCKED', color: 'var(--warn)' },
  review:  { label: 'REVIEW',  color: 'var(--info)' },
  done:    { label: 'DONE',    color: 'var(--muted)' },
};

const AGENTS = [
  {
    id: 'billing', name: 'Stripe webhook reconciliation', status: 'waiting',
    areas: ['api/billing', 'db/migrations'], progress: 0.45, branch: 'agent/billing-hooks',
    startedMin: 84, model: 'opus-4.5',
    plan: [
      { t: 'Map missing webhook event types', s: 'done' },
      { t: 'Build reconciliation worker', s: 'done' },
      { t: 'Write idempotency-key migration', s: 'done' },
      { t: 'Apply migration on staging', s: 'now' },
      { t: 'Backfill 30 days of events', s: 'todo' },
      { t: 'Open PR with rollout notes', s: 'todo' },
    ],
    files: ['api/billing/webhooks.ts', 'api/billing/reconcile.ts', 'db/migrations/0142_idempotency.sql'],
    log: [
      '14:02:11  worker passes replay suite — 412/412 events',
      '14:05:48  migration 0142 generated, dry-run OK',
      '14:06:02  ⏸ HITL — needs approval to run migrate on staging',
    ],
  },
  {
    id: 'deploy', name: 'Zero-downtime deploy pipeline', status: 'waiting',
    areas: ['infra/deploy'], progress: 0.12, branch: 'agent/blue-green',
    startedMin: 31, model: 'opus-4.5',
    plan: [
      { t: 'Audit current deploy script', s: 'done' },
      { t: 'Draft blue-green rollout plan', s: 'now' },
      { t: 'Health-check gating', s: 'todo' },
      { t: 'Rollback automation', s: 'todo' },
      { t: 'Run staged dry-run', s: 'todo' },
    ],
    files: ['infra/deploy/pipeline.yml'],
    log: [
      '14:21:30  audit complete — 2 single-point failovers found',
      '14:24:17  ⏸ HITL — plan ready for review before execution',
    ],
  },
  {
    id: 'onboard', name: 'Onboarding flow redesign', status: 'waiting',
    areas: ['web/onboarding', 'shared/ui'], progress: 0.58, branch: 'agent/onboard-v2',
    startedMin: 112, model: 'sonnet-4.6', conflict: 'shared/ui',
    plan: [
      { t: 'Rebuild step container + progress', s: 'done' },
      { t: 'New invite-teammates step', s: 'done' },
      { t: 'Wire CTA copy for step 3', s: 'now' },
      { t: 'Empty-state illustrations', s: 'todo' },
      { t: 'A/B flag + analytics events', s: 'todo' },
    ],
    files: ['web/onboarding/Step3.tsx', 'web/onboarding/flow.ts', 'shared/ui/Button.tsx'],
    log: [
      '13:58:40  step 3 layout rebuilt, snapshot tests updated',
      '14:11:05  ⚠ touched shared/ui/Button.tsx — owned by token-migration',
      '14:13:22  ⏸ HITL — CTA copy decision needed',
    ],
  },
  {
    id: 'ratelimit', name: 'API rate limiting', status: 'review',
    areas: ['api/middleware'], progress: 0.92, branch: 'agent/rate-limits',
    startedMin: 147, model: 'sonnet-4.6',
    plan: [
      { t: 'Token-bucket middleware', s: 'done' },
      { t: 'Per-tenant config + overrides', s: 'done' },
      { t: 'Load test at 10k rps', s: 'done' },
      { t: 'Diff review & merge', s: 'now' },
    ],
    files: ['api/middleware/ratelimit.ts', 'api/middleware/config.ts', 'api/middleware/store.ts'],
    log: [
      '13:40:12  load test: p99 +0.4ms at 10k rps',
      '14:18:55  ⏸ HITL — diff ready: +142 −38 across 6 files',
    ],
  },
  {
    id: 'auth', name: 'Rotate auth token refresh', status: 'running',
    areas: ['api/auth'], progress: 0.62, branch: 'agent/token-refresh',
    startedMin: 58, model: 'opus-4.5',
    plan: [
      { t: 'Audit current refresh flow', s: 'done' },
      { t: 'Add /token/refresh endpoint', s: 'done' },
      { t: 'Rotate token store keys', s: 'done' },
      { t: 'Update session middleware', s: 'now' },
      { t: 'Integration tests', s: 'todo' },
      { t: 'Open PR', s: 'todo' },
    ],
    files: ['api/auth/refresh.ts', 'api/auth/session.ts', 'api/auth/store.ts'],
    log: [
      '14:19:03  middleware: swapping verify path to rotating keys',
      '14:22:41  session.ts — 14/14 unit tests green',
    ],
  },
  {
    id: 'dashperf', name: 'Dashboard query performance', status: 'running',
    areas: ['web/dashboard'], progress: 0.31, branch: 'agent/dash-perf',
    startedMin: 22, model: 'sonnet-4.6',
    plan: [
      { t: 'Profile slow queries', s: 'done' },
      { t: 'Batch widget data loaders', s: 'now' },
      { t: 'Add query-level cache', s: 'todo' },
      { t: 'Verify p95 < 300ms', s: 'todo' },
    ],
    files: ['web/dashboard/loaders.ts', 'web/dashboard/widgets/usage.tsx'],
    log: [
      '14:20:10  profiling: usage widget = 61% of page time',
      '14:25:33  batching loaders — 9 queries → 2',
    ],
  },
  {
    id: 'tokens', name: 'Design token migration', status: 'running',
    areas: ['shared/ui'], progress: 0.77, branch: 'agent/token-migration',
    startedMin: 96, model: 'sonnet-4.6', conflict: 'shared/ui',
    plan: [
      { t: 'Extract color/space tokens', s: 'done' },
      { t: 'Codemod components to tokens', s: 'done' },
      { t: 'Migrate Button + Input', s: 'now' },
      { t: 'Visual regression pass', s: 'todo' },
    ],
    files: ['shared/ui/tokens.css', 'shared/ui/Button.tsx', 'shared/ui/Input.tsx'],
    log: [
      '14:15:27  codemod: 31 components migrated',
      '14:23:08  ⚠ Button.tsx also modified on agent/onboard-v2',
    ],
  },
  {
    id: 'changelog', name: 'Changelog automation', status: 'done',
    areas: ['docs'], progress: 1, branch: 'agent/changelog',
    startedMin: 203, model: 'haiku-4.5',
    plan: [
      { t: 'Parse merged PR labels', s: 'done' },
      { t: 'Generate weekly digest', s: 'done' },
      { t: 'CI job + Slack post', s: 'done' },
    ],
    files: ['docs/changelog.md', '.github/workflows/changelog.yml'],
    log: [ '12:48:19  ✓ merged — PR #1872' ],
  },
];

// HITL queue — sorted by wait time desc
const QUEUE = [
  {
    id: 'q-billing', agentId: 'billing', kind: 'approval', waited: 742, risk: 'medium',
    title: 'Run database migration on staging',
    why: 'Adds idempotency_key column + unique index to payments_events. Dry-run passed; table has 2.1M rows, est. lock < 3s.',
    command: 'prisma migrate deploy --schema db/schema.prisma  # staging',
  },
  {
    id: 'q-deploy', agentId: 'deploy', kind: 'plan', waited: 563, risk: 'low',
    title: 'Approve blue-green rollout plan',
    why: 'Plan replaces in-place deploys. No prod changes until staged dry-run passes.',
    steps: ['Provision green env from current image', 'Gate cutover on /health + error-rate check', 'Auto-rollback on 5xx spike > 0.5%', 'Staged dry-run on staging', 'Document runbook'],
  },
  {
    id: 'q-onboard', agentId: 'onboard', kind: 'question', waited: 251, risk: 'low',
    title: 'CTA copy for onboarding step 3',
    why: 'Two candidates pass the tone guide. Pick one — agent proceeds immediately.',
    options: ['Invite your team', 'Add teammates — it\u2019s faster together'],
    recommended: 0,
  },
  {
    id: 'q-ratelimit', agentId: 'ratelimit', kind: 'diff', waited: 138, risk: 'medium',
    title: 'Review diff: token-bucket rate limiting',
    why: 'Touches request path for all API traffic. Load-tested: p99 +0.4ms at 10k rps.',
    diff: { add: 142, del: 38, files: ['api/middleware/ratelimit.ts', 'api/middleware/config.ts', 'api/middleware/store.ts', '+3 more'] },
  },
];

const KIND_META = {
  approval: { label: 'APPROVAL', color: 'var(--warn)' },
  question: { label: 'DECISION', color: 'var(--info)' },
  plan:     { label: 'PLAN REVIEW', color: 'var(--violet)' },
  diff:     { label: 'DIFF REVIEW', color: 'var(--ok)' },
};

const AREAS = [
  { id: 'api/auth',       files: 23 },
  { id: 'api/billing',    files: 31 },
  { id: 'api/middleware', files: 14 },
  { id: 'web/dashboard',  files: 47 },
  { id: 'web/onboarding', files: 26 },
  { id: 'shared/ui',      files: 58 },
  { id: 'infra/deploy',   files: 9  },
  { id: 'db/migrations',  files: 142},
  { id: 'docs',           files: 38 },
];

// pool of extra log lines for the live simulation
const LOG_POOL = {
  auth: ['14:26:02  refresh.ts — rotating key set wired', '14:27:18  middleware verify path updated', '14:28:40  running integration suite…'],
  dashperf: ['14:26:50  loader batch #2 — 4 queries → 1', '14:28:05  usage widget p95: 612ms → 287ms', '14:29:12  adding cache layer to loaders'],
  tokens: ['14:26:31  Input.tsx migrated to tokens', '14:27:55  visual diff: 0 unexpected changes', '14:29:03  Button.tsx — waiting on conflict check'],
};

Object.assign(window, { AGENTS, QUEUE, AREAS, STATUS_META, KIND_META, LOG_POOL });
