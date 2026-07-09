// Test-only fixture for the WebSocket gateway suite (tests/ws-streaming.test.ts).
//
// It lives under apps/server/tests/ — NOT src/ — for one reason: fastify,
// @fastify/websocket and the `ws` client are dependencies of @skynet/server,
// installed in apps/server/node_modules. Vite/Vitest resolves bare imports by
// walking up from the importing file, so a file here resolves them, whereas the
// root tests/ directory (where the spec lives) cannot. The spec imports this
// module instead of importing fastify/ws directly. This file is outside the
// package's tsconfig `include` ("src/**/*"), so it never enters the tsc build
// or `pnpm -r typecheck`.

import "./ws-env-setup.js"; // MUST be first — sets AUTH_REQUIRED before config.ts loads
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { registerWs } from "../src/ws.js";
import { InProcessBus } from "../src/bus.js";
import { Hub } from "../src/hub.js";
import { MemoryStore } from "../src/store/memory.js";

// Re-export the `ws` client so the spec never has to resolve it from the root.
export { WebSocket };

export interface Fixture {
  bus: InProcessBus;
  /** ws://127.0.0.1:<port>/ws */
  url: string;
  close(): Promise<void>;
}

/** Boot a real Fastify server with @fastify/websocket + registerWs over an
 *  in-memory Store + in-process Bus (+ Hub), on an ephemeral port. */
export async function bootWsServer(): Promise<Fixture> {
  const store = new MemoryStore();
  const bus = new InProcessBus();
  const hub = new Hub(store, bus);
  const app = Fastify({ logger: false });
  await app.register(websocket);
  await registerWs(app, { store, bus, hub });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  return {
    bus,
    url: `ws://127.0.0.1:${port}/ws`,
    close: () => app.close(),
  };
}
