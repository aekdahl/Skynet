// ─── Live-preview reverse proxy ─────────────────────────────────────────────
// Fronts a preview's loopback dev server (127.0.0.1:<port>) at a public path
// `/p/<token>/…` on Skynet's own origin, so a live preview is viewable from a
// phone/remotely (behind the same Google IAP as the rest of the app — `/p/` is
// public at the APP level, gated at the edge).
//
// The key move: forward with the upstream `Host` rewritten to the loopback
// origin. Vite 6+ dev servers reject a foreign Host ("Blocked request. This host
// is not allowed", server.allowedHosts); rewriting Host makes them accept it,
// framework-agnostically, with no per-recipe flags. The FULL path (incl. the
// `/p/<token>` prefix) is forwarded — Vite is started with `--base=/p/<token>/`
// so its asset/HMR URLs already carry the prefix.
//
// HTTP is hijacked in an `onRequest` hook — that runs BEFORE Fastify parses the
// body, so we stream the raw request straight through. HMR (and any app) WebSocket
// is bridged on the server `upgrade` event.

import type { FastifyInstance } from "fastify";
import { request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";

/** Extract the `<token>` from `/p/<token>/…`. */
export function previewTokenOf(url: string): string | null {
  const m = url.match(/^\/p\/([A-Za-z0-9._-]+)(?:\/|\?|$)/);
  return m ? m[1]! : null;
}

/** Resolve a preview token to its live loopback port (undefined if unknown/not live). */
export type PortForToken = (token: string) => number | undefined;

export function registerLivePreviewProxy(app: FastifyInstance, portForToken: PortForToken): void {
  // ── HTTP ──────────────────────────────────────────────────────────────────
  app.addHook("onRequest", (req, reply, done) => {
    if (!req.url.startsWith("/p/")) return done();
    const token = previewTokenOf(req.url);
    const port = token ? portForToken(token) : undefined;
    if (!port) {
      reply.code(404).type("text/plain").send("preview not found or not running");
      return;
    }
    reply.hijack(); // take over the socket; skip Fastify's body parsing + serialization
    const raw = reply.raw;
    const headers = { ...req.headers, host: `127.0.0.1:${port}` };
    const upstream = httpRequest(
      { host: "127.0.0.1", port, method: req.method, path: req.url, headers },
      (up) => {
        raw.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(raw);
      },
    );
    upstream.on("error", () => {
      if (!raw.headersSent) raw.writeHead(502, { "content-type": "text/plain" });
      raw.end("preview upstream error");
    });
    req.raw.pipe(upstream); // GET → empty body ends immediately; POST/PUT → streamed
  });

  // ── WebSocket (Vite HMR + any app socket) ──────────────────────────────────
  // Transparent TCP splice: re-issue the raw HTTP upgrade to the loopback dev
  // server (Host rewritten) and pipe the sockets, so the 101 + frames flow end to
  // end. Only /p/ upgrades are ours — every other path (e.g. Skynet's own /ws) is
  // left untouched for its handler. Best-effort: a failed HMR socket never breaks
  // page viewing.
  app.server.on("upgrade", (req, socket, head) => {
    const url = req.url ?? "";
    if (!url.startsWith("/p/")) return; // not ours
    const token = previewTokenOf(url);
    const port = token ? portForToken(token) : undefined;
    if (!port) {
      socket.destroy();
      return;
    }
    const upstream = netConnect(port, "127.0.0.1", () => {
      const headers = { ...req.headers, host: `127.0.0.1:${port}` };
      const lines = [`${req.method ?? "GET"} ${url} HTTP/1.1`];
      for (const [k, v] of Object.entries(headers)) {
        if (Array.isArray(v)) for (const vv of v) lines.push(`${k}: ${vv}`);
        else if (v != null) lines.push(`${k}: ${v}`);
      }
      upstream.write(lines.join("\r\n") + "\r\n\r\n");
      if (head?.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
}
