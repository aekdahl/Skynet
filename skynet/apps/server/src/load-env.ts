// ─── .env loader ──────────────────────────────────────────────────────────
// Loads skynet/.env into process.env using Node's built-in loader (no deps).
// MUST be imported FIRST in the server entrypoint — before ./config and
// anything that reads process.env at module-eval time — or those modules
// capture values before the file is applied.
//
// Precedence: variables already set in the real environment WIN over the file
// (Node's loadEnvFile does not overwrite existing vars), so an exported
// ANTHROPIC_API_KEY still takes priority over .env. `.env` is gitignored.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function loadEnv(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  // Both src/ (tsx) and dist/ sit 3 levels under the skynet/ package root.
  const candidates = [
    join(process.cwd(), ".env"),
    join(here, "../../../.env"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      // Node ≥ 22: parses KEY=VALUE lines into process.env (no overwrite).
      process.loadEnvFile(path);
      return path;
    } catch {
      // malformed file — skip, fall through to the next candidate
    }
  }
  return null;
}

/** Absolute path of the .env that was loaded, or null if none was found. */
export const loadedEnvFrom = loadEnv();
