// ─── Seed fixtures ────────────────────────────────────────────────────────
// Ported from the prototype's data.jsx into the canonical contract shapes.
// Timestamps are computed relative to boot so the UI shows believable
// elapsed/wait/heartbeat values on first load.

import {
  DEFAULT_PROVIDERS,
  DEFAULT_WORKSPACE,
  type Agent,
  type Dependency,
  type HitlItem,
  type Module,
  type PlanStep,
  type Project,
  type ProviderId,
  type Runner,
  type Task,
} from "@skynet/shared";

const MODULE_NAMES: Record<string, string> = {
  "api/auth": "Auth",
  "api/billing": "Billing",
  "api/middleware": "API Middleware",
  "web/dashboard": "Dashboard",
  "web/onboarding": "Onboarding",
  "shared/ui": "Shared UI",
  "infra/deploy": "Deploy Infra",
  "db/migrations": "Data Migrations",
  docs: "Docs",
};

const MODEL_PROVIDER: Record<string, ProviderId> = {
  "opus-4.5": "claude",
  "sonnet-4.6": "claude",
  "haiku-4.5": "claude",
  "gpt-5.2-codex": "codex",
  "gpt-5.2-codex-mini": "codex",
  "gemini-3-pro": "gemini",
  "gemini-3-flash": "gemini",
  "composer-2": "cursor",
  "copilot-workspace": "copilot",
};

const plan = (steps: [string, PlanStep["state"]][]): PlanStep[] =>
  steps.map(([text, state]) => ({ text, state }));

interface RawAgent {
  id: string;
  name: string;
  status: Agent["status"];
  areas: string[];
  progress: number;
  branch: string;
  startedMin: number;
  model: string;
  hb: number;
  plan: PlanStep[];
  files: string[];
  log: string[];
  visual?: boolean;
  parentId?: string;
  branchFromStep?: number;
}

const RAW_AGENTS: RawAgent[] = [
  {
    id: "billing", name: "Stripe webhook reconciliation", status: "waiting",
    areas: ["api/billing", "db/migrations"], progress: 0.45, branch: "agent/billing-hooks",
    startedMin: 84, model: "opus-4.5", hb: 742,
    plan: plan([
      ["Map missing webhook event types", "done"],
      ["Build reconciliation worker", "done"],
      ["Write idempotency-key migration", "done"],
      ["Apply migration on staging", "now"],
      ["Backfill 30 days of events", "todo"],
      ["Open PR with rollout notes", "todo"],
    ]),
    files: ["api/billing/webhooks.ts", "api/billing/reconcile.ts", "db/migrations/0142_idempotency.sql"],
    log: ["worker passes replay suite — 412/412 events", "migration 0142 generated, dry-run OK", "HITL — needs approval to run migrate on staging"],
  },
  {
    id: "billing-replay", name: "Webhook replay tooling", status: "running",
    areas: ["api/billing"], progress: 0.34, branch: "agent/billing-replay",
    startedMin: 18, model: "opus-4.5", hb: 3, parentId: "billing", branchFromStep: 1,
    plan: plan([["Replay CLI", "done"], ["Event fixtures", "now"], ["Wire into CI", "todo"]]),
    files: ["api/billing/replay.ts"],
    log: ["forked from runner-01 — inherited webhook context", "replay CLI passing on 412-event fixture set"],
  },
  {
    id: "deploy", name: "Zero-downtime deploy pipeline", status: "waiting",
    areas: ["infra/deploy"], progress: 0.12, branch: "agent/blue-green",
    startedMin: 31, model: "opus-4.5", hb: 563,
    plan: plan([
      ["Audit current deploy script", "done"],
      ["Draft blue-green rollout plan", "now"],
      ["Health-check gating", "todo"],
      ["Rollback automation", "todo"],
      ["Run staged dry-run", "todo"],
    ]),
    files: ["infra/deploy/pipeline.yml"],
    log: ["audit complete — 2 single-point failovers found", "HITL — plan ready for review before execution"],
  },
  {
    id: "onboard", name: "Onboarding flow redesign", status: "waiting", visual: true,
    areas: ["web/onboarding", "shared/ui"], progress: 0.58, branch: "agent/onboard-v2",
    startedMin: 112, model: "sonnet-4.6", hb: 251,
    plan: plan([
      ["Rebuild step container + progress", "done"],
      ["New invite-teammates step", "done"],
      ["Wire CTA copy for step 3", "now"],
      ["Empty-state illustrations", "todo"],
      ["A/B flag + analytics events", "todo"],
    ]),
    files: ["web/onboarding/Step3.tsx", "web/onboarding/flow.ts", "shared/ui/Button.tsx"],
    log: ["step 3 layout rebuilt, snapshot tests updated", "touched shared/ui/Button.tsx — owned by token-migration", "HITL — CTA copy decision needed"],
  },
  {
    id: "ratelimit", name: "API rate limiting", status: "review",
    areas: ["api/middleware"], progress: 0.92, branch: "agent/rate-limits",
    startedMin: 147, model: "gpt-5.2-codex", hb: 138,
    plan: plan([
      ["Token-bucket middleware", "done"],
      ["Per-tenant config + overrides", "done"],
      ["Load test at 10k rps", "done"],
      ["Diff review & merge", "now"],
    ]),
    files: ["api/middleware/ratelimit.ts", "api/middleware/config.ts", "api/middleware/store.ts"],
    log: ["load test: p99 +0.4ms at 10k rps", "HITL — diff ready: +142 −38 across 6 files"],
  },
  {
    id: "auth", name: "Rotate auth token refresh", status: "running",
    areas: ["api/auth"], progress: 0.62, branch: "agent/token-refresh",
    startedMin: 58, model: "opus-4.5", hb: 2,
    plan: plan([
      ["Audit current refresh flow", "done"],
      ["Add /token/refresh endpoint", "done"],
      ["Rotate token store keys", "done"],
      ["Update session middleware", "now"],
      ["Integration tests", "todo"],
      ["Open PR", "todo"],
    ]),
    files: ["api/auth/refresh.ts", "api/auth/session.ts", "api/auth/store.ts"],
    log: ["middleware: swapping verify path to rotating keys", "session.ts — 14/14 unit tests green"],
  },
  {
    id: "auth-audit", name: "Session audit logging", status: "running",
    areas: ["api/auth"], progress: 0.15, branch: "agent/auth-audit",
    startedMin: 9, model: "opus-4.5", hb: 6, parentId: "auth", branchFromStep: 2,
    plan: plan([["Audit schema", "now"], ["Emit events", "todo"], ["Retention job", "todo"]]),
    files: ["api/auth/audit.ts"],
    log: ["forked from runner-05 — inherited token-rotation context", "drafting audit_events schema"],
  },
  {
    id: "dashperf", name: "Dashboard query performance", status: "running", visual: true,
    areas: ["web/dashboard"], progress: 0.31, branch: "agent/dash-perf",
    startedMin: 22, model: "gemini-3-flash", hb: 4,
    plan: plan([
      ["Profile slow queries", "done"],
      ["Batch widget data loaders", "now"],
      ["Add query-level cache", "todo"],
      ["Verify p95 < 300ms", "todo"],
    ]),
    files: ["web/dashboard/loaders.ts", "web/dashboard/widgets/usage.tsx"],
    log: ["profiling: usage widget = 61% of page time", "batching loaders — 9 queries → 2"],
  },
  {
    id: "tokens", name: "Design token migration", status: "running", visual: true,
    areas: ["shared/ui"], progress: 0.77, branch: "agent/token-migration",
    startedMin: 96, model: "composer-2", hb: 9,
    plan: plan([
      ["Extract color/space tokens", "done"],
      ["Codemod components to tokens", "done"],
      ["Migrate Button + Input", "now"],
      ["Visual regression pass", "todo"],
    ]),
    files: ["shared/ui/tokens.css", "shared/ui/Button.tsx", "shared/ui/Input.tsx"],
    log: ["codemod: 31 components migrated", "Button.tsx also modified on agent/onboard-v2"],
  },
  {
    id: "changelog", name: "Changelog automation", status: "done", visual: true,
    areas: ["docs"], progress: 1, branch: "agent/changelog",
    startedMin: 203, model: "haiku-4.5", hb: 0,
    plan: plan([["Parse merged PR labels", "done"], ["Generate weekly digest", "done"], ["CI job + Slack post", "done"]]),
    files: ["docs/changelog.md", ".github/workflows/changelog.yml"],
    log: ["merged — PR #1872"],
  },
];

interface RawProject {
  id: string;
  name: string;
  goal: string;
  agentIds: string[];
  backlog: string[];
}

const RAW_PROJECTS: RawProject[] = [
  { id: "payments", name: "Payments reliability", goal: "Stripe webhooks reconcile cleanly — zero dropped events.", agentIds: ["billing", "billing-replay"], backlog: ["Alerting on reconciliation drift", "Dunning email retries"] },
  { id: "apihard", name: "API hardening", goal: "Rate limiting and token rotation across the public API.", agentIds: ["ratelimit", "auth", "auth-audit"], backlog: ["API key scoping", "Audit log export"] },
  { id: "onboardp", name: "Onboarding revamp", goal: "New 4-step flow; targeting +15% activation.", agentIds: ["onboard"], backlog: ["Mobile onboarding parity"] },
  { id: "infra", name: "Deploy pipeline", goal: "Zero-downtime blue-green deploys with auto-rollback.", agentIds: ["deploy"], backlog: ["Canary deploys"] },
  { id: "feplat", name: "Frontend platform", goal: "Design tokens everywhere; dashboard p95 under 300ms.", agentIds: ["tokens", "dashperf"], backlog: ["Dark-mode tokens", "Chart kit migration"] },
  { id: "docsauto", name: "Docs automation", goal: "Weekly changelog digest, hands-free.", agentIds: ["changelog"], backlog: [] },
];

interface RawHitl {
  id: string;
  agentId: string;
  kind: HitlItem["kind"];
  waited: number;
  risk: HitlItem["risk"];
  title: string;
  why: string;
  command?: string;
  steps?: string[];
  options?: string[];
  recommended?: number;
  diffAdd?: number;
  diffDel?: number;
}

const RAW_QUEUE: RawHitl[] = [
  { id: "q-billing", agentId: "billing", kind: "approval", waited: 742, risk: "medium", title: "Run database migration on staging", why: "Adds idempotency_key column + unique index to payments_events. Dry-run passed; table has 2.1M rows, est. lock < 3s.", command: "prisma migrate deploy --schema db/schema.prisma  # staging" },
  { id: "q-deploy", agentId: "deploy", kind: "plan", waited: 563, risk: "low", title: "Approve blue-green rollout plan", why: "Plan replaces in-place deploys. No prod changes until staged dry-run passes.", steps: ["Provision green env from current image", "Gate cutover on /health + error-rate check", "Auto-rollback on 5xx spike > 0.5%", "Staged dry-run on staging", "Document runbook"] },
  { id: "q-onboard", agentId: "onboard", kind: "question", waited: 251, risk: "low", title: "CTA copy for onboarding step 3", why: "Two candidates pass the tone guide. Pick one — agent proceeds immediately.", options: ["Invite your team", "Add teammates — it’s faster together"], recommended: 0 },
  { id: "q-ratelimit", agentId: "ratelimit", kind: "diff", waited: 138, risk: "medium", title: "Review diff: token-bucket rate limiting", why: "Touches request path for all API traffic. Load-tested: p99 +0.4ms at 10k rps.", diffAdd: 142, diffDel: 38 },
];

const RAW_FLEET: { id: string; provider: ProviderId; model: string; idleMin?: number }[] = [
  { id: "runner-01", provider: "claude", model: "opus-4.5" },
  { id: "runner-02", provider: "claude", model: "opus-4.5" },
  { id: "runner-03", provider: "claude", model: "sonnet-4.6" },
  { id: "runner-04", provider: "codex", model: "gpt-5.2-codex" },
  { id: "runner-05", provider: "claude", model: "opus-4.5" },
  { id: "runner-06", provider: "cursor", model: "composer-2" },
  { id: "runner-07", provider: "gemini", model: "gemini-3-flash" },
  { id: "runner-08", provider: "claude", model: "haiku-4.5", idleMin: 41 },
  { id: "runner-09", provider: "copilot", model: "copilot-workspace", idleMin: 18 },
];

const DEPS_RAW: [string, string][] = [
  ["ratelimit", "deploy"],
  ["tokens", "dashperf"],
];

export interface SeedData {
  agents: Agent[];
  queue: HitlItem[];
  projects: Project[];
  tasks: Task[];
  fleet: Runner[];
  modules: Module[];
  deps: Dependency[];
}

export function buildSeed(now: number): SeedData {
  const agentProject = new Map<string, string>();
  for (const p of RAW_PROJECTS) for (const aid of p.agentIds) agentProject.set(aid, p.id);

  // Assign runners to active agents in order; runners flagged idle stay free.
  const freeRunners = RAW_FLEET.filter((r) => r.idleMin == null).map((r) => r.id);
  const runnerForAgent = new Map<string, string>();
  let ri = 0;
  for (const ra of RAW_AGENTS) {
    if (ra.status !== "done" && ri < freeRunners.length) {
      runnerForAgent.set(ra.id, freeRunners[ri]!);
      ri++;
    }
  }

  const agents: Agent[] = RAW_AGENTS.map((ra) => ({
    id: ra.id,
    workspaceId: DEFAULT_WORKSPACE,
    projectId: agentProject.get(ra.id) ?? "",
    name: ra.name,
    status: ra.status,
    runnerId: runnerForAgent.get(ra.id) ?? null,
    provider: MODEL_PROVIDER[ra.model] ?? "claude",
    model: ra.model,
    branch: ra.branch,
    modules: ra.areas,
    progress: ra.progress,
    plan: ra.plan,
    modifiedFiles: ra.files,
    log: ra.log.map((line, i) => ({ at: now - (ra.log.length - i) * 60_000, line })),
    startedAt: now - ra.startedMin * 60_000,
    lastHeartbeatAt: now - ra.hb * 1000,
    visual: ra.visual ?? false,
    previewUrl: null,
    dependsOn: [],
    parentId: ra.parentId ?? null,
    branchFromStep: ra.branchFromStep ?? null,
  }));

  const queue: HitlItem[] = RAW_QUEUE.map((rq) => {
    const agent = agents.find((a) => a.id === rq.agentId);
    return {
      id: rq.id,
      workspaceId: DEFAULT_WORKSPACE,
      agentId: rq.agentId,
      kind: rq.kind,
      title: rq.title,
      why: rq.why,
      risk: rq.risk,
      raisedAt: now - rq.waited * 1000,
      resolvedAt: null,
      resolution: null,
      command: rq.command ?? null,
      options: rq.options ?? null,
      recommended: rq.recommended ?? null,
      steps: rq.steps ?? null,
      diff:
        rq.diffAdd != null
          ? { add: rq.diffAdd, del: rq.diffDel ?? 0, modules: agent?.modules ?? [] }
          : null,
    };
  });

  const projects: Project[] = RAW_PROJECTS.map((p) => ({
    id: p.id,
    workspaceId: DEFAULT_WORKSPACE,
    name: p.name,
    goal: p.goal,
    agentIds: p.agentIds,
    status: "active",
  }));

  const tasks: Task[] = RAW_PROJECTS.flatMap((p) =>
    p.backlog.map((text, i) => ({
      id: `t-${p.id}-${i}`,
      workspaceId: DEFAULT_WORKSPACE,
      projectId: p.id,
      text,
      state: "backlog" as const,
      agentId: null,
    })),
  );

  const busy = new Set(runnerForAgent.values());
  const fleet: Runner[] = RAW_FLEET.map((r) => ({
    id: r.id,
    workspaceId: DEFAULT_WORKSPACE,
    name: r.id,
    provider: r.provider,
    model: r.model,
    status: busy.has(r.id) ? "busy" : "idle",
    idleSince: r.idleMin != null ? now - r.idleMin * 60_000 : busy.has(r.id) ? null : now,
  }));

  const modules: Module[] = Object.entries(MODULE_NAMES).map(([id, name]) => ({ id, name }));
  const deps: Dependency[] = DEPS_RAW.map(([fromAgentId, toAgentId]) => ({ fromAgentId, toAgentId }));

  return { agents, queue, projects, tasks, fleet, modules, deps };
}

// A provider is "available" when its credential is configured server-side
// (env var here; per-workspace secrets can override at run time). The
// create-agent UI disables providers that aren't available.
const PROVIDER_ENV_KEY: Record<ProviderId, string | undefined> = {
  claude: process.env.ANTHROPIC_API_KEY,
  codex: process.env.OPENAI_API_KEY,
  gemini: process.env.GEMINI_API_KEY,
  cursor: process.env.CURSOR_API_KEY,
  copilot: process.env.GITHUB_TOKEN,
};

export const PROVIDERS = DEFAULT_PROVIDERS.map((p) => ({
  ...p,
  available: Boolean(PROVIDER_ENV_KEY[p.id]),
}));
