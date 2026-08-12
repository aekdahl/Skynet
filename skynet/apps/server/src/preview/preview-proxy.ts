// ─── Live-preview reverse proxy ─────────────────────────────────────────────
// Fronts a preview's loopback dev server (127.0.0.1:<port>) at a public path
// `/p/<token>/…` on Skynet's own origin, so a live preview is viewable from a
// phone/remotely (behind the same Google IAP as the rest of the app — `/p/` is
// public at the APP level, gated at the edge).
//
// The key move: forward with the upstream `Host` rewritten to the loopback
// origin. Vite 6+ dev servers reject a foreign Host ("Blocked request. This host
// is not allowed", server.allowedHosts); rewriting Host makes them accept it,
// framework-agnostically, with no per-recipe flags.
//
// Two path modes, chosen per preview by whether the dev server serves its assets
// under the `/p/<token>/` prefix (see PreviewTarget.stripPrefix):
//
//   • base-prefixed (stripPrefix=false) — Vite was started with
//     `--base=/p/<token>/`, so its asset/HMR URLs already carry the prefix. We
//     forward the FULL path unchanged; HMR works end to end over the proxy.
//
//   • root-served (stripPrefix=true) — the dev server serves at base `/` and
//     emits root-absolute asset URLs (`/main.jsx`, `/@vite/client`). This is the
//     common case when Vite runs INDIRECTLY (via `concurrently`/npm scripts), so
//     the `--base` flag can't reach the leaf `vite` process. Here we STRIP the
//     `/p/<token>` prefix before forwarding (so `/p/<tok>/main.jsx` → `/main.jsx`
//     reaches Vite), and REWRITE the returned body so its root-absolute refs
//     re-gain the prefix — otherwise the browser, viewing the page at
//     `/p/<tok>/`, would request `/main.jsx` at the top origin, miss this proxy,
//     and get Skynet's SPA fallback HTML back (a `text/html` MIME error → blank
//     page). Two response kinds need this, not just the entry document: the HTML
//     (`src`/`href` attrs + inline `<script>` imports) AND every JS module Vite
//     serves after it — Vite rewrites each module's import specifiers to
//     root-absolute paths (`from "/src/App.jsx"`, `from "/@fs/…"`), so the SAME
//     MIME-mismatch/blank-page failure hits the whole module graph, not just the
//     entry HTML, if only the HTML were rewritten. HMR-over-proxy degrades to
//     reload-on-refresh in this mode.
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

/** Turn `/p/<token>/rest?q` into `/rest?q` for forwarding to a dev server that
 *  serves at base `/`. `/p/<token>` and `/p/<token>/` both become `/`. Anything
 *  not under the prefix is returned unchanged. PURE — unit-tested. */
export function stripPreviewPrefix(url: string, token: string): string {
  const base = `/p/${token}`;
  if (url === base || url === base + "/") return "/";
  if (url.startsWith(base + "/")) return url.slice(base.length); // "/p/<t>/x" → "/x"
  if (url.startsWith(base + "?")) return "/" + url.slice(base.length); // "/p/<t>?q" → "/?q"
  return url;
}

/** Re-prefix root-absolute ES-module specifiers in a JS body: `from "/…"` (static
 *  imports/re-exports), bare `import "/…"` (side-effect imports), dynamic
 *  `import("/…")`, and `new URL("/…", import.meta.url)` (Vite's transform for a
 *  static-literal `new URL(specifier, import.meta.url)` — the pattern libraries
 *  like `pdfjs-dist` use to locate a worker file: `fileToDevUrl` bakes the
 *  resolved path in as a *root-relative string*, so at runtime the browser
 *  resolves it against the page's origin, landing on the unprefixed path and
 *  missing this proxy entirely — a `text/html` SPA-fallback response where a
 *  worker script was expected, which surfaces as "failed to fetch dynamically
 *  imported module"). This is what Vite's module graph is actually built from
 *  once you're past the entry HTML — e.g. `main.jsx` importing `"/src/App.jsx"`
 *  or `"/@fs/…"` — so it applies both inside inline `<script>` blocks
 *  (react-refresh preamble) and to whole standalone `.js`/`.jsx` module
 *  responses. Skips protocol-relative, absolute-URL, relative, and
 *  already-prefixed specifiers (only a single leading `/` qualifies). PURE —
 *  tested. */
export function rewriteJsImports(js: string, prefix: string): string {
  const reprefix = (path: string): string | null =>
    path === prefix || path.startsWith(prefix + "/") ? null : prefix + path;
  return js
    .replace(/\bfrom\s*("|')(\/(?!\/)[^"']*)\1/g, (m, q, path) => {
      const r = reprefix(path);
      return r ? `from ${q}${r}${q}` : m;
    })
    .replace(/\bimport\s*\(\s*("|')(\/(?!\/)[^"']*)\1/g, (m, q, path) => {
      const r = reprefix(path);
      return r ? `import(${q}${r}${q}` : m;
    })
    .replace(/\bimport\s*("|')(\/(?!\/)[^"']*)\1/g, (m, q, path) => {
      const r = reprefix(path);
      return r ? `import ${q}${r}${q}` : m;
    })
    .replace(/\bnew\s+URL\s*\(\s*("|')(\/(?!\/)[^"']*)\1\s*,\s*import\.meta\.url\s*\)/g, (m, q, path) => {
      const r = reprefix(path);
      return r ? `new URL(${q}${r}${q}, import.meta.url)` : m;
    });
}

/** Re-prefix a root-served dev server's HTML so its root-absolute asset URLs are
 *  reachable through the `/p/<token>/` proxy. Rewrites `src`/`href` attributes and
 *  (via {@link rewriteJsImports}) absolute ES-module specifiers inside inline
 *  `<script>` blocks (e.g. Vite's react-refresh preamble: `import X from
 *  "/@react-refresh"`). Skips protocol-relative (`//host`), absolute-URL
 *  (`http…`), and already-prefixed values. `prefix` is the base with no trailing
 *  slash, e.g. `/p/abc123`. PURE — tested. */
export function rewritePreviewHtml(html: string, prefix: string): string {
  const reprefix = (path: string): string | null =>
    path === prefix || path.startsWith(prefix + "/") ? null : prefix + path;
  // 1) src="/…" / href="/…" attributes anywhere in the document.
  let out = html.replace(/\b(src|href)=("|')(\/(?!\/)[^"']*)\2/gi, (m, attr, q, path) => {
    const r = reprefix(path);
    return r ? `${attr}=${q}${r}${q}` : m;
  });
  // 2) Absolute module specifiers inside inline <script> blocks (external scripts
  //    have an empty body, so those are untouched here — their src was handled in 1).
  out = out.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi, (_m, open: string, body: string, close: string) =>
    open + rewriteJsImports(body, prefix) + close,
  );
  return out;
}

/** Resolve a preview token to its live loopback port and path mode, or undefined
 *  if unknown/not live. `stripPrefix` = the dev server serves at base `/`, so the
 *  proxy must strip the `/p/<token>` prefix and re-prefix its HTML (see header). */
export type PreviewTarget = (token: string) => { port: number; stripPrefix: boolean } | undefined;

export function registerLivePreviewProxy(app: FastifyInstance, targetForToken: PreviewTarget): void {
  // ── HTTP ──────────────────────────────────────────────────────────────────
  app.addHook("onRequest", (req, reply, done) => {
    if (!req.url.startsWith("/p/")) return done();
    const token = previewTokenOf(req.url);
    const target = token ? targetForToken(token) : undefined;
    if (!target) {
      reply.code(404).type("text/plain").send("preview not found or not running");
      return;
    }
    const { port, stripPrefix } = target;
    reply.hijack(); // take over the socket; skip Fastify's body parsing + serialization
    const raw = reply.raw;
    const fwdPath = stripPrefix ? stripPreviewPrefix(req.url, token!) : req.url;
    const headers = { ...req.headers, host: `127.0.0.1:${port}` };
    // In strip mode we may rewrite the body, so ask the dev server to hand it
    // back uncompressed (we can't rewrite gzipped bytes).
    if (stripPrefix) delete (headers as Record<string, unknown>)["accept-encoding"];
    const upstream = httpRequest({ host: "127.0.0.1", port, method: req.method, path: fwdPath, headers }, (up) => {
      const ct = String(up.headers["content-type"] ?? "");
      const isHtml = ct.includes("text/html");
      // Vite (and any bundler) rewrites a root-served module's import specifiers
      // to root-absolute paths too (`from "/src/App.jsx"`, `from "/@fs/…"`) — not
      // just the entry HTML's tags — so the whole module graph needs the same
      // treatment, else every import 404s off the prefix (Skynet's SPA fallback
      // answers with HTML → "Failed to load module script" → blank page).
      const isJs = ct.includes("javascript");
      const rewritable = stripPrefix && (isHtml || isJs) && !up.headers["content-encoding"];
      if (!rewritable) {
        raw.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(raw);
        return;
      }
      // Buffer the (small) response, re-prefix its root-absolute refs, and send
      // with a corrected content-length.
      const chunks: Buffer[] = [];
      up.on("data", (c: Buffer) => chunks.push(c));
      up.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const rewritten = isHtml ? rewritePreviewHtml(text, `/p/${token}`) : rewriteJsImports(text, `/p/${token}`);
        const body = Buffer.from(rewritten, "utf8");
        const outHeaders = { ...up.headers };
        delete outHeaders["content-length"];
        delete outHeaders["transfer-encoding"];
        outHeaders["content-length"] = String(body.length);
        raw.writeHead(up.statusCode ?? 200, outHeaders);
        raw.end(body);
      });
      up.on("error", () => {
        if (!raw.headersSent) raw.writeHead(502, { "content-type": "text/plain" });
        raw.end("preview upstream error");
      });
    });
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
    const target = token ? targetForToken(token) : undefined;
    if (!target) {
      socket.destroy();
      return;
    }
    const { port, stripPrefix } = target;
    const fwdUrl = stripPrefix ? stripPreviewPrefix(url, token!) : url;
    const upstream = netConnect(port, "127.0.0.1", () => {
      const headers = { ...req.headers, host: `127.0.0.1:${port}` };
      const lines = [`${req.method ?? "GET"} ${fwdUrl} HTTP/1.1`];
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
