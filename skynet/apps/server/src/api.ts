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
  MoveTaskRequest,
} from "@skynet/shared";
import { authenticate, type Principal } from "./auth.js";
import { requiresAuth } from "./auth-guard.js";
import { CommandDeniedError } from "./command-safety.js";
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
  // A denylisted command can never be approved — policy refusal, not a bad request.
  if (err instanceof CommandDeniedError) return reply.code(422).send({ error: err.message });
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
    // /mcp carries the same bearer-token principal as /api, so runs and humans
    // authenticate identically. Everything else (health, static SPA, /ws — which
    // authenticates itself) is untouched. requiresAuth() owns the decision (it
    // lowercases first so an uppercase /API/... can't skip the guard, and lets
    // /api/auth/login through as the one public route) — DEF-007.
    if (!requiresAuth(req.url)) return;
    const principal = await authenticate(req);
    if (!principal) return reply.code(401).send({ error: "Unauthorized" });
    req.principal = principal;
  });

  // ── reads (workspace-scoped) ──────────────────────────────────────────────
  app.get("/api/snapshot", (req) => ops.snapshot(ws(req)));
  app.get("/api/providers", (req) => ops.listProviders(ws(req)));
  app.get("/api/projects", (req) => ops.listProjects(ws(req)));
  app.get("/api/fleet/runners", (req) => ops.listAgents(ws(req)));
  // Decision audit trail — resolved HITL items, newest first (W8, Backend Brief §11).
  app.get("/api/audit", (req) => ops.listAudit(ws(req)));

  // Audit maintenance — archive/restore and delete, per-record and bulk. Mirrors
  // the archive (agent) and delete (project/task/runner) patterns. Records are
  // addressed by hitlId (unique per resolved decision within a workspace).
  // Bulk routes use distinct static paths so they don't collide with :hitlId.
  app.post("/api/audit/archive-all", async (req) => {
    await ops.archiveAllAudit(ws(req));
    return { ok: true };
  });
  app.delete("/api/audit", async (req) => {
    await ops.clearAudit(ws(req));
    return { ok: true };
  });
  app.post<{ Params: { hitlId: string }; Body: { archived?: boolean } }>("/api/audit/:hitlId/archive", async (req) => {
    await ops.archiveAudit(ws(req), req.params.hitlId, req.body?.archived ?? true);
    return { ok: true };
  });
  app.delete<{ Params: { hitlId: string } }>("/api/audit/:hitlId", async (req) => {
    await ops.deleteAudit(ws(req), req.params.hitlId);
    return { ok: true };
  });

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
  app.post<{ Params: { id: string } }>("/api/runs/:id/messages", async (req, reply) => {
    const body = ChatRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    try {
      const replyText = await ops.chatAgent(ws(req), req.params.id, body.data.text);
      return { reply: replyText };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/api/runs/:id/fork", async (req, reply) => {
    try {
      return await ops.forkAgent(ws(req), req.params.id);
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Archive / restore an agent (hidden from the board, kept in the store).
  app.post<{ Params: { id: string }; Body: { archived?: boolean } }>("/api/runs/:id/archive", async (req, reply) => {
    try {
      return await ops.archiveAgent(ws(req), req.params.id, req.body?.archived ?? true);
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Lifecycle controls: pause halts the runner (session kept), resume returns it
  // to running, stop is terminal (frees the runner, marks the agent done). Each
  // returns the updated agent.
  app.post<{ Params: { id: string } }>("/api/agents/:id/pause", async (req, reply) => {
    try {
      return await ops.pauseAgent(ws(req), req.params.id);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/api/agents/:id/resume", async (req, reply) => {
    try {
      return await ops.resumeAgent(ws(req), req.params.id);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/api/agents/:id/stop", async (req, reply) => {
    try {
      return await ops.stopAgent(ws(req), req.params.id);
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

  // Human kanban move (validated against the allowed-transition map).
  app.post<{ Params: { id: string; tid: string } }>("/api/projects/:id/tasks/:tid/state", async (req, reply) => {
    const body = MoveTaskRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    try {
      return await ops.transitionTask(ws(req), req.params.tid, body.data.to, req.principal!.operatorId);
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Manually promote (up) / demote (down) a task's backlog priority.
  app.post<{ Params: { id: string; tid: string }; Body: { direction?: string } }>("/api/projects/:id/tasks/:tid/move", async (req, reply) => {
    const direction = req.body?.direction;
    if (direction !== "up" && direction !== "down") return reply.code(400).send({ error: "direction must be 'up' or 'down'" });
    try {
      return await ops.moveTask(ws(req), req.params.tid, direction);
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
      return await ops.updateAgent(ws(req), req.params.id, body.data);
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
