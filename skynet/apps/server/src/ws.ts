// ─── WebSocket gateway ────────────────────────────────────────────────────
// On connect: resolve the operator's workspace from a ?token=, send a snapshot
// of THAT workspace, then forward only that workspace's bus deltas. (Backend
// Brief §07, Architecture Brief §06.) Replaces the prototype's two sim loops.

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import type { WsMessage } from "@skynet/shared";
import { authenticate } from "./auth.js";
import { config } from "./config.js";
import { withSecretAvailability } from "./secrets/index.js";
import type { Bus } from "./bus.js";
import type { Hub } from "./hub.js";
import type { Store } from "./store/store.js";

export interface WsDeps {
  store: Store;
  bus: Bus;
  hub: Hub;
}

export async function registerWs(app: FastifyInstance, deps: WsDeps): Promise<void> {
  const { store, bus, hub } = deps;

  app.get("/ws", { websocket: true }, async (socket: WebSocket, req: FastifyRequest) => {
    // WS upgrade can't carry an Authorization header, so the ?token= query
    // param is accepted here (and only here — REST rejects it, DEF-006).
    const principal = await authenticate(req, { allowQueryToken: true });
    if (!principal) {
      socket.close(1008, "Unauthorized");
      return;
    }
    const ws = principal.workspaceId;

    const send = (msg: WsMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };

    // 1. connect-time snapshot of this workspace (with live provider availability)
    const snap = await store.snapshot(ws);
    snap.providers = await withSecretAvailability(snap.providers, ws);
    snap.defaultApprovalLevel = config.defaultApprovalLevel;
    send({ type: "snapshot", state: snap });

    // 2. forward this workspace's deltas for the life of the connection
    const unsubscribe = bus.subscribe(ws, (event) => send(event));
    socket.on("close", unsubscribe);
    socket.on("error", unsubscribe);

    // 3. compute current conflicts now that the socket is listening (W4)
    void hub.refreshConflicts(ws);
  });
}
