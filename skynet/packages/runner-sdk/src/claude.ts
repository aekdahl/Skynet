// ─── Claude Code runner ───────────────────────────────────────────────────
// A real RunnerProvider backed by @anthropic-ai/claude-agent-sdk. This is the
// Phase-A spike that validates the runner-sdk control contract against a real
// agent: streaming-input session, a blocking `canUseTool` permission callback
// mapped to a HITL approval gate, interrupt(), and session resume for fork.
//
// Selected via RUNNER=claude. The default RUNNER=mock path is untouched.

import {
  query,
  type CanUseTool,
  type Options,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { PlanStep, ProviderId, Resolution } from "@skynet/shared";
import type {
  ConsultSpec,
  HitlRaise,
  RunnerEvents,
  RunnerHandle,
  RunnerProvider,
  StartSpec,
} from "./types.js";

// A push-driven async iterable of user messages — keeps the session live so we
// can inject chat / modify-guidance mid-run (streaming input mode).
function createInputStream() {
  const buffer: SDKUserMessage[] = [];
  let waiting: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  let closed = false;
  const wrap = (text: string): SDKUserMessage =>
    ({ type: "user", parent_tool_use_id: null, message: { role: "user", content: text } } as SDKUserMessage);
  return {
    push(text: string) {
      if (closed) return;
      const msg = wrap(text);
      if (waiting) { waiting({ value: msg, done: false }); waiting = null; }
      else buffer.push(msg);
    },
    close() {
      closed = true;
      if (waiting) { waiting({ value: undefined as never, done: true }); waiting = null; }
    },
    async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
      for (;;) {
        if (buffer.length) { yield buffer.shift()!; continue; }
        if (closed) return;
        const next = await new Promise<IteratorResult<SDKUserMessage>>((r) => (waiting = r));
        if (next.done) return;
        yield next.value;
      }
    },
  };
}

// Read-only tools run without a human gate; mutating/risky tools raise a HITL.
const AUTO_ALLOW = new Set(["Read", "LS", "Glob", "Grep", "NotebookRead", "TodoWrite"]);

const mapModel = (m: string): string | undefined =>
  m.startsWith("fable") ? "claude-fable-5"
    : m.startsWith("opus") ? "opus"
    : m.startsWith("sonnet") ? "sonnet"
    : m.startsWith("haiku") ? "haiku"
    : undefined;

// Build the env handed to the Agent SDK subprocess. `Options.env` REPLACES the
// subprocess environment, so we spread the ambient env (PATH/HOME/…) and then
// drop the markers that would route a nested Claude Code child to host-managed
// OAuth — a standalone server can't satisfy that path and would 401.
//
// Accepted credentials (any one authenticates the SDK): ANTHROPIC_API_KEY, a
// subscription token from `claude setup-token` (CLAUDE_CODE_OAUTH_TOKEN), or a
// gateway bearer token (ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL). We only
// strip the gateway credentials when a static ANTHROPIC_API_KEY would shadow
// them, or when a NESTED Claude Code session's host-managed gateway would 401 a
// standalone server. CLAUDE_CODE_OAUTH_TOKEN is a real standalone credential, so
// it is preserved while the other CLAUDE_CODE_* session markers are dropped.
export function buildRunnerEnv(): Record<string, string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  // A nested Claude Code session is signalled by CLAUDE_CODE_* markers *other*
  // than a deliberately-set OAuth token; its inherited gateway creds 401.
  const nestedSession = Object.keys(process.env).some(
    (k) => k.startsWith("CLAUDE_CODE_") && k !== "CLAUDE_CODE_OAUTH_TOKEN",
  );
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null) continue;
    // Drop nested child-session markers, but keep a real OAuth token.
    if (k.startsWith("CLAUDE_CODE_") && k !== "CLAUDE_CODE_OAUTH_TOKEN") continue;
    // Drop inherited gateway auth when a static key shadows it, or when a nested
    // session's host-managed gateway would 401 standalone.
    if ((apiKey || nestedSession) && (k === "ANTHROPIC_BASE_URL" || k === "ANTHROPIC_AUTH_TOKEN")) continue;
    env[k] = v;
  }
  return env;
}

/** A one-shot, tool-less query — used for consults (gate questions, follow-ups
 *  about finished work). Returns the answer text, or `fallback` if empty. */
async function oneShotConsult(opts: {
  prompt: string;
  cwd: string;
  model: string;
  env: Record<string, string>;
  fallback: string;
}): Promise<string> {
  try {
    const q = query({
      prompt: opts.prompt,
      options: {
        cwd: opts.cwd,
        model: mapModel(opts.model),
        permissionMode: "default",
        // Deny every tool so this stays a pure text answer.
        canUseTool: () => Promise.resolve({ behavior: "deny", message: "Answer in text only; do not use tools." } as PermissionResult),
        maxTurns: 4,
        env: opts.env,
      },
    });
    let answer = "";
    for await (const msg of q as AsyncIterable<SDKMessage>) {
      if (msg.type === "assistant") {
        const { text } = readAssistant((msg as { message: { content?: unknown } }).message);
        if (text) answer += (answer ? "\n" : "") + text;
      } else if (msg.type === "result") {
        break;
      }
    }
    return answer.trim() || opts.fallback;
  } catch (err) {
    return `couldn't look into that right now (${(err as Error).message}).`;
  }
}

/** A one-shot, tool-less text query authenticated exactly like a live runner
 *  (via {@link buildRunnerEnv} — so it works standalone AND nested inside a
 *  Claude Code session, where a raw `fetch` to the API has no egress). Used by
 *  out-of-band callers such as the eval judge. Returns the model's text. */
export async function oneShotText(opts: { prompt: string; model?: string; cwd?: string }): Promise<string> {
  return oneShotConsult({
    prompt: opts.prompt,
    cwd: opts.cwd ?? process.cwd(),
    model: opts.model ?? "opus",
    env: buildRunnerEnv(),
    fallback: "",
  });
}

// A tool call the assistant requested: its name, input args, and id (to pair
// with the later tool_result that carries its output).
type ToolCall = { name: string; input: Record<string, unknown>; id?: string };

// Extract text + tool calls (with inputs) from an assistant message.
function readAssistant(message: { content?: unknown }): { text: string; tools: ToolCall[] } {
  const blocks = Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : [];
  let text = "";
  const tools: ToolCall[] = [];
  for (const b of blocks) {
    if (b.type === "text" && typeof b.text === "string") text += b.text;
    else if (b.type === "tool_use" && typeof b.name === "string") {
      tools.push({
        name: b.name,
        input: b.input && typeof b.input === "object" ? (b.input as Record<string, unknown>) : {},
        id: typeof b.id === "string" ? b.id : undefined,
      });
    }
  }
  return { text: text.trim(), tools };
}

const clip = (s: string, n = 100) => (s.length > n ? `${s.slice(0, n)}…` : s);

// Flatten a tool_result's content (string, or an array of text/blocks) to text.
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : typeof c === "string" ? c : JSON.stringify(c)))
      .join("");
  }
  return content == null ? "" : JSON.stringify(content);
}

// One-line summary for the activity log (▸ Edit README.md, ▸ Bash: pnpm test, …).
function describeTool(name: string, input: Record<string, unknown>): string {
  const fp = typeof input.file_path === "string" ? input.file_path.split("/").pop() : undefined;
  if (name === "Bash" && typeof input.command === "string") return `Bash: ${clip(input.command)}`;
  if (fp && /^(Read|Write|Edit|NotebookRead|NotebookEdit)$/.test(name)) return `${name} ${fp}`;
  if (typeof input.pattern === "string" && /^(Glob|Grep)$/.test(name)) return `${name} ${clip(String(input.pattern), 60)}`;
  return name;
}

// Human-readable detail shown in the approval gate (the box the operator reads).
function approvalText(name: string, input: Record<string, unknown>): string {
  if (name === "Bash" && typeof input.command === "string") return input.command;
  const fp = typeof input.file_path === "string" ? input.file_path : undefined;
  if (name === "Edit" && fp) {
    const o = String(input.old_string ?? "");
    const n = String(input.new_string ?? "");
    return (
      `Edit ${fp}\n\n` +
      o.split("\n").map((l) => `- ${l}`).join("\n") +
      "\n" +
      n.split("\n").map((l) => `+ ${l}`).join("\n")
    );
  }
  if (name === "Write" && fp) return `Write ${fp}\n\n${clip(String(input.content ?? ""), 800)}`;
  if (fp) return `${name} ${fp}`;
  return JSON.stringify(input, null, 2);
}

/** A human-readable failure reason from an errored terminal result — the SDK's
 *  collected `errors` (e.g. "API Error: 529 Overloaded"), else the API status,
 *  else the error subtype (error_max_turns, error_during_execution, …). */
function resultErrorReason(r: SDKResultMessage): string {
  const errs = (r as { errors?: string[] }).errors;
  if (errs && errs.length) return errs.join("; ");
  const status = (r as { api_error_status?: number | null }).api_error_status;
  if (status) return `API error ${status}`;
  const text = (r as { result?: string }).result;
  if (r.subtype && r.subtype !== "success") return text ? `${r.subtype} — ${text}` : r.subtype;
  return text || "runner ended in an error state";
}

// The names of the agent's task-management tools. The claude_code preset gives
// TaskCreate/TaskUpdate (SDK ≥ 0.3.x, one task per call, SDK-assigned id);
// older builds use TodoWrite (whole list per call). We map either onto the
// PLAN panel so progress reflects real work, not a synthetic bump.
const PLAN_TOOLS = new Set(["TaskCreate", "TaskUpdate", "TodoWrite"]);

const taskStatusToState = (status: string): PlanStep["state"] =>
  status === "completed" ? "done" : status === "in_progress" ? "now" : "todo";

// TodoWrite input: { todos: [{ content, status, activeForm? }] } — a full list.
function todosToPlan(input: Record<string, unknown>): PlanStep[] {
  const todos = Array.isArray(input.todos) ? (input.todos as Array<Record<string, unknown>>) : [];
  const plan: PlanStep[] = [];
  for (const t of todos) {
    const state = taskStatusToState(String(t.status ?? "pending"));
    // Prefer the present-tense form while active; fall back to the content.
    const text = String((state === "now" && t.activeForm) || t.content || t.activeForm || "").trim();
    if (text) plan.push({ text, state });
  }
  return plan;
}

// A clarifying question the agent asked via the AskUserQuestion tool, distilled
// to what the HITL model needs: a prompt + a flat list of option labels.
interface ParsedQuestion {
  header: string; // short label for the question (chip/title)
  prompt: string; // the full question text shown to the operator
  options: Array<{ label: string; description?: string }>;
}

// AskUserQuestion input: { questions: [{ question, header, options: [{label, description}] }] }.
// We surface the FIRST question (the HITL model is one question + a choice list);
// any extra questions are appended to the prompt so nothing is silently dropped.
function parseAskUserQuestion(input: Record<string, unknown>): ParsedQuestion | null {
  const questions = Array.isArray(input.questions)
    ? (input.questions as Array<Record<string, unknown>>)
    : [];
  if (!questions.length) return null;
  const q0 = questions[0] ?? {};
  const rawOpts = Array.isArray(q0.options) ? q0.options : [];
  const options = rawOpts
    .map((o) =>
      typeof o === "string"
        ? { label: o }
        : o && typeof o === "object"
          ? { label: String((o as Record<string, unknown>).label ?? ""), description: (o as Record<string, unknown>).description ? String((o as Record<string, unknown>).description) : undefined }
          : { label: "" },
    )
    .filter((o) => o.label);
  if (!options.length) return null;
  const header = String(q0.header ?? "Question").trim() || "Question";
  let prompt = String(q0.question ?? q0.header ?? "The agent needs a decision.").trim();
  if (questions.length > 1) {
    const extra = questions.slice(1).map((q) => String(q.question ?? q.header ?? "")).filter(Boolean);
    if (extra.length) prompt += `\n\n(Also asked — answer in the same reply via Modify: ${extra.join(" · ")})`;
  }
  return { header, prompt, options };
}

// Turn a parsed AskUserQuestion into a `question` HITL: the prompt + a choice
// list the UI renders as option buttons (resolved via the `option` action).
function buildQuestionRaise(q: ParsedQuestion): HitlRaise {
  const detail = q.options.some((o) => o.description)
    ? q.options.map((o) => `• ${o.label}${o.description ? ` — ${o.description}` : ""}`).join("\n")
    : null;
  return {
    kind: "question",
    title: q.header,
    why: q.prompt,
    risk: "low",
    command: detail, // option descriptions, if any, for the detail box
    options: q.options.map((o) => o.label),
    recommended: null, // AskUserQuestion marks no default
    steps: null,
    diff: null,
  };
}

// Short human label of the chosen answer, for the activity log.
function describeAnswer(q: ParsedQuestion, decision?: Resolution): string {
  if (decision?.action === "option" && decision.optionIndex != null) {
    return q.options[decision.optionIndex]?.label ?? `option ${decision.optionIndex}`;
  }
  if (decision?.action === "modify" && decision.guidance) return decision.guidance;
  if (decision?.action === "reject") return "declined — agent's judgment";
  return "no selection";
}

// The message handed back to the model as the AskUserQuestion result. Frames it
// as the human's answer so the agent continues with the decision made for it.
function answerForQuestion(q: ParsedQuestion, decision?: Resolution): string {
  if (decision?.action === "option" && decision.optionIndex != null) {
    const opt = q.options[decision.optionIndex];
    const label = opt?.label ?? `option ${decision.optionIndex}`;
    return `The human answered your question "${q.header}": ${label}.${opt?.description ? ` (${opt.description})` : ""} Continue with this decision.`;
  }
  if (decision?.action === "modify" && decision.guidance) {
    return `The human answered your question "${q.header}": ${decision.guidance}. Continue with this.`;
  }
  if (decision?.action === "reject") {
    return `The human declined to choose for "${q.header}" — use your best judgment and proceed.`;
  }
  return `The human acknowledged "${q.header}" without a specific choice — use your best judgment and proceed.`;
}

class ClaudeRunnerHandle implements RunnerHandle {
  readonly agentId: string;
  readonly provider: ProviderId = "claude";
  private input = createInputStream();
  private q?: Query; // unset when we couldn't authenticate (see constructor)
  private gate: ((r: PermissionResult) => void) | null = null;
  // Original input of the gated tool call, echoed back on allow (the SDK treats
  // the allow result's `updatedInput` as the input to run — omitting it stalls
  // the session, so we always pass the tool's own input through).
  private gateInput: Record<string, unknown> | null = null;
  private gateTool: string | null = null; // name of the tool awaiting approval
  private gateQuestion: ParsedQuestion | null = null; // set when the gate is an AskUserQuestion
  private lastRationale = ""; // the agent's most recent prose (its stated reasoning)
  private sdkEnv: Record<string, string> = {}; // resolved auth env, reused for side-queries
  private pendingTools = new Map<string, string>(); // tool_use id → tool name, to pair outputs
  private pendingChat = false;
  private progress = 0;
  private plan: PlanStep[] = []; // real steps, from the agent's task-tracking tools
  private planOrder: string[] = []; // task ids in creation order (TaskCreate/Update)
  private planById = new Map<string, PlanStep>();
  private finished = false;
  private hb?: ReturnType<typeof setInterval>;

  constructor(
    private spec: StartSpec,
    private events: RunnerEvents,
    private onSession: (agentId: string, sessionId: string) => void,
    resumeSessionId?: string,
  ) {
    this.agentId = spec.agentId;
    this.events.onStatus(this.agentId, "running");
    this.events.onLog(this.agentId, `picked up "${spec.task}" on ${spec.branch}`);
    this.input.push(
      `You are a Skynet coding agent on branch ${spec.branch} in this repository. ` +
        `Task: ${spec.task}. ` +
        `First decide what the task actually needs: if it's a question, analysis, or research request, just answer it directly — do NOT create or edit files to "record" the answer. ` +
        `Only if it requires code changes, make them and run any relevant checks. Then stop when done. ` +
        `Ask before running destructive or irreversible commands. ` +
        `Be honest when you're blocked: if you cannot reproduce a reported problem, or the task lacks information you'd need to fix it correctly (a stack trace, reproduction steps, failing logs, expected vs actual behavior), do NOT guess or make a speculative edit. Use the AskUserQuestion tool to ask the operator for exactly what you need, or if no answer is possible, report plainly what you could and couldn't determine and stop WITHOUT changing code. Asking for the missing detail is the correct, honest outcome here — a fabricated fix is a failure, not progress.`,
    );

    const canUseTool: CanUseTool = (toolName, input) => {
      if (AUTO_ALLOW.has(toolName)) return Promise.resolve({ behavior: "allow", updatedInput: input });
      // AskUserQuestion is the agent asking the operator a decision — surface it
      // as a `question` HITL with real option buttons, not a generic "approve".
      const question = toolName === "AskUserQuestion" ? parseAskUserQuestion(input) : null;
      return new Promise<PermissionResult>((resolve) => {
        // One gate at a time — the SDK serializes tool calls in a turn.
        // Register the gate BEFORE emitting the event: a synchronous resume
        // (auto-approve policy / fast operator) can re-enter during onHitl, and
        // if the resolver isn't stored yet it would miss the gate → permanent stall.
        this.gate = resolve;
        this.gateInput = input;
        this.gateTool = toolName;
        this.gateQuestion = question;
        this.events.onStatus(this.agentId, "waiting");
        this.events.onHitl(
          this.agentId,
          question ? buildQuestionRaise(question) : this.buildRaise(toolName, input),
        );
      });
    };

    // Auth: authenticate the nested Agent SDK with any accepted credential — a
    // static ANTHROPIC_API_KEY (env or per-workspace, injected as spec.apiKey), a
    // `claude setup-token` subscription token (CLAUDE_CODE_OAUTH_TOKEN), or a
    // gateway bearer token (ANTHROPIC_AUTH_TOKEN). buildRunnerEnv() has already
    // dropped the nested-session markers that would 401 a standalone server, so
    // whatever survives here is usable. Fast-fail with a clear reason rather than
    // spinning up an agent that immediately 401s.
    const env = buildRunnerEnv();
    this.sdkEnv = spec.apiKey ? { ...env, ANTHROPIC_API_KEY: spec.apiKey } : env;
    const authed =
      !!spec.apiKey ||
      !!this.sdkEnv.ANTHROPIC_API_KEY ||
      !!this.sdkEnv.CLAUDE_CODE_OAUTH_TOKEN ||
      !!this.sdkEnv.ANTHROPIC_AUTH_TOKEN;
    if (!authed) {
      this.events.onLog(
        this.agentId,
        "No Claude credential found — set ANTHROPIC_API_KEY, run `claude setup-token` (CLAUDE_CODE_OAUTH_TOKEN), or configure a gateway (ANTHROPIC_AUTH_TOKEN). RUNNER=mock needs no key.",
      );
      this.events.onStatus(this.agentId, "review");
      return; // q stays unset; consume()/heartbeat never start
    }

    const options: Options = {
      cwd: spec.cwd ?? process.cwd(),
      model: mapModel(spec.model),
      permissionMode: "default",
      canUseTool,
      maxTurns: 60,
      // Use Claude Code's default system prompt + full tool suite. Without this a
      // bare query() gives a minimal agent that never loads TodoWrite, so the
      // agent writes plans as prose and the PLAN panel stays empty. The preset
      // makes the agent maintain a real todo list (→ our plan steps) and behave
      // like Claude Code; our canUseTool still gates every mutating tool.
      systemPrompt: { type: "preset", preset: "claude_code" },
      // Scrubbed env (drops the nested-session OAuth path); a per-workspace key
      // (orchestrator-injected) overrides ANTHROPIC_API_KEY for this session only.
      env: this.sdkEnv,
      ...(resumeSessionId ? { resume: resumeSessionId, forkSession: true } : {}),
    };

    this.q = query({ prompt: this.input, options });
    this.hb = setInterval(() => this.events.onHeartbeat(this.agentId), 5_000);
    void this.consume();
  }

  private buildRaise(toolName: string, input: Record<string, unknown>): HitlRaise {
    const command = approvalText(toolName, input);
    return {
      kind: "approval",
      title: `Approve: ${toolName}`,
      why: `Unit requested ${toolName} and is paused for your decision.`,
      risk: "medium",
      command,
      options: null,
      recommended: null,
      steps: null,
      diff: null,
    };
  }

  private bump() {
    // Once the agent maintains a real plan, that drives progress — don't let the
    // synthetic bump fight it. Only used before the first TodoWrite arrives.
    if (this.plan.length) return;
    this.progress = Math.min(0.9, this.progress + 0.08);
    this.events.onProgress(this.agentId, this.progress, [] as PlanStep[]);
  }

  /**
   * Fold a task-tracking tool call into the plan. TodoWrite replaces the whole
   * list; TaskCreate appends one task (ids are SDK-assigned in creation order,
   * so we mirror that with sequential ids); TaskUpdate flips one task's state.
   */
  private applyPlanTool(name: string, input: Record<string, unknown>) {
    if (name === "TodoWrite") {
      const plan = todosToPlan(input);
      if (plan.length) {
        this.plan = plan;
        this.emitPlan();
      }
      return;
    }
    if (name === "TaskCreate") {
      const items = Array.isArray(input.tasks)
        ? (input.tasks as Array<Record<string, unknown>>)
        : [input];
      for (const it of items) {
        const text = String(it.subject || it.title || it.activeForm || it.content || "").trim();
        if (!text) continue;
        const id = String(this.planOrder.length + 1); // SDK numbers tasks 1-based
        this.planOrder.push(id);
        this.planById.set(id, { text, state: "todo" });
      }
    } else if (name === "TaskUpdate") {
      const id = String(input.taskId ?? input.task_id ?? input.id ?? "");
      const step = this.planById.get(id);
      if (step) step.state = taskStatusToState(String(input.status ?? ""));
    }
    this.plan = this.planOrder
      .map((id) => this.planById.get(id))
      .filter((s): s is PlanStep => !!s);
    if (this.plan.length) this.emitPlan();
  }

  /** Recompute progress from the real plan (done/total) and push it + the plan. */
  private emitPlan() {
    const done = this.plan.filter((p) => p.state === "done").length;
    // Keep it shy of 1 until finish() flips the agent to done.
    this.progress = Math.min(0.99, this.plan.length ? done / this.plan.length : this.progress);
    this.events.onProgress(this.agentId, this.progress, this.plan);
  }

  /** Read exact token/cost totals off the SDK `result` message and report them. */
  private emitUsage(result: Record<string, unknown>) {
    const u = (result.usage ?? {}) as Record<string, unknown>;
    const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const input =
      n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens);
    const cost = typeof result.total_cost_usd === "number" ? result.total_cost_usd : null;
    const durationMs = typeof result.duration_ms === "number" ? result.duration_ms : null;
    this.events.onUsage?.(this.agentId, {
      inputTokens: input,
      outputTokens: n(u.output_tokens),
      costUsd: cost,
      turns: n(result.num_turns),
      durationMs,
    });
  }

  private async consume() {
    if (!this.q) return;
    let terminal: SDKResultMessage | null = null;
    try {
      for await (const msg of this.q as AsyncIterable<SDKMessage>) {
        if (this.finished) break;
        if (msg.type === "system" && "session_id" in msg && typeof msg.session_id === "string") {
          this.onSession(this.agentId, msg.session_id);
        } else if (msg.type === "assistant") {
          const { text, tools } = readAssistant((msg as { message: { content?: unknown } }).message);
          if (text) {
            if (this.pendingChat) { this.pendingChat = false; this.events.onChatReply(this.agentId, text); }
            else { this.lastRationale = text; this.events.onLog(this.agentId, text); }
          }
          for (const t of tools) {
            if (t.id) this.pendingTools.set(t.id, t.name);
            // The agent's task-tracking tools are its plan — feed them to the PLAN
            // panel + progress instead of logging them as tool lines / bumping the
            // synthetic bar.
            if (PLAN_TOOLS.has(t.name)) {
              this.applyPlanTool(t.name, t.input);
              continue;
            }
            // Log line carries the call's full input as expandable detail.
            this.events.onLog(this.agentId, `▸ ${describeTool(t.name, t.input)}`, approvalText(t.name, t.input));
            this.bump();
          }
        } else if (msg.type === "user") {
          // Tool results come back as a user message; surface each tool's output
          // as an expandable ↳ entry paired (by id) with the call above.
          const mm = (msg as unknown as { message?: { content?: unknown } }).message;
          const blocks: Array<Record<string, unknown>> = Array.isArray(mm?.content)
            ? (mm!.content as Array<Record<string, unknown>>)
            : [];
          for (const b of blocks) {
            if (b.type !== "tool_result") continue;
            const id = typeof b.tool_use_id === "string" ? b.tool_use_id : "";
            const name = (id && this.pendingTools.get(id)) || "tool";
            if (id) this.pendingTools.delete(id);
            const out = toolResultText(b.content);
            this.events.onLog(this.agentId, `↳ ${name}${b.is_error ? " failed" : ""}`, clip(out, 6000) || "(no output)");
          }
        } else if (msg.type === "result") {
          this.emitUsage(msg as Record<string, unknown>);
          terminal = msg;
          break;
        }
      }
    } catch (err) {
      // The query crashed (auth, network, SDK) — this is a FAILURE, not a
      // completion. Surface it; never report the agent as done with no work.
      this.fail((err as Error).message);
      return;
    }
    // A clean turn ends with a *success* result. An error result (e.g. an API
    // overload / 529 during execution, max-turns, budget) or a stream that ended
    // with no result at all is a FAILURE — never report the agent done with no
    // real work, which would read as a silent, dishonest success.
    if (this.finished) return; // already stopped or failed
    if (!terminal) return this.fail("runner ended without a result");
    if (terminal.is_error || terminal.subtype !== "success") {
      return this.fail(resultErrorReason(terminal));
    }
    this.finish();
  }

  /** Could-not-run path: mark needs-attention, never onCompleted. */
  private fail(reason: string) {
    if (this.finished) return;
    this.finished = true;
    if (this.hb) clearInterval(this.hb);
    this.events.onFailed(this.agentId, reason);
    this.input.close();
  }

  private finish() {
    if (this.finished) return;
    this.finished = true;
    if (this.hb) clearInterval(this.hb);
    // Keep the real plan visible on completion (all steps done), rather than
    // blanking it — the PLAN panel stays meaningful for a finished agent.
    const donePlan = this.plan.map((p) => ({ ...p, state: "done" as const }));
    this.events.onProgress(this.agentId, 1, donePlan);
    this.events.onStatus(this.agentId, "done");
    this.events.onCompleted(this.agentId, this.spec.branch);
    this.input.close();
  }

  async pause() {
    this.events.onStatus(this.agentId, "waiting");
  }

  async resume(decision?: Resolution) {
    if (this.gate) {
      const gate = this.gate;
      const input = this.gateInput ?? {};
      const question = this.gateQuestion;
      this.gate = null;
      this.gateInput = null;
      this.gateTool = null;
      this.gateQuestion = null;
      this.events.onStatus(this.agentId, "running");
      // AskUserQuestion: there's no interactive frontend to render the picker, so
      // we never actually run the tool — we deny it and hand the operator's answer
      // back as the tool's result message, which the model reads and continues on.
      if (question) {
        gate({ behavior: "deny", message: answerForQuestion(question, decision) });
        this.events.onLog(this.agentId, `↳ answered "${question.header}": ${describeAnswer(question, decision)}`);
      } else if (decision?.action === "reject") {
        gate({ behavior: "deny", message: "Operator rejected this action — revise your approach." });
      } else if (decision?.action === "modify") {
        gate({ behavior: "deny", message: decision.guidance ?? "Adjust per operator guidance." });
      } else {
        // Echo the tool's own input as `updatedInput` — required for the SDK to
        // actually run the approved tool (omitting it stalls the session).
        gate({ behavior: "allow", updatedInput: input });
      }
    } else if (decision?.guidance) {
      this.input.push(decision.guidance);
    }
  }

  async message(text: string) {
    // While a permission gate is open the SDK turn is parked inside canUseTool —
    // it won't read a new user message until the gate is resolved. So to let the
    // operator ask about the pending action, answer via a separate one-shot
    // side-query seeded with the gate context, instead of the frozen session.
    if (this.gate) {
      void this.consultAboutGate(text);
      return;
    }
    // After the agent has finished, its main session is closed — answer
    // follow-up questions ("what did you do?") via a fresh side-query seeded
    // with the task and the agent's final summary.
    if (this.finished) {
      void this.consultAboutWork(text);
      return;
    }
    this.pendingChat = true;
    this.input.push(text);
  }

  /**
   * Answer an operator's question about the action awaiting approval, using a
   * fresh non-agentic query (no tools) seeded with the task, the pending tool +
   * its input, and the agent's stated reasoning. Runs alongside the frozen main
   * session; never touches it.
   */
  private consultAboutGate(question: string): Promise<void> {
    const prompt =
      "You are helping a human operator decide whether to approve an action that an AI coding agent wants to take. " +
      "Answer the operator's question directly and concisely. Do NOT use any tools — just explain.\n\n" +
      `Agent's task: ${this.spec.task}\n` +
      `Working directory: ${this.spec.cwd ?? process.cwd()}\n` +
      (this.lastRationale ? `Agent's stated reasoning: ${this.lastRationale}\n` : "") +
      `Pending action: ${this.gateTool ?? "tool"} with input:\n${JSON.stringify(this.gateInput ?? {}, null, 2)}\n\n` +
      `Operator's question: ${question}`;
    return this.runConsult(
      prompt,
      "I'm paused on the command above — Approve to run it, Reject to skip, or Modify to redirect me.",
    );
  }

  /**
   * Answer a follow-up about already-finished work. The main session is closed,
   * so this is a fresh non-agentic query seeded with the task and the agent's
   * final summary — lets the operator ask "what did you do?" after completion.
   */
  private consultAboutWork(question: string): Promise<void> {
    const prompt =
      "You are an AI coding agent that has FINISHED a task. Answer the operator's follow-up question " +
      "directly and concisely, based on what you did. Do NOT use any tools — just explain.\n\n" +
      `Task: ${this.spec.task}\n` +
      `Working directory: ${this.spec.cwd ?? process.cwd()}\n` +
      `Branch: ${this.spec.branch}\n` +
      (this.lastRationale ? `Your final summary/answer was:\n${this.lastRationale}\n` : "") +
      `\nOperator's question: ${question}`;
    return this.runConsult(prompt, "The task is complete — ask me anything about what I did.");
  }

  /** Run a one-shot, tool-less query and emit its text as a chat reply. */
  private async runConsult(prompt: string, fallback: string): Promise<void> {
    const answer = await oneShotConsult({
      prompt,
      cwd: this.spec.cwd ?? process.cwd(),
      model: this.spec.model,
      env: this.sdkEnv,
      fallback,
    });
    this.events.onChatReply(this.agentId, answer);
  }

  async stop() {
    this.finished = true;
    if (this.hb) clearInterval(this.hb);
    await this.q?.interrupt().catch(() => undefined);
    this.input.close();
  }
}

export class ClaudeRunnerProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  // agentId → SDK session id, so a fork can resume a parent's context.
  private sessions = new Map<string, string>();

  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    const resumeSessionId = spec.parentId ? this.sessions.get(spec.parentId) : undefined;
    return new ClaudeRunnerHandle(
      spec,
      events,
      (agentId, sessionId) => this.sessions.set(agentId, sessionId),
      resumeSessionId,
    );
  }

  /** Answer a follow-up about a finished agent with no live handle (e.g. after a
   *  server restart) — a fresh tool-less query grounded in the agent's state. */
  async consult(spec: ConsultSpec, question: string): Promise<string> {
    const base = buildRunnerEnv();
    const env = spec.apiKey ? { ...base, ANTHROPIC_API_KEY: spec.apiKey } : base;
    const prompt =
      "You are an AI coding agent that has FINISHED a task. Answer the operator's follow-up " +
      "question directly and concisely, based on what you did. Do NOT use any tools — just explain.\n\n" +
      `Task: ${spec.task}\n` +
      (spec.context ? `What you did (your log / final answer):\n${spec.context}\n` : "") +
      `\nOperator's question: ${question}`;
    return oneShotConsult({
      prompt,
      cwd: spec.cwd ?? process.cwd(),
      model: spec.model,
      env,
      fallback: "The task is complete — ask me anything about what I did.",
    });
  }
}
