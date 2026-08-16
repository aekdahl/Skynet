// ─── Redis session store ──────────────────────────────────────────────────
// Multi-replica sessions: every app replica pointing at the same Redis resolves
// the same tokens, and expiry is handled natively by a per-key TTL (no sweep).
// Connects lazily so it can be constructed synchronously from config. Drops in
// behind SessionStore. Uses the same `redis` client as the Redis bus (W1).

import { createClient, type RedisClientType } from "redis";
import { now } from "../config.js";
import type { Principal } from "../auth.js";
import { newSession, type Session, type SessionStore } from "./sessions.js";

const keyFor = (token: string) => `sess:${token}`;
// A companion key rather than folding elevatedUntil into the principal blob
// above: Redis's native per-key TTL already gives the bounded window for
// free (no manual timestamp comparison needed on read), and the session's
// own value/TTL are untouched — elevating never re-serializes or re-times
// the base session.
const elevKeyFor = (token: string) => `sess:elev:${token}`;

export class RedisSessionStore implements SessionStore {
  private ready?: Promise<RedisClientType>;

  constructor(private url: string) {}

  private async client(): Promise<RedisClientType> {
    if (!this.ready) {
      this.ready = (async () => {
        const client: RedisClientType = createClient(this.url ? { url: this.url } : {});
        client.on("error", (err) => console.error("[redis-sessions] error:", err));
        await client.connect();
        return client;
      })();
    }
    return this.ready;
  }

  async create(principal: Principal, ttlMs: number): Promise<Session> {
    const session = newSession(principal, ttlMs);
    const client = await this.client();
    // PX = TTL in ms; Redis drops the key when it lapses (mirrors expiresAt).
    await client.set(keyFor(session.token), JSON.stringify(principal), { PX: ttlMs });
    return session;
  }

  async resolve(token: string): Promise<Principal | undefined> {
    const client = await this.client();
    const raw = await client.get(keyFor(token));
    if (!raw) return undefined; // missing or already expired by Redis
    let principal: Principal;
    try {
      principal = JSON.parse(raw) as Principal;
    } catch {
      return undefined;
    }
    const elevRaw = await client.get(elevKeyFor(token));
    if (elevRaw) return { ...principal, scopes: undefined, elevatedUntil: Number(elevRaw) };
    return principal;
  }

  async elevate(token: string, ttlMs: number): Promise<{ expiresAt: number } | undefined> {
    const client = await this.client();
    const raw = await client.get(keyFor(token));
    if (!raw) return undefined; // session missing/expired — nothing to elevate
    const expiresAt = now() + ttlMs;
    // The VALUE is the absolute expiresAt (for the caller/countdown UI); the
    // key's own PX is what actually enforces the window server-side.
    await client.set(elevKeyFor(token), String(expiresAt), { PX: ttlMs });
    return { expiresAt };
  }

  async destroy(token: string): Promise<void> {
    const client = await this.client();
    await client.del(keyFor(token));
    await client.del(elevKeyFor(token)); // harmless no-op if never elevated
  }
}
