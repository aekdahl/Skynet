// End-to-end proxy check against a base-`/` (nested-Vite-like) upstream — the
// case that produced a blank page (root-absolute /main.jsx served through
// /p/<token>/ fell through to the SPA fallback, a text/html MIME error). The
// upstream serves index.html with root-absolute /main.jsx + /@react-refresh,
// exactly like Vite at base `/`. Through the proxy we expect the HTML re-prefixed
// and /p/<token>/main.jsx stripped back to /main.jsx and served as JS.
import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { registerLivePreviewProxy } from "../apps/server/src/preview/preview-proxy.js";

const TOKEN = "tok_e2e";

const WORKTREE_DIR = "/data/worktrees/preview-p-e2e-1";

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
    } else if (req.url?.startsWith(`/@fs${WORKTREE_DIR}/node_modules/pdfjs-dist/build/pdf.worker.min.mjs`)) {
      // The worker file a `?url` import points at — fetched at RUNTIME by the
      // browser from a URL string, so it can only arrive here via salvage.
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(`/* pdf.worker */`);
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  });
  // Accept WebSocket upgrades like Vite's dev server does (HMR + vite-ping),
  // echoing the first requested subprotocol — enough for a real client's
  // handshake validation to pass.
  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"] ?? "";
    const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    const proto = String(req.headers["sec-websocket-protocol"] ?? "").split(",")[0]!.trim();
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        (proto ? `Sec-WebSocket-Protocol: ${proto}\r\n` : "") +
        "\r\n",
    );
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, port: (server.address() as any).port })));
}

/** Open a WebSocket and resolve "open" | "error" (never rejects). */
function wsOutcome(url: string, protocol: string): Promise<"open" | "error"> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, protocol);
    ws.addEventListener("open", () => {
      resolve("open");
      ws.close();
    });
    ws.addEventListener("error", () => resolve("error"));
  });
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
    registerLivePreviewProxy(
      app,
      (t) => (t === TOKEN ? { port: up.port, stripPrefix } : undefined),
      () => [{ token: TOKEN, dir: WORKTREE_DIR, stripPrefix }],
    );
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

  // ── salvage: token-less escapes routed back to the preview ────────────────
  // A runtime-computed URL (pdfjs-dist's workerSrc — served by Vite as
  // `export default "/@fs/…?import"`, consumed via new Worker()/import()) hits
  // the TOP origin with no /p/<token>/ prefix. It must reach the dev server —
  // never Skynet's SPA fallback (HTML where a module was expected).
  it("salvages a token-less /@fs/ request via the worktree dir baked into the path", async () => {
    const base = await boot(true);
    const res = await fetch(`${base}/@fs${WORKTREE_DIR}/node_modules/pdfjs-dist/build/pdf.worker.min.mjs?import`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(await res.text()).toContain("pdf.worker");
  });

  it("salvages a dev-namespace request via the Referer when the path embeds no dir", async () => {
    const base = await boot(true);
    const res = await fetch(`${base}/@react-refresh`, { headers: { referer: `${base}/p/${TOKEN}/` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
  });

  it("answers a dev-namespace request itself (404) when no preview resolves — never the SPA fallback", async () => {
    // No salvage candidates at all: the namespaces are dev-server-only, so the
    // proxy must own the miss (a plain 404), not let it fall through to routes
    // where the SPA fallback would answer 200 text/html — the exact "HTML where
    // a module was expected" failure class.
    const up = await fakeViteBaseSlash();
    upstream = up.server;
    app = Fastify();
    app.get("/*", async (_req, reply) => reply.type("text/html").send("<html>spa</html>")); // stand-in SPA fallback
    registerLivePreviewProxy(app, () => undefined, () => []);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const base = `http://127.0.0.1:${(app.server.address() as any).port}`;

    const res = await fetch(`${base}/@fs/data/worktrees/preview-p-other-9/node_modules/x.js`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type") ?? "").not.toContain("text/html");
    // Ordinary paths still reach the app's own routes untouched.
    const spa = await fetch(`${base}/some/spa/route`);
    expect(await spa.text()).toContain("spa");
  });
});

// ── WebSocket interception — the reload-loop killer ─────────────────────────
// A root-served preview's Vite client connects its HMR + "is the server back?"
// ping sockets at the TOP origin (its base is `/`). @fastify/websocket
// completes the websocket handshake on ANY matched route before noticing the
// route has no websocket handler — so, pre-fix, the vite-ping probe "opened"
// against the SPA fallback and Vite's client called location.reload() forever,
// about once per second. These pin the three behaviors that end that: a Vite
// socket splices through to the dev server; one that can't be routed is
// destroyed WITHOUT a handshake (open never fires); and Skynet's own /ws
// websocket route still works after the proxy takes over the upgrade event.
describe("live-preview proxy — WebSocket interception", () => {
  let app: FastifyInstance | undefined;
  let upstream: Server | undefined;
  let rawSockets: import("node:stream").Duplex[] = [];

  afterEach(async () => {
    // Spliced upgrade sockets are raw TCP pipes node no longer tracks on either
    // server (upgrade hands them off) — destroy them explicitly or close() hangs.
    for (const s of rawSockets) s.destroy();
    rawSockets = [];
    await app?.close();
    await new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r()));
    app = upstream = undefined;
  });

  async function bootWithWebsocketPlugin(candidates: () => { token: string; dir: string; stripPrefix: boolean }[]) {
    const up = await fakeViteBaseSlash();
    upstream = up.server;
    up.server.on("connection", (s) => rawSockets.push(s));
    app = Fastify();
    await app.register(fastifyWebsocket);
    app.get("/ws", { websocket: true }, (socket) => {
      socket.on("message", () => socket.send("pong"));
    });
    app.get("/*", async (_req, reply) => reply.type("text/html").send("<html>spa</html>")); // SPA stand-in — the route vite-ping used to fake-open against
    registerLivePreviewProxy(app, (t) => (t === TOKEN ? { port: up.port, stripPrefix: true } : undefined), candidates);
    await app.listen({ port: 0, host: "127.0.0.1" });
    app.server.on("connection", (s) => rawSockets.push(s));
    return `ws://127.0.0.1:${(app.server.address() as any).port}`;
  }

  it("splices a vite-ping/vite-hmr socket through to the sole root-served preview's dev server", async () => {
    const wsBase = await bootWithWebsocketPlugin(() => [{ token: TOKEN, dir: WORKTREE_DIR, stripPrefix: true }]);
    expect(await wsOutcome(`${wsBase}/?token=whatever`, "vite-ping")).toBe("open");
    expect(await wsOutcome(`${wsBase}/?token=whatever`, "vite-hmr")).toBe("open");
  });

  it("destroys an unroutable vite-ping WITHOUT a handshake — open never fires, so no reload loop", async () => {
    const wsBase = await bootWithWebsocketPlugin(() => []); // no live previews
    expect(await wsOutcome(`${wsBase}/?token=whatever`, "vite-ping")).toBe("error");
  });

  it("still delegates Skynet's own /ws route to @fastify/websocket", async () => {
    const wsBase = await bootWithWebsocketPlugin(() => [{ token: TOKEN, dir: WORKTREE_DIR, stripPrefix: true }]);
    const reply = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`${wsBase}/ws`);
      ws.addEventListener("open", () => ws.send("ping"));
      ws.addEventListener("message", (ev) => {
        resolve(String(ev.data));
        ws.close();
      });
      ws.addEventListener("error", () => reject(new Error("ws route failed")));
    });
    expect(reply).toBe("pong");
  });
});
