// ─── Runner SDK ───────────────────────────────────────────────────────────
// One provider-agnostic interface for every agent backend (Claude Code, Codex,
// Gemini, Cursor, Copilot). The orchestrator drives runners through this and
// never special-cases a vendor. (Backend Brief §06, Architecture Brief §07.)

export * from "./types.js";
export * from "./mock.js";
