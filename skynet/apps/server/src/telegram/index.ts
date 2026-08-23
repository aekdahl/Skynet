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
import type { Agent, Feature, HitlItem, Milestone, Project, ProviderInfo, ServerEvent, Task, TaskRun } from "@skynet/shared";
import type {
  ConfigureRunnerRequest,
  CreateFeatureRequest,
  CreateMilestoneRequest,
  CreateProjectRequest,
  CreateTaskRequest,
  ResolveRequest,
  StewardActionOutcome,
  StewardExecutionAction,
  UpdateFeatureRequest,
  UpdateMilestoneRequest,
  UpdateProjectRequest,
  UpdateTaskRequest,
} from "@skynet/shared";
import type { config as Config } from "../config.js";
import type { Bus } from "../bus.js";
import type { Operations } from "../operations.js";
import type { PreviewState } from "../preview/project-preview.js";
import type { Orchestrator } from "../orchestrator.js";
import { prefetchProjectDocs } from "../project-assistant.js";
import { TelegramClient } from "./client.js";
import { decide } from "./commands.js";
import {
  decisionCardHtml,
  gateKeyboard,
  gateHead,
  digestText,
  shippedCardHtml,
  reviewNotice,
  completedNotice,
  inQuietHours,
  parseQuietHours,
  runLink,
  desktopRunLink,
  esc,
  type Names,
} from "./notices.js";
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
    "/inbox — what needs you: open decisions + run counts",
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
  listFeatures?(ws: string): Promise<Feature[]>;
  listMilestones?(ws: string): Promise<Milestone[]>;
  resolveHitl(ws: string, id: string, input: ResolveRequest, operatorId: string): Promise<HitlItem>;
  /** The real unified diff of a run's branch, for the "View diff" button.
   *  Optional so existing fakes/callers don't have to implement it. */
  runDiff?(ws: string, runId: string): Promise<{ patch: string; add: number; del: number; files: string[] }>;
  createProject(ws: string, input: CreateProjectRequest): Promise<Project>;
  createTask(ws: string, projectId: string, input: CreateTaskRequest): Promise<Task>;
  assignTask(ws: string, projectId: string, taskId: string): Promise<TaskRun>;
  archiveTask(ws: string, projectId: string, taskId: string, archived: boolean): Promise<Task>;
  configureRunner(ws: string, input: ConfigureRunnerRequest): Promise<Agent>;
  // Project-management parity with the in-app Steward assistant (all guarded +
  // confirmed before they run). Optional so minimal test fakes needn't stub them.
  transitionTask?(ws: string, taskId: string, to: Task["state"], operatorId: string): Promise<Task>;
  updateTask?(ws: string, taskId: string, patch: UpdateTaskRequest): Promise<Task>;
  updateProject?(ws: string, id: string, patch: UpdateProjectRequest): Promise<Project>;
  // Grouping / roadmap ops — mirror the shape Steward uses.
  createFeature(ws: string, projectId: string, input: CreateFeatureRequest): Promise<Feature>;
  updateFeature(ws: string, featureId: string, patch: UpdateFeatureRequest): Promise<Feature>;
  createMilestone(ws: string, projectId: string, input: CreateMilestoneRequest): Promise<Milestone>;
  updateMilestone(ws: string, milestoneId: string, patch: UpdateMilestoneRequest): Promise<Milestone>;
  /** Spin up (or restart) the project's live preview; resolves when it's live or
   *  failed, with the URL in the returned state. */
  previewStart(ws: string, projectId: string): Promise<PreviewState>;
  // Execution intents (S10/S11) — the same one executor the dock's confirm
  // chip calls, reused here rather than growing a Telegram-only copy.
  executeStewardAction(
    ws: string,
    projectId: string,
    action: StewardExecutionAction,
    operatorId: string,
    opts?: { dryRun?: boolean },
  ): Promise<StewardActionOutcome>;
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
  /** Render the body as Telegram HTML (bold / code / italic). Text must be
   *  escaped by the caller (see notices.esc). */
  parse_mode?: "HTML";
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

// ── Execution intents (S10/S11) — shared with the dock, reused here ────────

/** Narrow a validated `Action` down to the strict shape the S10 execute
 *  endpoint accepts. Only called for the four execution-intent kinds (guarded
 *  by the caller), so the `!`s mirror validateAction's already-checked fields. */
function toExecutionAction(action: Action): StewardExecutionAction {
  switch (action.kind) {
    case "start_task":
      return { kind: "start_task", taskId: action.taskId! };
    case "queue_tasks":
      return { kind: "queue_tasks", taskIds: action.taskIds ?? [] };
    case "start_feature":
      return { kind: "start_feature", featureId: action.featureId!, execMode: action.execMode ?? "queue", feasibleOnly: action.feasibleOnly ?? true };
    case "process_backlog":
      return { kind: "process_backlog", feasibleOnly: action.feasibleOnly ?? true };
    default:
      throw new Error(`${action.kind} isn't an execution intent`);
  }
}

const EXCLUDE_REASON_LABEL: Record<string, string> = {
  unclear: "not yet triaged clear",
  "already-running": "already running",
  done: "already done",
  "over-budget": "over today's budget",
  "not-in-scope": "not in scope",
};

/** "3 starting, 2 queued, 1 excluded, ~$4.50" — shared by the dry-run preview
 *  (the confirm message) and the real outcome (the run() success line). */
function summarizeOutcome(o: StewardActionOutcome): string {
  const parts: string[] = [];
  if (o.started.length) parts.push(`${o.started.length} starting`);
  if (o.queued.length) parts.push(`${o.queued.length} queued`);
  if (o.excluded.length) parts.push(`${o.excluded.length} excluded`);
  if (!parts.length) parts.push("nothing to do");
  if (o.estimatedCostUsd > 0) parts.push(`~$${o.estimatedCostUsd.toFixed(2)}`);
  return parts.join(", ");
}

/** "2 already running, 1 over today's budget" — the "why" behind the excluded count. */
function excludedBreakdown(o: StewardActionOutcome): string {
  const counts = new Map<string, number>();
  for (const e of o.excluded) counts.set(e.reason, (counts.get(e.reason) ?? 0) + 1);
  return [...counts.entries()].map(([reason, n]) => `${n} ${EXCLUDE_REASON_LABEL[reason] ?? reason}`).join(", ");
}

/** The full dry-run preview clause a composite's confirm message shows —
 *  "3 starting, 2 queued — 1 excluded (already running) — this also turns
 *  autonomy on". Shared by queue_tasks/start_feature/process_backlog. */
function previewDetail(o: StewardActionOutcome): string {
  return [summarizeOutcome(o), o.excluded.length ? `— ${excludedBreakdown(o)}` : "", o.autonomyEnabled ? "— this also turns autonomy on" : ""]
    .filter(Boolean)
    .join(" ");
}

/**
 * The conversational confirm state machine, extracted so it can be unit-tested
 * with fake operations/orchestrator + a fake consult. Owns a single pending
 * action per owner chat. Returns `{ handle }` — the bridge calls it per inbound
 * owner message; deterministic commands are decided first (see `decide`).
 */
export function createOwnerControl(deps: OwnerControlDeps): {
  handle: (chatId: string, text: string, replyToMessageId?: number) => Promise<void>;
  handleCallback: (
    chatId: string,
    data: string,
    callbackQueryId: string,
    messageId: number,
  ) => Promise<void>;
  /** Register a decision card the bridge just sent, so a reply to it (or a
   *  "Request changes" tap) routes guidance to the right gate. */
  noteCard: (messageId: number, gateId: string, runId: string) => void;
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

  // ── "Request changes" / reply-to-resume ───────────────────────────────────
  // A decision card's message id → its gate, so replying to that message sends
  // the reply as `modify` guidance (the SAME path the app's "Request changes →
  // resume" uses). Tapping ✏️ instead arms `awaitingGuidance`, so the operator's
  // NEXT message becomes the guidance even without an explicit reply.
  const cardGate = new Map<number, { gateId: string; runId: string }>();
  let awaitingGuidance: { gateId: string; runId: string; messageId: number } | null = null;
  const noteCard = (messageId: number, gateId: string, runId: string): void => {
    if (messageId) cardGate.set(messageId, { gateId, runId });
  };
  /** Deliver operator text as `modify` guidance to a gate — resumes the agent. */
  const sendGuidance = async (chatId: string, gate: { gateId: string; messageId?: number }, text: string): Promise<void> => {
    const stillOpen = (await openGates()).some((g) => g.id === gate.gateId);
    if (!stillOpen) {
      await notify("That decision was already handled — nothing to change.");
      return;
    }
    try {
      await operations.resolveHitl(ws, gate.gateId, { action: "modify", guidance: text }, operatorId);
      await notify("↩ Sent your changes — resuming the agent. I'll re-check when it's back.");
      if (gate.messageId) await editReplyMarkup(chatId, gate.messageId).catch(() => undefined);
    } catch (err) {
      await notify(`Couldn't send those changes: ${(err as Error).message}`);
    }
  };

  const statusText = async (): Promise<string> => {
    const runs = await operations.listRuns(ws);
    const active = runs.filter((r) => r.status === "running" || r.status === "waiting").length;
    const gates = (await openGates()).length;
    return `Status: ${active} run(s) running/waiting, ${gates} open gate(s), autonomy ${
      orchestrator.isPaused() ? "PAUSED" : "active"
    }.`;
  };

  /** The glanceable /inbox digest — decisions first, then run counts. Resolves
   *  each gate's run name from the run list (no id soup), same as the pushes. */
  const digest = async (): Promise<{ text: string }> => {
    const [gates, runs] = await Promise.all([openGates(), operations.listRuns(ws)]);
    const runName = new Map(runs.map((r) => [r.id, r.name || r.id]));
    return {
      text: digestText({
        gates: gates.map((g) => ({ head: gateHead(g.kind), run: runName.get(g.runId) ?? g.title })),
        running: runs.filter((r) => r.status === "running" || r.status === "waiting").length,
        done: runs.filter((r) => r.status === "done").length,
      }),
    };
  };

  /** Turn a validated Action into a human-readable summary + a deferred executor
   *  (run on confirm). Never executes here — only describes. The `id` and
   *  `messageId` are stamped at the call site where we mint the nonce and know
   *  the message id after `notify` returns. */
  // ASYNC (unlike every other branch, which is pure/synchronous) because the
  // three execution-intent COMPOSITES need a dry-run BEFORE the confirm
  // message is even built — the pending text IS the feasibility preview, not
  // a generic "sure?" the operator has to trust blind. start_task doesn't
  // dry-run (nothing composite to preview), matching the dock.
  const toPending = async (action: Action, ctx: IntentContext): Promise<Omit<Pending, "id" | "messageId"> | null> => {
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
      case "move_task": {
        const task = ctx.tasks.find((t) => t.id === action.taskId);
        const summary = `Move task ${action.taskId} — "${task?.text ?? "?"}" to ${action.state}?`;
        return {
          kind: action.kind,
          summary,
          run: async () => {
            if (!operations.transitionTask) throw new Error("moving tasks isn't available here");
            await operations.transitionTask(ws, action.taskId!, action.state as Task["state"], operatorId);
            return `↦ Moved task ${action.taskId} to ${action.state}.`;
          },
        };
      }
      case "rename_task": {
        const task = ctx.tasks.find((t) => t.id === action.taskId);
        const summary = `Rename task ${action.taskId} — "${task?.text ?? "?"}" → "${action.newText}"?`;
        return {
          kind: action.kind,
          summary,
          run: async () => {
            if (!operations.updateTask) throw new Error("editing tasks isn't available here");
            await operations.updateTask(ws, action.taskId!, { text: action.newText! });
            return `✏️ Renamed task ${action.taskId} to "${action.newText}".`;
          },
        };
      }
      case "set_task_desc": {
        const task = ctx.tasks.find((t) => t.id === action.taskId);
        const cleared = !action.description;
        const summary = `${cleared ? "Clear the description of" : "Set the description of"} task ${action.taskId} — "${task?.text ?? "?"}"?`;
        return {
          kind: action.kind,
          summary,
          run: async () => {
            if (!operations.updateTask) throw new Error("editing tasks isn't available here");
            await operations.updateTask(ws, action.taskId!, { description: action.description! || null });
            return `📝 ${cleared ? "Cleared" : "Updated"} the description of task ${action.taskId}.`;
          },
        };
      }
      case "rename_project": {
        const project = ctx.projects.find((p) => p.id === action.projectId);
        const summary = `Rename project ${project?.name ?? action.projectId} → "${action.projectName}"?`;
        return {
          kind: action.kind,
          summary,
          run: async () => {
            if (!operations.updateProject) throw new Error("editing projects isn't available here");
            await operations.updateProject(ws, action.projectId!, { name: action.projectName! });
            return `✏️ Renamed project to "${action.projectName}".`;
          },
        };
      }
      case "set_goal": {
        const project = ctx.projects.find((p) => p.id === action.projectId);
        const summary = `Set ${project?.name ?? action.projectId}'s goal to "${action.projectGoal}"?`;
        return {
          kind: action.kind,
          summary,
          run: async () => {
            if (!operations.updateProject) throw new Error("editing projects isn't available here");
            await operations.updateProject(ws, action.projectId!, { goal: action.projectGoal ?? "" });
            return `🎯 Updated ${project?.name ?? action.projectId}'s goal.`;
          },
        };
      }
      case "set_autonomy": {
        const project = ctx.projects.find((p) => p.id === action.projectId);
        const summary = `Turn autonomy ${action.autonomy ? "ON" : "OFF"} for ${project?.name ?? action.projectId}?`;
        return {
          kind: action.kind,
          summary,
          run: async () => {
            if (!operations.updateProject) throw new Error("editing projects isn't available here");
            await operations.updateProject(ws, action.projectId!, { autonomy: action.autonomy! });
            return `⚙️ Autonomy ${action.autonomy ? "on" : "off"} for ${project?.name ?? action.projectId}.`;
          },
        };
      }
      case "set_status": {
        const project = ctx.projects.find((p) => p.id === action.projectId);
        const summary = `Set ${project?.name ?? action.projectId} status to ${action.projectStatus}?`;
        return {
          kind: action.kind,
          summary,
          run: async () => {
            if (!operations.updateProject) throw new Error("editing projects isn't available here");
            await operations.updateProject(ws, action.projectId!, { status: action.projectStatus as UpdateProjectRequest["status"] });
            return `🏷 ${project?.name ?? action.projectId} is now ${action.projectStatus}.`;
          },
        };
      }
      case "preview": {
        const project = ctx.projects.find((p) => p.id === action.projectId);
        const name = project?.name ?? action.projectId;
        const summary = `Preview ${name} — spin up a live preview and send the link here?`;
        return {
          kind: action.kind,
          summary,
          run: async () => {
            // Reply immediately, then push the URL when the preview is ready.
            // previewStart resolves only once the dev server is live (or failed),
            // so fire-and-forget it and notify on settle — never block this reply.
            void operations.previewStart(ws, action.projectId!).then(
              (st) =>
                notify(
                  st.status === "live" && st.url
                    ? `🔗 Preview ready for ${name}: ${st.url}`
                    : `⚠ Couldn't start the preview for ${name}: ${st.error ?? st.status}`,
                ),
              (err) => notify(`⚠ Couldn't start the preview for ${name}: ${(err as Error).message}`),
            );
            return `🚀 Spinning up a live preview of ${name} — I'll send the link here when it's ready.`;
          },
        };
      }
      case "create_feature": {
        const project = ctx.projects.find((p) => p.id === action.projectId);
        const projName = project?.name ?? action.projectId;
        const ms = action.milestoneId ? ctx.milestones.find((m) => m.id === action.milestoneId) : undefined;
        const msPart = ms ? ` under milestone "${ms.name}"` : "";
        return {
          kind: action.kind,
          summary: `Create feature "${action.featureName}" in ${projName}${msPart}?`,
          run: async () => {
            const f = await operations.createFeature(ws, action.projectId!, {
              name: action.featureName!,
              ...(action.featureDescription ? { description: action.featureDescription } : {}),
              ...(action.milestoneId ? { milestoneId: action.milestoneId } : {}),
            });
            return `⊞ Feature "${f.name}" created (${f.id}) in ${projName}.`;
          },
        };
      }
      case "set_task_feature": {
        const task = ctx.tasks.find((t) => t.id === action.taskId);
        if (action.featureId == null) {
          return {
            kind: action.kind,
            summary: `Unlink task ${action.taskId} — "${task?.text ?? "?"}" from its feature?`,
            run: async () => {
              if (!operations.updateTask) throw new Error("editing tasks isn't available here");
              await operations.updateTask(ws, action.taskId!, { featureId: null });
              return `⊞ Task ${action.taskId} unlinked from its feature.`;
            },
          };
        }
        const feature = ctx.features.find((f) => f.id === action.featureId);
        return {
          kind: action.kind,
          summary: `Move task ${action.taskId} — "${task?.text ?? "?"}" into feature "${feature?.name ?? action.featureId}"?`,
          run: async () => {
            if (!operations.updateTask) throw new Error("editing tasks isn't available here");
            await operations.updateTask(ws, action.taskId!, { featureId: action.featureId ?? null });
            return `⊞ Task ${action.taskId} → feature "${feature?.name ?? action.featureId}".`;
          },
        };
      }
      case "archive_feature": {
        const feature = ctx.features.find((f) => f.id === action.featureId);
        return {
          kind: action.kind,
          summary: `Archive feature "${feature?.name ?? action.featureId}" (hide, recoverable)?`,
          run: async () => {
            await operations.updateFeature(ws, action.featureId!, { archived: true });
            return `🗃 Archived feature "${feature?.name ?? action.featureId}".`;
          },
        };
      }
      case "create_milestone": {
        const project = ctx.projects.find((p) => p.id === action.projectId);
        const projName = project?.name ?? action.projectId;
        const when = action.targetAt ? ` (target ${new Date(action.targetAt).toISOString().slice(0, 10)})` : "";
        return {
          kind: action.kind,
          summary: `Create milestone "${action.milestoneName}" in ${projName}${when}?`,
          run: async () => {
            const m = await operations.createMilestone(ws, action.projectId!, {
              name: action.milestoneName!,
              ...(action.milestoneDescription ? { description: action.milestoneDescription } : {}),
              ...(action.targetAt !== undefined ? { targetAt: action.targetAt } : {}),
            });
            return `◉ Milestone "${m.name}" created (${m.id}) in ${projName}${when}.`;
          },
        };
      }
      case "set_feature_milestone": {
        const feature = ctx.features.find((f) => f.id === action.featureId);
        if (action.milestoneId == null) {
          return {
            kind: action.kind,
            summary: `Unlink feature "${feature?.name ?? action.featureId}" from its milestone?`,
            run: async () => {
              await operations.updateFeature(ws, action.featureId!, { milestoneId: null });
              return `◉ Feature "${feature?.name ?? action.featureId}" unlinked from its milestone.`;
            },
          };
        }
        const ms = ctx.milestones.find((m) => m.id === action.milestoneId);
        return {
          kind: action.kind,
          summary: `Attach feature "${feature?.name ?? action.featureId}" to milestone "${ms?.name ?? action.milestoneId}"?`,
          run: async () => {
            await operations.updateFeature(ws, action.featureId!, { milestoneId: action.milestoneId ?? null });
            return `◉ Feature "${feature?.name ?? action.featureId}" → milestone "${ms?.name ?? action.milestoneId}".`;
          },
        };
      }
      case "set_task_milestone": {
        const task = ctx.tasks.find((t) => t.id === action.taskId);
        if (action.milestoneId == null) {
          return {
            kind: action.kind,
            summary: `Unlink task ${action.taskId} — "${task?.text ?? "?"}" from its milestone?`,
            run: async () => {
              if (!operations.updateTask) throw new Error("editing tasks isn't available here");
              await operations.updateTask(ws, action.taskId!, { milestoneId: null });
              return `◉ Task ${action.taskId} unlinked from its milestone.`;
            },
          };
        }
        const ms = ctx.milestones.find((m) => m.id === action.milestoneId);
        return {
          kind: action.kind,
          summary: `Attach task ${action.taskId} — "${task?.text ?? "?"}" to milestone "${ms?.name ?? action.milestoneId}"?`,
          run: async () => {
            if (!operations.updateTask) throw new Error("editing tasks isn't available here");
            await operations.updateTask(ws, action.taskId!, { milestoneId: action.milestoneId ?? null });
            return `◉ Task ${action.taskId} → milestone "${ms?.name ?? action.milestoneId}".`;
          },
        };
      }
      case "mark_milestone_shipped": {
        const ms = ctx.milestones.find((m) => m.id === action.milestoneId);
        return {
          kind: action.kind,
          summary: `Mark milestone "${ms?.name ?? action.milestoneId}" as shipped?`,
          run: async () => {
            await operations.updateMilestone(ws, action.milestoneId!, { status: "shipped" });
            return `🚢 Milestone "${ms?.name ?? action.milestoneId}" shipped.`;
          },
        };
      }
      // ── Execution intents (S10/S11) ────────────────────────────────────
      case "start_task": {
        // No dry-run — a direct, explicit single-task start, same as the dock.
        const task = ctx.tasks.find((t) => t.id === action.taskId);
        return {
          kind: action.kind,
          summary: `Start task ${action.taskId} — "${task?.text ?? "?"}" now?`,
          run: async () => {
            const outcome = await operations.executeStewardAction(ws, action.projectId!, toExecutionAction(action), operatorId);
            return outcome.started.length
              ? `▶️ Started task ${action.taskId}.`
              : `Task ${action.taskId} wasn't startable — ${excludedBreakdown(outcome) || "no eligible task"}.`;
          },
        };
      }
      case "queue_tasks": {
        const preview = await operations.executeStewardAction(ws, action.projectId!, toExecutionAction(action), operatorId, { dryRun: true });
        return {
          kind: action.kind,
          summary: `Queue ${action.taskIds!.length} task(s) — would ${previewDetail(preview)}. Go ahead?`,
          run: async () => {
            const outcome = await operations.executeStewardAction(ws, action.projectId!, toExecutionAction(action), operatorId);
            return `✅ ${summarizeOutcome(outcome)}.`;
          },
        };
      }
      case "start_feature": {
        const feature = ctx.features.find((f) => f.id === action.featureId);
        const preview = await operations.executeStewardAction(ws, action.projectId!, toExecutionAction(action), operatorId, { dryRun: true });
        return {
          kind: action.kind,
          summary: `${action.execMode === "start_now" ? "Start now" : "Queue"} feature "${feature?.name ?? action.featureId}" — would ${previewDetail(preview)}. Go ahead?`,
          run: async () => {
            const outcome = await operations.executeStewardAction(ws, action.projectId!, toExecutionAction(action), operatorId);
            return `✅ ${summarizeOutcome(outcome)}.`;
          },
        };
      }
      case "process_backlog": {
        const project = ctx.projects.find((p) => p.id === action.projectId);
        const preview = await operations.executeStewardAction(ws, action.projectId!, toExecutionAction(action), operatorId, { dryRun: true });
        return {
          kind: action.kind,
          summary: `Queue ${project?.name ?? action.projectId}'s backlog — would ${previewDetail(preview)}. Go ahead?`,
          run: async () => {
            const outcome = await operations.executeStewardAction(ws, action.projectId!, toExecutionAction(action), operatorId);
            return `✅ ${summarizeOutcome(outcome)}.`;
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
      const draft = await toPending(action, ctx);
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

  const handle = async (chatId: string, text: string, replyToMessageId?: number): Promise<void> => {
    // Owner-bound guardrail (mirrors `decide`'s ignore): never act on another chat.
    if (String(chatId) !== deps.ownerChatId) {
      log("ignored message from non-owner chat");
      return;
    }

    // "Request changes" flow — a reply to a decision card, or the next message
    // after tapping ✏️, becomes `modify` guidance that resumes the agent. An
    // explicit reply always wins; the armed state defers to a real slash command.
    if (deps.controlEnabled && text.trim()) {
      const replied = replyToMessageId != null ? cardGate.get(replyToMessageId) : undefined;
      if (replied) {
        await sendGuidance(chatId, { gateId: replied.gateId, messageId: replyToMessageId }, text.trim());
        return;
      }
      if (awaitingGuidance && !text.trim().startsWith("/")) {
        const g = awaitingGuidance;
        awaitingGuidance = null;
        await sendGuidance(chatId, { gateId: g.gateId, messageId: g.messageId }, text.trim());
        return;
      }
    }

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

      case "inbox": {
        const { text: body } = await digest();
        await notify(body, { parse_mode: "HTML" });
        return;
      }

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

    // ── HITL actions — approve/reject/modify/diff. Same gate rule as /approve.
    if (kind === "hitl") {
      const sepInRest = rest.indexOf(":");
      const decision = sepInRest > 0 ? rest.slice(0, sepInRest) : rest;
      let gateId = sepInRest > 0 ? rest.slice(sepInRest + 1) : "";
      // A decision choice rides as `option:<index>:<gateId>` — peel the index off
      // the front, leaving the real gate id (hitl ids carry no colons).
      let optionIndex: number | undefined;
      if (decision === "option") {
        const sep2 = gateId.indexOf(":");
        optionIndex = Number(gateId.slice(0, sep2));
        gateId = sep2 > 0 ? gateId.slice(sep2 + 1) : "";
        if (!Number.isInteger(optionIndex) || optionIndex < 0) {
          await ackCallback(callbackQueryId);
          return;
        }
      }
      if (!["approve", "reject", "modify", "diff", "option"].includes(decision) || !gateId) {
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

      // 🔍 View diff — send the run's real patch (truncated), no resolution.
      if (decision === "diff") {
        await ackCallback(callbackQueryId).catch(() => undefined);
        try {
          const d = operations.runDiff ? await operations.runDiff(ws, gate.runId) : null;
          if (!d) {
            await notify("Diff isn't available for this run.");
          } else {
            const MAX = 3200; // keep well under Telegram's 4096-char message cap
            const clipped = d.patch.length > MAX ? d.patch.slice(0, MAX) + "\n… (truncated — open the app for the full diff)" : d.patch;
            const head = `🔍 <b>${d.files.length} file(s)</b> · <code>+${d.add} −${d.del}</code>`;
            await notify(`${head}\n<pre>${esc(clipped)}</pre>`, { parse_mode: "HTML" });
          }
        } catch (err) {
          await notify(`Couldn't load the diff: ${(err as Error).message}`);
        }
        return; // leave the decision buttons in place
      }

      // ✏️ Request changes — arm guidance capture; the next message resumes the agent.
      if (decision === "modify") {
        await ackCallback(callbackQueryId, { text: "Send your changes as a message." }).catch(() => undefined);
        awaitingGuidance = { gateId, runId: gate.runId, messageId };
        await notify("✏️ Reply with the changes you want — I'll send them to the agent and it'll resume.");
        return; // keep the buttons; guidance arrives as the next message
      }

      // ①②③ Chose a decision option — resolve with that index; the agent resumes
      // on the selected answer.
      if (decision === "option") {
        await ackCallback(callbackQueryId).catch(() => undefined);
        const chosen = gate.options?.[optionIndex!];
        try {
          await operations.resolveHitl(ws, gateId, { action: "option", optionIndex }, operatorId);
          await notify(`✅ Chose${chosen ? ` “${esc(chosen)}”` : ` option ${optionIndex! + 1}`} — the agent is resuming.`, { parse_mode: "HTML" });
        } catch (err) {
          await notify(`Couldn't submit that choice: ${(err as Error).message}`);
        }
        if (messageId) await editReplyMarkup(chatId, messageId).catch(() => undefined);
        return;
      }

      await ackCallback(callbackQueryId).catch(() => undefined);
      try {
        await operations.resolveHitl(ws, gateId, { action: decision as "approve" | "reject" }, operatorId);
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

  return { handle, handleCallback, noteCard };
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

/**
 * PURE: decide whether to send a Telegram card for a raised gate, given the
 * suppression rule that an auto-approved gate should NOT ping the operator's
 * phone.
 *
 *   • Approval-policy auto-approval (reversible in-sandbox commands, per
 *     `approval-policy.ts`) goes through the SILENT hub path
 *     (`raiseAndAutoResolveHitl`) — `hitl.raised` never fires for it, so
 *     those gates never reach this function.
 *
 *   • Auto-REVIEW (a fleet agent judging a completed run's diff/merge)
 *     runs through the normal path: `hitl.raised` fires immediately, then
 *     the autonomy tick (~15s + LLM) picks the gate up and resolves it. A
 *     naive notify pings the phone at t=0 about a decision that's about
 *     to auto-approve — the reported bug.
 *
 * Fix: for diff/merge gates on projects with autonomy on, wait through
 * the auto-review window (`debounceMs`), then re-check the gate. If it
 * resolved during the buffer, skip the notification entirely. Other gate
 * kinds (question, plan, escalation) aren't auto-reviewed, so their
 * `delay=0`. The re-check runs unconditionally as a race-guard — a
 * same-tick resolve is caught even without a delay.
 */
export interface GateAnnounceDeps {
  getRun(runId: string): Promise<{ projectId: string } | null>;
  getProject(projectId: string): Promise<{ autonomy: boolean } | null>;
  listOpenHitl(): Promise<HitlItem[]>;
  debounceMs: number;
  sleep(ms: number): Promise<void>;
}

export async function shouldAnnounceGate(
  item: HitlItem,
  deps: GateAnnounceDeps,
): Promise<{ send: boolean; delayedMs: number }> {
  const isReviewy = item.kind === "diff" || item.kind === "merge";
  let delayMs = 0;
  if (isReviewy && deps.debounceMs > 0) {
    const run = await deps.getRun(item.runId);
    const project = run ? await deps.getProject(run.projectId) : null;
    if (project?.autonomy) delayMs = deps.debounceMs;
  }
  if (delayMs > 0) await deps.sleep(delayMs);
  // Re-check under BOTH branches. A same-tick auto-resolve races the event
  // even with no delay, so the belt-and-suspenders re-read matters.
  const current = (await deps.listOpenHitl()).find((g) => g.id === item.id);
  const send = !!current && !current.resolvedAt;
  return { send, delayedMs: delayMs };
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
  /** Best-effort edit a message's text in place (live cards). Swallows errors. */
  const editText = async (messageId: number, text: string): Promise<void> => {
    try {
      await client.editMessageText(ownerChatId, messageId, text, { parse_mode: "HTML", reply_markup: null });
    } catch (err) {
      log(`editMessageText failed: ${(err as Error).message}`);
    }
  };

  // Quiet hours hold LOW-VALUE "shipped" pings overnight (decisions always go
  // through). Parsed once; malformed/unset → never quiet.
  const quiet = parseQuietHours(config.telegramQuietHours);
  // A run's live decision card (message id), so completion edits it in place into
  // "✅ Shipped" instead of stacking a separate line under it.
  const runCard = new Map<string, number>();

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
  // Deep link to open the run in the app. Desktop: always a skynet:// OS-protocol
  // link (config.desktop — apps/desktop/main.cjs sets SKYNET_DESKTOP=1 — no
  // PUBLIC_URL/token needed, the app is already running locally as the single
  // operator). Hosted: unchanged — empty unless PUBLIC_URL is configured.
  const linkFor = (runId: string): string | undefined =>
    config.desktop ? desktopRunLink(runId) : runLink(config.publicUrl, runId);

  // De-dupe run notices: only push when a run's status actually CHANGES, so a run
  // that re-emits "review" doesn't send the same line three times (the reported
  // spam). A gate raise also records "review" so we never double-notify a review.
  const lastNotice = new Map<string, string>();

  const announceGate = async (it: HitlItem): Promise<void> => {
    lastNotice.set(it.runId, "review"); // the gate IS the review heads-up

    // Suppress auto-approved gates. See `shouldAnnounceGate` for the full
    // rationale — briefly:
    //   • Approval-policy auto-approval (reversible in-sandbox commands) uses
    //     the SILENT hub path (`raiseAndAutoResolveHitl`), so `hitl.raised`
    //     never fires for those — they don't reach this handler.
    //   • Auto-REVIEW (a fleet agent judging a completed run's diff/merge)
    //     DOES emit `hitl.raised` first; the autonomy tick approves later.
    //     The debounce below waits through that window and skips the
    //     notification if the gate resolved in the meantime.
    const decision = await shouldAnnounceGate(it, {
      getRun: (id) => operations.getRun(ws, id).catch(() => null),
      getProject: (id) => operations.getProject(ws, id).catch(() => null),
      listOpenHitl: () => operations.listHitl(ws).catch(() => []),
      debounceMs: config.telegramGateAutoReviewDebounceMs,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    if (!decision.send) return;

    const opts: NotifyOpts = { parse_mode: "HTML" };
    if (config.telegramControl) opts.reply_markup = gateKeyboard(it);
    const sent = await notify(decisionCardHtml(it, await nameOf(it.runId), config.telegramControl, linkFor(it.runId)), opts);
    if (sent.messageId) {
      // A reply to this card → "request changes"; completion edits it in place.
      if (config.telegramControl) control.noteCard(sent.messageId, it.id, it.runId);
      runCard.set(it.runId, sent.messageId);
    }
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
        await notify(reviewNotice(await nameOf(runId), linkFor(runId)));
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
        const names = await nameOf(event.runId);
        const cardId = runCard.get(event.runId);
        if (cardId) {
          // Live card: turn the decision card you acted on INTO its result, in
          // place — no separate ping, so it's fine even during quiet hours.
          runCard.delete(event.runId);
          await editText(cardId, shippedCardHtml(names));
          return;
        }
        // No card to edit → a fresh "shipped" line. Low value, so hold it during
        // quiet hours (the /inbox digest still reflects it whenever you look).
        if (inQuietHours(new Date(), quiet)) return;
        await notify(completedNotice(names, linkFor(event.runId)));
      })();
    }
  };
  // Scope to the SAME workspace the web/admin uses. `config.adminWorkspace` is
  // set by the deployer (e.g. GCP setup.sh writes "skynet") and by the seed path
  // in index.ts — hardcoding DEFAULT_WORKSPACE here made Telegram query a
  // different empty universe than the web (the "workspace looks empty" bug).
  const ws = config.adminWorkspace || DEFAULT_WORKSPACE;

  // ── Inbound: owner-only control (deterministic commands + confirmed intents) ─
  // Created BEFORE subscribing, so a gate raised during boot can register its
  // decision card via `control.noteCard` without a temporal-dead-zone hazard.
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

  bus.subscribe(ws, handler);

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
          await control.handle(String(msg.chat.id), msg.text, msg.reply_to_message?.message_id).catch((err) =>
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
