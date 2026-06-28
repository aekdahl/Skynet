// ─── CLI runner base ────────────────────────────────────────────────────────
// Shared plumbing for provider backends that drive a vendor *CLI* (Codex,
// Gemini) rather than an in-process SDK. Unlike the Claude runner — which gets a
// programmatic `canUseTool` callback — these vendors expose their agent as a
// command-line binary, so we spawn it in the agent's worktree and translate its
// streaming stdout into the same RunnerEvents the orchestrator already consumes.
//
// codex.ts / gemini.ts own the vendor-specific bits (binary, argv, line parsing,
// approval/decision encoding) via the `CliVendor` shape below; everything else —
// process lifecycle, heartbeat, progress, the HITL gate, and a clean fallback
// when the binary or auth is missing — lives here once. This file is internal:
// only ./codex and ./gemini are exported as package subpaths.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { PlanStep, ProviderId, Resolution } from "@skynet/shared";
import type {
  HitlRaise,
  RunnerEvents,
  RunnerHandle,
  RunnerProvider,
  StartSpec,
} from "./types.js";

/** Per-call scratch space a vendor parser can use to correlate events (e.g. an
 *  approval id seen on one line and answered on `resume`). Owned by the handle. */
export type ParseCtx = Record<string, unknown>;

/** A vendor-neutral event distilled from one line of the CLI's stdout. */
export type CliEvent =
  | { kind: "log"; line: string } // plain activity line
  | { kind: "tool"; label: string } // a command/tool invocation → bump progress
  | { kind: "chat"; text: string } // assistant prose (reply to a `message()`)
  | { kind: "approval"; raise: HitlRaise } // blocked on a human → HITL gate
  | { kind: "ignore" }; // noise we deliberately drop

/** The contract a vendor file fills in. One instance per provider. */
export interface CliVendor {
  readonly id: ProviderId;
  /** Executable to spawn (each file lets an env var override it). */
  readonly bin: string;
  /** Shown when `bin` isn't on PATH, so the operator knows how to install it. */
  readonly installHint: string;
  /** argv (excluding `bin`) for a task. */
  buildArgs(spec: StartSpec): string[];
  /** Extra env for the child process (API keys are usually inherited). */
  env?(spec: StartSpec): Record<string, string>;
  /** The initial prompt to write to stdin once spawned, or null if the prompt
   *  is passed entirely via argv. */
  initialStdin?(spec: StartSpec): string | null;
  /** Map one stdout line to a neutral event. Throw-safe: the base falls back to
   *  logging the raw line if this throws. */
  parseLine(line: string, ctx: ParseCtx): CliEvent;
  /** Serialize an operator decision for the CLI's stdin. Return null when the
   *  CLI can't accept a mid-run decision (the base then just unblocks + logs). */
  encodeDecision(decision: Resolution | undefined, ctx: ParseCtx): string | null;
  /** Serialize a chat/guidance message for stdin, or null if unsupported. */
  encodeMessage(text: string): string | null;
}

class CliRunnerHandle implements RunnerHandle {
  readonly agentId: string;
  readonly provider: ProviderId;
  private child?: ChildProcessWithoutNullStreams;
  private gateOpen = false;
  private pendingChat = false;
  private progress = 0;
  private finished = false;
  private hb?: ReturnType<typeof setInterval>;
  private stderrTail: string[] = [];
  private ctx: ParseCtx = {};

  constructor(
    private vendor: CliVendor,
    private spec: StartSpec,
    private events: RunnerEvents,
  ) {
    this.agentId = spec.agentId;
    this.provider = vendor.id;
    this.events.onStatus(this.agentId, "running");
    this.events.onLog(this.agentId, `picked up "${spec.task}" on ${spec.branch}`);
    this.hb = setInterval(() => this.events.onHeartbeat(this.agentId), 5_000);
    this.launch();
  }

  private launch() {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.vendor.bin, this.vendor.buildArgs(this.spec), {
        cwd: this.spec.cwd ?? process.cwd(),
        env: { ...process.env, ...(this.vendor.env?.(this.spec) ?? {}) },
        // Default stdio is "pipe" for all three streams.
      });
    } catch (err) {
      this.fallback(`could not launch ${this.vendor.bin}: ${(err as Error).message}. ${this.vendor.installHint}`);
      return;
    }
    this.child = child;

    // ENOENT (binary not installed / not on PATH) surfaces here, not as a throw.
    child.on("error", (err) =>
      this.fallback(`${this.vendor.bin} unavailable: ${(err as Error).message}. ${this.vendor.installHint}`),
    );

    createInterface({ input: child.stdout }).on("line", (line) => this.onLine(line));
    createInterface({ input: child.stderr }).on("line", (line) => {
      this.stderrTail.push(line);
      if (this.stderrTail.length > 12) this.stderrTail.shift();
    });

    child.on("exit", (code) => {
      if (this.finished) return;
      if (code && code !== 0) {
        const tail = this.stderrTail.join(" | ").slice(0, 500);
        this.fallback(`${this.vendor.bin} exited ${code}${tail ? ` — ${tail}` : ""} (auth or config?)`);
      } else {
        this.finish();
      }
    });

    const seed = this.vendor.initialStdin?.(this.spec);
    if (seed != null) this.writeStdin(seed);
  }

  private onLine(raw: string) {
    if (this.finished) return;
    const line = raw.trimEnd();
    if (!line) return;
    let ev: CliEvent;
    try {
      ev = this.vendor.parseLine(line, this.ctx);
    } catch {
      ev = { kind: "log", line };
    }
    switch (ev.kind) {
      case "log":
        this.events.onLog(this.agentId, ev.line);
        break;
      case "tool":
        this.events.onLog(this.agentId, `▸ ${ev.label}`);
        this.bump();
        break;
      case "chat":
        if (this.pendingChat) {
          this.pendingChat = false;
          this.events.onChatReply(this.agentId, ev.text);
        } else {
          this.events.onLog(this.agentId, ev.text);
        }
        break;
      case "approval":
        this.gateOpen = true;
        this.events.onStatus(this.agentId, "waiting");
        this.events.onHitl(this.agentId, ev.raise);
        break;
      case "ignore":
        break;
    }
  }

  private bump() {
    this.progress = Math.min(0.9, this.progress + 0.08);
    this.events.onProgress(this.agentId, this.progress, [] as PlanStep[]);
  }

  // Binary missing, process died, or auth failed — this is a FAILURE, not a
  // completion. Surface it (orchestrator marks the agent needs-attention) and
  // never report success: a broken runner must not look like a done agent.
  private fallback(message: string) {
    if (this.finished) return;
    this.finished = true;
    if (this.hb) clearInterval(this.hb);
    this.events.onFailed(this.agentId, message);
    this.kill();
  }

  private finish() {
    if (this.finished) return;
    this.finished = true;
    if (this.hb) clearInterval(this.hb);
    this.events.onProgress(this.agentId, 1, [] as PlanStep[]);
    this.events.onStatus(this.agentId, "done");
    this.events.onCompleted(this.agentId, this.spec.branch);
    this.kill();
  }

  private writeStdin(payload: string | null) {
    const stdin = this.child?.stdin;
    if (!payload || !stdin || !stdin.writable) return;
    try {
      stdin.write(payload.endsWith("\n") ? payload : `${payload}\n`);
    } catch {
      /* child already gone */
    }
  }

  async pause() {
    this.events.onStatus(this.agentId, "waiting");
  }

  async resume(decision?: Resolution) {
    if (this.gateOpen) {
      this.gateOpen = false;
      this.events.onStatus(this.agentId, "running");
      // Best-effort: hand the decision to the CLI if it can take one on stdin.
      this.writeStdin(this.vendor.encodeDecision(decision, this.ctx));
      const tag = decision?.action ?? "approve";
      this.events.onLog(
        this.agentId,
        `decision: ${tag}${decision?.guidance ? ` — "${decision.guidance}"` : ""}`,
      );
    } else if (decision?.guidance) {
      // No gate pending — treat guidance as a mid-run steer.
      this.writeStdin(this.vendor.encodeMessage(decision.guidance));
    }
  }

  async message(text: string) {
    const payload = this.vendor.encodeMessage(text);
    if (payload != null) {
      this.pendingChat = true;
      this.writeStdin(payload);
    } else {
      // CLI runs one-shot — can't chat mid-run; acknowledge instead of hanging.
      this.events.onChatReply(this.agentId, `re: "${text}" — noted; ${this.vendor.id} runs headless, factoring it into the next step.`);
    }
  }

  async stop() {
    this.finished = true;
    if (this.hb) clearInterval(this.hb);
    this.kill();
  }

  private kill() {
    const child = this.child;
    if (!child || child.killed) return;
    try {
      child.stdin.end();
    } catch {
      /* ignore */
    }
    child.kill("SIGTERM");
  }
}

/** Base provider — a vendor file extends this and returns its `CliVendor`. */
export abstract class CliRunnerProvider implements RunnerProvider {
  abstract readonly id: ProviderId;
  protected abstract vendor(): CliVendor;

  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    return new CliRunnerHandle(this.vendor(), spec, events);
  }
}
