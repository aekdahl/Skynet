// Environment config — see .env.example for the full list.

const nodeEnv = process.env.NODE_ENV ?? "development";

export const config = {
  port: Number(process.env.PORT ?? 8080),
  nodeEnv,
  // No silent default: an unset STORE errors at boot rather than quietly using
  // an ephemeral in-memory store. Opt in explicitly (STORE=memory for dev/tests).
  store: (process.env.STORE || undefined) as "memory" | "file" | "postgres" | undefined,
  // Path for STORE=file (zero-dependency JSON persistence; default cwd-relative).
  // The desktop app points this at its per-user data directory.
  dbPath: process.env.SKYNET_DB_PATH || "skynet-data.json",
  // Prefill the store with demo fixtures (sample projects/agents/queue/fleet).
  // Off by default — a fresh deploy starts empty; opt in with SKYNET_SEED=true.
  seedDemo: process.env.SKYNET_SEED === "true",
  // No silent default: pick the fan-out backbone explicitly (BUS=memory for
  // single-process dev/tests; BUS=redis to fan out across replicas).
  bus: (process.env.BUS || undefined) as "memory" | "redis" | undefined,
  // No silent default: pick the session backend explicitly (memory for dev/tests;
  // postgres for durable, redis for multi-replica).
  sessions: (process.env.SESSIONS || undefined) as "memory" | "postgres" | "redis" | undefined,
  // No silent default: an unset RUNNER errors when you try to assign a task,
  // rather than quietly running the mock and looking like real execution. Set
  // RUNNER=mock explicitly for dev/tests, or a real provider.
  runner: (process.env.RUNNER || undefined) as "mock" | "claude" | "codex" | "gemini" | "cursor" | "copilot" | undefined,
  // Working directory for a real runner (the target repo / agent worktree).
  runnerCwd: process.env.SKYNET_RUNNER_CWD || undefined,
  databaseUrl: process.env.DATABASE_URL ?? "",
  redisUrl: process.env.REDIS_URL ?? "",
  // When true, requests without a valid token are rejected (401). Secure by
  // default: if AUTH_REQUIRED is unset, it's ON in production and OFF in dev —
  // so a prod deploy never silently accepts unauthenticated requests. Explicit
  // AUTH_REQUIRED=true/false always wins.
  authRequired: process.env.AUTH_REQUIRED != null ? process.env.AUTH_REQUIRED === "true" : nodeEnv === "production",
  // Lifetime of a login session before it expires (→ 401). Default 12h.
  sessionTtlMs: Number(process.env.SESSION_TTL_MS ?? 12 * 60 * 60 * 1000),
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
};

export const now = (): number => Date.now();
