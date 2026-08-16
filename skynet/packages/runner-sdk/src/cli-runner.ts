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

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { PlanStep, ProviderId, Resolution, Usage } from "@skynet/shared";
import { fmtDuration, idleCapMs, runtimeCapMs } from "./caps.js";
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
  | { kind: "delta"; text: string } // token-level "typing" chunk — live preview only, never persisted itself (see RunnerEvents.onLogDelta)
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
  /**
   * Write anything the vendor needs into the worktree before spawning — e.g. a
   * project-scoped MCP config file for a vendor whose MCP servers are file-
   * based only (no per-invocation flag). Synchronous: writes here are a few
   * small config files, so there's no need to make `launch()` async for a hook
   * only some vendors implement. A vendor whose MCP config IS argv-based (see
   * `browserMcpServerSpec`) has no reason to implement this at all.
   */
  prepareWorktree?(spec: StartSpec, cwd: string): void;
  /** The initial prompt to write to stdin once spawned, or null if the prompt
   *  is passed entirely via argv. */
  initialStdin?(spec: StartSpec): string | null;
  /**
   * True when this vendor's non-interactive process hangs indefinitely on an
   * OPEN stdin pipe — Node's `spawn()` default. Verified live for OpenCode: its
   * `run` command completes instantly when invoked from a shell (stdin
   * inherited/already closed) but hangs producing zero output when spawned with
   * Node's default piped stdio, and completes instantly again once stdin is
   * closed (`stdio: ["ignore", …]`) at spawn time. Unset/false preserves every
   * other vendor's existing behavior.
   */
  readonly closeStdin?: boolean;
  /**
   * Map one stdout line to a neutral event, or several — a vendor whose wire
   * protocol has no distinct "message complete" marker (see gemini.ts) needs to
   * flush a buffered `delta` run as a real `chat`/`log` line the moment the NEXT
   * line's event closes it out, and one stdout line can only produce one parsed
   * moment in time, not two independent ones later. Most vendors just return a
   * single event. Throw-safe: the base falls back to logging the raw line if
   * this throws.
   */
  parseLine(line: string, ctx: ParseCtx): CliEvent | CliEvent[];
  /** Serialize an operator decision for the CLI's stdin. Return null when the
   *  CLI can't accept a mid-run decision (the base then just unblocks + logs). */
  encodeDecision(decision: Resolution | undefined, ctx: ParseCtx): string | null;
  /** Serialize a chat/guidance message for stdin, or null if unsupported. */
  encodeMessage(text: string): string | null;
}

// ─── Opt-in browser tooling (shared across CLI vendors) ─────────────────────
// Mirrors claude.ts's `browserMcpServers` (kept separate — never shared code —
// so nothing here can touch the Claude path). When a run has `spec.browser` set
// (from the per-workspace `browserTools` setting), each vendor that supports MCP
// hands its CLI a Playwright/Chrome MCP server the same way: wrap Microsoft's
// `@playwright/mcp`, headless + isolated, one shared name so it reads the same
// across every vendor's logs. `SKYNET_BROWSER_MCP_COMMAND` overrides the launch
// command (space-separated) for pinning a version, a private mirror, or a
// Chrome-channel flavour — the SAME knob Claude uses, so one override covers the
// whole fleet.
export const BROWSER_MCP_NAME = "browser";
export function browserMcpServerSpec(): { command: string; args: string[] } {
  const override = process.env.SKYNET_BROWSER_MCP_COMMAND?.trim();
  const parts = override
    ? override.split(/\s+/).filter(Boolean)
    : ["npx", "-y", "@playwright/mcp@latest", "--headless", "--isolated"];
  return { command: parts[0] ?? "npx", args: parts.slice(1) };
}
/** Merge the browser MCP server into an already-parsed JSON config object's
 *  `mcpServers` key — shared by every FILE-based vendor (Gemini, Cursor).
 *  Preserves whatever else was in `existing` (e.g. servers the repo's own
 *  committed config already declares). Codex/Copilot don't need this — their
 *  MCP config is a per-invocation flag, no file involved. */
export function mergeBrowserMcpConfig(existing: Record<string, unknown>): Record<string, unknown> {
  const existingServers = existing.mcpServers as Record<string, unknown> | undefined;
  const { command, args } = browserMcpServerSpec();
  return { ...existing, mcpServers: { ...existingServers, [BROWSER_MCP_NAME]: { command, args } } };
}

class CliRunnerHandle implements RunnerHandle {
  readonly runId: string;
  readonly provider: ProviderId;
  private child?: ChildProcess;
  private gateOpen = false;
  private pendingChat = false;
  private progress = 0;
  private finished = false;
  private hb?: ReturnType<typeof setInterval>;
  private cap?: ReturnType<typeof setTimeout>;
  private idle?: ReturnType<typeof setTimeout>; // idle-stall watchdog (resets on each stdout line)
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
    // Best-effort: a vendor's worktree prep (e.g. writing a browser-MCP config
    // file) is opt-in tooling, never the run's actual task — a failure here
    // logs and falls through to a plain run rather than failing the whole thing.
    try {
      this.vendor.prepareWorktree?.(this.spec, cwd);
    } catch (err) {
      this.events.onLog(this.runId, `browser-tools setup failed: ${(err as Error).message} — continuing without it`);
    }
    // Opt-in OS write-confinement (SKYNET_RUNNER_SANDBOX). No-op unless enabled
    // and a sandbox tool is available; otherwise runs the vendor bin directly.
    const wrapped = wrapForSandbox(this.vendor.bin, this.vendor.buildArgs(this.spec), { cwd });
    if (wrapped.note) this.events.onLog(this.runId, wrapped.note);
    let child: ChildProcess;
    try {
      child = spawn(wrapped.bin, wrapped.args, {
        cwd,
        // `spawn`'s `cwd` option changes the child's REAL working directory but
        // never touches the inherited `PWD` env var — it stays whatever the
        // Skynet server process itself was launched from. Verified live: a
        // Bun-compiled vendor binary (OpenCode) resolves its own project
        // directory from `PWD` rather than the OS cwd, so a stale inherited
        // `PWD` silently pointed it at the SERVER's launch directory instead of
        // the agent's worktree — writing real files there instead of failing
        // loudly. Overriding PWD to match `cwd` here is strictly more correct
        // for every vendor, not just the one that surfaced the bug.
        env: { ...process.env, PWD: cwd, ...(this.vendor.env?.(this.spec) ?? {}) },
        // Default stdio is "pipe" for all three streams — except a vendor that
        // opts into closeStdin (see CliVendor), whose stdin is closed at spawn
        // time instead (stdout/stderr stay piped either way).
        ...(this.vendor.closeStdin ? { stdio: ["ignore", "pipe", "pipe"] as const } : {}),
      });
    } catch (err) {
      this.fallback(`could not launch ${this.vendor.bin}: ${(err as Error).message}. ${this.vendor.installHint}`);
      return;
    }
    this.child = child;

    // Wall-clock resource cap: a runaway/hung agent is force-failed so it can't
    // hold its fleet slot and burn tokens forever. 0 disables (see caps.ts).
    const capMs = runtimeCapMs();
    if (capMs > 0) {
      this.cap = setTimeout(
        () => this.fallback(`exceeded max runtime (${fmtDuration(capMs)}) — force-stopped`),
        capMs,
      );
    }
    this.bumpIdle(); // idle-stall watchdog: reset on each stdout line (see onLine)

    // ENOENT (binary not installed / not on PATH) surfaces here, not as a throw.
    child.on("error", (err) =>
      this.fallback(`${this.vendor.bin} unavailable: ${(err as Error).message}. ${this.vendor.installHint}`),
    );

    // stdout/stderr are always piped (only stdin's mode varies, see above).
    createInterface({ input: child.stdout! }).on("line", (line) => this.onLine(line));
    createInterface({ input: child.stderr! }).on("line", (line) => {
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
    this.bumpIdle(); // stdout activity = progress → reset the stall watchdog
    const line = raw.trimEnd();
    if (!line) return;
    let evs: CliEvent[];
    try {
      const parsed = this.vendor.parseLine(line, this.ctx);
      evs = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      evs = [{ kind: "log", line }];
    }
    for (const ev of evs) this.applyEvent(ev);
  }

  private applyEvent(ev: CliEvent) {
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
      case "delta":
        this.events.onLogDelta?.(this.runId, ev.text);
        break;
      case "ignore":
        break;
    }
  }

  private bump() {
    this.progress = Math.min(0.9, this.progress + 0.08);
    this.events.onProgress(this.runId, this.progress, [] as PlanStep[]);
  }

  /** (Re)arm the idle-stall watchdog. Resets on each stdout line, so it fires
   *  only after the CLI has produced NO output for idleCapMs — catching a wedged
   *  vendor process (hung mid-turn, dead stream) fast, while a process that keeps
   *  streaming is never interrupted. The heartbeat is a fixed timer that keeps
   *  ticking for a hung run, so the server reaper can't catch this. Force-fail →
   *  onFailed → needs-attention, never a silent "running" forever. */
  private bumpIdle() {
    if (this.finished) return;
    const ms = idleCapMs();
    if (ms <= 0) return; // disabled
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.fallback(`no progress for ${fmtDuration(ms)} — stalled, force-stopped`), ms);
  }

  // Binary missing, process died, or auth failed — this is a FAILURE, not a
  // completion. Surface it (orchestrator marks the agent needs-attention) and
  // never report success: a broken runner must not look like a done agent.
  private fallback(message: string) {
    if (this.finished) return;
    this.finished = true;
    if (this.hb) clearInterval(this.hb);
    if (this.cap) clearTimeout(this.cap);
    if (this.idle) clearTimeout(this.idle);
    this.events.onFailed(this.runId, message);
    this.kill();
  }

  private finish() {
    if (this.finished) return;
    this.finished = true;
    if (this.hb) clearInterval(this.hb);
    if (this.cap) clearTimeout(this.cap);
    if (this.idle) clearTimeout(this.idle);
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
    if (this.cap) clearTimeout(this.cap);
    if (this.idle) clearTimeout(this.idle);
    this.kill();
  }

  private kill() {
    const child = this.child;
    if (!child || child.killed) return;
    try {
      child.stdin?.end();
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
