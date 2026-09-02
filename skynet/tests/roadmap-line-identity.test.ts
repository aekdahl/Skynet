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
});
