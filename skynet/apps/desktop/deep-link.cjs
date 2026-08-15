// ─── skynet:// deep-link translation ────────────────────────────────────────
// Pure translation from a `skynet://` OS-protocol URL to the app's existing
// hash-route form (apps/web/src/lib/routing.ts) — extracted from main.cjs so
// it's unit-testable (see tests/desktop-deep-link.test.ts). Everything else
// this feature touches in main.cjs is Electron event wiring (app.on("open-url"),
// second-instance argv, window creation) with no meaningful way to unit-test in
// this repo's current setup — apps/desktop has no test harness today, and this
// repo's convention (tests/**/*.test.ts, real vitest — see vitest.config.ts)
// isn't set up to drive a live Electron process, so that surface is covered by
// manual verification (packaged app, real OS `open` of a skynet:// link) instead
// of invented for one feature.
//
//   skynet://agent/<runId>   -> #/agent/<runId>
//   skynet://project/<id>    -> #/project/<id>
//   skynet://fleet/<agentId> -> #/fleet/<agentId>
//   skynet://fleet           -> #/fleet
//   skynet://queue           -> #/queue
//
// Mirrors routing.ts's parseHash() route shapes verbatim by construction —
// this file doesn't know or validate which segments are real routes; an
// unrecognized one just produces a hash that routing.ts's own parseHash()
// already no-ops on (same as today's behavior for any unrecognized hash),
// so there's nothing to keep in sync when a route is added there.

/** `skynet://<seg>/<rest>` -> `#/<seg>/<rest>`, or null if `raw` isn't a
 *  well-formed `skynet:` URL. PURE — tested. */
function skynetUrlToHash(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "skynet:") return null;
  const seg = u.hostname; // WHATWG URL parsing: skynet://agent/x -> hostname "agent"
  if (!seg) return null;
  const rest = u.pathname && u.pathname !== "/" ? u.pathname : ""; // pathname already carries its own leading "/"
  return `#/${seg}${rest}`;
}

/** First `skynet://…` entry in an argv-like array, or undefined. Used for both
 *  a cold launch (this process's own `process.argv`) and a second-instance
 *  forward (the OS-launched second process's argv, relayed via Electron's
 *  `second-instance` event) — same shape either way. */
function findSkynetUrlArg(argv) {
  return argv.find((a) => typeof a === "string" && a.startsWith("skynet://"));
}

module.exports = { skynetUrlToHash, findSkynetUrlArg };
