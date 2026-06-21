// ─── CLI subprocess runner ─────────────────────────────────────────────────
// A vendor-agnostic RunnerProvider that drives an agentic *CLI* as a subprocess
// (the same shape claude.ts uses for the Claude CLI). Codex, Gemini, Cursor, and
// Copilot each ship an agent CLI; codex.ts/gemini.ts/cursor.ts/copilot.ts are
// thin configs over this base. The orchestrator selects one via RUNNER=<vendor>.
//
// Approval gate: a synchronous per-tool permission callback (the Claude Agent
// SDK's `canUseTool`) isn't available across a subprocess boundary. So the gate
// is coarse — before the CLI runs with file/command access we raise ONE
// `approval` HITL; on approve we spawn it, on reject we stop. The CLI's stdout
// streams to the agent log; exit code drives completion.
//
// Fallback: when the vendor CLI isn't on PATH we fast-fail to `review` with a
// clear reason (mirrors the Claude runner; satisfies W2 "falls back cleanly
// otherwise"). The binary is overridable per vendor via an env var so teams can
// point at a specific install without code changes.

import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import type { PlanStep, ProviderId, Resolution } from "@skynet/shared";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "./types.js";

const execFileAsync = promisify(execFile);

/** Per-vendor configuration for {@link CliRunnerProvider}. */
export interface CliRunnerSpec {
  id: ProviderId;
  /** Human label for logs/HITL, e.g. "Codex". */
  label: string;
  /** Default executable name, e.g. "codex". Overridable via {@link cmdEnv}. */
  bin: string;
  /** Env var that overrides the binary path/name (e.g. "SKYNET_CODEX_CMD"). */
  cmdEnv: string;
  /** Map a Skynet model id → the CLI's --model value. undefined → omit the flag. */
  mapModel?: (model: string) => string | undefined;
  /**
   * Build the argv (excluding the binary) for a non-interactive run of `task`.
   * Exact flags should be confirmed against the installed CLI version — this is
   * the single place to adjust per vendor.
   */
  buildArgs: (ctx: { task: string; model?: string }) => string[];
}

async function resolveBinary(bin: string): Promise<boolean> {
  try {
    // `command -v` resolves PATH entries, builtins, and aliases without running the tool.
    await execFileAsync("/bin/sh", ["-c", `command -v ${JSON.stringify(bin)}`]);
    return true;
  } catch {
    return false;
  }
}

class CliRunnerHandle implements RunnerHandle {
  readonly agentId: string;
  readonly provider: ProviderId;
  private child?: ChildProcess;
  private gate?: (decision?: Resolution) => void; // resolves the pre-run approval HITL
  private progress = 0;
  private finished = false;
  private hb?: ReturnType<typeof setInterval>;

  constructor(
    private spec: StartSpec,
    private events: RunnerEvents,
    private vendor: CliRunnerSpec,
    private bin: string | null, // null → CLI not found; fast-fail
  ) {
    this.agentId = spec.agentId;
    this.provider = vendor.id;
    this.events.onStatus(this.agentId, "running");
    this.events.onLog(this.agentId, `picked up "${spec.task}" on ${spec.branch}`);

    if (!this.bin) {
      this.events.onLog(
        this.agentId,
        `the ${vendor.label} CLI ('${vendor.bin}') was not found on PATH — install and authenticate it ` +
          `(or set ${vendor.cmdEnv}) to enable live ${vendor.label} runs.`,
      );
      this.events.onStatus(this.agentId, "review");
      return; // no gate, no process
    }

    // Coarse approval gate: the CLI runs with write/command access, so pause for
    // a human before the first run instead of executing unattended.
    this.events.onStatus(this.agentId, "waiting");
    this.events.onHitl(this.agentId, {
      kind: "approval",
      title: `Approve ${vendor.label} to work on: ${spec.task}`,
      why: `${vendor.label} will run with file + command access in ${spec.cwd ?? process.cwd()}. Approve to start, reject to cancel.`,
      risk: "medium",
      command: `${this.bin} ${vendor.buildArgs({ task: spec.task, model: vendor.mapModel?.(spec.model) }).join(" ")}`,
      options: null,
      recommended: null,
      steps: null,
      diff: null,
    });
  }

  private bump() {
    this.progress = Math.min(0.9, this.progress + 0.05);
    this.events.onProgress(this.agentId, this.progress, [] as PlanStep[]);
  }

  private spawnProcess() {
    if (!this.bin || this.finished) return;
    const model = this.vendor.mapModel?.(this.spec.model);
    const args = this.vendor.buildArgs({ task: this.spec.task, model });
    this.events.onStatus(this.agentId, "running");
    this.events.onLog(this.agentId, `running: ${this.bin} ${args.join(" ")}`);

    const child = spawn(this.bin, args, {
      cwd: this.spec.cwd ?? process.cwd(),
      env: process.env,
    });
    this.child = child;
    this.hb = setInterval(() => this.events.onHeartbeat(this.agentId), 5_000);

    const onChunk = (buf: Buffer) => {
      for (const line of buf.toString().split("\n")) {
        const trimmed = line.trim();
        if (trimmed) this.events.onLog(this.agentId, trimmed);
      }
      this.bump();
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    child.on("error", (err) => {
      this.events.onLog(this.agentId, `runner error: ${err.message}`);
      this.fail();
    });
    child.on("close", (code) => (code === 0 ? this.finish() : this.fail(code ?? undefined)));
  }

  private clearTimers() {
    if (this.hb) clearInterval(this.hb);
  }

  private finish() {
    if (this.finished) return;
    this.finished = true;
    this.clearTimers();
    this.events.onProgress(this.agentId, 1, [] as PlanStep[]);
    this.events.onStatus(this.agentId, "done");
    this.events.onCompleted(this.agentId, this.spec.branch);
  }

  private fail(code?: number) {
    if (this.finished) return;
    this.finished = true;
    this.clearTimers();
    if (code != null) this.events.onLog(this.agentId, `${this.vendor.label} CLI exited with code ${code}`);
    this.events.onStatus(this.agentId, "review");
  }

  async pause() {
    this.events.onStatus(this.agentId, "waiting");
  }

  async resume(decision?: Resolution) {
    if (this.gate) {
      const gate = this.gate;
      this.gate = undefined;
      if (decision?.action === "reject") {
        this.events.onLog(this.agentId, "operator rejected — not starting the runner.");
        this.fail();
      } else {
        if (decision?.action === "modify" && decision.guidance) {
          this.events.onLog(this.agentId, `operator guidance: ${decision.guidance}`);
        }
        this.spawnProcess();
      }
      gate(decision);
    }
  }

  async message(text: string) {
    // One-shot CLI runs have no live chat channel; acknowledge so callers don't hang.
    this.events.onChatReply(this.agentId, `(${this.vendor.label}) chat isn't available during a batch CLI run — noted: "${text}".`);
  }

  async stop() {
    this.finished = true;
    this.clearTimers();
    this.child?.kill("SIGTERM");
  }
}

/** A RunnerProvider backed by a vendor's agentic CLI. One instance per vendor. */
export class CliRunnerProvider implements RunnerProvider {
  readonly id: ProviderId;
  constructor(private vendor: CliRunnerSpec) {
    this.id = vendor.id;
  }

  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    const bin = process.env[this.vendor.cmdEnv] || this.vendor.bin;
    const available = await resolveBinary(bin);
    return new CliRunnerHandle(spec, events, this.vendor, available ? bin : null);
  }
}
