// ─── Secrets API ──────────────────────────────────────────────────────────
// Workspace-scoped management of provider CREDENTIALS. A credential is a named
// key for a provider; the DEFAULT credential's id is the provider itself. Write-
// only by design: set/rotate/delete a key and list which credentials exist, but
// the raw key is never returned. Auth + workspace scoping come from the global
// /api onRequest hook (req.principal).
//
// The raw key only appears in a request body; it is never logged or echoed.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { CreateCredentialRequest, SetSecretRequest } from "@skynet/shared";
import { now } from "../config.js";
import { SecretsDisabledError, UnknownCredentialError, secretService, envBackedProviders } from "./service.js";

export async function registerSecretsRoutes(app: FastifyInstance): Promise<void> {
  // List configured credentials (metadata — never the keys) plus the providers
  // currently backed by a server env var (the fallback a stored default key
  // would override). Lets Settings show "via env" vs "via Settings" vs "not set".
  app.get("/api/secrets", async (req: FastifyRequest) => {
    const { workspaceId } = req.principal!;
    return { secrets: await secretService.list(workspaceId), env: envBackedProviders() };
  });

  // Create a NAMED credential (a "duplicate" of a provider) with its own key.
  app.post("/api/credentials", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = CreateCredentialRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "provider, name and apiKey are required" });
    const { workspaceId, operatorId } = req.principal!;
    try {
      const meta = await secretService.createCredential(
        workspaceId,
        body.data.provider,
        body.data.name,
        body.data.apiKey,
        operatorId,
        now(),
      );
      return reply.code(200).send({ secret: meta });
    } catch (err) {
      if (err instanceof SecretsDisabledError) return reply.code(501).send({ error: err.message });
      throw err;
    }
  });

  // Set or rotate a credential's key by id (a provider id sets that provider's
  // default credential; a `cred-…` id rotates an existing named credential).
  app.put<{ Params: { id: string } }>(
    "/api/secrets/:id",
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const body = SetSecretRequest.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "apiKey is required" });
      const { workspaceId, operatorId } = req.principal!;
      try {
        const meta = await secretService.setKey(workspaceId, req.params.id, body.data.apiKey, operatorId, now());
        return reply.code(200).send({ secret: meta });
      } catch (err) {
        if (err instanceof SecretsDisabledError) return reply.code(501).send({ error: err.message });
        if (err instanceof UnknownCredentialError) return reply.code(400).send({ error: err.message });
        throw err;
      }
    },
  );

  // Remove a credential by id (default id === provider).
  app.delete<{ Params: { id: string } }>(
    "/api/secrets/:id",
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      await secretService.delete(req.principal!.workspaceId, req.params.id);
      return reply.code(204).send();
    },
  );
}
