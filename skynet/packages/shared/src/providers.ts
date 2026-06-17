// ─── Default provider catalog ──────────────────────────────────────────────
// The server is the source of truth for this (served via GET /providers so the
// Fleet model dropdown stays server-driven, never hard-coded in the client).
// This default mirrors the prototype's PROVIDERS map.

import type { ProviderInfo } from "./contracts.js";

export const DEFAULT_PROVIDERS: ProviderInfo[] = [
  { id: "claude", name: "Claude Code", glyph: "✱", color: "#D97757", models: ["opus-4.5", "sonnet-4.6", "haiku-4.5"] },
  { id: "codex", name: "Codex", glyph: "◌", color: "#19C2A8", models: ["gpt-5.2-codex", "gpt-5.2-codex-mini"] },
  { id: "gemini", name: "Gemini CLI", glyph: "✦", color: "#5EA2FF", models: ["gemini-3-pro", "gemini-3-flash"] },
  { id: "cursor", name: "Cursor Agent", glyph: "▎", color: "#A78BFA", models: ["composer-2"] },
  { id: "copilot", name: "GitHub Copilot", glyph: "◈", color: "#8B93A5", models: ["copilot-workspace"] },
];
