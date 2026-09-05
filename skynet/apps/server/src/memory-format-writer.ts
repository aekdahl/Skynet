// ─── Memory file writer (Memory v0, phase 1) ────────────────────────────────
// The other half of memory-format-reader.ts: serializes a NEW fact block and
// appends it to a memory file's raw text, per docs/memory-format.md's
// "append, don't mutate" editing model. Pure — no filesystem/git access, so
// it's round-trip-testable against parseMemoryFile directly. Never rewrites
// existing content: a file this has never touched, or one hand-edited with
// unknown frontmatter/fact-metadata keys, keeps every byte it already had.

import type { MemoryFactSource, MemoryConfidence, MemoryScope } from "@skynet/shared";

export interface NewFactInput {
  id: string;
  heading: string;
  body: string;
  source: MemoryFactSource;
  author: string;
  created: string; // ISO-8601, matching the spec's `created` field
  confidence: MemoryConfidence;
  run?: string | null;
  hitl?: string | null;
  supersedes?: string | null;
}

/** Quote a metadata value if it contains whitespace — matches the reader's
 *  own `"[^"]*"|\S+` tolerance, so a spaced author handle or id still parses. */
function attr(key: string, value: string): string {
  return /\s/.test(value) ? `${key}="${value}"` : `${key}=${value}`;
}

/** Serialize one fact into its `## heading` + metadata-comment + body block. */
function serializeFact(fact: NewFactInput): string {
  const attrs = [
    attr("id", fact.id),
    attr("source", fact.source),
    attr("author", fact.author),
    attr("created", fact.created),
    attr("confidence", fact.confidence),
    ...(fact.run ? [attr("run", fact.run)] : []),
    ...(fact.hitl ? [attr("hitl", fact.hitl)] : []),
    ...(fact.supersedes ? [attr("supersedes", fact.supersedes)] : []),
  ].join(" ");
  const body = fact.body.trim();
  return `## ${fact.heading.trim()}\n<!-- skynet:fact ${attrs} -->\n${body ? `\n${body}\n` : "\n"}`;
}

/**
 * Fresh frontmatter for a memory file that doesn't exist yet — the spec's
 * required `skynet_memory_version`/`scope` plus whichever of
 * `project`/`area`/`agent_family` apply to this scope.
 */
export function newMemoryFileHeader(
  scope: MemoryScope,
  opts: { project?: string; area?: string; agentFamily?: string } = {},
): string {
  const lines = ["---", "skynet_memory_version: 0.1", `scope: ${scope}`];
  if (opts.project) lines.push(`project: ${opts.project}`);
  if (opts.area) lines.push(`area: ${opts.area}`);
  if (opts.agentFamily) lines.push(`agent_family: ${opts.agentFamily}`);
  lines.push("---", "");
  return lines.join("\n");
}

/**
 * Append `fact` to `existingContent` (empty string for a brand-new file —
 * the caller supplies `header` in that case via `newMemoryFileHeader`).
 * Never touches anything already there: this only ever adds bytes at the end,
 * with a blank-line separator so the new `##` heading starts its own line
 * regardless of how the existing content ends.
 */
export function appendFact(existingContent: string, fact: NewFactInput, header?: string): string {
  const base = existingContent || header || "";
  const separator = base.length === 0 || base.endsWith("\n\n") ? "" : base.endsWith("\n") ? "\n" : "\n\n";
  return `${base}${separator}${serializeFact(fact)}`;
}
