// ─── Auth (pluggable: dev tokens + sessions/SSO) ──────────────────────────
// Maps a bearer token, ?token=, or session cookie to a Principal
// { workspaceId, operatorId }. Resolution order:
//   1. dev token map  — DEV ONLY (never resolves in production)
//   2. session store   — tokens issued by real login (W6, see auth/)
//   3. AUTH_REQUIRED   — off → fall back to the dev default (DEV ONLY);
//                        on  → unknown/expired resolves to undefined → 401.
// In production the dev tokens and the open default are BOTH disabled: only a
// real session passes. Combined with AUTH_REQUIRED defaulting on in production
// (config.ts), a prod deploy never silently accepts unauthenticated requests.
// The session store is injected via configureAuth() so this module stays free
// of a hard dependency on any particular backend (memory/Redis/Postgres).

import type { FastifyRequest } from "fastify";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { config } from "./config.js";
import type { SessionStore } from "./auth/sessions.js";
import type { ServiceTokenStore } from "./auth/service-tokens.js";

/**
 * Capability scopes carried by a service token (MCP / API access). Human logins
 * carry no scopes (`Principal.scopes` undefined) and are treated as full
 * authority; a service token narrows what an automated caller may do:
 *  • observe  — reads (snapshot, lists, get)
 *  • author   — create/assign/fork/chat/stop/archive, configure fleet runners
 *  • approver — resolve HITL items (approve/reject/modify diffs, answer, gate push)
 *  • admin    — mint/revoke tokens and other privileged ops (never granted to MCP)
 */
export const SCOPES = ["observe", "author", "approver", "admin"] as const;
export type Scope = (typeof SCOPES)[number];

export interface Principal {
  workspaceId: string;
  operatorId: string;
  // Undefined = full authority (human sessions, dev tokens). A service token
  // carries an explicit subset; scope-gated call sites check these before acting.
  scopes?: Scope[];
}

/** True if the principal may exercise `scope`. Humans (no scopes) always may. */
export function hasScope(principal: Principal, scope: Scope): boolean {
  return principal.scopes === undefined || principal.scopes.includes(scope);
}

// Dev tokens — two workspaces so isolation is demonstrable. These resolve
// regardless of AUTH_REQUIRED so the local flow and tests keep working.
const TOKENS: Record<string, Principal> = {
  "dev-cyberdyne": { workspaceId: DEFAULT_WORKSPACE, operatorId: "jordan" },
  "dev-resistance": { workspaceId: "resistance", operatorId: "kyle" },
};

const DEV_DEFAULT: Principal = { workspaceId: DEFAULT_WORKSPACE, operatorId: "operator" };

/** Dev conveniences (token map + open default) are disabled in production. */
const devAuthAllowed = (): boolean => config.nodeEnv !== "production";

/** Cookie that carries a session token (set by the login route). */
export const SESSION_COOKIE = "skynet_session";

// Injected backends (real login tokens + service/API tokens). Absent until
// configureAuth runs.
let sessions: SessionStore | undefined;
let serviceTokens: ServiceTokenStore | undefined;

/** Wire the auth backends (called once at bootstrap). */
export function configureAuth(opts: { sessions?: SessionStore; serviceTokens?: ServiceTokenStore }): void {
  sessions = opts.sessions;
  serviceTokens = opts.serviceTokens;
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
  const dev = devAuthAllowed();
  if (token) {
    if (dev && TOKENS[token]) return TOKENS[token]; // dev tokens never resolve in prod
    const fromSession = await sessions?.resolve(token);
    if (fromSession) return fromSession;
    // Service/API tokens (MCP + programmatic access). Real credentials, so they
    // resolve in production too — unlike the dev conveniences above.
    const fromServiceToken = await serviceTokens?.resolve(token);
    if (fromServiceToken) return fromServiceToken;
  }
  // Fail closed unless dev explicitly allows the open default. In production this
  // is never reached as open (authRequired defaults on; dev=false here anyway).
  if (config.authRequired || !dev) return undefined;
  return DEV_DEFAULT;
}

/** Resolve a principal from a request (header → query → cookie). */
export async function authenticate(req: FastifyRequest): Promise<Principal | undefined> {
  const queryToken = (req.query as { token?: string } | undefined)?.token;
  const token = tokenFrom(req.headers.authorization, queryToken) ?? cookieToken(req.headers.cookie);
  return resolvePrincipal(token);
}
