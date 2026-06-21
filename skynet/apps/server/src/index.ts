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
import { MemoryStore } from "./store/memory.js";
import type { Store } from "./store/store.js";

async function main() {
  let store: Store;
  if (config.store === "postgres") {
    const { PostgresStore } = await import("./store/postgres.js");
    store = await PostgresStore.create(config.databaseUrl);
  } else {
    store = new MemoryStore();
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

  const app = Fastify({ logger: { level: config.nodeEnv === "development" ? "info" : "warn" } });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  app.get("/health", async () => ({ ok: true, store: config.store, bus: config.bus, runner: config.runner }));

  await registerApi(app, { store, hub, orchestrator });
  await registerWs(app, { store, bus });
  const servingSpa = await registerStatic(app);

  await app.listen({ port: config.port, host: "0.0.0.0" });
  if (servingSpa) app.log.info("serving built web SPA from this server");
  app.log.info(`Skynet server up on :${config.port}  (store=${config.store} bus=${config.bus} runner=${config.runner})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
