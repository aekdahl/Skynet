// ─── MCP over Streamable HTTP ─────────────────────────────────────────────
// Mounts the MCP endpoint at /mcp on the same Fastify server. Stateless: each
// request builds a fresh McpServer bound to the request's principal (already
// resolved by the shared auth hook — the same bearer token humans use) and a
// throwaway transport, so there is no cross-request session state to leak
// between tenants. Long-running tool calls (wait_for_*) hold the request open
// until they resolve, then the JSON response is sent.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildMcpServer, type McpDeps } from "./tools.js";

export async function registerMcp(app: FastifyInstance, deps: McpDeps): Promise<void> {
  const handle = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    // The onRequest auth hook (api.ts) has already resolved req.principal or 401'd.
    const principal = req.principal!;
    const server = buildMcpServer(principal, deps);
    // Stateless mode: no session id, JSON responses (not SSE) for simple tool calls.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });

    // We write to the raw socket via the transport, so take the response away
    // from Fastify and tear both down when the socket closes.
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch {
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { "content-type": "application/json" });
        reply.raw.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
      }
    }
  };

  // POST carries JSON-RPC requests; GET/DELETE are handled by the transport
  // (in stateless mode a GET/DELETE with no session is answered as unsupported).
  app.post("/mcp", handle);
  app.get("/mcp", handle);
  app.delete("/mcp", handle);
}
