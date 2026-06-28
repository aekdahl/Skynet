// ─── Secrets API ──────────────────────────────────────────────────────────
// Workspace-scoped management of provider keys. Write-only by design: an
// operator can set/rotate/delete a key and list which providers are configured,
// but the raw key is never returned. Auth + workspace scoping come from the
// global /api onRequest hook (req.principal), same as every other /api route.
//
// The raw key only appears in the PUT body; it is never logged or echoed.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ProviderId, SetSecretRequest } from "@skynet/shared";
import { now } from "../config.js";
import { SecretsDisabledError, secretService, envBackedProviders } from "./service.js";

export async function registerSecretsRoutes(app: FastifyInstance): Promise<void> {
  // List configured providers (stored-key metadata — never the keys) plus the
  // providers currently backed by a server env var (the fallback a stored key
  // would override). Lets Settings show "via env" vs "via Settings" vs "not set".
  app.get("/api/secrets", async (req: FastifyRequest) => {
    const { workspaceId } = req.principal!;
    return { secrets: await secretService.list(workspaceId), env: envBackedProviders() };
  });

  // Set or rotate a provider key.
  app.put<{ Params: { provider: string } }>(
    "/api/secrets/:provider",
    async (req: FastifyRequest<{ Params: { provider: string } }>, reply: FastifyReply) => {
      const provider = ProviderId.safeParse(req.params.provider);
      if (!provider.success) return reply.code(400).send({ error: "Unknown provider" });
      const body = SetSecretRequest.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "apiKey is required" });

      const { workspaceId, operatorId } = req.principal!;
      try {
        const meta = await secretService.set(
          workspaceId,
          provider.data,
          body.data.apiKey,
          operatorId,
          now(),
        );
        return reply.code(200).send({ secret: meta });
      } catch (err) {
        if (err instanceof SecretsDisabledError) return reply.code(501).send({ error: err.message });
        throw err;
      }
    },
  );

  // Remove a provider key.
  app.delete<{ Params: { provider: string } }>(
    "/api/secrets/:provider",
    async (req: FastifyRequest<{ Params: { provider: string } }>, reply: FastifyReply) => {
      const provider = ProviderId.safeParse(req.params.provider);
      if (!provider.success) return reply.code(400).send({ error: "Unknown provider" });
      await secretService.delete(req.principal!.workspaceId, provider.data);
      return reply.code(204).send();
    },
  );
}
