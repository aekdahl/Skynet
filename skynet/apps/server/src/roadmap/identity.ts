// ─── Roadmap line identity (Phase 24) ───────────────────────────────────────
// Assigns a stable `id` to every checklistItem node in a freshly-parsed AST,
// reconciled against the PREVIOUS parse (if any) so a line's id — and
// whatever links to it (taskIds, questionIds, once a later task sets them) —
// survive a re-parse.
//
// Three-pass, greedy, content-first:
//  1. Exact match — a new line's (anchor-stripped) text hashes to the same
//     value as a previous line's, OR it already carries a `<!--#id-->` anchor
//     matching a previous line's id. Position-independent, so an insertion
//     or a deletion ANYWHERE else in the file never touches this line's id.
//  2. Similarity match — among whatever's left unmatched on both sides, pair
//     up lines whose text is highly similar (a Jaccard token-overlap score
//     above SIMILARITY_THRESHOLD) — a genuine rewording, not a coincidence.
//     Only THIS pass ever stamps a `<!--#id-->` anchor onto a line's raw text
//     (reusing the OLD line's id), and only onto the specific line that
//     matched — never proactively onto every line, and never onto a line
//     whose text didn't change (pass 1 already covered those with no anchor
//     needed).
//  3. Whatever's left is a genuinely new line — id is its own content hash,
//     no anchor (nothing to preserve yet).
//
// A previous line that matches nothing (genuinely deleted) is simply
// dropped — its id/anchor go with it, which is correct: nothing still in the
// file should claim to be it.

import { createHash } from "node:crypto";
import type { RoadmapAstNode, RoadmapChecklistItemNode } from "@skynet/shared";

const ANCHOR_RE = /\s*<!--#([a-zA-Z0-9]+)-->\s*$/;
const ID_HEX_LEN = 12; // short-but-collision-safe for a single file's line count
const SIMILARITY_THRESHOLD = 0.6;

/** Content-hash id for one line's text (already anchor-stripped by the
 *  caller). Truncated sha256 — a fresh, independent purpose from
 *  steward/docs.ts's `contentHash` (a whole-FILE optimistic-concurrency
 *  baseline), not a reuse of it. */
export function hashLineText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, ID_HEX_LEN);
}

/** Splits a trailing `<!--#id-->` anchor comment off a checklist item's text,
 *  if present. Returns the text with any trailing whitespace before the
 *  anchor trimmed too, so hashing/similarity never sees the anchor itself. */
function stripAnchor(text: string): { text: string; anchorId: string | null } {
  const m = ANCHOR_RE.exec(text);
  if (!m) return { text, anchorId: null };
  return { text: text.slice(0, m.index), anchorId: m[1]! };
}

function tokenize(s: string): Set<string> {
  return new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

/** Jaccard token-overlap similarity, 0..1. Pure text metric — deliberately
 *  not pulled from an npm dependency for something this constrained (one
 *  file, dozens to low-hundreds of lines). */
export function lineSimilarity(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection++;
  const union = ta.size + tb.size - intersection;
  return intersection / union;
}

function checklistItems(ast: RoadmapAstNode[]): RoadmapChecklistItemNode[] {
  return ast.filter((n): n is RoadmapChecklistItemNode => n.type === "checklistItem");
}

/**
 * Returns a NEW ast array with every checklistItem's `id` filled in (and,
 * only where a rewording was detected, `text`/`raw` rewritten to carry a
 * trailing anchor comment). `previousAst` is the prior parse's ast (or
 * `null`/`undefined` for a project's first-ever sync — every line then gets
 * a fresh hash id with no anchors).
 */
export function assignLineIdentity(newAst: RoadmapAstNode[], previousAst: RoadmapAstNode[] | null | undefined): RoadmapAstNode[] {
  const prevItems = checklistItems(previousAst ?? []);
  const newItems = checklistItems(newAst);

  const prevByHash = new Map<string, RoadmapChecklistItemNode>();
  const prevByAnchor = new Map<string, RoadmapChecklistItemNode>();
  for (const p of prevItems) {
    const { text, anchorId } = stripAnchor(p.text);
    // First-write-wins on a hash collision within the previous doc itself
    // (shouldn't happen for real distinct lines) — never throws.
    if (!prevByHash.has(hashLineText(text))) prevByHash.set(hashLineText(text), p);
    if (anchorId) prevByAnchor.set(anchorId, p);
  }

  const claimed = new Set<string>(); // previous line ids already reused this pass
  const idFor = new Map<RoadmapChecklistItemNode, { id: string; anchorId: string | null }>();
  let unmatchedNew: RoadmapChecklistItemNode[] = [];

  // Pass 1 — exact match (by anchor, then by content hash).
  for (const n of newItems) {
    const { text: stripped, anchorId } = stripAnchor(n.text);
    const byAnchor = anchorId ? prevByAnchor.get(anchorId) : undefined;
    const byHash = prevByHash.get(hashLineText(stripped));
    const match = byAnchor && !claimed.has(byAnchor.id) ? byAnchor : byHash && !claimed.has(byHash.id) ? byHash : undefined;
    if (match) {
      claimed.add(match.id);
      idFor.set(n, { id: match.id, anchorId }); // keep whatever anchor (if any) was already embedded
    } else {
      unmatchedNew.push(n);
    }
  }

  // Pass 2 — similarity match among what's left, greedy best-score-first so
  // an ambiguous case doesn't get claimed by a worse match first.
  const unmatchedPrev = prevItems.filter((p) => !claimed.has(p.id));
  const candidates: { n: RoadmapChecklistItemNode; p: RoadmapChecklistItemNode; score: number }[] = [];
  for (const n of unmatchedNew) {
    const { text: strippedNew } = stripAnchor(n.text);
    for (const p of unmatchedPrev) {
      const { text: strippedPrev } = stripAnchor(p.text);
      const score = lineSimilarity(strippedNew, strippedPrev);
      if (score >= SIMILARITY_THRESHOLD) candidates.push({ n, p, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const matchedNewIds = new Set<RoadmapChecklistItemNode>();
  for (const c of candidates) {
    if (matchedNewIds.has(c.n) || claimed.has(c.p.id)) continue;
    claimed.add(c.p.id);
    matchedNewIds.add(c.n);
    // A genuine rewording — reuse the old id, and (only now) stamp an anchor
    // so the NEXT reparse finds this line by anchor even if it drifts further.
    idFor.set(c.n, { id: c.p.id, anchorId: c.p.id });
  }
  unmatchedNew = unmatchedNew.filter((n) => !matchedNewIds.has(n));

  // Pass 3 — genuinely new lines: id is their own content hash, no anchor.
  for (const n of unmatchedNew) {
    const { text: stripped } = stripAnchor(n.text);
    idFor.set(n, { id: hashLineText(stripped), anchorId: null });
  }

  return newAst.map((node) => {
    if (node.type !== "checklistItem") return node;
    const resolved = idFor.get(node)!;
    const { text: stripped } = stripAnchor(node.text);
    const finalText = resolved.anchorId != null ? `${stripped} <!--#${resolved.anchorId}-->` : stripped;
    if (finalText === node.text) return { ...node, id: resolved.id };
    // Anchor added/changed — the only case raw is rewritten. `node.text` was
    // sliced directly out of `node.raw` moments ago by the parser, so this
    // substitution is exact; everything else about the line (indent, bullet
    // character, checkbox spacing, trailing newline) is untouched.
    return { ...node, id: resolved.id, text: finalText, raw: node.raw.replace(node.text, finalText) };
  });
}
