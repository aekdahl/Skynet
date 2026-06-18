// ─── WebSocket gateway ────────────────────────────────────────────────────
// On connect: resolve the operator's workspace from a ?token=, send a snapshot
// of THAT workspace, then forward only that workspace's bus deltas. (Backend
// Brief §07, Architecture Brief §06.) Replaces the prototype's two sim loops.

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import type { WsMessage } from "@skynet/shared";
import { authenticate } from "./auth.js";
import type { Bus } from "./bus.js";
import type { Store } from "./store/store.js";

export interface WsDeps {
  store: Store;
  bus: Bus;
}

export async function registerWs(app: FastifyInstance, deps: WsDeps): Promise<void> {
  const { store, bus } = deps;

  app.get("/ws", { websocket: true }, async (socket: WebSocket, req: FastifyRequest) => {
    const principal = authenticate(req);
    if (!principal) {
      socket.close(1008, "Unauthorized");
      return;
    }
    const ws = principal.workspaceId;

    const send = (msg: WsMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };

    // 1. connect-time snapshot of this workspace
    send({ type: "snapshot", state: await store.snapshot(ws) });

    // 2. forward this workspace's deltas for the life of the connection
    const unsubscribe = bus.subscribe(ws, (event) => send(event));
    socket.on("close", unsubscribe);
    socket.on("error", unsubscribe);
  });
}
