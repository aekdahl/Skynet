// Approving a finished diff is the worst moment to ask a human: they didn't
// write the code, may not remember the task, and by then all the leverage is
// gone — reject discards hours of work, so the honest options are rubber-stamp
// or feel bad.
//
// Skynet already gathers real evidence (an independent review verdict, a
// browser-driven deep review, an adversarial breaker, a fixed sensitive-path
// list, the diff's own size) and then ignored it at the gate: every merge asked
// a human, except `approvalLevel: "full"` which merged anything non-high-risk
// with NO review at all. This is the middle — and the reason it's safe to have
// one is that it can always say WHICH condition sent a diff to a person.
import { describe, it, expect } from "vitest";
import {
  decideAutoMerge,
  DEFAULT_AUTO_MERGE_POLICY,
  GATE_REASON_TEXT,
  type MergeEvidence,
  type MergeGateReason,
} from "../apps/server/src/merge-policy.js";

/** Everything present and passing — each test then removes ONE thing. */
const clean = (over: Partial<MergeEvidence> = {}): MergeEvidence => ({
  policy: { ...DEFAULT_AUTO_MERGE_POLICY, enabled: true },
  autonomy: true,
  risk: "medium",
  requiresHumanGlobs: [],
  review: { decision: "approve" },
  deepReviewConfigured: false,
  hasDeepReviewEvidence: false,
  breakerConfigured: false,
  breakerClean: null,
  stat: { add: 40, del: 10, files: 3 },
  ...over,
});

const reasons = (over: Partial<MergeEvidence> = {}) => decideAutoMerge(clean(over)).reasons;

describe("merges unattended only when the evidence is actually there", () => {
  it("merges a small, reviewed, approved diff", () => {
    const d = decideAutoMerge(clean());
    expect(d.autoMerge).toBe(true);
    expect(d.reasons).toEqual([]);
  });

  it("records WHAT the evidence was, so 'who approved this?' has a real answer", () => {
    const d = decideAutoMerge(clean({ deepReviewConfigured: true, hasDeepReviewEvidence: true, breakerConfigured: true, breakerClean: true }));
    expect(d.autoMerge).toBe(true);
    expect(d.explain).toContain("an agent reviewed and approved it");
    expect(d.explain).toContain("deep review exercised it in a browser");
    expect(d.explain).toContain("the breaker tried to break it and couldn't");
  });

  it("is OFF unless the operator turned it on", () => {
    // Handing a project's merges to evidence is a deliberate decision, never
    // one inherited from a default.
    expect(DEFAULT_AUTO_MERGE_POLICY.enabled).toBe(false);
    expect(reasons({ policy: DEFAULT_AUTO_MERGE_POLICY })).toContain("policy-off");
  });

  it("respects the project's master autonomy switch", () => {
    expect(reasons({ autonomy: false })).toContain("autonomy-off");
  });
});

describe("the conditions that send a diff to a human", () => {
  const cases: Array<[string, Partial<MergeEvidence>, MergeGateReason]> = [
    ["no agent reviewed it", { review: null }, "no-review"],
    ["the reviewer flagged it", { review: { decision: "flag" } }, "review-flagged"],
    ["it scored high risk", { risk: "high" }, "high-risk"],
    ["it touches a sensitive path", { requiresHumanGlobs: ["migrations/**"] }, "sensitive-paths"],
    ["it changes too many files", { stat: { add: 1, del: 1, files: 999 } }, "too-many-files"],
    ["it changes too many lines", { stat: { add: 9999, del: 0, files: 1 } }, "too-many-lines"],
    ["deep review is on but this diff has none", { deepReviewConfigured: true, hasDeepReviewEvidence: false }, "deep-review-missing"],
    ["the breaker found something", { breakerConfigured: true, breakerClean: false }, "breaker-flagged"],
  ];

  for (const [name, over, reason] of cases) {
    it(`gates when ${name}`, () => {
      const d = decideAutoMerge(clean(over));
      expect(d.autoMerge).toBe(false);
      expect(d.reasons).toContain(reason);
      // The whole point: the card can say why.
      expect(d.explain).toContain(GATE_REASON_TEXT[reason]);
    });
  }

  it("sensitive paths gate even when every other signal is perfect", () => {
    // Not configurable, deliberately: a policy that could switch this off would
    // defeat the reason the list is fixed.
    const d = decideAutoMerge(clean({
      requiresHumanGlobs: [".github/workflows/**"],
      deepReviewConfigured: true, hasDeepReviewEvidence: true,
      breakerConfigured: true, breakerClean: true,
    }));
    expect(d.autoMerge).toBe(false);
    expect(d.reasons).toEqual(["sensitive-paths"]);
  });
});

describe("it reports EVERY failing condition, not just the first", () => {
  it("so fixing one doesn't reveal the next on a re-run", () => {
    const d = decideAutoMerge(clean({ review: null, risk: "high", stat: { add: 5000, del: 0, files: 99 } }));
    expect(d.reasons).toEqual(expect.arrayContaining(["no-review", "high-risk", "too-many-files", "too-many-lines"]));
  });

  it("reads as a sentence, not a list of enum names", () => {
    const d = decideAutoMerge(clean({ review: null, risk: "high" }));
    expect(d.explain).toMatch(/^Needs you because it .* and .*\.$/);
    expect(d.explain).not.toMatch(/no-review|high-risk/); // the slug never leaks to a human
  });

  it("every reason has operator-facing text", () => {
    // A new reason must not be able to ship without an explanation — an
    // unexplained gate is exactly what this replaces.
    for (const [slug, text] of Object.entries(GATE_REASON_TEXT)) {
      expect(text.length, slug).toBeGreaterThan(5);
      // Prose, not the enum slug echoed back at a human.
      expect(text, slug).not.toBe(slug);
      expect(text, slug).toMatch(/\s/);
    }
  });
});

describe("evidence a project never opted into isn't held against it", () => {
  it("doesn't demand deep review when the project doesn't run it", () => {
    // Holding a project to a bar it never chose would just mean nothing merges.
    expect(decideAutoMerge(clean({ deepReviewConfigured: false, hasDeepReviewEvidence: false })).autoMerge).toBe(true);
  });

  it("doesn't demand a breaker verdict when the breaker isn't configured", () => {
    expect(decideAutoMerge(clean({ breakerConfigured: false, breakerClean: null })).autoMerge).toBe(true);
  });

  it("a configured breaker that recorded NO verdict doesn't block", () => {
    // null = "ran but produced nothing readable". A broken breaker must never
    // wedge the pipeline — the same rule its own implementation follows.
    expect(decideAutoMerge(clean({ breakerConfigured: true, breakerClean: null })).autoMerge).toBe(true);
  });

  it("but a policy can waive review entirely if an operator insists", () => {
    const d = decideAutoMerge(clean({ policy: { ...DEFAULT_AUTO_MERGE_POLICY, enabled: true, requireReviewApproval: false }, review: null }));
    expect(d.autoMerge).toBe(true);
  });
});
