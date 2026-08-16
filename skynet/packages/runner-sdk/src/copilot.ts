// ─── Copilot runner (W2d) ─────────────────────────────────────────────────
// A real RunnerProvider backed by the GitHub Copilot CLI (`copilot`, the
// `@github/copilot` programmatic agent). Same control contract as the other
// runners: a streamed task session surfaced as log/progress, the CLI's
// per-command tool-approval prompt mapped to a HITL `approval` item, and chat /
// decisions delivered back to the live session.
//
//   copilot -p "<task>" --model <m>            # one-shot, prompts for risky tools
//
// Unlike cursor-agent, the Copilot CLI streams human-readable text rather than
// NDJSON, so we parse lines heuristically: tool/command lines bump progress and
// an approval prompt (e.g. "Allow … ? [y/N]") raises a HITL gate answered over
// stdin.
//
// Selected via RUNNER=copilot; Core wires orchestrator.getProvider(). The
// default RUNNER=mock path never imports this file.
//
// Auth: the Copilot CLI needs a signed-in `gh`/Copilot subscription (or
// GH_TOKEN). When the binary is missing or unauthenticated the runner degrades
// cleanly — it surfaces the reason and completes, so the lifecycle never hangs.
//
// Opt-in browser tooling (spec.browser): unlike Cursor/Gemini, the Copilot CLI
// takes MCP config as a real per-invocation flag — `--additional-mcp-config
// <json>` (verified live against @github/copilot 1.0.80: --help says it
// "augments config from ~/.copilot/mcp-config.json for this session", i.e.
// session-scoped, no file ever written). Same {mcpServers:{...}} shape every
// other vendor's config uses. Tool calls from it fall through the CLI's
// existing generic APPROVAL_PROMPT match below — same live gate as any other
// tool, no special-casing needed.

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { PlanStep, ProviderId, Resolution } from "@skynet/shared";
import { BROWSER_MCP_NAME, browserMcpServerSpec } from "./cli-runner.js";
import type {
  HitlRaise,
  RunnerEvents,
  RunnerHandle,
  RunnerProvider,
  StartSpec,
} from "./types.js";

const COPILOT_BIN = process.env.SKYNET_COPILOT_BIN || "copilot";

const mapModel = (m: string): string | undefined => (m.trim() ? m.trim() : undefined);

/** Pure argv builder for one `copilot -p` turn — pulled out of spawnTurn so
 *  it's directly testable without spawning a real process. */
export function copilotArgs(
  spec: StartSpec,
  prompt: string,
  opts: { resumeSession: boolean; primary: boolean },
): string[] {
  const model = mapModel(spec.model);
  const args = ["-p", prompt, "--no-color"];
  if (model) args.push("--model", model);
  // Continue the prior session for follow-up (chat / decision) turns.
  if (opts.resumeSession && !opts.primary) args.push("--continue");
  if (spec.browser) {
    const { command, args: mcpArgs } = browserMcpServerSpec();
    args.push(
      "--additional-mcp-config",
      JSON.stringify({ mcpServers: { [BROWSER_MCP_NAME]: { command, args: mcpArgs } } }),
    );
  }
  return args;
}

// Lines that signal the agent is invoking a tool / running a command — used to
// advance progress and (when they carry a command) to label the HITL gate.
const TOOL_LINE = /^(?:▸|>|•|\s*(?:running|executing|tool|shell|bash|run|edit|write|patch)\b)/i;
// An interactive approval prompt awaiting a yes/no answer on stdin.
const APPROVAL_PROMPT = /\b(allow|approve|run this|proceed|confirm)\b.*\?\s*(\[[yYnN/]+\])?\s*$/;

class CopilotRunnerHandle implements RunnerHandle {
  readonly runId: string;
  readonly provider: ProviderId = "copilot";
  private child?: ChildProcess;
  private reader?: Interface;
  private progress = 0;
  private finished = false;
  private pendingChat = false;
  private gateCommand: string | null = null;
  private hb?: ReturnType<typeof setInterval>;

  constructor(
    private spec: StartSpec,
    private events: RunnerEvents,
    private resumeSession: boolean,
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

  /** Launch one `copilot -p` turn. `primary` turns drive the task to completion. */
  private spawnTurn(prompt: string, primary: boolean) {
    const args = copilotArgs(this.spec, prompt, { resumeSession: this.resumeSession, primary });

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
    this.resumeSession = true;

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
      this.reader.on("line", (line) => {
        scanAuth(line);
        this.onLine(line, primary);
      });
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
      // Don't complete while a HITL gate is pending: a one-shot turn exits right
      // after printing the approval prompt; resume() spawns the turn that
      // actually drives the task to completion.
      if (primary && !this.gateCommand) this.finish();
    });
  }

  private onLine(line: string, primary: boolean) {
    const trimmed = line.trim();
    if (!trimmed) return;

    // Approval prompt → HITL gate (primary turn only).
    if (primary && !this.gateCommand && APPROVAL_PROMPT.test(trimmed)) {
      this.raiseGate(trimmed);
      return;
    }

    if (this.pendingChat) {
      // First substantive line after a chat message becomes the reply.
      this.pendingChat = false;
      this.events.onChatReply(this.runId, trimmed);
      return;
    }

    this.events.onLog(this.runId, trimmed);
    if (TOOL_LINE.test(trimmed)) this.bump();
  }

  private raiseGate(command: string) {
    this.gateCommand = command;
    this.events.onStatus(this.runId, "waiting");
    this.events.onHitl(this.runId, this.buildRaise(command));
  }

  private buildRaise(command: string): HitlRaise {
    return {
      kind: "approval",
      title: `Approve: ${command.slice(0, 80)}`,
      why: "Copilot unit is requesting permission to run a command.",
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
    this.events.onStatus(this.runId, "waiting");
  }

  async resume(decision?: Resolution) {
    if (this.gateCommand) {
      const command = this.gateCommand;
      this.gateCommand = null;
      this.events.onStatus(this.runId, "running");
      // The CLI is blocked on its y/N prompt — answer it directly on stdin.
      if (decision?.action === "reject" || decision?.action === "modify") {
        this.writeStdin("n");
        this.events.onLog(this.runId, `decision: ${decision.action}`);
        const guidance =
          decision.action === "modify" && decision.guidance?.trim()
            ? decision.guidance.trim()
            : `Do not run \`${command}\` — revise your approach.`;
        if (this.childAlive()) this.writeStdin(guidance);
        else this.spawnTurn(guidance, true);
      } else {
        this.writeStdin("y");
        this.events.onLog(this.runId, "decision: approve");
        if (!this.childAlive()) this.spawnTurn(`Approved — proceed with \`${command}\`.`, true);
      }
      return;
    }
    if (decision?.guidance?.trim()) {
      if (this.childAlive()) this.writeStdin(decision.guidance.trim());
      else this.spawnTurn(decision.guidance.trim(), false);
    }
  }

  async message(text: string) {
    this.pendingChat = true;
    if (this.childAlive()) this.writeStdin(text);
    else this.spawnTurn(text, false);
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

export class CopilotRunnerProvider implements RunnerProvider {
  readonly id: ProviderId = "copilot";
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    // Fork support: Copilot's CLI resumes the most recent session via --continue;
    // there is no addressable per-chat id to map a parent onto, so a fork starts
    // fresh from the task prompt (still a valid, independent unit).
    return new CopilotRunnerHandle(spec, events, false);
  }
}
