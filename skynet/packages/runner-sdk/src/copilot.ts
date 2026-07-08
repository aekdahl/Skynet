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

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { PlanStep, ProviderId, Resolution } from "@skynet/shared";
import type {
  HitlRaise,
  RunnerEvents,
  RunnerHandle,
  RunnerProvider,
  StartSpec,
} from "./types.js";

const COPILOT_BIN = process.env.SKYNET_COPILOT_BIN || "copilot";

const mapModel = (m: string): string | undefined => (m.trim() ? m.trim() : undefined);

// Lines that signal the agent is invoking a tool / running a command — used to
// advance progress and (when they carry a command) to label the HITL gate.
const TOOL_LINE = /^(?:▸|>|•|\s*(?:running|executing|tool|shell|bash|run|edit|write|patch)\b)/i;
// An interactive approval prompt awaiting a yes/no answer on stdin.
const APPROVAL_PROMPT = /\b(allow|approve|run this|proceed|confirm)\b.*\?\s*(\[[yYnN/]+\])?\s*$/;

class CopilotRunnerHandle implements RunnerHandle {
  readonly agentId: string;
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
    this.agentId = spec.agentId;
    this.events.onStatus(this.agentId, "running");
    this.events.onLog(this.agentId, `picked up "${spec.task}" on ${spec.branch}`);
    this.hb = setInterval(() => this.events.onHeartbeat(this.agentId), 5_000);
    this.spawnTurn(this.initialPrompt(), true);
  }

  private initialPrompt(): string {
    return (
      `You are a Skynet unit working in this repository on branch ${this.spec.branch}. ` +
      `Task: ${this.spec.task}. Make the change, run any relevant checks, then stop when done. ` +
      `Ask before running destructive or irreversible commands.`
    );
  }

  /** Launch one `copilot -p` turn. `primary` turns drive the task to completion. */
  private spawnTurn(prompt: string, primary: boolean) {
    const model = mapModel(this.spec.model);
    const args = ["-p", prompt, "--no-color"];
    if (model) args.push("--model", model);
    // Continue the prior session for follow-up (chat / decision) turns.
    if (this.resumeSession && !primary) args.push("--continue");

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
        if (line) this.events.onLog(this.agentId, `[copilot] ${line}`);
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
      this.events.onChatReply(this.agentId, trimmed);
      return;
    }

    this.events.onLog(this.agentId, trimmed);
    if (TOOL_LINE.test(trimmed)) this.bump();
  }

  private raiseGate(command: string) {
    this.gateCommand = command;
    this.events.onStatus(this.agentId, "waiting");
    this.events.onHitl(this.agentId, this.buildRaise(command));
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
      steps: null,
      diff: null,
    };
  }

  private bump() {
    this.progress = Math.min(0.9, this.progress + 0.08);
    this.events.onProgress(this.agentId, this.progress, [] as PlanStep[]);
  }

  async pause() {
    this.events.onStatus(this.agentId, "waiting");
  }

  async resume(decision?: Resolution) {
    if (this.gateCommand) {
      const command = this.gateCommand;
      this.gateCommand = null;
      this.events.onStatus(this.agentId, "running");
      // The CLI is blocked on its y/N prompt — answer it directly on stdin.
      if (decision?.action === "reject" || decision?.action === "modify") {
        this.writeStdin("n");
        this.events.onLog(this.agentId, `decision: ${decision.action}`);
        const guidance =
          decision.action === "modify" && decision.guidance?.trim()
            ? decision.guidance.trim()
            : `Do not run \`${command}\` — revise your approach.`;
        if (this.childAlive()) this.writeStdin(guidance);
        else this.spawnTurn(guidance, true);
      } else {
        this.writeStdin("y");
        this.events.onLog(this.agentId, "decision: approve");
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
    this.events.onProgress(this.agentId, 1, [] as PlanStep[]);
    // The orchestrator owns the terminal "done" (after committing the worktree →
    // review → merge). Emitting it here would race integration and surface a
    // premature "done" with uncommitted work — hand off via onCompleted only.
    this.events.onCompleted(this.agentId, this.spec.branch);
    this.killChild();
  }

  /** Live execution is unavailable — surface it as a FAILURE, not a completion. */
  private degrade(reason: string, primary: boolean) {
    if (this.finished || !primary) return;
    this.finished = true;
    if (this.hb) clearInterval(this.hb);
    this.events.onFailed(this.agentId, `copilot runner unavailable — ${reason}`);
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
