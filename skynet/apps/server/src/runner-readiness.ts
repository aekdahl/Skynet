// ─── Agent readiness ──────────────────────────────────────────────────────
// Guards agent creation: you cannot spin up an agent unless there is a runner
// that can actually execute. Two ways it can't:
//   • no runner is configured in the fleet at all;
//   • a runner is configured but the executor has no credential (no key set).
//
// The mock executor needs no credential (the dev/demo path stays open), and
// providers that authenticate via CLI login (e.g. cursor) can't be introspected
// for a key, so they aren't blocked. The orchestrator resolves the live inputs
// (fleet size, whether a key is present) and calls the pure assessor below.

import type { ProviderId } from "@skynet/shared";

/**
 * Ambient env vars that authenticate each API-key provider. A provider absent
 * from this map authenticates some other way (e.g. cursor's CLI login) and is
 * therefore treated as "needs no detectable key" rather than blocked.
 */
export const PROVIDER_ENV_KEYS: Partial<Record<ProviderId, readonly string[]>> = {
  claude: ["ANTHROPIC_API_KEY"],
  codex: ["OPENAI_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  copilot: ["GH_TOKEN", "GITHUB_TOKEN"],
};

/** The executor runs without a detectable API key: mock, or a CLI-login provider. */
export function executorNeedsNoKey(runnerMode: string): boolean {
  return runnerMode === "mock" || !(runnerMode in PROVIDER_ENV_KEYS);
}

/** True when an ambient env var authenticates the executor's provider. */
export function envKeyPresent(runnerMode: string): boolean {
  const keys = PROVIDER_ENV_KEYS[runnerMode as ProviderId];
  return keys?.some((k) => (process.env[k] ?? "").trim() !== "") ?? false;
}

export interface Readiness {
  ok: boolean;
  reason?: string;
}

/**
 * Whether the workspace can start a new agent. Pure and synchronous so it is
 * trivially testable; the orchestrator supplies the resolved inputs.
 *   - no runner in the fleet          → not ok ("configure a runner")
 *   - mock executor                   → ok (runs without a credential)
 *   - real executor with a credential → ok
 *   - real executor, no credential    → not ok ("set an API key")
 */
export function assessRunnerReadiness(input: {
  runnerMode: string; // config.runner — the actual executor
  runnerCount: number; // runners in the workspace fleet
  credentialPresent: boolean; // a key for the executor is resolvable (or none is needed)
}): Readiness {
  if (input.runnerCount === 0) {
    return {
      ok: false,
      reason: "No runner configured — add one in Fleet before assigning runs.",
    };
  }
  if (input.runnerMode === "mock" || input.credentialPresent) return { ok: true };
  return {
    ok: false,
    reason: `No API key set for ${input.runnerMode} — add one in Settings before assigning runs.`,
  };
}
