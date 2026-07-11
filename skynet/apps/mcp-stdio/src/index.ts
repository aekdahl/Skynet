#!/usr/bin/env node
// ─── Skynet stdio ⇆ HTTP MCP bridge ───────────────────────────────────────
// A tiny binary that MCP clients which only speak stdio (Claude Code, Cursor,
// the desktop app's spawned server) launch to reach a running Skynet server.
// It does NOT hold its own domain state: it is a transparent JSON-RPC pump
// between a stdio transport (facing the client) and an HTTP transport (facing
// the local server's /mcp). This keeps the file store single-writer — the
// desktop app already runs the one server; we just proxy to it over loopback.
//
//   env SKYNET_MCP_URL    full URL of the /mcp endpoint (default loopback:8080)
//   env SKYNET_MCP_TOKEN  a skynet_pat_… service token (required)

import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

const URL_DEFAULT = "http://127.0.0.1:8080/mcp";

const log = (msg: string): void => void process.stderr.write(`[skynet-mcp] ${msg}\n`);

async function main(): Promise<void> {
  const url = process.env.SKYNET_MCP_URL ?? URL_DEFAULT;
  const token = process.env.SKYNET_MCP_TOKEN;
  if (!token) {
    log("SKYNET_MCP_TOKEN is required (a skynet_pat_… service token from Settings). Exiting.");
    process.exit(1);
  }

  const http = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const stdio = new StdioServerTransport();

  const onError = (err: Error): void => log(err.message);

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    void http.close();
    void stdio.close();
    process.exit(0);
  };

  // Transparent pump: forward every JSON-RPC message each way. The SDK transports
  // own framing (stdio is newline-delimited) and HTTP/SSE correlation; we only
  // wire the two message streams together.
  stdio.onmessage = (msg: JSONRPCMessage) => void http.send(msg).catch(onError);
  http.onmessage = (msg: JSONRPCMessage) => void stdio.send(msg).catch(onError);
  stdio.onclose = shutdown; // client (editor) disconnected
  http.onclose = shutdown; // server went away
  stdio.onerror = onError;
  http.onerror = onError;

  await http.start();
  await stdio.start();
  log(`bridging stdio ⇆ ${url}`);
}

main().catch((err: unknown) => {
  log(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
