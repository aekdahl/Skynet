// ─── Friendly fleet-agent names ───────────────────────────────────────────
// New agents get a human-memorable name — `<provider>-<name>` (e.g. claude-ada,
// codex-grace) — instead of an opaque `runner-<id>`. The operator can rename
// later; this is just a nice default so the board reads in names, not ids.

// A curated pool of short, easy first names (broadly gender-neutral / varied).
// Order is stable so name assignment is deterministic and testable — we hand out
// the first name not already in use.
export const AGENT_NAME_POOL = [
  "ada", "grace", "lisa", "alex", "kai", "mira", "noa", "ravi", "sol", "wren",
  "ivy", "jules", "remy", "tess", "zane", "june", "leo", "nova", "otis", "pia",
  "quinn", "rune", "sage", "theo", "uma", "vera", "wes", "xan", "yara", "zoe",
] as const;

/**
 * Pick a friendly `<provider>-<name>` not already taken by the workspace's fleet.
 * Walks the name pool in order and returns the first free combination; if the
 * whole pool is exhausted for this provider, appends a numeric suffix
 * (`<provider>-<name>-2`, `-3`, …) so it always resolves to something unique.
 */
export function generateAgentName(provider: string, existingNames: Iterable<string>): string {
  const taken = new Set(existingNames);
  for (const name of AGENT_NAME_POOL) {
    const candidate = `${provider}-${name}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Pool exhausted for this provider — extend with a numeric suffix.
  for (let n = 2; ; n++) {
    for (const name of AGENT_NAME_POOL) {
      const candidate = `${provider}-${name}-${n}`;
      if (!taken.has(candidate)) return candidate;
    }
  }
}
