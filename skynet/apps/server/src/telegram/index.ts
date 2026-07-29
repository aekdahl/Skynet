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
import type { ConfigureRunnerRequest, CreateProjectRequest, CreateTaskRequest, ResolveRequest } from "@skynet/shared";
import type { config as Config } from "../config.js";
import type { Bus } from "../bus.js";
import type { Operations } from "../operations.js";
import type { Orchestrator } from "../orchestrator.js";
import { prefetchProjectDocs } from "../project-assistant.js";
import { TelegramClient } from "./client.js";
import { decide } from "./commands.js";
import { gateNotice, reviewNotice, completedNotice, type Names } from "./notices.js";
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

/** An affirmative confirmation of a pending action. Anything else cancels. */
const isAffirmative = (text: string): boolean =>
  ["yes", "y", "confirm", "ok", "okay", "yep", "yeah"].includes(text.trim().toLowerCase());

/** Rolling per-chat conversation buffer cap (turns). Oldest dropped past this.
 *  Short by design — enough to resolve immediate back-references, no more. */
const HISTORY_CAP = 8;

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
}

/** The Orchestrator methods the control handler needs. */
export interface ControlOrch {
  consult(ws: string, question: string, context?: string, system?: string): Promise<string | null>;
  stopAll(reason: string): Promise<number>;
  setPaused(p: boolean): void;
  isPaused(): boolean;
}

/** What the widened `notify` returns — the messageId lets callers edit the
 *  message later (e.g. strip the inline confirm buttons after tapping). */
export interface NotifyResult {
  messageId: number;
}

/** Optional shape for widened `notify`: pass `reply_markup` to attach an inline
 *  keyboard (Confirm/Cancel, Approve/Reject). Kept OPTIONAL so callers that
 *  only care about text stay unchanged, and so `notify` remains fake-friendly. */
export interface NotifyOpts {
  reply_markup?: import("./client.js").InlineKeyboardMarkup;
}

export interface OwnerControlDeps {
  /** Only SKYNET_TELEGRAM_CONTROL matters to the handler. */
  controlEnabled: boolean;
  ownerChatId: string;
  operations: ControlOps;
  orchestrator: ControlOrch;
  /** Send a reply to the owner. Returns the sent-message id when the caller
   *  needs it (to edit later); passing no opts sends plain text. */
  notify: (text: string, opts?: NotifyOpts) => Promise<NotifyResult>;
  /** Strip the inline keyboard from a previously-sent message (best-effort:
   *  telegram errors are swallowed). Called after Confirm/Cancel resolves a
   *  pending action, so the buttons don't stay tappable. Optional for tests. */
  editReplyMarkup?: (chatId: string, messageId: number) => Promise<void>;
  /** Acknowledge a tapped inline-keyboard button (dismisses the client's
   *  loading spinner). Optional for tests. */
  ackCallback?: (callbackQueryId: string, opts?: { text?: string }) => Promise<void>;
  /** Shut the app down (defaults to process.exit; injectable for tests). */
  onQuit?: () => void;
  /** Workspace to act in (defaults to DEFAULT_WORKSPACE). */
  ws?: string;
}

interface Pending {
  /** Short opaque id that rides in the inline button's callback_data. Guards
   *  against a stale tap after a new pending has replaced this one. */
  id: string;
  summary: string;
  /** Runs the confirmed action; resolves to a short success string. */
  run: () => Promise<string>;
  /** The action kind, for logging only (never the message contents). */
  kind: Action["kind"];
  /** id of the notify message that carries the Confirm/Cancel buttons — we edit
   *  it after resolution to strip the buttons. 0 if the send didn't return one. */
  messageId: number;
}

/**
 * The conversational confirm state machine, extracted so it can be unit-tested
 * with fake operations/orchestrator + a fake consult. Owns a single pending
 * action per owner chat. Returns `{ handle }` — the bridge calls it per inbound
 * owner message; deterministic commands are decided first (see `decide`).
 */
export function createOwnerControl(deps: OwnerControlDeps): {
  handle: (chatId: string, text: string) => Promise<void>;
  handleCallback: (
    chatId: string,
    data: string,
    callbackQueryId: string,
    messageId: number,
  ) => Promise<void>;
} {
  const { operations, orchestrator, notify } = deps;
  const editReplyMarkup = deps.editReplyMarkup ?? (async () => undefined);
  const ackCallback = deps.ackCallback ?? (async () => undefined);
  const ws = deps.ws ?? DEFAULT_WORKSPACE;
  const operatorId = `telegram:${deps.ownerChatId}`;
  const onQuit = deps.onQuit ?? (() => process.exit(REMOTE_SHUTDOWN_CODE));
  const pending = new Map<string, Pending>();
  // Monotonic counter for pending ids. Small (fits in 64-byte callback_data
  // trivially) and unique-per-process — enough to distinguish a stale tap on an
  // older pending from a live one, since only one pending exists per chat.
  let pendingSeq = 0;

  /** Two-button Confirm/Cancel keyboard for a pending action. */
  const confirmKeyboard = (pendingId: string) => ({
    inline_keyboard: [[
      { text: "✓ Confirm", callback_data: `confirm:${pendingId}` },
      { text: "✕ Cancel", callback_data: `cancel:${pendingId}` },
    ]],
  });
  /** Two-button Approve/Reject keyboard for a HITL gate. The gate id rides in
   *  the callback_data so the tap resolves the exact gate the buttons were on
   *  (a later gate can't be resolved by an older button). */
  const hitlKeyboard = (gateId: string) => ({
    inline_keyboard: [[
      { text: "✓ Approve", callback_data: `hitl:approve:${gateId}` },
      { text: "✕ Reject", callback_data: `hitl:reject:${gateId}` },
    ]],
  });

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
   *  (run on confirm). Never executes here — only describes. The `id` and
   *  `messageId` are stamped at the call site where we mint the nonce and know
   *  the message id after `notify` returns. */
  const toPending = (action: Action, ctx: IntentContext): Omit<Pending, "id" | "messageId"> | null => {
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

  /** Resolve a pending action — shared by the "yes/no" free-text path AND the
   *  Confirm/Cancel button tap. `p` is the popped pending; caller has already
   *  removed it from the map. On success, strip the buttons off the original
   *  message so it can't be double-tapped. */
  const runPending = async (chatId: string, p: Pending, accepted: boolean): Promise<void> => {
    if (!accepted) {
      await notify("Cancelled.");
      if (p.messageId) await editReplyMarkup(chatId, p.messageId).catch(() => undefined);
      return;
    }
    log(`executing confirmed action: ${p.kind}`);
    try {
      const outcome = await p.run();
      // Record the OUTCOME (with ids) so later back-references ("remove that
      // task", "it") can resolve. This is the memory that makes undo work.
      pushHistory(chatId, { role: "assistant", text: outcome });
      await notify(outcome);
    } catch (err) {
      await notify(`Couldn't complete that: ${(err as Error).message}`);
    }
    if (p.messageId) await editReplyMarkup(chatId, p.messageId).catch(() => undefined);
  };

  /** The free-text (non-slash-command) path: pending affirmation first, then the
   *  helpful assistant (a concise reply, plus an optional confirmed action). */
  const handleFreeText = async (chatId: string, text: string): Promise<void> => {
    // 1. Resolve a pending action first — never send a "yes"/"no" to the LLM.
    const p = pending.get(chatId);
    if (p) {
      pending.delete(chatId);
      await runPending(chatId, p, isAffirmative(text));
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
    const [ctx, docs] = await Promise.all([buildContext(operations, ws), gatherProjectDocs(operations, ws)]);
    // The operator's own text rides as `question` (runner labels it OPERATOR
    // MESSAGE); INTENT_SYSTEM_PROMPT rides as `system` (the role framing);
    // `renderContext` is GROUNDING only (workspace + repo docs + recent
    // conversation). Reversing this made Claude read the system prompt as a
    // prompt-injection attempt in the operator's message.
    const raw = await orchestrator.consult(ws, text, renderContext(ctx, priorHistory, docs), INTENT_SYSTEM_PROMPT);
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

    // A privileged action: describe it and wait for confirmation — either a tap
    // on the ✓ Confirm / ✕ Cancel buttons, or a typed "yes/no". The reply rides
    // along so the owner always gets context before confirming.
    if (action && action.kind !== "none") {
      const draft = toPending(action, ctx);
      if (draft) {
        const id = `p-${++pendingSeq}`;
        log(`awaiting confirmation for action: ${draft.kind}`);
        const out = [reply, `${draft.summary} — tap a button below or reply yes / no.`].filter(Boolean).join("\n\n");
        pushHistory(chatId, { role: "assistant", text: out });
        const sent = await notify(out, { reply_markup: confirmKeyboard(id) });
        pending.set(chatId, { ...draft, id, messageId: sent.messageId });
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

  /**
   * Inbound inline-button tap. Owner-check happens at the poll-loop level (same
   * as `handle`), so by the time we get here the chat is the owner's.
   *
   * `data` shape (closed set — never parse anything else):
   *   `confirm:<pendingId>`   → run the pending action (if the id still matches)
   *   `cancel:<pendingId>`    → drop the pending
   *   `hitl:approve:<gateId>` → resolveHitl approve (if control is enabled + gate open)
   *   `hitl:reject:<gateId>`  → resolveHitl reject  (ditto)
   *
   * Every branch calls `ackCallback` to dismiss the client's loading spinner —
   * Telegram REQUIRES it, otherwise the button spins for ~30 seconds.
   */
  const handleCallback = async (
    chatId: string,
    data: string,
    callbackQueryId: string,
    messageId: number,
  ): Promise<void> => {
    // Parse `<kind>:<rest>` — kind is a closed set (see doc above), rest is
    // opaque data we validate before acting on. Anything else = ignore.
    const colon = data.indexOf(":");
    if (colon < 0) {
      await ackCallback(callbackQueryId);
      return;
    }
    const kind = data.slice(0, colon);
    const rest = data.slice(colon + 1);

    // ── Pending confirm/cancel — must match the STORED pending id, else stale
    if (kind === "confirm" || kind === "cancel") {
      const p = pending.get(chatId);
      // A different pending has replaced this one (or there is none) — refuse
      // and tell the operator via the callback toast. Never runs the old action.
      if (!p || p.id !== rest) {
        await ackCallback(callbackQueryId, { text: "That action has already been handled." });
        // Strip the stale buttons so the message reads as done.
        if (messageId) await editReplyMarkup(chatId, messageId).catch(() => undefined);
        return;
      }
      pending.delete(chatId);
      // Ack BEFORE running so the spinner dismisses immediately even if the
      // action takes a moment. `runPending` sends its own outcome message +
      // edits the confirm message to remove the buttons.
      await ackCallback(callbackQueryId).catch(() => undefined);
      await runPending(chatId, p, kind === "confirm");
      return;
    }

    // ── HITL approve/reject — gated by the SAME rule as /approve <id>.
    if (kind === "hitl") {
      const sepInRest = rest.indexOf(":");
      const decision = sepInRest > 0 ? rest.slice(0, sepInRest) : rest;
      const gateId = sepInRest > 0 ? rest.slice(sepInRest + 1) : "";
      if ((decision !== "approve" && decision !== "reject") || !gateId) {
        await ackCallback(callbackQueryId);
        return;
      }
      if (!deps.controlEnabled) {
        await ackCallback(callbackQueryId, { text: "Control is off — set SKYNET_TELEGRAM_CONTROL." });
        return;
      }
      // Refuse to act on a gate that's no longer open (already resolved from
      // the app or another tap). The button is stripped either way.
      const gate = (await openGates()).find((g) => g.id === gateId);
      if (!gate) {
        await ackCallback(callbackQueryId, { text: "Gate already handled." });
        if (messageId) await editReplyMarkup(chatId, messageId).catch(() => undefined);
        return;
      }
      await ackCallback(callbackQueryId).catch(() => undefined);
      try {
        await operations.resolveHitl(ws, gateId, { action: decision }, operatorId);
        await notify(`${decision === "approve" ? "✅" : "🚫"} Gate ${gateId} ${decision}d.`);
      } catch (err) {
        await notify(`Couldn't ${decision} gate ${gateId}: ${(err as Error).message}`);
      }
      if (messageId) await editReplyMarkup(chatId, messageId).catch(() => undefined);
      return;
    }

    // Unknown kind — silently ack so the spinner stops; don't leak internals.
    await ackCallback(callbackQueryId).catch(() => undefined);
  };

  return { handle, handleCallback };
}

/** The narrow slice {@link simulateConversational} needs from the orchestrator. */
export interface SimulateOrch {
  consult(ws: string, question: string, context?: string, system?: string): Promise<string | null>;
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
  const raw = await deps.orchestrator.consult(ws, text, renderContext(ctx, undefined, docs), INTENT_SYSTEM_PROMPT);
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

  /** Best-effort notify the owner; a Telegram outage must never break the bridge.
   *  Returns the sent-message id (or 0 on failure) so callers can strip inline
   *  buttons later. Accepts an optional inline keyboard via `reply_markup`. */
  const notify = async (text: string, opts?: NotifyOpts): Promise<NotifyResult> => {
    try {
      const sent = await client.sendMessage(ownerChatId, text, opts);
      return { messageId: sent.messageId };
    } catch (err) {
      // The client scrubs the token from its errors, so this is safe to log.
      log(`sendMessage failed: ${(err as Error).message}`);
      return { messageId: 0 };
    }
  };
  /** Best-effort strip the inline keyboard from a message — swallow errors so a
   *  Telegram outage never breaks the bridge; the buttons just stay tappable. */
  const editReplyMarkup = async (chatId: string, messageId: number): Promise<void> => {
    try {
      await client.editMessageReplyMarkup(chatId, messageId, null);
    } catch (err) {
      log(`editMessageReplyMarkup failed: ${(err as Error).message}`);
    }
  };
  /** Best-effort ack a callback_query (dismisses the client's loading spinner). */
  const ackCallback = async (callbackQueryId: string, opts?: { text?: string }): Promise<void> => {
    try {
      await client.answerCallbackQuery(callbackQueryId, opts);
    } catch (err) {
      log(`answerCallbackQuery failed: ${(err as Error).message}`);
    }
  };

  // ── Outbound: push workspace events to the owner ──────────────────────────
  // Notifications lead with human names — a run's task title + its project — not
  // the raw ids that made these unreadable ("Run pin-the-node-docker-image-to-a-
  // d-1 needs attention"). Best-effort lookups: on failure we fall back to the id.
  const nameOf = async (runId: string): Promise<Names> => {
    const run = await operations.getRun(ws, runId).catch(() => null);
    if (!run) return { run: runId, project: "" };
    const project = await operations.getProject(ws, run.projectId).catch(() => null);
    return { run: run.name || runId, project: project?.name ?? "" };
  };

  // De-dupe run notices: only push when a run's status actually CHANGES, so a run
  // that re-emits "review" doesn't send the same line three times (the reported
  // spam). A gate raise also records "review" so we never double-notify a review.
  const lastNotice = new Map<string, string>();

  const announceGate = async (it: HitlItem): Promise<void> => {
    lastNotice.set(it.runId, "review"); // the gate IS the review heads-up
    const opts = config.telegramControl
      ? {
          reply_markup: {
            inline_keyboard: [[
              { text: "✓ Approve", callback_data: `hitl:approve:${it.id}` },
              { text: "✕ Reject", callback_data: `hitl:reject:${it.id}` },
            ]],
          },
        }
      : undefined;
    await notify(gateNotice(it, await nameOf(it.runId), config.telegramControl), opts);
  };

  const announceReview = (runId: string): void => {
    if (lastNotice.get(runId) === "review") return; // already flagged (gate or prior review)
    lastNotice.set(runId, "review");
    // A gate for this run (diff/merge/escalation) is raised right AFTER the status
    // flips to review; wait a beat, then only ping if NO gate covers it — otherwise
    // the richer, actionable gate notice already went out. This is the case where a
    // run parks in review with nothing to tap (e.g. a flagged auto-review).
    setTimeout(() => {
      void (async () => {
        const covered = (await operations.listHitl(ws).catch(() => []))
          .some((g) => g.runId === runId && !g.resolvedAt);
        if (covered) return;
        await notify(reviewNotice(await nameOf(runId)));
      })();
    }, 700);
  };

  const handler = (event: ServerEvent): void => {
    if (event.type === "hitl.raised") {
      void announceGate(event.item);
    } else if (event.type === "run.status" && event.status === "review") {
      announceReview(event.runId);
    } else if (event.type === "run.completed") {
      lastNotice.set(event.runId, "done");
      void (async () => {
        await notify(completedNotice(await nameOf(event.runId)));
      })();
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
    editReplyMarkup,
    ackCallback,
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
          // Inline-button tap → dispatch to handleCallback. Owner-bound: taps
          // from any other chat are ignored silently (defense-in-depth; the
          // bot is owner-scoped anyway, but never trust the source).
          if (u.callback_query) {
            const cq = u.callback_query;
            const chatId = cq.message?.chat.id;
            const messageId = cq.message?.message_id ?? 0;
            const data = cq.data ?? "";
            if (chatId != null && String(chatId) === ownerChatId && data) {
              await control.handleCallback(String(chatId), data, cq.id, messageId).catch((err) =>
                log(`callback handler error: ${(err as Error).message}`),
              );
            }
            continue;
          }
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
