// ─── Codex CLI runner ─────────────────────────────────────────────────────
// A real RunnerProvider backed by OpenAI's Codex CLI (`codex`). Selected via
// RUNNER=codex. We drive `codex exec` in JSONL mode: it runs the task headless
// in the agent's worktree and streams structured events on stdout, which we map
// onto the runner-sdk control contract — agent prose → log, command/patch items
// → progress, and any approval/elicitation event → a HITL approval gate.
//
// The Codex JSON event protocol is experimental and still shifting, so the
// parser is deliberately tolerant: it classifies by fuzzy `type` match and falls
// back to logging the raw line. Binary name and argv are env-overridable
// (CODEX_BIN, CODEX_EXTRA_ARGS) so operators can track protocol changes without
// a code change. Missing binary or an auth failure falls back cleanly (see
// cli-runner.ts) — the default RUNNER=mock path never imports this module.
//
// Opt-in browser tooling (`spec.browser`, see cli-runner.ts's
// `browserMcpServerSpec`) is wired via `-c mcp_servers.browser.*=…` overrides on
// `buildArgs` — no config file touched, ever (see the comment there).

import type { ProviderId, Resolution } from "@skynet/shared";
import {
  BROWSER_MCP_NAME,
  CliRunnerProvider,
  browserMcpServerSpec,
  usageFromJson,
  type CliEvent,
  type CliVendor,
  type ParseCtx,
} from "./cli-runner.js";
import type { HitlRaise, StartSpec } from "./types.js";

const BIN = process.env.CODEX_BIN || "codex";
const EXTRA = (process.env.CODEX_EXTRA_ARGS ?? "").split(" ").filter(Boolean);

function approvalRaise(toolName: string, command: unknown): HitlRaise {
  return {
    kind: "approval",
    title: `Approve: ${toolName}`,
    why: "Codex unit requested a command and is paused for your decision.",
    risk: "medium",
    command: typeof command === "string" ? command : command ? JSON.stringify(command) : null,
    options: null,
    recommended: null,
    rationale: null,
    steps: null,
    diff: null,
  };
}

// Pull the first string found at any of the candidate keys (flat or under `msg`/`item`).
function pick(obj: Record<string, unknown>, keys: string[]): string | undefined {
  const scopes = [obj, obj.msg as Record<string, unknown>, obj.item as Record<string, unknown>];
  for (const scope of scopes) {
    if (!scope) continue;
    for (const k of keys) {
      const v = scope[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return undefined;
}

export const codex: CliVendor = {
  id: "codex" as ProviderId,
  bin: BIN,
  installHint: "Install with `npm i -g @openai/codex` and authenticate (`codex login`).",

  env(spec: StartSpec): Record<string, string> {
    // Per-workspace key injected by the orchestrator; empty → inherit ambient env.
    return spec.apiKey ? { OPENAI_API_KEY: spec.apiKey } : {};
  },

  buildArgs(spec: StartSpec): string[] {
    // `exec` = non-interactive; `--json` = JSONL event stream on stdout.
    const args = [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--model",
      spec.model,
    ];
    // Opt-in browser tooling: Codex has NO project-local MCP config file (only
    // a global `~/.codex/config.toml`) — but `-c key=value` overrides a config
    // value for just this invocation (verified live against codex-cli 0.147.0:
    // `codex mcp list -c 'mcp_servers.browser.command="npx"' -c '…args=[...]'`
    // registers the server with zero file writes). Each override value is TOML,
    // and a JSON string/array of strings IS valid TOML, so JSON.stringify
    // produces exactly the literal `-c` wants.
    if (spec.browser) {
      const { command, args: mcpArgs } = browserMcpServerSpec();
      args.push("-c", `mcp_servers.${BROWSER_MCP_NAME}.command=${JSON.stringify(command)}`);
      args.push("-c", `mcp_servers.${BROWSER_MCP_NAME}.args=${JSON.stringify(mcpArgs)}`);
    }
    args.push(...EXTRA, spec.task);
    return args;
  },

  parseLine(line: string, ctx: ParseCtx): CliEvent {
    if (!line.startsWith("{")) return { kind: "log", line };
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return { kind: "log", line };
    }
    const type = String(obj.type ?? (obj.msg as Record<string, unknown>)?.type ?? "");

    // Token-count / usage events (shape varies across Codex versions) — report
    // best-effort. As of codex-cli 0.147.0 (codex-rs/protocol TokenCountEvent),
    // the real counts sit two levels deep — `msg.info.total_token_usage` /
    // `.last_token_usage` — not at a flat usage/stats/tokens/metrics key, so the
    // generic scanner alone finds nothing here; unwrap it first. Prefer the
    // session TOTAL (matches Skynet's cumulative Usage semantics) over the last
    // turn, and fall back to the raw scopes in case a future version flattens
    // the shape again.
    if (/token|usage/i.test(type)) {
      const msg = (obj.msg as Record<string, unknown>) ?? obj;
      const info = msg.info as Record<string, unknown> | undefined;
      const usage =
        usageFromJson((info?.total_token_usage as Record<string, unknown>) ?? {}) ??
        usageFromJson((info?.last_token_usage as Record<string, unknown>) ?? {}) ??
        usageFromJson(msg) ??
        usageFromJson(obj);
      if (usage) return { kind: "usage", usage };
    }

    // Blocked on a human — capture the request id so `resume` can answer it.
    if (/approval|elicit|permission|confirm/i.test(type)) {
      ctx.approvalId = obj.id ?? obj.call_id ?? (obj.msg as Record<string, unknown>)?.id ?? null;
      const command = pick(obj, ["command", "cmd"]) ?? (obj.command as unknown);
      return { kind: "approval", raise: approvalRaise(type || "command", command) };
    }

    // A command / patch / tool execution → surface as progress.
    if (/command|exec|tool|shell|patch|apply|mcp/i.test(type)) {
      const label = pick(obj, ["command", "cmd", "name", "tool"]) ?? type;
      return { kind: "tool", label };
    }

    // Assistant prose. Treat agent messages as chat (reply to a `message()`),
    // anything else with text as a log line.
    const text = pick(obj, ["text", "message", "delta", "content"]);
    if (text) {
      return /agent_message|assistant|response|reasoning/i.test(type)
        ? { kind: "chat", text }
        : { kind: "log", line: text };
    }
    return { kind: "ignore" };
  },

  encodeDecision(decision: Resolution | undefined, ctx: ParseCtx): string | null {
    // Best-effort: answer the captured approval request over stdin. If Codex's
    // exec mode ignores stdin decisions, this is a harmless no-op and the base
    // still unblocks our state + logs the decision.
    if (ctx.approvalId == null) return null;
    const verdict =
      decision?.action === "reject" || decision?.action === "modify" ? "denied" : "approved";
    return JSON.stringify({ id: ctx.approvalId, decision: verdict, note: decision?.guidance ?? null });
  },

  // `codex exec` is one-shot — no live chat channel. The base acknowledges
  // chat messages gracefully when this returns null.
  encodeMessage(): string | null {
    return null;
  },
};

export class CodexRunnerProvider extends CliRunnerProvider {
  readonly id: ProviderId = "codex";
  protected vendor(): CliVendor {
    return codex;
  }
}
