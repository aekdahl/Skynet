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
//     entry HTML, if only the HTML were rewritten.
//
// Text rewriting is inherently best-effort (a runtime-computed URL can never be
// caught as text), so root-served mode gets a second, structural safety net —
// SALVAGE: a request that escaped the prefix entirely and landed on the top
// origin in a namespace only a dev server owns (`/@fs/…`, `/@vite/…`, `/@id/…`,
// `/@react-refresh`, `/node_modules/…`, `/__vite…`) is routed BACK to the live
// preview it belongs to (resolved via the worktree path baked into `/@fs/`
// URLs, the request's `Referer`, or the sole live preview) instead of falling
// through to Skynet's SPA fallback. Same for WebSockets: Vite's HMR client in
// root-served mode connects at the TOP origin (its base is `/`), declaring the
// `vite-hmr`/`vite-ping` subprotocols — those upgrades are spliced through to
// the dev server, which both makes HMR work end-to-end in strip mode AND kills
// a vicious reload loop: previously the upgrade fell through to
// @fastify/websocket, whose handler COMPLETES the handshake on any matched
// route before noticing it isn't a websocket route — so Vite's "is the server
// back?" ping socket (success = the socket OPENS, see waitForSuccessfulPing in
// vite/dist/client/client.mjs) always "succeeded" against the SPA fallback and
// the client called location.reload(), once per second, forever.
//
// HTTP is hijacked in an `onRequest` hook — that runs BEFORE Fastify parses the
// body, so we stream the raw request straight through. Upgrades are intercepted
// EXCLUSIVELY (prior `upgrade` listeners — @fastify/websocket, which owns /ws —
// only see upgrades that aren't ours), so a preview socket is never double-
// handled by two writers on one socket.

import type { FastifyInstance } from "fastify";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as netConnect } from "node:net";
import type { Duplex } from "node:stream";

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

// Vite's own `vite:worker-import-meta-url` transform sometimes injects a
// `/* @vite-ignore */` block comment between the opening paren and the string
// literal (e.g. `new URL(/* @vite-ignore */ "/@fs/…", import.meta.url)`) to
// suppress its own dynamic-import warning. Tolerate one here so a literal
// path preceded by such a comment still gets re-prefixed.
const OPT_COMMENT = "(?:/\\*.*?\\*/\\s*)?";

/** Re-prefix root-absolute ES-module specifiers in a JS body: `from "/…"` (static
 *  imports/re-exports), bare `import "/…"` (side-effect imports), dynamic
 *  `import("/…")`, `new URL("/…", import.meta.url)` (Vite's transform for a
 *  static-literal `new URL(specifier, import.meta.url)`), and
 *  `export default "/…"` — the entire body of the module Vite's dev server
 *  serves for a `?url` asset import (vite:asset load():
 *  `export default ${JSON.stringify(url)}`). That last shape is how a library
 *  worker file's URL actually reaches app code — e.g.
 *  `import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url"` resolves
 *  to a module whose text is `export default "/@fs/…/pdf.worker.min.mjs?import"`
 *  — and the string is then consumed at RUNTIME (`new Worker(url)`,
 *  `import(url)`), where no text rewriter can see it anymore. Miss it here and
 *  the browser resolves the bare `/@fs/…` path against the top origin, escapes
 *  the proxy, and gets SPA-fallback HTML where a worker script was expected
 *  ("Setting up fake worker failed: Failed to fetch dynamically imported
 *  module"). Skips protocol-relative, absolute-URL, relative, and
 *  already-prefixed specifiers (only a single leading `/` qualifies).
 *
 *  Still inherently incomplete — a URL assembled at runtime from pieces can
 *  never be caught as text; the salvage layer (see header + salvagePreviewToken)
 *  is the structural backstop for that class. PURE — tested. */
export function rewriteJsImports(js: string, prefix: string): string {
  const reprefix = (path: string): string | null =>
    path === prefix || path.startsWith(prefix + "/") ? null : prefix + path;
  return js
    .replace(/\bfrom\s*("|')(\/(?!\/)[^"']*)\1/g, (m, q, path) => {
      const r = reprefix(path);
      return r ? `from ${q}${r}${q}` : m;
    })
    .replace(new RegExp(`\\bimport\\s*\\(\\s*${OPT_COMMENT}("|')(/(?!/)[^"']*)\\1`, "g"), (m, q, path) => {
      const r = reprefix(path);
      return r ? m.replace(`${q}${path}${q}`, `${q}${r}${q}`) : m;
    })
    .replace(/\bimport\s*("|')(\/(?!\/)[^"']*)\1/g, (m, q, path) => {
      const r = reprefix(path);
      return r ? `import ${q}${r}${q}` : m;
    })
    .replace(new RegExp(`\\bnew\\s+URL\\s*\\(\\s*${OPT_COMMENT}("|')(/(?!/)[^"']*)\\1\\s*,\\s*import\\.meta\\.url\\s*\\)`, "g"), (m, q, path) => {
      const r = reprefix(path);
      return r ? m.replace(`${q}${path}${q}`, `${q}${r}${q}`) : m;
    })
    .replace(/\bexport\s+default\s+("|')(\/(?!\/)[^"']*)\1/g, (m, q, path) => {
      const r = reprefix(path);
      return r ? `export default ${q}${r}${q}` : m;
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

// ─── Salvage: token-less dev-server requests back to their preview ──────────

/** Path namespaces only a dev server (Vite & friends) ever owns. A top-origin
 *  request in one of these can only be a preview-page reference that escaped
 *  the `/p/<token>/` prefix (a runtime-computed URL the text rewriter could not
 *  see) — never a legitimate Skynet route. PURE — tested. */
export function isDevServerPath(url: string): boolean {
  const p = url.split("?")[0]!;
  return (
    p.startsWith("/@fs/") ||
    p.startsWith("/@vite/") ||
    p.startsWith("/@id/") ||
    p === "/@react-refresh" ||
    p.startsWith("/node_modules/") ||
    p.startsWith("/__vite")
  );
}

/** A live preview the salvage layer can route to. `dir` is the preview's
 *  worktree directory (absolute); `stripPrefix` mirrors PreviewTarget. */
export interface SalvageCandidate {
  token: string;
  dir: string;
  stripPrefix: boolean;
}

/** Resolve which live preview a token-less dev-server request belongs to:
 *   1. `/@fs/<abs-path>` embeds the file's real location — match it against
 *      each candidate's worktree dir (deterministic, works even for requests
 *      that carry no Referer, e.g. a worker's own sub-requests);
 *   2. the request's `Referer` names the page it came from — `/p/<token>/…`;
 *   3. exactly one live preview → it (the overwhelmingly common case).
 *  Returns the token, or null when unresolvable (ambiguous or no previews).
 *  PURE — tested. */
export function salvagePreviewToken(
  url: string,
  referer: string | undefined,
  candidates: SalvageCandidate[],
): string | null {
  if (!isDevServerPath(url) || candidates.length === 0) return null;
  const path = url.split("?")[0]!;
  if (path.startsWith("/@fs/")) {
    let decoded = path;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      /* keep raw */
    }
    const fsPath = decoded.slice("/@fs".length); // "/@fs/data/…" → "/data/…"
    for (const c of candidates) {
      const dir = c.dir.replace(/\/+$/, "");
      if (dir && (fsPath === dir || fsPath.startsWith(dir + "/"))) return c.token;
    }
  }
  if (referer) {
    const m = referer.match(/\/p\/([A-Za-z0-9._-]+)(?:\/|\?|$)/);
    const tok = m?.[1];
    if (tok && candidates.some((c) => c.token === tok)) return tok;
  }
  if (candidates.length === 1) return candidates[0]!.token;
  return null;
}

/** Does an upgrade request declare Vite's client subprotocols? (`vite-hmr` for
 *  the live HMR channel, `vite-ping` for the "is the server back?" probe whose
 *  SUCCESS CONDITION is just the socket opening.) PURE — tested. */
export function isViteClientSocket(protocolHeader: string | string[] | undefined): boolean {
  const v = Array.isArray(protocolHeader) ? protocolHeader.join(",") : (protocolHeader ?? "");
  return /\bvite-(hmr|ping)\b/.test(v);
}

/** Resolve a preview token to its live loopback port and path mode, or undefined
 *  if unknown/not live. `stripPrefix` = the dev server serves at base `/`, so the
 *  proxy must strip the `/p/<token>` prefix and re-prefix its HTML (see header). */
export type PreviewTarget = (token: string) => { port: number; stripPrefix: boolean } | undefined;

/** The live previews the salvage layer may route token-less requests to. */
export type SalvageCandidates = () => SalvageCandidate[];

export function registerLivePreviewProxy(
  app: FastifyInstance,
  targetForToken: PreviewTarget,
  salvageCandidates: SalvageCandidates = () => [],
): void {
  /** Forward one HTTP request to a preview's dev server, rewriting root-served
   *  bodies so their root-absolute refs re-enter the `/p/<token>/` prefix. */
  function forward(req: IncomingMessage & { url: string }, raw: ServerResponse, token: string, port: number, stripPrefix: boolean, fwdPath: string): void {
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
    req.pipe(upstream); // GET → empty body ends immediately; POST/PUT → streamed
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────
  app.addHook("onRequest", (req, reply, done) => {
    if (!req.url.startsWith("/p/")) {
      // Salvage: a dev-server-namespace request that escaped the prefix (a
      // runtime-computed URL — see header). Route it back to its preview; when
      // no preview can be resolved, answer 404 OURSELVES — these namespaces are
      // never Skynet routes, and letting them fall to the SPA fallback turns
      // every miss into a misleading 200 text/html (the "HTML where a module
      // was expected" class of failure).
      if (!isDevServerPath(req.url)) return done();
      const token = salvagePreviewToken(req.url, req.headers.referer, salvageCandidates());
      const target = token ? targetForToken(token) : undefined;
      if (!token || !target) {
        reply.code(404).type("text/plain").send("preview asset not routable (no matching live preview)");
        return;
      }
      reply.hijack();
      // A root-served dev server expects the path exactly as it appears here; a
      // base-prefixed one only answers under its base, so re-add the prefix.
      const fwdPath = target.stripPrefix ? req.url : `/p/${token}${req.url}`;
      forward(req.raw as IncomingMessage & { url: string }, reply.raw, token, target.port, target.stripPrefix, fwdPath);
      return;
    }
    const token = previewTokenOf(req.url);
    const target = token ? targetForToken(token) : undefined;
    if (!target) {
      reply.code(404).type("text/plain").send("preview not found or not running");
      return;
    }
    reply.hijack(); // take over the socket; skip Fastify's body parsing + serialization
    const fwdPath = target.stripPrefix ? stripPreviewPrefix(req.url, token!) : req.url;
    forward(req.raw as IncomingMessage & { url: string }, reply.raw, token!, target.port, target.stripPrefix, fwdPath);
  });

  // ── WebSocket (Vite HMR + any app socket) ──────────────────────────────────
  // Transparent TCP splice: re-issue the raw HTTP upgrade to the loopback dev
  // server (Host rewritten) and pipe the sockets, so the 101 + frames flow end
  // to end. Interception is EXCLUSIVE: prior `upgrade` listeners (that's
  // @fastify/websocket, which owns Skynet's own /ws) only run for upgrades that
  // aren't ours — previously both listeners fired for every upgrade, and
  // @fastify/websocket completes the websocket handshake on ANY matched route
  // before discovering it has no websocket handler (handleUpgrade first,
  // noHandle after), which is what made Vite's `vite-ping` probe "succeed"
  // against the SPA fallback and reload the previewed page every second.
  // Best-effort: a failed HMR socket never breaks page viewing.
  //
  // The takeover runs at onReady — Fastify boots plugins lazily, so
  // @fastify/websocket's own `upgrade` listener only exists once the app has
  // finished booting; capturing earlier would find an empty list and then
  // coexist with (instead of preceding) the plugin's listener, resurrecting the
  // double-handling this replaces — and destroying /ws sockets we should have
  // delegated.
  app.addHook("onReady", (done) => {
    const priorUpgradeListeners = app.server.listeners("upgrade").slice() as Array<(req: IncomingMessage, socket: Duplex, head: Buffer) => void>;
    app.server.removeAllListeners("upgrade");
    app.server.on("upgrade", (req, socket, head) => {
      const url = req.url ?? "";
      let token: string | null = null;
      let fwdUrl = url;
      if (url.startsWith("/p/")) {
        token = previewTokenOf(url);
        if (token) fwdUrl = targetForToken(token)?.stripPrefix ? stripPreviewPrefix(url, token) : url;
      } else if (!url.startsWith("/ws") && isViteClientSocket(req.headers["sec-websocket-protocol"])) {
        // A root-served preview's Vite client connects at the TOP origin (its
        // base is `/`) — the page URL's token never reaches us, so resolve by
        // the sole live root-served preview. Ambiguous (several live) → destroy
        // WITHOUT a handshake: vite-ping's success test is "did the socket
        // open", so a hard failure keeps the client polling quietly instead of
        // reload-looping on a fake open.
        const strips = salvageCandidates().filter((c) => c.stripPrefix);
        token = strips.length === 1 ? strips[0]!.token : null;
        if (token === null) {
          socket.destroy();
          return;
        }
      } else {
        // Not a preview upgrade — hand it to whoever was listening before us
        // (@fastify/websocket → Skynet's /ws gateway).
        if (priorUpgradeListeners.length === 0) socket.destroy();
        else for (const l of priorUpgradeListeners) l.call(app.server, req, socket, head);
        return;
      }
      const target = token ? targetForToken(token) : undefined;
      if (!target) {
        socket.destroy();
        return;
      }
      const { port } = target;
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
    done();
  });
}
