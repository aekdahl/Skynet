// ─── .env loader ──────────────────────────────────────────────────────────
// Loads .env into process.env before ./config (and anything reading process.env
// at module-eval time) — so it MUST be imported FIRST in the server entrypoint.
//
// Design notes / why this is hand-rolled rather than process.loadEnvFile():
//  • It loads EVERY candidate location, not just the first that exists. pnpm
//    runs the server with cwd = apps/server, so a stray apps/server/.env (or a
//    repo-root .env) must not shadow the canonical skynet/.env — a partial file
//    used to stop the search and the key was silently never read.
//  • Real environment variables always win; a file never overwrites a value
//    already in process.env, and earlier (more specific) files win over later.
//  • Parsing is forgiving: `export KEY=v`, quotes, `#` comments, blank lines and
//    CRLF are all handled, and a malformed line is skipped rather than aborting
//    the whole file.
//  • Failures are LOGGED, never silently swallowed — an unreadable .env used to
//    produce no key and no diagnostic, which reads as "env vars not picked up".

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Parse a .env body into key/value pairs (no variable expansion). */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trim();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue; // ignore junk lines
    let val = line.slice(eq + 1).trim();
    const q = val[0];
    if (val.length >= 2 && (q === '"' || q === "'") && val[val.length - 1] === q) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/** Apply a file's vars to process.env without overwriting existing ones.
 *  Returns the number of NEW keys set (0 if the file only duplicated env). */
function applyEnvFile(path: string): number {
  const parsed = parseEnv(readFileSync(path, "utf8"));
  let set = 0;
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) {
      process.env[k] = v;
      set++;
    }
  }
  return set;
}

function loadEnv(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/ (tsx) and dist/ both sit 3 levels under the skynet/ package root; the
  // repo root is one further up. Priority order = most specific first.
  const candidates = [
    join(process.cwd(), ".env"),
    join(here, "../../../.env"), // skynet/.env
    join(here, "../../../../.env"), // <repo>/.env (monorepo root)
  ];

  const loadedFrom: string[] = [];
  const seen = new Set<string>();
  for (const path of candidates) {
    if (seen.has(path) || !existsSync(path)) continue;
    seen.add(path);
    try {
      applyEnvFile(path);
      loadedFrom.push(path); // record every file read, even if it only duplicated env
    } catch (err) {
      // Visible, not silent — a present-but-unreadable .env is exactly the
      // "my key isn't picked up" symptom.
      console.warn(`[load-env] failed to read ${path}: ${(err as Error).message}`);
    }
  }
  return loadedFrom.length ? loadedFrom.join(", ") : null;
}

/** Absolute path(s) of the .env file(s) that were loaded, or null if none. */
export const loadedEnvFrom = loadEnv();
