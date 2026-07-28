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
import { readFile } from "node:fs/promises";
import { authenticate, type Principal } from "./auth.js";
import { requiresAuth } from "./auth-guard.js";
import { config, RESTART_EXIT_CODE } from "./config.js";
import { listDir } from "./fs-browse.js";
import {
  currentEnvSettings,
  envSettingsWritable,
  writeEnvSettings,
  UnknownEnvKeyError,
  InvalidEnvValueError,
} from "./settings/env-settings.js";
import { CommandDeniedError } from "./command-safety.js";
import { NoCapacityError, RunnerNotConfiguredError, TaskAlreadyAssignedError, type Orchestrator } from "./orchestrator.js";
import { NotFoundError, type Operations, RunnerBusyError } from "./operations.js";
import type { ChatTurn } from "./project-assistant.js";
import { simulateConversational } from "./telegram/index.js";
import { simulationGrade } from "./simulation/grade.js";

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export interface ApiDeps {
  operations: Operations;
  /** Used by the Telegram conversational DRY-RUN endpoint (BYOK consult). */
  orchestrator: Orchestrator;
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

  // Local folder browser powering the project folder picker. Gated by
  // config.allowLocalFs — it reveals the server machine's filesystem, so it's on
  // only outside production (desktop = server = the same machine), never hosted.
  app.get<{ Querystring: { path?: string } }>("/api/fs/list", async (req, reply) => {
    if (!config.allowLocalFs)
      return reply.code(403).send({ error: "Local folder browsing is disabled on this server" });
    return listDir(req.query.path);
  });

  // The product roadmap (ROADMAP.md at the repo root), served so the Settings
  // view can render it in-app. Read per request (it's small and edited often in
  // dev); auth applies via the standard /api hook. Missing file → honest note.
  app.get("/api/roadmap", async () => {
    try {
      const markdown = await readFile(new URL("../../../ROADMAP.md", import.meta.url), "utf8");
      return { markdown };
    } catch {
      return { markdown: "# Roadmap\n\nROADMAP.md isn't bundled with this build — see the repository." };
    }
  });

  // Advanced env settings (desktop only). A strict whitelist of operator knobs
  // the packaged app can set; changes are staged to the userData env file and
  // applied when the desktop shell restarts the local engine. Gated on
  // config.desktop so a hosted server never exposes an env-writing surface.
  app.get("/api/settings/env", async () => currentEnvSettings());

  app.put("/api/settings/env", async (req, reply) => {
    if (!envSettingsWritable()) return reply.code(400).send({ error: "Advanced env settings are only writable in the desktop app." });
    const body = (req.body ?? {}) as { updates?: Record<string, unknown> };
    const updates: Record<string, string> = {};
    for (const [k, v] of Object.entries(body.updates ?? {})) updates[k] = v == null ? "" : String(v);
    try {
      await writeEnvSettings(updates);
    } catch (err) {
      if (err instanceof UnknownEnvKeyError || err instanceof InvalidEnvValueError) {
        return reply.code(422).send({ error: err.message });
      }
      throw err;
    }
    return { ok: true, restartRequired: true };
  });

  // Restart the local engine so staged env changes apply. Only the desktop shell
  // can honor this: the server exits with a sentinel code its parent respawns on.
  app.post("/api/settings/restart", async (req, reply) => {
    if (!config.desktop) return reply.code(400).send({ error: "Restart is only available in the desktop app." });
    // Respond first, then exit so the shell re-launches with the fresh env.
    reply.send({ restarting: true });
    setTimeout(() => process.exit(RESTART_EXIT_CODE), 150);
    return reply;
  });

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

  // ── Telegram conversational assistant — DRY-RUN ────────────────────────────
  // Runs the exact assistant pipeline (buildContext → BYOK consult → parse the
  // {reply, action} envelope) WITHOUT executing anything. This is the seam the
  // Simulation section drives: it proves the assistant answers questions AND
  // routes clear requests to a whitelisted action, repeatably and with zero
  // mutations. No consult-capable key → {reply:null, action:null, error:"no-llm"}.
  app.post<{ Body: { text?: unknown } }>("/api/telegram/simulate", async (req, reply) => {
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    if (!text.trim()) return reply.code(400).send({ error: "text is required" });
    try {
      return await simulateConversational(
        { operations: ops, orchestrator: deps.orchestrator, ws: ws(req) },
        text,
      );
    } catch (err) {
      return fail(reply, err);
    }
  });

  // ── Simulation step grading — LLM-as-judge ─────────────────────────────────
  // A generic "did the assistant's response meet an expectation?" grader the
  // Simulation LLM journeys call to decide each step: the behavior is produced
  // by a real BYOK LLM, and the per-step verdict is ALSO produced by an LLM (so
  // a defensible paraphrase / clearly-equivalent action isn't failed by a
  // brittle `===`). prompt/expectation/actual all ride inside the context as
  // DATA. No consult-capable key → {pass:null, error:"no-llm"} (HTTP 200) so the
  // caller can soft-skip, consistent with the conversational dry-run endpoint.
  app.post<{ Body: { prompt?: unknown; expectation?: unknown; actual?: unknown } }>(
    "/api/simulation/grade",
    async (req, reply) => {
      const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : "";
      const expectation = typeof req.body?.expectation === "string" ? req.body.expectation : "";
      const actual = typeof req.body?.actual === "string" ? req.body.actual : "";
      if (!prompt.trim() || !expectation.trim()) {
        return reply.code(400).send({ error: "prompt and expectation are required" });
      }
      try {
        return await simulationGrade(
          { orchestrator: deps.orchestrator, ws: ws(req) },
          { prompt, expectation, actual },
        );
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

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

  // Streaming chat: the same reply as /messages, but written as text/plain
  // chunks so the UI renders it as it's generated. Ownership is validated BEFORE
  // we take over the socket, so a bad id / cross-workspace run still returns a
  // clean JSON error; once streaming starts we can only append.
  app.post<{ Params: { id: string } }>("/api/runs/:id/messages/stream", async (req, reply) => {
    const body = ChatRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    try {
      await ops.getRun(ws(req), req.params.id); // 404 / cross-ws → JSON error, no stream
    } catch (err) {
      return fail(reply, err);
    }
    reply.hijack(); // we own the raw response from here
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no", // don't let a proxy buffer the stream
    });
    try {
      for await (const delta of ops.chatAgentStream(ws(req), req.params.id, body.data.text)) {
        raw.write(delta);
      }
    } catch (err) {
      // Headers are already sent — surface the failure inline rather than a 500.
      raw.write(`\n[stream error] ${(err as Error).message}`);
    } finally {
      raw.end();
    }
  });

  app.post<{ Params: { id: string } }>("/api/runs/:id/fork", async (req, reply) => {
    try {
      return await ops.forkAgent(ws(req), req.params.id);
    } catch (err) {
      return fail(reply, err);
    }
  });

  // The real diff of a run's branch (unified patch + stat) — lazily loaded by the
  // diff-review UI so patches never ride in the snapshot.
  app.get<{ Params: { id: string } }>("/api/runs/:id/diff", async (req, reply) => {
    try {
      return await ops.runDiff(ws(req), req.params.id);
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
  // returns the updated run. Pathed under /api/runs/:id like the other run
  // actions (messages/fork/archive) — the agents→runs rename missed these three,
  // so the client's /api/runs/:id/{pause,resume,stop} calls 404'd.
  app.post<{ Params: { id: string } }>("/api/runs/:id/pause", async (req, reply) => {
    try {
      return await ops.pauseAgent(ws(req), req.params.id);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/api/runs/:id/resume", async (req, reply) => {
    try {
      return await ops.resumeAgent(ws(req), req.params.id);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/api/runs/:id/stop", async (req, reply) => {
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
    try {
      return await ops.createProject(ws(req), body.data);
    } catch (err) {
      // createRepo can fail (bad token, name taken, missing scope) — surface it.
      return fail(reply, err);
    }
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

  // Clone a GitHub-connected project's repo into a managed local checkout (for a
  // headless server with no folder to point at). Sets repoPath + gitBacked.
  app.post<{ Params: { id: string } }>("/api/projects/:id/clone", async (req, reply) => {
    try {
      return await ops.cloneRepoIntoProject(ws(req), req.params.id);
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Repo-aware project assistant — chat about this project's status + content.
  app.post<{ Params: { id: string }; Body: { question?: string; history?: ChatTurn[] } }>(
    "/api/projects/:id/chat",
    async (req, reply) => {
      const question = (req.body?.question ?? "").trim();
      if (!question) return reply.code(400).send({ error: "Ask a question about the project." });
      const history = Array.isArray(req.body?.history)
        ? req.body!.history
            .filter((h) => h && (h.role === "user" || h.role === "assistant") && typeof h.content === "string")
            .slice(-16)
        : undefined;
      try {
        const answer = await ops.projectAssistant(ws(req), req.params.id, question, history);
        return { reply: answer };
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  // Streaming form of the project assistant — same answer, written as text/plain
  // chunks so "Ask about this project" renders it as it's generated. Ownership /
  // bad-request errors stay JSON (validated before we hijack the socket).
  app.post<{ Params: { id: string }; Body: { question?: string; history?: ChatTurn[] } }>(
    "/api/projects/:id/chat/stream",
    async (req, reply) => {
      const question = (req.body?.question ?? "").trim();
      if (!question) return reply.code(400).send({ error: "Ask a question about the project." });
      const history = Array.isArray(req.body?.history)
        ? req.body!.history
            .filter((h) => h && (h.role === "user" || h.role === "assistant") && typeof h.content === "string")
            .slice(-16)
        : undefined;
      // Validate the project exists / is ours before taking over the socket.
      try {
        await ops.getProject(ws(req), req.params.id);
      } catch (err) {
        return fail(reply, err);
      }
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      });
      try {
        for await (const delta of ops.projectAssistantStream(ws(req), req.params.id, question, history)) {
          raw.write(delta);
        }
      } catch (err) {
        raw.write(`\n[stream error] ${(err as Error).message}`);
      } finally {
        raw.end();
      }
    },
  );

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

  // Reversible soft-hide (archive) — body {archived?:boolean}, default true.
  // Un-archive with {archived:false}. Never deletes; the record stays recoverable.
  app.post<{ Params: { id: string; tid: string }; Body: { archived?: boolean } }>(
    "/api/projects/:id/tasks/:tid/archive",
    async (req, reply) => {
      const archived = req.body?.archived ?? true;
      try {
        return await ops.archiveTask(ws(req), req.params.id, req.params.tid, archived);
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

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
