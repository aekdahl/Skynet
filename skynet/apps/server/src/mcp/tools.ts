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
  CreateFeatureRequest,
  CreateMilestoneRequest,
  CreateProjectContextEntryRequest,
  CreateProjectRequest,
  CreateSolutionBriefRequest,
  CreateTaskRequest,
  ResolveRequest,
  SolutionBriefStatus,
  TaskState,
  UpdateFeatureRequest,
  UpdateMilestoneRequest,
  UpdateProjectRequest,
  UpdateRunnerRequest,
  UpdateSolutionBriefRequest,
  UpdateTaskRequest,
  UpdateWorkspaceSettingsRequest,
  type ServerEvent,
  type Snapshot,
} from "@skynet/shared";
import { hasScope, type Principal, type Scope } from "../auth.js";
import type { Bus } from "../bus.js";
import type { Operations } from "../operations.js";
import { projectScope } from "./project-scope.js";
import {
  clip,
  clipPatch,
  DEFAULT_LOG_DETAIL_CHARS,
  DEFAULT_LOG_LIMIT,
  MAX_LIST_LIMIT,
  MAX_LOG_DETAIL_CHARS,
  MAX_LOG_LIMIT,
  MAX_PATCH_CHARS,
  paginate,
  SNAPSHOT_CAP,
  summarizeAudit,
  summarizeBrief,
  summarizeHitl,
  summarizeRun,
  summarizeTask,
} from "./summarize.js";
import { clampWait, waitForEvent } from "./watch.js";

export interface McpDeps {
  operations: Operations;
  bus: Bus;
}

const INSTRUCTIONS = `Skynet orchestrates a fleet of coding runs across projects. Typical flow:
1. get_snapshot to see projects, runs, fleet runners, and open human-in-the-loop (HITL) items.
2. create_project, then create_task for each unit of work.
3. assign_task to spin up an agent on an idle runner (idempotent — re-assigning returns the existing agent).
4. wait_for_hitl to block until an agent needs a human decision; read the change with run_diff, then resolve_hitl to answer it (requires the "approver" scope).
5. wait_for_agent to block until an agent finishes or needs review.
6. Move work across the board with transition_task (triage→todo, review→done, ongoing→todo to abandon); prioritize with move_task / reorder_task; group with features + milestones.
Risky actions (approving diffs, pushing to GitHub) are gated behind HITL. A token without the "approver" scope can observe and drive runs but cannot resolve gates — a human must.
Every list_* tool, get_snapshot, wait_for_agent, and the skynet://snapshot resource return COMPACT SUMMARIES, not full records — no activity logs, long docs, decision prose, or captured diff patches, so reading a busy workspace stays cheap. Once you've found the ONE record you care about, drill in: get_agent (run + log), get_task, get_hitl (a decision's full command/output/walkthrough), get_brief, get_audit. Clipped text ends with an explicit "…[+N chars]" marker; large payloads have raise-the-cap params (get_agent's logDetailChars, run_diff/get_audit's maxPatchChars) — never assume an unmarked field was truncated.
Every update_* tool (update_task, update_feature, update_milestone, update_project, update_runner, update_workspace_settings) is a true PATCH: send ONLY the field(s) you actually want to change. Omitting a field leaves it untouched; explicitly passing a nullable field as null CLEARS it (e.g. update_task's featureId: null removes the task from its feature). Sending null for a field you don't intend to change WILL wipe it out — never fill in every schema property just because it's listed as a parameter.`;

type Shape = z.ZodRawShape;
type Args<S extends Shape> = z.infer<z.ZodObject<S>>;

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Push a compact notification about a raised HITL gate to the connected MCP
 * client — so an idle MCP agent (or a Claude Code / Cursor client) is pinged
 * the moment a decision is needed, without having to be inside a
 * `wait_for_hitl` call. Delivered as MCP `notifications/message` (level=info,
 * logger="skynet.hitl", data=<structured payload>) — the SDK routes it
 * through the active transport (stdio is push-native; HTTP requires the
 * server-side transport to be in session mode, see http.ts). Clients that
 * didn't declare `logging` capability just don't see it — safe to send.
 */
export interface HitlNotification {
  workspaceId: string;
  hitlId: string;
  runId: string;
  kind: string;
  risk: string;
  title: string;
  // A one-shot hint so a UI-less client can approve/reject immediately:
  // the exact tool + args it would call. Advisory — never trust it.
  approverHint?: { tool: "resolve_hitl"; args: { hitlId: string } };
}

/**
 * Build a fresh MCP server bound to one principal. Cheap to construct per
 * request — it just registers tool closures over `deps` and the principal.
 *
 * A workspace bus subscription is set up here and torn down in `server.close()`
 * so push notifications for HITL gates / status changes fire on the caller's
 * MCP transport. See sendHitlNotification / sendReviewNotification below.
 */
export function buildMcpServer(principal: Principal, deps: McpDeps): McpServer {
  const { operations, bus } = deps;
  const ws = principal.workspaceId;
  // Project confinement (Principal.projectIds). Unrestricted for humans /
  // workspace-wide tokens — `restricted` is false and every check below no-ops.
  const projectAccess = projectScope(principal, operations, ws);
  // `capabilities.logging` is required for `sendLoggingMessage` to fire — the
  // SDK silently drops the notification otherwise. We only *send* logs (HITL
  // push, review push); we do not implement `logging/setLevel`, so the
  // capability object stays empty.
  const server = new McpServer(
    { name: "skynet", version: "0.1.0" },
    { instructions: INSTRUCTIONS, capabilities: { logging: {} } },
  );

  // Push a raised HITL gate to the client. Best-effort — swallow send errors
  // (transport may be closing / not supporting logging); the wait_for_* long-poll
  // remains the reliable fallback for clients that missed the push.
  const pushHitl = (event: Extract<ServerEvent, { type: "hitl.raised" }>): void => {
    const data: HitlNotification = {
      workspaceId: ws,
      hitlId: event.item.id,
      runId: event.item.runId,
      kind: event.item.kind,
      risk: event.item.risk,
      title: event.item.title,
      // Include the approve tool + args only for clients that hold the scope
      // — a hint that leaks the action name to an unauth'd client is fine
      // (the scope check still runs on invoke), but keeping it tight is
      // better UX (no dead-end suggestion).
      ...(hasScope(principal, "approver")
        ? { approverHint: { tool: "resolve_hitl" as const, args: { hitlId: event.item.id } } }
        : {}),
    };
    void server.server
      .sendLoggingMessage({ level: event.item.risk === "high" ? "warning" : "info", logger: "skynet.hitl", data })
      .catch(() => undefined);
  };
  // A run just entered "needs attention" — distinct logger so clients can route
  // (a review push isn't necessarily an approval decision — see the run's HITL).
  const pushReview = (runId: string): void => {
    void server.server
      .sendLoggingMessage({ level: "info", logger: "skynet.run", data: { workspaceId: ws, runId, status: "review" as const } })
      .catch(() => undefined);
  };

  // Push HITL raises / review flips to the client. Subscribe once per constructed
  // server; the `close()` override below tears the subscription down so a
  // disconnecting client doesn't leave a dangling handler on the bus. bus.subscribe
  // already scopes to the workspace; for a PROJECT-scoped token we additionally
  // resolve the run's project and drop pushes outside the allowlist (async,
  // best-effort) so a confined token is never notified about work it can't see.
  const confined = async (runId: string): Promise<boolean> =>
    !projectAccess.restricted || (await projectAccess.filterByRun([{ runId }])).length > 0;
  const unsubscribeBus = bus.subscribe(ws, (event) => {
    if (event.type === "hitl.raised" && !event.item.resolvedAt) {
      void confined(event.item.runId).then((allow) => allow && pushHitl(event));
    } else if (event.type === "run.status" && event.status === "review") {
      void confined(event.runId).then((allow) => allow && pushReview(event.runId));
    }
  });
  // Preserve the SDK's own `close()` and add our unsubscribe on top of it.
  const priorClose = server.close.bind(server);
  server.close = async () => {
    unsubscribeBus();
    await priorClose();
  };

  // Compact JSON, deliberately NOT pretty-printed: MCP results are read by a
  // model, not a human, and 2-space indentation on deeply nested records adds
  // a double-digit percentage of pure whitespace tokens to every single call.
  const ok = (data: unknown): CallToolResult => ({
    content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data) }],
  });
  const err = (message: string): CallToolResult => ({ content: [{ type: "text", text: message }], isError: true });

  // Register a scope-gated tool. Enforcing scope here (not just at token mint)
  // means a stolen/over-broad token still can't exceed its granted capabilities.
  //
  // opts.filter marks a workspace-wide READ: its result is narrowed to the
  // token's allowed projects before returning. Any other tool that mutates or
  // names a specific record is GATED — a project-scoped token must resolve to an
  // allowed project or the call is refused (see project-scope.ts). opts.selfGuarded
  // opts a tool out of the wrapper's gate/filter because it enforces confinement
  // in its own body (the optional-runId waits).
  const tool = <S extends Shape>(
    name: string,
    scope: Scope,
    description: string,
    inputSchema: S,
    run: (args: Args<S>) => Promise<unknown> | unknown,
    opts: {
      readOnly?: boolean;
      filter?: (result: unknown) => Promise<unknown> | unknown;
      selfGuarded?: boolean;
    } = {},
  ): void => {
    const cb = async (args: unknown): Promise<CallToolResult> => {
      if (!hasScope(principal, scope)) {
        return err(`Forbidden: "${name}" requires the "${scope}" scope, which this token was not granted.`);
      }
      try {
        if (projectAccess.restricted && !opts.selfGuarded) {
          if (opts.filter) {
            // Workspace-wide read → confine the result to allowed projects.
            return ok(await opts.filter(await run(args as Args<S>)));
          }
          // Mutation / id-scoped call → gate on the project it targets.
          const denied = await projectAccess.gate((args ?? {}) as Record<string, unknown>);
          if (denied) return err(denied);
        }
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
      { description, inputSchema, annotations: { readOnlyHint: opts.readOnly ?? false } },
      cb as unknown as ToolCallback<S>,
    );
  };

  // ── observe ───────────────────────────────────────────────────────────────
  // The workspace-wide reads carry a `filter` so a project-scoped token sees
  // only its own projects' data; `get_agent` names a run and is gated instead.
  //
  // list_agents / list_tasks / list_audit / get_snapshot are summarized +
  // paginated (see summarize.ts) — a workspace's runs carry an unbounded
  // activity log and its audit trail embeds full diff patches, so returning
  // full records for EVERY row on a listing call scales token cost with
  // workspace history, not with what the caller actually asked for. These
  // three do their own project-confinement inline (selfGuarded) so filtering
  // can happen BEFORE pagination — total/hasMore must reflect the token's
  // own visible set, not the whole workspace's.
  const pageArgs = {
    limit: z.number().int().positive().max(MAX_LIST_LIMIT).optional(),
    offset: z.number().int().nonnegative().optional(),
  };
  // The summarized workspace overview, shared verbatim by the get_snapshot
  // tool AND the skynet://snapshot resource — the resource previously returned
  // the RAW snapshot (every run's full activity log, every brief's full doc),
  // silently bypassing the summarization the tool already had.
  const snapshotView = async () => {
    // filterSnapshot (not opts.filter): opts.filter only runs for
    // project-restricted tokens (see tool()'s gate/filter branch below), which
    // would skip summarization entirely for the common unrestricted case
    // (human sessions, workspace-wide tokens) — exactly the callers this fix
    // targets. filterSnapshot is a no-op when unrestricted, so this stays
    // correct either way.
    const snap = await projectAccess.filterSnapshot((await operations.snapshot(ws)) as Snapshot);
    const runs = snap.runs.slice().sort((x, y) => y.lastHeartbeatAt - x.lastHeartbeatAt);
    return {
      ...snap,
      runs: runs.slice(0, SNAPSHOT_CAP).map(summarizeRun),
      runsTotal: runs.length,
      tasks: snap.tasks.slice(0, SNAPSHOT_CAP).map(summarizeTask),
      tasksTotal: snap.tasks.length,
      queue: snap.queue.map(summarizeHitl),
      solutionBriefs: snap.solutionBriefs.map(summarizeBrief),
    };
  };
  tool(
    "get_snapshot",
    "observe",
    "Workspace overview: projects, fleet runners, providers, plus runs/tasks/HITL queue/briefs as compact summaries (same shapes as list_agents/list_tasks/list_hitl/list_briefs — no activity logs, decision prose, or long docs). Capped at 200 runs/tasks each (most recently active first); beyond that use the list_* tools with pagination, or get_agent/get_task/get_hitl/get_brief for one record's full detail.",
    {},
    snapshotView,
    { readOnly: true, selfGuarded: true },
  );
  tool("list_projects", "observe", "List the workspace's projects.", {}, () => operations.listProjects(ws), {
    readOnly: true,
    filter: (r) => projectAccess.filterProjects(r as { id: string }[]),
  });
  tool(
    "list_agents",
    "observe",
    "List the workspace's runs as compact summaries (id, name, status, progress, current plan step, project/agent, cost) — NOT the full record, no activity log. Defaults to the 30 most recently active, excluding archived; filter with `status`, page with `limit`/`offset`. Use get_agent for one run's full detail.",
    { status: z.array(TaskRunStatus).optional(), includeArchived: z.boolean().optional(), ...pageArgs },
    async (a) => {
      let runs = projectAccess.filterByProjectId(await operations.listRuns(ws));
      if (!a.includeArchived) runs = runs.filter((r) => !r.archived);
      if (a.status && a.status.length > 0) runs = runs.filter((r) => a.status!.includes(r.status));
      runs = runs.slice().sort((x, y) => y.lastHeartbeatAt - x.lastHeartbeatAt);
      const page = paginate(runs, a.limit, a.offset);
      return { ...page, items: page.items.map(summarizeRun) };
    },
    { readOnly: true, selfGuarded: true },
  );
  tool(
    "get_agent",
    "observe",
    "Get one agent's full detail: status, plan, usage, and its activity log (tool calls + outputs). The log defaults to the most recent 100 entries (see `logTotal`/`logTruncated`); page further back with `logLimit`/`logOffset`. Each entry's expandable `detail` (a tool call's full input/output) is clipped to 600 chars by default — a clipped one ends with an `…[+N chars]` marker; re-call with `logDetailChars` (up to 6000) for more, or 0 to drop details and read just the lines.",
    {
      runId: z.string(),
      logLimit: z.number().int().positive().max(MAX_LOG_LIMIT).optional(),
      logOffset: z.number().int().nonnegative().optional(),
      logDetailChars: z.number().int().nonnegative().max(MAX_LOG_DETAIL_CHARS).optional(),
    },
    async (a) => {
      const run = await operations.getRun(ws, a.runId);
      const logLimit = Math.min(a.logLimit ?? DEFAULT_LOG_LIMIT, MAX_LOG_LIMIT);
      // Default offset tails the log (most recent entries) — an activity log's
      // most useful default view is "what's happening now", not "what happened
      // first". An explicit logOffset always wins.
      const logOffset = a.logOffset ?? Math.max(0, run.log.length - logLimit);
      const detailChars = a.logDetailChars ?? DEFAULT_LOG_DETAIL_CHARS;
      const log = run.log.slice(logOffset, logOffset + logLimit).map((l) => {
        if (l.detail == null) return l;
        if (detailChars === 0) {
          const { detail: _detail, ...rest } = l;
          return rest;
        }
        return { ...l, detail: clip(l.detail, detailChars) };
      });
      return { ...run, log, logTotal: run.log.length, logTruncated: log.length < run.log.length };
    },
    { readOnly: true },
  );
  tool(
    "run_diff",
    "observe",
    "Get a run's working diff: the unified patch plus added/deleted line counts and changed files. Read this to see what a run actually changed before resolving its review gate. The patch is clipped to 30k chars by default (`patchTruncated`/`patchChars` report the cut); re-call with `maxPatchChars` (up to 200k) for more.",
    { runId: z.string(), maxPatchChars: z.number().int().positive().max(MAX_PATCH_CHARS).optional() },
    async (a) => {
      const d = await operations.runDiff(ws, a.runId);
      return { ...d, ...clipPatch(d.patch, a.maxPatchChars) };
    },
    { readOnly: true },
  );
  tool(
    "list_tasks",
    "observe",
    "List the workspace's tasks as compact summaries (id, text, state, project/run, autoPick) — NOT full detail, no description/assessment/lint text. Excludes archived by default; filter with `state`, page with `limit`/`offset`. Use get_task for one task's full detail.",
    { state: z.array(TaskState).optional(), includeArchived: z.boolean().optional(), ...pageArgs },
    async (a) => {
      let tasks = projectAccess.filterByProjectId(await operations.listTasks(ws));
      if (!a.includeArchived) tasks = tasks.filter((t) => !t.archived);
      if (a.state && a.state.length > 0) tasks = tasks.filter((t) => a.state!.includes(t.state));
      const page = paginate(tasks, a.limit, a.offset);
      return { ...page, items: page.items.map(summarizeTask) };
    },
    { readOnly: true, selfGuarded: true },
  );
  tool("get_task", "observe", "Get one task's full detail: description, structured triage read-out (effort/risks), review verdict, and lint concerns — the full record list_tasks summarizes away.", { taskId: z.string() }, (a) => operations.getTask(ws, a.taskId), { readOnly: true });
  tool("list_features", "observe", "List the workspace's features (task groupings). Scoped tokens see only their projects'.", {}, () => operations.listFeatures(ws), {
    readOnly: true,
    filter: (r) => projectAccess.filterByProjectId(r as { projectId: string }[]),
  });
  tool("list_milestones", "observe", "List the workspace's milestones (dated roadmap checkpoints). Scoped tokens see only their projects'.", {}, () => operations.listMilestones(ws), {
    readOnly: true,
    filter: (r) => projectAccess.filterByProjectId(r as { projectId: string }[]),
  });
  tool(
    "list_briefs",
    "observe",
    "List the workspace's solution briefs as compact summaries (id, title, status, a clipped problem teaser, and section counts) — NOT the full docs; a brief's problem/approach/options/risks/criteria are long-form markdown. Use get_brief for one brief's full detail. Scoped tokens see only their projects'.",
    {},
    async () => (await projectAccess.filterByProjectId(await operations.listBriefs(ws))).map(summarizeBrief),
    { readOnly: true, selfGuarded: true },
  );
  tool("get_brief", "observe", "Get one solution brief's full detail.", { briefId: z.string() }, (a) => operations.getBrief(ws, a.briefId), { readOnly: true });
  tool(
    "list_hitl",
    "observe",
    "List the open human-in-the-loop queue (decisions awaiting an operator) as compact summaries: kind, risk, title/why, options, diff stats, plus a clipped command and presence signals (outputChars, hasWalkthrough/hasMergeBrief) instead of the full decision prose. Use get_hitl for the ONE item you're about to act on.",
    {},
    async () => (await projectAccess.filterByRun(await operations.listHitl(ws))).map(summarizeHitl),
    { readOnly: true, selfGuarded: true },
  );
  tool(
    "get_hitl",
    "observe",
    "Get one HITL item's full record: the complete command/preview text, a verifier gate's captured check output, plan steps, and a diff gate's walkthrough + merge brief — everything list_hitl summarizes away. Read this (plus run_diff for a diff gate) before resolve_hitl.",
    { hitlId: z.string() },
    (a) => operations.getHitl(ws, a.hitlId),
    { readOnly: true },
  );
  tool(
    "list_audit",
    "observe",
    "List resolved HITL decisions as compact summaries (action, kind, risk, diff stats), newest first — NOT the full payload, no rationale text or captured diff patch. Excludes archived by default; page with `limit`/`offset`. Use get_audit for one decision's full record.",
    { includeArchived: z.boolean().optional(), ...pageArgs },
    async (a) => {
      let records = await projectAccess.filterByRun(await operations.listAudit(ws));
      if (!a.includeArchived) records = records.filter((r) => !r.archived);
      records = records.slice().sort((x, y) => y.at - x.at);
      const page = paginate(records, a.limit, a.offset);
      return { ...page, items: page.items.map(summarizeAudit) };
    },
    { readOnly: true, selfGuarded: true },
  );
  tool(
    "get_audit",
    "observe",
    "Get one resolved HITL decision's full record: rationale, guidance, options, and — for a diff/merge decision — the captured unified diff patch. The full record list_audit summarizes away. The captured patch is clipped to 30k chars by default (`patchTruncated`/`patchChars` on the payload report the cut); re-call with `maxPatchChars` (up to 200k) for more.",
    { hitlId: z.string(), maxPatchChars: z.number().int().positive().max(MAX_PATCH_CHARS).optional() },
    async (a) => {
      const record = await operations.getAuditRecord(ws, a.hitlId);
      // payload is z.unknown() — only touch it when it carries a string patch.
      const p = record.payload;
      if (p && typeof p === "object" && typeof (p as { patch?: unknown }).patch === "string") {
        return { ...record, payload: { ...(p as object), ...clipPatch((p as { patch: string }).patch, a.maxPatchChars) } };
      }
      return record;
    },
    { readOnly: true },
  );
  tool(
    "get_settings",
    "observe",
    "Read the workspace's non-secret settings: the fleet auto-scale policy (autoProvisionRunners + maxRunners) and which providers have a usable key. Project settings live on each project (update_project); secrets are never exposed via MCP.",
    {},
    async () => {
      const [fleet, providers] = await Promise.all([operations.getWorkspaceSettings(ws), operations.listProviders(ws)]);
      return { fleet, providers: providers.map((p) => ({ id: p.id, name: p.name, available: p.available })) };
    },
    // Non-secret workspace metadata (already visible in get_snapshot), so a
    // project-scoped token may read it too — skip the workspace-level gate.
    { readOnly: true, selfGuarded: true },
  );

  // ── author ──────────────────────────────────────────────────────────────
  tool(
    "update_settings",
    "author",
    "Update the workspace fleet policy: autoProvisionRunners (auto-add a runner, cloned from a busy one on an allowed key, when a task has none free), maxRunners (hard cap on fleet size; 0 = no cap), and browserTools (give Claude runners a real browser via a Playwright MCP server; off by default). Workspace-level — a project-scoped token cannot change it.",
    UpdateWorkspaceSettingsRequest.shape,
    (a) => operations.updateWorkspaceSettings(ws, a),
  );
  tool("create_project", "author", "Create a project. Bind it to a repo (\"owner/repo\" via `repo`, or an existing repo's git URL via `repoUrl` to clone it) to enable the PR flow.", CreateProjectRequest.shape, (a) => operations.createProject(ws, a));
  tool("update_project", "author", "Update a project's name, goal, status, or bound repo.", { projectId: z.string(), ...UpdateProjectRequest.shape }, (a) => {
    const { projectId, ...patch } = a;
    return operations.updateProject(ws, projectId, patch);
  });
  // The project's "brain": raw pasted/uploaded material (the web UI's
  // "Context" tab) condensed into Project.contextSummary — the primer every
  // agent's task prompt and Steward's grounding read (agent-context.ts).
  // Exposing read/write here is the point of "Memory as an MCP server": any
  // MCP client, including one never run through Skynet, sees and grows the
  // same portable memory driving every agent's prompt.
  tool(
    "list_memory",
    "observe",
    "List a project's memory entries — the raw pasted notes / uploaded docs behind its condensed primer (see get_snapshot/list_projects for a project's current contextSummary). Newest first.",
    { projectId: z.string() },
    (a) => operations.listContextEntries(ws, a.projectId),
    { readOnly: true },
  );
  tool(
    "add_memory",
    "author",
    "Add a note to a project's memory (pasted text; file upload is web-UI only). Automatically re-condenses the project's primer (contextSummary) that every agent's prompt and Steward read.",
    { projectId: z.string(), ...CreateProjectContextEntryRequest.shape },
    (a) => {
      const { projectId, ...body } = a;
      return operations.addContextEntry(ws, projectId, principal.operatorId, body);
    },
  );
  tool(
    "delete_memory",
    "author",
    "Delete one memory entry from a project. Automatically re-condenses the project's primer (contextSummary).",
    { projectId: z.string(), entryId: z.string() },
    async (a) => {
      await operations.deleteContextEntry(ws, a.projectId, a.entryId);
      return { deleted: a.entryId };
    },
  );
  tool(
    "refresh_memory",
    "author",
    "Re-condense a project's accumulated memory entries into its primer (contextSummary) on demand. Normally automatic on add_memory/delete_memory — use this after an out-of-band change or to force a fresh pass.",
    { projectId: z.string() },
    (a) => operations.refreshProjectContext(ws, a.projectId),
  );
  tool("create_task", "author", "Add a task to a project's backlog.", { projectId: z.string(), ...CreateTaskRequest.shape }, (a) => {
    const { projectId, ...body } = a;
    return operations.createTask(ws, projectId, body);
  });
  tool("update_task", "author", "Update a task's editable fields: text, description, autoPick, agent eligibility (assignment), schedule (estimatedDurationMs / plannedStartAt), or roadmap link (featureId / milestoneId). To MOVE a task through the board (change its state) use transition_task — state transitions are guarded and can't be set here. PATCH semantics: omit any field you don't want to change — every field here is nullable, and passing one as null explicitly CLEARS it (e.g. featureId: null un-links the task). Never include a field just because it's in the schema; only send what you're actually changing.", { taskId: z.string(), ...UpdateTaskRequest.shape }, (a) => {
    const { taskId, ...patch } = a;
    return operations.updateTask(ws, taskId, patch);
  });
  tool(
    "transition_task",
    "author",
    "Move a task through the kanban to a new state (backlog | triage | todo | ongoing | review | done). Only legal human transitions are allowed (e.g. triage→todo, review→done approves the diff gate, ongoing→todo abandons + detaches the run); an illegal jump is refused. `todo→ongoing` is not here — use assign_task to start a run.",
    { taskId: z.string(), to: TaskState },
    (a) => operations.transitionTask(ws, a.taskId, a.to, principal.operatorId),
  );
  tool("force_task_done", "author", "Escape hatch: force a task straight to done from any state — commits + pushes/opens a PR (or enqueues the local merge) through the same path a normal Approve uses, so it's really done, not just relabeled. A quick completeness check runs first when skipping an open gate; if it looks incomplete, nothing is pushed and a real diff review is raised instead. Use only when the normal review→done path is stuck (wedged gate, run finished out-of-band).", { taskId: z.string() }, (a) => operations.forceTaskDone(ws, a.taskId, principal.operatorId));
  tool("request_review", "author", "Force a review pass on a review-stage task now, instead of waiting for a periodic tick to find an idle reviewer on its own. Throws if the task isn't in review with an open gate, already has a verdict, or no other (non-doer) agent is free to review right now.", { taskId: z.string() }, (a) => operations.requestReview(ws, a.taskId));
  tool("request_retriage", "author", "Force a fresh triage pass on a task already parked in triage, instead of waiting for it to cycle back through backlog on its own. Throws if the task isn't in triage right now, or no agent is idle.", { taskId: z.string() }, (a) => operations.requestRetriage(ws, a.taskId));
  tool("force_review", "author", "Pull a still-ongoing task's live run up for review right now, instead of waiting for the agent to finish its own turn. Commits whatever's on the worktree, stops the live session, and raises a diff review. Throws if the task isn't ongoing, its run isn't live, or nothing has changed yet.", { taskId: z.string() }, (a) => operations.forceReview(ws, a.taskId));
  tool("reassign_task_agent", "author", "Move a still-ongoing task's live run to a specific idle agent — keeps the same worktree/branch/committed work, stops the current session, and resumes it on the target. Throws if the task isn't ongoing, or the target agent isn't found/idle/usable (the live run is left untouched in that case).", { taskId: z.string(), agentId: z.string() }, (a) => operations.reassignTaskAgent(ws, a.taskId, a.agentId));
  tool("move_task", "author", "Bump a task up or down within its column's priority order (also the auto-pick order when Autonomy is on).", { taskId: z.string(), direction: z.enum(["up", "down"]) }, (a) => operations.moveTask(ws, a.taskId, a.direction));
  tool("reorder_task", "author", "Reorder a task to sit immediately before another task in the same column (beforeId = null moves it to the end).", { taskId: z.string(), beforeId: z.string().nullable() }, (a) => operations.reorderTask(ws, a.taskId, a.beforeId));
  tool("archive_task", "author", "Archive (or restore) a task — hides it from the board without deleting it (still read by Steward).", { projectId: z.string(), taskId: z.string(), archived: z.boolean().optional() }, (a) => operations.archiveTask(ws, a.projectId, a.taskId, a.archived ?? true));
  tool("delete_task", "author", "Permanently delete a task. Prefer archive_task unless you truly need it gone.", { taskId: z.string() }, async (a) => {
    await operations.deleteTask(ws, a.taskId);
    return { deleted: a.taskId };
  });
  tool("import_github_issues", "author", "Import a project's connected-repo open GitHub issues as tasks (deduped; sets each task's source so status changes can sync back). Needs the project bound to a GitHub repo.", { projectId: z.string() }, (a) => operations.importGithubIssues(ws, a.projectId));
  tool("import_repo_file", "author", "Import a repo file's `- [ ]` checklist items as tasks (anchored by label; completing one later checks its box). Needs the project bound to a GitHub repo.", { projectId: z.string(), path: z.string() }, (a) => operations.importRepoFile(ws, a.projectId, a.path));
  tool("resync_source", "author", "Catch up GitHub sync both ways for a project in one call: pull new/edited issues and repo-file checklist items into tasks, and push any task status change that never made it back (e.g. from before syncSourceStatus was on, or a failed write-back). Needs the project bound to a GitHub repo. Returns {imported, updated, pushed}.", { projectId: z.string() }, (a) => operations.resyncProjectSource(ws, a.projectId));
  tool("create_feature", "author", "Create a feature (a task grouping) in a project. Optionally roll it up into a milestone via `milestoneId`.", { projectId: z.string(), ...CreateFeatureRequest.shape }, (a) => {
    const { projectId, ...body } = a;
    return operations.createFeature(ws, projectId, body);
  });
  tool("update_feature", "author", "Update a feature's name, description, status, milestone (milestoneId), or archived flag.", { featureId: z.string(), ...UpdateFeatureRequest.shape }, (a) => {
    const { featureId, ...patch } = a;
    return operations.updateFeature(ws, featureId, patch);
  });
  tool("create_milestone", "author", "Create a milestone (a dated roadmap checkpoint) in a project.", { projectId: z.string(), ...CreateMilestoneRequest.shape }, (a) => {
    const { projectId, ...body } = a;
    return operations.createMilestone(ws, projectId, body);
  });
  tool("update_milestone", "author", "Update a milestone's name, target date, status (e.g. mark it shipped), or archived flag.", { milestoneId: z.string(), ...UpdateMilestoneRequest.shape }, (a) => {
    const { milestoneId, ...patch } = a;
    return operations.updateMilestone(ws, milestoneId, patch);
  });
  tool("delete_milestone", "author", "Delete a milestone. Features + tasks in it keep existing but lose the grouping.", { milestoneId: z.string() }, async (a) => {
    await operations.deleteMilestone(ws, a.milestoneId);
    return { deleted: a.milestoneId };
  });
  tool("delete_feature", "author", "Delete a feature (task grouping). Tasks in it keep existing but lose the grouping.", { featureId: z.string() }, async (a) => {
    await operations.deleteFeature(ws, a.featureId);
    return { deleted: a.featureId };
  });
  tool(
    "create_brief",
    "author",
    "Create a solution brief (a pre-work planning doc — problem, approach, options considered, risks, acceptance criteria, open questions — for a chunk of work BEFORE any task or run exists for it) in a project. Optionally roll it up into a feature via `featureId`.",
    { projectId: z.string(), ...CreateSolutionBriefRequest.shape },
    (a) => {
      const { projectId, ...body } = a;
      return operations.createBrief(ws, projectId, body);
    },
  );
  tool(
    "update_brief",
    "author",
    'Update a solution brief\'s content (title/problem/approach/optionsConsidered/risks/acceptanceCriteria/openQuestions), its feature link (featureId), or move its status to "building"/"done". PATCH semantics: omit any field you don\'t want to change. Approving a brief (status: "approved") is NOT available here — that\'s human/API only (the web UI, or a direct call carrying full/unscoped authority), never an agent-scoped token like this one; this tool\'s status field structurally excludes "approved", so there is nothing to bypass — ask the operator to approve it themselves.',
    { briefId: z.string(), ...UpdateSolutionBriefRequest.shape, status: SolutionBriefStatus.exclude(["approved"]).optional() },
    (a) => {
      const { briefId, ...patch } = a;
      return operations.updateBrief(ws, briefId, patch, principal.operatorId);
    },
  );
  tool("assign_task", "author", "Assign a task to a fresh agent on an idle runner. Idempotent: re-assigning an already-assigned task returns the existing agent.", { projectId: z.string(), taskId: z.string() }, (a) => operations.assignTask(ws, a.projectId, a.taskId));
  tool("message_agent", "author", "Send a chat message to an agent and get its reply.", { runId: z.string(), ...ChatRequest.shape }, async (a) => ({ reply: await operations.chatAgent(ws, a.runId, a.text) }));
  tool("fork_agent", "author", "Fork an agent to explore an alternative from its current step.", { runId: z.string() }, (a) => operations.forkAgent(ws, a.runId));
  tool("stop_agent", "author", "Stop a live agent (frees its runner, retires its worktree).", { runId: z.string() }, async (a) => {
    await operations.stopAgent(ws, a.runId);
    return { stopped: a.runId };
  });
  tool("archive_agent", "author", "Archive (or restore) an agent — hides it from the board without deleting it.", { runId: z.string(), archived: z.boolean().optional() }, (a) => operations.archiveAgent(ws, a.runId, a.archived ?? true));
  tool("pause_agent", "author", "Pause a live agent — it stops working but keeps its runner + worktree so resume_agent can continue it.", { runId: z.string() }, (a) => operations.pauseAgent(ws, a.runId));
  tool("resume_agent", "author", "Resume a paused agent where it left off.", { runId: z.string() }, (a) => operations.resumeAgent(ws, a.runId));
  tool(
    "configure_runner",
    "author",
    "Add a fleet runner (a provider + model slot that can execute one agent). A project-scoped token may add capacity, but only on a provider key enabled for one of its projects.",
    ConfigureRunnerRequest.shape,
    async (a) => {
      // A project-scoped token CAN add fleet capacity (so it never starves) — but
      // only on a key its project(s) are allowed to run on. Enforced here rather
      // than via the generic gate (which would blanket-deny a keyless mutation).
      if (projectAccess.restricted) {
        const denied = await projectAccess.gateRunnerConfig(a.provider, a.credentialId ?? null);
        if (denied) throw new Error(denied);
      }
      return operations.configureRunner(ws, a);
    },
    { selfGuarded: true },
  );
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
      // Confinement: a scoped token waiting on a specific run must be allowed it;
      // a broad wait only ever surfaces gates from its allowed projects.
      if (projectAccess.restricted && a.runId) {
        const denied = await projectAccess.gate({ runId: a.runId });
        if (denied) throw new Error(denied);
      }
      let open = (await operations.listHitl(ws)).filter((h) => !h.resolution && (!a.runId || h.runId === a.runId));
      open = await projectAccess.filterByRun(open);
      if (open.length > 0) return { hitl: open[0], waited: false };
      const event = await waitForEvent(
        bus,
        ws,
        (e) => e.type === "hitl.raised" && (!a.runId || e.item.runId === a.runId),
        clampWait(a.timeoutMs),
      );
      if (!event) return { timedOut: true };
      const item = (event as Extract<ServerEvent, { type: "hitl.raised" }>).item;
      // A gate raised on a project outside the allowlist isn't this token's to see.
      if (projectAccess.restricted && (await projectAccess.filterByRun([item])).length === 0) return { timedOut: true };
      return { hitl: item, waited: true };
    },
    { readOnly: true, selfGuarded: true },
  );
  tool(
    "wait_for_agent",
    "observe",
    "Block until an agent reaches a target status (default: any terminal state — 'done' or 'review'), or until timeoutMs elapses. Returns the run as a compact summary (same shape as list_agents) — drill into the transcript with get_agent, or the change with run_diff.",
    { runId: z.string(), status: TaskRunStatus.optional(), timeoutMs: z.number().int().positive().optional() },
    async (a) => {
      const isTerminal = (s: z.infer<typeof TaskRunStatus>) => s === "done" || s === "review";
      const satisfied = (s: z.infer<typeof TaskRunStatus>) => (a.status ? s === a.status : isTerminal(s));
      // Summarized, not the full record: the full run embeds its ENTIRE
      // activity log, and "the agent finished" is a triage moment — the caller
      // decides what to read next (get_agent / run_diff), not receives it all.
      const agent = await operations.getRun(ws, a.runId); // 404 unless in this workspace
      if (satisfied(agent.status)) return { agent: summarizeRun(agent), waited: false };
      const event = await waitForEvent(
        bus,
        ws,
        (e) =>
          (e.type === "run.status" && e.runId === a.runId && satisfied(e.status)) ||
          (e.type === "run.completed" && e.runId === a.runId),
        clampWait(a.timeoutMs),
      );
      const current = summarizeRun(await operations.getRun(ws, a.runId));
      return event ? { agent: current, waited: true } : { timedOut: true, agent: current };
    },
    { readOnly: true },
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
      // Same confinement AND the same summarized shape as get_snapshot — the raw
      // snapshot (full activity logs, full brief docs, decision prose) is
      // exactly what summarize.ts exists to keep off the MCP wire.
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await snapshotView()) }] };
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
