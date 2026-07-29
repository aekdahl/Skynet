// The preview reverse proxy makes a running preview reachable through Skynet's
// own URL (phone/remote) at `/p/<token>/…`. These drive the REAL route against a
// fake upstream "dev server": token → forward, strip-prefix + <base> injection
// for a root-served app, full-path passthrough for a vite (basePath) app, and a
// 404 for an unknown/expired token (the path token is the only secret).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createServer, type Server } from "node:http";
import { registerPreviewProxy } from "../apps/server/src/preview/proxy.js";

let upstream: Server;
let upstreamPort: number;
let app: FastifyInstance;
let appUrl: string;

// Fake resolver: "root" serves at / (strip + inject), "vite" serves under its
// base (full-path passthrough), anything else is unknown.
const resolver = {
  proxyTarget(token: string) {
    if (token === "root") return { port: upstreamPort };
    if (token === "vite") return { port: upstreamPort, basePath: "/p/vite/" };
    return null;
  },
};

beforeAll(async () => {
  // Upstream echoes the path it received; serves HTML at the root paths.
  upstream = createServer((req, res) => {
    if (req.url === "/" || req.url === "/p/vite/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><head><title>App</title></head><body>hello</body></html>");
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`GOT ${req.url}`);
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamPort = (upstream.address() as { port: number }).port;

  app = Fastify();
  registerPreviewProxy(app, resolver);
  appUrl = await app.listen({ port: 0, host: "127.0.0.1" });
});

afterAll(async () => {
  await app.close();
  await new Promise<void>((r) => upstream.close(() => r()));
});

describe("preview reverse proxy (/p/:token)", () => {
  it("forwards to the live preview and injects <base> for a root-served app", async () => {
    const res = await fetch(`${appUrl}/p/root/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<base href="/p/root/">'); // relative assets now resolve under the prefix
    expect(html).toContain("hello");
  });

  it("strips the /p/<token> prefix so the dev server sees a root path", async () => {
    const res = await fetch(`${appUrl}/p/root/assets/app.js?v=1`);
    expect(await res.text()).toBe("GOT /assets/app.js?v=1");
  });

  it("passes the FULL path through for a vite (basePath) preview — no strip, no rewrite", async () => {
    // index at the base is HTML but must NOT be rewritten (vite already has the base).
    const idx = await fetch(`${appUrl}/p/vite/`);
    expect(await idx.text()).not.toContain("<base");
    const asset = await fetch(`${appUrl}/p/vite/assets/x.js`);
    expect(await asset.text()).toBe("GOT /p/vite/assets/x.js");
  });

  it("404s an unknown / expired token (the token is the only secret)", async () => {
    const res = await fetch(`${appUrl}/p/nope/`);
    expect(res.status).toBe(404);
    expect(await res.text()).toMatch(/not running/i);
  });
});
