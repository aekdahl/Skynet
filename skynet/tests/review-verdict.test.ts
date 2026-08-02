import { describe, it, expect } from "vitest";
import { parseReviewVerdict } from "../apps/server/src/review-verdict.js";

// The verdict is a MODEL-EMITTED structured field we validate — we never classify
// its prose. So an APPROVE whose reason mentions "flagged" is still an approve,
// and an unreadable reply is held for a human (never auto-approved).
describe("parseReviewVerdict — structured", () => {
  it("reads the verdict field; reason prose is irrelevant to the decision", () => {
    const v = parseReviewVerdict(
      '{"verdict":"approve","reason":"Delivers the outcome; the gh CLI is a clearly-flagged, reasonable deviation."}',
    );
    expect(v.approve).toBe(true);
    expect(v.reason).toMatch(/clearly-flagged/); // the word no longer flips the verdict
  });

  it("flags on verdict:flag and keeps the stated reason", () => {
    const v = parseReviewVerdict('{"verdict":"flag","reason":"no tests, can 500 on empty input"}');
    expect(v.approve).toBe(false);
    expect(v.reason).toBe("no tests, can 500 on empty input");
  });

  it("tolerates a ```json fence and surrounding prose", () => {
    const v = parseReviewVerdict('Here is my review:\n```json\n{"verdict":"approve","reason":"looks good"}\n```');
    expect(v.approve).toBe(true);
    expect(v.reason).toBe("looks good");
  });

  it("is case-insensitive on the verdict value", () => {
    expect(parseReviewVerdict('{"verdict":"APPROVE","reason":"ok"}').approve).toBe(true);
    expect(parseReviewVerdict('{"verdict":"Flag","reason":"nope"}').approve).toBe(false);
  });

  it("FLAGS (never auto-approves) when the reply isn't a readable verdict", () => {
    for (const bad of ["", "   ", "looks fine to me, ship it", "{not json", '{"verdict":"maybe"}', '{"reason":"x"}']) {
      const v = parseReviewVerdict(bad);
      expect(v.approve).toBe(false); // the safe default — hold for a human
      expect(v.reason.length).toBeGreaterThan(0);
    }
  });

  it("a flag with no stated reason still carries a reason", () => {
    expect(parseReviewVerdict('{"verdict":"flag"}').reason).toMatch(/no reason given/i);
  });
});
