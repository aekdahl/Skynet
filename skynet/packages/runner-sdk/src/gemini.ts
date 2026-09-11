// ─── Gemini CLI runner ────────────────────────────────────────────────────
// A real RunnerProvider backed by Google's Gemini CLI (`gemini`). Selected via
// RUNNER=gemini. We run the task headless in the agent's worktree (`gemini -p`)
// and stream its output onto the runner-sdk control contract — prose → log,
// tool/command lines → progress, and a tool-confirmation prompt → a HITL
// approval gate answered over stdin (y/N) on resume.
//
// Gemini emits human-readable text by default; we request `--output-format
// stream-json` instead — a real NDJSON event per line, including a final
// `result` event with flat token/duration totals (`stats.{input_tokens,
// output_tokens,duration_ms}`, verified against google-gemini/gemini-cli's
// StreamJsonFormatter) — so usage is actually reported, not just logged as
// prose. Assistant text arrives as a run of `message`+`delta:true` chunks (no
// distinct final event — see parseLine's flushDelta) and is previewed live via
// onLogDelta while still landing as one persisted line, same as Claude's
// token-by-token streaming. The parser still falls back to text-line
// heuristics (tool calls, confirmation prompts) for anything that isn't valid
// JSON, in case an operator overrides GEMINI_EXTRA_ARGS back to text mode.
// Binary and argv are env-overridable (GEMINI_BIN, GEMINI_EXTRA_ARGS — a later
// --output-format in EXTRA wins). Missing binary or an auth failure falls back
// cleanly (see cli-runner.ts); the default RUNNER=mock path never imports this
// module.
//
// Opt-in MCP tooling (spec.browser, spec.mcpServers): Gemini's MCP servers are
// FILE-based only — there's no per-invocation flag (verified live against
// gemini-cli 0.55.1: --help has nothing config-override-shaped; `gemini mcp
// add --scope project` is the only way in, and it just writes
// .gemini/settings.json's mcpServers key). prepareWorktree writes that file
// directly — same shape `gemini mcp add` produces — into the run's OWN
// worktree (project scope), so it never touches the operator's global
// ~/.gemini/settings.json and is naturally cleaned up when the worktree is
// retired. Remote (url/headers) user-configured servers are emitted in the
// same `{type:"http", url, headers}` shape Claude's SDK accepts — the
// standard MCP-client JSON convention — but that shape isn't independently
// verified against gemini-cli's own schema; a stdio server is guaranteed to
// work, a remote one is best-effort.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderId, Resolution } from "@skynet/shared";
import {
  CliRunnerProvider,
  mergeMcpConfig,
  usageFromJson,
  type CliEvent,
  type CliVendor,
  type ParseCtx,
} from "./cli-runner.js";
import type { HitlRaise, StartSpec } from "./types.js";

const BIN = process.env.GEMINI_BIN || "gemini";
const EXTRA = (process.env.GEMINI_EXTRA_ARGS ?? "").split(" ").filter(Boolean);

// Lines Gemini prints when it wants the user to confirm a tool/edit.
const CONFIRM_RE = /\b(allow|apply this|proceed\??|confirm|\(y\/n\)|\[y\/n\]|yes\/no)\b/i;
// Lines that indicate a tool / shell / edit is being run.
const TOOL_RE = /^(?:\s*[▸✦●>*-]\s*)?(running|executing|tool|shell|run_shell|edit|write_file|replace|read_file|web_?fetch|google_search)\b/i;

/** Flush any buffered delta chunks (ctx.geminiDelta) as ONE persisted `chat`
 *  line — the "complete text still lands once the message finishes" half of
 *  the onLogDelta contract. Called whenever a non-delta event line arrives,
 *  since that's the only boundary the wire actually gives us (see parseLine). */
function flushDelta(ctx: ParseCtx): CliEvent[] {
  const buf = ctx.geminiDelta as string | undefined;
  if (!buf) return [];
  ctx.geminiDelta = undefined;
  return [{ kind: "chat", text: buf }];
}

// Prepend a flush ahead of the current line's own event — but stay a single
// bare CliEvent (not a 1-element array) in the overwhelmingly common case of
// no pending flush, so callers/tests that don't care about delta-buffering
// see the same shape as before this feature existed.
function withFlush(flush: CliEvent[], ev: CliEvent): CliEvent | CliEvent[] {
  return flush.length ? [...flush, ev] : ev;
}

function approvalRaise(command: string): HitlRaise {
  return {
    kind: "approval",
    title: "Approve: Gemini action",
    why: "Gemini unit is requesting confirmation before continuing.",
    risk: "medium",
    command: command || null,
    options: null,
    recommended: null,
    rationale: null,
    steps: null,
    diff: null,
  };
}

export const gemini: CliVendor = {
  id: "gemini" as ProviderId,
  bin: BIN,
  installHint: "Install with `npm i -g @google/gemini-cli` and authenticate (`gemini`, then sign in).",

  env(spec: StartSpec): Record<string, string> {
    // Per-workspace key injected by the orchestrator; empty → inherit ambient env.
    return spec.apiKey ? { GEMINI_API_KEY: spec.apiKey, GOOGLE_API_KEY: spec.apiKey } : {};
  },

  prepareWorktree(spec: StartSpec, cwd: string): void {
    if (!spec.browser && !spec.mcpServers?.length) return;
    const dir = join(cwd, ".gemini");
    const file = join(dir, "settings.json");
    // Merge onto whatever the repo itself commits at .gemini/settings.json (if
    // anything) rather than clobbering it — this only ever touches the run's
    // own worktree, never the operator's ~/.gemini/settings.json.
    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      /* no existing file, or unreadable — start fresh */
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(mergeMcpConfig(settings, spec), null, 2));
  },

  buildArgs(spec: StartSpec): string[] {
    // `-p` runs the prompt non-interactively in the cwd; `-m` selects the model.
    // `--output-format stream-json` is the default so usage is actually
    // reported (see the file header) — placed before EXTRA so an operator's
    // own GEMINI_EXTRA_ARGS can still override it back to text/json.
    return ["-m", spec.model, "--output-format", "stream-json", ...EXTRA, "-p", spec.task];
  },

  parseLine(line: string, ctx: ParseCtx): CliEvent | CliEvent[] {
    // Structured mode (when --output-format json / stream-json is configured).
    if (line.startsWith("{")) {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        const type = String(obj.type ?? "");

        // Token-level streaming: a `message` event with `delta: true` carries
        // ONE incremental chunk of assistant text, not an accumulated snapshot
        // — verified live against gemini-cli's nonInteractiveCli.ts (the `-p`
        // non-interactive path this runner drives): each `GeminiEventType.
        // Content` chunk is emitted immediately as `{type:"message",
        // role:"assistant", content:<chunk>, delta:true}`. Unlike Claude's SDK,
        // there is NO separate final "message complete" event on the wire —
        // preview each chunk live, and buffer it so the complete text still
        // lands as exactly one persisted line once the stream moves past it
        // (flushDelta, below), matching the onLogDelta contract.
        if (type === "message" && obj.role === "assistant" && obj.delta === true && typeof obj.content === "string") {
          ctx.geminiDelta = ((ctx.geminiDelta as string | undefined) ?? "") + obj.content;
          return { kind: "delta", text: obj.content };
        }
        const flush = flushDelta(ctx);

        if (/confirm|approval|permission/i.test(type)) {
          const cmd = typeof obj.command === "string" ? obj.command : String(obj.name ?? "");
          ctx.awaitingConfirm = true;
          return withFlush(flush, { kind: "approval", raise: approvalRaise(cmd) });
        }
        if (/tool|function|command|action/i.test(type)) {
          const label = String(obj.name ?? obj.command ?? type);
          return withFlush(flush, { kind: "tool", label });
        }
        // Best-effort token/cost totals (stats/usage events in JSON mode).
        if (/stat|usage|token|metadata/i.test(type) || obj.usage || obj.stats) {
          const usage = usageFromJson(obj);
          if (usage) return withFlush(flush, { kind: "usage", usage });
        }
        const text = obj.response ?? obj.text ?? obj.content ?? obj.message;
        if (typeof text === "string" && text.trim()) return withFlush(flush, { kind: "chat", text: text.trim() });
        return flush.length ? flush : { kind: "ignore" };
      } catch {
        /* fall through to text handling */
      }
    }

    // Text mode.
    const flush = flushDelta(ctx);
    if (CONFIRM_RE.test(line)) {
      ctx.awaitingConfirm = true;
      return withFlush(flush, { kind: "approval", raise: approvalRaise(line) });
    }
    if (TOOL_RE.test(line)) return withFlush(flush, { kind: "tool", label: line });
    return withFlush(flush, { kind: "log", line });
  },

  encodeDecision(decision: Resolution | undefined, ctx: ParseCtx): string | null {
    if (!ctx.awaitingConfirm) return null;
    ctx.awaitingConfirm = false;
    // Gemini's confirmation prompts read a y/N answer from stdin.
    const approved = !(decision?.action === "reject" || decision?.action === "modify");
    return approved ? "y" : "n";
  },

  // Non-interactive `-p` runs are one-shot — no live chat channel.
  encodeMessage(): string | null {
    return null;
  },
};

export class GeminiRunnerProvider extends CliRunnerProvider {
  readonly id: ProviderId = "gemini";
  protected vendor(): CliVendor {
    return gemini;
  }
}
