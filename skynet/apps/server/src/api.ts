// ─── HTTP / RPC API ───────────────────────────────────────────────────────
// The endpoints behind the frontend handlers (Frontend Brief §08, Backend
// Brief §08). Every /api route is scoped to the caller's workspace (resolved
// from a token); mutations persist + publish via the Hub, so connected
// operators of that workspace see the delta over the WS stream.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  ConfigureRunnerRequest,
  CreateProjectRequest,
  CreateTaskRequest,
  ResolveRequest,
  ChatRequest,
  UpdateProjectRequest,
  UpdateRunnerRequest,
  UpdateTaskRequest,
  modelValidForProvider,
  type Project,
  type Resolution,
  type Runner,
  type Task,
} from "@skynet/shared";
import { resolve as resolvePath } from "node:path";
import { now, config } from "./config.js";
import { listDir, isGitRepo } from "./fs-browse.js";
import { authenticate, type Principal } from "./auth.js";
import { withSecretAvailability } from "./secrets/index.js";
import type { Hub } from "./hub.js";
import { NoCapacityError, RunnerNotConfiguredError, TaskAlreadyAssignedError, type Orchestrator } from "./orchestrator.js";
import type { Store } from "./store/store.js";

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export interface ApiDeps {
  store: Store;
  hub: Hub;
  orchestrator: Orchestrator;
}

let seq = 0;
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++seq}`;
const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24);

const ws = (req: FastifyRequest) => req.principal!.workspaceId;

export async function registerApi(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const { store, hub, orchestrator } = deps;

  // ── auth: every /api route resolves a workspace-scoped principal ──────────
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    // Lowercase the path before every prefix check — the match must be
    // case-insensitive so an uppercase /API/... can't skip the guard (DEF-007).
    const path = req.url.toLowerCase();
    if (!path.startsWith("/api")) return;
    // Login is the one public /api route — it issues the token, so it can't
    // require one. (Path may carry a query string; match the prefix.)
    if (path === "/api/auth/login" || path.startsWith("/api/auth/login?")) return;
    // REST does NOT accept a ?token= query param (leaks via logs/history/Referer,
    // DEF-006): prefer the Authorization header, then the session cookie. The
    // query token is reserved for the WS handshake alone.
    const principal = await authenticate(req);
    if (!principal) return reply.code(401).send({ error: "Unauthorized" });
    req.principal = principal;
  });

  // ── reads (workspace-scoped) ──────────────────────────────────────────────
  app.get("/api/snapshot", async (req) => {
    const snap = await store.snapshot(ws(req));
    snap.providers = await withSecretAvailability(snap.providers, ws(req));
    return snap;
  });
  app.get("/api/providers", async (req) => withSecretAvailability(await store.listProviders(), ws(req)));
  app.get("/api/projects", async (req) => store.listProjects(ws(req)));
  app.get("/api/fleet/runners", async (req) => store.listRunners(ws(req)));
  // Decision audit trail — resolved HITL items, newest first (W8, Backend Brief §11).
  app.get("/api/audit", async (req) => store.listAudit(ws(req)));

  // Local folder browser powering the connect-a-folder picker. Local-only and
  // gated (config.allowLocalFs) — reveals the server machine's filesystem, so
  // it's disabled on hosted deploys. Returns 403 when off.
  app.get<{ Querystring: { path?: string } }>("/api/fs/list", async (req, reply) => {
    if (!config.allowLocalFs) return reply.code(403).send({ error: "Local folder browsing is disabled on this server" });
    return listDir(req.query.path);
  });

  // ── HITL ───────────────────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>("/api/hitl/:id/resolve", async (req, reply) => {
    const body = ResolveRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });

    const item = await store.getHitl(req.params.id);
    if (!item || item.workspaceId !== ws(req)) return reply.code(404).send({ error: "HITL item not found" });

    const resolution: Resolution = {
      action: body.data.action,
      optionIndex: body.data.optionIndex ?? null,
      guidance: body.data.guidance ?? null,
      by: req.principal!.operatorId,
      at: now(),
    };
    const resolved = await hub.resolveHitl(req.params.id, resolution);
    // Deliver to the agent & resume/merge (idempotent: only on first resolve).
    if (resolved && resolved.resolution?.at === resolution.at) {
      await orchestrator.deliver(item, resolution);
    }
    return resolved ?? item;
  });

  // ── agent actions ────────────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>("/api/agents/:id/messages", async (req, reply) => {
    const body = ChatRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    const agent = await store.getAgent(req.params.id);
    if (!agent || agent.workspaceId !== ws(req)) return reply.code(404).send({ error: "Agent not found" });
    const replyText = await orchestrator.chat(req.params.id, body.data.text);
    return { reply: replyText };
  });

  app.post<{ Params: { id: string } }>("/api/agents/:id/fork", async (req, reply) => {
    const agent = await store.getAgent(req.params.id);
    if (!agent || agent.workspaceId !== ws(req)) return reply.code(404).send({ error: "Agent not found" });
    try {
      return await orchestrator.fork(req.params.id);
    } catch (err) {
      if (err instanceof NoCapacityError || err instanceof RunnerNotConfiguredError) {
        return reply.code(409).send({ error: err.message });
      }
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // Archive / restore an agent (hidden from the board, kept in the store).
  app.post<{ Params: { id: string }; Body: { archived?: boolean } }>("/api/agents/:id/archive", async (req, reply) => {
    const agent = await store.getAgent(req.params.id);
    if (!agent || agent.workspaceId !== ws(req)) return reply.code(404).send({ error: "Agent not found" });
    const archived = req.body?.archived ?? true;
    return (await hub.setAgentArchived(req.params.id, archived)) ?? reply.code(404).send({ error: "Agent not found" });
  });

  // Lifecycle controls (agent detail view): pause / resume / stop.
  app.post<{ Params: { id: string } }>("/api/agents/:id/pause", async (req, reply) => {
    const agent = await store.getAgent(req.params.id);
    if (!agent || agent.workspaceId !== ws(req)) return reply.code(404).send({ error: "Agent not found" });
    return orchestrator.pauseAgent(req.params.id);
  });

  app.post<{ Params: { id: string } }>("/api/agents/:id/resume", async (req, reply) => {
    const agent = await store.getAgent(req.params.id);
    if (!agent || agent.workspaceId !== ws(req)) return reply.code(404).send({ error: "Agent not found" });
    return orchestrator.resumeAgent(req.params.id);
  });

  // Stop terminates the agent and frees the runner it holds (marking it done),
  // even if the agent is orphaned (no live handle after a restart) — the escape
  // hatch for a wedged agent that would otherwise pin its runner "busy" forever.
  app.post<{ Params: { id: string } }>("/api/agents/:id/stop", async (req, reply) => {
    const agent = await store.getAgent(req.params.id);
    if (!agent || agent.workspaceId !== ws(req)) return reply.code(404).send({ error: "Agent not found" });
    return orchestrator.haltAgent(req.params.id);
  });

  // ── projects ───────────────────────────────────────────────────────────
  app.post("/api/projects", async (req, reply) => {
    const body = CreateProjectRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    // A local repoPath that contains a .git is git-backed → Skynet auto-manages a
    // worktree per agent + the merge queue against it (desktop-first default).
    const repoPath = body.data.repoPath ? resolvePath(body.data.repoPath) : null;
    const project: Project = {
      id: uid("p"), workspaceId: ws(req), name: body.data.name, goal: body.data.goal,
      agentIds: [], status: "active",
      repoPath, gitBacked: repoPath ? isGitRepo(repoPath) : false,
      repo: body.data.repo,
    };
    return hub.upsertProject(project);
  });

  app.patch<{ Params: { id: string } }>("/api/projects/:id", async (req, reply) => {
    const body = UpdateProjectRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    const existing = await store.getProject(req.params.id);
    if (!existing || existing.workspaceId !== ws(req)) return reply.code(404).send({ error: "Project not found" });
    // Rebinding the local folder recomputes git-backing (null clears it).
    const rebind =
      body.data.repoPath !== undefined
        ? (() => {
            const rp = body.data.repoPath ? resolvePath(body.data.repoPath) : null;
            return { repoPath: rp, gitBacked: rp ? isGitRepo(rp) : false };
          })()
        : {};
    return hub.upsertProject({ ...existing, ...body.data, ...rebind });
  });

  app.delete<{ Params: { id: string } }>("/api/projects/:id", async (req, reply) => {
    const existing = await store.getProject(req.params.id);
    if (!existing || existing.workspaceId !== ws(req)) return reply.code(404).send({ error: "Project not found" });
    for (const agentId of existing.agentIds) await orchestrator.stopAgent(agentId);
    await hub.deleteProject(req.params.id);
    return { ok: true };
  });

  // ── tasks ──────────────────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>("/api/projects/:id/tasks", async (req, reply) => {
    const body = CreateTaskRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    const project = await store.getProject(req.params.id);
    if (!project || project.workspaceId !== ws(req)) return reply.code(404).send({ error: "Project not found" });
    const task: Task = { id: uid(`t-${slug(project.name)}`), workspaceId: ws(req), projectId: req.params.id, text: body.data.text, state: "backlog", agentId: null };
    return hub.upsertTask(task);
  });

  app.patch<{ Params: { id: string; tid: string } }>("/api/projects/:id/tasks/:tid", async (req, reply) => {
    const body = UpdateTaskRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    const task = await store.getTask(req.params.tid);
    if (!task || task.workspaceId !== ws(req)) return reply.code(404).send({ error: "Task not found" });
    return hub.upsertTask({ ...task, ...body.data });
  });

  app.delete<{ Params: { id: string; tid: string } }>("/api/projects/:id/tasks/:tid", async (req, reply) => {
    const task = await store.getTask(req.params.tid);
    if (!task || task.workspaceId !== ws(req)) return reply.code(404).send({ error: "Task not found" });
    await hub.deleteTask(req.params.tid);
    return { ok: true };
  });

  app.post<{ Params: { id: string; tid: string } }>("/api/projects/:id/tasks/:tid/assign", async (req, reply) => {
    const project = await store.getProject(req.params.id);
    if (!project || project.workspaceId !== ws(req)) return reply.code(404).send({ error: "Project not found" });
    try {
      return await orchestrator.assignTask(req.params.id, req.params.tid);
    } catch (err) {
      // DEF-003/005: a done or already-assigned task is a conflict, not a retry.
      if (
        err instanceof NoCapacityError ||
        err instanceof TaskAlreadyAssignedError ||
        err instanceof RunnerNotConfiguredError
      ) {
        return reply.code(409).send({ error: err.message });
      }
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // ── fleet ──────────────────────────────────────────────────────────────
  // A runner's model must be one the chosen provider actually offers — the
  // provider catalog (GET /api/providers) is the single source of truth, so we
  // reuse it here rather than hard-code a second copy (DEF-004).
  const validateModelForProvider = async (provider: string, model: string): Promise<string | undefined> =>
    modelValidForProvider(await store.listProviders(), provider, model);

  app.post("/api/fleet/runners", async (req, reply) => {
    const body = ConfigureRunnerRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    const invalid = await validateModelForProvider(body.data.provider, body.data.model);
    if (invalid) return reply.code(400).send({ error: invalid });
    const id = body.data.name ?? uid("runner");
    const runner: Runner = { id, workspaceId: ws(req), name: id, provider: body.data.provider, model: body.data.model, status: "idle", idleSince: now() };
    return hub.upsertRunner(runner);
  });

  app.patch<{ Params: { id: string } }>("/api/fleet/runners/:id", async (req, reply) => {
    const body = UpdateRunnerRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    const existing = await store.getRunner(req.params.id);
    if (!existing || existing.workspaceId !== ws(req)) return reply.code(404).send({ error: "Runner not found" });
    // A model change is validated against the runner's existing provider.
    if (body.data.model !== undefined) {
      const invalid = await validateModelForProvider(existing.provider, body.data.model);
      if (invalid) return reply.code(400).send({ error: invalid });
    }
    return hub.upsertRunner({ ...existing, ...body.data });
  });

  app.delete<{ Params: { id: string } }>("/api/fleet/runners/:id", async (req, reply) => {
    const existing = await store.getRunner(req.params.id);
    if (!existing || existing.workspaceId !== ws(req)) return reply.code(404).send({ error: "Runner not found" });
    // Busy-runner guard — enforced server-side (Backend Brief §04).
    if (existing.status === "busy" || orchestrator.isBusy(req.params.id)) {
      return reply.code(409).send({ error: "Cannot retire a busy runner" });
    }
    await hub.deleteRunner(req.params.id);
    return { ok: true };
  });
}
