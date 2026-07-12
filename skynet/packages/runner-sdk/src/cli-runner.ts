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
import type { PlanStep, ProviderId, Resolution, Usage } from "@skynet/shared";
import { wrapForSandbox } from "./sandbox.js";
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
  | { kind: "usage"; usage: Usage } // token/cost totals the CLI reported
  | { kind: "ignore" }; // noise we deliberately drop

/**
 * Best-effort token/cost extraction from a parsed JSON event. Vendor JSONL
 * shapes vary and shift, so we scan the object (and a few common nesting keys)
 * for the field names these CLIs have used. Returns null unless at least one
 * token count is present, so we never fabricate a zeroed usage row. Numbers we
 * can't find stay 0 / null — honest partials, not invented totals.
 */
export function usageFromJson(obj: Record<string, unknown>): Usage | null {
  const scopes = [obj, obj.usage, obj.stats, obj.tokens, obj.metrics].filter(
    (s): s is Record<string, unknown> => !!s && typeof s === "object",
  );
  const num = (keys: string[]): number | undefined => {
    for (const scope of scopes) {
      for (const k of keys) {
        const v = scope[k];
        if (typeof v === "number" && Number.isFinite(v)) return v;
      }
    }
    return undefined;
  };
  const input = num(["input_tokens", "prompt_tokens", "inputTokens", "tokens_in", "input"]);
  const output = num(["output_tokens", "completion_tokens", "outputTokens", "tokens_out", "output"]);
  if (input === undefined && output === undefined) return null;
  const cost = num(["total_cost_usd", "cost_usd", "costUsd", "cost"]);
  const turns = num(["num_turns", "turns", "steps"]);
  const durationMs = num(["duration_ms", "durationMs", "elapsed_ms"]);
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    costUsd: cost ?? null,
    turns: turns ?? 0,
    durationMs: durationMs ?? null,
  };
}

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
  readonly runId: string;
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
    this.runId = spec.runId;
    this.provider = vendor.id;
    this.events.onStatus(this.runId, "running");
    this.events.onLog(this.runId, `picked up "${spec.task}" on ${spec.branch}`);
    this.hb = setInterval(() => this.events.onHeartbeat(this.runId), 5_000);
    this.launch();
  }

  private launch() {
    const cwd = this.spec.cwd ?? process.cwd();
    // Opt-in OS write-confinement (SKYNET_RUNNER_SANDBOX). No-op unless enabled
    // and a sandbox tool is available; otherwise runs the vendor bin directly.
    const wrapped = wrapForSandbox(this.vendor.bin, this.vendor.buildArgs(this.spec), { cwd });
    if (wrapped.note) this.events.onLog(this.runId, wrapped.note);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(wrapped.bin, wrapped.args, {
        cwd,
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
        this.events.onLog(this.runId, ev.line);
        break;
      case "tool":
        this.events.onLog(this.runId, `▸ ${ev.label}`);
        this.bump();
        break;
      case "chat":
        if (this.pendingChat) {
          this.pendingChat = false;
          this.events.onChatReply(this.runId, ev.text);
        } else {
          this.events.onLog(this.runId, ev.text);
        }
        break;
      case "approval":
        this.gateOpen = true;
        this.events.onStatus(this.runId, "waiting");
        this.events.onHitl(this.runId, ev.raise);
        break;
      case "usage":
        this.events.onUsage?.(this.runId, ev.usage);
        break;
      case "ignore":
        break;
    }
  }

  private bump() {
    this.progress = Math.min(0.9, this.progress + 0.08);
    this.events.onProgress(this.runId, this.progress, [] as PlanStep[]);
  }

  // Binary missing, process died, or auth failed — this is a FAILURE, not a
  // completion. Surface it (orchestrator marks the agent needs-attention) and
  // never report success: a broken runner must not look like a done agent.
  private fallback(message: string) {
    if (this.finished) return;
    this.finished = true;
    if (this.hb) clearInterval(this.hb);
    this.events.onFailed(this.runId, message);
    this.kill();
  }

  private finish() {
    if (this.finished) return;
    this.finished = true;
    if (this.hb) clearInterval(this.hb);
    this.events.onProgress(this.runId, 1, [] as PlanStep[]);
    // Compute finished, but the orchestrator owns the terminal "done" (after it
    // commits the worktree → review → merge). Emitting "done" here would race
    // integration and expose a premature "done" with uncommitted work — hand off
    // via onCompleted only.
    this.events.onCompleted(this.runId, this.spec.branch);
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
    this.events.onStatus(this.runId, "waiting");
  }

  async resume(decision?: Resolution) {
    if (this.gateOpen) {
      this.gateOpen = false;
      this.events.onStatus(this.runId, "running");
      // Best-effort: hand the decision to the CLI if it can take one on stdin.
      this.writeStdin(this.vendor.encodeDecision(decision, this.ctx));
      const tag = decision?.action ?? "approve";
      this.events.onLog(
        this.runId,
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
      this.events.onChatReply(this.runId, `re: "${text}" — noted; ${this.vendor.id} runs headless, factoring it into the next step.`);
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
