// ─── Skynet server bootstrap ───────────────────────────────────────────────
// API + WebSocket gateway + orchestrator in one process (Architecture Brief
// §03/§08). Phase 0: in-memory store, in-process bus, mock runner.

import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { config } from "./config.js";
import { InProcessBus } from "./bus.js";
import type { Bus } from "./bus.js";
import { Hub } from "./hub.js";
import { Orchestrator } from "./orchestrator.js";
import { registerApi } from "./api.js";
import { registerWs } from "./ws.js";
import { registerStatic } from "./static.js";
import { registerPreview, backfillPreviews, kickoffPreviewBuilds } from "./preview/index.js";
import { registerSecretsRoutes } from "./secrets/index.js";
import { configureAuth } from "./auth.js";
import { MemorySessionStore, type SessionStore } from "./auth/sessions.js";
import { MemoryOperatorDirectory, seedOperators } from "./auth/operators.js";
import { registerAuthRoutes } from "./auth/routes.js";
import { MemoryStore } from "./store/memory.js";
import type { Store } from "./store/store.js";

async function main() {
  let store: Store;
  if (config.store === "postgres") {
    const { PostgresStore } = await import("./store/postgres.js");
    store = await PostgresStore.create(config.databaseUrl, config.seedDemo);
  } else {
    store = new MemoryStore({ seed: config.seedDemo });
  }
  let bus: Bus;
  if (config.bus === "redis") {
    const { RedisBus } = await import("./bus.redis.js");
    bus = await RedisBus.create(config.redisUrl);
  } else {
    bus = new InProcessBus();
  }
  const hub = new Hub(store, bus);
  const orchestrator = new Orchestrator(store, hub);

  // Auth: dev tokens always resolve; real login issues sessions (W6). The
  // session backend is durable (Postgres) or multi-replica (Redis) when
  // selected, else in-memory. Adapters connect lazily, so no await here.
  let sessions: SessionStore;
  if (config.sessions === "postgres") {
    const { PostgresSessionStore } = await import("./auth/sessions.postgres.js");
    sessions = new PostgresSessionStore(config.databaseUrl);
  } else if (config.sessions === "redis") {
    const { RedisSessionStore } = await import("./auth/sessions.redis.js");
    sessions = new RedisSessionStore(config.redisUrl);
  } else {
    sessions = new MemorySessionStore();
  }
  const operators = new MemoryOperatorDirectory(seedOperators());
  configureAuth({ sessions });

  const app = Fastify({ logger: { level: config.nodeEnv === "development" ? "info" : "warn" } });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  app.get("/health", async () => ({ ok: true, store: config.store, bus: config.bus, runner: config.runner, sessions: config.sessions }));

  await registerAuthRoutes(app, { sessions, operators });
  await registerApi(app, { store, hub, orchestrator });
  // Workspace-scoped provider keys (encrypted at rest); /api auth hook applies.
  await registerSecretsRoutes(app);
  await registerWs(app, { store, bus, hub });
  // W5 live preview: mount the sandboxed /preview route, stamp visual/previewUrl
  // onto already-stored agents, then warm their builds. No-op unless PREVIEW != off.
  await registerPreview(app, { store });
  const stamped = await backfillPreviews(store);
  if (stamped) app.log.info(`preview: stamped ${stamped} agent(s) with a live preview URL`);
  const queued = await kickoffPreviewBuilds(store);
  if (queued) app.log.info(`preview: queued ${queued} agent build(s)`);
  const servingSpa = await registerStatic(app);

  await app.listen({ port: config.port, host: "0.0.0.0" });
  if (servingSpa) app.log.info("serving built web SPA from this server");
  app.log.info(`Skynet server up on :${config.port}  (store=${config.store} bus=${config.bus} runner=${config.runner} sessions=${config.sessions})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
