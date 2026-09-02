import { describe, it, expect } from "vitest";
import { parseHandoffSummary } from "../apps/server/src/handoff-summary.js";

// Same structured-field discipline as parseDiffWalkthrough/parseReviewVerdict:
// read a model-emitted JSON field, never classify prose, and treat any
// unreadable or empty reply as "no summary" rather than throwing — the
// caller (Orchestrator.relaunchEscalated) already has a safe static
// fallback line for that case.
describe("parseHandoffSummary — structured", () => {
  it("reads the summary field", () => {
    const s = parseHandoffSummary(
      '{"summary":"Tried refactoring the parser but got stuck on a lexer type error."}',
    );
    expect(s).toBe("Tried refactoring the parser but got stuck on a lexer type error.");
  });

  it("trims surrounding whitespace", () => {
    const s = parseHandoffSummary('{"summary":"  spaced out  "}');
    expect(s).toBe("spaced out");
  });

  it("tolerates a ```json fence and surrounding prose", () => {
    const s = parseHandoffSummary(
      'Here is the handoff:\n```json\n{"summary":"Wired up the new endpoint, tests still red."}\n```',
    );
    expect(s).toBe("Wired up the new endpoint, tests still red.");
  });

  it("caps an overlong summary at 1000 chars", () => {
    const long = "a".repeat(2000);
    const s = parseHandoffSummary(JSON.stringify({ summary: long }));
    expect(s).toHaveLength(1000);
  });

  it("returns null for an unreadable or empty reply — never blocks the reassign", () => {
    for (const bad of ["", "   ", "not sure what happened", "{not json", "{}", '{"summary":""}', '{"summary":"   "}', '{"summary":123}']) {
      expect(parseHandoffSummary(bad)).toBeNull();
    }
  });
});
