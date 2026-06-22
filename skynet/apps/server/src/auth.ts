// ─── Auth (pluggable: dev tokens + sessions/SSO) ──────────────────────────
// Maps a bearer token, ?token=, or session cookie to a Principal
// { workspaceId, operatorId }. Resolution order:
//   1. dev token map  — always on, for local dev + tests
//   2. session store   — tokens issued by real login (W6, see auth/)
//   3. AUTH_REQUIRED   — off → fall back to the dev default (open local flow);
//                        on  → unknown/expired resolves to undefined → 401.
// The session store is injected via configureAuth() so this module stays free
// of a hard dependency on any particular backend (memory/Redis/Postgres).

import type { FastifyRequest } from "fastify";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { config } from "./config.js";
import type { SessionStore } from "./auth/sessions.js";

export interface Principal {
  workspaceId: string;
  operatorId: string;
}

// Dev tokens — two workspaces so isolation is demonstrable. These resolve
// regardless of AUTH_REQUIRED so the local flow and tests keep working.
const TOKENS: Record<string, Principal> = {
  "dev-cyberdyne": { workspaceId: DEFAULT_WORKSPACE, operatorId: "jordan" },
  "dev-resistance": { workspaceId: "resistance", operatorId: "kyle" },
};

const DEV_DEFAULT: Principal = { workspaceId: DEFAULT_WORKSPACE, operatorId: "operator" };

/** Cookie that carries a session token (set by the login route). */
export const SESSION_COOKIE = "skynet_session";

// Injected session backend (real login tokens). Absent until configureAuth runs.
let sessions: SessionStore | undefined;

/** Wire the session backend (called once at bootstrap). */
export function configureAuth(opts: { sessions?: SessionStore }): void {
  sessions = opts.sessions;
}

/** Extract a token from an Authorization header or a ?token= query value. */
export function tokenFrom(authHeader?: string, queryToken?: string): string | undefined {
  if (queryToken) return queryToken;
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7).trim();
  return undefined;
}

/** Pull the session token out of a Cookie header (no cookie plugin needed). */
export function cookieToken(cookieHeader?: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

/**
 * Resolve a principal from a token. Dev tokens first, then live sessions; when
 * AUTH_REQUIRED is off an absent/unknown/expired token falls back to the dev
 * default (keeps local dev open). When on, only a valid token/session passes.
 */
export async function resolvePrincipal(token?: string): Promise<Principal | undefined> {
  if (token) {
    if (TOKENS[token]) return TOKENS[token];
    const fromSession = await sessions?.resolve(token);
    if (fromSession) return fromSession;
  }
  if (config.authRequired) return undefined;
  return DEV_DEFAULT;
}

/** Resolve a principal from a request (header → query → cookie). */
export async function authenticate(req: FastifyRequest): Promise<Principal | undefined> {
  const queryToken = (req.query as { token?: string } | undefined)?.token;
  const token = tokenFrom(req.headers.authorization, queryToken) ?? cookieToken(req.headers.cookie);
  return resolvePrincipal(token);
}
