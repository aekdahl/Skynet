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
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { PlanStep, ProviderId, Resolution } from "@skynet/shared";
import type {
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
// OAuth — a standalone server can't satisfy that path and would 401. When an
// ANTHROPIC_API_KEY is present we also drop the inherited gateway
// ANTHROPIC_BASE_URL and any ANTHROPIC_AUTH_TOKEN so the key isn't shadowed.
function buildRunnerEnv(): Record<string, string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null) continue;
    if (k.startsWith("CLAUDE_CODE_")) continue; // nested child-session markers
    if (apiKey && (k === "ANTHROPIC_BASE_URL" || k === "ANTHROPIC_AUTH_TOKEN")) continue;
    env[k] = v;
  }
  return env;
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
  private lastRationale = ""; // the agent's most recent prose (its stated reasoning)
  private sdkEnv: Record<string, string> = {}; // resolved auth env, reused for side-queries
  private pendingTools = new Map<string, string>(); // tool_use id → tool name, to pair outputs
  private pendingChat = false;
  private progress = 0;
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
        `Ask before running destructive or irreversible commands.`,
    );

    const canUseTool: CanUseTool = (toolName, input) => {
      if (AUTO_ALLOW.has(toolName)) return Promise.resolve({ behavior: "allow", updatedInput: input });
      return new Promise<PermissionResult>((resolve) => {
        // One gate at a time — the SDK serializes tool calls in a turn.
        // Register the gate BEFORE emitting the event: a synchronous resume
        // (auto-approve policy / fast operator) can re-enter during onHitl, and
        // if the resolver isn't stored yet it would miss the gate → permanent stall.
        this.gate = resolve;
        this.gateInput = input;
        this.gateTool = toolName;
        this.events.onStatus(this.agentId, "waiting");
        this.events.onHitl(this.agentId, this.buildRaise(toolName, input));
      });
    };

    // Auth: a self-hosted server authenticates the nested Agent SDK with a
    // static ANTHROPIC_API_KEY. Without one we'd inherit this process's env —
    // which, when Skynet itself runs under Claude Code, carries CLAUDE_CODE_*
    // child-session markers + a gateway ANTHROPIC_BASE_URL that expect a host to
    // refresh a short-lived OAuth token over the control channel. A standalone
    // server has no such host, so those credentials 401. Fast-fail with a clear
    // reason instead of spinning up an agent that immediately 401s.
    const env = buildRunnerEnv();
    this.sdkEnv = spec.apiKey ? { ...env, ANTHROPIC_API_KEY: spec.apiKey } : env;
    if (!env.ANTHROPIC_API_KEY && !spec.apiKey) {
      this.events.onLog(
        this.agentId,
        "ANTHROPIC_API_KEY is not set — the Claude runner cannot authenticate (set it to enable live runs; RUNNER=mock needs no key).",
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
    this.progress = Math.min(0.9, this.progress + 0.08);
    this.events.onProgress(this.agentId, this.progress, [] as PlanStep[]);
  }

  private async consume() {
    if (!this.q) return;
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
          break;
        }
      }
    } catch (err) {
      // The query crashed (auth, network, SDK) — this is a FAILURE, not a
      // completion. Surface it; never report the agent as done with no work.
      this.fail((err as Error).message);
      return;
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
    this.events.onProgress(this.agentId, 1, [] as PlanStep[]);
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
      this.gate = null;
      this.gateInput = null;
      this.gateTool = null;
      this.events.onStatus(this.agentId, "running");
      if (decision?.action === "reject") {
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
    this.pendingChat = true;
    this.input.push(text);
  }

  /**
   * Answer an operator's question about the action awaiting approval, using a
   * fresh non-agentic query (no tools) seeded with the task, the pending tool +
   * its input, and the agent's stated reasoning. Runs alongside the frozen main
   * session; never touches it.
   */
  private async consultAboutGate(question: string): Promise<void> {
    const prompt =
      "You are helping a human operator decide whether to approve an action that an AI coding agent wants to take. " +
      "Answer the operator's question directly and concisely. Do NOT use any tools — just explain.\n\n" +
      `Agent's task: ${this.spec.task}\n` +
      `Working directory: ${this.spec.cwd ?? process.cwd()}\n` +
      (this.lastRationale ? `Agent's stated reasoning: ${this.lastRationale}\n` : "") +
      `Pending action: ${this.gateTool ?? "tool"} with input:\n${JSON.stringify(this.gateInput ?? {}, null, 2)}\n\n` +
      `Operator's question: ${question}`;
    try {
      const q = query({
        prompt,
        options: {
          cwd: this.spec.cwd ?? process.cwd(),
          model: mapModel(this.spec.model),
          permissionMode: "default",
          // Deny every tool so this stays a pure text answer about the pending action.
          canUseTool: () => Promise.resolve({ behavior: "deny", message: "Answer in text only; do not use tools." } as PermissionResult),
          maxTurns: 4,
          env: this.sdkEnv,
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
      this.events.onChatReply(
        this.agentId,
        answer.trim() ||
          "I'm paused on the command above — Approve to run it, Reject to skip, or Modify to redirect me.",
      );
    } catch (err) {
      this.events.onChatReply(this.agentId, `couldn't look into that right now (${(err as Error).message}).`);
    }
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
}
