// ─── Hermes CLI runner ─────────────────────────────────────────────────────
// A real RunnerProvider backed by Nous Research's Hermes Agent CLI (`hermes`).
// Selected via RUNNER=hermes. We drive the documented one-shot entry point
// (`hermes -z "<task>"`) headless in the agent's worktree — "-z" is Hermes' pure
// one-shot mode that prints only the agent's final response (no banner, spinner,
// or tool previews), which a parent script can cleanly capture.
//
//   hermes -z "<task>" -m <model>
//
// The model string is Hermes' `provider/model` slug (e.g. anthropic/claude-…),
// passed via `-m`; a per-workspace key is injected as OPENROUTER_API_KEY (Hermes'
// recommended provider) with the ambient env still carrying any others. Because
// "-z" is non-interactive it never blocks on a confirmation prompt, so there is
// no live HITL gate here — Skynet's own post-run diff review gates the merge.
//
// Binary and extra argv are env-overridable (SKYNET_HERMES_BIN, HERMES_EXTRA_ARGS).
// Missing binary or an auth failure falls back cleanly via the CLI base
// (cli-runner.ts); the default RUNNER=mock path never imports this module.

import type { ProviderId, Resolution } from "@skynet/shared";
import { CliRunnerProvider, type CliEvent, type CliVendor, type ParseCtx } from "./cli-runner.js";
import type { StartSpec } from "./types.js";

const BIN = process.env.SKYNET_HERMES_BIN || "hermes";
const EXTRA = (process.env.HERMES_EXTRA_ARGS ?? "").split(" ").filter(Boolean);

// Hermes model strings are `provider/model` slugs; pass through, dropping a
// blank so the CLI falls back to its configured default.
const mapModel = (m: string): string | undefined => (m.trim() ? m.trim() : undefined);

// Lines that look like a tool / shell / edit is running — bump progress.
const TOOL_RE = /^(?:\s*[▸✦●>*-]\s*)?(running|executing|tool|shell|run|edit|write|read|patch|apply|search|fetch)\b/i;

const hermes: CliVendor = {
  id: "hermes" as ProviderId,
  bin: BIN,
  installHint: "Install the Hermes Agent CLI (https://hermes-agent.nousresearch.com) and set a provider key (e.g. OPENROUTER_API_KEY), or set SKYNET_HERMES_BIN.",

  env(spec: StartSpec): Record<string, string> {
    // Per-workspace key injected by the orchestrator → Hermes' recommended
    // provider. Empty → inherit whatever provider key is already in the env.
    return spec.apiKey ? { OPENROUTER_API_KEY: spec.apiKey } : {};
  },

  buildArgs(spec: StartSpec): string[] {
    // `-z` takes the prompt as its value; model flag follows (mirrors the
    // documented `hermes -z "…" --model …` form).
    const model = mapModel(spec.model);
    return ["-z", spec.task, ...(model ? ["-m", model] : []), ...EXTRA];
  },

  parseLine(line: string): CliEvent {
    // `-z` emits the final response as plain text — no structured stream. Treat
    // tool-ish lines as progress and everything else as log; the base reports
    // completion when the process exits 0.
    if (TOOL_RE.test(line)) return { kind: "tool", label: line };
    return { kind: "log", line };
  },

  // One-shot `-z` runs headless — no live decision channel and no mid-run chat.
  encodeDecision(_decision: Resolution | undefined, _ctx: ParseCtx): string | null {
    return null;
  },
  encodeMessage(): string | null {
    return null;
  },
};

export class HermesRunnerProvider extends CliRunnerProvider {
  readonly id: ProviderId = "hermes";
  protected vendor(): CliVendor {
    return hermes;
  }
}
