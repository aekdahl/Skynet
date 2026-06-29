// ─── GitHub API ───────────────────────────────────────────────────────────
// Workspace-scoped management of the GitHub connection + safety policy. Auth +
// workspace scoping come from the global /api onRequest hook (req.principal),
// same as every other /api route. No secrets cross this boundary — the App key
// is server-side only; this stores installation metadata + the policy.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ConnectGithubRequest, ConnectPatRequest, SAFETY_DEFAULTS, UpdateSafetyRequest, type GithubConnection } from "@skynet/shared";
import { config } from "../config.js";
import { githubService } from "./service.js";
import { pollDeviceToken, startDeviceFlow } from "./device-flow.js";

// The connection a workspace sees when nothing is configured yet.
const empty = (workspaceId: string): GithubConnection => ({
  workspaceId,
  connected: false,
  auth: "app",
  installation: null,
  tokenLast4: null,
  repos: [],
  safety: { ...SAFETY_DEFAULTS },
});

export async function registerGithubRoutes(app: FastifyInstance): Promise<void> {
  // Current connection (+ whether the server App is configured at all).
  app.get("/api/github", async (req: FastifyRequest) => {
    const { workspaceId } = req.principal!;
    const connection = (await githubService.get(workspaceId)) ?? empty(workspaceId);
    // appConfigured = local App key; brokerConfigured = cloud broker + device flow.
    return { connection, appConfigured: githubService.appConfigured, brokerConfigured: !!config.githubClientId };
  });

  // Broker mode: list the user's App installations, then a chosen installation's
  // repos (both via the sealed Device-Flow user token).
  app.get("/api/github/installations", async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      return { installations: await githubService.listInstallations(req.principal!.workspaceId) };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
  app.get<{ Params: { id: string } }>("/api/github/installations/:id/repos", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return reply.code(400).send({ error: "bad installation id" });
    try {
      return { repos: await githubService.listInstallationRepos(req.principal!.workspaceId, id) };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // Record an installation after the App is installed on GitHub.
  app.put("/api/github", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = ConnectGithubRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    const conn = await githubService.connect(req.principal!.workspaceId, body.data.installation, body.data.repos);
    return reply.code(200).send({ connection: conn });
  });

  // Connect via a personal access token (local/desktop path — no App needed).
  // Validates + seals the token server-side and lists the repos it can access.
  app.put("/api/github/pat", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = ConnectPatRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    try {
      const conn = await githubService.connectViaPat(req.principal!.workspaceId, body.data.token);
      return reply.code(200).send({ connection: conn });
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // ── Device Flow (Phase 2: GitHub App via cloud broker) ────────────────────
  // Start: get a user code to show + a device code to poll with.
  app.post("/api/github/device/start", async (_req: FastifyRequest, reply: FastifyReply) => {
    if (!config.githubClientId) return reply.code(501).send({ error: "GitHub Device Flow is not configured (GITHUB_CLIENT_ID unset)" });
    try {
      const code = await startDeviceFlow(config.githubClientId);
      return reply.code(200).send(code);
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  // Poll: when authorized, seal the user token server-side. The caller then
  // selects an installation and records it via PUT /api/github.
  app.post<{ Body: { device_code?: string } }>("/api/github/device/poll", async (req, reply) => {
    if (!config.githubClientId) return reply.code(501).send({ error: "GitHub Device Flow is not configured" });
    const deviceCode = req.body?.device_code;
    if (!deviceCode) return reply.code(400).send({ error: "device_code is required" });
    try {
      const token = await pollDeviceToken(config.githubClientId, deviceCode);
      if (!token) return reply.code(200).send({ authorized: false });
      await githubService.storeUserToken(req.principal!.workspaceId, token);
      return reply.code(200).send({ authorized: true });
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // Update the safety guardrails (any subset).
  app.put("/api/github/safety", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = UpdateSafetyRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    const conn = await githubService.updateSafety(req.principal!.workspaceId, body.data);
    if (!conn) return reply.code(404).send({ error: "GitHub is not connected" });
    return reply.code(200).send({ connection: conn });
  });

  // Disconnect / forget the installation for this workspace.
  app.delete("/api/github", async (req: FastifyRequest, reply: FastifyReply) => {
    await githubService.disconnect(req.principal!.workspaceId);
    return reply.code(204).send();
  });
}
