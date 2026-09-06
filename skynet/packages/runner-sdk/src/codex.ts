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
//
// User-configured MCP servers (`spec.mcpServers`) use the same `-c` override
// mechanism, live-verified against codex-cli 0.147.0: a stdio server's env
// vars go through `-c mcp_servers.<name>.env.<KEY>="value"` (a dotted TOML
// key, confirmed via `codex mcp list -c ...` — the value registers with zero
// file writes, same as the browser server). A remote server is `-c
// mcp_servers.<name>.url="…"` — but Codex authenticates a remote server with
// exactly ONE mechanism, `bearer_token_env_var` (the NAME of an env var it
// reads at connect time, not the value inline), so a remote server's
// `headers` map is reduced to its `Authorization: Bearer <token>` entry (if
// any) — that token is injected into the child process's env under a
// per-server var name, and everything else in `headers` has no Codex
// equivalent and is silently dropped (logged once, not per-run, to avoid
// spamming every run on a server with unsupported headers).
import type { ProviderId, Resolution } from "@skynet/shared";
import {
  BROWSER_MCP_NAME,
  CliRunnerProvider,
  RESERVED_MCP_NAMES,
  browserMcpServerSpec,
  usageFromJson,
  type CliEvent,
  type CliVendor,
  type ParseCtx,
} from "./cli-runner.js";
import type { HitlRaise, StartSpec } from "./types.js";

/** The env var name Codex reads a remote server's bearer token from — unique
 *  per server so two remote servers on the same run never collide. */
const bearerEnvVar = (name: string) => `SKYNET_MCP_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_TOKEN`;

/** `-c mcp_servers.<name>.*=…` overrides for every user-configured server on
 *  this spec, plus the env vars a remote server's bearer token rides on
 *  (merged into the child's env by `codex.env` below). Pulled out so both
 *  `buildArgs` and `env` derive from the same pass. */
function userMcpOverrides(spec: StartSpec): { args: string[]; env: Record<string, string> } {
  const args: string[] = [];
  const env: Record<string, string> = {};
  for (const s of spec.mcpServers ?? []) {
    if (!s.name || RESERVED_MCP_NAMES.has(s.name)) continue;
    if (s.transport === "remote") {
      args.push("-c", `mcp_servers.${s.name}.url=${JSON.stringify(s.url)}`);
      const token = s.headers?.Authorization?.replace(/^Bearer\s+/i, "");
      if (token) {
        const envVar = bearerEnvVar(s.name);
        args.push("-c", `mcp_servers.${s.name}.bearer_token_env_var=${JSON.stringify(envVar)}`);
        env[envVar] = token;
      }
    } else {
      args.push("-c", `mcp_servers.${s.name}.command=${JSON.stringify(s.command)}`);
      args.push("-c", `mcp_servers.${s.name}.args=${JSON.stringify(s.args)}`);
      for (const [k, v] of Object.entries(s.env ?? {})) {
        args.push("-c", `mcp_servers.${s.name}.env.${k}=${JSON.stringify(v)}`);
      }
    }
  }
  return { args, env };
}

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
    return {
      ...(spec.apiKey ? { OPENAI_API_KEY: spec.apiKey } : {}),
      // A remote user-configured server's bearer token (if any) — see
      // userMcpOverrides above for why this rides as an env var, not inline.
      ...userMcpOverrides(spec).env,
    };
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
    // User-configured MCP servers — see userMcpOverrides above.
    args.push(...userMcpOverrides(spec).args);
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
