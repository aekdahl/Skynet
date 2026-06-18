// ─── Gemini CLI runner ────────────────────────────────────────────────────
// A real RunnerProvider backed by Google's Gemini CLI (`gemini`). Selected via
// RUNNER=gemini. We run the task headless in the agent's worktree (`gemini -p`)
// and stream its output onto the runner-sdk control contract — prose → log,
// tool/command lines → progress, and a tool-confirmation prompt → a HITL
// approval gate answered over stdin (y/N) on resume.
//
// Gemini emits human-readable text by default and structured JSON when asked
// (`--output-format json`), so the parser handles both: JSON lines first, then a
// text-line fallback that recognises tool calls and confirmation prompts. Binary
// and argv are env-overridable (GEMINI_BIN, GEMINI_EXTRA_ARGS). Missing binary
// or an auth failure falls back cleanly (see cli-runner.ts); the default
// RUNNER=mock path never imports this module.

import type { ProviderId, Resolution } from "@skynet/shared";
import {
  CliRunnerProvider,
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

function approvalRaise(command: string): HitlRaise {
  return {
    kind: "approval",
    title: "Approve: Gemini action",
    why: "Gemini unit is requesting confirmation before continuing.",
    risk: "medium",
    command: command || null,
    options: null,
    recommended: null,
    steps: null,
    diff: null,
  };
}

const gemini: CliVendor = {
  id: "gemini" as ProviderId,
  bin: BIN,
  installHint: "Install with `npm i -g @google/gemini-cli` and authenticate (`gemini`, then sign in).",

  buildArgs(spec: StartSpec): string[] {
    // `-p` runs the prompt non-interactively in the cwd; `-m` selects the model.
    return ["-m", spec.model, ...EXTRA, "-p", spec.task];
  },

  parseLine(line: string, ctx: ParseCtx): CliEvent {
    // Structured mode (when --output-format json / stream-json is configured).
    if (line.startsWith("{")) {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        const type = String(obj.type ?? "");
        if (/confirm|approval|permission/i.test(type)) {
          const cmd = typeof obj.command === "string" ? obj.command : String(obj.name ?? "");
          ctx.awaitingConfirm = true;
          return { kind: "approval", raise: approvalRaise(cmd) };
        }
        if (/tool|function|command|action/i.test(type)) {
          const label = String(obj.name ?? obj.command ?? type);
          return { kind: "tool", label };
        }
        const text = obj.response ?? obj.text ?? obj.content ?? obj.message;
        if (typeof text === "string" && text.trim()) return { kind: "chat", text: text.trim() };
        return { kind: "ignore" };
      } catch {
        /* fall through to text handling */
      }
    }

    // Text mode.
    if (CONFIRM_RE.test(line)) {
      ctx.awaitingConfirm = true;
      return { kind: "approval", raise: approvalRaise(line) };
    }
    if (TOOL_RE.test(line)) return { kind: "tool", label: line };
    return { kind: "log", line };
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
