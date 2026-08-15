// ─── Copilot runner (W2d) ─────────────────────────────────────────────────
// A real RunnerProvider backed by the GitHub Copilot CLI (`copilot`, the
// `@github/copilot` programmatic agent). Same control contract as the other
// runners: a streamed task session surfaced as log/progress, a permission
// denial mapped to a HITL `approval` item, and chat/decisions delivered back
// to the live session.
//
//   copilot -p "<task>" --model <m> --output-format json --session-id <id>
//
// `--output-format json` (confirmed live against copilot 1.0.80 — see the
// event notes below) streams one JSON object per line instead of the
// human-readable text this runner used to regex-parse. That's a real
// protocol switch, not just an extra flag:
//
//   - There is NO interactive approval prompt in this mode. A non-interactive
//     `-p` invocation has no stdin-driven approval channel at all, so the CLI
//     never even emits a `permission.requested` event here — a tool needing
//     permission is auto-denied immediately as a normal (if unsuccessful)
//     tool result: `tool.execution_complete` with
//     `success:false, error:{code:"denied", message:"Permission denied and
//     could not request permission from user"}`. Read-only tool calls (a
//     plain `echo`, a file read) need no permission at all and just run.
//     Verified live: a bare shell `echo` executed with zero gating, while
//     asking the agent to create a file was silently denied twice (the
//     `create` tool, then a `bash > file` fallback) before it gave its own
//     honest "couldn't write, permission denied" answer — all inside ONE
//     continuous turn, no external stimulus.
//   - So the approval gate here is keyed off that denial, not a
//     `permission.requested` event: Skynet raises the HITL the CLI itself
//     couldn't. There's no way to un-deny the exact call that already
//     failed, so approving replays the SAME action as a fresh follow-up turn
//     with that one tool's permission explicitly granted via `--allow-tool`
//     (scoped to the specific command/path where the CLI's own permission
//     grammar allows it — see `allowToolFlag` — not a blanket
//     `--allow-all-tools`).
//   - `assistant.message` events carry a real `outputTokens` count per
//     message; the terminal `result` line (NOT wrapped in the usual
//     `{id,timestamp,parentId,type,data}` envelope every other event uses —
//     it's the CLI's one-shot exec summary, not a session event) carries
//     `usage.totalApiDurationMs`/`sessionDurationMs`. There is no
//     input-token count anywhere in this protocol and no USD cost (Copilot
//     meters "premium requests"/AI credits, a genuinely different billing
//     model) — see `buildUsage` below for why this intentionally doesn't
//     round-trip through the shared `usageFromJson` scanner.
//
// Selected via RUNNER=copilot; Core wires orchestrator.getProvider(). The
// default RUNNER=mock path never imports this file.
//
// Auth: the Copilot CLI needs a signed-in `gh`/Copilot subscription (or
// GH_TOKEN). When the binary is missing or unauthenticated the runner degrades
// cleanly — it surfaces the reason and completes, so the lifecycle never hangs.

import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { PlanStep, ProviderId, Resolution, Usage } from "@skynet/shared";
import type {
  HitlRaise,
  RunnerEvents,
  RunnerHandle,
  RunnerProvider,
  StartSpec,
} from "./types.js";

const COPILOT_BIN = process.env.SKYNET_COPILOT_BIN || "copilot";

const mapModel = (m: string): string | undefined => (m.trim() ? m.trim() : undefined);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

// Built-in tool names observed in `tool.execution_start.toolName` (live
// capture) that this runner treats as "shell" / "write" kinds for the
// `--allow-tool` permission grammar (`copilot help permissions`). An unknown
// tool name falls back to its bare name, which matches how the grammar
// addresses an MCP or custom tool.
const SHELL_TOOLS = new Set(["bash", "shell", "powershell", "local_shell"]);
const WRITE_TOOLS = new Set(["create", "write", "edit", "str_replace", "patch", "apply_patch"]);

/** A human-readable one-liner for a tool call — used for both the log line
 *  bumped on `tool.execution_start` and the HITL gate's `command` text. */
function describeTool(name: string, args: Record<string, unknown>): string {
  if (typeof args.command === "string") return args.command;
  if (typeof args.path === "string") return `${name} ${args.path}`;
  if (typeof args.description === "string") return args.description;
  const keys = Object.keys(args);
  return keys.length ? `${name}(${keys.join(", ")})` : name;
}

/** The tightest `--allow-tool` pattern this runner can build for a denied
 *  call, so an approval grants permission for that one command/path on the
 *  retry turn rather than every tool for the rest of the session. */
function allowToolFlag(name: string, args: Record<string, unknown>): string {
  if (SHELL_TOOLS.has(name)) {
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    const first = cmd.split(/\s+/)[0];
    return first ? `shell(${first})` : "shell";
  }
  if (WRITE_TOOLS.has(name)) {
    const path = typeof args.path === "string" ? args.path : undefined;
    return path ? `write(${path})` : "write";
  }
  return name;
}

/** A tool-execution failure the CLI reported because it couldn't get
 *  permission — not a normal tool error. `code` isn't a documented enum
 *  (session-events.schema.json leaves it a free-form string), so this
 *  matches both the exact code observed live and the message wording as a
 *  defensive fallback against wording drift. */
function isDenied(error: { code?: string; message?: string }): boolean {
  return error.code === "denied" || /permission/i.test(error.message ?? "");
}

/** What the CLI actually denied — enough to describe it to the operator and
 *  to rebuild a scoped `--allow-tool` flag if they approve a retry. */
interface DeniedGate {
  toolName: string;
  args: Record<string, unknown>;
  display: string;
}

/**
 * Duration off the terminal `result` line's usage block. Prefers actual API
 * time over wall-clock session time (closer to what "usage" means for the
 * other vendors' durationMs); falls back when a future CLI version omits one
 * or the other. Exported for the vendor-usage test fixture.
 */
export function durationFromResultUsage(usage: Record<string, unknown>): number {
  const apiMs = typeof usage.totalApiDurationMs === "number" ? usage.totalApiDurationMs : undefined;
  const sessionMs = typeof usage.sessionDurationMs === "number" ? usage.sessionDurationMs : undefined;
  return apiMs ?? sessionMs ?? 0;
}

/**
 * Best-effort usage from a completed run. Deliberately NOT routed through the
 * shared `usageFromJson` scanner (cli-runner.ts): that scanner looks for
 * input_tokens/output_tokens/cost keys on one object, but Copilot's shapes
 * don't overlap it at all — output tokens live on each `assistant.message`
 * (summed across the run), duration lives on the terminal `result.usage`, and
 * neither input tokens nor a $ cost exist anywhere in this protocol (Copilot
 * meters "premium requests"/AI credits, not $/token). Forcing this through
 * the generic scanner would either find nothing or, worse, silently misread
 * an unrelated numeric field as a token count. Exported for the vendor-usage
 * test fixture (see tests/cli-runner-vendor-usage.test.ts).
 */
export function buildUsage(outputTokens: number, turns: number, durationMs: number): Usage | null {
  if (outputTokens <= 0 && turns <= 0 && durationMs <= 0) return null;
  return {
    inputTokens: 0, // never reported anywhere in this protocol — see file header
    outputTokens,
    costUsd: null, // credits/premium-requests, not $/token — there is no per-token price to report
    turns,
    durationMs: durationMs || null,
  };
}

class CopilotRunnerHandle implements RunnerHandle {
  readonly runId: string;
  readonly provider: ProviderId = "copilot";
  /** A UUID this runner picks and reuses on every turn via `--session-id`,
   *  so follow-up turns explicitly resume THIS run's own conversation. Copilot's
   *  `--continue` instead resumes whatever session was most recently active on
   *  the host — fine for a single interactive user, but wrong once more than
   *  one Skynet run can be live on the same box at once. */
  private readonly sessionId = randomUUID();
  private child?: ChildProcess;
  private reader?: Interface;
  private progress = 0;
  private finished = false;
  private pendingChat = false;
  /** Set while a tool call was denied and the operator hasn't answered yet. */
  private gate: DeniedGate | null = null;
  /** A resume()/message() that arrived while the current turn's process was
   *  still alive — see runOrQueue(). Applied from the `close` handler. */
  private pendingAction: (() => void) | null = null;
  private hb?: ReturnType<typeof setInterval>;
  /** toolCallId → the call that started it, so a later `tool.execution_complete`
   *  (which carries no command/path of its own) can be described. */
  private pendingTools = new Map<string, { name: string; args: Record<string, unknown> }>();
  private outputTokens = 0;
  private turns = 0;
  private durationMs = 0;

  constructor(
    private spec: StartSpec,
    private events: RunnerEvents,
  ) {
    this.runId = spec.runId;
    this.events.onStatus(this.runId, "running");
    this.events.onLog(this.runId, `picked up "${spec.task}" on ${spec.branch}`);
    this.hb = setInterval(() => this.events.onHeartbeat(this.runId), 5_000);
    this.spawnTurn(this.initialPrompt(), true);
  }

  private initialPrompt(): string {
    return (
      `You are a Skynet unit working in this repository on branch ${this.spec.branch}. ` +
      `Task: ${this.spec.task}. Make the change, run any relevant checks, then stop when done. ` +
      `Make code changes ONLY — do NOT run git commit, git push, or gh pr, and do NOT ask the operator whether to commit, push, or open a PR. Skynet owns that: when you finish it auto-commits your worktree, then gates the push and PR behind a separate review/approval step it controls. So never say you "didn't commit" or ask "should I open a PR?" — leave version control entirely to Skynet. Your "done" message should simply summarize what you changed and why, nothing about committing, pushing, or PRs. ` +
      `Ask before running destructive or irreversible commands. ` +
      `Be honest when you're blocked: if you cannot reproduce a reported problem, or the task lacks information you'd need to fix it correctly (a stack trace, reproduction steps, failing logs, expected vs actual behavior), do NOT guess or make a speculative edit. Report plainly what you could and couldn't determine and state exactly what you need to proceed, then stop WITHOUT changing code. Making no change and asking for the missing detail is the correct, honest outcome — a fabricated fix is a failure, not progress.`
    );
  }

  /** Launch one `copilot -p` turn. `primary` turns drive the task to
   *  completion. `allowTool`, when set, scopes this ONE turn's permission for
   *  a previously-denied call the operator just approved. */
  private spawnTurn(prompt: string, primary: boolean, allowTool?: string) {
    const model = mapModel(this.spec.model);
    const args = ["-p", prompt, "--output-format", "json", "--session-id", this.sessionId];
    if (model) args.push("--model", model);
    if (allowTool) args.push("--allow-tool", allowTool);

    let child: ChildProcess;
    try {
      child = spawn(COPILOT_BIN, args, {
        cwd: this.spec.cwd ?? process.cwd(),
        // Per-workspace key (orchestrator-injected) overrides ambient env. The
        // Copilot CLI authenticates via GitHub token env vars.
        env: this.spec.apiKey
          ? { ...process.env, GH_TOKEN: this.spec.apiKey, GITHUB_TOKEN: this.spec.apiKey }
          : process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      this.degrade(`copilot failed to launch: ${(err as Error).message}`, primary);
      return;
    }
    this.child = child;

    child.on("error", (err) => {
      const reason =
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? `copilot CLI not found on PATH (set SKYNET_COPILOT_BIN or install the GitHub Copilot CLI)`
          : `copilot error: ${err.message}`;
      this.degrade(reason, primary);
    });

    let sawAuthError = false;
    const scanAuth = (chunk: string) => {
      if (/not (?:logged in|authenticated)|sign in|unauthor|gh auth|401|forbidden|no (?:active )?subscription/i.test(chunk))
        sawAuthError = true;
    };
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        scanAuth(chunk);
        const line = chunk.trim();
        if (line) this.events.onLog(this.runId, `[copilot] ${line}`);
      });
    }

    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      this.reader = createInterface({ input: child.stdout });
      this.reader.on("line", (line) => this.onLine(line, primary));
    }

    child.on("close", (code) => {
      this.reader?.close();
      if (this.finished) return;
      if (sawAuthError || (code !== 0 && this.progress === 0)) {
        this.degrade(
          sawAuthError
            ? `copilot CLI is not authenticated — run \`copilot\` once to sign in (or set GH_TOKEN)`
            : `copilot exited with code ${code} before producing output`,
          primary,
        );
        return;
      }
      // A resume()/message() arrived while this turn was still running and got
      // queued (see runOrQueue) — apply it now instead of possibly finishing.
      if (this.pendingAction) {
        const action = this.pendingAction;
        this.pendingAction = null;
        action();
        return;
      }
      // Don't complete while a HITL gate is pending: the CLI already finished
      // this turn on its own (a denied tool call doesn't block the process —
      // the model just reports it couldn't do the thing and stops), but the
      // operator hasn't answered yet. resume() spawns the follow-up turn that
      // actually drives the task to completion.
      if (primary && !this.gate) this.finish();
    });
  }

  private onLine(line: string, primary: boolean) {
    const trimmed = line.trim();
    if (!trimmed) return;

    if (!trimmed.startsWith("{")) {
      // Not a session event (a stray banner line, etc.) — surface verbatim.
      this.events.onLog(this.runId, trimmed);
      return;
    }
    let obj: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!isRecord(parsed)) return;
      obj = parsed;
    } catch {
      this.events.onLog(this.runId, trimmed);
      return;
    }

    const type = String(obj.type ?? "");

    // The terminal `result` line is the CLI's one-shot exec summary, not a
    // session event — it isn't wrapped in the {id,timestamp,parentId,data}
    // envelope every other line uses.
    if (type === "result") {
      this.onResult(obj);
      return;
    }

    const data = isRecord(obj.data) ? obj.data : {};
    switch (type) {
      case "assistant.message":
        this.onAssistantMessage(data);
        return;
      case "tool.execution_start":
        this.onToolStart(data);
        return;
      case "tool.execution_complete":
        this.onToolComplete(data, primary);
        return;
      case "assistant.turn_end":
        this.turns += 1;
        return;
      default:
        // Internal telemetry (mcp/session bookkeeping, model.call_*, streaming
        // deltas already superseded by the assembled assistant.message,
        // reasoning, …) — deliberately dropped, not every line is operator-facing.
        return;
    }
  }

  private onAssistantMessage(data: Record<string, unknown>) {
    if (typeof data.outputTokens === "number") this.outputTokens += data.outputTokens;
    const content = typeof data.content === "string" ? data.content.trim() : "";
    if (!content) return;
    if (this.pendingChat) {
      this.pendingChat = false;
      this.events.onChatReply(this.runId, content);
      return;
    }
    this.events.onLog(this.runId, content);
  }

  private onToolStart(data: Record<string, unknown>) {
    const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : undefined;
    const name = typeof data.toolName === "string" ? data.toolName : "tool";
    const args = isRecord(data.arguments) ? data.arguments : {};
    if (toolCallId) this.pendingTools.set(toolCallId, { name, args });
    this.events.onLog(this.runId, `▸ ${describeTool(name, args)}`);
    this.bump();
  }

  private onToolComplete(data: Record<string, unknown>, primary: boolean) {
    const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : undefined;
    const info = toolCallId ? this.pendingTools.get(toolCallId) : undefined;
    if (toolCallId) this.pendingTools.delete(toolCallId);
    if (data.success !== false) return;

    const errorObj = isRecord(data.error) ? data.error : {};
    const message = typeof errorObj.message === "string" ? errorObj.message : "tool failed";
    const code = typeof errorObj.code === "string" ? errorObj.code : undefined;

    if (info && primary && !this.gate && isDenied({ code, message })) {
      this.raiseGate(info.name, info.args);
      return;
    }
    // A real tool error (not a permission denial) — surface it, but it's not
    // a decision the operator needs to make, so no gate.
    this.events.onLog(this.runId, `⚠ ${info?.name ?? "tool"} failed: ${message}`);
  }

  private onResult(obj: Record<string, unknown>) {
    this.durationMs += durationFromResultUsage(isRecord(obj.usage) ? obj.usage : {});
    const reported = buildUsage(this.outputTokens, this.turns, this.durationMs);
    if (reported) this.events.onUsage?.(this.runId, reported);
  }

  private raiseGate(toolName: string, args: Record<string, unknown>) {
    const display = describeTool(toolName, args);
    this.gate = { toolName, args, display };
    this.events.onStatus(this.runId, "waiting");
    this.events.onHitl(this.runId, this.buildRaise(display));
  }

  private buildRaise(display: string): HitlRaise {
    return {
      kind: "approval",
      title: `Approve: ${display.slice(0, 80)}`,
      why: "Copilot unit's request was auto-denied — headless mode has no live approval channel, so the CLI already refused it. Approve to retry with that one action explicitly permitted.",
      risk: "medium",
      command: display,
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
    this.events.onStatus(this.runId, "waiting");
  }

  async resume(decision?: Resolution) {
    this.runOrQueue(() => this.applyResume(decision));
  }

  async message(text: string) {
    this.runOrQueue(() => {
      this.pendingChat = true;
      this.spawnTurn(text, false);
    });
  }

  /**
   * A gate is raised as soon as a call is denied, but the CLI process itself
   * keeps running (this mode has no way to actually block a turn — see the
   * file header) and typically finishes seconds later on its own. If the
   * operator answers before that happens, don't spawn a second `copilot`
   * process against the same `--session-id` — queue it and apply the moment
   * the running turn's `close` handler sees it (below).
   */
  private runOrQueue(action: () => void) {
    if (this.childAlive()) {
      this.pendingAction = action;
      return;
    }
    action();
  }

  private applyResume(decision?: Resolution) {
    if (this.gate) {
      const gate = this.gate;
      this.gate = null;
      this.events.onStatus(this.runId, "running");
      if (decision?.action === "reject" || decision?.action === "modify") {
        this.events.onLog(this.runId, `decision: ${decision.action}`);
        const guidance =
          decision.action === "modify" && decision.guidance?.trim()
            ? decision.guidance.trim()
            : `Do not do \`${gate.display}\` — it was denied. Revise your approach.`;
        this.spawnTurn(guidance, true);
      } else {
        this.events.onLog(this.runId, "decision: approve");
        this.spawnTurn(
          `Approved — proceed with \`${gate.display}\`.`,
          true,
          allowToolFlag(gate.toolName, gate.args),
        );
      }
      return;
    }
    if (decision?.guidance?.trim()) this.spawnTurn(decision.guidance.trim(), false);
  }

  private childAlive(): boolean {
    return !!this.child && this.child.exitCode === null && !this.child.killed;
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
    this.events.onFailed(this.runId, `copilot runner unavailable — ${reason}`);
    this.killChild();
  }

  private killChild() {
    if (this.child && this.child.exitCode === null && !this.child.killed) {
      this.child.kill("SIGTERM");
    }
  }
}

export class CopilotRunnerProvider implements RunnerProvider {
  readonly id: ProviderId = "copilot";
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    // Fork support: each handle picks its own fresh --session-id (see the
    // class field), and a fork gets its own — there is no parent context to
    // inherit (the CLI has no addressable way to branch a session), so a fork
    // starts fresh from the task prompt. Same behavior as before this file's
    // JSON migration; still a valid, independent unit.
    return new CopilotRunnerHandle(spec, events);
  }
}
