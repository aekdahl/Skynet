// ─── CORS origin policy: the one decision the @fastify/cors hook trusts ─────
// Historically CORS reflected ANY request origin (`origin: true`), the last
// auth-hardening gap: a hosted deploy would echo back and thus trust every
// site's Origin. This is the single source of truth for whether an Origin is
// allowed, so production behavior and the test can never drift.
//
//   • devMode (explicit development/test): permissive — localhost dev is
//     unaffected. Everything is allowed.
//   • production-grade: allow ONLY origins on the allowlist. A request with no
//     Origin header (same-origin fetches, curl, server-to-server) is always
//     allowed — CORS only governs cross-origin browser requests. An EMPTY
//     allowlist is closed: nothing cross-origin passes (never a silent
//     fall-back to reflect-any).

export function isCorsOriginAllowed(
  origin: string | undefined,
  opts: { devMode: boolean; allowlist: readonly string[] },
): boolean {
  if (opts.devMode) return true;
  // No Origin header → not a cross-origin browser request; nothing to gate.
  if (!origin) return true;
  return opts.allowlist.includes(origin);
}
