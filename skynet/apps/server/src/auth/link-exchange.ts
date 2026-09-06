// ─── Chat → canvas handoff: hosted signed-token exchange ───────────────────
// The desktop app's `skynet://` deep link (apps/desktop/deep-link.cjs) needs
// no token — it's already running locally as the single operator. A hosted
// deploy has no such luxury: a Telegram notification tapped from a phone
// that isn't already logged in is the one case that genuinely needs to
// establish a session from a cold click. This module mints the short-lived,
// single-use token that makes that possible; `../auth/routes.ts`'s
// `GET /handoff/:token` consumes it and issues a real session.
//
// Security framing: Telegram delivery to the owner's own configured chat is
// the SAME out-of-band channel `mfa.ts` already uses to deliver its OTP —
// receiving a message there already proves "I have the owner's Telegram,"
// which is the second factor. Combined with a single-use, cryptographically
// random token (192 bits), this is a defensible magic-link pattern, not a
// bypass of the real control.
//
// Shape mirrors `mfa.ts`'s challenge Map (short-lived, single-use, in-memory)
// rather than inventing a new pattern. KNOWN LIMITATION, same as mfa.ts's own
// `challenges` Map: in-memory, single-node. A multi-replica hosted deploy
// (ROADMAP.md's separate, unstarted "Redis multi-replica fan-out" item) would
// need this promoted to a shared store first — not solved here.

import { randomBytes } from "node:crypto";
import type { Principal } from "../auth.js";
import { config, now } from "../config.js";

interface Exchange {
  principal: Principal;
  hash: string; // target hash route, e.g. "#/agent/r-123"
  expiresAt: number;
}

const exchanges = new Map<string, Exchange>();

/** Mint a one-time token that exchanges for a real session landing the
 *  browser on `hash`. `hash` is opaque here (already `#/...`-shaped) so any
 *  future caller (a project link, a fleet link) can reuse this unchanged. */
export function createLinkExchange(principal: Principal, hash: string): string {
  const token = randomBytes(24).toString("base64url");
  exchanges.set(token, { principal, hash, expiresAt: now() + config.handoffTtlMs });
  return token;
}

/** Single-use: deletes on lookup regardless of outcome, so a leaked/re-shared
 *  link can never be replayed even within its TTL window. Undefined for a
 *  missing, already-consumed, or expired token. */
export function consumeLinkExchange(token: string): { principal: Principal; hash: string } | undefined {
  const e = exchanges.get(token);
  if (!e) return undefined;
  exchanges.delete(token);
  if (now() > e.expiresAt) return undefined;
  return { principal: e.principal, hash: e.hash };
}
