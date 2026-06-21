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
  m.startsWith("opus") ? "opus" : m.startsWith("sonnet") ? "sonnet" : m.startsWith("haiku") ? "haiku" : undefined;

// Extract text + tool names from an assistant message's content blocks.
function readAssistant(message: { content?: unknown }): { text: string; tools: string[] } {
  const blocks = Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : [];
  let text = "";
  const tools: string[] = [];
  for (const b of blocks) {
    if (b.type === "text" && typeof b.text === "string") text += b.text;
    else if (b.type === "tool_use" && typeof b.name === "string") tools.push(b.name);
  }
  return { text: text.trim(), tools };
}

class ClaudeRunnerHandle implements RunnerHandle {
  readonly agentId: string;
  readonly provider: ProviderId = "claude";
  private input = createInputStream();
  private q: Query;
  private gate: ((r: PermissionResult) => void) | null = null;
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
      `You are a Skynet unit working in this repository on branch ${spec.branch}. ` +
        `Task: ${spec.task}. Make the change, run any relevant checks, then stop when done. ` +
        `Ask before running destructive or irreversible commands.`,
    );

    const canUseTool: CanUseTool = (toolName, input) => {
      if (AUTO_ALLOW.has(toolName)) return Promise.resolve({ behavior: "allow" } as PermissionResult);
      return new Promise<PermissionResult>((resolve) => {
        // One gate at a time — the SDK serializes tool calls in a turn.
        this.events.onStatus(this.agentId, "waiting");
        this.events.onHitl(this.agentId, this.buildRaise(toolName, input));
        this.gate = resolve;
      });
    };

    const options: Options = {
      cwd: spec.cwd ?? process.cwd(),
      model: mapModel(spec.model),
      permissionMode: "default",
      canUseTool,
      maxTurns: 60,
      ...(resumeSessionId ? { resume: resumeSessionId, forkSession: true } : {}),
    };

    this.q = query({ prompt: this.input, options });
    this.hb = setInterval(() => this.events.onHeartbeat(this.agentId), 5_000);
    void this.consume();
  }

  private buildRaise(toolName: string, input: Record<string, unknown>): HitlRaise {
    const command = typeof input.command === "string" ? input.command : JSON.stringify(input);
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
    try {
      for await (const msg of this.q as AsyncIterable<SDKMessage>) {
        if (this.finished) break;
        if (msg.type === "system" && "session_id" in msg && typeof msg.session_id === "string") {
          this.onSession(this.agentId, msg.session_id);
        } else if (msg.type === "assistant") {
          const { text, tools } = readAssistant((msg as { message: { content?: unknown } }).message);
          if (text) {
            if (this.pendingChat) { this.pendingChat = false; this.events.onChatReply(this.agentId, text); }
            else this.events.onLog(this.agentId, text);
          }
          for (const t of tools) { this.events.onLog(this.agentId, `▸ ${t}`); this.bump(); }
        } else if (msg.type === "result") {
          break;
        }
      }
    } catch (err) {
      this.events.onLog(this.agentId, `runner error: ${(err as Error).message}`);
    }
    this.finish();
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
      this.gate = null;
      this.events.onStatus(this.agentId, "running");
      if (decision?.action === "reject") {
        gate({ behavior: "deny", message: "Operator rejected this action — revise your approach." });
      } else if (decision?.action === "modify") {
        gate({ behavior: "deny", message: decision.guidance ?? "Adjust per operator guidance." });
      } else {
        gate({ behavior: "allow" });
      }
    } else if (decision?.guidance) {
      this.input.push(decision.guidance);
    }
  }

  async message(text: string) {
    this.pendingChat = true;
    this.input.push(text);
  }

  async stop() {
    this.finished = true;
    if (this.hb) clearInterval(this.hb);
    await this.q.interrupt().catch(() => undefined);
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
