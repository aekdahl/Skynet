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
  CreateFeatureRequest,
  CreateMilestoneRequest,
  CreateProjectRequest,
  CreateSolutionBriefRequest,
  CreateTaskRequest,
  DraftCharterRequest,
  DryRunPolicyRequest,
  ProviderId,
  ResolveRequest,
  ChatRequest,
  SavePolicyVersionRequest,
  InformRequest,
  UpdateFeatureRequest,
  UpdateMilestoneRequest,
  UpdateProjectRequest,
  UpdateProjectRoadmapRequest,
  UpdateWorkspaceSettingsRequest,
  UpdateRunnerRequest,
  UpdateSolutionBriefRequest,
  UpdateTaskRequest,
  MoveTaskRequest,
  ReorderTaskRequest,
  MergePrRequest,
  ReworkPrRequest,
} from "@skynet/shared";
import { installProviderCli } from "./provider-install.js";
import { installCommandFor } from "./provider-requirements.js";
import { readFile } from "node:fs/promises";
import { authenticate, hasScope, type Principal } from "./auth.js";
import { requiresAuth, requiredScope } from "./auth-guard.js";
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
import { NotFoundError, type Operations, RoadmapConflictError, RunnerBusyError } from "./operations.js";
import { CrystallizeParseError } from "./steward/crystallize.js";
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
  // The request was well-formed, but the model couldn't produce a valid draft
  // even after a retry — semantically unprocessable, not a malformed request.
  if (err instanceof CrystallizeParseError) return reply.code(422).send({ error: err.message });
  if (
    err instanceof NoCapacityError ||
    err instanceof TaskAlreadyAssignedError ||
    err instanceof RunnerNotConfiguredError ||
    err instanceof RunnerBusyError ||
    err instanceof RoadmapConflictError
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
    // Viewer role (read-only humans) + scoped service tokens: a mutation route
    // needs the scope it's classified under (auth-guard.ts's requiredScope) —
    // full-authority principals (scopes undefined) always pass hasScope().
    const scope = requiredScope(req.method, req.url);
    if (scope && !hasScope(principal, scope)) {
      return reply.code(403).send({ error: `Forbidden: this action requires the "${scope}" scope.` });
    }
  });

  // ── reads (workspace-scoped) ──────────────────────────────────────────────
  app.get("/api/snapshot", (req) => ops.snapshot(ws(req)));
  app.get("/api/providers", (req) => ops.listProviders(ws(req)));

  // Install a provider's CLI in-place, streaming stdout+stderr as text/plain
  // so the Settings UI can render live output. The command is FIXED per
  // provider on the server (see provider-requirements.ts INSTALL_COMMAND) —
  // the client only sends the provider id; there's no way for a caller to
  // inject shell text. Providers without a scriptable install (brew/manual)
  // return 400. Post-install the client refreshes the snapshot to pick up
  // the re-probed `binOnPath`.
  app.post<{ Params: { id: string } }>("/api/providers/:id/install", async (req, reply) => {
    const parsed = ProviderId.safeParse(req.params.id);
    if (!parsed.success) return reply.code(400).send({ error: "unknown provider id" });
    const id = parsed.data;
    if (!installCommandFor(id)) {
      return reply.code(400).send({ error: `no auto-install available for "${id}"; use the docs link on the provider card` });
    }
    reply.header("content-type", "text/plain; charset=utf-8");
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache" });
    try {
      for await (const ev of installProviderCli(id)) {
        if (ev.kind === "line" || ev.kind === "error") raw.write((ev.text ?? "") + "\n");
        else if (ev.kind === "done") {
          raw.write(`\n[done] exit=${ev.exitCode ?? "spawn-failed"} binOnPath=${ev.binOnPath ? "yes" : "no"}\n`);
        }
      }
    } catch (err) {
      raw.write(`\n[error] ${(err as Error).message}\n`);
    } finally {
      raw.end();
    }
  });
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

  // Live workspace fleet policy (auto-scale + cap). Per-workspace, applied at
  // runtime (no restart) — unlike the env knobs below.
  app.get("/api/settings/fleet", (req) => ops.getWorkspaceSettings(ws(req)));
  app.patch("/api/settings/fleet", async (req, reply) => {
    const body = UpdateWorkspaceSettingsRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    try {
      return await ops.updateWorkspaceSettings(ws(req), body.data);
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Command policy: the versioned, per-workspace command-safety classifier
  // (ROADMAP.md — "policy as code"). View the active policy + version history,
  // dry-run a proposed edit against real command history, then save it as a
  // new active version. No custom version saved yet = the shipped default.
  app.get("/api/settings/command-policy", (req) => ops.getActiveCommandPolicy(ws(req)));
  app.get("/api/settings/command-policy/versions", (req) => ops.listCommandPolicyVersions(ws(req)));
  app.post("/api/settings/command-policy/dry-run", async (req, reply) => {
    const body = DryRunPolicyRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    return ops.dryRunCommandPolicy(ws(req), body.data);
  });
  app.post("/api/settings/command-policy/versions", async (req, reply) => {
    const body = SavePolicyVersionRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    return ops.saveCommandPolicyVersion(ws(req), body.data, req.principal!.operatorId);
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

  // SIEM export — the workspace's full audit trail as NDJSON (one record per line,
  // oldest-first so the hash chain can be followed sequentially). Each line is a
  // complete AuditRecord including hash + prevHash for offline chain verification.
  // Optional ?from=<ms>&?to=<ms> narrow the time window. Intended for ingestion
  // into a SIEM (Splunk / Datadog / ELK) or archival; not paginated — callers
  // should scope via from/to when the trail is large.
  app.get<{ Querystring: { from?: string; to?: string } }>("/api/audit/export", async (req, reply) => {
    const records = (await ops.listAudit(ws(req))).reverse(); // oldest-first for SIEM chain
    const from = req.query.from ? Number(req.query.from) : null;
    const to = req.query.to ? Number(req.query.to) : null;
    const filtered = records.filter((r) => (from == null || r.at >= from) && (to == null || r.at <= to));
    reply.header("Content-Type", "application/x-ndjson");
    reply.header("Content-Disposition", 'attachment; filename="audit-export.ndjson"');
    return reply.send(filtered.map((r) => JSON.stringify(r)).join("\n") + (filtered.length ? "\n" : ""));
  });

  // One-click signed "AI change report" (ROADMAP: Compliance evidence pack) —
  // a project, a run, a date range, or the whole workspace (all query params
  // optional/omittable). Always returns the signed JSON; the web client
  // renders it to Markdown client-side (shared/compliance.ts) for the
  // one-click download, so there's exactly one canonical rendering, usable
  // both here and in tests, with no server-side templating to maintain.
  app.get<{ Querystring: { projectId?: string; runId?: string; from?: string; to?: string } }>(
    "/api/compliance/report",
    async (req, reply) => {
      const q = req.query;
      const num = (v: string | undefined) => (v ? Number(v) : undefined);
      try {
        return await ops.generateComplianceReport(ws(req), req.principal!.operatorId, {
          projectId: q.projectId || null,
          runId: q.runId || null,
          from: num(q.from) ?? null,
          to: num(q.to) ?? null,
        });
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

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

  // `inform` — mass-select runs (explicit ids and/or a whole project's live
  // runs) and attach a note that rides each one's NEXT prompt, no extra turn.
  // A third interaction type alongside chat (above) and resolve (HITL) — not a
  // HITL gate itself, so this never touches /api/hitl.
  app.post("/api/runs/inform", async (req, reply) => {
    const body = InformRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    try {
      return await ops.informRuns(ws(req), body.data);
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

  // ── Checkpoint / restore (extends fork/resume) ─────────────────────────────
  app.post<{ Params: { id: string }; Body: { label?: string } }>("/api/runs/:id/checkpoints", async (req, reply) => {
    try {
      return await ops.createCheckpoint(ws(req), req.params.id, req.body?.label ?? null);
    } catch (err) {
      return fail(reply, err);
    }
  });
  app.get<{ Params: { id: string } }>("/api/runs/:id/checkpoints", async (req, reply) => {
    try {
      return await ops.listCheckpoints(ws(req), req.params.id);
    } catch (err) {
      return fail(reply, err);
    }
  });
  app.post<{ Params: { id: string; checkpointId: string } }>("/api/runs/:id/checkpoints/:checkpointId/restore", async (req, reply) => {
    try {
      return await ops.restoreCheckpoint(ws(req), req.params.id, req.params.checkpointId);
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

  // ── Ready-to-merge (human PR merge decisions) ──────────────────────────────
  // Runs whose PR is open and awaiting a human's merge/rework/no-op call.
  app.get("/api/merges", (req) => ops.listReadyPrs(ws(req)));
  app.post<{ Params: { id: string } }>("/api/merges/:id/merge", async (req, reply) => {
    const body = MergePrRequest.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    try {
      return await ops.mergeReadyPr(ws(req), req.params.id, body.data.method);
    } catch (err) {
      return fail(reply, err);
    }
  });
  app.post<{ Params: { id: string } }>("/api/merges/:id/rework", async (req, reply) => {
    const body = ReworkPrRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    try {
      await ops.reworkReadyPr(ws(req), req.params.id, body.data.guidance, body.data.comment);
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });
  app.post<{ Params: { id: string } }>("/api/merges/:id/update-branch", async (req, reply) => {
    try {
      return await ops.updateReadyPrBranch(ws(req), req.params.id);
    } catch (err) {
      return fail(reply, err);
    }
  });
  app.post<{ Params: { id: string } }>("/api/merges/:id/dismiss", async (req, reply) => {
    try {
      await ops.dismissReadyPr(ws(req), req.params.id);
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });
  // Live GitHub check-run status — a real API call, fetched on demand by the
  // card (not part of the polled snapshot). null = unreachable/unknown; the
  // card falls back to showing no check-status affordance.
  app.get<{ Params: { id: string } }>("/api/merges/:id/checks", async (req, reply) => {
    try {
      return await ops.prChecksForRun(ws(req), req.params.id);
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Feature-scoped branch batching's aggregate PR — one per completed Feature,
  // not per task (see orchestrator.ts's checkFeatureCompletion). Only Merge +
  // Dismiss: no Rework/Update-branch for a batch (see the plan).
  app.get("/api/features/pr/ready", (req) => ops.listReadyFeaturePrs(ws(req)));
  app.post<{ Params: { id: string } }>("/api/features/:id/pr/merge", async (req, reply) => {
    const body = MergePrRequest.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    try {
      return await ops.mergeReadyFeaturePr(ws(req), req.params.id, body.data.method);
    } catch (err) {
      return fail(reply, err);
    }
  });
  app.post<{ Params: { id: string } }>("/api/features/:id/pr/dismiss", async (req, reply) => {
    try {
      await ops.dismissReadyFeaturePr(ws(req), req.params.id);
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });
  app.get<{ Params: { id: string } }>("/api/features/:id/pr/checks", async (req, reply) => {
    try {
      return await ops.prChecksForFeature(ws(req), req.params.id);
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

  // Gate G-1: draft a Project Charter from the operator's raw goal using the
  // workspace's own Claude key (one cheap Haiku call). The operator corrects/
  // approves the result in the UI before creating the project.
  app.post("/api/projects/draft-charter", async (req, reply) => {
    const body = DraftCharterRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    try {
      return await ops.draftCharter(ws(req), body.data);
    } catch (err) {
      return fail(reply, err);
    }
  });

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

  // Revoke one standing "approve always" rule from a project's approval policy.
  app.delete<{ Params: { id: string; ruleId: string } }>(
    "/api/projects/:id/approval-rules/:ruleId",
    async (req, reply) => {
      try {
        return await ops.removeApprovalRule(ws(req), req.params.id, req.params.ruleId);
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  // Clone a GitHub-connected project's repo into a managed local checkout (for a
  // headless server with no folder to point at). Sets repoPath + gitBacked.
  app.post<{ Params: { id: string } }>("/api/projects/:id/clone", async (req, reply) => {
    try {
      return await ops.cloneRepoIntoProject(ws(req), req.params.id);
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Global Steward chat (the sidebar dock, every page). Optional `projectId`
  // focuses the page you're on — then it's the full project assistant (actions);
  // otherwise it answers workspace-wide.
  app.post<{ Body: { question?: string; history?: ChatTurn[]; projectId?: string } }>(
    "/api/steward/chat",
    async (req, reply) => {
      const question = (req.body?.question ?? "").trim();
      if (!question) return reply.code(400).send({ error: "Ask Steward something." });
      const history = Array.isArray(req.body?.history)
        ? req.body!.history
            .filter((h) => h && (h.role === "user" || h.role === "assistant") && typeof h.content === "string")
            .slice(-16)
        : undefined;
      try {
        const focus = typeof req.body?.projectId === "string" ? req.body!.projectId : undefined;
        return await ops.stewardChat(ws(req), question, history, focus);
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  // Streaming Steward chat: the reply is written as text/plain deltas so the dock
  // renders it live, then a final control frame — a RS (\x1e) sentinel followed by
  // {reply, action, projectId} — carries the CLEAN reply (trailing action JSON
  // stripped) and any confirm-first action. The sentinel never occurs in prose.
  app.post<{ Body: { question?: string; history?: ChatTurn[]; projectId?: string } }>(
    "/api/steward/chat/stream",
    async (req, reply) => {
      const question = (req.body?.question ?? "").trim();
      if (!question) return reply.code(400).send({ error: "Ask Steward something." });
      const history = Array.isArray(req.body?.history)
        ? req.body!.history
            .filter((h) => h && (h.role === "user" || h.role === "assistant") && typeof h.content === "string")
            .slice(-16)
        : undefined;
      const focus = typeof req.body?.projectId === "string" ? req.body!.projectId : undefined;
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      });
      try {
        const gen = ops.stewardChatStream(ws(req), question, history, focus);
        let result: { reply: string; actions: unknown; projectId: string | null } | undefined;
        for (;;) {
          const { value, done } = await gen.next();
          if (done) {
            result = value;
            break;
          }
          raw.write(value);
        }
        raw.write("\x1e" + JSON.stringify(result));
      } catch (err) {
        raw.write(`\n[stream error] ${(err as Error).message}`);
      } finally {
        raw.end();
      }
    },
  );

  // ── live preview (Phase-1 v0) — run the project's web app + iframe it ─────
  app.get<{ Params: { id: string } }>("/api/projects/:id/preview", async (req, reply) => {
    try {
      return await ops.previewState(ws(req), req.params.id);
    } catch (err) {
      return fail(reply, err);
    }
  });
  const previewAction =
    (fn: (ws: string, id: string) => Promise<unknown>) =>
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        return await fn(ws(req), req.params.id);
      } catch (err) {
        return fail(reply, err);
      }
    };
  app.post<{ Params: { id: string }; Body: { source?: "main" | "merged" | "latest" } }>(
    "/api/projects/:id/preview/start",
    async (req, reply) => {
      const source = req.body?.source;
      const src = source === "main" || source === "merged" || source === "latest" ? source : undefined;
      try {
        return await ops.previewStart(ws(req), req.params.id, src);
      } catch (err) {
        return fail(reply, err);
      }
    },
  );
  app.post<{ Params: { id: string } }>("/api/projects/:id/preview/stop", previewAction((w, i) => ops.previewStop(w, i)));
  app.post<{ Params: { id: string } }>("/api/projects/:id/preview/restart", previewAction((w, i) => ops.previewRestart(w, i)));
  app.post<{ Params: { id: string } }>("/api/projects/:id/preview/refresh", previewAction((w, i) => ops.previewRefresh(w, i)));

  // ── Deploy to Fly.io (persistent, human-triggered) — a REAL, shareable URL
  // that survives independent of the local Skynet process. Explicit operator
  // action only: there is deliberately no automatic trigger anywhere in this
  // file. Two targets: a project's integration branch, or a single run's own
  // branch (pre-merge verification) — see docs/live-preview.md.
  app.get<{ Params: { id: string } }>("/api/projects/:id/fly-deploy", async (req, reply) => {
    try {
      return await ops.flyDeployProjectState(ws(req), req.params.id);
    } catch (err) {
      return fail(reply, err);
    }
  });
  app.post<{ Params: { id: string } }>("/api/projects/:id/fly-deploy/start", async (req, reply) => {
    try {
      return await ops.flyDeployProjectStart(ws(req), req.params.id, req.principal!.operatorId);
    } catch (err) {
      return fail(reply, err);
    }
  });
  app.post<{ Params: { id: string } }>("/api/projects/:id/fly-deploy/stop", async (req, reply) => {
    try {
      return await ops.flyDeployProjectStop(ws(req), req.params.id);
    } catch (err) {
      return fail(reply, err);
    }
  });
  app.get<{ Params: { id: string } }>("/api/runs/:id/fly-deploy", async (req, reply) => {
    try {
      return await ops.flyDeployRunState(ws(req), req.params.id);
    } catch (err) {
      return fail(reply, err);
    }
  });
  app.post<{ Params: { id: string } }>("/api/runs/:id/fly-deploy/start", async (req, reply) => {
    try {
      return await ops.flyDeployRunStart(ws(req), req.params.id, req.principal!.operatorId);
    } catch (err) {
      return fail(reply, err);
    }
  });
  app.post<{ Params: { id: string } }>("/api/runs/:id/fly-deploy/stop", async (req, reply) => {
    try {
      return await ops.flyDeployRunStop(ws(req), req.params.id);
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

  // Import a GitHub-connected project's open issues as tasks (linked back to the
  // issue via Task.source, so status changes can be written back).
  app.post<{ Params: { id: string } }>("/api/projects/:id/import/github-issues", async (req, reply) => {
    try {
      return await ops.importGithubIssues(ws(req), req.params.id);
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Import a repo file's open checklist items as tasks (Phase 2). Body: { path }.
  app.post<{ Params: { id: string }; Body: { path?: string } }>("/api/projects/:id/import/repo-file", async (req, reply) => {
    const path = (req.body?.path ?? "").trim();
    if (!path) return reply.code(400).send({ error: "A file path is required (e.g. TODO.md)." });
    try {
      return await ops.importRepoFile(ws(req), req.params.id, path);
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

  // Force a task to `done` — bypasses HUMAN_TRANSITIONS and always syncs the
  // linked run's status to "done". The escape hatch when the normal
  // review → done path fails (merge queue stuck, HITL wedged, run finished
  // without advancing the card). Never merges the branch: it's a
  // "call it done" operator override, not a work-completion signal.
  app.post<{ Params: { id: string; tid: string } }>("/api/projects/:id/tasks/:tid/force-done", async (req, reply) => {
    try {
      return await ops.forceTaskDone(ws(req), req.params.tid);
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

  // Dismiss a task linter (v0) hint — advisory only, so this just marks the
  // current lint result seen; it never re-checks or blocks anything.
  app.post<{ Params: { id: string; tid: string } }>("/api/projects/:id/tasks/:tid/lint/dismiss", async (req, reply) => {
    try {
      return await ops.dismissTaskLint(ws(req), req.params.tid);
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Drag-reorder a task to an arbitrary backlog position (before `beforeId`, or end).
  app.post<{ Params: { id: string; tid: string } }>("/api/projects/:id/tasks/:tid/reorder", async (req, reply) => {
    const body = ReorderTaskRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    try {
      return await ops.reorderTask(ws(req), req.params.tid, body.data.beforeId);
    } catch (err) {
      return fail(reply, err);
    }
  });

  // ── features (task grouping) ──────────────────────────────────────────
  app.post<{ Params: { id: string } }>("/api/projects/:id/features", async (req, reply) => {
    const body = CreateFeatureRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    try {
      return await ops.createFeature(ws(req), req.params.id, body.data);
    } catch (err) {
      return fail(reply, err);
    }
  });
  app.patch<{ Params: { fid: string } }>("/api/features/:fid", async (req, reply) => {
    const body = UpdateFeatureRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    try {
      return await ops.updateFeature(ws(req), req.params.fid, body.data);
    } catch (err) {
      return fail(reply, err);
    }
  });
  app.delete<{ Params: { fid: string } }>("/api/features/:fid", async (req, reply) => {
    try {
      await ops.deleteFeature(ws(req), req.params.fid);
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // ── solution briefs (S4: the persistent pre-work planning doc) ─────────
  // Nested entirely under /api/projects/:id/briefs (list/create/get/update/
  // delete) rather than features' flat /api/features/:fid for update/delete —
  // a deliberate simplification for this entity. GET/PATCH/DELETE re-check
  // the fetched brief's projectId against the URL's :id so a mismatched pair
  // 404s instead of silently acting through the "wrong" project's URL.
  app.get<{ Params: { id: string } }>("/api/projects/:id/briefs", async (req, reply) => {
    try {
      const all = await ops.listBriefs(ws(req));
      return all.filter((b) => b.projectId === req.params.id);
    } catch (err) {
      return fail(reply, err);
    }
  });
  app.post<{ Params: { id: string } }>("/api/projects/:id/briefs", async (req, reply) => {
    const body = CreateSolutionBriefRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    try {
      return await ops.createBrief(ws(req), req.params.id, body.data);
    } catch (err) {
      return fail(reply, err);
    }
  });
  app.get<{ Params: { id: string; bid: string } }>("/api/projects/:id/briefs/:bid", async (req, reply) => {
    try {
      const brief = await ops.getBrief(ws(req), req.params.bid);
      if (brief.projectId !== req.params.id) throw new NotFoundError("SolutionBrief");
      return brief;
    } catch (err) {
      return fail(reply, err);
    }
  });
  app.patch<{ Params: { id: string; bid: string } }>("/api/projects/:id/briefs/:bid", async (req, reply) => {
    const body = UpdateSolutionBriefRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    // Approval is human/API only — never an agent-scoped token. `scopes` is
    // undefined ONLY for a human session or an unscoped token (full
    // authority, see auth.ts's Principal doc comment); any token minted with
    // an explicit scope list — including one that happens to carry "approver"
    // for HITL/merge decisions elsewhere — is refused here specifically. The
    // MCP surface (mcp/tools.ts's update_brief) enforces the SAME rule
    // structurally, by never accepting "approved" in its input schema at all.
    if (body.data.status === "approved" && req.principal!.scopes !== undefined) {
      return reply.code(403).send({ error: "Approving a solution brief requires a human/unscoped token — not exposed to agent-scoped tokens." });
    }
    try {
      const brief = await ops.getBrief(ws(req), req.params.bid);
      if (brief.projectId !== req.params.id) throw new NotFoundError("SolutionBrief");
      return await ops.updateBrief(ws(req), req.params.bid, body.data, req.principal!.operatorId);
    } catch (err) {
      return fail(reply, err);
    }
  });
  app.delete<{ Params: { id: string; bid: string } }>("/api/projects/:id/briefs/:bid", async (req, reply) => {
    try {
      const brief = await ops.getBrief(ws(req), req.params.bid);
      if (brief.projectId !== req.params.id) throw new NotFoundError("SolutionBrief");
      await ops.deleteBrief(ws(req), req.params.bid);
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });
  // S5: turn a Steward conversation into a draft SolutionBrief. `history` is
  // the transcript the CALLER already holds (the steward dock's own chat
  // state) — there's no server-side steward session to reference instead, so
  // this is the only shape that makes sense (mirrors /api/steward/chat's own
  // client-supplied-history contract exactly). A retry happens INSIDE
  // crystallizeBrief; a second bad model reply throws CrystallizeParseError,
  // mapped to 422 below — never a half-parsed brief.
  app.post<{ Params: { id: string }; Body: { history?: ChatTurn[] } }>("/api/projects/:id/briefs/crystallize", async (req, reply) => {
    const history = Array.isArray(req.body?.history)
      ? req.body!.history.filter((h) => h && (h.role === "user" || h.role === "assistant") && typeof h.content === "string")
      : [];
    if (history.length === 0) return reply.code(400).send({ error: "Crystallize needs a conversation to draft from — pass `history`." });
    try {
      return await ops.crystallizeBrief(ws(req), req.params.id, history);
    } catch (err) {
      return fail(reply, err);
    }
  });
  // S6 (optional): opt-in rigor before approving — spins a bounded, read-only
  // agent run against a detached checkout of the base branch and appends its
  // findings/touchpoints onto the brief (`SolutionBrief.exploration`).
  // Never blocks approval; a failure is a real error response (fail()'s
  // default 400 for a plain Error) and leaves the brief untouched — see
  // Operations.exploreBrief.
  app.post<{ Params: { id: string; bid: string } }>("/api/projects/:id/briefs/:bid/explore", async (req, reply) => {
    try {
      const brief = await ops.getBrief(ws(req), req.params.bid);
      if (brief.projectId !== req.params.id) throw new NotFoundError("SolutionBrief");
      return await ops.exploreBrief(ws(req), req.params.id, req.params.bid);
    } catch (err) {
      return fail(reply, err);
    }
  });

  // ── milestones (roadmap) ──────────────────────────────────────────────
  app.post<{ Params: { id: string } }>("/api/projects/:id/milestones", async (req, reply) => {
    const body = CreateMilestoneRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    try {
      return await ops.createMilestone(ws(req), req.params.id, body.data);
    } catch (err) {
      return fail(reply, err);
    }
  });
  app.patch<{ Params: { mid: string } }>("/api/milestones/:mid", async (req, reply) => {
    const body = UpdateMilestoneRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    try {
      return await ops.updateMilestone(ws(req), req.params.mid, body.data);
    } catch (err) {
      return fail(reply, err);
    }
  });
  app.delete<{ Params: { mid: string } }>("/api/milestones/:mid", async (req, reply) => {
    try {
      await ops.deleteMilestone(ws(req), req.params.mid);
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // ── project roadmap doc (ROADMAP.md, read straight from the bound repo) ──
  app.get<{ Params: { id: string } }>("/api/projects/:id/roadmap", async (req, reply) => {
    try {
      return await ops.getProjectRoadmap(ws(req), req.params.id);
    } catch (err) {
      return fail(reply, err);
    }
  });
  app.post<{ Params: { id: string } }>("/api/projects/:id/roadmap", async (req, reply) => {
    const body = UpdateProjectRoadmapRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    try {
      return await ops.updateProjectRoadmap(ws(req), req.params.id, body.data);
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
