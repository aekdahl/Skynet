// ─── Interop REST surface ───────────────────────────────────────────────────
// A plain job-submission REST API alongside /v1/chat/completions (openai.ts):
// submit work as { projectId, text } and get a run handle back immediately —
// no blocking, no chat-message wrapper — then poll it for status/diff. For
// external tools that want structured job semantics rather than an OpenAI
// chat completion. Same bearer-token auth, scopes, and project confinement as
// /mcp (see mcp/project-scope.ts) — a project-scoped token only ever sees or
// submits work to its own projects.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  NoCapacityError,
  RunnerNotConfiguredError,
  TaskAlreadyAssignedError,
} from "../orchestrator.js";
import { NotFoundError, RunnerBusyError, type Operations } from "../operations.js";
import { projectScope } from "../mcp/project-scope.js";
import { MAX_LIST_LIMIT, summarizeRun } from "../mcp/summarize.js";

export interface InteropRestDeps {
  operations: Operations;
}

function fail(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof NotFoundError) return reply.code(404).send({ error: err.message });
  if (err instanceof NoCapacityError || err instanceof RunnerNotConfiguredError || err instanceof RunnerBusyError || err instanceof TaskAlreadyAssignedError) {
    return reply.code(409).send({ error: (err as Error).message });
  }
  return reply.code(400).send({ error: (err as Error).message });
}

const CreateRunRequest = z.object({ projectId: z.string().min(1), text: z.string().min(1) });

export async function registerInteropRest(app: FastifyInstance, deps: InteropRestDeps): Promise<void> {
  const ops = deps.operations;

  app.get("/v1/projects", async (req: FastifyRequest) => {
    const principal = req.principal!;
    const ws = principal.workspaceId;
    const access = projectScope(principal, ops, ws);
    const projects = access.filterProjects(await ops.listProjects(ws));
    return { data: projects.map((p) => ({ id: p.id, name: p.name, goal: p.goal, status: p.status })) };
  });

  app.get("/v1/runs", async (req: FastifyRequest) => {
    const principal = req.principal!;
    const ws = principal.workspaceId;
    const access = projectScope(principal, ops, ws);
    const q = req.query as { status?: string; projectId?: string; limit?: string; offset?: string };
    let runs = access.filterByProjectId(await ops.listRuns(ws));
    if (q.projectId) runs = runs.filter((r) => r.projectId === q.projectId);
    if (q.status) runs = runs.filter((r) => r.status === q.status);
    runs = runs.slice().sort((a, b) => b.lastHeartbeatAt - a.lastHeartbeatAt);
    const limit = Math.min(Math.max(parseInt(q.limit ?? "", 10) || 30, 1), MAX_LIST_LIMIT);
    const offset = Math.max(parseInt(q.offset ?? "", 10) || 0, 0);
    const page = runs.slice(offset, offset + limit);
    return { data: page.map(summarizeRun), total: runs.length, limit, offset };
  });

  app.post("/v1/runs", async (req: FastifyRequest, reply: FastifyReply) => {
    const principal = req.principal!;
    const ws = principal.workspaceId;
    const parsed = CreateRunRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const access = projectScope(principal, ops, ws);
    if (access.restricted) {
      const denied = await access.gate({ projectId: parsed.data.projectId });
      if (denied) return reply.code(403).send({ error: denied });
    }
    try {
      const task = await ops.createTask(ws, parsed.data.projectId, { text: parsed.data.text });
      const run = await ops.assignTask(ws, parsed.data.projectId, task.id);
      return reply.code(201).send({ taskId: task.id, run: summarizeRun(run) });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/v1/runs/:id", async (req, reply) => {
    const principal = req.principal!;
    const ws = principal.workspaceId;
    try {
      const run = await ops.getRun(ws, req.params.id);
      const access = projectScope(principal, ops, ws);
      if (access.restricted && access.filterByProjectId([run]).length === 0) {
        return reply.code(404).send({ error: "Run not found" });
      }
      const summary = summarizeRun(run);
      const includeDiff = (req.query as { diff?: string }).diff === "true";
      if (!includeDiff) return summary;
      const diff = await ops.runDiff(ws, run.id).catch(() => null);
      return { ...summary, diff: diff ? { files: diff.files, add: diff.add, del: diff.del } : null };
    } catch (err) {
      return fail(reply, err);
    }
  });
}
