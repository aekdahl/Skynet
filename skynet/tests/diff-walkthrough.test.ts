import { describe, it, expect } from "vitest";
import { parseDiffWalkthrough } from "../apps/server/src/diff-walkthrough.js";

// The walkthrough is a MODEL-EMITTED structured field, same discipline as the
// auto-review verdict: read it, never classify prose. Comments are trusted
// individually (dropped if they name a file the diff never touched) but an
// unreadable/missing summary means no walkthrough at all — the diff HITL
// still raises fine without one.
describe("parseDiffWalkthrough — structured", () => {
  const FILES = ["src/rate-limit.ts", "src/server.ts"];

  it("reads the summary and keeps comments anchored to files the diff touched", () => {
    const w = parseDiffWalkthrough(
      '{"summary":"Adds a token-bucket limiter and wires it into the server.",' +
        '"comments":[{"file":"src/rate-limit.ts","line":12,"note":"refills every 100ms"},' +
        '{"file":"src/server.ts","line":null,"note":"limiter is applied before auth"}]}',
      FILES,
    );
    expect(w?.summary).toBe("Adds a token-bucket limiter and wires it into the server.");
    expect(w?.comments).toEqual([
      { file: "src/rate-limit.ts", line: 12, note: "refills every 100ms" },
      { file: "src/server.ts", line: null, note: "limiter is applied before auth" },
    ]);
  });

  it("drops a comment naming a file the diff never touched — never trusts a hallucinated citation", () => {
    const w = parseDiffWalkthrough(
      '{"summary":"Small fix.","comments":[{"file":"src/not-in-diff.ts","line":1,"note":"nope"}]}',
      FILES,
    );
    expect(w?.summary).toBe("Small fix.");
    expect(w?.comments).toEqual([]);
  });

  it("tolerates a ```json fence and surrounding prose", () => {
    const w = parseDiffWalkthrough(
      'Here is my walkthrough:\n```json\n{"summary":"Refactors the parser.","comments":[]}\n```',
      FILES,
    );
    expect(w?.summary).toBe("Refactors the parser.");
  });

  it("caps comments at 8 even when the model returns more", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ file: FILES[0], line: i + 1, note: `n${i}` }));
    const w = parseDiffWalkthrough(JSON.stringify({ summary: "Many notes.", comments: many }), FILES);
    expect(w?.comments).toHaveLength(8);
  });

  it("drops a non-positive or non-integer line, keeping the comment as file-level", () => {
    const w = parseDiffWalkthrough(
      '{"summary":"s","comments":[{"file":"src/server.ts","line":-1,"note":"bad line"},{"file":"src/server.ts","line":1.5,"note":"also bad"}]}',
      FILES,
    );
    expect(w?.comments).toEqual([
      { file: "src/server.ts", line: null, note: "bad line" },
      { file: "src/server.ts", line: null, note: "also bad" },
    ]);
  });

  it("returns null (no walkthrough) when the reply isn't readable — never blocks the review", () => {
    for (const bad of ["", "   ", "looks fine, ship it", "{not json", '{"comments":[]}', '{"summary":""}']) {
      expect(parseDiffWalkthrough(bad, FILES)).toBeNull();
    }
  });

  it("ignores malformed comment entries instead of throwing", () => {
    const w = parseDiffWalkthrough(
      '{"summary":"s","comments":[null,"nope",42,{"file":"src/server.ts"},{"note":"missing file"}]}',
      FILES,
    );
    expect(w?.summary).toBe("s");
    expect(w?.comments).toEqual([]); // "missing file" and file-only entries both lack a usable note+file pair
  });
});
