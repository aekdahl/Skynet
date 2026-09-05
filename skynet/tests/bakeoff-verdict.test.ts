import { describe, it, expect } from "vitest";
import { comparativeReviewInstruction, parseComparativeVerdict } from "../apps/server/src/bakeoff-verdict.js";

// Same "MODEL-EMITTED structured field, never classified from prose" contract
// as review-verdict.test.ts, extended to an N-way comparison: the winner is a
// label ("A"/"B"/...) the judge was actually offered, resolved back to a
// runId through the SAME map the caller built the prompt from.
describe("parseComparativeVerdict — structured", () => {
  const labels = new Map([
    ["A", "run-claude-1"],
    ["B", "run-codex-1"],
    ["C", "run-gemini-1"],
  ]);

  it("resolves a valid label to its runId", () => {
    const v = parseComparativeVerdict('{"winner":"B","reason":"only one that handles the empty-input case"}', labels);
    expect(v.winnerRunId).toBe("run-codex-1");
    expect(v.reason).toBe("only one that handles the empty-input case");
  });

  it("tolerates a ```json fence and surrounding prose", () => {
    const v = parseComparativeVerdict('Comparing the three:\n```json\n{"winner":"A","reason":"cleanest diff"}\n```', labels);
    expect(v.winnerRunId).toBe("run-claude-1");
  });

  it("an explicit null winner is not resolved to any candidate", () => {
    const v = parseComparativeVerdict('{"winner":null,"reason":"all three look equivalent"}', labels);
    expect(v.winnerRunId).toBeNull();
    expect(v.reason).toBe("all three look equivalent");
  });

  it("NEVER resolves a winner from an unknown/malformed label (never guesses)", () => {
    for (const bad of ["", "   ", "B looks best to me", "{not json", '{"winner":"Z","reason":"x"}', '{"reason":"x"}']) {
      const v = parseComparativeVerdict(bad, labels);
      expect(v.winnerRunId).toBeNull(); // the safe default — hold for a human
      expect(v.reason.length).toBeGreaterThan(0);
    }
  });

  it("an unknown label still carries a stated reason when given", () => {
    const v = parseComparativeVerdict('{"winner":"Z","reason":"picked the wrong one on purpose"}', labels);
    expect(v.winnerRunId).toBeNull();
    expect(v.reason).toBe("picked the wrong one on purpose");
  });

  it("a null winner with no stated reason still carries a reason", () => {
    expect(parseComparativeVerdict('{"winner":null}', labels).reason).toMatch(/couldn't confidently pick/i);
  });
});

describe("comparativeReviewInstruction", () => {
  it("lists exactly the labels offered, as quoted alternatives plus null", () => {
    const instruction = comparativeReviewInstruction(["A", "B", "C"]);
    expect(instruction).toContain('"A"|"B"|"C"|null');
  });
});
