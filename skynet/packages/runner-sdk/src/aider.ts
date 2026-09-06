// ─── Aider CLI runner ───────────────────────────────────────────────────────
// A real RunnerProvider backed by the Aider CLI (`aider`, open-source terminal
// pair-programmer — https://aider.chat, https://github.com/Aider-AI/aider).
// Selected via RUNNER=aider. We drive Aider's documented one-shot scripting
// mode headless in the agent's worktree:
//
//   aider --message <task> --yes-always --no-pretty --no-stream
//         --no-check-update --no-analytics --no-auto-commits --no-dirty-commits
//         --model <provider/model>
//
// UNVERIFIED LIVE (unlike every sibling file in this directory): no Aider
// binary or working provider key was available while writing this adapter.
// Everything below is inferred from Aider's own published CLI reference
// (aider.chat/docs/scripting.html, aider.chat/docs/config/options.html) and
// known litellm model-string conventions, NOT a captured real run. Confirm
// the flag names, the usage-line format, and the auto-commit behavior against
// a real install before relying on this in production — the same "verify
// live" bar every other adapter here already clears.
//
// Known capability gap (not a parsing bug — a real fit gap against Skynet's
// model, see docs/runner-catalog.md): per
// github.com/Aider-AI/aider/issues/3903 (open as of writing), `--yes-always`
// auto-confirms proposed EDITS but does NOT auto-run shell commands the model
// proposes — those are silently skipped, not even surfaced as a prompt. A
// task whose completion depends on Aider itself running a build/lint/test
// command will not get that command run; only file edits land. Skynet's own
// post-run diff review still sees whatever edits DID happen, same as any
// other adapter, but this is a real limitation to know about, not a bug here.
//
// No structured output: Aider has no JSON/NDJSON mode (absent from its full
// CLI reference) — stdout is plain text for a human terminal, so
// `--no-pretty --no-stream` asks for the cleanest plain text a line parser can
// work with (no ANSI color codes, no token-by-token flicker). Usage is
// reported as one documented end-of-turn text line:
//   "Tokens: 2.3k sent, 191 received. Cost: $0.01 message, $0.03 session."
// parsed by USAGE_LINE_RE below (abbreviated-count aware: "2.3k" → 2300).
// Everything else is a plain log line; a line naming a file edit ("Applied
// edit to <path>", "Editing <path>") is promoted to a `tool` event so the
// run's progress bar moves, the same way Hermes' regex-tagged lines do.
//
// No live HITL gate: `--yes-always` runs fully non-interactive by design (the
// whole point of a scriptable mode) — like Hermes/OpenCode/Kimi, Skynet's own
// post-run diff review gates the merge, not this CLI.
//
// Auto-commit is turned OFF (`--no-auto-commits --no-dirty-commits`) so Aider
// leaves its edits as an uncommitted diff in the worktree, matching every
// other adapter's contract with the orchestrator (which commits + reviews the
// diff itself after the run finishes). Left on, Aider's own default (commit
// every edit as it's made, and commit pre-existing dirty state first) would
// hand the orchestrator an already-clean worktree and no diff to review.
//
// Model strings follow Aider's own litellm-style "<provider>/<model>" slugs
// (e.g. "anthropic/claude-sonnet-5", "openai/gpt-5.2") — passed via `--model`,
// the same convention OpenCode already uses. The per-workspace key is
// injected as ANTHROPIC_API_KEY (Aider's docs default to Anthropic/Claude
// models in their own examples), the same default OpenCode makes; an operator
// on a different backend relies on that backend's own key already being in
// the ambient environment, same fallback every provider-agnostic adapter here
// uses (see opencode.ts, hermes.ts).
//
// Binary and extra argv are env-overridable (SKYNET_AIDER_BIN,
// AIDER_EXTRA_ARGS). Missing binary or an auth failure falls back cleanly via
// the CLI base (cli-runner.ts); the default RUNNER=mock path never imports
// this module.

import type { ProviderId, Resolution, Usage } from "@skynet/shared";
import { CliRunnerProvider, type CliEvent, type CliVendor, type ParseCtx } from "./cli-runner.js";
import type { StartSpec } from "./types.js";

const BIN = process.env.SKYNET_AIDER_BIN || "aider";
const EXTRA = (process.env.AIDER_EXTRA_ARGS ?? "").split(" ").filter(Boolean);

// Aider's own litellm-style "provider/model" slugs; pass through, dropping a
// blank so the CLI falls back to its configured default.
const mapModel = (m: string): string | undefined => (m.trim() ? m.trim() : undefined);

// A file-edit line ("Applied edit to foo.py", "Editing foo.py") — bump
// progress the same way Hermes' TOOL_RE promotes tool-ish lines.
const EDIT_RE = /^(?:applied edit to|editing|wrote|created)\b/i;

// "Tokens: 2.3k sent, 191 received. Cost: $0.01 message, $0.03 session." —
// Aider's documented end-of-turn usage line. Abbreviated counts ("2.3k") are
// common for larger contexts; parseAbbrev below expands them. The session
// total (not the per-message figure) is reported as costUsd when present.
const USAGE_LINE_RE =
  /^Tokens:\s*([\d.]+k?)\s*sent,\s*([\d.]+k?)\s*received\.(?:\s*Cost:\s*\$([\d.]+)\s*message(?:,\s*\$([\d.]+)\s*session)?\.)?/i;

function parseAbbrev(s: string): number {
  const m = /^([\d.]+)(k)?$/i.exec(s.trim());
  if (!m) return 0;
  const n = parseFloat(m[1]!);
  return Math.round(m[2] ? n * 1000 : n);
}

function parseUsageLine(line: string): Usage | null {
  const m = USAGE_LINE_RE.exec(line.trim());
  if (!m) return null;
  const sessionCost = m[4] ?? m[3]; // prefer the session running total when present
  return {
    inputTokens: parseAbbrev(m[1]!),
    outputTokens: parseAbbrev(m[2]!),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: sessionCost ? parseFloat(sessionCost) : null,
    turns: 0,
    durationMs: null,
  };
}

export const aider: CliVendor = {
  id: "aider" as ProviderId,
  bin: BIN,
  installHint:
    "Install with `python -m pip install aider-install && aider-install` (or `pipx install aider-chat`) and set a provider key (e.g. ANTHROPIC_API_KEY).",

  env(spec: StartSpec): Record<string, string> {
    // Per-workspace key injected by the orchestrator; empty → inherit ambient env.
    return spec.apiKey ? { ANTHROPIC_API_KEY: spec.apiKey } : {};
  },

  buildArgs(spec: StartSpec): string[] {
    const model = mapModel(spec.model);
    return [
      "--message",
      spec.task,
      "--yes-always",
      "--no-pretty",
      "--no-stream",
      "--no-check-update",
      "--no-analytics",
      "--no-auto-commits",
      "--no-dirty-commits",
      ...(model ? ["--model", model] : []),
      ...EXTRA,
    ];
  },

  parseLine(line: string): CliEvent {
    const usage = parseUsageLine(line);
    if (usage) return { kind: "usage", usage };
    const trimmed = line.trim();
    if (EDIT_RE.test(trimmed)) return { kind: "tool", label: trimmed };
    return { kind: "log", line };
  },

  // `--message` is one-shot and headless — no live decision channel and no
  // mid-run chat (see file header).
  encodeDecision(_decision: Resolution | undefined, _ctx: ParseCtx): string | null {
    return null;
  },
  encodeMessage(): string | null {
    return null;
  },
};

export class AiderRunnerProvider extends CliRunnerProvider {
  readonly id: ProviderId = "aider";
  protected vendor(): CliVendor {
    return aider;
  }
}
