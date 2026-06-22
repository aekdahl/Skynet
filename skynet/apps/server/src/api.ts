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
  type Project,
  type Resolution,
  type Runner,
  type Task,
} from "@skynet/shared";
import { now } from "./config.js";
import { authenticate, type Principal } from "./auth.js";
import type { Hub } from "./hub.js";
import { NoCapacityError, type Orchestrator } from "./orchestrator.js";
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
    if (!req.url.startsWith("/api")) return;
    // Login is the one public /api route — it issues the token, so it can't
    // require one. (Path may carry a query string; match the prefix.)
    if (req.url === "/api/auth/login" || req.url.startsWith("/api/auth/login?")) return;
    const principal = await authenticate(req);
    if (!principal) return reply.code(401).send({ error: "Unauthorized" });
    req.principal = principal;
  });

  // ── reads (workspace-scoped) ──────────────────────────────────────────────
  app.get("/api/snapshot", async (req) => store.snapshot(ws(req)));
  app.get("/api/providers", async () => store.listProviders());
  app.get("/api/projects", async (req) => store.listProjects(ws(req)));
  app.get("/api/fleet/runners", async (req) => store.listRunners(ws(req)));
  // Decision audit trail — resolved HITL items, newest first (W8, Backend Brief §11).
  app.get("/api/audit", async (req) => store.listAudit(ws(req)));

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
      if (err instanceof NoCapacityError) return reply.code(409).send({ error: err.message });
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // ── projects ───────────────────────────────────────────────────────────
  app.post("/api/projects", async (req, reply) => {
    const body = CreateProjectRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    const project: Project = { id: uid("p"), workspaceId: ws(req), name: body.data.name, goal: body.data.goal, agentIds: [], status: "active" };
    return hub.upsertProject(project);
  });

  app.patch<{ Params: { id: string } }>("/api/projects/:id", async (req, reply) => {
    const body = UpdateProjectRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    const existing = await store.getProject(req.params.id);
    if (!existing || existing.workspaceId !== ws(req)) return reply.code(404).send({ error: "Project not found" });
    return hub.upsertProject({ ...existing, ...body.data });
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
      if (err instanceof NoCapacityError) return reply.code(409).send({ error: err.message });
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // ── fleet ──────────────────────────────────────────────────────────────
  app.post("/api/fleet/runners", async (req, reply) => {
    const body = ConfigureRunnerRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    const id = body.data.name ?? uid("runner");
    const runner: Runner = { id, workspaceId: ws(req), name: id, provider: body.data.provider, model: body.data.model, status: "idle", idleSince: now() };
    return hub.upsertRunner(runner);
  });

  app.patch<{ Params: { id: string } }>("/api/fleet/runners/:id", async (req, reply) => {
    const body = UpdateRunnerRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    const existing = await store.getRunner(req.params.id);
    if (!existing || existing.workspaceId !== ws(req)) return reply.code(404).send({ error: "Runner not found" });
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
