// ─── Skynet server bootstrap ───────────────────────────────────────────────
// API + WebSocket gateway + orchestrator in one process (Architecture Brief
// §03/§08). Phase 0: in-memory store, in-process bus, mock runner.

import { loadedEnvFrom } from "./load-env.js"; // MUST be first — loads .env before config reads process.env
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { config } from "./config.js";
import { InProcessBus } from "./bus.js";
import type { Bus } from "./bus.js";
import { Hub } from "./hub.js";
import { Orchestrator } from "./orchestrator.js";
import { Operations } from "./operations.js";
import { RuleEngine } from "./rules/engine.js";
import { registerApi } from "./api.js";
import { registerMcp } from "./mcp/http.js";
import { registerOpenAiCompat } from "./interop/openai.js";
import { registerInteropRest } from "./interop/rest.js";
import { registerWs } from "./ws.js";
import { registerStatic } from "./static.js";
import { registerPreview, backfillPreviews, kickoffPreviewBuilds } from "./preview/index.js";
import { projectPreview } from "./preview/project-preview.js";
import { registerLivePreviewProxy } from "./preview/preview-proxy.js";
import { recordPublicOrigin } from "./preview/public-origin.js";
import { registerSecretsRoutes } from "./secrets/index.js";
import { registerGithubRoutes, registerGithubWebhookRoutes, configureGithub, githubService } from "./github/index.js";
import { startTaskSourceSync } from "./task-sync.js";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { registerEvalsRoutes } from "./evals/index.js";
import { registerSimulationRoutes } from "./simulation/index.js";
import { registerRateLimit } from "./rate-limit.js";
import { isCorsOriginAllowed } from "./cors-policy.js";
import { configureAuth } from "./auth.js";
import { MemorySessionStore, type SessionStore } from "./auth/sessions.js";
import { StoreServiceTokenStore } from "./auth/service-tokens.js";
import { seedBootstrapToken } from "./auth/bootstrap.js";
import { MemoryOperatorDirectory, seedOperators } from "./auth/operators.js";
import { MemoryElevationStore } from "./auth/elevations.js";
import { registerAuthRoutes, registerServiceTokenRoutes } from "./auth/routes.js";
import { ensureRecoveryCodes } from "./auth/mfa.js";
import { startTelegramBridge } from "./telegram/index.js";
import { MemoryStore } from "./store/memory.js";
import type { Store } from "./store/store.js";

async function main() {
  let store: Store;
  if (config.store === "postgres") {
    const { PostgresStore } = await import("./store/postgres.js");
    store = await PostgresStore.create(config.databaseUrl);
  } else if (config.store === "file") {
    const { FileStore } = await import("./store/file.js");
    store = FileStore.create(config.dbPath);
  } else if (config.store === "memory") {
    store = new MemoryStore();
  } else {
    // No silent default: choosing persistence is explicit so data loss is never a surprise.
    throw new Error("No store configured. Set STORE=memory for dev/tests, or STORE=file / STORE=postgres for durability.");
  }
  let bus: Bus;
  if (config.bus === "redis") {
    const { RedisBus } = await import("./bus.redis.js");
    bus = await RedisBus.create(config.redisUrl);
  } else if (config.bus === "memory") {
    bus = new InProcessBus();
  } else {
    throw new Error("No bus configured. Set BUS=memory for single-process dev/tests, or BUS=redis for multi-replica.");
  }
  const hub = new Hub(store, bus);
  const orchestrator = new Orchestrator(store, hub);
  // Momentum Rollout Phase 1b — the board-management layer alongside the
  // orchestrator (reacts to signals, moves cards, writes Transitions; never
  // touches agents/worktrees). Subscribing is inert on its own: it only acts
  // once a project has at least one `state:"live"` Rule.
  const ruleEngine = new RuleEngine({ store, hub, bus });
  await ruleEngine.start();
  // The shared service layer behind both the HTTP API and the MCP server.
  const operations = new Operations({ store, hub, orchestrator, ruleEngine });
  // Persist the GitHub connection in the same Store as the rest of the domain
  // (file for the desktop app, Postgres for hosted) — durable, no side-store.
  configureGithub(store);

  // Write task status changes back to their imported source of truth (GitHub
  // issues today). Off unless a project opts in (syncSourceStatus). Best-effort.
  startTaskSourceSync(bus, { store, log: (m) => console.log(m) });

  // Deploy-time convenience: if a GITHUB_TOKEN is present (the GCP self-host
  // loads it from Secret Manager) and the workspace has no GitHub connection
  // yet, connect it via PAT at boot — so repo ops (branch/push/PR) work without
  // re-pasting the same token in the UI. Best-effort: a bad/expired token,
  // missing scopes, or no network just leaves the in-app connect prompt; it
  // never blocks startup.
  const githubSeedToken = process.env.GITHUB_TOKEN;
  if (githubSeedToken) {
    const seedWs = config.adminWorkspace || DEFAULT_WORKSPACE;
    void githubService
      .get(seedWs)
      .then(async (existing) => {
        if (existing?.connected) return;
        await githubService.connectViaPat(seedWs, githubSeedToken);
        console.log(`[github] connected from GITHUB_TOKEN for workspace=${seedWs}`);
      })
      .catch((err) =>
        console.warn(
          `[github] GITHUB_TOKEN present but auto-connect failed (connect in the UI): ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );
  }

  // Auth: real login issues sessions (W6); dev tokens resolve in dev only. The
  // session backend is durable (Postgres) or multi-replica (Redis) when
  // selected, else in-memory. Adapters connect lazily, so no await here.
  let sessions: SessionStore;
  if (config.sessions === "postgres") {
    const { PostgresSessionStore } = await import("./auth/sessions.postgres.js");
    sessions = new PostgresSessionStore(config.databaseUrl);
  } else if (config.sessions === "redis") {
    const { RedisSessionStore } = await import("./auth/sessions.redis.js");
    sessions = new RedisSessionStore(config.redisUrl);
  } else if (config.sessions === "memory") {
    sessions = new MemorySessionStore();
  } else {
    throw new Error("No session store configured. Set SESSIONS=memory for dev/tests, or SESSIONS=postgres / SESSIONS=redis.");
  }
  const seededOperators = seedOperators();
  const operators = new MemoryOperatorDirectory(seededOperators);
  // Time-limited admin promotion (ROADMAP.md) — grants + their audit trail,
  // in-memory only for now, same footing as the operator directory itself (no
  // Postgres-backed directory exists yet either). Independent of the session
  // backend (memory/Postgres/Redis) — see auth/elevations.ts.
  const elevations = new MemoryElevationStore();
  // Scoped API tokens for MCP / programmatic access. Persisted through the
  // domain Store (file on desktop, Postgres hosted) as a hash + last-4 — so a
  // token minted in Settings survives a restart, and the raw secret is never
  // written to disk.
  const serviceTokens = new StoreServiceTokenStore(store);
  configureAuth({ sessions, serviceTokens, elevations });
  // Recovery codes: generate once (plaintext written to a 0600 file on /data
  // for one-time SSH retrieval; hashes persisted) — idempotent, a no-op past
  // the first boot. Unconditional now (not gated on mfaEnabled()): a
  // workspace can turn MFA on LIVE via its own Settings toggle
  // (requireLoginVerification), with SKYNET_MFA never set at boot — codes
  // must already exist before that happens, or a Telegram delivery failure
  // could lock the operator out with no escape but SSH break-glass.
  ensureRecoveryCodes((m) => console.log(m));
  // Headless/sandbox deploys: register the agent-provided bootstrap token so it
  // can call /mcp without a human login (no-op unless SKYNET_BOOTSTRAP_TOKEN set).
  const bootstrap = await seedBootstrapToken(serviceTokens);

  // Hard guardrail: never boot an OPEN API outside an explicit dev/test env. An
  // unset/typo'd/"staging" NODE_ENV now requires auth by default; if someone
  // ALSO forces AUTH_REQUIRED=false there, fail closed rather than silently serve
  // unauthenticated requests. Only an explicit NODE_ENV=development/test may open.
  if (!config.authRequired && !config.devMode) {
    throw new Error(
      "Refusing to start: AUTH_REQUIRED is off outside an explicit development/test env — the API would accept UNAUTHENTICATED requests. " +
        `Set AUTH_REQUIRED=true (recommended), or NODE_ENV=development for local dev. (NODE_ENV=${config.nodeEnv})`,
    );
  }

  // trustProxy: read the real client IP from X-Forwarded-For behind a proxy you
  // control, so rate limiting keys on the caller, not the proxy. Off by default.
  const app = Fastify({
    // Headless deploys log at info so the operator/agent sees the MCP-ready +
    // bootstrap-token confirmation on boot (otherwise suppressed in production).
    logger: { level: config.nodeEnv === "development" || config.headless ? "info" : "warn" },
    trustProxy: config.trustProxy,
  });
  if (!config.authRequired) {
    app.log.warn("AUTH_REQUIRED is OFF (explicit dev/test) — the API accepts unauthenticated requests. Never expose this build.");
  }
  // Fail-loud, not fail-silent: in production the demo operators are never
  // seeded, so an empty directory means nobody can log in via the UI. Fine for a
  // headless/MCP deploy (service tokens), a lockout for a UI deploy — say so.
  if (!config.devMode && seededOperators.length === 0) {
    app.log.warn(
      "No operator seeded — UI login is disabled. Set SKYNET_ADMIN_EMAIL + SKYNET_ADMIN_PASSWORD to seed the first admin, or drive the API with service tokens (MCP).",
    );
  }
  // Scoped CORS: dev/test stays permissive (localhost). In production-grade mode
  // only SKYNET_CORS_ORIGINS are allowed; an empty allowlist is closed (no
  // reflect-any fall-back). isCorsOriginAllowed is the single source of truth.
  await app.register(cors, {
    origin: config.devMode
      ? true
      : (origin, cb) =>
          cb(null, isCorsOriginAllowed(origin, { devMode: config.devMode, allowlist: config.corsOrigins })),
  });
  await app.register(websocket);
  // Context-entry uploads (meeting notes/docs — see steward/context.ts). A
  // single small field: one file per request, capped well above any real
  // notes doc but far below "someone uploaded a video by mistake".
  await app.register(multipart, { limits: { fileSize: 15 * 1024 * 1024, files: 1 } });
  // Rate limiting runs before auth so a flood is shed early. Guards /api + /mcp
  // (login hardest); exempts loopback in dev. See rate-limit.ts.
  registerRateLimit(app);

  app.get("/health", async () => ({ ok: true, store: config.store, bus: config.bus, runner: "per-runner", sessions: config.sessions }));

  await registerAuthRoutes(app, { sessions, operators, elevations, operations });
  await registerServiceTokenRoutes(app, { serviceTokens, operations });
  await registerApi(app, { operations, orchestrator });
  // MCP endpoint (Streamable HTTP) — runs drive Skynet through the same
  // scoped-principal auth as the /api routes. stdio clients proxy to this too.
  await registerMcp(app, { operations, bus });
  // Interop surface beyond /mcp: an OpenAI-compatible /v1/chat/completions +
  // /v1/models (drive the fleet as if it were a hosted model) and a plain
  // /v1/runs job-submission REST API — same bearer-token auth/scopes as /mcp.
  await registerOpenAiCompat(app, { operations, bus });
  await registerInteropRest(app, { operations });
  // Workspace-scoped provider keys (encrypted at rest); /api auth hook applies.
  await registerSecretsRoutes(app, operations);
  // GitHub App connection + safety policy (workspace-scoped); /api auth applies.
  await registerGithubRoutes(app);
  // Inbound GitHub webhook (issues → task) — outside /api on purpose; the HMAC
  // signature is its own auth. No-op unless GITHUB_WEBHOOK_SECRET is set.
  await registerGithubWebhookRoutes(app, { operations });
  // LLM-judged acceptance evals (real runs via the standalone evals/ suite,
  // spawned as a subprocess); /api auth hook applies.
  await registerEvalsRoutes(app);
  // Behavioral LLM judge for Simulation journeys (in-process; /api auth applies).
  registerSimulationRoutes(app);
  await registerWs(app, { store, bus, hub });
  // Headless / MCP-first mode skips the web SPA + preview pipeline — just the
  // API + WS + /mcp (agent surface only). Otherwise mount both as usual.
  let servingSpa = false;
  if (config.headless) {
    app.log.info("headless mode: SPA + live-preview disabled — API + WS + /mcp only");
  } else {
    // W5 live preview: mount the sandboxed /preview route, stamp visual/previewUrl
    // onto already-stored runs, then warm their builds. No-op unless PREVIEW != off.
    await registerPreview(app, { store });
    // Learn Skynet's public origin from forwarded headers so live previews get a
    // phone-reachable URL, and front their loopback dev servers at /p/<token>/.
    app.addHook("onRequest", (req, _reply, done) => {
      recordPublicOrigin(
        req.headers["x-forwarded-proto"] as string | undefined,
        req.headers["x-forwarded-host"] as string | undefined,
        req.headers.host,
      );
      done();
    });
    registerLivePreviewProxy(
      app,
      (t) => projectPreview.proxyTargetForToken(t),
      () => projectPreview.liveSalvageCandidates(),
    );
    // Kill any live preview trees on graceful shutdown — their dev servers are
    // spawned detached (own process group) so they'd otherwise outlive the server
    // and keep holding ports (EADDRINUSE on the next boot). In a container, PID
    // teardown handles this; this covers desktop / `app.close()`.
    app.addHook("onClose", async () => {
      await projectPreview.stopAll().catch(() => undefined);
    });
    const stamped = await backfillPreviews(store);
    if (stamped) app.log.info(`preview: stamped ${stamped} agent(s) with a live preview URL`);
    const queued = await kickoffPreviewBuilds(store);
    if (queued) app.log.info(`preview: queued ${queued} agent build(s)`);
    servingSpa = await registerStatic(app);
  }

  // Release "orphaned busy" runners — persisted busy but held by no live agent
  // (a restart leaves the store saying busy while the in-memory live map is
  // empty). Runs once at boot, before we listen, so nothing is mid-assign.
  await orchestrator.reconcileRunners().catch((err) => app.log.warn(`runner reconcile: ${(err as Error).message}`));

  // Keep the fleet on latest main: fetch each active project's base from origin
  // and flag any in-flight run that's fallen behind. Once at boot (so the first
  // run branches off fresh main), then on the reaper's interval.
  const syncBase = () =>
    orchestrator.syncBaseAndFlagStale().catch((err) => app.log.warn(`base sync: ${(err as Error).message}`));
  await syncBase();

  // Reap presumed-dead runs (frees runners orphaned by a crash/restart). Run
  // once at boot to clear restart orphans, then on an interval. Bounded to a
  // sane minimum so it can't spin hot; disabled when agentReapMs <= 0.
  if (config.agentReapMs > 0) {
    const sweep = () => {
      void orchestrator.reapStaleAgents().catch((err) => app.log.warn(`reaper: ${(err as Error).message}`));
      // Self-heal runs archived while still mid-flight. Archiving settles the
      // run at the point of archiving now, but runs archived BEFORE that fix
      // are stuck non-terminal forever (the stuck-review sweep skips archived
      // runs) — this clears them without a data migration, and is a cheap
      // no-op once none remain.
      void orchestrator
        .settleArchivedRuns()
        .catch((err) => app.log.warn(`archived-run sweep: ${(err as Error).message}`));
      void syncBase();
    };
    await sweep();
    const every = Math.max(30_000, Math.min(config.agentReapMs, 60_000));
    setInterval(sweep, every).unref();
  }

  // Worktree GC: remove zombie agent worktrees (run done/archived/unknown) and
  // integrated agent/* branches; surface limbo reviews. Never deletes unmerged
  // work. Boot sweep + interval; disabled when worktreeGcMs <= 0.
  if (config.worktreeGcMs > 0) {
    const gc = () =>
      orchestrator
        .gcWorktrees()
        .then((s) => {
          if (s.worktreesRemoved || s.branchesDeleted)
            app.log.info(`worktree gc: removed ${s.worktreesRemoved} worktree(s), ${s.branchesDeleted} merged branch(es)${s.limbo ? `, ${s.limbo} review(s) in limbo` : ""}`);
        })
        .catch((err) => app.log.warn(`worktree gc: ${(err as Error).message}`));
    await gc();
    setInterval(gc, Math.max(300_000, config.worktreeGcMs)).unref();
  }

  // Idle-runner reaper: retire auto-provisioned runners that have sat idle past
  // the workspace's TTL (retireIdleRunnersAfterMinutes; 0 = off, per workspace),
  // so auto-scaled capacity is reclaimed instead of piling up. A janitorial sweep
  // like the run reaper above — cheap, and a no-op when no workspace enables it.
  {
    const reapRunners = () =>
      orchestrator
        .reapIdleRunners()
        .then((n) => {
          if (n) app.log.info(`idle-runner reaper: retired ${n} idle auto-provisioned runner(s)`);
        })
        .catch((err) => app.log.warn(`idle-runner reaper: ${(err as Error).message}`));
    await reapRunners();
    setInterval(reapRunners, 60_000).unref();
  }

  // Autonomy loop: triage backlog items, start auto-pick tasks, review finished
  // runs — for projects with autonomy on. Disabled when autonomyMs <= 0.
  if (config.autonomyMs > 0) {
    const tick = () =>
      orchestrator.tickAutonomy().catch((err) => app.log.warn(`autonomy: ${(err as Error).message}`));
    const every = Math.max(8_000, Math.min(config.autonomyMs, 60_000));
    setInterval(tick, every).unref();
  }

  // Rule engine resolver sweep: finalizes announce-before-acting
  // PendingRuleActions once their undo window elapses. Kept frequent by
  // default — the sweep is cheap (a no-op unless something's actually ready)
  // and a short cadence keeps the "signal in → ... → window elapses" loop
  // tight for demo/test purposes. 0 disables.
  if (config.ruleEngineSweepMs > 0) {
    const sweepPending = () =>
      ruleEngine.sweepPendingActions().catch((err) => app.log.warn(`rule engine sweep: ${(err as Error).message}`));
    await sweepPending();
    setInterval(sweepPending, Math.max(5_000, config.ruleEngineSweepMs)).unref();
  }

  // Stall detection: a separate, slower scheduled job (same reaper pattern)
  // — flags ongoing/review tasks with no signal in stallNudgeHours, escalates
  // at stallEscalateHours. 0 disables.
  if (config.stallSweepMs > 0) {
    const sweepStall = () =>
      ruleEngine.sweepStallDetection().catch((err) => app.log.warn(`stall detection: ${(err as Error).message}`));
    await sweepStall();
    setInterval(sweepStall, Math.max(60_000, config.stallSweepMs)).unref();
  }

  // TASK 10 — pattern-spotted automation onboarding: scans human Transitions
  // for a repeated manual move and proposes it as a rule (same reaper
  // pattern as the sweeps above). Separately, a watch-state rule left
  // unmodified for a week auto-promotes to live. Both 0 disables.
  if (config.patternDetectSweepMs > 0) {
    const sweepPatterns = () =>
      ruleEngine.sweepPatternDetection().catch((err) => app.log.warn(`pattern detection: ${(err as Error).message}`));
    await sweepPatterns();
    setInterval(sweepPatterns, Math.max(60_000, config.patternDetectSweepMs)).unref();
  }
  if (config.watchPromoteSweepMs > 0) {
    const sweepWatchPromotion = () =>
      ruleEngine.sweepWatchPromotion().catch((err) => app.log.warn(`watch promotion: ${(err as Error).message}`));
    await sweepWatchPromotion();
    setInterval(sweepWatchPromotion, Math.max(60_000, config.watchPromoteSweepMs)).unref();
  }

  // Telegram messaging bridge + remote kill switch: connects OUT to Telegram
  // (long-poll, no open ports), pushes gate/run notifications to the owner, and
  // accepts owner-only slash-commands (/status, /stop, /quit, …). Fire-and-forget
  // — no-op unless SKYNET_TELEGRAM_BOT_TOKEN + SKYNET_TELEGRAM_OWNER_CHAT_ID are set.
  startTelegramBridge({ config, bus, operations, orchestrator });

  await app.listen({ port: config.port, host: "0.0.0.0" });
  if (servingSpa) app.log.info("serving built web SPA from this server");
  if (bootstrap) {
    // Never log the secret itself — only what it was granted.
    app.log.info(`MCP bootstrap token registered — workspace=${bootstrap.workspaceId} scopes=[${bootstrap.scopes.join(", ")}] → POST /mcp`);
    if (bootstrap.dropped.length > 0) app.log.warn(`ignored unknown bootstrap scopes: ${bootstrap.dropped.join(", ")}`);
  }
  if (config.headless) {
    app.log.info(`MCP endpoint ready → POST :${config.port}/mcp  (Authorization: Bearer <service-token>)`);
    if (!bootstrap) app.log.warn("headless without SKYNET_BOOTSTRAP_TOKEN — no token registered; set it, or mint one via the API, before an MCP client can connect.");
  }
  app.log.info(loadedEnvFrom ? `loaded env from ${loadedEnvFrom}` : "no .env file found (using process env only)");
  app.log.info(`Skynet server up on :${config.port}  (store=${config.store} bus=${config.bus} runner=per-runner sessions=${config.sessions})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
