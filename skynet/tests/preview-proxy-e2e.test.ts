// End-to-end proxy check against a base-`/` (nested-Vite-like) upstream — the
// case that produced a blank page (root-absolute /main.jsx served through
// /p/<token>/ fell through to the SPA fallback, a text/html MIME error). The
// upstream serves index.html with root-absolute /main.jsx + /@react-refresh,
// exactly like Vite at base `/`. Through the proxy we expect the HTML re-prefixed
// and /p/<token>/main.jsx stripped back to /main.jsx and served as JS.
import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createServer, type Server } from "node:http";
import { registerLivePreviewProxy } from "../apps/server/src/preview/preview-proxy.js";

const TOKEN = "tok_e2e";

/** A fake dev server that serves at base `/` (the failing case). */
function fakeViteBaseSlash(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        `<!doctype html><html><head>\n` +
          `<script type="module">\nimport RefreshRuntime from "/@react-refresh"\nRefreshRuntime.injectIntoGlobalHook(window)\n</script>\n` +
          `</head><body><div id="root"></div>\n` +
          `<script type="module" src="/main.jsx"></script>\n</body></html>`,
      );
    } else if (req.url === "/main.jsx") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(`console.log("app entry")`);
    } else if (req.url === "/@react-refresh") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(`export default {}`);
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, port: (server.address() as any).port })));
}

describe("live-preview proxy — root-served (strip + rewrite) mode", () => {
  let app: FastifyInstance | undefined;
  let upstream: Server | undefined;

  afterEach(async () => {
    await app?.close();
    await new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r()));
    app = upstream = undefined;
  });

  async function boot(stripPrefix: boolean) {
    const up = await fakeViteBaseSlash();
    upstream = up.server;
    app = Fastify();
    registerLivePreviewProxy(app, (t) => (t === TOKEN ? { port: up.port, stripPrefix } : undefined));
    await app.listen({ port: 0, host: "127.0.0.1" });
    return `http://127.0.0.1:${(app.server.address() as any).port}`;
  }

  it("re-prefixes the HTML entry and serves stripped assets as JS", async () => {
    const base = await boot(true);

    const htmlRes = await fetch(`${base}/p/${TOKEN}/`);
    const html = await htmlRes.text();
    expect(htmlRes.headers.get("content-type")).toContain("text/html");
    expect(html).toContain(`src="/p/${TOKEN}/main.jsx"`);
    expect(html).toContain(`from "/p/${TOKEN}/@react-refresh"`);
    // The rewritten body's content-length must match (else the browser truncates).
    expect(Number(htmlRes.headers.get("content-length"))).toBe(Buffer.byteLength(html));

    // The follow-up asset request the browser now makes — stripped, served as JS,
    // NOT the SPA-fallback text/html that caused the blank page.
    const jsRes = await fetch(`${base}/p/${TOKEN}/main.jsx`);
    expect(jsRes.headers.get("content-type")).toContain("javascript");
    expect(await jsRes.text()).toContain("app entry");
  });

  it("forwards the full path unchanged when base is prefixed (no rewrite)", async () => {
    // stripPrefix=false models a Vite started with --base=/p/<token>/, which would
    // itself serve at /p/<token>/… — our fake serves at `/`, so the full-path
    // forward 404s. The point is only that we do NOT strip or rewrite here.
    const base = await boot(false);
    const res = await fetch(`${base}/p/${TOKEN}/main.jsx`);
    expect(res.status).toBe(404); // forwarded as-is to /p/<token>/main.jsx (not /main.jsx)
  });

  it("404s an unknown token without crashing", async () => {
    const base = await boot(true);
    const res = await fetch(`${base}/p/nope/`);
    expect(res.status).toBe(404);
  });
});
