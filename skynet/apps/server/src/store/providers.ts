// ─── Provider catalog ───────────────────────────────────────────────────────
// The real vendor catalog surfaced to the create-agent UI. A provider is
// "available" when its credential is configured server-side (an env var here;
// a per-workspace secret can override at run time) — the UI disables providers
// that aren't available. This is live configuration, not demo data.

import { DEFAULT_PROVIDERS, type ProviderId, type ProviderInfo } from "@skynet/shared";
import { withProviderRequirements } from "../provider-requirements.js";
import { mergeModels } from "../provider-catalog.js";

const PROVIDER_ENV_KEY: Record<ProviderId, string | undefined> = {
  claude: process.env.ANTHROPIC_API_KEY,
  codex: process.env.OPENAI_API_KEY,
  gemini: process.env.GEMINI_API_KEY,
  cursor: process.env.CURSOR_API_KEY,
  copilot: process.env.GITHUB_TOKEN,
  // Hermes is provider-agnostic; its recommended key is OpenRouter's.
  hermes: process.env.OPENROUTER_API_KEY,
};

// Each provider carries its static requirements + a live binOnPath probe (what
// it needs to run), plus the env-derived `available` baseline (the secrets
// overlay refines `available` per workspace at serve time). `models` here are the
// curated defaults; providerCatalog() merges in any auto-discovered suggestions.
const BASE = withProviderRequirements(
  DEFAULT_PROVIDERS.map((p) => ({ ...p, available: Boolean(PROVIDER_ENV_KEY[p.id]) })),
);

// Auto-discovered model suggestions, refreshed from an external catalog on a
// schedule (see provider-catalog-refresh.ts). Merged over the curated list at
// serve time; empty until a refresh succeeds, so the curated defaults are ALWAYS
// the fallback — a failed/absent fetch never changes what the UI shows.
let modelOverrides: Partial<Record<ProviderId, string[]>> = {};

/** Replace the auto-discovered model suggestions (called after a catalog refresh). */
export function setModelOverrides(overrides: Partial<Record<ProviderId, string[]>>): void {
  modelOverrides = overrides;
}

/** The live provider catalog: curated defaults with any auto-discovered models
 *  merged in (curated first, deduped, capped). Rebuilt per call so a refresh is
 *  reflected on the next snapshot/listProviders without a restart. */
export function providerCatalog(): ProviderInfo[] {
  return BASE.map((p) => {
    const extra = modelOverrides[p.id];
    return extra && extra.length > 0 ? { ...p, models: mergeModels(p.models, extra) } : p;
  });
}

/** @deprecated Prefer providerCatalog() — this is the static (unmerged) base. */
export const PROVIDERS = BASE;
