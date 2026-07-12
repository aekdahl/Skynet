// ─── Default provider catalog ──────────────────────────────────────────────
// The server is the source of truth for this (served via GET /providers so the
// Fleet model dropdown stays server-driven, never hard-coded in the client).
// This default mirrors the prototype's PROVIDERS map.

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
 * Validate that a model belongs to a provider's catalog (DEF-004). The catalog
 * is passed in so callers reuse their live source of truth (e.g. the server's
 * store.listProviders()) rather than hard-coding a second copy. Returns a
 * human-readable error string when the pairing is invalid, or `undefined` when
 * it is valid.
 */
export function modelValidForProvider(
  catalog: ProviderInfo[],
  provider: string,
  model: string,
): string | undefined {
  const entry = catalog.find((p) => p.id === provider);
  if (!entry) return `Unknown provider "${provider}"`;
  if (!entry.models.includes(model)) {
    return `Model "${model}" is not valid for provider "${provider}" (expected one of: ${entry.models.join(", ")})`;
  }
  return undefined;
}
