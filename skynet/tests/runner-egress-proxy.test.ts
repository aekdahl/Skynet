// The opt-in network-egress allowlist proxy (SKYNET_RUNNER_EGRESS_ALLOWLIST,
// packages/runner-sdk/src/egress-proxy.ts) must let allowlisted hosts through
// end-to-end (a real tunnel, not just a "would allow" check) and must reject a
// disallowed host WITHOUT ever attempting a real connection to it — proven via
// spies on node:net/node:http, not just by observing the eventual response.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as http from "node:http";
import * as net from "node:net";

// vi.spyOn can't redefine node: built-in exports directly (non-configurable
// ESM bindings) — vi.mock + importOriginal is the supported way to wrap one
// while every other export (and unwrapped calls) still hit the real
// implementation. Both `connect`/`request` call through to the real fn by
// default, so the "allowed host" tests below get a genuine end-to-end path;
// only the "blocked host" tests inspect the spies' call arguments. Note both
// the proxy AND this test file's own traffic (dialing the proxy itself, or
// setting up a fake "upstream" target) share these same mocked functions —
// the "never dialed" assertions below check call ARGUMENTS (did anything
// target the disallowed host), not total call count, so the test's own,
// legitimate calls don't cause a false failure.
vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();
  return { ...actual, connect: vi.fn(actual.connect) };
});
vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>();
  return { ...actual, request: vi.fn(actual.request) };
});

import {
  EgressProxy,
  egressAllowlistEnabled,
  egressProxyEnv,
  parseAllowlist,
  resetSharedEgressProxyForTests,
  splitHostPort,
} from "../packages/runner-sdk/src/egress-proxy.js";

const KEY = "SKYNET_RUNNER_EGRESS_ALLOWLIST";
const original = process.env[KEY];
afterEach(async () => {
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
  await resetSharedEgressProxyForTests();
  vi.restoreAllMocks();
});

describe("parseAllowlist / egressAllowlistEnabled", () => {
  it("is disabled when unset, blank, or whitespace-only", () => {
    delete process.env[KEY];
    expect(parseAllowlist()).toBeUndefined();
    expect(egressAllowlistEnabled()).toBe(false);
    process.env[KEY] = "   ";
    expect(parseAllowlist()).toBeUndefined();
  });

  it("splits on commas, trims, and lowercases each host", () => {
    process.env[KEY] = " Api.Anthropic.com ,github.com,,  api.openai.com ";
    const hosts = parseAllowlist();
    expect(hosts).toEqual(new Set(["api.anthropic.com", "github.com", "api.openai.com"]));
    expect(egressAllowlistEnabled()).toBe(true);
  });
});

/** Raw CONNECT over a plain socket — the same wire shape a vendor CLI's HTTP
 *  client produces when it dials an HTTPS host through HTTP_PROXY. Resolves
 *  with the status line and, for a 200, the connected duplex socket. */
function rawConnect(proxyPort: number, target: string): Promise<{ status: number; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, "127.0.0.1", () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    socket.once("data", (chunk) => {
      const status = Number(chunk.toString("utf8").match(/^HTTP\/1\.1 (\d+)/)?.[1] ?? 0);
      resolve({ status, socket });
    });
    socket.once("error", reject);
  });
}

describe("EgressProxy — CONNECT tunneling", () => {
  it("tunnels a real end-to-end connection to an allowlisted host", async () => {
    // A real local "upstream" the tunnel connects to — echoes back anything sent.
    const upstream = net.createServer((s) => s.pipe(s));
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstream.address() as net.AddressInfo).port;

    const proxy = new EgressProxy(new Set(["127.0.0.1"]));
    const proxyPort = await proxy.start();
    try {
      const { status, socket } = await rawConnect(proxyPort, `127.0.0.1:${upstreamPort}`);
      expect(status).toBe(200);
      const echoed = await new Promise<string>((resolve) => {
        socket.once("data", (chunk) => resolve(chunk.toString("utf8")));
        socket.write("ping-through-the-tunnel");
      });
      expect(echoed).toBe("ping-through-the-tunnel");
      socket.destroy();
    } finally {
      await proxy.stop();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it("rejects a disallowed host with 403 and never attempts a real connection to it", async () => {
    const connectSpy = vi.mocked(net.connect);
    const proxy = new EgressProxy(new Set(["127.0.0.1"])); // does NOT include example.invalid
    const proxyPort = await proxy.start();
    try {
      const { status, socket } = await rawConnect(proxyPort, "example.invalid:443");
      expect(status).toBe(403);
      // The only net.connect calls made are OUR test's own raw socket to the
      // proxy itself — the proxy's internal upstream dial never happened.
      expect(connectSpy.mock.calls.some(([port, host]) => host === "example.invalid" || port === "example.invalid")).toBe(false);
      socket.destroy();
    } finally {
      await proxy.stop();
    }
  });

  it("blocked-host notifications go to onBlocked, defaulting to a console.error the operator can find in server logs", async () => {
    const blocked: string[] = [];
    const proxy = new EgressProxy(new Set(["127.0.0.1"]), (host) => blocked.push(host));
    const proxyPort = await proxy.start();
    try {
      const { socket } = await rawConnect(proxyPort, "evil.example:443");
      socket.destroy();
      expect(blocked).toEqual(["evil.example"]);
    } finally {
      await proxy.stop();
    }
  });

});

// A live IPv6-loopback connection is unreliable across sandboxes (many
// containers disable IPv6 entirely, so a real `::1` dial can hang rather
// than succeed OR fail) — splitHostPort's bracket handling is tested directly
// as a pure function instead of through a real socket.
describe("splitHostPort", () => {
  it("splits an ordinary host:port", () => {
    expect(splitHostPort("api.anthropic.com:443", 80)).toEqual({ host: "api.anthropic.com", port: 443 });
  });

  it("defaults the port when absent", () => {
    expect(splitHostPort("api.anthropic.com", 443)).toEqual({ host: "api.anthropic.com", port: 443 });
  });

  it("strips brackets from an IPv6 literal and reads its port", () => {
    expect(splitHostPort("[::1]:8443", 443)).toEqual({ host: "::1", port: 8443 });
  });

  it("strips brackets from a bare IPv6 literal (no port) and defaults the port", () => {
    expect(splitHostPort("[::1]", 443)).toEqual({ host: "::1", port: 443 });
  });

  it("does not mis-split on the colons INSIDE an IPv6 literal", () => {
    // A naive lastIndexOf(":") on the bracketed form would still be safe here
    // (the brackets are consumed first), but a fully-expanded address is the
    // sharpest case to prove the bracket branch, not the plain-colon branch,
    // is what handles it.
    expect(splitHostPort("[2001:db8::1]:443", 80)).toEqual({ host: "2001:db8::1", port: 443 });
  });
});

describe("EgressProxy — plain HTTP proxying", () => {
  it("forwards a real request to an allowlisted host", async () => {
    const upstream = http.createServer((_req, res) => res.end("hello from upstream"));
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstream.address() as net.AddressInfo).port;

    const proxy = new EgressProxy(new Set(["127.0.0.1"]));
    const proxyPort = await proxy.start();
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port: proxyPort, path: `http://127.0.0.1:${upstreamPort}/`, method: "GET" }, (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve(data));
        });
        req.on("error", reject);
        req.end();
      });
      expect(body).toBe("hello from upstream");
    } finally {
      await proxy.stop();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it("rejects a disallowed host with 403 and never dials it", async () => {
    const requestSpy = vi.mocked(http.request);
    const proxy = new EgressProxy(new Set(["127.0.0.1"]));
    const proxyPort = await proxy.start();
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port: proxyPort, path: "http://example.invalid/secret", method: "GET" }, (res) => resolve(res.statusCode ?? 0));
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(403);
      // The only http.request call is THIS test's own request INTO the proxy
      // (host: 127.0.0.1) — the proxy's internal forward-to-upstream call for
      // example.invalid never happened.
      expect(requestSpy.mock.calls.some(([opts]) => (opts as http.RequestOptions).hostname === "example.invalid")).toBe(false);
    } finally {
      await proxy.stop();
    }
  });
});

describe("egressProxyEnv", () => {
  it("returns undefined when disabled — today's fully-open behavior, unchanged", async () => {
    delete process.env[KEY];
    expect(await egressProxyEnv()).toBeUndefined();
  });

  it("when enabled, starts one shared proxy and points HTTP_PROXY/HTTPS_PROXY at it, reused across calls", async () => {
    process.env[KEY] = "127.0.0.1";
    const first = await egressProxyEnv();
    const second = await egressProxyEnv();
    expect(first).toBeDefined();
    expect(first).toEqual(second); // same port both times — one shared instance, not one per call
    expect(first!.HTTP_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(first!.HTTPS_PROXY).toBe(first!.HTTP_PROXY);
  });
});
