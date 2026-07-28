// ─── Cursor runner (W2c) ──────────────────────────────────────────────────
// A real RunnerProvider backed by the `cursor-agent` CLI (Cursor's headless
// coding agent). It validates the runner-sdk control contract against a second
// vendor: a streaming NDJSON session, tool executions surfaced as log/progress,
// the CLI's command-approval gate mapped to a HITL `approval` item, and chat /
// decisions injected back into the live session over stdin.
//
//   cursor-agent -p --output-format stream-json --model <m> "<task>"
//
// Selected via RUNNER=cursor; Core wires orchestrator.getProvider(). The default
// RUNNER=mock path never imports this file.
//
// Auth: cursor-agent needs CURSOR_API_KEY (or a signed-in CLI). When the binary
// is missing or unauthenticated the runner degrades cleanly — it surfaces the
// reason and completes, so the orchestrator lifecycle never hangs.

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { PlanStep, ProviderId, Resolution } from "@skynet/shared";
import { usageFromJson } from "./cli-runner.js";
import type {
  HitlRaise,
  RunnerEvents,
  RunnerHandle,
  RunnerProvider,
  StartSpec,
} from "./types.js";

const CURSOR_BIN = process.env.SKYNET_CURSOR_BIN || "cursor-agent";

// cursor-agent takes model slugs like `sonnet-4`, `sonnet-4-thinking`, `gpt-5`.
// Our fleet model strings already use those slugs, so pass through; only drop a
// blank so the CLI falls back to its configured default.
const mapModel = (m: string): string | undefined => (m.trim() ? m.trim() : undefined);

// Tool/command events whose names we treat as read-only — logged but never gated.
const READ_ONLY = new Set(["read", "ls", "glob", "grep", "search", "list", "read_file"]);

// Heuristic: does a parsed stream event represent the agent blocking on a human?
// cursor-agent surfaces command approvals as a tool_call awaiting confirmation;
// we match defensively across the field names the CLI has used across versions.
function approvalOf(ev: Record<string, unknown>): { command: string } | null {
  const type = String(ev.type ?? "");
  const subtype = String(ev.subtype ?? ev.status ?? "");
  const looksLikeGate =
    type === "permission" ||
    type === "approval" ||
    /approval|permission|confirm|awaiting/i.test(subtype) ||
    ev.approval_required === true ||
    ev.needs_approval === true;
  if (!looksLikeGate) return null;
  const raw =
    (typeof ev.command === "string" && ev.command) ||
    (isRecord(ev.input) && typeof ev.input.command === "string" && ev.input.command) ||
    (isRecord(ev.tool_call) && typeof ev.tool_call.command === "string" && ev.tool_call.command) ||
    "";
  return { command: raw || JSON.stringify(ev) };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

// Pull display text + tool-call names out of an assistant message's content blocks.
function readAssistant(message: unknown): { text: string; tools: string[] } {
  const content = isRecord(message) ? message.content : undefined;
  const blocks = Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
  let text = "";
  const tools: string[] = [];
  for (const b of blocks) {
    if (b.type === "text" && typeof b.text === "string") text += b.text;
    else if (b.type === "tool_use" && typeof b.name === "string") tools.push(b.name);
  }
  return { text: text.trim(), tools };
}

class CursorRunnerHandle implements RunnerHandle {
  readonly runId: string;
  readonly provider: ProviderId = "cursor";
  private child?: ChildProcess;
  private reader?: Interface;
  private progress = 0;
  private finished = false;
  private pendingChat = false;
  /** Set while the agent is blocked on a command-approval gate. */
  private gateCommand: string | null = null;
  private hb?: ReturnType<typeof setInterval>;

  constructor(
    private spec: StartSpec,
    private events: RunnerEvents,
    private onSession: (runId: string, chatId: string) => void,
    private resumeChatId?: string,
  ) {
    this.runId = spec.runId;
    this.events.onStatus(this.runId, "running");
    this.events.onLog(this.runId, `picked up "${spec.task}" on ${spec.branch}`);
    this.hb = setInterval(() => this.events.onHeartbeat(this.runId), 5_000);
    this.spawnTurn(this.initialPrompt(), true);
  }

  private initialPrompt(): string {
    return (
      `You are a Skynet coding agent on branch ${this.spec.branch} in this repository. ` +
      `Task: ${this.spec.task}. ` +
      `First decide what the task actually needs: if it's a question, analysis, or research request, just answer it directly — do NOT create or edit files to "record" the answer. ` +
      `Only if it requires code changes, make them and run any relevant checks. Then stop when done. ` +
      `Make code changes ONLY — do NOT run git commit, git push, or gh pr, and do NOT ask the operator whether to commit, push, or open a PR. Skynet owns that: when you finish it auto-commits your worktree, then gates the push and PR behind a separate review/approval step it controls. So never say you "didn't commit" or ask "should I open a PR?" — leave version control entirely to Skynet. Your "done" message should simply summarize what you changed and why, nothing about committing, pushing, or PRs. ` +
      `Ask before running destructive or irreversible commands. ` +
      `Be honest when you're blocked: if you cannot reproduce a reported problem, or the task lacks information you'd need to fix it correctly (a stack trace, reproduction steps, failing logs, expected vs actual behavior), do NOT guess or make a speculative edit. Report plainly what you could and couldn't determine and state exactly what you need to proceed, then stop WITHOUT changing code. Making no change and asking for the missing detail is the correct, honest outcome — a fabricated fix is a failure, not progress.`
    );
  }

  /** Launch one cursor-agent turn. `primary` turns drive the task to completion. */
  private spawnTurn(prompt: string, primary: boolean) {
    const model = mapModel(this.spec.model);
    // `-f` (force) also satisfies cursor-agent's "Workspace Trust" gate: in a
    // fresh per-agent worktree, headless `-p` mode otherwise blocks forever on an
    // interactive trust prompt it can't answer. The operator's gate is preserved
    // by Skynet's own post-run diff review before anything merges.
    const args = ["-p", "--output-format", "stream-json", "--force"];
    if (model) args.push("--model", model);
    // Continue the parent/own chat when we have an id (fork or follow-up turn).
    if (this.resumeChatId) args.push("--resume", this.resumeChatId);
    args.push(prompt);

    let child: ChildProcess;
    try {
      child = spawn(CURSOR_BIN, args, {
        cwd: this.spec.cwd ?? process.cwd(),
        // Per-workspace key (orchestrator-injected) overrides ambient env.
        env: this.spec.apiKey ? { ...process.env, CURSOR_API_KEY: this.spec.apiKey } : process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      this.degrade(`cursor-agent failed to launch: ${(err as Error).message}`, primary);
      return;
    }
    this.child = child;

    // ENOENT (binary not installed) and other spawn errors land here.
    child.on("error", (err) => {
      const reason =
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? `cursor-agent not found on PATH (set SKYNET_CURSOR_BIN or install the Cursor CLI)`
          : `cursor-agent error: ${err.message}`;
      this.degrade(reason, primary);
    });

    let sawAuthError = false;
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        if (/sign in|unauthor|api[- ]?key|401|forbidden/i.test(chunk)) sawAuthError = true;
        const line = chunk.trim();
        if (line) this.events.onLog(this.runId, `[cursor] ${line}`);
      });
    }

    if (child.stdout) {
      this.reader = createInterface({ input: child.stdout });
      this.reader.on("line", (line) => this.onLine(line, primary));
    }

    child.on("close", (code) => {
      this.reader?.close();
      if (this.finished) return;
      if (sawAuthError || (code !== 0 && this.progress === 0)) {
        this.degrade(
          sawAuthError
            ? `cursor-agent is not authenticated — set CURSOR_API_KEY to run live`
            : `cursor-agent exited with code ${code} before producing output`,
          primary,
        );
        return;
      }
      // A non-primary (chat/decision) turn finished — leave the agent running.
      // Don't complete while a HITL gate is pending: a one-shot print turn exits
      // right after emitting the approval prompt; the follow-up turn that resume()
      // spawns is what actually drives the task to completion.
      if (primary && !this.gateCommand) this.finish();
    });
  }

  private onLine(line: string, primary: boolean) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let ev: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) ev = parsed;
    } catch {
      // Non-JSON output (banners, partial text) — surface verbatim.
      this.events.onLog(this.runId, trimmed);
      return;
    }
    if (!ev) return;

    const type = String(ev.type ?? "");

    // Capture the chat/session id so a fork can --resume the parent's context.
    if (type === "system") {
      const id =
        (typeof ev.session_id === "string" && ev.session_id) ||
        (typeof ev.chat_id === "string" && ev.chat_id) ||
        (typeof ev.chatId === "string" && ev.chatId) ||
        "";
      if (id) {
        this.resumeChatId = id;
        this.onSession(this.runId, id);
      }
      return;
    }

    // Command-approval gate → HITL. Only meaningful on the primary task turn.
    const gate = approvalOf(ev);
    if (gate && primary && !this.gateCommand) {
      this.raiseGate(gate.command);
      return;
    }

    if (type === "assistant") {
      const { text, tools } = readAssistant(ev.message);
      if (text) {
        if (this.pendingChat) {
          this.pendingChat = false;
          this.events.onChatReply(this.runId, text);
        } else {
          this.events.onLog(this.runId, text);
        }
      }
      for (const t of tools) {
        this.events.onLog(this.runId, `▸ ${t}`);
        if (!READ_ONLY.has(t.toLowerCase())) this.bump();
      }
      return;
    }

    if (type === "tool_call") {
      const name =
        (typeof ev.name === "string" && ev.name) ||
        (isRecord(ev.tool_call) && typeof ev.tool_call.name === "string" && ev.tool_call.name) ||
        "tool";
      this.events.onLog(this.runId, `▸ ${name}`);
      if (!READ_ONLY.has(name.toLowerCase())) this.bump();
      return;
    }

    // The stream carries token/cost totals on the final `result` (and sometimes
    // interim usage/metadata events) — report best-effort when present.
    if (type === "result" || /usage|metadata/i.test(type)) {
      const usage = usageFromJson((isRecord(ev.usage) ? ev.usage : ev) as Record<string, unknown>);
      if (usage) this.events.onUsage?.(this.runId, usage);
    }

    if (type === "result") {
      if (primary && !this.gateCommand) this.finish();
    }
  }

  private raiseGate(command: string) {
    this.gateCommand = command;
    this.events.onStatus(this.runId, "waiting");
    this.events.onHitl(this.runId, this.buildRaise(command));
  }

  private buildRaise(command: string): HitlRaise {
    return {
      kind: "approval",
      title: `Approve: ${command.split("\n")[0]?.slice(0, 80) ?? "command"}`,
      why: "Cursor unit wants to run a command and is paused for your decision.",
      risk: "medium",
      command,
      options: null,
      recommended: null,
      rationale: null,
      steps: null,
      diff: null,
    };
  }

  private bump() {
    this.progress = Math.min(0.9, this.progress + 0.08);
    this.events.onProgress(this.runId, this.progress, [] as PlanStep[]);
  }

  async pause() {
    // cursor-agent has no external pause; reflect intent in status (mirrors claude).
    this.events.onStatus(this.runId, "waiting");
  }

  async resume(decision?: Resolution) {
    // Answering a pending command-approval gate.
    if (this.gateCommand) {
      const command = this.gateCommand;
      this.gateCommand = null;
      this.events.onStatus(this.runId, "running");
      // print-mode turns are one-shot, so we deliver the decision as a follow-up
      // turn that continues the same chat (--resume), plus a best-effort stdin
      // answer in case this build blocks the live process awaiting input.
      let followUp: string;
      if (decision?.action === "reject") {
        followUp = `Do not run \`${command}\`. The operator rejected it — revise your approach.`;
        this.writeStdin("n");
      } else if (decision?.action === "modify") {
        followUp = decision.guidance?.trim()
          ? `Adjust per operator guidance: ${decision.guidance.trim()}`
          : `Adjust your approach before running \`${command}\`.`;
        this.writeStdin("n");
      } else {
        followUp = `Approved — proceed with \`${command}\`.`;
        this.writeStdin("y");
      }
      this.events.onLog(this.runId, `decision: ${decision?.action ?? "approve"}`);
      if (!this.childAlive()) this.spawnTurn(followUp, true);
      return;
    }
    // No gate pending: a bare modify/guidance becomes a steering turn.
    if (decision?.guidance?.trim()) {
      this.spawnTurn(decision.guidance.trim(), false);
    }
  }

  async message(text: string) {
    // Discuss without resolving: continue the chat and route the reply to chat.
    this.pendingChat = true;
    if (this.childAlive()) {
      // Live process — try injecting; otherwise a resumed turn carries the text.
      this.writeStdin(text);
    } else {
      this.spawnTurn(text, false);
    }
  }

  async stop() {
    this.finished = true;
    if (this.hb) clearInterval(this.hb);
    this.reader?.close();
    this.killChild();
  }

  private finish() {
    if (this.finished) return;
    this.finished = true;
    if (this.hb) clearInterval(this.hb);
    this.events.onProgress(this.runId, 1, [] as PlanStep[]);
    // The orchestrator owns the terminal "done" (after committing the worktree →
    // review → merge). Emitting it here would race integration and surface a
    // premature "done" with uncommitted work — hand off via onCompleted only.
    this.events.onCompleted(this.runId, this.spec.branch);
    this.killChild();
  }

  /** Live execution is unavailable — surface it as a FAILURE, not a completion. */
  private degrade(reason: string, primary: boolean) {
    if (this.finished || !primary) return;
    this.finished = true;
    if (this.hb) clearInterval(this.hb);
    this.events.onFailed(this.runId, `cursor runner unavailable — ${reason}`);
    this.killChild();
  }

  private childAlive(): boolean {
    return !!this.child && this.child.exitCode === null && !this.child.killed;
  }

  private writeStdin(text: string) {
    if (this.child?.stdin?.writable) {
      this.child.stdin.write(text.endsWith("\n") ? text : `${text}\n`);
    }
  }

  private killChild() {
    if (this.child && this.child.exitCode === null && !this.child.killed) {
      this.child.kill("SIGTERM");
    }
  }
}

export class CursorRunnerProvider implements RunnerProvider {
  readonly id: ProviderId = "cursor";
  // runId → cursor chat id, so a fork can resume its parent's context.
  private chats = new Map<string, string>();

  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    const resumeChatId = spec.parentId ? this.chats.get(spec.parentId) : undefined;
    return new CursorRunnerHandle(
      spec,
      events,
      (runId, chatId) => this.chats.set(runId, chatId),
      resumeChatId,
    );
  }
}
