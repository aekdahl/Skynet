// ─── Roadmap state-block serializer (Phase 24) ──────────────────────────────
// A machine-generated snapshot ("as of commit X, here's what state every
// tracked line was in") a later task can embed in the doc and diff against.
// Deterministic key order so regenerating it — even with the exact same
// data — produces a byte-identical block, and a REAL change produces the
// smallest possible diff. Always regenerated wholesale; this module has no
// "merge into existing content" path because there isn't meant to be one —
// callers replace the whole block, never hand-edit it.
//
// Rendered as a fenced JSON block inside an HTML comment: renders as nothing
// in a markdown viewer, greps/diffs cleanly, and needs no bespoke markdown
// dialect of its own.

import type { RoadmapStateBlock, RoadmapStateBlockEntry } from "@skynet/shared";

export const STATE_BLOCK_START = "<!--roadmap-state";
export const STATE_BLOCK_END = "-->";

// Entries are sorted by lineId — the data itself has no inherent order (it's
// a snapshot across the whole doc), so imposing one deterministically is what
// makes "regenerate with unchanged data" a no-op diff.
function sortedEntries(entries: RoadmapStateBlockEntry[]): RoadmapStateBlockEntry[] {
  return [...entries].sort((a, b) => a.lineId.localeCompare(b.lineId));
}

// Fixed key order per entry — JS preserves insertion order for string keys,
// so constructing every entry object with the SAME literal key order (rather
// than spreading/copying, which could vary) is what makes JSON.stringify's
// own output order deterministic without needing a custom stringifier.
function orderedEntry(e: RoadmapStateBlockEntry): RoadmapStateBlockEntry {
  return { lineId: e.lineId, state: e.state, taskIds: [...e.taskIds].sort() };
}

export function serializeRoadmapStateBlock(block: RoadmapStateBlock): string {
  const ordered = { generatedAt: block.generatedAt, commitSha: block.commitSha, entries: sortedEntries(block.entries).map(orderedEntry) };
  const json = JSON.stringify(ordered, null, 2);
  return `${STATE_BLOCK_START}\n${json}\n${STATE_BLOCK_END}\n`;
}

/** Parses a previously-serialized state block back out, or `null` if `text`
 *  isn't one (not present, or the JSON inside is malformed) — a caller
 *  decides what "no existing block" means, this never throws. */
export function parseRoadmapStateBlock(text: string): RoadmapStateBlock | null {
  const start = text.indexOf(STATE_BLOCK_START);
  if (start === -1) return null;
  const end = text.indexOf(STATE_BLOCK_END, start);
  if (end === -1) return null;
  const inner = text.slice(start + STATE_BLOCK_START.length, end).trim();
  try {
    const parsed = JSON.parse(inner) as RoadmapStateBlock;
    return parsed;
  } catch {
    return null;
  }
}
