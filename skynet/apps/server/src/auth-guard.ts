import type { Scope } from "./auth.js";

// ─── /api + /mcp auth guard: the one predicate the onRequest hook trusts ────
// The server authenticates every /api and /mcp route from a bearer-token
// principal; /api/auth/login is the sole public route (it issues the token, so
// it can't require one). Everything else — health, the static SPA, /ws (which
// authenticates itself) — is untouched. The match is case-insensitive so an
// uppercase /API/... can't slip past the guard (DEF-007).
//
// These predicates are the single source of truth: the hook uses them, and the
// auth-hardening test asserts against them, so production behavior and the test
// can never drift.

/** A guarded surface — /api, /mcp, or the /v1 interop surface (OpenAI-compat +
 *  REST, see interop/) — that requires a resolved principal. */
export function isGuardedPath(url: string): boolean {
  const path = url.toLowerCase();
  return path.startsWith("/api") || path.startsWith("/mcp") || path.startsWith("/v1");
}

/** The public /api auth routes: login + the MFA second-factor exchange both
 *  issue the token, so they can't require one. */
export function isPublicLogin(url: string): boolean {
  const path = url.toLowerCase();
  // The path may carry a query string (e.g. ?next=/); match the prefix.
  return (
    path === "/api/auth/login" ||
    path.startsWith("/api/auth/login?") ||
    path === "/api/auth/mfa" ||
    path.startsWith("/api/auth/mfa?")
  );
}

/** True when a request must resolve a principal before it may proceed. */
export function requiresAuth(url: string): boolean {
  return isGuardedPath(url) && !isPublicLogin(url);
}

// ─── mutation scope gate (viewer role) ──────────────────────────────────────
// A human login carries no scopes (full authority) UNLESS it's a viewer
// account (auth/operators.ts maps role "viewer" → scopes: ["observe"] at
// login). hasScope() already treats an unscoped principal as allowed for
// anything, so this gate only ever narrows a SCOPED principal (a viewer, or a
// service token) — full-authority humans are unaffected.
//
// /mcp is deliberately excluded: every tool there is already individually
// scope-gated at finer grain (mcp/tools.ts's `tool(name, scope, ...)`) — a
// single POST /mcp carries calls at every scope, so a blanket per-verb rule
// on the transport can't express what a per-tool rule already does correctly.

/** HITL/merge decision gates — "approve/reject/modify diffs... gate push" in
 *  the SCOPES doc comment (auth.ts). Everything else non-GET under /api falls
 *  through to "author" below. */
function isApproverDecision(method: string, path: string): boolean {
  if (method !== "POST") return false;
  return /^\/api\/hitl\/[^/]+\/resolve$/.test(path) || /^\/api\/merges\/[^/]+\/(merge|rework|update-branch|dismiss)$/.test(path);
}

/** Requests that don't touch domain state: a personal auth action (logout),
 *  or a dry-run/judge endpoint that only reads + calls an LLM, never writes
 *  (the Telegram/Simulation QA harnesses, and Steward's own chat — Steward
 *  only PROPOSES an action here; a human/viewer confirming it is a separate,
 *  gated call to the action's own route). */
function isExemptMutation(method: string, path: string): boolean {
  if (path === "/api/auth/logout") return true;
  if (method !== "POST") return false;
  return (
    path === "/api/telegram/simulate" ||
    path === "/api/simulation/grade" ||
    path === "/api/simulation/judge" ||
    path === "/api/steward/chat" ||
    path === "/api/steward/chat/stream"
  );
}

/**
 * The scope a request requires beyond "has a resolved principal", or null when
 * none applies (reads; the exemptions above; anything outside /api and /v1).
 * Default for a non-GET /api or /v1 route is "author" (create/assign/fork/
 * chat/stop/archive, configure fleet runners/providers — the SCOPES doc
 * comment in auth.ts); "approver" is reserved for the HITL/merge decision
 * gates it names by name. /v1 (interop/) never names an approver decision
 * today, so it always falls through to "author" — same bar as spinning up a
 * run via /mcp's assign_task.
 *
 * Admin promotion (POST /api/operators/:id/promote) is deliberately NOT
 * exempted — it needs no escape hatch the way self-service elevation would
 * have: the CALLER here is already an admin (full authority, no scopes), so
 * it passes the default "author" requirement naturally, while a viewer (only
 * "observe") is correctly blocked from ever reaching it. The route's own
 * handler adds a SECOND, stronger check on top (the caller's PERSISTED role,
 * not just their current scope) — see auth/routes.ts.
 */
export function requiredScope(method: string, url: string): Scope | null {
  const q = url.indexOf("?");
  const path = (q < 0 ? url : url.slice(0, q)).toLowerCase();
  if (!path.startsWith("/api") && !path.startsWith("/v1")) return null; // /mcp: self-gated per tool call
  if (method === "GET" || method === "HEAD") return null;
  if (isExemptMutation(method, path)) return null;
  return isApproverDecision(method, path) ? "approver" : "author";
}
