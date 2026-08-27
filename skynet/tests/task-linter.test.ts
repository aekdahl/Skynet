import { describe, it, expect } from "vitest";
import { parseTaskLint } from "../apps/server/src/task-linter.js";

// The linter's concerns are a MODEL-EMITTED structured field we validate — we
// never classify its prose. An unreadable reply (or one with junk in the
// `concerns` array) reads as "no concerns", the same safe default as a
// genuinely clean task — never a thrown error.
describe("parseTaskLint — structured", () => {
  it("reads concerns off the field", () => {
    const c = parseTaskLint(
      '{"concerns":[{"kind":"vague","note":"no concrete target"},{"kind":"no-done-definition","note":"no acceptance criteria"}]}',
    );
    expect(c).toEqual([
      { kind: "vague", note: "no concrete target" },
      { kind: "no-done-definition", note: "no acceptance criteria" },
    ]);
  });

  it("an empty concerns array is a clean task", () => {
    expect(parseTaskLint('{"concerns":[]}')).toEqual([]);
  });

  it("tolerates a ```json fence and surrounding prose", () => {
    const c = parseTaskLint('Here you go:\n```json\n{"concerns":[{"kind":"multi-module","note":"touches billing + auth"}]}\n```');
    expect(c).toEqual([{ kind: "multi-module", note: "touches billing + auth" }]);
  });

  it("drops entries with an unknown kind rather than passing them through", () => {
    const c = parseTaskLint('{"concerns":[{"kind":"too-easy","note":"nah"},{"kind":"vague","note":"ok"}]}');
    expect(c).toEqual([{ kind: "vague", note: "ok" }]);
  });

  it("drops entries missing a note", () => {
    expect(parseTaskLint('{"concerns":[{"kind":"vague"}]}')).toEqual([]);
  });

  it("returns no concerns (never throws) when the reply isn't readable JSON", () => {
    for (const bad of ["", "   ", "looks fine to me", "{not json", '{"concerns":"nope"}', "{}"]) {
      expect(parseTaskLint(bad)).toEqual([]);
    }
  });

  it("caps at 5 concerns — a hint, not a report", () => {
    const many = Array.from({ length: 8 }, () => ({ kind: "vague", note: "x" }));
    expect(parseTaskLint(JSON.stringify({ concerns: many }))).toHaveLength(5);
  });

  // v5 "coach" concern kinds — same structured field, just two more values.
  it("reads the v5 missing-dependency and parallel-candidate kinds", () => {
    const c = parseTaskLint(
      '{"concerns":[{"kind":"missing-dependency","note":"says \\"once the API ships\\" but nothing links it"},{"kind":"parallel-candidate","note":"independent of \\"Fix pagination bug\\""}]}',
    );
    expect(c).toEqual([
      { kind: "missing-dependency", note: 'says "once the API ships" but nothing links it' },
      { kind: "parallel-candidate", note: 'independent of "Fix pagination bug"' },
    ]);
  });
});
