// Unit tests for the PURE simulation-step grade parser. The LLM produces both
// the behavior and the verdict; parseGrade turns the grader's raw reply into a
// {pass, reason} — tolerant of fenced / prose-wrapped JSON, and defaulting to a
// safe FAIL on anything unparseable so a broken grader can't spuriously pass.
import { describe, it, expect } from "vitest";
import { parseGrade } from "../apps/server/src/simulation/grade.js";

describe("parseGrade", () => {
  it("parses a clean {pass:true, reason} verdict", () => {
    const v = parseGrade('{"pass": true, "reason": "reply is helpful and proposes no action"}');
    expect(v.pass).toBe(true);
    expect(v.reason).toBe("reply is helpful and proposes no action");
  });

  it("parses a fenced + prose-wrapped verdict", () => {
    const raw = [
      "Sure, here is my judgement:",
      "```json",
      '{"pass": false, "reason": "the assistant dead-ended without answering"}',
      "```",
      "Let me know if you need more.",
    ].join("\n");
    const v = parseGrade(raw);
    expect(v.pass).toBe(false);
    expect(v.reason).toBe("the assistant dead-ended without answering");
  });

  it("defaults to a safe fail on a non-JSON reply", () => {
    const v = parseGrade("I think it looks fine to me, no JSON here.");
    expect(v.pass).toBe(false);
    expect(v.reason).toBe("grader returned an unparseable verdict");
  });

  it("defaults to a safe fail when `pass` is missing or non-boolean", () => {
    const v = parseGrade('{"reason": "no verdict field"}');
    expect(v.pass).toBe(false);
    expect(v.reason).toBe("grader returned an unparseable verdict");
  });

  it("supplies a default reason when the grader omits one", () => {
    const v = parseGrade('{"pass": true}');
    expect(v.pass).toBe(true);
    expect(v.reason.length).toBeGreaterThan(0);
  });
});
