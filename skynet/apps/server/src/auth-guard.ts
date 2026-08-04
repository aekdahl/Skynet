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

/** A guarded surface — /api or /mcp — that requires a resolved principal. */
export function isGuardedPath(url: string): boolean {
  const path = url.toLowerCase();
  return path.startsWith("/api") || path.startsWith("/mcp");
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
