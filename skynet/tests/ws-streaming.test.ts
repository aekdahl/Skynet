// WebSocket gateway (apps/server/src/ws.ts) — the live-update backbone. The
// fixture (apps/server/tests/ws-fixture.ts) boots a real Fastify server with
// @fastify/websocket + registerWs over an in-memory Store + in-process Bus (+
// Hub) on an ephemeral port; this spec drives it with the `ws` client to pin
// the connect → snapshot → forward-deltas contract:
//   1. a valid ?token= receives a connect-time `snapshot` for its workspace
//   2. a bus publish for that workspace is forwarded down the socket as a delta
//   3. a publish for a DIFFERENT workspace is NOT delivered (isolation)
//   4. an absent/bad token is rejected (socket closed 1008, no snapshot)
//
// The fixture lives under apps/server/tests/ (not src/) so its fastify / ws
// imports resolve from apps/server/node_modules — the root tests/ dir can't.
//
// The fixture also sets AUTH_REQUIRED=true (via its first import, ws-env-setup)
// before config.ts loads, which makes the rejection cases (4, 4b) deterministic:
// without the guard the dev/test env falls back to an open default principal and
// every connection would get a snapshot. Dev tokens (dev-cyberdyne /
// dev-resistance) resolve regardless of AUTH_REQUIRED and only outside
// production, so the accept cases stay valid. NODE_ENV is left unset (→
// "development"), which we assert below.

import { afterEach, beforeAll, describe, it, expect } from "vitest";
import type { Runner, WsMessage } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { bootWsServer, WebSocket, type Fixture } from "../apps/server/tests/ws-fixture.js";

// A dev token that resolves to the "cyberdyne" workspace, and one for a second,
// isolated workspace so we can prove cross-workspace deltas don't leak.
const TOKEN_CYBERDYNE = "dev-cyberdyne";
const TOKEN_RESISTANCE = "dev-resistance";
const OTHER_WORKSPACE = "resistance";

// ── a buffering client so no message can be missed ─────────────────────────
// The server sends the snapshot the instant the socket opens, so a listener
// attached only after `await open` would race and miss it. TestClient buffers
// every message from the moment it's constructed; awaiters drain the buffer or
// park until the next arrival. This keeps every assertion deterministic without
// arbitrary sleeps.
class TestClient {
  readonly ws: WebSocket;
  private readonly buffer: WsMessage[] = [];
  private waiters: Array<() => void> = [];
  closedCode: number | null = null;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on("message", (data: unknown) => {
      this.buffer.push(JSON.parse(String(data)) as WsMessage);
      this.flush();
    });
    this.ws.on("close", (code: number) => {
      this.closedCode = code;
      this.flush();
    });
  }

  private flush() {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  /** Resolve once the socket is OPEN, else reject on close/error/timeout. */
  open(timeoutMs = 2000): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === this.ws.OPEN) return resolve();
      const timer = setTimeout(() => reject(new Error("timed out waiting for open")), timeoutMs);
      this.ws.once("open", () => { clearTimeout(timer); resolve(); });
      this.ws.once("error", (err) => { clearTimeout(timer); reject(err); });
      this.ws.once("close", (code) => { clearTimeout(timer); reject(new Error(`closed before open (code ${code})`)); });
    });
  }

  /** Resolve with the next buffered/incoming message matching `match`. */
  next(match: (m: WsMessage) => boolean = () => true, timeoutMs = 2000): Promise<WsMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { detach(); reject(new Error("timed out waiting for message")); }, timeoutMs);
      const detach = () => { clearTimeout(timer); this.waiters = this.waiters.filter((w) => w !== attempt); };
      const attempt = () => {
        const idx = this.buffer.findIndex(match);
        if (idx >= 0) { detach(); resolve(this.buffer.splice(idx, 1)[0]); return; }
        if (this.closedCode !== null) { detach(); reject(new Error(`closed while waiting (code ${this.closedCode})`)); return; }
        this.waiters.push(attempt);
      };
      attempt();
    });
  }

  /** Resolve with the close code, or reject if the socket stays open. */
  waitClose(timeoutMs = 2000): Promise<number> {
    return new Promise((resolve, reject) => {
      if (this.closedCode !== null) return resolve(this.closedCode);
      const timer = setTimeout(() => reject(new Error("timed out waiting for close")), timeoutMs);
      this.ws.once("close", (code) => { clearTimeout(timer); resolve(code); });
    });
  }

  /** Reject if any message arrives within the window; resolve if none does.
   *  Considers already-buffered messages too, so it can't miss an early one. */
  expectNone(windowMs = 300): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.buffer.length > 0) return reject(new Error(`unexpected message: ${JSON.stringify(this.buffer[0])}`));
      const timer = setTimeout(() => { this.waiters = this.waiters.filter((w) => w !== attempt); resolve(); }, windowMs);
      const attempt = () => {
        if (this.buffer.length > 0) { clearTimeout(timer); reject(new Error(`unexpected message: ${JSON.stringify(this.buffer[0])}`)); }
      };
      this.waiters.push(attempt);
    });
  }

  terminate() {
    if (this.ws.readyState === this.ws.OPEN || this.ws.readyState === this.ws.CONNECTING) this.ws.terminate();
  }
}

const runner = (id: string, workspaceId: string): Runner => ({
  id, workspaceId, name: id, provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0,
});

let fixture: Fixture;
const clients: TestClient[] = [];

/** Open a client socket, tracked for teardown. */
function connect(token?: string): TestClient {
  const url = token ? `${fixture.url}?token=${token}` : fixture.url;
  const client = new TestClient(url);
  clients.push(client);
  return client;
}

beforeAll(() => {
  // Dev tokens resolve only outside production; pin that the test env qualifies.
  expect(process.env.NODE_ENV).not.toBe("production");
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.terminate();
  if (fixture) await fixture.close();
});

describe("WebSocket gateway: snapshot + delta streaming + isolation", () => {
  it("1. a valid token receives a connect-time snapshot for its workspace", async () => {
    fixture = await bootWsServer();
    const c = connect(TOKEN_CYBERDYNE);
    await c.open();

    const msg = await c.next((m) => m.type === "snapshot");
    expect(msg.type).toBe("snapshot");
    if (msg.type !== "snapshot") throw new Error("unreachable");
    // A snapshot carries the workspace's collections; a fresh store is empty but
    // always has the live provider catalog stamped on.
    expect(Array.isArray(msg.state.agents)).toBe(true);
    expect(Array.isArray(msg.state.providers)).toBe(true);
    expect(msg.state.providers.length).toBeGreaterThan(0);
  });

  it("2. a bus publish for this workspace is forwarded to the socket as a delta", async () => {
    fixture = await bootWsServer();
    const c = connect(TOKEN_CYBERDYNE);
    await c.open();
    await c.next((m) => m.type === "snapshot"); // consume the snapshot first

    fixture.bus.publish(DEFAULT_WORKSPACE, { type: "runner.upserted", runner: runner("r1", DEFAULT_WORKSPACE) });
    const msg = await c.next((m) => m.type === "runner.upserted");
    expect(msg.type).toBe("runner.upserted");
    if (msg.type !== "runner.upserted") throw new Error("unreachable");
    expect(msg.runner.id).toBe("r1");
  });

  it("3. a publish for a DIFFERENT workspace is NOT delivered (isolation)", async () => {
    fixture = await bootWsServer();
    const c = connect(TOKEN_CYBERDYNE);
    await c.open();
    await c.next((m) => m.type === "snapshot"); // consume the snapshot

    // A delta for the OTHER workspace must not reach this cyberdyne socket...
    fixture.bus.publish(OTHER_WORKSPACE, { type: "runner.upserted", runner: runner("other", OTHER_WORKSPACE) });
    await c.expectNone();

    // ...but this workspace's own delta still flows, proving the socket is live
    // and it was isolation, not a dead connection, that dropped the first one.
    fixture.bus.publish(DEFAULT_WORKSPACE, { type: "runner.upserted", runner: runner("mine", DEFAULT_WORKSPACE) });
    const msg = await c.next((m) => m.type === "runner.upserted");
    if (msg.type !== "runner.upserted") throw new Error("unreachable");
    expect(msg.runner.id).toBe("mine");
  });

  it("3b. a second workspace's socket sees only its own deltas", async () => {
    fixture = await bootWsServer();
    const c = connect(TOKEN_RESISTANCE);
    await c.open();
    await c.next((m) => m.type === "snapshot"); // consume the snapshot

    // A cyberdyne delta must not reach the resistance socket.
    fixture.bus.publish(DEFAULT_WORKSPACE, { type: "runner.upserted", runner: runner("cyb", DEFAULT_WORKSPACE) });
    await c.expectNone();

    fixture.bus.publish(OTHER_WORKSPACE, { type: "runner.upserted", runner: runner("res", OTHER_WORKSPACE) });
    const msg = await c.next((m) => m.type === "runner.upserted");
    if (msg.type !== "runner.upserted") throw new Error("unreachable");
    expect(msg.runner.id).toBe("res");
  });

  it("4. connecting without a token is rejected (closed 1008, no snapshot)", async () => {
    fixture = await bootWsServer();
    const c = connect(); // no ?token=
    const noSnapshot = c.expectNone(500);
    const code = await c.waitClose();
    expect(code).toBe(1008);
    await noSnapshot; // resolves iff no message arrived before the close
  });

  it("4b. connecting with a bad token is rejected (closed 1008, no snapshot)", async () => {
    fixture = await bootWsServer();
    const c = connect("not-a-real-token");
    const noSnapshot = c.expectNone(500);
    const code = await c.waitClose();
    expect(code).toBe(1008);
    await noSnapshot;
  });
});
