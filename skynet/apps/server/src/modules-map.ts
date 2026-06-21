// ─── Module map + diff→module derivation (W3) ──────────────────────────────
// The UI is code-agnostic: it shows named modules (Billing, Auth, Shared UI),
// never file trees. The source of truth for that mapping is a curated map
// committed to the *target* repo at `.skynet/modules.json` (VCS brief §3):
//
//   {
//     "modules": [
//       { "id": "api/billing", "name": "Billing",   "globs": ["api/billing/**", "db/migrations/*billing*"] },
//       { "id": "shared/ui",   "name": "Shared UI", "globs": ["packages/ui/**", "shared/ui/**"] }
//     ]
//   }
//
// This module loads that file and resolves an agent's *changed files* → module
// ids by glob match, so `Agent.modules` becomes derived from what the agent
// actually touched rather than declared up front. Rules from §3:
//   • a file matching multiple globs belongs to ALL matched modules (overlap is
//     real and intended);
//   • a file matching no glob maps to no module (surfaced as "unmapped", never
//     guessed);
//   • when the map is absent or malformed, callers fall back to the seed map.
//
// Owned by W3 (Lane D). Core wires it into `Store.listModules` and agent module
// derivation; until then nothing imports it, so the default dev path is
// unchanged. No new dependencies — globs compile to RegExp in-process.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Module } from "@skynet/shared";

/** Path, relative to the target repo root, of the curated module map. */
export const MODULE_MAP_PATH = ".skynet/modules.json";

/** One entry in `.skynet/modules.json`. */
export interface ModuleMapEntry {
  id: string;
  name: string;
  globs: string[];
}

/**
 * Resolves changed files to architectural modules. Two implementations:
 * `GlobModuleMap` (driven by `.skynet/modules.json`) and `SeedModuleMap`
 * (prefix-based fallback over the seed catalog). Callers depend on this
 * interface, not the concrete source.
 */
export interface ModuleResolver {
  /** The module catalog ({id,name}) for `Store.listModules`, in declared order. */
  list(): Module[];
  /**
   * The sorted, de-duplicated module ids the given changed files touch.
   * Files matching no module are dropped (unmapped — never guessed).
   */
  derive(files: string[]): string[];
}

// ─── glob → RegExp ─────────────────────────────────────────────────────────
// A path-oriented glob compiler covering the shapes §3 needs and a bit more:
//   **      any run of characters incl. `/`        (`api/billing/**`)
//   **/     zero-or-more leading path segments     (`packages/**/test`)
//   *       any run within a single segment        (`*billing*`)
//   ?       a single non-separator character
//   {a,b}   alternation
//   [abc]   character class ( [!..] / [^..] negates )
// Everything else is matched literally. Patterns are anchored end-to-end.

const REGEXP_SPECIALS = new Set([
  ".", "+", "(", ")", "|", "^", "$", "\\", "/",
]);

/** Compile a single glob pattern into an anchored RegExp. Exported for tests. */
export function compileGlob(glob: string): RegExp {
  // Normalize: drop a leading "./" or "/" so patterns and paths align.
  const g = glob.replace(/^\.?\//, "");
  let re = "";
  let braceDepth = 0;

  for (let i = 0; i < g.length; ) {
    const c = g[i]!;

    if (c === "*") {
      if (g[i + 1] === "*") {
        // Globstar. `**/` → optional leading segments; otherwise → any run.
        if (g[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        // Single star: anything but a path separator.
        re += "[^/]*";
        i += 1;
      }
      continue;
    }

    if (c === "?") {
      re += "[^/]";
      i += 1;
      continue;
    }

    if (c === "{") {
      re += "(?:";
      braceDepth++;
      i += 1;
      continue;
    }
    if (c === "}" && braceDepth > 0) {
      re += ")";
      braceDepth--;
      i += 1;
      continue;
    }
    if (c === "," && braceDepth > 0) {
      re += "|";
      i += 1;
      continue;
    }

    if (c === "[") {
      // Character class: copy through the closing ']', negation via ! or ^.
      const end = g.indexOf("]", i + 1);
      if (end === -1) {
        // Unterminated — treat '[' literally.
        re += "\\[";
        i += 1;
        continue;
      }
      let body = g.slice(i + 1, end);
      if (body.startsWith("!") || body.startsWith("^")) body = "^" + body.slice(1);
      re += `[${body}]`;
      i = end + 1;
      continue;
    }

    re += REGEXP_SPECIALS.has(c) ? `\\${c}` : c;
    i += 1;
  }

  return new RegExp(`^${re}$`);
}

/** Strip a leading "./" or "/" so a changed-file path lines up with globs. */
function normalizePath(file: string): string {
  return file.replace(/^\.?\//, "");
}

// ─── Resolvers ──────────────────────────────────────────────────────────────

/** Glob-driven resolver built from `.skynet/modules.json`. */
export class GlobModuleMap implements ModuleResolver {
  private readonly modules: Module[];
  // Per-module compiled matchers, in declared order.
  private readonly matchers: { id: string; globs: RegExp[] }[];

  constructor(entries: ModuleMapEntry[]) {
    // De-dupe by id, first declaration wins (preserves declared order).
    const seen = new Set<string>();
    const ordered = entries.filter((e) => !seen.has(e.id) && seen.add(e.id));
    this.modules = ordered.map((e) => ({ id: e.id, name: e.name }));
    this.matchers = ordered.map((e) => ({
      id: e.id,
      globs: e.globs.map(compileGlob),
    }));
  }

  list(): Module[] {
    return this.modules;
  }

  derive(files: string[]): string[] {
    const hit = new Set<string>();
    for (const raw of files) {
      const file = normalizePath(raw);
      for (const m of this.matchers) {
        if (m.globs.some((g) => g.test(file))) hit.add(m.id);
      }
    }
    return [...hit].sort();
  }
}

/**
 * Fallback resolver used when `.skynet/modules.json` is absent or invalid.
 * Mirrors the seed: the catalog is the seed `Module[]`, and a file touches a
 * module when its path equals or is nested under the module id (the seed ids
 * are directory prefixes like `api/billing`). Same "unmapped → dropped" rule.
 */
export class SeedModuleMap implements ModuleResolver {
  constructor(private readonly modules: Module[]) {}

  list(): Module[] {
    return this.modules;
  }

  derive(files: string[]): string[] {
    const hit = new Set<string>();
    for (const raw of files) {
      const file = normalizePath(raw);
      for (const m of this.modules) {
        if (file === m.id || file.startsWith(`${m.id}/`)) hit.add(m.id);
      }
    }
    return [...hit].sort();
  }
}

// ─── Loading ──────────────────────────────────────────────────────────────

/**
 * Read and validate `.skynet/modules.json` from `repoRoot`. Returns the parsed
 * entries, or `null` if the file is missing or malformed (caller falls back).
 */
export function readModuleMapFile(repoRoot: string): ModuleMapEntry[] | null {
  let text: string;
  try {
    text = readFileSync(join(repoRoot, MODULE_MAP_PATH), "utf8");
  } catch {
    return null; // absent — expected, the common case
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    const mods = (parsed as { modules?: unknown })?.modules;
    if (!Array.isArray(mods)) throw new Error("`modules` must be an array");
    const entries: ModuleMapEntry[] = mods.map((m, i) => {
      const e = m as Partial<ModuleMapEntry>;
      if (typeof e.id !== "string" || typeof e.name !== "string" || !Array.isArray(e.globs)) {
        throw new Error(`module[${i}] must have string id, string name, and globs[]`);
      }
      return { id: e.id, name: e.name, globs: e.globs.map(String) };
    });
    return entries;
  } catch (err) {
    console.warn(`[modules-map] ignoring malformed ${MODULE_MAP_PATH}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Build a {@link ModuleResolver} for a target repo. Loads `.skynet/modules.json`
 * when present (and well-formed); otherwise returns a seed-backed fallback over
 * `fallbackModules`. `repoRoot` undefined (no target repo configured, e.g. the
 * mock+memory dev path) also yields the fallback.
 *
 * Core wires this: `Store.listModules` → `resolver.list()`, and agent module
 * derivation → `resolver.derive(agent.modifiedFiles)`.
 */
export function loadModuleMap(
  repoRoot: string | undefined,
  fallbackModules: Module[],
): ModuleResolver {
  const entries = repoRoot ? readModuleMapFile(repoRoot) : null;
  return entries ? new GlobModuleMap(entries) : new SeedModuleMap(fallbackModules);
}
