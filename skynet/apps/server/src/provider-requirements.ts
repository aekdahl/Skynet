// ─── Provider requirements ─────────────────────────────────────────────────
// Assembles the "what does this provider need to run" descriptor the UI shows
// (Settings + create-agent): runtime kind, CLI binary, auth env vars, whether a
// CLI login works instead of a key, an install hint, and a docs link — plus a
// live probe of whether the CLI binary is actually on this server's PATH.
//
// Single sources of truth are reused, not duplicated: auth env vars and the
// CLI-login set come from provider-env.ts; the binary names mirror the runner
// vendors (packages/runner-sdk/src/*.ts) including their env overrides. Only the
// human-facing install hints / docs links are authored here.

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { ProviderId, ProviderInfo, ProviderRequirements } from "@skynet/shared";
import { PROVIDER_ENV_VARS, CLI_LOGIN_PROVIDERS } from "./provider-env.js";

// CLI binary per provider, honouring the SAME env overrides the vendors use so
// detection matches what actually gets spawned. Absent = in-process SDK (claude).
const PROVIDER_BIN: Partial<Record<ProviderId, string>> = {
  codex: process.env.CODEX_BIN || "codex",
  gemini: process.env.GEMINI_BIN || "gemini",
  cursor: process.env.SKYNET_CURSOR_BIN || "cursor-agent",
  copilot: process.env.SKYNET_COPILOT_BIN || "copilot",
  hermes: process.env.SKYNET_HERMES_BIN || "hermes",
};

const INSTALL_HINT: Record<ProviderId, string> = {
  claude: "Set ANTHROPIC_API_KEY (or a Claude OAuth token / gateway) — runs in-process, no CLI to install.",
  codex: "Install with `npm i -g @openai/codex` and authenticate (`codex login`).",
  gemini: "Install with `npm i -g @google/gemini-cli` and authenticate (`gemini`, then sign in).",
  cursor: "Install the Cursor CLI (`cursor-agent`) and sign in, or set CURSOR_API_KEY.",
  copilot: "Install the GitHub Copilot CLI (`copilot`) and authenticate with GitHub, or set GITHUB_TOKEN.",
  hermes: "Install the Hermes Agent CLI (`hermes`, on PATH) and set a provider key (e.g. OPENROUTER_API_KEY).",
};

const DOCS_URL: Partial<Record<ProviderId, string>> = {
  claude: "https://docs.anthropic.com/en/docs/claude-code",
  codex: "https://github.com/openai/codex",
  gemini: "https://github.com/google-gemini/gemini-cli",
  cursor: "https://docs.cursor.com/en/cli/overview",
  copilot: "https://docs.github.com/en/copilot/github-copilot-in-the-cli",
  hermes: "https://hermes-agent.nousresearch.com/",
};

/** Is `bin` resolvable on the server's PATH? Cheap synchronous scan. */
function binOnPath(bin: string): boolean {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  return dirs.some((d) => existsSync(join(d, bin)));
}

/** Build the static requirements descriptor for one provider. */
export function providerRequirements(id: ProviderId): ProviderRequirements {
  const bin = PROVIDER_BIN[id] ?? null;
  return {
    runtime: bin ? "cli" : "sdk",
    bin,
    authEnvVars: [...(PROVIDER_ENV_VARS[id] ?? [])],
    cliLogin: CLI_LOGIN_PROVIDERS.has(id),
    installHint: INSTALL_HINT[id] ?? null,
    docsUrl: DOCS_URL[id] ?? null,
  };
}

// PATH is stable for a process, so probe each binary once at module load.
const BIN_ON_PATH: Partial<Record<ProviderId, boolean>> = Object.fromEntries(
  (Object.keys(PROVIDER_BIN) as ProviderId[]).map((id) => [id, binOnPath(PROVIDER_BIN[id]!)]),
) as Partial<Record<ProviderId, boolean>>;

/**
 * Attach the requirements descriptor and the live binOnPath probe to each
 * provider in the catalog. Leaves `available` (per-workspace credential state)
 * to the secrets overlay.
 */
export function withProviderRequirements(providers: ProviderInfo[]): ProviderInfo[] {
  return providers.map((p) => ({
    ...p,
    requirements: providerRequirements(p.id),
    // null for an in-process SDK provider (no binary to find).
    binOnPath: PROVIDER_BIN[p.id] ? (BIN_ON_PATH[p.id] ?? false) : null,
  }));
}
