// ─── Public origin — how the outside world reaches this Skynet ──────────────
// Preview links (web + Telegram) must point at a URL the operator's device can
// actually reach. Two sources, in order:
//   1. SKYNET_PUBLIC_URL — an explicit override (always wins).
//   2. Learned from inbound requests — when Skynet runs behind a reverse proxy /
//      load balancer (e.g. the GCP IAP+LB deploy), each request carries the
//      public host it came in on (X-Forwarded-Host/-Proto). We remember the last
//      non-loopback one, so no env is needed when deployed behind the LB.
// The Telegram flow has no inbound request of its own, so it relies on this
// learned value (populated once anyone opens the board over the public URL).

let observed: string | undefined;

const clean = (s: string): string => s.replace(/\/+$/, "");
const isLoopback = (host: string): boolean => /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?$/i.test(host);

/** Record the public origin a request arrived on (best-effort). Ignores loopback
 *  so an admin's localhost/IAP-tunnel session never clobbers a real public host. */
export function recordPublicOrigin(proto: string | undefined, host: string | undefined): void {
  if (!host || isLoopback(host)) return;
  const scheme = proto === "http" || proto === "https" ? proto : "https";
  observed = clean(`${scheme}://${host}`);
}

/** The best known public base URL, or undefined if none. Env override wins. */
export function publicOrigin(): string | undefined {
  const env = clean(process.env.SKYNET_PUBLIC_URL || "");
  return env || observed;
}

/** Test seam: reset the learned origin. */
export function __resetObservedOrigin(): void {
  observed = undefined;
}
