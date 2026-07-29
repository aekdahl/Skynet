// ─── Preview reverse proxy — serve a running preview through Skynet's own URL ──
// A phone can't reach the preview's loopback dev server directly. When Skynet has
// a public URL (SKYNET_PUBLIC_URL), we proxy `/<base>/p/<token>/…` on the Skynet
// server through to the preview's `127.0.0.1:<port>` — so the shared link opens
// on any device that can reach Skynet. The path `token` is an unguessable secret
// (the route is intentionally UNAUTHENTICATED — the phone has no session), so a
// preview is only reachable by someone the operator handed the link to.
//
// Two modes (chosen per preview in the manager):
//   • Vite (basePath set) — the dev server was started with `--base=/p/<token>/`,
//     so it already serves everything under the prefix. Forward the full path.
//   • Everything else — strip the `/p/<token>` prefix so the dev server sees `/`,
//     and inject a `<base href>` so its RELATIVE asset URLs resolve under the
//     prefix. (Apps that emit absolute asset paths need the Vite path or a base
//     config — documented limitation.)
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { request as httpRequest } from "node:http";
import { WebSocket as WsClient, type RawData, type WebSocket as WsSocket } from "ws";

interface ProxyResolver {
  proxyTarget(token: string): { port: number; basePath?: string } | null;
}

// @fastify/websocket only allows a wsHandler on a GET route, so we register GET
// (HTTP + upgrade) separately from the other HTTP methods. HEAD is omitted — the
// GET route registers it automatically (declaring it again collides).
const NON_GET_METHODS = ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

/** The loopback path to forward to: vite serves under the prefix (pass through),
 *  everything else is served at root (strip the `/p/<token>` prefix). */
function upstreamPath(fullPath: string, prefix: string, basePath?: string): string {
  return basePath ? fullPath : fullPath.slice(prefix.length) || "/";
}

/** Inject `<base href>` (once) so a stripped-prefix app's relative URLs resolve
 *  under `/p/<token>/`. Prefers just-inside-<head>, else prepends. */
function injectBase(html: string, base: string): string {
  if (/<base\s/i.test(html)) return html; // app already declares a base
  const tag = `<base href="${base}">`;
  return /<head[^>]*>/i.test(html) ? html.replace(/(<head[^>]*>)/i, `$1${tag}`) : tag + html;
}

export function registerPreviewProxy(app: FastifyInstance, previews: ProxyResolver): void {
  const handler = (req: FastifyRequest, reply: FastifyReply): void => {
    const token = (req.params as { token?: string }).token ?? "";
    const target = previews.proxyTarget(token);
    if (!target) {
      reply.code(404).type("text/plain").send("Preview not running — it may have stopped or timed out. Ask for a new preview.");
      return;
    }
    const prefix = `/p/${token}`;
    const fullPath = req.raw.url ?? "/"; // includes the query string
    const path = upstreamPath(fullPath, prefix, target.basePath);
    const rewriteHtml = !target.basePath;

    // Strip accept-encoding so the dev server responds uncompressed — otherwise
    // buffering + rewriting HTML would corrupt a gzip stream.
    const headers = { ...req.headers, host: `127.0.0.1:${target.port}` };
    delete (headers as Record<string, unknown>)["accept-encoding"];

    reply.hijack();
    const proxyReq = httpRequest(
      { host: "127.0.0.1", port: target.port, method: req.raw.method, path, headers },
      (proxyRes) => {
        const status = proxyRes.statusCode ?? 502;
        const ct = String(proxyRes.headers["content-type"] ?? "");
        if (rewriteHtml && ct.includes("text/html")) {
          const chunks: Buffer[] = [];
          proxyRes.on("data", (c: Buffer) => chunks.push(c));
          proxyRes.on("end", () => {
            const html = injectBase(Buffer.concat(chunks).toString("utf8"), `${prefix}/`);
            const out = { ...proxyRes.headers };
            delete out["content-length"]; // body length changed by the rewrite
            reply.raw.writeHead(status, out);
            reply.raw.end(html);
          });
          proxyRes.on("error", () => reply.raw.end());
        } else {
          reply.raw.writeHead(status, proxyRes.headers);
          proxyRes.pipe(reply.raw);
        }
      },
    );
    proxyReq.on("error", (err) => {
      try {
        reply.raw.writeHead(502, { "content-type": "text/plain" });
        reply.raw.end(`preview proxy error: ${err.message}`);
      } catch {
        /* socket already gone */
      }
    });
    req.raw.pipe(proxyReq);
  };

  // Proxy the WebSocket upgrade too — so a dev server's HMR socket (Vite live
  // reload) tunnels through, and the preview hot-updates on the phone. Bridges
  // the browser↔Skynet socket to a fresh Skynet↔dev-server socket, forwarding the
  // subprotocol (Vite uses `vite-hmr`). Registered via @fastify/websocket's
  // wsHandler so it cooperates with the app's own /ws instead of racing raw
  // 'upgrade' listeners.
  const wsHandler = (socket: WsSocket, req: FastifyRequest): void => {
    const token = (req.params as { token?: string }).token ?? "";
    const target = previews.proxyTarget(token);
    if (!target) {
      socket.close(1011, "preview not running");
      return;
    }
    const path = upstreamPath(req.raw.url ?? "/", `/p/${token}`, target.basePath);
    const sub = req.headers["sec-websocket-protocol"];
    const protocols = sub ? String(sub).split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const upstream = new WsClient(`ws://127.0.0.1:${target.port}${path}`, protocols);
    const backlog: RawData[] = [];
    let up = false;
    socket.on("message", (d: RawData) => (up ? upstream.send(d as Buffer) : backlog.push(d)));
    socket.on("close", () => upstream.close());
    socket.on("error", () => upstream.close());
    upstream.on("open", () => {
      up = true;
      for (const d of backlog) upstream.send(d as Buffer);
      backlog.length = 0;
    });
    upstream.on("message", (d: RawData) => {
      if (socket.readyState === socket.OPEN) socket.send(d as Buffer);
    });
    upstream.on("close", () => {
      try { socket.close(); } catch { /* already closed */ }
    });
    upstream.on("error", () => {
      try { socket.close(1011, "upstream ws error"); } catch { /* already closed */ }
    });
  };

  for (const url of ["/p/:token", "/p/:token/*"]) {
    app.route({ method: "GET", url, handler, wsHandler }); // HTTP GET + the WS/HMR upgrade
    app.route({ method: NON_GET_METHODS as unknown as string[], url, handler });
  }
}
