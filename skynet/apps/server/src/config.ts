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
  // Set by the desktop shell (apps/desktop/main.cjs) when the server is running
  // as the local packaged app. Gates the in-app Advanced env-settings panel +
  // engine-restart, which only make sense (and are only safe) there.
  desktop: process.env.SKYNET_DESKTOP === "1",
  // The `<userData>/skynet.env` overrides file the desktop shell reads at boot;
  // the Advanced settings panel writes staged env changes here. Null elsewhere.
  envFile: process.env.SKYNET_ENV_FILE || null,
  // Trust an upstream reverse proxy's X-Forwarded-For for the client IP (needed
  // so rate limiting keys on the real caller in a hosted deploy). Off by default
  // — only enable behind a proxy you control (XFF is spoofable otherwise).
  trustProxy: process.env.SKYNET_TRUST_PROXY === "true",
  // Per-IP request cap per minute on /api + /mcp (0 disables). A generous general
  // limit blunts abuse/DoS without tripping the local suites; login is far tighter
  // to blunt credential brute-force. Loopback is exempt in devMode (trusted desktop).
  rateMax: Number(process.env.SKYNET_RATE_MAX ?? 600),
  loginRateMax: Number(process.env.SKYNET_LOGIN_RATE_MAX ?? 10),
  // Cross-origin allowlist for @fastify/cors. In dev/test CORS stays permissive
  // (localhost dev). In production-grade mode ONLY these origins are allowed and
  // an empty list is CLOSED (never a silent reflect-any fall-back). See
  // cors-policy.ts. Comma-separated (e.g. https://app.example.com,https://ops.example.com).
  corsOrigins: (process.env.SKYNET_CORS_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  // No silent default: an unset STORE errors at boot rather than quietly using
  // an ephemeral in-memory store. Opt in explicitly (STORE=memory for dev/tests).
  store: (process.env.STORE || undefined) as "memory" | "file" | "postgres" | undefined,
  // Path for STORE=file (zero-dependency JSON persistence; default cwd-relative).
  // The desktop app points this at its per-user data directory.
  dbPath: process.env.SKYNET_DB_PATH || "skynet-data.json",
  // Where this installation's compliance-report signing keypair lives (see
  // apps/server/src/compliance/signing.ts). Defaults next to the data file —
  // same "just a file on disk, no native deps" trust model as STORE=file
  // itself. The private key never leaves this file / this host.
  complianceKeyPath: process.env.SKYNET_COMPLIANCE_KEY_PATH || undefined,
  // No silent default: pick the fan-out backbone explicitly (BUS=memory for
  // single-process dev/tests; BUS=redis to fan out across replicas).
  bus: (process.env.BUS || undefined) as "memory" | "redis" | undefined,
  // No silent default: pick the session backend explicitly (memory for dev/tests;
  // postgres for durable, redis for multi-replica).
  sessions: (process.env.SESSIONS || undefined) as "memory" | "postgres" | "redis" | undefined,
  // Working directory for a real runner (the target repo / agent worktree).
  // Each agent executes on its fleet runner's own provider
  // (claude/codex/gemini/cursor/copilot/hermes/opencode); there is no mock and no global
  // RUNNER override — a runner runs only if its provider has a credential (or is
  // a CLI-login provider), else nothing runs.
  runnerCwd: process.env.SKYNET_RUNNER_CWD || undefined,
  databaseUrl: process.env.DATABASE_URL ?? "",
  redisUrl: process.env.REDIS_URL ?? "",
  // Public base URL the app is reachable at (e.g. https://skynet.example.com) —
  // used to build deep links in outbound notifications (Telegram) that open the
  // specific run. No trailing slash; empty → notices omit the link.
  publicUrl: (process.env.PUBLIC_URL ?? "").trim().replace(/\/+$/, ""),
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
  //
  // Two TTLs: MFA-verified sessions can last much longer than password-only
  // ones, because the second factor already raised the bar. Rechecking MFA
  // every 12h is more friction than the security buys — a re-verify every ~30d
  // is the industry-common "trust this device" duration.
  sessionTtlMs: Number(process.env.SESSION_TTL_MS ?? 12 * 60 * 60 * 1000),
  sessionTtlMfaMs: Number(process.env.SESSION_TTL_MFA_MS ?? 30 * 24 * 60 * 60 * 1000),

  // ── First operator (production login seed) ─────────────────────────────────
  // In dev/test the operator directory is seeded with the demo pair so the login
  // flow is demoable end-to-end. In PRODUCTION those shared demo accounts are
  // NEVER seeded (a well-known password on a hosted deploy is a footgun); instead
  // the first admin is seeded ONLY from these env vars. Unset in prod → an empty
  // directory (UI login disabled — correct for a headless/MCP deploy that uses
  // service tokens; a UI deploy MUST set these). See auth/operators.ts.
  adminEmail: (process.env.SKYNET_ADMIN_EMAIL || "").toLowerCase() || undefined,
  adminPassword: process.env.SKYNET_ADMIN_PASSWORD || undefined,
  adminWorkspace: process.env.SKYNET_ADMIN_WORKSPACE || undefined,

  // Optional second account: a read-only login (Principal.scopes: ["observe"]
  // at login — see auth/operators.ts). Independent of the admin vars above;
  // set alone or alongside them. No invite/user-management UI exists yet, so
  // this env seed is the only way to stand up a viewer on a hosted deploy.
  viewerEmail: (process.env.SKYNET_VIEWER_EMAIL || "").toLowerCase() || undefined,
  viewerPassword: process.env.SKYNET_VIEWER_PASSWORD || undefined,
  viewerWorkspace: process.env.SKYNET_VIEWER_WORKSPACE || undefined,

  // Time-limited admin promotion (ROADMAP.md) — an existing ADMIN grants a
  // named viewer a bounded full-authority window (POST
  // /api/operators/:id/promote), which auto-reverts on its own once it lapses
  // (auth/elevations.ts's activeUntil(), checked on every request — no
  // manual revert). elevationTtlMs is the default window when the request
  // doesn't specify one; elevationMaxTtlMs caps whatever it asks for, so a
  // caller can request a shorter window but never a longer one.
  elevationTtlMs: Number(process.env.SKYNET_ELEVATION_TTL_MS ?? 15 * 60 * 1000),
  elevationMaxTtlMs: Number(process.env.SKYNET_ELEVATION_MAX_TTL_MS ?? 60 * 60 * 1000),

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
  // Where GitHub-connected projects are cloned to on a server with no local
  // checkout (e.g. GCP): each project gets `<reposDir>/<projectId>`, set as its
  // repoPath. On the desktop you pick a local folder instead, so this is unset.
  // Default (when unset) is a `.skynet-repos` dir next to the cwd.
  reposDir: process.env.SKYNET_REPOS_DIR || undefined,
  // Auto-reap window: a running/waiting agent whose heartbeat has been silent
  // for longer than this (ms) is presumed dead — its runner is freed and the
  // agent terminated. Catches orphans left by a crash/restart. 0 disables.
  agentReapMs: Number(process.env.SKYNET_AGENT_REAP_MS ?? 180_000),
  // Worktree GC sweep interval (ms): removes zombie agent worktrees (run done/
  // archived/unknown — e.g. left behind by a crash or a memory-store restart)
  // and deletes agent/* branches already merged into their integration branch.
  // NEVER deletes unmerged work. 0 disables. Runs once at boot regardless of
  // interval when > 0.
  worktreeGcMs: Number(process.env.SKYNET_WORKTREE_GC_MS ?? 1_800_000),
  // A run parked in `review` with no open gate and a heartbeat older than this
  // many days is SURFACED (log) as limbo — its worktree may hold the only copy
  // of unmerged work, so GC warns instead of deleting.
  worktreeTtlDays: Number(process.env.SKYNET_WORKTREE_TTL_DAYS ?? 3),
  // How often the autonomy loop ticks (ms): for projects with `autonomy` on it
  // triages backlog items, starts auto-pick todo tasks, and reviews finished
  // runs. 0 disables it entirely (fully human-driven). Per-project autonomy
  // flag still gates each project.
  autonomyMs: Number(process.env.SKYNET_AUTONOMY_MS ?? 15_000),
  // Default agent-action approval level for NEW projects (existing projects keep
  // their stored level). See ApprovalLevel: `manual` gates every command,
  // `assisted` auto-approves low-risk, `trusted` (default) auto-approves
  // low+medium reversible in-sandbox commands while high-risk / boundary ops
  // (push, merge, infra, destructive git) always gate. Env override:
  // SKYNET_APPROVAL_LEVEL. An unrecognized value falls back to `trusted`.
  // `full` (unattended merge to the base branch) is DELIBERATELY not settable
  // here — a workspace-wide env var silently defaulting every new project to
  // unattended merges would defeat the point of it being an explicit, confirmed,
  // per-project opt-in (see the Approvals selector in the web app).
  defaultApprovalLevel: (["manual", "assisted", "trusted"].includes(process.env.SKYNET_APPROVAL_LEVEL ?? "")
    ? process.env.SKYNET_APPROVAL_LEVEL
    : "trusted") as "manual" | "assisted" | "trusted",
  // Auto-resolve window for an unanswered `question` HITL (ms). When an agent
  // asks the operator something (e.g. "I can't reproduce this — what's the
  // stack trace?") and no one answers within this window, the question is
  // auto-resolved as "no answer" so the agent concludes without guessing and the
  // run doesn't hang. 0 (default) disables it — interactive workspaces wait for a
  // human indefinitely; headless/eval runs set a bound (e.g. 120_000).
  hitlQuestionTimeoutMs: Number(process.env.SKYNET_HITL_QUESTION_TIMEOUT_MS ?? 0),
  // Escalation guards — when a run can't finish on its own, hand it to a human
  // (an "escalation" HITL: help & resume, reassign, or stop) instead of spinning
  // or failing silently. The agent can also escalate itself at any time.
  //   • runMaxFailures: after this many failed attempts on the SAME run, escalate
  //     instead of parking it in `review`. >0 enables (default 3); 0 disables.
  //   • runStuckMs: a run actively `running` this long (ms) without finishing is
  //     escalated as "too long". 0 (default) disables — the runner already has a
  //     hard wall-clock cap (SKYNET_RUNNER_MAX_RUNTIME_MS); set this BELOW that to
  //     get a soft, human-recoverable escalation before the hard fail.
  runMaxFailures: Number(process.env.SKYNET_RUN_MAX_FAILURES ?? 3),
  runStuckMs: Number(process.env.SKYNET_RUN_STUCK_MS ?? 0),
  // Session circuit-breaker (project-scoped, behavioral — not the budget guard):
  // N consecutive BAD autonomy outcomes for the same project — a flagged
  // auto-review verdict, or a run that failed — with no good outcome in
  // between, turns that project's OWN `autonomy` toggle off and raises ONE
  // summary escalation instead of letting the sweep grind through more tasks.
  // Only tracks outcomes produced WHILE the project is autonomous (a manually-
  // supervised project isn't "sweeping"); re-enabling the toggle resets the
  // streak. >0 enables (default 3); 0 disables. See orchestrator.ts
  // noteAutonomyOutcome / noteAutonomyBadOutcome.
  autonomyMaxConsecutiveFailures: Number(process.env.SKYNET_AUTONOMY_MAX_CONSECUTIVE_FAILURES ?? 3),
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

  // ── Telegram messaging bridge (outbound-only remote control) ───────────────
  // The desktop app connects OUT to Telegram (no hosting, no open ports): it
  // pushes gate/run notifications to the owner and accepts a few owner-only
  // slash-commands (status, kill switch). BYO bot via @BotFather. Unset either of
  // the first two → the bridge stays disabled. NEVER log the token.
  telegramBotToken: process.env.SKYNET_TELEGRAM_BOT_TOKEN || undefined,
  // The owner's chat id — the ONLY chat the bridge acts on (all others ignored).
  telegramOwnerChatId: process.env.SKYNET_TELEGRAM_OWNER_CHAT_ID || undefined,
  // Conversational owner-only control is opt-in (default OFF). This single gate
  // enables ALL privileged natural-language actions (approve/reject/add_task/
  // assign/add_agent), each of which is parsed by the operator's OWN LLM into a
  // CLOSED five-action whitelist and CONFIRMED before it runs. Notifications,
  // /status, and the kill switch (/stop, /quit) work WITHOUT it and never depend
  // on the LLM. Replaces the older approve-only SKYNET_TELEGRAM_APPROVE flag.
  telegramControl: process.env.SKYNET_TELEGRAM_CONTROL === "true",
  // Quiet hours "22-7" (local, 24h): hold low-value "shipped" pings overnight so
  // the phone stays quiet. Decisions and "needs a look" always go through. Unset
  // or malformed → never quiet.
  telegramQuietHours: process.env.SKYNET_TELEGRAM_QUIET_HOURS || undefined,
  // How long the Telegram bridge waits before sending a diff/merge gate on an
  // autonomy-on project, so an auto-review that would approve it silences the
  // phone ping. The autonomy loop is ~15s + an LLM call, so ~20s is the shape
  // that catches the common case without meaningfully delaying real
  // human-facing gates. `0` disables the wait entirely (all gates ping
  // immediately — old behavior).
  telegramGateAutoReviewDebounceMs: Number(process.env.SKYNET_TELEGRAM_GATE_DEBOUNCE_MS ?? 20_000),

  // ── MFA (second factor on the public login) ────────────────────────────────
  // Opt-in Telegram OTP after the password. SKYNET_MFA_DISABLE is the SSH
  // break-glass: set it on the box + restart to log in with password only if you
  // ever lose Telegram AND your recovery codes.
  mfa: process.env.SKYNET_MFA === "true",
  mfaBreakGlass: process.env.SKYNET_MFA_DISABLE === "true",
};

export const now = (): number => Date.now();

// Sentinel exit code the server uses to ask the desktop shell to relaunch it
// (so staged env changes apply). apps/desktop/main.cjs respawns on this code
// instead of treating the exit as a crash. Keep in sync with main.cjs.
export const RESTART_EXIT_CODE = 88;
