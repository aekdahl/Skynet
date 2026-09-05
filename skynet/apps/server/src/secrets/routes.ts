// ─── Secrets API ──────────────────────────────────────────────────────────
// Workspace-scoped management of provider CREDENTIALS. A credential is a named
// key for a provider; the DEFAULT credential's id is the provider itself. Write-
// only by design: set/rotate/delete a key and list which credentials exist, but
// the raw key is never returned. Auth + workspace scoping come from the global
// /api onRequest hook (req.principal).
//
// The raw key only appears in a request body; it is never logged or echoed.
// The one exception to "write-only" is /verify: it uses the stored key for a
// single outbound call to the vendor and returns only {ok, message} — never
// the key itself (see secrets/verify.ts).

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { CreateCredentialRequest, PauseCredentialRequest, SetOrgOwnedRequest, SetSecretRequest } from "@skynet/shared";
import { now } from "../config.js";
import type { Operations } from "../operations.js";
import { SecretsDisabledError, UnknownCredentialError, InvalidEndpointError, secretService, envBackedProviders } from "./service.js";

export async function registerSecretsRoutes(app: FastifyInstance, operations: Operations): Promise<void> {
  // List configured credentials (metadata — never the keys) plus the providers
  // currently backed by a server env var (the fallback a stored default key
  // would override). Lets Settings show "via env" vs "via Settings" vs "not set".
  app.get("/api/secrets", async (req: FastifyRequest) => {
    const { workspaceId } = req.principal!;
    return { secrets: await secretService.list(workspaceId), env: envBackedProviders() };
  });

  // Credential lifecycle log (created/rotated/removed, who + when — never the
  // key) — answers "why did this provider suddenly show not connected".
  app.get("/api/secrets/audit", async (req: FastifyRequest) => {
    const { workspaceId } = req.principal!;
    return { audit: await secretService.listAudit(workspaceId) };
  });

  // Create a NAMED credential (a "duplicate" of a provider) with its own key.
  app.post("/api/credentials", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = CreateCredentialRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "provider, name and apiKey are required" });
    const { workspaceId, operatorId } = req.principal!;
    // Onboarding telemetry (PMF v1.5) — read BEFORE the write, so this tells
    // us whether the workspace had ANY credential at all, not just this one.
    const hadAnySecretBefore = (await secretService.list(workspaceId)).length > 0;
    try {
      const meta = await secretService.createCredential(
        workspaceId,
        body.data.provider,
        body.data.name,
        body.data.apiKey,
        operatorId,
        now(),
        body.data.baseUrl,
      );
      if (!hadAnySecretBefore) void operations.recordTelemetryMilestone(workspaceId, "key_added");
      return reply.code(200).send({ secret: meta });
    } catch (err) {
      if (err instanceof SecretsDisabledError) return reply.code(501).send({ error: err.message });
      if (err instanceof InvalidEndpointError) return reply.code(400).send({ error: err.message });
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
      // Same "before" check as createCredential above — a rotation of an
      // EXISTING credential must never re-fire this, only a workspace's
      // genuinely first-ever key.
      const hadAnySecretBefore = (await secretService.list(workspaceId)).length > 0;
      try {
        const meta = await secretService.setKey(workspaceId, req.params.id, body.data.apiKey, operatorId, now(), body.data.baseUrl);
        if (!hadAnySecretBefore) void operations.recordTelemetryMilestone(workspaceId, "key_added");
        return reply.code(200).send({ secret: meta });
      } catch (err) {
        if (err instanceof SecretsDisabledError) return reply.code(501).send({ error: err.message });
        if (err instanceof UnknownCredentialError) return reply.code(400).send({ error: err.message });
        if (err instanceof InvalidEndpointError) return reply.code(400).send({ error: err.message });
        throw err;
      }
    },
  );

  // Remove a credential by id (default id === provider).
  app.delete<{ Params: { id: string } }>(
    "/api/secrets/:id",
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { workspaceId, operatorId } = req.principal!;
      await secretService.delete(workspaceId, req.params.id, operatorId, now());
      return reply.code(204).send();
    },
  );

  // Set/clear the org-owned governance flag (Keys & Budget panel) — an
  // operator's explicit correction, never auto-detected (see SecretMeta.orgOwned).
  app.post<{ Params: { id: string } }>(
    "/api/credentials/:id/org-owned",
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const body = SetOrgOwnedRequest.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "orgOwned (boolean) is required" });
      const { workspaceId, operatorId } = req.principal!;
      try {
        return reply.code(200).send({ secret: await secretService.setOrgOwned(workspaceId, req.params.id, body.data.orgOwned, operatorId, now()) });
      } catch (err) {
        if (err instanceof SecretsDisabledError) return reply.code(501).send({ error: err.message });
        if (err instanceof UnknownCredentialError) return reply.code(404).send({ error: err.message });
        throw err;
      }
    },
  );

  // Live-verify a credential's key against its vendor (a real, cheap call —
  // never a generation). Never gates the save that already happened; this is
  // feedback only, so a failed verify still returns 200 with {ok: false}.
  app.post<{ Params: { id: string } }>(
    "/api/credentials/:id/verify",
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { workspaceId } = req.principal!;
      try {
        return reply.code(200).send(await secretService.verify(workspaceId, req.params.id));
      } catch (err) {
        if (err instanceof SecretsDisabledError) return reply.code(501).send({ error: err.message });
        if (err instanceof UnknownCredentialError) return reply.code(404).send({ error: err.message });
        throw err;
      }
    },
  );

  // Bench a credential: no runner on it gets new work, and every run already on
  // it is stopped and its task released. Both halves matter — see
  // Operations.pauseCredential.
  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    "/api/credentials/:id/pause",
    async (req: FastifyRequest<{ Params: { id: string }; Body: { reason?: string } }>, reply: FastifyReply) => {
      const body = PauseCredentialRequest.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "a reason is required to pause a credential" });
      const { workspaceId, operatorId } = req.principal!;
      try {
        return reply.code(200).send(await operations.pauseCredential(workspaceId, req.params.id, body.data.reason, operatorId));
      } catch (err) {
        if (err instanceof SecretsDisabledError) return reply.code(501).send({ error: err.message });
        if (err instanceof UnknownCredentialError) return reply.code(404).send({ error: err.message });
        throw err;
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/credentials/:id/resume",
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { workspaceId, operatorId } = req.principal!;
      try {
        return reply.code(200).send({ secret: await operations.resumeCredential(workspaceId, req.params.id, operatorId) });
      } catch (err) {
        if (err instanceof SecretsDisabledError) return reply.code(501).send({ error: err.message });
        if (err instanceof UnknownCredentialError) return reply.code(404).send({ error: err.message });
        throw err;
      }
    },
  );

  // Smoke-test a credential by running ONE tiny real task through the agent
  // loop on it. Verify proves a key authenticates; this proves the endpoint can
  // actually drive Skynet — tool calls the gate can intercept, tool results fed
  // back, streamed output, metered usage. Costs a fraction of a cent, so it is
  // operator-triggered only and never runs on its own.
  app.post<{ Params: { id: string }; Body: { model?: string } }>(
    "/api/credentials/:id/smoke",
    async (req: FastifyRequest<{ Params: { id: string }; Body: { model?: string } }>, reply: FastifyReply) => {
      const { workspaceId } = req.principal!;
      try {
        return reply.code(200).send(await secretService.smokeTest(workspaceId, req.params.id, req.body?.model));
      } catch (err) {
        if (err instanceof SecretsDisabledError) return reply.code(501).send({ error: err.message });
        if (err instanceof UnknownCredentialError) return reply.code(404).send({ error: err.message });
        throw err;
      }
    },
  );
}
