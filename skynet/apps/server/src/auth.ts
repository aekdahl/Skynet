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
import type { ElevationStore } from "./auth/elevations.js";

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
  // Undefined = every project in the workspace (the default — humans, unscoped
  // tokens). A non-empty allowlist narrows the token to just these projects:
  // the MCP layer both gates mutations to them and filters reads down to them,
  // so a project-scoped token can neither touch nor see other projects' work.
  // Mirrors the `scopes` capability model, but on the project axis.
  projectIds?: string[];
  // Set ONLY by resolvePrincipal() below while an admin-granted, time-limited
  // promotion (ROADMAP.md) is active for this operator — the moment this
  // timestamp passes, resolution reverts to the base (stored session)
  // principal on its own; no logout/re-login, no manual revert. See
  // auth/elevations.ts, auth/routes.ts's POST /api/operators/:id/promote.
  elevatedUntil?: number;
}

/** True if the principal may exercise `scope`. Humans (no scopes) always may. */
export function hasScope(principal: Principal, scope: Scope): boolean {
  return principal.scopes === undefined || principal.scopes.includes(scope);
}

/**
 * True if the principal may act on / see `projectId`. An unrestricted principal
 * (no `projectIds` — humans, workspace-wide tokens) always may; a project-scoped
 * token may only when the id is in its allowlist. Callers must still enforce the
 * workspace boundary separately (this assumes the project is in-workspace).
 */
export function allowsProject(principal: Principal, projectId: string): boolean {
  return principal.projectIds === undefined || principal.projectIds.includes(projectId);
}

// Dev tokens — two workspaces so isolation is demonstrable. These resolve
// regardless of AUTH_REQUIRED so the local flow and tests keep working.
const TOKENS: Record<string, Principal> = {
  "dev-cyberdyne": { workspaceId: DEFAULT_WORKSPACE, operatorId: "jordan" },
  "dev-resistance": { workspaceId: "resistance", operatorId: "kyle" },
};

const DEV_DEFAULT: Principal = { workspaceId: DEFAULT_WORKSPACE, operatorId: "operator" };

/** Dev conveniences (token map + open default) require an EXPLICIT development
 *  or test env — an unset/"staging"/production NODE_ENV never opens the API. */
const devAuthAllowed = (): boolean => config.devMode;

/** Cookie that carries a session token (set by the login route). */
export const SESSION_COOKIE = "skynet_session";

// Injected backends (real login tokens + service/API tokens). Absent until
// configureAuth runs.
let sessions: SessionStore | undefined;
let serviceTokens: ServiceTokenStore | undefined;
let elevations: ElevationStore | undefined;

/** Wire the auth backends (called once at bootstrap). */
export function configureAuth(opts: {
  sessions?: SessionStore;
  serviceTokens?: ServiceTokenStore;
  elevations?: ElevationStore;
}): void {
  sessions = opts.sessions;
  serviceTokens = opts.serviceTokens;
  elevations = opts.elevations;
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
    if (fromSession) {
      // Time-limited admin promotion (ROADMAP.md) — checked on EVERY request
      // for a session-resolved (human) principal, never for dev/service
      // tokens: elevation is a fact about an OPERATOR, granted by an admin,
      // and only ever narrows/widens the "viewer" concept those other token
      // kinds don't have. A live grant returns full authority + the deadline
      // (for the UI's countdown); an expired one is swept by activeUntil()
      // itself, so this naturally reverts with no action here.
      const elevatedUntil = await elevations?.activeUntil(fromSession.workspaceId, fromSession.operatorId);
      if (elevatedUntil != null) return { ...fromSession, scopes: undefined, elevatedUntil };
      return fromSession;
    }
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

/**
 * Resolve a principal from a request (header → query → cookie).
 *
 * `allowQueryToken` gates the `?token=` query param: it is accepted ONLY for the
 * WebSocket upgrade handshake (browsers can't set an Authorization header on a
 * WS connection). REST callers must omit it — query-string tokens leak via
 * access logs, browser history, and Referer headers (DEF-006), so REST requests
 * prefer the Authorization header, then the session cookie.
 */
export async function authenticate(
  req: FastifyRequest,
  opts: { allowQueryToken?: boolean } = {},
): Promise<Principal | undefined> {
  const queryToken = opts.allowQueryToken
    ? (req.query as { token?: string } | undefined)?.token
    : undefined;
  const token = tokenFrom(req.headers.authorization, queryToken) ?? cookieToken(req.headers.cookie);
  return resolvePrincipal(token);
}
