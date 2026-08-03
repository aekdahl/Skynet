// ─── Public origin (for phone/remote-reachable preview URLs) ────────────────
// A live preview runs on a loopback port; to open it from a phone the UI needs a
// URL on Skynet's OWN public origin (proxied — see preview-proxy.ts). We learn
// that origin from an explicit env, else from the reverse-proxy / Google-IAP
// forwarded headers seen on real requests (loopback ignored). Display + proxy
// routing only — never trusted for auth.

let learned: string | undefined;

/** Record the origin from a request's forwarded headers. Ignores loopback/private
 *  values so a local dev hit doesn't pin a useless origin. Idempotent + cheap. */
export function recordPublicOrigin(forwardedProto?: string, forwardedHost?: string, host?: string): void {
  const rawHost = (forwardedHost ?? host ?? "").split(",")[0]?.trim();
  if (!rawHost) return;
  if (/^(localhost|127\.0\.0\.1|\[?::1\]?|0\.0\.0\.0)(:|$)/i.test(rawHost)) return;
  const proto = (forwardedProto ?? "").split(",")[0]?.trim() || "https";
  learned = `${proto}://${rawHost}`;
}

/** The public origin, if known: explicit env wins, else the learned value.
 *  undefined → no public origin (desktop / not yet observed) → previews stay
 *  loopback-only. */
export function publicOrigin(): string | undefined {
  const env = process.env.SKYNET_PUBLIC_URL || process.env.SKYNET_PREVIEW_BASE_URL;
  return (env && env.replace(/\/+$/, "")) || learned;
}

/** Test seam. */
export function __resetPublicOrigin(): void {
  learned = undefined;
}
