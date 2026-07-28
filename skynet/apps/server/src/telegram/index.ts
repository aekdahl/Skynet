// ─── Telegram messaging bridge + conversational owner-only control ──────────
// The operator's installed desktop app connects OUT to Telegram (long-poll, no
// inbound server, no open ports). It pushes gate/run notifications to the owner's
// phone and accepts OWNER-ONLY control — a deterministic kill switch (/stop,
// /quit) + status, and (opt-in) conversational control of FIVE privileged
// actions, each CONFIRMED before it runs.
//
// SECURITY MODEL:
//   • Owner-bound — we act ONLY on messages whose chat.id equals the configured
//     owner chat id. Any other sender is ignored silently (logged WITHOUT
//     echoing the content). See commands.ts `decide`.
//   • Deterministic kill switch + status — /stop, /quit, /status, /gates, /help
//     are decided in commands.ts BEFORE any LLM parse and never depend on it.
//   • Conversational control is opt-in (SKYNET_TELEGRAM_CONTROL=true, default
//     OFF). It maps free text into a CLOSED five-action whitelist — approve,
//     reject, add_task, assign, add_agent — using the operator's OWN LLM (BYOK)
//     via orchestrator.consult; the action space never exceeds those five, so a
//     misparse or an injected instruction can't escalate.
//   • Confirm every action — the bridge replies with exactly what it parsed and
//     executes ONLY on an explicit affirmative reply (single pending action per
//     owner). Anything the model can't confidently map → ask to rephrase.
//   • The bot token is a secret — never logged. Message CONTENTS are never
//     logged either; only the action KIND is.

import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { Agent, HitlItem, Project, ProviderInfo, ServerEvent, Task, TaskRun } from "@skynet/shared";
import type {
  ConfigureRunnerRequest,
  CreateProjectRequest,
  CreateTaskRequest,
  ResolveRequest,
  UpdateProjectRequest,
  UpdateTaskRequest,
} from "@skynet/shared";
import type { config as Config } from "../config.js";
import type { Bus } from "../bus.js";
import type { Operations } from "../operations.js";
import type { Orchestrator } from "../orchestrator.js";
import { prefetchProjectDocs } from "../project-assistant.js";
import {
  askSteward,
  resolveFocusedProject,
  parseConfirmation,
  MAX_HISTORY,
  type ChatTurn,
  type AssistantAction,
} from "../steward/assistant.js";
import { TelegramClient } from "./client.js";
import { decide } from "./commands.js";
import {
  buildContext,
  INTENT_SYSTEM_PROMPT,
  parseResponse,
  renderContext,
  type Action,
  type HistoryEntry,
  type IntentContext,
  type IntentOps,
} from "./intent.js";

const log = (line: string): void => console.log(`[telegram] ${line}`);

// Repo grounding for the conversational assistant: prefetch each project's key
// docs + file tree so the owner can ask about roadmap items, features, or bugs
// over Telegram. Bounded hard — Telegram context is workspace-wide, so we trim
// each doc small and cap the total, and skip projects with no repo bound.
const TG_DOC_PER_DOC_CHARS = 2500;
const TG_DOC_TOTAL_CAP = 12000;

async function gatherProjectDocs(
  operations: Pick<ControlOps, "listProjects">,
  ws: string,
): Promise<string> {
  const projects = await operations.listProjects(ws).catch(() => [] as Project[]);
  let out = "";
  for (const p of projects) {
    if (out.length >= TG_DOC_TOTAL_CAP) break;
    if (!p.repo && !p.repoPath) continue;
    const docs = await prefetchProjectDocs(ws, p, TG_DOC_PER_DOC_CHARS).catch(() => "");
    if (docs) out += `\n\n### PROJECT ${p.name} (${p.id})${docs}`;
  }
  return out.slice(0, TG_DOC_TOTAL_CAP);
}

/** Exit code the desktop main (main.cjs) treats as an intentional remote quit. */
const REMOTE_SHUTDOWN_CODE = 42;

/** Long-poll window (seconds). Telegram holds the request open up to this long. */
const POLL_TIMEOUT_S = 30;

/** Backoff after a loop iteration throws, so a persistent error can't spin hot. */
const ERROR_BACKOFF_MS = 5_000;

const HELP =
  [
    "Skynet remote control:",
    "/status — running/waiting runs, open gates, pause state",
    "/gates — list open gates",
    "/approve <id> — approve a gate (needs SKYNET_TELEGRAM_CONTROL=true)",
    "/reject <id> — reject a gate (needs SKYNET_TELEGRAM_CONTROL=true)",
    "/task <text> — add a backlog item (no LLM needed; needs SKYNET_TELEGRAM_CONTROL=true)",
    "/removetask <id> — archive a task (reversible; recoverable in the app; needs SKYNET_TELEGRAM_CONTROL=true)",
    "/newproject <name> — create a project (needs SKYNET_TELEGRAM_CONTROL=true)",
    "/stop — kill switch: halt all runs + pause autonomy",
    "/resume — re-enable autonomy",
    "/quit — shut down the Skynet app",
    "/help — this list",
    "",
    "With control on you can also just say what you want, e.g.:",
    "  approve the deploy gate · add task \"fix login\" to Web · assign that task · add a claude agent · create a project called Web",
    "I'll confirm before doing anything — reply yes to run, anything else cancels.",
  ].join("\n");


/** Rolling per-chat conversation buffer cap (turns; each owner/assistant message
 *  is one). Kept in step with Steward's MAX_HISTORY so the buffer feeds the full
 *  window the prompt can use — Steward shouldn't "forget" after a few messages.
 *  In-memory + owner-scoped + cleared on restart, so a larger buffer is cheap. */
const HISTORY_CAP = MAX_HISTORY;

// ── Narrow dependency slices (so the confirm state machine is unit-testable) ──

/** The Operations methods the control handler needs. */
export interface ControlOps {
  listHitl(ws: string): Promise<HitlItem[]>;
  listRuns(ws: string): Promise<TaskRun[]>;
  listProjects(ws: string): Promise<Project[]>;
  listTasks(ws: string): Promise<Task[]>;
  listAgents(ws: string): Promise<Agent[]>;
  listProviders(ws: string): Promise<ProviderInfo[]>;
  resolveHitl(ws: string, id: string, input: ResolveRequest, operatorId: string): Promise<HitlItem>;
  createProject(ws: string, input: CreateProjectRequest): Promise<Project>;
  createTask(ws: string, projectId: string, input: CreateTaskRequest): Promise<Task>;
  assignTask(ws: string, projectId: string, taskId: string): Promise<TaskRun>;
  archiveTask(ws: string, projectId: string, taskId: string, archived: boolean): Promise<Task>;
  configureRunner(ws: string, input: ConfigureRunnerRequest): Promise<Agent>;
  // Board mutations Steward's project actions execute over Telegram (same set the
  // in-app assistant drives). Task ids are workspace-unique, so these take no
  // projectId; the server validates workspace ownership.
  transitionTask(ws: string, taskId: string, to: Task["state"], operatorId: string): Promise<Task>;
  updateTask(ws: string, taskId: string, patch: UpdateTaskRequest): Promise<Task>;
  moveTask(ws: string, taskId: string, direction: "up" | "down"): Promise<Task>;
  deleteTask(ws: string, taskId: string): Promise<void>;
  updateProject(ws: string, id: string, patch: UpdateProjectRequest): Promise<Project>;
}

/** The Orchestrator methods the control handler needs. */
export interface ControlOrch {
  consult(ws: string, question: string, context?: string): Promise<string | null>;
  stopAll(reason: string): Promise<number>;
  setPaused(p: boolean): void;
  isPaused(): boolean;
}

export interface OwnerControlDeps {
  /** Only SKYNET_TELEGRAM_CONTROL matters to the handler. */
  controlEnabled: boolean;
  ownerChatId: string;
  operations: ControlOps;
  orchestrator: ControlOrch;
  /** Send a reply to the owner. */
  notify: (text: string) => Promise<void>;
  /** Shut the app down (defaults to process.exit; injectable for tests). */
  onQuit?: () => void;
  /** Workspace to act in (defaults to DEFAULT_WORKSPACE). */
  ws?: string;
}

interface Pending {
  summary: string;
  /** Runs the confirmed action; resolves to a short success string. */
  run: () => Promise<string>;
  /** The action kind, for logging only (never the message contents). Widened to
   *  string because Steward's board actions add kinds beyond the intent whitelist. */
  kind: string;
}

/**
 * The conversational confirm state machine, extracted so it can be unit-tested
 * with fake operations/orchestrator + a fake consult. Owns a single pending
 * action per owner chat. Returns `{ handle }` — the bridge calls it per inbound
 * owner message; deterministic commands are decided first (see `decide`).
 */
export function createOwnerControl(deps: OwnerControlDeps): {
  handle: (chatId: string, text: string) => Promise<void>;
} {
  const { operations, orchestrator, notify } = deps;
  const ws = deps.ws ?? DEFAULT_WORKSPACE;
  const operatorId = `telegram:${deps.ownerChatId}`;
  const onQuit = deps.onQuit ?? (() => process.exit(REMOTE_SHUTDOWN_CODE));
  // A QUEUE of pending actions per owner chat. The intent path enqueues one; a
  // Steward change request can enqueue several. "yes" runs the head, "accept all"
  // runs them all, anything else cancels the queue. Empty ⇒ nothing pending.
  const pending = new Map<string, Pending[]>();

  // Short conversational memory (in-memory, owner-scoped, capped, cleared on
  // restart). Lets back-references ("remove that task", "it") resolve to a
  // concrete id: confirmed-action OUTCOMES are recorded WITH ids. We never log
  // message contents (see the module header) — this buffer stays in memory only.
  const history = new Map<string, HistoryEntry[]>();
  const pushHistory = (chatId: string, entry: HistoryEntry): void => {
    const buf = history.get(chatId) ?? [];
    buf.push(entry);
    while (buf.length > HISTORY_CAP) buf.shift(); // drop oldest past the cap
    history.set(chatId, buf);
  };

  const openGates = async (): Promise<HitlItem[]> =>
    (await operations.listHitl(ws)).filter((h) => !h.resolvedAt);

  const statusText = async (): Promise<string> => {
    const runs = await operations.listRuns(ws);
    const active = runs.filter((r) => r.status === "running" || r.status === "waiting").length;
    const gates = (await openGates()).length;
    return `Status: ${active} run(s) running/waiting, ${gates} open gate(s), autonomy ${
      orchestrator.isPaused() ? "PAUSED" : "active"
    }.`;
  };

  /** Turn a validated Action into a human-readable summary + a deferred executor
   *  (run on confirm). Never executes here — only describes. */
  const toPending = (action: Action, ctx: IntentContext): Pending | null => {
    switch (action.kind) {
      case "approve":
      case "reject": {
        const gate = ctx.gates.find((g) => g.id === action.gateId);
        const decision = action.kind; // "approve" | "reject"
        const verb = decision === "approve" ? "Approve" : "Reject";
        const summary = `${verb} gate ${action.gateId} — '${gate?.title ?? "?"}' (risk ${gate?.risk ?? "?"})?`;
        return {
          kind: action.kind,
          summary,
          run: async () => {
            await operations.resolveHitl(ws, action.gateId!, { action: decision }, operatorId);
            return `${decision === "approve" ? "✅" : "🚫"} Gate ${action.gateId} ${decision}d.`;
          },
        };
      }
      case "add_task": {
        const project = ctx.projects.find((p) => p.id === action.projectId);
        const summary = `Add task to ${project?.name ?? action.projectId}: "${action.taskText}"?`;
        return {
          kind: action.kind,
          summary,
          run: async () => {
            const t = await operations.createTask(ws, action.projectId!, { text: action.taskText! });
            return `➕ Task created (${t.id}) in ${project?.name ?? action.projectId}.`;
          },
        };
      }
      case "assign": {
        const task = ctx.tasks.find((t) => t.id === action.taskId);
        const summary = `Assign task ${action.taskId} — "${task?.text ?? "?"}" to a fresh agent?`;
        return {
          kind: action.kind,
          summary,
          run: async () => {
            const run = await operations.assignTask(ws, action.projectId!, action.taskId!);
            return `▶️ Assigned task ${action.taskId} — run ${run.id} started.`;
          },
        };
      }
      case "add_agent": {
        const name = action.agentName ? ` "${action.agentName}"` : "";
        const summary = `Add agent${name} — ${action.provider}/${action.model}?`;
        return {
          kind: action.kind,
          summary,
          run: async () => {
            const agent = await operations.configureRunner(ws, {
              provider: action.provider!,
              model: action.model!,
              ...(action.agentName ? { name: action.agentName } : {}),
            });
            return `🤖 Agent ${agent.id} added (${action.provider}/${action.model}).`;
          },
        };
      }
      case "create_project": {
        const summary = `Create project "${action.projectName}"${action.projectGoal ? ` — goal: ${action.projectGoal}` : ""}?`;
        return {
          kind: action.kind,
          summary,
          run: async () => {
            const p = await operations.createProject(ws, {
              name: action.projectName!,
              goal: action.projectGoal ?? "",
            });
            return `📁 Project "${p.name}" created (${p.id}). Add a repo in the app to run agents.`;
          },
        };
      }
      case "remove_task": {
        const task = ctx.tasks.find((t) => t.id === action.taskId);
        const summary = `Remove (archive) task ${action.taskId} — "${task?.text ?? "?"}"? (recoverable in the app)`;
        return {
          kind: action.kind,
          summary,
          run: async () => {
            await operations.archiveTask(ws, action.projectId!, action.taskId!, true);
            return `🗃 Archived task ${action.taskId}${task?.text ? ` — "${task.text}"` : ""}. Recoverable in the app (un-archive to restore).`;
          },
        };
      }
      // status / none are handled before this point.
      default:
        return null;
    }
  };

  /**
   * Turn one of Steward's 10 project/task actions into a deferred executor for the
   * confirm queue — the SAME board mutations the in-app assistant runs, so Steward
   * behaves identically on both surfaces. `action.summary` is Steward's own confirm
   * label (already built at validation time); the run returns a short outcome.
   * `projectId` is the focused project the actions were validated against, so task
   * ids are guaranteed to belong to it. remove_task hard-deletes (matching the web
   * Steward); the legacy `/removetask` slash command still archives (reversible).
   */
  const stewardPending = (action: AssistantAction, projectId: string): Pending => ({
    kind: `steward:${action.kind}`,
    summary: action.summary,
    run: async () => {
      switch (action.kind) {
        case "add_task": {
          const t = await operations.createTask(ws, projectId, {
            text: action.text!,
            ...(action.description ? { description: action.description } : {}),
          });
          return `➕ Task created (${t.id})${action.text ? ` — "${action.text}"` : ""}.`;
        }
        case "move_task":
          await operations.transitionTask(ws, action.taskId!, action.to!, operatorId);
          return `➡️ Moved task ${action.taskId} → ${action.to}.`;
        case "rename_task":
          await operations.updateTask(ws, action.taskId!, { text: action.text });
          return `✏️ Renamed task ${action.taskId}.`;
        case "set_task_desc":
          await operations.updateTask(ws, action.taskId!, { description: action.description ?? "" });
          return `📝 Updated the description for task ${action.taskId}.`;
        case "remove_task":
          await operations.deleteTask(ws, action.taskId!);
          return `🗑 Removed task ${action.taskId}.`;
        case "reorder_task":
          await operations.moveTask(ws, action.taskId!, action.direction!);
          return `↕️ Reordered task ${action.taskId} (${action.direction}).`;
        case "rename_project": {
          const pr = await operations.updateProject(ws, projectId, { name: action.name });
          return `✏️ Project renamed to "${pr.name}".`;
        }
        case "set_goal":
          await operations.updateProject(ws, projectId, { goal: action.goal ?? "" });
          return `🎯 Project goal updated.`;
        case "set_autonomy":
          await operations.updateProject(ws, projectId, { autonomy: action.autonomy });
          return `⚙️ Autonomy ${action.autonomy ? "ON" : "OFF"}.`;
        case "set_status":
          await operations.updateProject(ws, projectId, { status: action.status });
          return `🚦 Project status → ${action.status}.`;
        default:
          throw new Error(`unsupported action`);
      }
    },
  });

  /** The free-text (non-slash-command) path: pending affirmation first, then the
   *  helpful assistant (a concise reply, plus an optional confirmed action). */
  const handleFreeText = async (chatId: string, text: string): Promise<void> => {
    // 1. Resolve pending actions first — never send a "yes"/"no" to the LLM.
    //    Shared confirmation vocabulary with the in-app assistant: "yes" runs the
    //    head of the queue, "accept all" runs the whole batch, anything else
    //    cancels it. A single proposal (the common case) is a one-item queue.
    const queue = pending.get(chatId);
    if (queue && queue.length > 0) {
      pending.delete(chatId);
      const confirm = parseConfirmation(text);
      if (confirm === "no") {
        await notify("Cancelled.");
        return;
      }
      const toRun = confirm === "all" ? queue : [queue[0]!];
      const outcomes: string[] = [];
      for (const p of toRun) {
        log(`executing confirmed action: ${p.kind}`);
        try {
          const outcome = await p.run();
          // Record each OUTCOME (with ids) so later back-references ("remove that
          // task", "it") can resolve. This is the memory that makes undo work.
          pushHistory(chatId, { role: "assistant", text: outcome });
          outcomes.push(outcome);
        } catch (err) {
          outcomes.push(`⚠️ Couldn't complete "${p.summary}": ${(err as Error).message}`);
        }
      }
      // "yes" on a multi-item queue runs only the head; re-offer the remainder.
      const rest = confirm === "all" ? [] : queue.slice(1);
      if (rest.length > 0) {
        pending.set(chatId, rest);
        const remaining =
          rest.length === 1
            ? `1 more pending: ${rest[0]!.summary} — reply yes / no`
            : `${rest.length} more pending — reply "accept all", "yes" for the next, or "no" to cancel:\n` +
              rest.map((r, i) => `${i + 1}. ${r.summary}`).join("\n");
        outcomes.push(remaining);
      }
      await notify(outcomes.join("\n\n"));
      return;
    }

    // 2. A fresh message needs conversational control turned on.
    if (!deps.controlEnabled) {
      await notify("Conversational control is off (set SKYNET_TELEGRAM_CONTROL=true).");
      return;
    }

    // 3. Interpret via the operator's OWN provider key (BYOK). No key → fall back.
    //    Snapshot the PRIOR history (before this message) to ground back-references,
    //    then record this owner message BEFORE the consult (it becomes context for
    //    the next turn). The current message rides as the OPERATOR MESSAGE, so it is
    //    not duplicated into RECENT CONVERSATION.
    const priorHistory = [...(history.get(chatId) ?? [])];
    pushHistory(chatId, { role: "owner", text });

    // 3a. Repo-grounded answer for a FOCUSED project — a project named in the
    //     message that has a LOCAL checkout. Steward reads its working tree via the
    //     same read-only tool-loop (Read/Grep/Glob) the in-app assistant uses, so
    //     Telegram gets identical repo access. A question answers here; a change
    //     request enqueues Steward's proposed board action(s) for confirm-first
    //     execution — the SAME 10-kind action set the in-app assistant runs, so
    //     one "accept all" applies a whole batch. Best-effort — if the tool-loop
    //     can't run (no Claude key / SDK), we fall through to the workspace path.
    try {
      const focus = resolveFocusedProject(text, await operations.listProjects(ws));
      if (focus) {
        const turns: ChatTurn[] = priorHistory.map((h) => ({
          role: h.role === "owner" ? "user" : "assistant",
          content: h.text,
        }));
        const res = await askSteward(operations, { workspaceId: ws, project: focus, question: text, history: turns });
        if (res.actions.length > 0) {
          // Change request: queue the proposals and ask for confirmation.
          const q = res.actions.map((a) => stewardPending(a, focus.id));
          pending.set(chatId, q);
          log(`awaiting confirmation for ${q.length} steward action(s) on ${focus.name}`);
          const list =
            q.length === 1
              ? `${q[0]!.summary} — reply yes / no`
              : `${q.length} changes — reply "accept all", "yes" for the first, or "no" to cancel:\n` +
                q.map((p, i) => `${i + 1}. ${p.summary}`).join("\n");
          const out = [res.reply, list].filter(Boolean).join("\n\n");
          pushHistory(chatId, { role: "assistant", text: out });
          await notify(out);
          return;
        }
        if (res.reply) {
          // Pure answer (question about the repo/status).
          pushHistory(chatId, { role: "assistant", text: res.reply });
          await notify(res.reply);
          return;
        }
      }
    } catch (err) {
      log(`focused repo answer unavailable (${(err as Error).message}) — using workspace path`);
    }

    const [ctx, docs] = await Promise.all([buildContext(operations, ws), gatherProjectDocs(operations, ws)]);
    const raw = await orchestrator.consult(ws, INTENT_SYSTEM_PROMPT, renderContext(text, ctx, priorHistory, docs));
    if (raw == null) {
      await notify(
        "Conversational control needs an Anthropic (Claude) key to interpret messages — set ANTHROPIC_API_KEY (or add a Claude agent), then retry. Meanwhile you can add a backlog item with: /task <text>",
      );
      return;
    }

    // 4. The assistant ALWAYS replies helpfully, and OPTIONALLY proposes ONE
    //    validated action. Never a dead end: a chat/question just gets the reply.
    const { reply, action } = parseResponse(raw, ctx);

    // Read-only status: answer with the live status (nothing to confirm).
    if (action?.kind === "status") {
      const status = await statusText();
      const out = reply ? `${reply}\n\n${status}` : status;
      pushHistory(chatId, { role: "assistant", text: reply || status });
      await notify(out);
      return;
    }

    // A privileged action: describe it and wait for an explicit yes. The reply
    // rides along so the owner always gets context before confirming.
    if (action && action.kind !== "none") {
      const next = toPending(action, ctx);
      if (next) {
        pending.set(chatId, [next]); // the intent path proposes exactly one action
        log(`awaiting confirmation for action: ${next.kind}`);
        const out = [reply, `${next.summary} — reply yes / no`].filter(Boolean).join("\n\n");
        pushHistory(chatId, { role: "assistant", text: out });
        await notify(out);
        return;
      }
    }

    // No actionable intent — just the helpful reply.
    const out = reply || "I'm here to help — ask me about gates, runs, projects, or tell me what to do.";
    pushHistory(chatId, { role: "assistant", text: out });
    await notify(out);
  };

  const handle = async (chatId: string, text: string): Promise<void> => {
    const action = decide({ chatId, ownerChatId: deps.ownerChatId, controlEnabled: deps.controlEnabled, text });

    // Owner-bound guardrail: never echo a non-owner's content.
    if (action.kind === "ignore") {
      log("ignored message from non-owner chat");
      return;
    }

    switch (action.kind) {
      case "help":
        await notify(HELP);
        return;

      case "status":
        await notify(await statusText());
        return;

      case "gates": {
        const gates = await openGates();
        if (gates.length === 0) {
          await notify("No open gates.");
          return;
        }
        await notify(gates.map((g) => `${g.id} — ${g.kind} — ${g.title}`).join("\n"));
        return;
      }

      case "approve":
      case "reject": {
        // Deterministic slash-command path (/approve <id>) — still confirmed by
        // being an explicit command; kept as the no-LLM fallback.
        const gates = await openGates();
        let id = action.arg;
        if (!id) {
          if (gates.length === 1) id = gates[0]!.id;
          else if (gates.length === 0) {
            await notify("No open gates to act on.");
            return;
          } else {
            await notify(`Which gate? ${gates.length} open — reply /${action.kind} <id>. See /gates.`);
            return;
          }
        }
        const decision = action.kind === "approve" ? "approve" : "reject";
        log(`executing slash-command action: ${decision}`);
        try {
          await operations.resolveHitl(ws, id, { action: decision }, operatorId);
          await notify(`${decision === "approve" ? "✅" : "🚫"} Gate ${id} ${decision}d.`);
        } catch (err) {
          await notify(`Couldn't ${decision} gate ${id}: ${(err as Error).message}`);
        }
        return;
      }

      case "task": {
        // Deterministic backlog add — no LLM involved, so it works even without a
        // consult-capable provider key.
        const taskText = action.arg?.trim();
        if (!taskText) {
          await notify("Usage: /task <what to add to the backlog>");
          return;
        }
        const projects = await operations.listProjects(ws).catch(() => [] as Project[]);
        if (projects.length === 0) {
          await notify("No project yet — create one in the app first, then /task <text>.");
          return;
        }
        if (projects.length > 1) {
          await notify(
            `You have ${projects.length} projects — name one (e.g. “add a task to ${projects[0]!.name}: ${taskText}”), or add it in the app.`,
          );
          return;
        }
        const proj = projects[0]!;
        try {
          const t = await operations.createTask(ws, proj.id, { text: taskText });
          await notify(`➕ Added to ${proj.name} backlog: “${t.text}”`);
        } catch (err) {
          await notify(`Couldn't add the task: ${(err as Error).message}`);
        }
        return;
      }

      case "newproject": {
        // Deterministic project creation — no LLM. Creates a project shell (bind a
        // repo in the app to run agents on it).
        const name = action.arg?.trim();
        if (!name) {
          await notify("Usage: /newproject <name>");
          return;
        }
        try {
          const p = await operations.createProject(ws, { name, goal: "" });
          await notify(`📁 Project "${p.name}" created. Add a repo in the app to run agents.`);
        } catch (err) {
          await notify(`Couldn't create the project: ${(err as Error).message}`);
        }
        return;
      }

      case "removetask": {
        // Deterministic reversible archive by id — the no-LLM undo path. Resolves
        // the task's project id from the workspace; archiveTask refuses a task that
        // still owns a live run. Recoverable (un-archive in the app).
        const id = action.arg?.trim();
        if (!id) {
          await notify("Usage: /removetask <task id>");
          return;
        }
        const task = (await operations.listTasks(ws).catch(() => [] as Task[])).find((t) => t.id === id);
        if (!task) {
          await notify(`No task ${id} found.`);
          return;
        }
        log("executing slash-command action: removetask");
        try {
          await operations.archiveTask(ws, task.projectId, id, true);
          await notify(`🗃 Archived task ${id} — recoverable in the app (un-archive to restore).`);
        } catch (err) {
          await notify(`Couldn't remove task ${id}: ${(err as Error).message}`);
        }
        return;
      }

      case "denied-control":
        await notify(
          "Control over chat is disabled (set SKYNET_TELEGRAM_CONTROL=true). Or add the task/project in the app.",
        );
        return;

      case "denied-approve":
        await notify(
          "Control over chat is disabled (set SKYNET_TELEGRAM_CONTROL=true). Open the app to decide.",
        );
        return;

      case "stop": {
        pending.delete(chatId); // a kill switch clears any pending confirmation
        const n = await orchestrator.stopAll("kill switch via Telegram");
        await notify(`🛑 Stopped ${n} run(s); autonomy paused. /resume to re-enable.`);
        return;
      }

      case "resume":
        orchestrator.setPaused(false);
        await notify("▶️ Autonomy resumed.");
        return;

      case "quit": {
        pending.delete(chatId);
        await notify("🛑 Shutting down Skynet…");
        await orchestrator.stopAll("shutdown via Telegram /quit").catch(() => undefined);
        onQuit();
        return;
      }

      case "freetext":
        await handleFreeText(chatId, text);
        return;
    }
  };

  return { handle };
}

/** The narrow slice {@link simulateConversational} needs from the orchestrator. */
export interface SimulateOrch {
  consult(ws: string, question: string, context?: string): Promise<string | null>;
}

export interface SimulateDeps {
  operations: IntentOps;
  orchestrator: SimulateOrch;
  /** Workspace to ground against (defaults to DEFAULT_WORKSPACE). */
  ws?: string;
}

/**
 * DRY-RUN of the conversational assistant: build the grounding context, ask the
 * operator's own LLM (BYOK, via consult), and parse the {reply, action} envelope
 * — WITHOUT executing anything. This is the seam the Simulation section drives to
 * verify the assistant both ANSWERS and ROUTES, repeatably and with no mutations.
 * When no consult-capable key is available, returns `{reply:null, action:null,
 * error:"no-llm"}` so the caller can soft-skip rather than fail.
 */
export async function simulateConversational(
  deps: SimulateDeps,
  text: string,
): Promise<{ reply: string | null; action: Action | null; error?: string }> {
  const ws = deps.ws ?? DEFAULT_WORKSPACE;
  const [ctx, docs] = await Promise.all([buildContext(deps.operations, ws), gatherProjectDocs(deps.operations, ws)]);
  const raw = await deps.orchestrator.consult(ws, INTENT_SYSTEM_PROMPT, renderContext(text, ctx, undefined, docs));
  if (raw == null) return { reply: null, action: null, error: "no-llm" };
  const { reply, action } = parseResponse(raw, ctx);
  return { reply, action };
}

export interface TelegramBridgeDeps {
  config: typeof Config;
  bus: Bus;
  operations: Operations;
  orchestrator: Orchestrator;
}

export function startTelegramBridge(deps: TelegramBridgeDeps): void {
  const { config, bus, operations, orchestrator } = deps;
  const token = config.telegramBotToken;
  const ownerChatId = config.telegramOwnerChatId;

  if (!token || !ownerChatId) {
    log("telegram bridge disabled — set SKYNET_TELEGRAM_BOT_TOKEN + SKYNET_TELEGRAM_OWNER_CHAT_ID");
    return;
  }

  const client = new TelegramClient(token);

  /** Best-effort notify the owner; a Telegram outage must never break the bridge. */
  const notify = async (text: string): Promise<void> => {
    try {
      await client.sendMessage(ownerChatId, text);
    } catch (err) {
      // The client scrubs the token from its errors, so this is safe to log.
      log(`sendMessage failed: ${(err as Error).message}`);
    }
  };

  // ── Outbound: push workspace events to the owner ──────────────────────────
  const handler = (event: ServerEvent): void => {
    if (event.type === "hitl.raised") {
      const it = event.item;
      const lines = [`🔔 Gate ${it.id} (${it.kind}, risk ${it.risk}): ${it.title}`];
      if (it.command) lines.push(it.command);
      lines.push(`reply /approve ${it.id} or /reject ${it.id}`);
      void notify(lines.join("\n"));
    } else if (event.type === "run.status" && event.status === "review") {
      void notify(`⚠︎ Run ${event.runId} needs attention`);
    } else if (event.type === "run.completed") {
      void notify(`✅ Run ${event.runId} merged/done`);
    }
  };
  // Scope to the SAME workspace the web/admin uses. `config.adminWorkspace` is
  // set by the deployer (e.g. GCP setup.sh writes "skynet") and by the seed path
  // in index.ts — hardcoding DEFAULT_WORKSPACE here made Telegram query a
  // different empty universe than the web (the "workspace looks empty" bug).
  const ws = config.adminWorkspace || DEFAULT_WORKSPACE;
  bus.subscribe(ws, handler);

  // ── Inbound: owner-only control (deterministic commands + confirmed intents) ─
  const control = createOwnerControl({
    controlEnabled: config.telegramControl,
    ownerChatId,
    operations,
    orchestrator,
    notify,
    ws,
  });

  // Long-poll loop — fire-and-forget (never awaited at boot). Each iteration is
  // isolated: an error is caught + backed off so the loop survives, and it never
  // throws out of startTelegramBridge.
  const loop = async (): Promise<void> => {
    let offset = 0;
    log("telegram bridge active — owner-bound remote control online");
    for (;;) {
      try {
        const updates = await client.getUpdates(offset, POLL_TIMEOUT_S);
        for (const u of updates) {
          offset = Math.max(offset, u.update_id + 1); // ack past this update
          const msg = u.message;
          if (!msg || typeof msg.text !== "string") continue;
          await control.handle(String(msg.chat.id), msg.text).catch((err) =>
            log(`handler error: ${(err as Error).message}`),
          );
        }
      } catch (err) {
        // getUpdates already swallows network errors, but guard the whole body so
        // nothing can escape the loop; back off before retrying.
        log(`poll error: ${(err as Error).message}`);
        await new Promise((r) => setTimeout(r, ERROR_BACKOFF_MS));
      }
    }
  };

  void loop();
}
