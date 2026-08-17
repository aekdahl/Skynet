// ─── OpenCode CLI runner ───────────────────────────────────────────────────
// A real RunnerProvider backed by the OpenCode CLI (`opencode`, npm package
// `opencode-ai` — https://opencode.ai). Selected via RUNNER=opencode. We drive
// `opencode run --format json` headless in the agent's worktree: a real NDJSON
// event stream on stdout (verified live against opencode-ai@1.18.18, both a
// plain reply and a tool-using task — bash + a file write), mapped onto the
// runner-sdk control contract the same way codex/gemini's structured modes are.
//
// Real captured event shapes (top-level `type`, payload under `part`):
//   {"type":"step_start", "part":{"type":"step-start", ...}}                  — a turn begins; no useful content
//   {"type":"text",       "part":{"type":"text","text":"…"}}                  — assistant prose
//   {"type":"tool_use",   "part":{"type":"tool","tool":"bash"|"write"|…,
//                                  "state":{"status":"completed"|"error",
//                                           "title":"echo hi"|"greet.txt",
//                                           "error"?:"…"}}}                    — one tool call, already resolved
//   {"type":"step_finish","part":{"type":"step-finish","reason":"stop"|"tool-calls",
//                                  "tokens":{"input":N,"output":N,…},"cost":N}} — PER-STEP usage, not cumulative
//   {"type":"error",      "error":{"name":"APIError","data":{"message":"…"}}}  — fatal; process then exits 1
//
// `step_finish.tokens`/`cost` are per-step (verified: a 2-step run reports two
// small deltas, not a growing running total), so unlike Codex's session-total
// event we accumulate them ourselves in `ctx.usage` and report the running sum
// each time — `onUsage` is documented as "the cumulative totals for the run".
// `usageFromJson` (its `input`/`output`/`cost` aliases) already reads `part`
// directly with no vendor-specific unwrapping needed.
//
// No live HITL gate: `opencode run`'s non-interactive mode has no
// stdin-answerable permission protocol — verified live, a project with
// `permission: {bash: "ask"}` gets an immediate "auto-rejecting" on stderr with
// NO corresponding stdout JSON event, not a pause. `--auto` (OpenCode's own
// "approve unless explicitly denied" flag) avoids that silent auto-reject —
// same tradeoff Cursor's runner makes with `--force`. So, like Hermes, there is
// no live HITL gate here; Skynet's own post-run diff review gates the merge.
//
// Model strings are OpenCode's own `provider/model` slugs (e.g.
// `anthropic/claude-sonnet-5`, confirmed via `opencode models anthropic` with a
// real key) — passed straight through, mirroring Hermes' model-slug handling.
// The credential Skynet stores for this provider is injected as ANTHROPIC_API_KEY
// (OpenCode's own docs: "Although Anthropic is recommended…", and it picks up a
// non-empty ANTHROPIC_API_KEY automatically) — provider-agnostic like Hermes,
// just defaulted to Anthropic rather than OpenRouter.
//
// Binary and extra argv are env-overridable (SKYNET_OPENCODE_BIN,
// OPENCODE_EXTRA_ARGS). Missing binary or an auth failure falls back cleanly
// via the CLI base (cli-runner.ts); the default RUNNER=mock path never imports
// this module.

import type { ProviderId, Resolution, Usage } from "@skynet/shared";
import { CliRunnerProvider, usageFromJson, type CliEvent, type CliVendor, type ParseCtx } from "./cli-runner.js";
import type { StartSpec } from "./types.js";

const BIN = process.env.SKYNET_OPENCODE_BIN || "opencode";
const EXTRA = (process.env.OPENCODE_EXTRA_ARGS ?? "").split(" ").filter(Boolean);

// OpenCode's own `provider/model` slugs; pass through, dropping a blank so the
// CLI falls back to its configured default.
const mapModel = (m: string): string | undefined => (m.trim() ? m.trim() : undefined);

function addUsage(ctx: ParseCtx, delta: Usage): Usage {
  const prev = (ctx.usage as Usage | undefined) ?? { inputTokens: 0, outputTokens: 0, costUsd: null, turns: 0, durationMs: null };
  const next: Usage = {
    inputTokens: prev.inputTokens + delta.inputTokens,
    outputTokens: prev.outputTokens + delta.outputTokens,
    costUsd: delta.costUsd == null && prev.costUsd == null ? null : (prev.costUsd ?? 0) + (delta.costUsd ?? 0),
    turns: prev.turns + 1,
    durationMs: prev.durationMs, // not reported per-step by opencode
  };
  ctx.usage = next;
  return next;
}

/** Best-effort message out of an `{type:"error", error:{...}}` event. */
function errorMessage(obj: Record<string, unknown>): string {
  const err = obj.error as Record<string, unknown> | undefined;
  const data = err?.data as Record<string, unknown> | undefined;
  const msg = data?.message ?? err?.message;
  return typeof msg === "string" && msg.trim() ? msg.trim() : "opencode reported an error";
}

export const opencode: CliVendor = {
  id: "opencode" as ProviderId,
  bin: BIN,
  installHint: "Install with `npm i -g opencode-ai` and authenticate (`opencode auth login`), or set a provider key (e.g. ANTHROPIC_API_KEY).",
  // Verified live: `opencode run` hangs indefinitely producing zero output when
  // spawned with Node's default (open) stdin pipe — it completes instantly both
  // from an interactive shell (stdin inherited) and when stdin is explicitly
  // closed at spawn time. See CliVendor.closeStdin's doc comment.
  closeStdin: true,

  env(spec: StartSpec): Record<string, string> {
    // Per-workspace key injected by the orchestrator; empty → inherit ambient env.
    return spec.apiKey ? { ANTHROPIC_API_KEY: spec.apiKey } : {};
  },

  buildArgs(spec: StartSpec): string[] {
    // `run` = non-interactive, one-shot; `--format json` = the real NDJSON event
    // stream (see file header); `--auto` avoids a project's own permission
    // config silently auto-rejecting a tool call with no way to resolve it.
    const model = mapModel(spec.model);
    return ["run", "--format", "json", "--auto", ...(model ? ["-m", model] : []), ...EXTRA, spec.task];
  },

  parseLine(line: string, ctx: ParseCtx): CliEvent {
    if (!line.startsWith("{")) return { kind: "log", line };
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return { kind: "log", line };
    }
    const type = String(obj.type ?? "");
    const part = (obj.part as Record<string, unknown> | undefined) ?? {};

    if (type === "error") return { kind: "log", line: `error: ${errorMessage(obj)}` };

    if (type === "text") {
      const text = part.text;
      return typeof text === "string" && text.trim() ? { kind: "chat", text: text.trim() } : { kind: "ignore" };
    }

    if (type === "tool_use") {
      const tool = typeof part.tool === "string" ? part.tool : "tool";
      const state = (part.state as Record<string, unknown> | undefined) ?? {};
      const label = typeof state.title === "string" && state.title.trim() ? state.title.trim() : tool;
      if (state.status === "error") {
        return { kind: "log", line: `✕ ${label}: ${typeof state.error === "string" ? state.error : "failed"}` };
      }
      return { kind: "tool", label };
    }

    if (type === "step_finish") {
      const delta = usageFromJson(part);
      if (delta) return { kind: "usage", usage: addUsage(ctx, delta) };
      return { kind: "ignore" };
    }

    // "step_start" and anything not yet seen — no useful content to surface.
    return { kind: "ignore" };
  },

  // `run` is one-shot and headless — no live decision channel (see file header).
  encodeDecision(_decision: Resolution | undefined, _ctx: ParseCtx): string | null {
    return null;
  },
  encodeMessage(): string | null {
    return null;
  },
};

export class OpenCodeRunnerProvider extends CliRunnerProvider {
  readonly id: ProviderId = "opencode";
  protected vendor(): CliVendor {
    return opencode;
  }
}
