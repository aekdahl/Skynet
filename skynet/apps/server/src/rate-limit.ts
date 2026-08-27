// ─── Rate limiting (in-memory, per-IP, fixed 1-minute window) ────────────────
// Blunts credential brute-force and request abuse on the guarded surface
// (/api + /mcp + /v1). Single-process / single-tenant, so an in-memory limiter
// is the right size — no Redis. It runs as the FIRST onRequest hook (before
// auth), so a flood is rejected before doing any work.
//
// - General cap (config.rateMax) applies to all /api + /mcp + /v1 requests.
// - Login (/api/auth/login) gets a much tighter cap (config.loginRateMax) so a
//   guessed-password attack is throttled hard.
// - Loopback is exempt ONLY in devMode (the trusted local desktop / test suites),
//   never in a hosted deploy — where a reverse proxy may itself be on loopback,
//   so set SKYNET_TRUST_PROXY=true to key on the real client IP.
// - SKYNET_RATE_MAX=0 disables it entirely.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";

const WINDOW_MS = 60_000;

type Bucket = { count: number; resetAt: number };

function isLoopback(ip: string | undefined): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

export function registerRateLimit(app: FastifyInstance): void {
  if (config.rateMax <= 0) {
    app.log.warn("rate limiting DISABLED (SKYNET_RATE_MAX=0)");
    return;
  }
  const buckets = new Map<string, Bucket>();

  // Opportunistic sweep so the map can't grow unbounded across many client IPs.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (now >= b.resetAt) buckets.delete(k);
  }, WINDOW_MS);
  sweep.unref?.();

  const take = (key: string, max: number, now: number): { ok: boolean; retryAfter: number } => {
    let b = buckets.get(key);
    if (!b || now >= b.resetAt) {
      b = { count: 0, resetAt: now + WINDOW_MS };
      buckets.set(key, b);
    }
    b.count += 1;
    return { ok: b.count <= max, retryAfter: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
  };

  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const url = req.url.toLowerCase();
    // Only the guarded surface — never the SPA, /health, or the WS upgrade.
    if (!(url.startsWith("/api") || url.startsWith("/mcp") || url.startsWith("/v1"))) return;
    // Trust the local desktop / test suites (loopback) — but only in dev/test.
    if (config.devMode && isLoopback(req.ip)) return;

    const isLogin = url.startsWith("/api/auth/login");
    const max = isLogin ? config.loginRateMax : config.rateMax;
    if (max <= 0) return;
    const { ok, retryAfter } = take(`${req.ip}:${isLogin ? "login" : "api"}`, max, Date.now());
    if (!ok) {
      return reply
        .code(429)
        .header("retry-after", String(retryAfter))
        .send({ error: "Too many requests — rate limited. Try again shortly." });
    }
  });
}
