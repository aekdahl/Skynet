// ─── Custom MCP servers API ───────────────────────────────────────────────
// Workspace-scoped management of an operator's custom MCP server configs (the
// "scoped tools" roadmap "Tools via MCP" gives an agent). Write-only by
// design: add/remove a server and list which ones exist, but a stored env/
// header VALUE is never returned. Auth + workspace scoping come from the
// global /api onRequest hook (req.principal) — same as ../secrets/routes.ts.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { CreateMcpServerRequest } from "@skynet/shared";
import { now } from "../config.js";
import { McpServersDisabledError, ReservedMcpServerNameError, mcpServerService } from "./service.js";

export async function registerMcpServerRoutes(app: FastifyInstance): Promise<void> {
  // List configured custom MCP servers (metadata only — never secret values).
  app.get("/api/mcp-servers", async (req: FastifyRequest) => {
    const { workspaceId } = req.principal!;
    return { servers: await mcpServerService.list(workspaceId) };
  });

  // Add a custom MCP server (stdio command/args/env, or a remote url/headers).
  app.post("/api/mcp-servers", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = CreateMcpServerRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "name and a stdio command or remote url are required" });
    const { workspaceId, operatorId } = req.principal!;
    try {
      const server = await mcpServerService.create(workspaceId, body.data, operatorId, now());
      return reply.code(200).send({ server });
    } catch (err) {
      if (err instanceof McpServersDisabledError) return reply.code(501).send({ error: err.message });
      if (err instanceof ReservedMcpServerNameError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  // Remove a custom MCP server. No edit/rotate endpoint — remove and re-add
  // to change one (same add/remove-only UX as GithubAccounts/FlyAccounts).
  app.delete<{ Params: { id: string } }>(
    "/api/mcp-servers/:id",
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { workspaceId } = req.principal!;
      await mcpServerService.delete(workspaceId, req.params.id);
      return reply.code(204).send();
    },
  );
}
