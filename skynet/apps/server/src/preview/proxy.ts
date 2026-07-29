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

interface ProxyResolver {
  proxyTarget(token: string): { port: number; basePath?: string } | null;
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
    // Vite serves under the prefix → forward as-is; otherwise strip the prefix.
    const path = target.basePath ? fullPath : fullPath.slice(prefix.length) || "/";
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

  app.all("/p/:token", handler);
  app.all("/p/:token/*", handler);
}
