// ─── Advanced env settings (desktop) ───────────────────────────────────────
// The desktop app builds the server's environment at launch from an optional
// `<userData>/skynet.env` file (see apps/desktop/main.cjs). Most of `config` is
// read ONCE at server boot, so changing one of these values only takes effect
// after the server process restarts — which the desktop shell does on request.
//
// This module is the SINGLE SOURCE OF TRUTH for which env vars the in-app
// Advanced settings panel may touch. It is a strict WHITELIST: the API will only
// ever read/write keys defined here, so a user (or a compromised renderer) can
// never set app-breaking plumbing (STORE, NODE_ENV, PORT, …) or hosted-only vars
// through it. Adding a knob = adding a field here.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "../config.js";

export type EnvFieldType = "text" | "number" | "toggle" | "secret";

export interface EnvField {
  key: string;
  group: string;
  label: string;
  hint: string;
  type: EnvFieldType;
  placeholder?: string;
  unit?: string;
}

/** The whitelist. Order is the render order; `group` buckets the UI. */
export const ENV_FIELDS: EnvField[] = [
  // Telegram notifications/control. The FEATURE (reading these) ships in its own
  // PR; this panel only makes the vars settable + applied. BOT_TOKEN is a secret.
  { key: "SKYNET_TELEGRAM_BOT_TOKEN", group: "Telegram", label: "Bot token", type: "secret",
    hint: "From @BotFather. Enables Telegram notifications/control.", placeholder: "123456:ABC-DEF…" },
  { key: "SKYNET_TELEGRAM_OWNER_CHAT_ID", group: "Telegram", label: "Owner chat ID", type: "text",
    hint: "The Telegram chat/user id the bot messages and accepts commands from.", placeholder: "e.g. 87654321" },
  { key: "SKYNET_TELEGRAM_CONTROL", group: "Telegram", label: "Allow control from Telegram", type: "toggle",
    hint: "Let the owner drive Skynet from Telegram (not just receive notifications)." },

  // Runner safety.
  { key: "SKYNET_RUNNER_SANDBOX", group: "Runner safety", label: "OS write-confinement", type: "toggle",
    hint: "Confine agent file writes to their worktree (macOS sandbox-exec / Linux bwrap). Best-effort." },
  { key: "SKYNET_RUNNER_MAX_RUNTIME_MS", group: "Runner safety", label: "Max run time", type: "number", unit: "ms",
    hint: "Force-stop a runaway/hung agent after this long. 0 disables. Default 1800000 (30 min).", placeholder: "1800000" },
  { key: "SKYNET_RUNNER_EGRESS_ALLOWLIST", group: "Runner safety", label: "Network egress allowlist", type: "text",
    hint: "Comma-separated hostnames agent processes may reach (e.g. api.anthropic.com,github.com). Blank = network stays fully open. Best-effort — a process that ignores HTTP(S)_PROXY isn't blocked.", placeholder: "api.anthropic.com,github.com" },

  // Integration.
  { key: "SKYNET_CHECK_CMD", group: "Integration", label: "Pre-merge check command", type: "text",
    hint: "Run in the worktree before a merge commits (e.g. pnpm test). Blank = no check.", placeholder: "pnpm test" },

  // Vendor CLI paths — where the fleet finds each non-Claude agent binary.
  { key: "CODEX_BIN", group: "Vendor CLI paths", label: "Codex binary", type: "text", hint: "Path/name of the Codex CLI.", placeholder: "codex" },
  { key: "GEMINI_BIN", group: "Vendor CLI paths", label: "Gemini binary", type: "text", hint: "Path/name of the Gemini CLI.", placeholder: "gemini" },
  { key: "SKYNET_CURSOR_BIN", group: "Vendor CLI paths", label: "Cursor binary", type: "text", hint: "Path/name of the cursor-agent CLI.", placeholder: "cursor-agent" },
  { key: "SKYNET_COPILOT_BIN", group: "Vendor CLI paths", label: "Copilot binary", type: "text", hint: "Path/name of the Copilot CLI.", placeholder: "copilot" },
  { key: "SKYNET_HERMES_BIN", group: "Vendor CLI paths", label: "Hermes binary", type: "text", hint: "Path/name of the Hermes CLI.", placeholder: "hermes" },
  { key: "SKYNET_OPENCODE_BIN", group: "Vendor CLI paths", label: "OpenCode binary", type: "text", hint: "Path/name of the OpenCode CLI.", placeholder: "opencode" },
];

const FIELD_BY_KEY = new Map(ENV_FIELDS.map((f) => [f.key, f]));

/** True when the server was launched by the desktop shell with a writable env
 *  file — the only context where these settings can be persisted + applied. */
export function envSettingsWritable(): boolean {
  return config.desktop && !!config.envFile;
}

/** Parse a KEY=value env file (comments + blanks skipped) into a map. */
async function readEnvFile(): Promise<Record<string, string>> {
  if (!config.envFile) return {};
  const out: Record<string, string> = {};
  try {
    const text = await readFile(config.envFile, "utf8");
    for (const line of text.split("\n")) {
      if (/^\s*#/.test(line) || !line.trim()) continue;
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]!] = m[2]!;
    }
  } catch {
    /* no file yet */
  }
  return out;
}

/** A secret's value is never returned — only whether it's set. */
export interface EnvSettingView extends EnvField {
  value: string; // empty for secrets (masked) and unset keys
  set: boolean;
}

/**
 * The current values the panel should show: the STAGED source of truth (the env
 * file, which is what the next restart applies), falling back to the live
 * process env. Secret values are masked to "" with `set` telling the UI it exists.
 */
export async function currentEnvSettings(): Promise<{ writable: boolean; fields: EnvSettingView[] }> {
  const fileEnv = await readEnvFile();
  const fields = ENV_FIELDS.map((f) => {
    const raw = fileEnv[f.key] ?? process.env[f.key] ?? "";
    const set = raw.trim().length > 0;
    return { ...f, value: f.type === "secret" ? "" : raw, set };
  });
  return { writable: envSettingsWritable(), fields };
}

/**
 * A SECRET-SAFE, plain-text snapshot of the workspace's LIVE server/runtime
 * settings — what's ACTUALLY configured right now, not just what the committed
 * repo docs describe. This is the grounding the assistant (Steward) gets so it
 * can answer "is autonomy on?", "which approval level is the default?", "is the
 * sandbox enabled?", "is Telegram control on?" from real state.
 *
 * Two parts:
 *   • RUNTIME — read-only operational knobs from `config` (approval level,
 *     autonomy loop, escalation guards, backends, deployment mode, GitHub App /
 *     MCP wiring). Most are fixed at server boot.
 *   • ADVANCED — the whitelisted, desktop-editable env fields (Telegram, runner
 *     safety, integration, vendor CLI paths) via {@link currentEnvSettings}.
 *
 * Secrets are NEVER emitted: `secret`-typed env fields and sensitive config
 * (tokens, keys, passwords, DB/Redis URLs) are shown only as "set"/"not set".
 * Best-effort + never throws — a failed read just yields a short note so the
 * assistant prompt is never broken by settings.
 */
export async function settingsContext(): Promise<string> {
  try {
    const orNone = (v: string | undefined, none = "(not set)"): string => (v && v.trim() ? v : none);

    const runtime: string[] = [
      "RUNTIME (server config — mostly fixed until the engine restarts):",
      `  Default approval level for NEW projects: ${config.defaultApprovalLevel}`,
      `  Autonomy loop: ${config.autonomyMs > 0 ? `every ${config.autonomyMs}ms` : "disabled (fully human-driven)"} (per-project autonomy flag still gates each project)`,
      `  Escalation — max failures per run: ${config.runMaxFailures > 0 ? config.runMaxFailures : "disabled"}; stuck-run escalation: ${config.runStuckMs > 0 ? `after ${config.runStuckMs}ms running` : "disabled"}`,
      `  Unanswered HITL question auto-resolve: ${config.hitlQuestionTimeoutMs > 0 ? `after ${config.hitlQuestionTimeoutMs}ms` : "disabled (waits for a human)"}`,
      `  Integration: repo ${orNone(config.integrationRepo, "(none — local merge engine)")}, base branch ${config.baseBranch}`,
      `  Backends: store=${orNone(config.store, "unset")}, bus=${orNone(config.bus, "unset")}, sessions=${orNone(config.sessions, "unset")}`,
      `  Deployment: ${config.desktop ? "desktop app" : config.headless ? "headless (API+WS+MCP only)" : "hosted"}; auth ${config.authRequired ? "required" : "open"}; session TTL ${config.sessionTtlMs}ms`,
      `  GitHub App: ${config.githubAppId ? "configured" : "not configured"}; GitHub webhook secret: ${config.githubWebhookSecret ? "set" : "not set"}`,
      `  MCP bootstrap token: ${config.mcpBootstrapToken ? "set" : "not set"}; bootstrap scopes: ${config.mcpBootstrapScopes}`,
    ];

    const { writable, fields } = await currentEnvSettings();
    const advanced: string[] = [
      `ADVANCED (whitelisted env overrides — ${writable ? "editable in the in-app Advanced settings panel" : "read-only in this deployment"}):`,
    ];
    let group = "";
    for (const f of fields) {
      if (f.group !== group) {
        group = f.group;
        advanced.push(`  ${group}:`);
      }
      let shown: string;
      if (f.type === "secret") shown = f.set ? "set" : "not set";
      else if (f.type === "toggle") shown = f.set ? "on" : "off";
      else shown = f.set ? `${f.value}${f.unit ? ` ${f.unit}` : ""}` : "(not set)";
      advanced.push(`    ${f.label}: ${shown}`);
    }

    return [...runtime, "", ...advanced].join("\n");
  } catch {
    return "(settings are unavailable right now)";
  }
}

/** A save was attempted with a key not on the whitelist. */
export class UnknownEnvKeyError extends Error {
  constructor(key: string) {
    super(`"${key}" is not a settable env key`);
    this.name = "UnknownEnvKeyError";
  }
}

/** A value failed its field's type check (e.g. a non-numeric number field). */
export class InvalidEnvValueError extends Error {
  constructor(key: string, why: string) {
    super(`"${key}": ${why}`);
    this.name = "InvalidEnvValueError";
  }
}

/**
 * Merge `updates` into the env file (whitelisted keys only). An empty/blank
 * value REMOVES the key (revert to default). Written 0600 — it may hold a token.
 * A `secret` field with an empty value is a NO-OP (don't clobber an existing
 * secret just because the masked UI submitted blank); to clear a secret the UI
 * sends the sentinel " " (cleared explicitly).
 */
export async function writeEnvSettings(updates: Record<string, string>): Promise<void> {
  if (!config.envFile) throw new Error("env settings are not writable in this context");

  for (const key of Object.keys(updates)) {
    const field = FIELD_BY_KEY.get(key);
    if (!field) throw new UnknownEnvKeyError(key);
    const v = updates[key] ?? "";
    if (field.type === "number" && v.trim() && !Number.isFinite(Number(v.trim()))) {
      throw new InvalidEnvValueError(key, "must be a number");
    }
  }

  const env = await readEnvFile();
  for (const [key, rawVal] of Object.entries(updates)) {
    const field = FIELD_BY_KEY.get(key)!;
    const val = (rawVal ?? "").trim();
    if (field.type === "secret" && val === "") continue; // masked-blank → leave as-is
    if (val === "" || val === " ") delete env[key]; // clear / revert to default
    else if (field.type === "toggle") env[key] = /^(1|true|yes|on)$/i.test(val) ? "true" : "";
    else env[key] = val;
    if (env[key] === "") delete env[key];
  }

  const body =
    "# Skynet desktop overrides — written by the in-app Advanced settings panel.\n" +
    "# KEY=value, one per line. Applied when the app restarts the local engine.\n" +
    Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") +
    "\n";
  await mkdir(dirname(config.envFile), { recursive: true }).catch(() => undefined);
  await writeFile(config.envFile, body, { mode: 0o600 });
}
