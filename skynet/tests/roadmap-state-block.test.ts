// Phase 24 — the state block is ALWAYS regenerated wholesale, never merged.
// The one property that matters: regenerating from unchanged data produces a
// byte-identical block (so a sync that finds nothing new touches nothing in
// the file), and the key order is deterministic regardless of insertion order.
import { describe, it, expect } from "vitest";
import type { RoadmapStateBlock } from "@skynet/shared";
import { parseRoadmapStateBlock, serializeRoadmapStateBlock, STATE_BLOCK_START, STATE_BLOCK_END } from "../apps/server/src/roadmap/state-block.js";

const block: RoadmapStateBlock = {
  generatedAt: 1_000,
  commitSha: "abc123",
  entries: [
    { lineId: "line-b", state: "todo", taskIds: ["t2", "t1"] },
    { lineId: "line-a", state: "done", taskIds: [] },
  ],
};

describe("roadmap state-block serializer", () => {
  it("regenerating with unchanged data (even reordered entries) produces a byte-identical block", () => {
    const first = serializeRoadmapStateBlock(block);
    const reordered: RoadmapStateBlock = { ...block, entries: [...block.entries].reverse() };
    const second = serializeRoadmapStateBlock(reordered);
    expect(second).toBe(first);
  });

  it("entries are sorted by lineId regardless of input order", () => {
    const text = serializeRoadmapStateBlock(block);
    const idxA = text.indexOf('"line-a"');
    const idxB = text.indexOf('"line-b"');
    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(-1);
    expect(idxA).toBeLessThan(idxB);
  });

  it("a real state change produces a genuinely different block", () => {
    const first = serializeRoadmapStateBlock(block);
    const changed: RoadmapStateBlock = { ...block, entries: [{ ...block.entries[0]!, state: "done" }, block.entries[1]!] };
    expect(serializeRoadmapStateBlock(changed)).not.toBe(first);
  });

  it("is embeddable in and greppable out of a real markdown document", () => {
    const doc = `## Notes\n\nSome prose.\n\n${serializeRoadmapStateBlock(block)}\nMore prose.\n`;
    expect(doc).toContain(STATE_BLOCK_START);
    expect(doc).toContain(STATE_BLOCK_END);
    const parsed = parseRoadmapStateBlock(doc);
    expect(parsed?.commitSha).toBe("abc123");
    expect(parsed?.entries).toHaveLength(2);
  });

  it("parseRoadmapStateBlock returns null for absent or malformed blocks, never throws", () => {
    expect(parseRoadmapStateBlock("no block here at all")).toBeNull();
    expect(parseRoadmapStateBlock(`${STATE_BLOCK_START}\n{ not valid json\n${STATE_BLOCK_END}`)).toBeNull();
  });

  it("round-trips through serialize → embed → parse with the same logical content", () => {
    const text = serializeRoadmapStateBlock(block);
    const parsed = parseRoadmapStateBlock(text)!;
    expect(parsed.generatedAt).toBe(block.generatedAt);
    expect(parsed.commitSha).toBe(block.commitSha);
    expect(new Set(parsed.entries.map((e) => e.lineId))).toEqual(new Set(block.entries.map((e) => e.lineId)));
  });
});
