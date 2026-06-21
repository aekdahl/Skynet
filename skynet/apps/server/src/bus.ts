// ─── Event bus ────────────────────────────────────────────────────────────
// Fan-out backbone. Phase 0 is an in-process EventEmitter; swapping in a Redis
// pub/sub implementation behind this interface lets events fan out across
// multiple app replicas (Architecture Brief §06) without touching callers.

import { EventEmitter } from "node:events";
import type { ServerEvent } from "@skynet/shared";

export interface Bus {
  /** Publish a delta to one workspace's channel. */
  publish(workspaceId: string, event: ServerEvent): void;
  /** Subscribe to one workspace's channel; returns an unsubscribe fn. */
  subscribe(workspaceId: string, handler: (event: ServerEvent) => void): () => void;
}

export class InProcessBus implements Bus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0); // one listener per connected socket
  }

  private channel(workspaceId: string) {
    return `event:${workspaceId}`;
  }

  publish(workspaceId: string, event: ServerEvent): void {
    this.emitter.emit(this.channel(workspaceId), event);
  }

  subscribe(workspaceId: string, handler: (event: ServerEvent) => void): () => void {
    const ch = this.channel(workspaceId);
    this.emitter.on(ch, handler);
    return () => this.emitter.off(ch, handler);
  }
}
