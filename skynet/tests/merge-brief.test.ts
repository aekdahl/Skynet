import { describe, it, expect } from "vitest";
import { parseMergeBrief } from "../apps/server/src/merge-brief.js";

// Guided merge's brief is a MODEL-EMITTED structured field, same discipline as
// the diff walkthrough / auto-review verdict: read it, never classify prose.
// An unreadable/missing summary means no brief at all — the diff HITL still
// raises fine without one.
describe("parseMergeBrief — structured", () => {
  it("reads summary, risks, and mitigations", () => {
    const b = parseMergeBrief(
      '{"summary":"Adds a rate limiter to the API and wires it into the request pipeline.",' +
        '"risks":["touches the auth middleware path","adds a new dependency (token-bucket lib)"],' +
        '"mitigations":["covered by the new rate-limit.test.ts suite","limiter is feature-flagged off by default"]}',
    );
    expect(b?.summary).toBe("Adds a rate limiter to the API and wires it into the request pipeline.");
    expect(b?.risks).toEqual(["touches the auth middleware path", "adds a new dependency (token-bucket lib)"]);
    expect(b?.mitigations).toEqual([
      "covered by the new rate-limit.test.ts suite",
      "limiter is feature-flagged off by default",
    ]);
  });

  it("defaults risks/mitigations to an empty array when omitted — an honest empty list, not a fabricated one", () => {
    const b = parseMergeBrief('{"summary":"Small doc fix."}');
    expect(b?.summary).toBe("Small doc fix.");
    expect(b?.risks).toEqual([]);
    expect(b?.mitigations).toEqual([]);
  });

  it("tolerates a ```json fence and surrounding prose", () => {
    const b = parseMergeBrief(
      'Here is my brief:\n```json\n{"summary":"Refactors the parser.","risks":[],"mitigations":[]}\n```',
    );
    expect(b?.summary).toBe("Refactors the parser.");
  });

  it("caps risks and mitigations at 6 each even when the model returns more", () => {
    const many = Array.from({ length: 10 }, (_, i) => `risk ${i}`);
    const b = parseMergeBrief(JSON.stringify({ summary: "s", risks: many, mitigations: many }));
    expect(b?.risks).toHaveLength(6);
    expect(b?.mitigations).toHaveLength(6);
  });

  it("drops non-string or blank entries instead of throwing", () => {
    const b = parseMergeBrief(
      JSON.stringify({ summary: "s", risks: [null, 42, "", "   ", "a real risk"], mitigations: "not an array" }),
    );
    expect(b?.risks).toEqual(["a real risk"]);
    expect(b?.mitigations).toEqual([]); // a non-array field is treated as absent, not thrown on
  });

  it("returns null (no brief) when the reply isn't readable — never blocks the review", () => {
    for (const bad of ["", "   ", "looks safe, merge it", "{not json", '{"risks":[]}', '{"summary":""}']) {
      expect(parseMergeBrief(bad)).toBeNull();
    }
  });
});
