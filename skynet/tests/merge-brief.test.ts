import { describe, it, expect } from "vitest";
import { parseMergeBrief } from "../apps/server/src/merge-brief.js";

// The merge brief is a MODEL-EMITTED structured field, same discipline as the
// auto-review verdict and the diff walkthrough: read it, never classify prose.
// A missing/empty summary means no brief at all — the diff HITL still raises
// fine without one (see the orchestrator wiring test for that behavior).
describe("parseMergeBrief — structured", () => {
  it("reads the summary and the risks/mitigations arrays", () => {
    const b = parseMergeBrief(
      '{"summary":"Adds a token-bucket rate limiter to the API.",' +
        '"risks":["touches request-handling middleware order"],' +
        '"mitigations":["covered by an added test"]}',
    );
    expect(b?.summary).toBe("Adds a token-bucket rate limiter to the API.");
    expect(b?.risks).toEqual(["touches request-handling middleware order"]);
    expect(b?.mitigations).toEqual(["covered by an added test"]);
  });

  it("empty risks/mitigations arrays are a valid, safe brief", () => {
    const b = parseMergeBrief('{"summary":"Fixes a typo in a comment.","risks":[],"mitigations":[]}');
    expect(b?.summary).toBe("Fixes a typo in a comment.");
    expect(b?.risks).toEqual([]);
    expect(b?.mitigations).toEqual([]);
  });

  it("tolerates a ```json fence and surrounding prose", () => {
    const b = parseMergeBrief('Here is my read:\n```json\n{"summary":"Refactors the parser.","risks":[],"mitigations":[]}\n```');
    expect(b?.summary).toBe("Refactors the parser.");
  });

  it("drops non-string entries in risks/mitigations instead of failing the whole brief", () => {
    const b = parseMergeBrief('{"summary":"s","risks":[42,null,"a real risk",{"x":1}],"mitigations":["ok",true]}');
    expect(b?.summary).toBe("s");
    expect(b?.risks).toEqual(["a real risk"]);
    expect(b?.mitigations).toEqual(["ok"]);
  });

  it("caps risks and mitigations at 6 entries each", () => {
    const many = Array.from({ length: 10 }, (_, i) => `risk ${i}`);
    const b = parseMergeBrief(JSON.stringify({ summary: "s", risks: many, mitigations: many }));
    expect(b?.risks).toHaveLength(6);
    expect(b?.mitigations).toHaveLength(6);
  });

  it("returns null (no brief) when the reply isn't readable — never blocks the review", () => {
    for (const bad of ["", "   ", "looks safe, merge it", "{not json", '{"risks":[]}', '{"summary":""}']) {
      expect(parseMergeBrief(bad)).toBeNull();
    }
  });

  it("missing risks/mitigations fields default to empty arrays, not a crash", () => {
    const b = parseMergeBrief('{"summary":"s"}');
    expect(b?.risks).toEqual([]);
    expect(b?.mitigations).toEqual([]);
  });
});
