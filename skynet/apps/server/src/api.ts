// ─── HTTP / RPC API ───────────────────────────────────────────────────────
// The endpoints behind the frontend handlers (Frontend Brief §08, Backend
// Brief §08). Every /api route is scoped to the caller's workspace (resolved
// from a token) and delegates the domain work to Operations — the shared
// service layer the MCP server also uses, so the human and agent surfaces can
// never drift. This file owns only the HTTP concerns: auth, input validation,
// and mapping typed errors to status codes.

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
} from "@skynet/shared";
import { authenticate, type Principal } from "./auth.js";
import { NoCapacityError, RunnerNotConfiguredError, TaskAlreadyAssignedError } from "./orchestrator.js";
import { NotFoundError, type Operations, RunnerBusyError } from "./operations.js";

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export interface ApiDeps {
  operations: Operations;
}

const ws = (req: FastifyRequest) => req.principal!.workspaceId;

/** Map a typed operation error to the right HTTP status. */
function fail(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof NotFoundError) return reply.code(404).send({ error: err.message });
  if (
    err instanceof NoCapacityError ||
    err instanceof TaskAlreadyAssignedError ||
    err instanceof RunnerNotConfiguredError ||
    err instanceof RunnerBusyError
  ) {
    return reply.code(409).send({ error: (err as Error).message });
  }
  return reply.code(400).send({ error: (err as Error).message });
}

export async function registerApi(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const ops = deps.operations;

  // ── auth: every /api and /mcp route resolves a workspace-scoped principal ──
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    // /mcp carries the same bearer-token principal as /api, so agents and humans
    // authenticate identically. Everything else (health, static SPA, /ws — which
    // authenticates itself) is untouched. Lowercase first so an uppercase
    // /API/... can't skip the guard (DEF-007).
    const path = req.url.toLowerCase();
    if (!path.startsWith("/api") && !path.startsWith("/mcp")) return;
    // Login is the one public /api route — it issues the token, so it can't
    // require one. (Path may carry a query string; match the prefix.)
    if (path === "/api/auth/login" || path.startsWith("/api/auth/login?")) return;
    const principal = await authenticate(req);
    if (!principal) return reply.code(401).send({ error: "Unauthorized" });
    req.principal = principal;
  });

  // ── reads (workspace-scoped) ──────────────────────────────────────────────
  app.get("/api/snapshot", (req) => ops.snapshot(ws(req)));
  app.get("/api/providers", (req) => ops.listProviders(ws(req)));
  app.get("/api/projects", (req) => ops.listProjects(ws(req)));
  app.get("/api/fleet/runners", (req) => ops.listRunners(ws(req)));
  // Decision audit trail — resolved HITL items, newest first (W8, Backend Brief §11).
  app.get("/api/audit", (req) => ops.listAudit(ws(req)));

  // ── HITL ───────────────────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>("/api/hitl/:id/resolve", async (req, reply) => {
    const body = ResolveRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    try {
      return await ops.resolveHitl(ws(req), req.params.id, body.data, req.principal!.operatorId);
    } catch (err) {
      return fail(reply, err);
    }
  });

  // ── agent actions ────────────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>("/api/agents/:id/messages", async (req, reply) => {
    const body = ChatRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    try {
      const replyText = await ops.chatAgent(ws(req), req.params.id, body.data.text);
      return { reply: replyText };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/api/agents/:id/fork", async (req, reply) => {
    try {
      return await ops.forkAgent(ws(req), req.params.id);
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Archive / restore an agent (hidden from the board, kept in the store).
  app.post<{ Params: { id: string }; Body: { archived?: boolean } }>("/api/agents/:id/archive", async (req, reply) => {
    try {
      return await ops.archiveAgent(ws(req), req.params.id, req.body?.archived ?? true);
    } catch (err) {
      return fail(reply, err);
    }
  });

  // ── projects ───────────────────────────────────────────────────────────
  app.post("/api/projects", async (req, reply) => {
    const body = CreateProjectRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    return ops.createProject(ws(req), body.data);
  });

  app.patch<{ Params: { id: string } }>("/api/projects/:id", async (req, reply) => {
    const body = UpdateProjectRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    try {
      return await ops.updateProject(ws(req), req.params.id, body.data);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/projects/:id", async (req, reply) => {
    try {
      await ops.deleteProject(ws(req), req.params.id);
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // ── tasks ──────────────────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>("/api/projects/:id/tasks", async (req, reply) => {
    const body = CreateTaskRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    try {
      return await ops.createTask(ws(req), req.params.id, body.data);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.patch<{ Params: { id: string; tid: string } }>("/api/projects/:id/tasks/:tid", async (req, reply) => {
    const body = UpdateTaskRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    try {
      return await ops.updateTask(ws(req), req.params.tid, body.data);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete<{ Params: { id: string; tid: string } }>("/api/projects/:id/tasks/:tid", async (req, reply) => {
    try {
      await ops.deleteTask(ws(req), req.params.tid);
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<{ Params: { id: string; tid: string } }>("/api/projects/:id/tasks/:tid/assign", async (req, reply) => {
    try {
      return await ops.assignTask(ws(req), req.params.id, req.params.tid);
    } catch (err) {
      return fail(reply, err);
    }
  });

  // ── fleet ──────────────────────────────────────────────────────────────
  app.post("/api/fleet/runners", async (req, reply) => {
    const body = ConfigureRunnerRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    return ops.configureRunner(ws(req), body.data);
  });

  app.patch<{ Params: { id: string } }>("/api/fleet/runners/:id", async (req, reply) => {
    const body = UpdateRunnerRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    try {
      return await ops.updateRunner(ws(req), req.params.id, body.data);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/fleet/runners/:id", async (req, reply) => {
    try {
      await ops.retireRunner(ws(req), req.params.id);
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });
}
