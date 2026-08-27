// ─── Agent SDK ───────────────────────────────────────────────────────────
// One provider-agnostic interface for every agent backend (Claude Code, Codex,
// Gemini, Cursor, Copilot). The orchestrator drives runners through this and
// never special-cases a vendor. (Backend Brief §06, Architecture Brief §07.)

export * from "./types.js";

// Pure API-error classifiers — the orchestrator's key-health breaker keys off
// billing (credit/quota) exhaustion, so surface them through the barrel too.
export { isTransientApiError, isCreditExhaustionError, smokeTestEndpoint } from "./claude.js";
