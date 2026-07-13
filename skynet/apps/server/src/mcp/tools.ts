// ─── MCP tool core ────────────────────────────────────────────────────────
// Builds a per-principal McpServer exposing Skynet's product surface as tools.
// Every tool delegates to Operations (the same service layer the HTTP API uses)
// and is gated by the calling token's scopes, so an agent is narrowed to exactly
// what it was granted. Tool input schemas reuse the shared Zod contracts, so the
// agent-facing surface can't drift from the human one.

import { McpServer, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  TaskRunStatus,
  ChatRequest,
  ConfigureRunnerRequest,
  CreateProjectRequest,
  CreateTaskRequest,
  ResolveRequest,
  UpdateProjectRequest,
  UpdateRunnerRequest,
  UpdateTaskRequest,
  type ServerEvent,
} from "@skynet/shared";
import { hasScope, type Principal, type Scope } from "../auth.js";
import type { Bus } from "../bus.js";
import type { Operations } from "../operations.js";
import { clampWait, waitForEvent } from "./watch.js";

export interface McpDeps {
  operations: Operations;
  bus: Bus;
}

const INSTRUCTIONS = `Skynet orchestrates a fleet of coding runs across projects. Typical flow:
1. get_snapshot to see projects, runs, fleet runners, and open human-in-the-loop (HITL) items.
2. create_project, then create_task for each unit of work.
3. assign_task to spin up an agent on an idle runner (idempotent — re-assigning returns the existing agent).
4. wait_for_hitl to block until an agent needs a human decision; resolve_hitl to answer it (requires the "approver" scope).
5. wait_for_agent to block until an agent finishes or needs review.
Risky actions (approving diffs, pushing to GitHub) are gated behind HITL. A token without the "approver" scope can observe and drive runs but cannot resolve gates — a human must.`;

type Shape = z.ZodRawShape;
type Args<S extends Shape> = z.infer<z.ZodObject<S>>;

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Build a fresh MCP server bound to one principal. Cheap to construct per
 * request — it just registers tool closures over `deps` and the principal.
 */
export function buildMcpServer(principal: Principal, deps: McpDeps): McpServer {
  const { operations, bus } = deps;
  const ws = principal.workspaceId;
  const server = new McpServer({ name: "skynet", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  const ok = (data: unknown): CallToolResult => ({
    content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
  });
  const err = (message: string): CallToolResult => ({ content: [{ type: "text", text: message }], isError: true });

  // Register a scope-gated tool. Enforcing scope here (not just at token mint)
  // means a stolen/over-broad token still can't exceed its granted capabilities.
  const tool = <S extends Shape>(
    name: string,
    scope: Scope,
    description: string,
    inputSchema: S,
    run: (args: Args<S>) => Promise<unknown> | unknown,
    readOnly = false,
  ): void => {
    const cb = async (args: unknown): Promise<CallToolResult> => {
      if (!hasScope(principal, scope)) {
        return err(`Forbidden: "${name}" requires the "${scope}" scope, which this token was not granted.`);
      }
      try {
        return ok(await run(args as Args<S>));
      } catch (e) {
        return err(errMsg(e));
      }
    };
    // Inside this generic wrapper `S` is abstract, so ToolCallback<S> is an
    // unresolved conditional TS can't match a concrete callback against — the
    // cast is safe: the callback ignores `extra` and returns a CallToolResult.
    server.registerTool(
      name,
      { description, inputSchema, annotations: { readOnlyHint: readOnly } },
      cb as unknown as ToolCallback<S>,
    );
  };

  // ── observe ───────────────────────────────────────────────────────────────
  tool("get_snapshot", "observe", "Full workspace snapshot: projects, runs, fleet runners, HITL queue, providers.", {}, () => operations.snapshot(ws), true);
  tool("list_projects", "observe", "List the workspace's projects.", {}, () => operations.listProjects(ws), true);
  tool("list_agents", "observe", "List the workspace's runs (running, waiting, in review, done).", {}, () => operations.listRuns(ws), true);
  tool("get_agent", "observe", "Get one agent including its plan and recent activity log.", { runId: z.string() }, (a) => operations.getRun(ws, a.runId), true);
  tool("list_hitl", "observe", "List the open human-in-the-loop queue (decisions awaiting an operator).", {}, () => operations.listHitl(ws), true);
  tool("list_audit", "observe", "List resolved HITL decisions, newest first (the audit trail).", {}, () => operations.listAudit(ws), true);

  // ── author ──────────────────────────────────────────────────────────────
  tool("create_project", "author", "Create a project. Bind it to a repo (\"owner/repo\") to enable the PR flow.", CreateProjectRequest.shape, (a) => operations.createProject(ws, a));
  tool("update_project", "author", "Update a project's name, goal, status, or bound repo.", { projectId: z.string(), ...UpdateProjectRequest.shape }, (a) => {
    const { projectId, ...patch } = a;
    return operations.updateProject(ws, projectId, patch);
  });
  tool("create_task", "author", "Add a task to a project's backlog.", { projectId: z.string(), ...CreateTaskRequest.shape }, (a) => {
    const { projectId, ...body } = a;
    return operations.createTask(ws, projectId, body);
  });
  tool("update_task", "author", "Update a task's text or state (backlog | assigned | done).", { taskId: z.string(), ...UpdateTaskRequest.shape }, (a) => {
    const { taskId, ...patch } = a;
    return operations.updateTask(ws, taskId, patch);
  });
  tool("assign_task", "author", "Assign a task to a fresh agent on an idle runner. Idempotent: re-assigning an already-assigned task returns the existing agent.", { projectId: z.string(), taskId: z.string() }, (a) => operations.assignTask(ws, a.projectId, a.taskId));
  tool("message_agent", "author", "Send a chat message to an agent and get its reply.", { runId: z.string(), ...ChatRequest.shape }, async (a) => ({ reply: await operations.chatAgent(ws, a.runId, a.text) }));
  tool("fork_agent", "author", "Fork an agent to explore an alternative from its current step.", { runId: z.string() }, (a) => operations.forkAgent(ws, a.runId));
  tool("stop_agent", "author", "Stop a live agent (frees its runner, retires its worktree).", { runId: z.string() }, async (a) => {
    await operations.stopAgent(ws, a.runId);
    return { stopped: a.runId };
  });
  tool("archive_agent", "author", "Archive (or restore) an agent — hides it from the board without deleting it.", { runId: z.string(), archived: z.boolean().optional() }, (a) => operations.archiveAgent(ws, a.runId, a.archived ?? true));
  tool("configure_runner", "author", "Add a fleet runner (a provider + model slot that can execute one agent).", ConfigureRunnerRequest.shape, (a) => operations.configureRunner(ws, a));
  tool("update_runner", "author", "Update a fleet runner's model or name.", { runnerId: z.string(), ...UpdateRunnerRequest.shape }, (a) => {
    const { runnerId, ...patch } = a;
    return operations.updateAgent(ws, runnerId, patch);
  });
  tool("retire_runner", "author", "Retire an idle fleet runner. Fails if the runner is busy.", { runnerId: z.string() }, async (a) => {
    await operations.retireRunner(ws, a.runnerId);
    return { retired: a.runnerId };
  });

  // ── approver (opt-in scope) ─────────────────────────────────────────────
  tool("resolve_hitl", "approver", "Resolve a human-in-the-loop item: approve | reject | modify | option. Gates diff/push approvals — grant this scope deliberately.", { hitlId: z.string(), ...ResolveRequest.shape }, (a) => {
    const { hitlId, ...input } = a;
    return operations.resolveHitl(ws, hitlId, input, principal.operatorId);
  });

  // ── event waits (block instead of hot-polling) ──────────────────────────
  tool(
    "wait_for_hitl",
    "observe",
    "Block until a HITL item is raised (optionally for a specific agent), or until timeoutMs elapses. Returns an already-open item immediately if one matches.",
    { runId: z.string().optional(), timeoutMs: z.number().int().positive().optional() },
    async (a) => {
      const open = (await operations.listHitl(ws)).filter((h) => !h.resolution && (!a.runId || h.runId === a.runId));
      if (open.length > 0) return { hitl: open[0], waited: false };
      const event = await waitForEvent(
        bus,
        ws,
        (e) => e.type === "hitl.raised" && (!a.runId || e.item.runId === a.runId),
        clampWait(a.timeoutMs),
      );
      if (!event) return { timedOut: true };
      return { hitl: (event as Extract<ServerEvent, { type: "hitl.raised" }>).item, waited: true };
    },
    true,
  );
  tool(
    "wait_for_agent",
    "observe",
    "Block until an agent reaches a target status (default: any terminal state — 'done' or 'review'), or until timeoutMs elapses.",
    { runId: z.string(), status: TaskRunStatus.optional(), timeoutMs: z.number().int().positive().optional() },
    async (a) => {
      const isTerminal = (s: z.infer<typeof TaskRunStatus>) => s === "done" || s === "review";
      const satisfied = (s: z.infer<typeof TaskRunStatus>) => (a.status ? s === a.status : isTerminal(s));
      const agent = await operations.getRun(ws, a.runId); // 404 unless in this workspace
      if (satisfied(agent.status)) return { agent, waited: false };
      const event = await waitForEvent(
        bus,
        ws,
        (e) =>
          (e.type === "run.status" && e.runId === a.runId && satisfied(e.status)) ||
          (e.type === "run.completed" && e.runId === a.runId),
        clampWait(a.timeoutMs),
      );
      const current = await operations.getRun(ws, a.runId);
      return event ? { agent: current, waited: true } : { timedOut: true, agent: current };
    },
    true,
  );

  // ── resource: the live workspace snapshot ────────────────────────────────
  // A client can read this (and re-read it) instead of calling get_snapshot,
  // and subscribe to it for change notifications on capable clients.
  server.registerResource(
    "snapshot",
    "skynet://snapshot",
    { title: "Workspace snapshot", description: "Live projects, runs, fleet runners, HITL queue, and providers.", mimeType: "application/json" },
    async (uri) => {
      if (!hasScope(principal, "observe")) throw new Error(`Forbidden: reading ${uri.href} requires the "observe" scope.`);
      const snapshot = await operations.snapshot(ws);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(snapshot, null, 2) }] };
    },
  );

  // ── prompt: bootstrap an agent operating Skynet ──────────────────────────
  server.registerPrompt(
    "operate_skynet",
    { title: "Operate Skynet", description: "Guidance for driving Skynet's fleet from an MCP client." },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: "You are operating Skynet, a fleet of coding runs. Start by reading the skynet://snapshot resource (or calling get_snapshot) to see current projects, runs, runners, and open HITL items. To do work: create_project, add tasks with create_task, then assign_task to launch an agent on an idle runner. Use wait_for_hitl to block until an agent needs a decision and wait_for_agent to block until one finishes. If a decision is a human's to make and you lack the approver scope, surface it rather than guessing. Never fabricate progress — report tool results faithfully.",
          },
        },
      ],
    }),
  );

  return server;
}
