// Phase 24 — line identity is the whole point of the roadmap doc model: a
// re-parse must not scramble which line is which. Covers exactly the two
// acceptance-criteria scenarios (an insertion elsewhere, a rewording of
// unrelated lines) plus the anchor-injection mechanics that make a genuine
// rewording survive too.
import { describe, it, expect } from "vitest";
import type { RoadmapAstNode, RoadmapChecklistItemNode } from "@skynet/shared";
import { parseRoadmapAst, serializeRoadmapAst } from "../apps/server/src/roadmap/ast.js";
import { assignLineIdentity, lineSimilarity } from "../apps/server/src/roadmap/identity.js";

const items = (ast: RoadmapAstNode[]) => ast.filter((n): n is RoadmapChecklistItemNode => n.type === "checklistItem");

/** Parse raw markdown and assign fresh ids (no prior doc) — the entry point
 *  a first-ever sync uses. */
function parseFresh(raw: string) {
  return assignLineIdentity(parseRoadmapAst(raw), null);
}

const BASE = `## Section

- [ ] Task A about caching
- [ ] Task B about the merge queue
- [ ] Task C about billing exports
`;

describe("roadmap line identity", () => {
  it("a fresh parse (no prior doc) assigns ids with zero anchors added", () => {
    const ast = parseFresh(BASE);
    const its = items(ast);
    expect(its).toHaveLength(3);
    for (const it of its) {
      expect(it.text).not.toContain("<!--#");
      expect(it.id).toHaveLength(12);
    }
    // Round-trips exactly — fresh identity assignment must not touch raw text.
    expect(serializeRoadmapAst(ast)).toBe(BASE);
  });

  it("ids survive an insertion elsewhere in the file — untouched lines keep their exact id", () => {
    const before = parseFresh(BASE);
    const beforeIds = new Map(items(before).map((it) => [it.text, it.id]));

    const withInsertion = `## Section

- [ ] Task A about caching
- [ ] A brand new line inserted here
- [ ] Task B about the merge queue
- [ ] Task C about billing exports
`;
    const after = assignLineIdentity(parseRoadmapAst(withInsertion), before);
    const afterIts = items(after);
    expect(afterIts).toHaveLength(4);

    for (const [text, id] of beforeIds) {
      const match = afterIts.find((it) => it.text === text);
      expect(match?.id).toBe(id);
    }
    // The new line gets its OWN fresh id, distinct from every existing one.
    const inserted = afterIts.find((it) => it.text.includes("brand new line"))!;
    expect([...beforeIds.values()]).not.toContain(inserted.id);
  });

  it("a minor rewording of ONE line doesn't change any OTHER (unrelated) line's id", () => {
    const before = parseFresh(BASE);
    const beforeIds = new Map(items(before).map((it) => [it.text, it.id]));

    const reworded = `## Section

- [ ] Task A about caching layers specifically
- [ ] Task B about the merge queue
- [ ] Task C about billing exports
`;
    const after = assignLineIdentity(parseRoadmapAst(reworded), before);
    const afterIts = items(after);

    // B and C are byte-identical to before — untouched, no anchor, same id.
    const b = afterIts.find((it) => it.text === "Task B about the merge queue")!;
    const c = afterIts.find((it) => it.text === "Task C about billing exports")!;
    expect(b.id).toBe(beforeIds.get("Task B about the merge queue"));
    expect(c.id).toBe(beforeIds.get("Task C about billing exports"));
    expect(b.text).not.toContain("<!--#");
    expect(c.text).not.toContain("<!--#");
  });

  it("a genuine rewording reuses the OLD line's id and stamps a trailing anchor comment", () => {
    const before = parseFresh(BASE);
    const oldA = items(before).find((it) => it.text.startsWith("Task A"))!;

    const reworded = `## Section

- [ ] Task A about caching layers specifically
- [ ] Task B about the merge queue
- [ ] Task C about billing exports
`;
    const after = assignLineIdentity(parseRoadmapAst(reworded), before);
    const newA = items(after).find((it) => it.id === oldA.id)!;

    expect(newA).toBeTruthy();
    expect(newA.text).toContain("caching layers specifically");
    expect(newA.text).toContain(`<!--#${oldA.id}-->`);
    expect(newA.raw).toContain(`<!--#${oldA.id}-->`);
    // The anchor is invisible to the readable text a consumer would show —
    // it's appended, not woven into the sentence.
    expect(newA.raw.trim().endsWith(`<!--#${oldA.id}-->`)).toBe(true);
  });

  it("a SECOND reparse of an already-anchored, still-reworded line matches by anchor with zero re-similarity-scoring drift", () => {
    const before = parseFresh(BASE);
    const oldA = items(before).find((it) => it.text.startsWith("Task A"))!;
    const first = assignLineIdentity(
      parseRoadmapAst(`## Section\n\n- [ ] Task A about caching layers specifically\n- [ ] Task B about the merge queue\n- [ ] Task C about billing exports\n`),
      before,
    );

    // Re-parse the SAME (already-anchored) content again — must be a pure
    // exact-match (pass 1, via the embedded anchor), not a fresh similarity
    // guess that could in principle land on a different candidate.
    const serialized = serializeRoadmapAst(first);
    const second = assignLineIdentity(parseRoadmapAst(serialized), first);
    const secondA = items(second).find((it) => it.id === oldA.id)!;
    expect(secondA.text).toBe(items(first).find((it) => it.id === oldA.id)!.text);
    expect(serializeRoadmapAst(second)).toBe(serialized); // idempotent — no further raw changes
  });

  it("a genuinely deleted line's id is dropped, not reassigned to an unrelated survivor", () => {
    const before = parseFresh(BASE);
    const bId = items(before).find((it) => it.text.startsWith("Task B"))!.id;

    const withoutB = `## Section

- [ ] Task A about caching
- [ ] Task C about billing exports
`;
    const after = assignLineIdentity(parseRoadmapAst(withoutB), before);
    const afterIts = items(after);
    expect(afterIts).toHaveLength(2);
    expect(afterIts.some((it) => it.id === bId)).toBe(false);
  });

  it("lineSimilarity: near-identical text scores high, unrelated text scores low", () => {
    expect(lineSimilarity("Task A about caching", "Task A about caching layers specifically")).toBeGreaterThan(0.6);
    expect(lineSimilarity("Task A about caching", "Task C about billing exports")).toBeLessThan(0.3);
    expect(lineSimilarity("", "")).toBe(1);
  });

  // Item 12 (Phase 30 hardening) — the two prior tests only ever exercised
  // the happy path (well above / well below 0.6). SIMILARITY_THRESHOLD's own
  // exact boundary — a score just under 0.6 vs. right at/above it — was
  // never checked, on either lineSimilarity's raw number OR the thing that
  // actually matters: whether assignLineIdentity's pass 2 reuses the old id.
  describe("SIMILARITY_THRESHOLD (0.6) boundary", () => {
    // 5 shared tokens ("alpha".."echo") out of a 9-token union (4 new words
    // added on rewording) → 5/9 ≈ 0.556, just under 0.6.
    const JUST_BELOW_A = "alpha bravo charlie delta echo";
    const JUST_BELOW_B = "alpha bravo charlie delta echo foxtrot golf hotel india";
    // 3 shared tokens out of a 5-token union (2 new words added) → 3/5 = 0.6
    // exactly, right at the inclusive `score >= SIMILARITY_THRESHOLD` cutoff.
    const AT_THRESHOLD_A = "alpha bravo charlie";
    const AT_THRESHOLD_B = "alpha bravo charlie delta echo";

    it("just below 0.6 is NOT a similarity match — the raw score, hand-verified", () => {
      const score = lineSimilarity(JUST_BELOW_A, JUST_BELOW_B);
      expect(score).toBeCloseTo(5 / 9, 5);
      expect(score).toBeLessThan(0.6);
    });

    it("at exactly 0.6 the score meets the threshold — hand-verified", () => {
      const score = lineSimilarity(AT_THRESHOLD_A, AT_THRESHOLD_B);
      expect(score).toBeCloseTo(0.6, 5);
    });

    it("just below 0.6: assignLineIdentity does NOT reuse the old line's id — it's treated as genuinely new, losing whatever was linked to the old id", () => {
      const before = parseFresh(`## Section\n\n- [ ] ${JUST_BELOW_A}\n`);
      const beforeId = items(before)[0]!.id;

      const after = assignLineIdentity(parseRoadmapAst(`## Section\n\n- [ ] ${JUST_BELOW_B}\n`), before);
      const afterItem = items(after)[0]!;
      expect(afterItem.id).not.toBe(beforeId);
      expect(afterItem.text).not.toContain("<!--#"); // pass 3 (genuinely new) never stamps an anchor
    });

    it("at exactly 0.6: assignLineIdentity DOES reuse the old line's id and stamps an anchor", () => {
      const before = parseFresh(`## Section\n\n- [ ] ${AT_THRESHOLD_A}\n`);
      const beforeId = items(before)[0]!.id;

      const after = assignLineIdentity(parseRoadmapAst(`## Section\n\n- [ ] ${AT_THRESHOLD_B}\n`), before);
      const afterItem = items(after)[0]!;
      expect(afterItem.id).toBe(beforeId);
      expect(afterItem.text).toContain(`<!--#${beforeId}-->`);
    });
  });
});
