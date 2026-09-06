// ─── Opt-in network-egress allowlist proxy ─────────────────────────────────
// Companion to sandbox.ts's OS write-confinement: that module leaves the
// network fully open ("the agent can still reach its model API"). This module
// closes that gap for an operator who wants it, by starting a local
// HTTP(S)-forward proxy that only lets a CLI runner's traffic through to an
// explicitly allowlisted set of hostnames — everything else gets a 403 and
// never reaches the network.
//
// Opt-in via SKYNET_RUNNER_EGRESS_ALLOWLIST, a comma-separated hostname list
// (e.g. "api.anthropic.com,github.com"). Blank/unset = fully open, exactly
// today's behavior. Deliberately ships with NO curated default list: this
// codebase can't verify every vendor CLI's and package manager's real
// endpoints, and a wrong/incomplete allowlist silently breaks a run — a worse
// failure mode than the current fully-open network. An operator turning this
// on supplies the hosts themselves.
//
// Same "best-effort guardrail" posture as sandbox.ts, and for the same
// reason: this only restricts traffic that goes through the proxy via the
// HTTP_PROXY/HTTPS_PROXY env vars, which is every vendor CLI observed in this
// codebase (all built on Node/Go HTTP clients that respect them) but is NOT
// an OS-level network boundary — a process that ignores those env vars, or
// resolves and connects to an IP directly, is not stopped. Not a security
// boundary against a hostile agent; a guardrail for a well-meaning one.
//
// One proxy instance per Skynet server process, shared across every
// concurrently-spawned runner (not one per run) — see egressProxyEnv.

import * as http from "node:http";
import * as net from "node:net";
import type { Duplex } from "node:stream";

/** Parse SKYNET_RUNNER_EGRESS_ALLOWLIST into a lowercase hostname set, or
 *  undefined when unset/blank (= disabled, network stays fully open). */
export function parseAllowlist(): Set<string> | undefined {
  const raw = process.env.SKYNET_RUNNER_EGRESS_ALLOWLIST;
  if (!raw || !raw.trim()) return undefined;
  const hosts = raw
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return hosts.length > 0 ? new Set(hosts) : undefined;
}

export function egressAllowlistEnabled(): boolean {
  return parseAllowlist() !== undefined;
}

/** Split a CONNECT target (`host:port` or `[::1]:port`) into a bare host and
 *  a port, defaulting the port when absent. IPv6 literals arrive bracketed
 *  per RFC 3986 — the brackets are stripped from the returned host, both for
 *  the allowlist check (a human writes an allowlist entry as `::1`, not
 *  `[::1]`) and because net.connect's `host` option wants the bare address. */
export function splitHostPort(value: string, defaultPort: number): { host: string; port: number } {
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end === -1) return { host: value.slice(1), port: defaultPort };
    const rest = value.slice(end + 1); // "" or ":port"
    const port = rest.startsWith(":") ? Number(rest.slice(1)) : NaN;
    return { host: value.slice(1, end), port: port || defaultPort };
  }
  const i = value.lastIndexOf(":");
  if (i === -1) return { host: value, port: defaultPort };
  return { host: value.slice(0, i), port: Number(value.slice(i + 1)) || defaultPort };
}

export class EgressProxy {
  private server: http.Server;
  private port?: number;

  constructor(
    private allowed: Set<string>,
    // Fixed at construction, not per-caller: this proxy is shared across every
    // concurrently-spawned runner (see egressProxyEnv), and a blocked
    // connection can't be attributed to any ONE of them after the fact — so
    // this reports to the SERVER's own log, not a specific run's activity
    // feed. An operator debugging a blocked request finds it in server logs.
    private onBlocked: (host: string) => void = (host) => console.error(`[egress-proxy] blocked disallowed host: ${host}`),
  ) {
    this.server = http.createServer((req, res) => this.handleHttp(req, res));
    this.server.on("connect", (req, clientSocket, head) => this.handleConnect(req, clientSocket, head));
    // A malformed/aborted client connection is an ordinary network event for
    // a proxy, not a server bug — never let it crash the process.
    this.server.on("clientError", (_err, socket) => {
      if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    });
  }

  /** IPv6 literals arrive bracketed (`[::1]`, per RFC 3986 / WHATWG URL); an
   *  allowlist entry is written unbracketed (`::1`) the way a human names an
   *  IPv6 host, so the comparison strips brackets on whichever side has them. */
  private isAllowed(host: string): boolean {
    const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
    return this.allowed.has(bare.toLowerCase());
  }

  /** Plain HTTP proxying: `GET http://host/path HTTP/1.1`. Uncommon in
   *  practice (nearly everything a runner talks to is HTTPS, handled by
   *  `handleConnect` instead) but implemented for symmetry/completeness. */
  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    let target: URL;
    try {
      // A real HTTP proxy request's url is absolute; a plain GET to the
      // proxy's own root (e.g. a health check) is not — reject it as
      // "not a proxy request" rather than crashing on the URL parse.
      target = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end("not a proxy request");
      return;
    }
    if (!this.isAllowed(target.hostname)) {
      this.onBlocked(target.hostname);
      res.writeHead(403, { "Content-Type": "text/plain" }).end(`egress blocked: ${target.hostname} is not on the allowlist`);
      return;
    }
    // URL.hostname keeps IPv6 brackets; http.request's `hostname` wants the
    // bare address (matching net.connect's convention in handleConnect).
    const { host: bareHostname } = splitHostPort(target.hostname, 0);
    const upstream = http.request(
      { hostname: bareHostname, port: target.port || 80, path: target.pathname + target.search, method: req.method, headers: req.headers },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", () => res.destroy());
    req.pipe(upstream);
  }

  /** HTTPS proxying via CONNECT tunneling — the path every vendor CLI's TLS
   *  traffic actually takes. We only ever see the target host:port (the TLS
   *  handshake itself is opaque to us, which is the point of a tunnel), so
   *  the allowlist check is on the CONNECT target, then the two sockets are
   *  spliced together verbatim. */
  // `http.Server`'s "connect" event types the socket as the generic
  // `stream.Duplex` (it's a real net.Socket at runtime, but @types/node
  // doesn't narrow it) — every method used below (write/pipe/end/destroy/on)
  // is on Duplex already, so no cast is needed.
  private handleConnect(req: http.IncomingMessage, clientSocket: Duplex, head: Buffer): void {
    const { host, port } = splitHostPort(req.url ?? "", 443);
    if (!this.isAllowed(host)) {
      this.onBlocked(host);
      clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = net.connect(port, host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  }

  /** Bind to an ephemeral localhost port (never beyond 127.0.0.1 — this is a
   *  process-local tunnel, not a shared network service) and resolve once
   *  actually listening. */
  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        const addr = this.server.address();
        this.port = typeof addr === "object" && addr ? addr.port : undefined;
        if (!this.port) {
          reject(new Error("egress proxy bound but reported no port"));
          return;
        }
        resolve(this.port);
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

// One proxy per server process, started lazily on first use and reused for
// every subsequent runner spawn — matches how RedisBus/RedisSessionStore are
// singletons per process rather than per-call. A restart (e.g. the allowlist
// env var changed) requires restarting the server process, same as any other
// config read once at boot elsewhere in this codebase.
let shared: Promise<{ proxy: EgressProxy; port: number }> | undefined;

/**
 * When SKYNET_RUNNER_EGRESS_ALLOWLIST is set, ensures the shared proxy is
 * running and returns the HTTP_PROXY/HTTPS_PROXY env vars a spawned child
 * should get. Returns undefined when disabled (today's fully-open behavior).
 * A blocked attempt logs to the server's own log (console.error), not a
 * specific run's activity feed — the proxy is shared across every
 * concurrently-spawned runner, so a blocked connection can't be reliably
 * attributed to any one of them after the fact.
 */
export async function egressProxyEnv(): Promise<Record<string, string> | undefined> {
  const allowlist = parseAllowlist();
  if (!allowlist) return undefined;
  if (!shared) {
    const proxy = new EgressProxy(allowlist);
    shared = proxy.start().then((port) => ({ proxy, port }));
  }
  const { port } = await shared;
  const url = `http://127.0.0.1:${port}`;
  return { HTTP_PROXY: url, HTTPS_PROXY: url };
}

/** Test-only: drop the shared instance so a fresh allowlist takes effect. */
export async function resetSharedEgressProxyForTests(): Promise<void> {
  if (!shared) return;
  const { proxy } = await shared;
  await proxy.stop();
  shared = undefined;
}
