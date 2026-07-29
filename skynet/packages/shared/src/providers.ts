// ─── Default provider catalog ──────────────────────────────────────────────
// The server is the source of truth for this (served via GET /providers so the
// Fleet model dropdown stays server-driven, never hard-coded in the client).
//
// The per-provider `models` are curated SUGGESTIONS shown in the picker — NOT an
// allowlist. The runners pass whatever model string they're given straight to the
// vendor CLI/SDK, which is the real authority on what's valid, so an operator can
// select a model released after this list was last updated by typing its id (the
// Fleet form's "custom" option). That's why validation is advisory — see
// modelValidForProvider / isKnownModel below. Keeping this list fresh is purely a
// UX nicety; a stale list never blocks using a new model.

import type { ProviderInfo } from "./contracts.js";

export const DEFAULT_PROVIDERS: ProviderInfo[] = [
  { id: "claude", name: "Claude Code", glyph: "✱", color: "#D97757", models: ["opus-4.8", "sonnet-4.6", "haiku-4.5", "fable-5"] },
  { id: "codex", name: "Codex", glyph: "◌", color: "#19C2A8", models: ["gpt-5.2-codex", "gpt-5.2-codex-mini"] },
  { id: "gemini", name: "Gemini CLI", glyph: "✦", color: "#5EA2FF", models: ["gemini-3-pro", "gemini-3-flash"] },
  { id: "cursor", name: "Cursor Agent", glyph: "▎", color: "#A78BFA", models: ["composer-2"] },
  { id: "copilot", name: "GitHub Copilot", glyph: "◈", color: "#8B93A5", models: ["copilot-workspace"] },
  { id: "hermes", name: "Hermes Agent", glyph: "⬡", color: "#E0B341", models: ["anthropic/claude-sonnet-4.6", "openai/gpt-5.2", "nousresearch/hermes-4-405b"] },
];

/**
 * Validate a provider + model pairing (DEF-004). ADVISORY on the model: the
 * `models` list is curated suggestions, not an allowlist (the vendor CLI/SDK is
 * the real authority), so ANY non-empty model is accepted for a known provider —
 * this is what lets a just-released model be used without a catalog edit. Only an
 * unknown provider or an empty model is rejected. The catalog is passed in so
 * callers reuse their live source of truth (e.g. store.listProviders()). Returns
 * a human-readable error string when invalid, or `undefined` when acceptable.
 */
export function modelValidForProvider(
  catalog: ProviderInfo[],
  provider: string,
  model: string,
): string | undefined {
  const entry = catalog.find((p) => p.id === provider);
  if (!entry) return `Unknown provider "${provider}"`;
  if (!model || !model.trim()) return `A model is required for provider "${provider}"`;
  return undefined;
}

/**
 * Is `model` one of a provider's curated (known/verified) suggestions? PURE and
 * for UI signalling only (e.g. flag a custom model as "unverified") — never a
 * gate; unknown models are still valid to use (see modelValidForProvider).
 */
export function isKnownModel(catalog: ProviderInfo[], provider: string, model: string): boolean {
  const entry = catalog.find((p) => p.id === provider);
  return !!entry && entry.models.includes(model.trim());
}
