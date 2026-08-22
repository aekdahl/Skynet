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
  opencode: process.env.SKYNET_OPENCODE_BIN || "opencode",
};

const INSTALL_HINT: Record<ProviderId, string> = {
  claude: "Set ANTHROPIC_API_KEY (or a Claude OAuth token / gateway) — runs in-process, no CLI to install.",
  codex: "Install with `npm i -g @openai/codex` and authenticate (`codex login`).",
  gemini: "Install with `npm i -g @google/gemini-cli` and authenticate (`gemini`, then sign in).",
  cursor: "Install the Cursor CLI (`cursor-agent`) and sign in, or set CURSOR_API_KEY.",
  copilot: "Install with `npm i -g @github/copilot` and authenticate with GitHub (`copilot`, then sign in), or set GITHUB_TOKEN.",
  hermes: "Install the Hermes Agent CLI (`hermes`, on PATH) and set a provider key (e.g. OPENROUTER_API_KEY).",
  opencode: "Install with `npm i -g opencode-ai` and authenticate (`opencode auth login`), or set a provider key (e.g. ANTHROPIC_API_KEY).",
};

// Providers whose CLI is auto-installable via a package manager the server can
// run for the operator. Only npm is supported today — brew installs need
// interactive password prompts, and cursor is a `curl | bash` script (a shell
// install the npm-only, no-shell installer deliberately doesn't run). Those stay
// null and rely on the docs link. FIXED constants, never user-derived: shells out
// through execFile with a static argv (no shell interpolation), and the UI
// displays the exact command verbatim before running.
const INSTALL_COMMAND: Partial<Record<ProviderId, { packageManager: "npm"; command: string }>> = {
  codex: { packageManager: "npm", command: "npm install -g @openai/codex" },
  gemini: { packageManager: "npm", command: "npm install -g @google/gemini-cli" },
  // The GitHub Copilot CLI is now a standalone npm package (`@github/copilot`),
  // no longer a `gh` extension — so it installs through the same path as codex.
  copilot: { packageManager: "npm", command: "npm install -g @github/copilot" },
  opencode: { packageManager: "npm", command: "npm install -g opencode-ai" },
};

const DOCS_URL: Partial<Record<ProviderId, string>> = {
  claude: "https://docs.anthropic.com/en/docs/claude-code",
  codex: "https://github.com/openai/codex",
  gemini: "https://github.com/google-gemini/gemini-cli",
  cursor: "https://docs.cursor.com/en/cli/overview",
  copilot: "https://docs.github.com/en/copilot/github-copilot-in-the-cli",
  hermes: "https://hermes-agent.nousresearch.com/",
  opencode: "https://opencode.ai/docs/",
};

// Where to create or find the API key for each provider — linked directly from
// the onboarding Connect step so users never need to hunt for it. Absent for
// providers that use CLI login only (no API key to create, only copilot/cursor
// which ALSO accept a key; those are still included since key-entry is the
// in-app path). `null` would mean "no key, CLI login only" — none of the
// current providers are exclusively CLI-login without a key option.
const KEY_URL: Partial<Record<ProviderId, string>> = {
  claude: "https://console.anthropic.com/settings/keys",
  codex: "https://platform.openai.com/api-keys",
  gemini: "https://aistudio.google.com/app/apikey",
  cursor: "https://www.cursor.com/settings",
  copilot: "https://github.com/settings/tokens/new?scopes=copilot",
  hermes: "https://openrouter.ai/settings/keys",
  opencode: "https://console.anthropic.com/settings/keys",
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
    keyUrl: KEY_URL[id] ?? null,
    install: INSTALL_COMMAND[id] ?? null,
  };
}

/** Server-authoritative install command for one provider. Returned to the
 *  installer route, NEVER derived from client input — the client only sends the
 *  provider id and the server picks the fixed command from this table. */
export function installCommandFor(id: ProviderId): { packageManager: "npm"; command: string } | null {
  return INSTALL_COMMAND[id] ?? null;
}

/** The CLI binary the installer should re-probe for after running its command.
 *  Falls back to null for SDK-only providers (they have no CLI to install). */
export function providerBin(id: ProviderId): string | null {
  return PROVIDER_BIN[id] ?? null;
}

/** Live PATH probe — same logic as the module-load probe, but callable to
 *  refresh readiness right after `installCLI` succeeds. */
export function probeBinOnPath(bin: string): boolean {
  return binOnPath(bin);
}

/**
 * Attach the requirements descriptor and a live binOnPath probe to each
 * provider in the catalog. The probe used to be cached at module load, but the
 * in-app installer (POST /api/providers/:id/install) can change what's on
 * disk mid-process — so we re-probe here, cheaply (per-provider filesystem
 * checks against PATH entries). Leaves `available` (per-workspace credential
 * state) to the secrets overlay.
 */
export function withProviderRequirements(providers: ProviderInfo[]): ProviderInfo[] {
  return providers.map((p) => {
    const bin = PROVIDER_BIN[p.id];
    return {
      ...p,
      requirements: providerRequirements(p.id),
      // null for an in-process SDK provider (no binary to find).
      binOnPath: bin ? binOnPath(bin) : null,
    };
  });
}
