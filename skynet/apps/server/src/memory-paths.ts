// ─── Memory file paths (Memory v0, phase 1) ─────────────────────────────────
// Pure scope → relative-path resolution, per docs/memory-format.md's layout.
// Slugs are the CALLER's job (Operations already has a `slug()` helper) —
// this stays a pure function so it's testable with plain strings.

import type { MemoryScope } from "@skynet/shared";

/**
 * A project's slug for its `.skynet/memory/projects/<slug>.md` filename —
 * matches Operations' own private `slug()` helper exactly (lowercase,
 * non-alphanumeric runs collapsed to a single `-`, trimmed, capped at 24
 * chars) so a project's memory path is stable and predictable independent of
 * which call site derives it (reading vs. writing must never disagree).
 */
export function memorySlug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24);
}

export class InvalidMemoryScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMemoryScopeError";
  }
}

/**
 * The relative path (under `.skynet/memory/`) for a fact of the given scope,
 * per the format's own layout:
 *   workspace → workspace.md
 *   project   → projects/<projectSlug>.md
 *   area      → areas/<projectSlug>/<areaSlug>.md
 *   agent     → agents/<agentFamily>.md
 * `projectSlug` is required for `project`/`area` (ignored otherwise). Throws
 * for `area`/`agent` missing their required slug/family — a caller bug (the
 * server always has these before calling), not a runtime condition to
 * degrade gracefully from.
 */
export function memoryFilePath(
  scope: MemoryScope,
  projectSlug: string,
  opts: { areaSlug?: string | null; agentFamily?: string | null } = {},
): string {
  const base = ".skynet/memory";
  switch (scope) {
    case "workspace":
      return `${base}/workspace.md`;
    case "project":
      return `${base}/projects/${projectSlug}.md`;
    case "area":
      if (!opts.areaSlug) throw new InvalidMemoryScopeError("An area-scoped fact needs an area.");
      return `${base}/areas/${projectSlug}/${opts.areaSlug}.md`;
    case "agent":
      if (!opts.agentFamily) throw new InvalidMemoryScopeError("An agent-scoped fact needs an agentFamily.");
      return `${base}/agents/${opts.agentFamily}.md`;
  }
}
