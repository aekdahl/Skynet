// ─── Kimi Code CLI runner ───────────────────────────────────────────────────
// A real RunnerProvider backed by Moonshot AI's Kimi Code CLI (`kimi`, native
// single-binary install — https://github.com/MoonshotAI/kimi-code, docs at
// https://moonshotai.github.io/kimi-code/). Selected via RUNNER=kimi. We drive
// `kimi -p <task> --output-format stream-json` headless in the agent's
// worktree: a real NDJSON event stream on stdout (verified live against
// kimi-code 0.38.0, installed via the official install.sh — a plain reply, a
// successful bash call, a FAILING bash call, and a file write, each captured
// from real runs), mapped onto the runner-sdk control contract the same way
// opencode's structured mode is (see opencode.ts).
//
// Real captured event shapes (one JSON object per stdout line):
//   {"role":"meta","type":"system.version","version":"0.38.0"}                — banner; no useful content
//   {"role":"assistant","tool_calls":[{"type":"function","id":"toolu_…",
//                                       "function":{"name":"Bash","arguments":"{\"command\":\"…\"}"}}]}
//                                                                             — one or more tool calls, about to run
//   {"role":"tool","tool_call_id":"toolu_…","content":"…"}                    — a tool's result (success AND failure
//                                                                                both land here as plain text, e.g.
//                                                                                "Command failed with exit code: 1." —
//                                                                                no separate error boolean was ever
//                                                                                observed, verified live with `false`)
//   {"role":"assistant","content":"…"}                                       — final/plain assistant prose
//   {"role":"meta","type":"session.resume_hint","session_id":"…",
//                    "command":"kimi -r session_…","content":"…"}            — trailer; no useful content
// A fatal error (bad key, etc.) never appears as a JSON line at all — it's a
// stderr message plus a non-zero exit code (verified live with a rejected key:
// `error: failed to run prompt: provider.auth_error: 401 {...}`, exit 1), which
// cli-runner.ts's base already treats as a failure via the generic
// `child.on("exit")` handler — nothing kimi-specific to parse there.
//
// No usage/cost reported: per the CLI's own docs ("Thinking content is not
// written to JSONL... tool progress ... still written to stderr") and every
// live capture above, `-p --output-format stream-json` never emits a token or
// cost field anywhere — `usageFromJson` is called defensively but is expected
// to always return null for this vendor; `onUsage` simply never fires. Honest
// gap, not a bug: nothing here fabricates a usage row.
//
// No live HITL gate: `-p` mode cannot even be combined with `--yolo`/`--auto`
// (verified live: `kimi -p … --auto` / `--yolo` both hard-error with "Cannot
// combine --prompt with --auto/--yolo" before spawning anything) because
// print mode already runs under a fixed `auto` permission policy by design —
// confirmed live, a Bash tool call executes with zero approval prompt and no
// stdin read. So, like Hermes/OpenCode, there is no live decision channel here;
// Skynet's own post-run diff review gates the merge, not this CLI.
//
// Multi-provider model routing: Kimi Code CLI can talk to Moonshot's own `kimi`
// backend OR proxy straight to `anthropic`/`openai` (its docs: "works out of
// the box with Moonshot AI's Kimi models and can also be configured to use
// other compatible providers") — but per its own docs, provider credentials are
// NEVER read from ambient shell env vars, with exactly one documented
// exception: the `KIMI_MODEL_*` env family synthesizes a temporary provider in
// memory for one launch, which IS read from the environment
// (KIMI_MODEL_NAME/KIMI_MODEL_API_KEY/KIMI_MODEL_PROVIDER_TYPE). That's the
// only channel this file can use to inject Skynet's per-workspace credential
// without writing config.toml. `spec.model` is therefore "<type>/<id>" to pick
// a non-default backend (verified live end-to-end against `anthropic` with a
// real ANTHROPIC_API_KEY — a plain reply, a successful tool call, a failing
// tool call, and a file write, matching the exact shapes above) or a bare model
// id for Kimi's own `kimi` backend (KIMI_MODEL_PROVIDER_TYPE defaults to
// "kimi" — not independently verified live here for lack of a Moonshot key,
// but it's the CLI's own documented default and mechanically identical to the
// anthropic path already verified). `google-genai`/`vertexai` are NOT
// supported by the KIMI_MODEL_* channel per its docs, so only kimi/anthropic/
// openai prefixes are recognized.
//
// No closeStdin needed: verified live with Node's default (open, piped) stdin
// — a `-p` run completes normally in a few seconds, unlike OpenCode's
// documented hang-on-open-stdin bug. cwd resolution also verified correct
// (writes land in the real spawn `cwd`, not a stale inherited `PWD`).
//
// Binary and extra argv are env-overridable (SKYNET_KIMI_BIN, KIMI_EXTRA_ARGS).
// Missing binary or an auth failure falls back cleanly via the CLI base
// (cli-runner.ts); the default RUNNER=mock path never imports this module.

import type { ProviderId, Resolution } from "@skynet/shared";
import { CliRunnerProvider, usageFromJson, type CliEvent, type CliVendor, type ParseCtx } from "./cli-runner.js";
import type { StartSpec } from "./types.js";

const BIN = process.env.SKYNET_KIMI_BIN || "kimi";
const EXTRA = (process.env.KIMI_EXTRA_ARGS ?? "").split(" ").filter(Boolean);

const MODEL_PROVIDER_TYPES = new Set(["kimi", "anthropic", "openai"]);

/** Split "<type>/<id>" into the CLI's KIMI_MODEL_PROVIDER_TYPE + KIMI_MODEL_NAME,
 *  defaulting to the "kimi" (Moonshot-native) backend when no recognized
 *  prefix is present — matches KIMI_MODEL_PROVIDER_TYPE's own documented
 *  default. An unrecognized prefix (e.g. a bare model id containing a slash)
 *  is treated as having no prefix at all, so it's passed through whole rather
 *  than silently truncated. */
function parseModel(model: string): { providerType: string; name: string } {
  const trimmed = model.trim();
  const slash = trimmed.indexOf("/");
  if (slash > 0) {
    const prefix = trimmed.slice(0, slash).toLowerCase();
    const rest = trimmed.slice(slash + 1).trim();
    if (MODEL_PROVIDER_TYPES.has(prefix) && rest) return { providerType: prefix, name: rest };
  }
  return { providerType: "kimi", name: trimmed };
}

/** Best-effort label for a tool call from its (JSON-string) arguments, falling
 *  back to the bare function name when arguments don't parse or carry nothing
 *  recognizable. Verified live shapes: Bash → {command}, Write → {path,content}. */
function toolLabel(name: string, rawArgs: unknown): string {
  if (typeof rawArgs === "string") {
    try {
      const args = JSON.parse(rawArgs) as Record<string, unknown>;
      const detail = args.command ?? args.path ?? args.file_path ?? args.query;
      if (typeof detail === "string" && detail.trim()) return detail.trim();
    } catch {
      /* not JSON — fall through to the bare name */
    }
  }
  return name;
}

export const kimi: CliVendor = {
  id: "kimi" as ProviderId,
  bin: BIN,
  installHint:
    "Install with the official script (`curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash`) and authenticate (`kimi login`), or set a provider key (KIMI_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY).",

  env(spec: StartSpec): Record<string, string> {
    // Per-workspace key injected by the orchestrator; empty → inherit ambient
    // env (no KIMI_MODEL_* vars set, so the CLI falls back to its own
    // config.toml, e.g. after a `kimi login`).
    if (!spec.apiKey) return {};
    const { providerType, name } = parseModel(spec.model);
    return {
      KIMI_MODEL_NAME: name,
      KIMI_MODEL_API_KEY: spec.apiKey,
      KIMI_MODEL_PROVIDER_TYPE: providerType,
    };
  },

  buildArgs(spec: StartSpec): string[] {
    // `-p` = non-interactive, one-shot, fixed `auto` permission (see file
    // header — cannot be combined with --yolo/--auto/--plan); `--output-format
    // stream-json` = the real NDJSON event stream captured above. The model is
    // selected entirely via KIMI_MODEL_* env (see `env()` above), not argv —
    // `-m` selects a config.toml alias, which the ephemeral KIMI_MODEL_* channel
    // doesn't need and already outranks per the CLI's own docs.
    return ["-p", spec.task, "--output-format", "stream-json", ...EXTRA];
  },

  parseLine(line: string, ctx: ParseCtx): CliEvent | CliEvent[] {
    if (!line.startsWith("{")) return { kind: "log", line };
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return { kind: "log", line };
    }
    const role = String(obj.role ?? "");

    // "meta" lines (version banner, resume hint) carry nothing worth surfacing.
    if (role === "meta") return { kind: "ignore" };

    // A tool result — the corresponding call already bumped progress when it
    // was announced; the CLI reports both success and failure as plain text in
    // the same shape (no separate error flag, verified live), so there's
    // nothing structured to branch on here.
    if (role === "tool") return { kind: "ignore" };

    if (role === "assistant") {
      const toolCalls = obj.tool_calls;
      if (Array.isArray(toolCalls) && toolCalls.length > 0) {
        const events: CliEvent[] = [];
        for (const call of toolCalls) {
          const fn = (call as Record<string, unknown>)?.function as Record<string, unknown> | undefined;
          const name = typeof fn?.name === "string" && fn.name.trim() ? fn.name.trim() : "tool";
          events.push({ kind: "tool", label: toolLabel(name, fn?.arguments) });
        }
        return events;
      }
      const text = obj.content;
      if (typeof text === "string" && text.trim()) return { kind: "chat", text: text.trim() };
      return { kind: "ignore" };
    }

    // Unrecognized shape — usageFromJson is defensive (never fabricates a row;
    // see file header on why this vendor's stream never actually carries one).
    const usage = usageFromJson(obj);
    if (usage) return { kind: "usage", usage };
    return { kind: "ignore" };
  },

  // `-p` is one-shot and headless with a fixed auto-permission policy — no live
  // decision channel (see file header).
  encodeDecision(_decision: Resolution | undefined, _ctx: ParseCtx): string | null {
    return null;
  },
  encodeMessage(): string | null {
    return null;
  },
};

export class KimiRunnerProvider extends CliRunnerProvider {
  readonly id: ProviderId = "kimi";
  protected vendor(): CliVendor {
    return kimi;
  }
}
