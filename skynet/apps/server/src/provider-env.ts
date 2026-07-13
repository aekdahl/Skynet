// ─── Provider credential env vars ──────────────────────────────────────────
// Single source of truth for which environment variables authenticate each
// provider. Shared by the secrets service (availability + env fallback) and the
// orchestrator's runner-usability check so the two never diverge.
//
// Claude accepts more than an API key: `claude setup-token` mints a
// CLAUDE_CODE_OAUTH_TOKEN for headless/subscription auth, and a gateway/proxy
// setup uses ANTHROPIC_AUTH_TOKEN (with ANTHROPIC_BASE_URL). Any of these makes
// the provider usable — detecting only ANTHROPIC_API_KEY made a valid setup
// look "not set" and blocked agent creation.

import type { ProviderId } from "@skynet/shared";

/**
 * Credential env vars per provider, most-preferred first. The FIRST entry is
 * the "primary" API-key variable whose VALUE can be injected into a runner as
 * that provider's key; the rest are additional credentials (OAuth / gateway /
 * subscription tokens) that make the provider usable but are consumed from the
 * ambient environment by the runner rather than injected.
 */
export const PROVIDER_ENV_VARS: Record<ProviderId, readonly string[]> = {
  claude: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"],
  codex: ["OPENAI_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  cursor: ["CURSOR_API_KEY"],
  copilot: ["GITHUB_TOKEN", "GH_TOKEN"],
  // Hermes is provider-agnostic; OpenRouter is its recommended key, but any of
  // these provider keys in the ambient env also make it usable.
  hermes: ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY"],
};

/** The primary API-key env var per provider (its value is injectable as the key). */
export const PROVIDER_ENV_VAR: Record<ProviderId, string> = Object.fromEntries(
  (Object.keys(PROVIDER_ENV_VARS) as ProviderId[]).map((p) => [p, PROVIDER_ENV_VARS[p][0]!]),
) as Record<ProviderId, string>;

/** True when any of a provider's credential env vars is set (non-empty). */
export function providerEnvCredential(provider: ProviderId): boolean {
  return (PROVIDER_ENV_VARS[provider] ?? []).some((v) => (process.env[v] ?? "").trim() !== "");
}

/**
 * Providers that authenticate via their own CLI login (`cursor` / GitHub) rather
 * than an API-key env var, so they're usable without a key/token in the env.
 * Everything else needs a credential — no keys, nothing runs.
 */
export const CLI_LOGIN_PROVIDERS = new Set<ProviderId>(["cursor", "copilot"]);

/**
 * Whether a provider is usable from the ambient environment alone: a CLI-login
 * provider, or one with a credential env var set. Callers OR this with a stored
 * per-workspace secret. (There is no mock — an unusable provider means the
 * runner cannot execute.)
 */
export function providerUsableFromEnv(provider: ProviderId): boolean {
  return CLI_LOGIN_PROVIDERS.has(provider) || providerEnvCredential(provider);
}
