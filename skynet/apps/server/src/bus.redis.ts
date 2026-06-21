// ─── Redis event bus ───────────────────────────────────────────────────────
// Cross-replica fan-out backbone (Architecture Brief §06). Mirrors InProcessBus
// (bus.ts) behind the same Bus interface, but publishes each workspace's deltas
// onto a Redis pub/sub channel (`event:<workspaceId>`) so that every app replica
// subscribed to that channel forwards the delta to its own connected sockets.
// Selected via BUS=redis; the in-process bus stays the default. Drops in behind
// the Bus interface — Hub / WS gateway are unchanged.
//
// Bridging note: the Bus interface is synchronous (publish/subscribe return
// immediately) while Redis I/O is async. We keep the contract by:
//   • publish — fire-and-forget the PUBLISH; surface failures via onError.
//   • subscribe — register the handler on a local EventEmitter synchronously and
//     ref-count Redis SUBSCRIBE per channel, so N sockets watching one workspace
//     share a single Redis subscription and the unsubscribe fn is immediate.
// Redis requires a dedicated connection for subscriber mode, so we keep one
// client for publishing and a duplicate for subscribing.

import { EventEmitter } from "node:events";
import { createClient, type RedisClientType } from "redis";
import type { ServerEvent } from "@skynet/shared";
import type { Bus } from "./bus.js";

export class RedisBus implements Bus {
  // Local fan-out: one Redis SUBSCRIBE per channel feeds every socket handler.
  private emitter = new EventEmitter();
  // Channels with a live Redis SUBSCRIBE, by local subscriber count.
  private refs = new Map<string, number>();

  private constructor(
    private pub: RedisClientType,
    private sub: RedisClientType,
  ) {
    this.emitter.setMaxListeners(0); // one listener per connected socket
  }

  /** Connect a publisher + subscriber pair and return a ready bus. */
  static async create(url: string): Promise<RedisBus> {
    const pub: RedisClientType = createClient(url ? { url } : {});
    const sub: RedisClientType = pub.duplicate(); // subscriber mode needs its own connection
    // Keep connection errors from crashing the process; reconnection is automatic.
    pub.on("error", (err) => console.error("[redis-bus] publisher error:", err));
    sub.on("error", (err) => console.error("[redis-bus] subscriber error:", err));
    await Promise.all([pub.connect(), sub.connect()]);
    return new RedisBus(pub, sub);
  }

  private channel(workspaceId: string): string {
    return `event:${workspaceId}`;
  }

  publish(workspaceId: string, event: ServerEvent): void {
    // Fire-and-forget: the Bus contract is synchronous. PUBLISH reaches every
    // replica subscribed to this channel (including this one).
    this.pub.publish(this.channel(workspaceId), JSON.stringify(event)).catch((err) => {
      console.error("[redis-bus] publish failed:", err);
    });
  }

  subscribe(workspaceId: string, handler: (event: ServerEvent) => void): () => void {
    const ch = this.channel(workspaceId);
    this.emitter.on(ch, handler);

    // First local listener for this channel → open the Redis SUBSCRIBE.
    const count = this.refs.get(ch) ?? 0;
    this.refs.set(ch, count + 1);
    if (count === 0) {
      this.sub
        .subscribe(ch, (message) => this.dispatch(ch, message))
        .catch((err) => console.error(`[redis-bus] subscribe ${ch} failed:`, err));
    }

    let active = true;
    return () => {
      if (!active) return; // unsubscribe is idempotent
      active = false;
      this.emitter.off(ch, handler);
      const remaining = (this.refs.get(ch) ?? 1) - 1;
      if (remaining <= 0) {
        this.refs.delete(ch);
        // Last local listener gone → drop the Redis SUBSCRIBE.
        this.sub.unsubscribe(ch).catch((err) => console.error(`[redis-bus] unsubscribe ${ch} failed:`, err));
      } else {
        this.refs.set(ch, remaining);
      }
    };
  }

  /** Parse a Redis message and fan it out to this replica's local handlers. */
  private dispatch(ch: string, message: string): void {
    let event: ServerEvent;
    try {
      event = JSON.parse(message) as ServerEvent;
    } catch (err) {
      console.error(`[redis-bus] dropping malformed message on ${ch}:`, err);
      return;
    }
    this.emitter.emit(ch, event);
  }

  /** Graceful shutdown — close both connections. */
  async close(): Promise<void> {
    await Promise.allSettled([this.pub.quit(), this.sub.quit()]);
  }
}
