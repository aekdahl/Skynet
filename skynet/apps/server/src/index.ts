// ─── Skynet server bootstrap ───────────────────────────────────────────────
// API + WebSocket gateway + orchestrator in one process (Architecture Brief
// §03/§08). Phase 0: in-memory store, in-process bus, mock runner.

import { loadedEnvFrom } from "./load-env.js"; // MUST be first — loads .env before config reads process.env
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { config } from "./config.js";
import { InProcessBus } from "./bus.js";
import type { Bus } from "./bus.js";
import { Hub } from "./hub.js";
import { Orchestrator } from "./orchestrator.js";
import { Operations } from "./operations.js";
import { registerApi } from "./api.js";
import { registerMcp } from "./mcp/http.js";
import { registerWs } from "./ws.js";
import { registerStatic } from "./static.js";
import { registerPreview, backfillPreviews, kickoffPreviewBuilds } from "./preview/index.js";
import { registerSecretsRoutes } from "./secrets/index.js";
import { registerGithubRoutes, configureGithub } from "./github/index.js";
import { registerEvalsRoutes } from "./evals/index.js";
import { registerSimulationRoutes } from "./simulation/index.js";
import { configureAuth } from "./auth.js";
import { MemorySessionStore, type SessionStore } from "./auth/sessions.js";
import { MemoryServiceTokenStore } from "./auth/service-tokens.js";
import { seedBootstrapToken } from "./auth/bootstrap.js";
import { MemoryOperatorDirectory, seedOperators } from "./auth/operators.js";
import { registerAuthRoutes, registerServiceTokenRoutes } from "./auth/routes.js";
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
  // The shared service layer behind both the HTTP API and the MCP server.
  const operations = new Operations({ store, hub, orchestrator });
  // Persist the GitHub connection in the same Store as the rest of the domain
  // (file for the desktop app, Postgres for hosted) — durable, no side-store.
  configureGithub(store);

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
  const operators = new MemoryOperatorDirectory(seedOperators());
  // Scoped API tokens for MCP / programmatic access. In-memory for now; a durable
  // adapter drops in behind ServiceTokenStore (same pattern as sessions) later.
  const serviceTokens = new MemoryServiceTokenStore();
  configureAuth({ sessions, serviceTokens });
  // Headless/sandbox deploys: register the agent-provided bootstrap token so it
  // can call /mcp without a human login (no-op unless SKYNET_BOOTSTRAP_TOKEN set).
  const bootstrap = await seedBootstrapToken(serviceTokens);

  const app = Fastify({ logger: { level: config.nodeEnv === "development" ? "info" : "warn" } });
  // Loud guardrail: an explicit AUTH_REQUIRED=false in production opens the API.
  if (config.nodeEnv === "production" && !config.authRequired) {
    app.log.warn("AUTH_REQUIRED=false in production — the API accepts UNAUTHENTICATED requests. Set AUTH_REQUIRED=true.");
  }
  await app.register(cors, { origin: true });
  await app.register(websocket);

  app.get("/health", async () => ({ ok: true, store: config.store, bus: config.bus, runner: "per-runner", sessions: config.sessions }));

  await registerAuthRoutes(app, { sessions, operators });
  await registerServiceTokenRoutes(app, { serviceTokens });
  await registerApi(app, { operations });
  // MCP endpoint (Streamable HTTP) — agents drive Skynet through the same
  // scoped-principal auth as the /api routes. stdio clients proxy to this too.
  await registerMcp(app, { operations, bus });
  // Workspace-scoped provider keys (encrypted at rest); /api auth hook applies.
  await registerSecretsRoutes(app);
  // GitHub App connection + safety policy (workspace-scoped); /api auth applies.
  await registerGithubRoutes(app);
  // LLM-judged acceptance evals (real runs via the standalone evals/ suite,
  // spawned as a subprocess); /api auth hook applies.
  await registerEvalsRoutes(app);
  // Behavioral LLM judge for Simulation journeys (in-process; /api auth applies).
  registerSimulationRoutes(app);
  await registerWs(app, { store, bus, hub });
  // W5 live preview: mount the sandboxed /preview route, stamp visual/previewUrl
  // onto already-stored agents, then warm their builds. No-op unless PREVIEW != off.
  await registerPreview(app, { store });
  const stamped = await backfillPreviews(store);
  if (stamped) app.log.info(`preview: stamped ${stamped} agent(s) with a live preview URL`);
  const queued = await kickoffPreviewBuilds(store);
  if (queued) app.log.info(`preview: queued ${queued} agent build(s)`);
  const servingSpa = await registerStatic(app);

  // Release "orphaned busy" runners — persisted busy but held by no live agent
  // (a restart leaves the store saying busy while the in-memory live map is
  // empty). Runs once at boot, before we listen, so nothing is mid-assign.
  await orchestrator.reconcileRunners().catch((err) => app.log.warn(`runner reconcile: ${(err as Error).message}`));

  // Reap presumed-dead agents (frees runners orphaned by a crash/restart). Run
  // once at boot to clear restart orphans, then on an interval. Bounded to a
  // sane minimum so it can't spin hot; disabled when agentReapMs <= 0.
  if (config.agentReapMs > 0) {
    const sweep = () =>
      orchestrator.reapStaleAgents().catch((err) => app.log.warn(`reaper: ${(err as Error).message}`));
    await sweep();
    const every = Math.max(30_000, Math.min(config.agentReapMs, 60_000));
    setInterval(sweep, every).unref();
  }

  await app.listen({ port: config.port, host: "0.0.0.0" });
  if (servingSpa) app.log.info("serving built web SPA from this server");
  if (bootstrap) {
    // Never log the secret itself — only what it was granted.
    app.log.info(`MCP bootstrap token registered — workspace=${bootstrap.workspaceId} scopes=[${bootstrap.scopes.join(", ")}] → POST /mcp`);
    if (bootstrap.dropped.length > 0) app.log.warn(`ignored unknown bootstrap scopes: ${bootstrap.dropped.join(", ")}`);
  }
  app.log.info(loadedEnvFrom ? `loaded env from ${loadedEnvFrom}` : "no .env file found (using process env only)");
  app.log.info(`Skynet server up on :${config.port}  (store=${config.store} bus=${config.bus} runner=per-runner sessions=${config.sessions})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
