import { describe, it, expect } from "vitest";
import { parseReviewVerdict } from "../apps/server/src/review-verdict.js";

describe("parseReviewVerdict", () => {
  it("does NOT flag an APPROVE whose reason merely contains the word 'flagged' (the reported bug)", () => {
    const reply =
      "APPROVE — Delivers the core outcome (paste a git URL → cloned checkout at project creation) " +
      "with tests and passing checks; the `gh` CLI wording is a reasonable, clearly-flagged deviation " +
      "that fits the codebase's deliberate zero-external-dep clone design.";
    const v = parseReviewVerdict(reply);
    expect(v.approve).toBe(true);
    // The reason is the rationale WITHOUT the leading verdict word.
    expect(v.reason.startsWith("APPROVE")).toBe(false);
    expect(v.reason).toMatch(/^Delivers the core outcome/);
  });

  it("flags when the verdict word IS flag, and declares the reason", () => {
    const v = parseReviewVerdict("FLAG — the new endpoint has no tests and can 500 on empty input.");
    expect(v.approve).toBe(false);
    expect(v.reason).toBe("the new endpoint has no tests and can 500 on empty input.");
  });

  it("approves on a bare APPROVE, flags on a bare FLAG (with a stated fallback reason)", () => {
    expect(parseReviewVerdict("APPROVE").approve).toBe(true);
    const flag = parseReviewVerdict("FLAG");
    expect(flag.approve).toBe(false);
    expect(flag.reason).toMatch(/no reason given/i); // a flag ALWAYS carries a reason
  });

  it("is case-insensitive and tolerates a leading colon/period separator", () => {
    expect(parseReviewVerdict("approve: looks good").approve).toBe(true);
    expect(parseReviewVerdict("approve: looks good").reason).toBe("looks good");
    expect(parseReviewVerdict("Flag. missing migration").approve).toBe(false);
    expect(parseReviewVerdict("Flag. missing migration").reason).toBe("missing migration");
  });

  it("defaults to approve when the verdict word is neither (never a spurious flag)", () => {
    // e.g. the model hedges — we only ever FLAG on an explicit leading FLAG.
    const v = parseReviewVerdict("Looks fine to me, ship it.");
    expect(v.approve).toBe(true);
  });

  it("handles empty/garbage input without throwing", () => {
    expect(parseReviewVerdict("").approve).toBe(true);
    expect(parseReviewVerdict("   ").reason).toMatch(/auto-approved/i);
  });
});
