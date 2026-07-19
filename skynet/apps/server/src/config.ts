// Environment config — see .env.example for the full list.

const rawNodeEnv = process.env.NODE_ENV;
const nodeEnv = rawNodeEnv ?? "development";
// Dev conveniences (open API + dev-token map) require an EXPLICIT development or
// test signal — never an unset/typo'd/"staging" NODE_ENV. An UNSET NODE_ENV is
// treated as production-grade (secure), so forgetting to set it can't silently
// open the API. (Vitest sets NODE_ENV=test, so the suite keeps its open default.)
const devMode = rawNodeEnv === "development" || rawNodeEnv === "test";

export const config = {
  port: Number(process.env.PORT ?? 8080),
  nodeEnv,
  // Explicit dev/test only — gates the open-auth fallback + dev-token map.
  devMode,
  // Trust an upstream reverse proxy's X-Forwarded-For for the client IP (needed
  // so rate limiting keys on the real caller in a hosted deploy). Off by default
  // — only enable behind a proxy you control (XFF is spoofable otherwise).
  trustProxy: process.env.SKYNET_TRUST_PROXY === "true",
  // Per-IP request cap per minute on /api + /mcp (0 disables). A generous general
  // limit blunts abuse/DoS without tripping the local suites; login is far tighter
  // to blunt credential brute-force. Loopback is exempt in devMode (trusted desktop).
  rateMax: Number(process.env.SKYNET_RATE_MAX ?? 600),
  loginRateMax: Number(process.env.SKYNET_LOGIN_RATE_MAX ?? 10),
  // No silent default: an unset STORE errors at boot rather than quietly using
  // an ephemeral in-memory store. Opt in explicitly (STORE=memory for dev/tests).
  store: (process.env.STORE || undefined) as "memory" | "file" | "postgres" | undefined,
  // Path for STORE=file (zero-dependency JSON persistence; default cwd-relative).
  // The desktop app points this at its per-user data directory.
  dbPath: process.env.SKYNET_DB_PATH || "skynet-data.json",
  // No silent default: pick the fan-out backbone explicitly (BUS=memory for
  // single-process dev/tests; BUS=redis to fan out across replicas).
  bus: (process.env.BUS || undefined) as "memory" | "redis" | undefined,
  // No silent default: pick the session backend explicitly (memory for dev/tests;
  // postgres for durable, redis for multi-replica).
  sessions: (process.env.SESSIONS || undefined) as "memory" | "postgres" | "redis" | undefined,
  // Working directory for a real runner (the target repo / agent worktree).
  // Each agent executes on its fleet runner's own provider
  // (claude/codex/gemini/cursor/copilot/hermes); there is no mock and no global
  // RUNNER override — a runner runs only if its provider has a credential (or is
  // a CLI-login provider), else nothing runs.
  runnerCwd: process.env.SKYNET_RUNNER_CWD || undefined,
  databaseUrl: process.env.DATABASE_URL ?? "",
  redisUrl: process.env.REDIS_URL ?? "",
  // When true, requests without a valid token are rejected (401). Secure by
  // default: if AUTH_REQUIRED is unset, it's ON in production and OFF in dev —
  // so a prod deploy never silently accepts unauthenticated requests. Explicit
  // AUTH_REQUIRED=true/false always wins.
  // Secure by default: ON unless we're explicitly in development/test. So an
  // unset/typo'd/"staging" NODE_ENV requires auth (fail closed). Explicit
  // AUTH_REQUIRED=true/false always wins; index.ts refuses to boot with it off
  // outside dev/test.
  authRequired: process.env.AUTH_REQUIRED != null ? process.env.AUTH_REQUIRED === "true" : !devMode,
  // Lifetime of a login session before it expires (→ 401). Default 12h.
  sessionTtlMs: Number(process.env.SESSION_TTL_MS ?? 12 * 60 * 60 * 1000),

  // ── MCP bootstrap token (headless / sandbox deploys) ───────────────────────
  // In a sandbox (e.g. Daytona) there is no human to log in and mint a token,
  // so the creating agent injects a strong random secret here at boot; Skynet
  // registers it as a scoped service token the agent then uses to call /mcp.
  // Unset (the default) → no bootstrap token; tokens are minted only via the UI.
  // Headless / MCP-first mode: don't serve the web SPA or run the live-preview
  // pipeline — just the API + WS + /mcp. For a sandbox (e.g. Daytona) that only
  // needs the agent surface. Same server, leaner footprint. See docs/mcp-sandbox.md.
  headless: process.env.SKYNET_HEADLESS === "true",
  mcpBootstrapToken: process.env.SKYNET_BOOTSTRAP_TOKEN || undefined,
  // Comma-separated scopes for the bootstrap token (default: observe + author,
  // NEVER approver by default — a human still gates HITL unless you opt in).
  mcpBootstrapScopes: process.env.SKYNET_BOOTSTRAP_SCOPES || "observe,author",
  // Workspace the bootstrap token is scoped to (default: the single-tenant one).
  mcpBootstrapWorkspace: process.env.SKYNET_BOOTSTRAP_WORKSPACE || undefined,
  // Target repo the merge queue integrates into. Unset → merge engine disabled
  // (diff-approve just completes the agent, the Phase 0 behavior).
  integrationRepo: process.env.SKYNET_INTEGRATION_REPO || undefined,
  baseBranch: process.env.SKYNET_BASE_BRANCH || "main",
  // Optional check command run in the repo before a merge is committed.
  checkCmd: process.env.SKYNET_CHECK_CMD || undefined,
  // Where per-agent git worktrees are created. Defaults to a sibling of the
  // integration repo (.skynet-worktrees) so working copies never show as
  // untracked inside the repo.
  worktreesDir: process.env.SKYNET_WORKTREES_DIR || undefined,
  // Auto-reap window: a running/waiting agent whose heartbeat has been silent
  // for longer than this (ms) is presumed dead — its runner is freed and the
  // agent terminated. Catches orphans left by a crash/restart. 0 disables.
  agentReapMs: Number(process.env.SKYNET_AGENT_REAP_MS ?? 180_000),
  // How often the autonomy loop ticks (ms): for projects with `autonomy` on it
  // triages backlog items, starts auto-pick todo tasks, and reviews finished
  // runs. 0 disables it entirely (fully human-driven). Per-project autonomy
  // flag still gates each project.
  autonomyMs: Number(process.env.SKYNET_AUTONOMY_MS ?? 15_000),
  // Auto-resolve window for an unanswered `question` HITL (ms). When an agent
  // asks the operator something (e.g. "I can't reproduce this — what's the
  // stack trace?") and no one answers within this window, the question is
  // auto-resolved as "no answer" so the agent concludes without guessing and the
  // run doesn't hang. 0 (default) disables it — interactive workspaces wait for a
  // human indefinitely; headless/eval runs set a bound (e.g. 120_000).
  hitlQuestionTimeoutMs: Number(process.env.SKYNET_HITL_QUESTION_TIMEOUT_MS ?? 0),
  // Expose the local folder browser (/api/fs/list) so the desktop UI can offer a
  // folder *picker* for connecting a project to a local repo. Local-only: it
  // reveals the server machine's filesystem, so it's ON only outside production
  // (desktop = server = same machine). MUST stay off for any hosted deploy.
  allowLocalFs:
    process.env.SKYNET_ALLOW_LOCAL_FS != null
      ? process.env.SKYNET_ALLOW_LOCAL_FS === "true"
      : nodeEnv !== "production",

  // ── GitHub App (server-side credentials; never per-workspace) ──────────────
  // When the App id + private key are set, the GitProvider can mint short-lived
  // installation tokens and push/PR/merge on the fleet's behalf. Unset → the
  // GitHub flow is disabled and the local merge engine handles integration.
  githubAppId: process.env.GITHUB_APP_ID || undefined,
  // PEM private key (or a \n-escaped single line, which we unescape).
  githubPrivateKey: (process.env.GITHUB_APP_PRIVATE_KEY || "").replace(/\\n/g, "\n") || undefined,
  githubApiBase: process.env.GITHUB_API_URL || "https://api.github.com",
  // HMAC secret to verify inbound webhooks (push/PR/check events).
  githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET || undefined,
  // ── GitHub App via cloud token-broker (Phase 2; desktop has no App key) ────
  // When set (and no local App key), installation tokens are minted by the
  // broker function from a user token obtained via Device Flow. The client id is
  // public (Device Flow needs no secret).
  githubBrokerUrl: process.env.SKYNET_GITHUB_BROKER_URL || undefined,
  githubClientId: process.env.GITHUB_CLIENT_ID || undefined,
};

export const now = (): number => Date.now();
