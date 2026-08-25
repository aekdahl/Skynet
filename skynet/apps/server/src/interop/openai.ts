// ─── OpenAI-compatible interop endpoint ────────────────────────────────────
// Lets any tool that already speaks the OpenAI Chat Completions wire format
// (LangChain, LiteLLM, Continue, the `openai` SDK pointed at a custom
// base_url, ...) drive Skynet as if it were a hosted model, without knowing
// anything about projects/tasks/runs. GET /v1/models lists the caller's
// projects as models; POST /v1/chat/completions turns the last user message
// into a task in the chosen project, assigns it to a fresh agent, and returns
// the run's outcome as the assistant's reply.
//
// One completion = one task. There is no server-side thread: an OpenAI client
// resends the whole message history on every call, but there's no field in
// that wire format naming an existing Skynet run to keep talking to, so every
// call starts fresh work (prior turns are folded into the new task's
// description as context). Routing a follow-up back into the SAME run is the
// separate "feedback-loop responders" effort — out of scope here.
//
// Auth is the same bearer service token as /mcp, with the same scopes
// (no scope needed to list models; "author" to spend a completion — see
// auth-guard.ts) and the same project confinement (a project-scoped token
// only ever sees/targets its own projects as "models").

import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Bus } from "../bus.js";
import {
  NoCapacityError,
  RunnerNotConfiguredError,
  TaskAlreadyAssignedError,
} from "../orchestrator.js";
import { NotFoundError, RunnerBusyError, type Operations } from "../operations.js";
import { projectScope } from "../mcp/project-scope.js";
import { summarizeRun } from "../mcp/summarize.js";
import { waitForEvent } from "../mcp/watch.js";
import type { TaskRun } from "@skynet/shared";

export interface OpenAiCompatDeps {
  operations: Operations;
  bus: Bus;
}

// Generous relative to the MCP wait_for_* tools' 5-minute cap: a chat
// completion has no client hot-loop to fall back on, so it's worth holding the
// connection open through a typical small coding task before telling the
// caller to poll instead. Still short of most HTTP client / proxy read
// timeouts (commonly 10 minutes-plus).
const COMPLETION_WAIT_MS = 9 * 60_000;

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Map a completion-path error to an OpenAI-shaped error body + status. */
function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  const type =
    err instanceof NotFoundError
      ? "invalid_request_error"
      : err instanceof NoCapacityError || err instanceof RunnerNotConfiguredError || err instanceof RunnerBusyError || err instanceof TaskAlreadyAssignedError
        ? "capacity_error"
        : "invalid_request_error";
  const code = err instanceof NotFoundError ? 404 : type === "capacity_error" ? 409 : 400;
  return reply.code(code).send({ error: { message: errMsg(err), type } });
}

const ChatMessage = z
  .object({
    role: z.string(),
    content: z.union([z.string(), z.array(z.record(z.unknown())), z.null()]).optional(),
  })
  .passthrough();

const ChatCompletionRequest = z
  .object({
    model: z.string().min(1),
    messages: z.array(ChatMessage).min(1),
    stream: z.boolean().optional(),
  })
  .passthrough();

function contentText(m: z.infer<typeof ChatMessage>): string {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map((part) => (typeof (part as { text?: unknown }).text === "string" ? ((part as { text: string }).text) : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** The last user message becomes the task; earlier turns ride along as context. */
function toTaskInput(messages: z.infer<typeof ChatCompletionRequest>["messages"]): { text: string; description?: string } {
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
  const lastUser = lastUserIdx >= 0 ? messages[lastUserIdx] : undefined;
  if (!lastUser) throw new Error('messages must include at least one "user" message');
  const text = contentText(lastUser).trim();
  if (!text) throw new Error("the last user message has no text content");
  const prior = messages
    .slice(0, lastUserIdx)
    .map((m) => ({ role: m.role, text: contentText(m).trim() }))
    .filter((m) => m.text.length > 0)
    .map((m) => `${m.role}: ${m.text}`);
  return prior.length > 0 ? { text, description: `Prior conversation (for context):\n${prior.join("\n")}` } : { text };
}

const isTerminal = (s: TaskRun["status"]) => s === "done" || s === "review";

/** Block (in bounded chunks) until the run is done/review or timeoutMs elapses. */
async function waitForOutcome(bus: Bus, operations: Operations, ws: string, runId: string, timeoutMs: number): Promise<TaskRun> {
  const deadline = Date.now() + timeoutMs;
  let run = await operations.getRun(ws, runId);
  while (!isTerminal(run.status) && Date.now() < deadline) {
    await waitForEvent(
      bus,
      ws,
      (e) => (e.type === "run.status" && e.runId === runId && isTerminal(e.status)) || (e.type === "run.completed" && e.runId === runId),
      deadline - Date.now(),
    );
    run = await operations.getRun(ws, runId);
  }
  return run;
}

/** Render a run's outcome as the assistant's reply text. */
async function renderOutcome(operations: Operations, ws: string, run: TaskRun): Promise<string> {
  const lines: string[] = [];
  if (run.status === "done") lines.push(`Task complete — run ${run.id} (${run.name}) finished.`);
  else if (run.status === "review") lines.push(`Ready for review — run ${run.id} (${run.name}) is waiting on a human decision (HITL gate).`);
  else lines.push(`Still ${run.status} — run ${run.id} (${run.name}) did not finish within the wait window; poll GET /v1/runs/${run.id} for status.`);
  try {
    const diff = await operations.runDiff(ws, run.id);
    if (diff.files.length > 0) {
      const shown = diff.files.slice(0, 20).join(", ");
      const more = diff.files.length > 20 ? `, …+${diff.files.length - 20} more` : "";
      lines.push(`Changed ${diff.files.length} file(s), +${diff.add}/-${diff.del}: ${shown}${more}`);
    }
  } catch {
    // No diff available yet (e.g. the run errored before any commit) — the
    // status line above already says enough.
  }
  return lines.join("\n");
}

function chunk(
  id: string,
  created: number,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null,
  extra?: Record<string, unknown>,
) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...extra,
  })}\n\n`;
}

async function streamCompletion(
  reply: FastifyReply,
  deps: OpenAiCompatDeps,
  ws: string,
  modelId: string,
  id: string,
  created: number,
  runId: string,
  taskId: string,
): Promise<void> {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    "x-accel-buffering": "no",
    connection: "keep-alive",
  });
  // The run/task handle rides the FIRST chunk (a non-standard, additive
  // field — ignored by spec-compliant clients) so a streaming caller can
  // start polling GET /v1/runs/:id right away instead of waiting for the
  // final chunk to learn which run it kicked off.
  raw.write(chunk(id, created, modelId, { role: "assistant" }, null, { skynet: { runId, taskId } }));
  try {
    const run = await waitForOutcome(deps.bus, deps.operations, ws, runId, COMPLETION_WAIT_MS);
    const content = await renderOutcome(deps.operations, ws, run);
    raw.write(chunk(id, created, modelId, { content }, null));
    raw.write(chunk(id, created, modelId, {}, "stop"));
  } catch (err) {
    raw.write(chunk(id, created, modelId, { content: `\n[error] ${errMsg(err)}` }, "stop"));
  } finally {
    raw.write("data: [DONE]\n\n");
    raw.end();
  }
}

export async function registerOpenAiCompat(app: FastifyInstance, deps: OpenAiCompatDeps): Promise<void> {
  const { operations } = deps;

  app.get("/v1/models", async (req: FastifyRequest) => {
    const principal = req.principal!;
    const ws = principal.workspaceId;
    const access = projectScope(principal, operations, ws);
    const projects = access.filterProjects(await operations.listProjects(ws));
    return {
      object: "list",
      data: projects.map((p) => ({ id: p.id, object: "model" as const, created: 0, owned_by: "skynet", name: p.name })),
    };
  });

  app.post("/v1/chat/completions", async (req: FastifyRequest, reply: FastifyReply) => {
    const principal = req.principal!;
    const ws = principal.workspaceId;
    const parsed = ChatCompletionRequest.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { message: parsed.error.message, type: "invalid_request_error" } });
    }
    const { model, messages, stream } = parsed.data;

    const access = projectScope(principal, operations, ws);
    const projects = access.filterProjects(await operations.listProjects(ws));
    const project = projects.find((p) => p.id === model) ?? projects.find((p) => p.name.toLowerCase() === model.toLowerCase());
    if (!project) {
      return reply.code(404).send({
        error: { message: `Unknown model "${model}". GET /v1/models for the projects this token can drive.`, type: "invalid_request_error" },
      });
    }

    let taskInput: { text: string; description?: string };
    try {
      taskInput = toTaskInput(messages);
    } catch (err) {
      return reply.code(400).send({ error: { message: errMsg(err), type: "invalid_request_error" } });
    }

    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    let runId: string;
    let taskId: string;
    try {
      const task = await operations.createTask(ws, project.id, taskInput);
      const run = await operations.assignTask(ws, project.id, task.id);
      runId = run.id;
      taskId = task.id;
    } catch (err) {
      return sendError(reply, err);
    }

    if (stream) {
      return streamCompletion(reply, deps, ws, project.id, id, created, runId, taskId);
    }

    const run = await waitForOutcome(deps.bus, operations, ws, runId, COMPLETION_WAIT_MS);
    const content = await renderOutcome(operations, ws, run);
    return {
      id,
      object: "chat.completion",
      created,
      model: project.id,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      // Non-standard, additive field (ignored by spec-compliant clients) so a
      // caller that wants the handle doesn't have to parse it out of prose.
      skynet: { runId: run.id, taskId, status: run.status, costUsd: run.usage?.costUsd ?? null },
    };
  });
}
