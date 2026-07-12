// ─── Provider catalog ───────────────────────────────────────────────────────
// The real vendor catalog surfaced to the create-agent UI. A provider is
// "available" when its credential is configured server-side (an env var here;
// a per-workspace secret can override at run time) — the UI disables providers
// that aren't available. This is live configuration, not demo data.

import { DEFAULT_PROVIDERS, type ProviderId } from "@skynet/shared";

const PROVIDER_ENV_KEY: Record<ProviderId, string | undefined> = {
  claude: process.env.ANTHROPIC_API_KEY,
  codex: process.env.OPENAI_API_KEY,
  gemini: process.env.GEMINI_API_KEY,
  cursor: process.env.CURSOR_API_KEY,
  copilot: process.env.GITHUB_TOKEN,
  // Hermes is provider-agnostic; its recommended key is OpenRouter's.
  hermes: process.env.OPENROUTER_API_KEY,
};

export const PROVIDERS = DEFAULT_PROVIDERS.map((p) => ({
  ...p,
  available: Boolean(PROVIDER_ENV_KEY[p.id]),
}));
