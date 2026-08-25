// The ready-to-merge card's decision aid (see merges.tsx + the Solution
// Manager critique that prompted this): a bare "RECOMMEND MERGE" verdict
// isn't enough evidence to click Merge on a high-risk change — the operator
// needs the actual diff composition, WHICH files tripped the sensitive-area
// flag (not just the flag), and who authored vs. who independently reviewed.
// These are pure functions (no I/O) specifically so that evidence can be
// tested directly, without spinning up a git worktree + GitHub push.
import { describe, it, expect } from "vitest";
import {
  mergeSensitiveFiles,
  mergeTouchesTests,
  mergeRisk,
  mergeRequiresHumanGlobs,
  computeMergeBriefing,
  computeFeatureMergeBriefing,
} from "../apps/server/src/orchestrator.js";

describe("mergeSensitiveFiles", () => {
  it("lists the actual file paths that match the sensitive-area heuristic", () => {
    const files = ["src/auth/login.ts", "src/ui/button.tsx", "server/migrations/0001_init.sql"];
    expect(mergeSensitiveFiles(files, [])).toEqual(["src/auth/login.ts", "server/migrations/0001_init.sql"]);
  });
  it("returns [] when nothing matches — no false positive on an ordinary diff", () => {
    expect(mergeSensitiveFiles(["src/ui/button.tsx", "README.md"], ["ui"])).toEqual([]);
  });
  it("falls back to a labeled module match when no individual file name matches", () => {
    // e.g. a file named checkout.ts inside a "billing" module — the module id
    // itself is the evidence, not any single filename.
    expect(mergeSensitiveFiles(["src/checkout.ts"], ["billing"])).toEqual(["module: billing"]);
  });
  it("prefers file-level matches over module-level ones when both exist", () => {
    expect(mergeSensitiveFiles(["src/auth/login.ts"], ["billing"])).toEqual(["src/auth/login.ts"]);
  });
});

describe("mergeTouchesTests", () => {
  it("recognizes common test-file shapes", () => {
    for (const f of ["src/foo.test.ts", "src/foo.spec.ts", "src/tests/foo.ts", "src/test/foo.ts", "src/__tests__/foo.ts"]) {
      expect(mergeTouchesTests([f]), f).toBe(true);
    }
  });
  it("is false when nothing in the diff looks like a test", () => {
    expect(mergeTouchesTests(["src/App.tsx", "README.md"])).toBe(false);
  });
});

describe("mergeRisk", () => {
  it("a sensitive-area change is always high risk, even if small", () => {
    expect(mergeRisk({ add: 2, del: 1, files: ["a.ts"] }, true)).toBe("high");
  });
  it("a broad but non-sensitive change is medium", () => {
    expect(mergeRisk({ add: 10, del: 10, files: Array.from({ length: 20 }, (_, i) => `f${i}.ts`) }, false)).toBe("medium");
    expect(mergeRisk({ add: 5, del: 500, files: ["a.ts"] }, false)).toBe("medium");
    expect(mergeRisk({ add: 500, del: 400, files: ["a.ts"] }, false)).toBe("medium");
  });
  it("a small, non-sensitive change is low", () => {
    expect(mergeRisk({ add: 10, del: 5, files: ["a.ts", "b.ts"] }, false)).toBe("low");
  });
});

describe("mergeRequiresHumanGlobs", () => {
  it("flags migrations/**, .github/workflows/**, and auth/** by path shape", () => {
    expect(mergeRequiresHumanGlobs(["server/migrations/0007_x.sql"])).toEqual(["migrations/**"]);
    expect(mergeRequiresHumanGlobs([".github/workflows/ci.yml"])).toEqual([".github/workflows/**"]);
    expect(mergeRequiresHumanGlobs(["src/auth/session.ts"])).toEqual(["auth/**"]);
  });
  it("flags dependency manifests by filename, wherever they live", () => {
    expect(mergeRequiresHumanGlobs(["apps/web/package.json"])).toEqual(["dependency manifest"]);
    expect(mergeRequiresHumanGlobs(["pnpm-lock.yaml"])).toEqual(["dependency manifest"]);
  });
  it("returns [] on an ordinary diff — no false positive", () => {
    expect(mergeRequiresHumanGlobs(["src/ui/button.tsx", "README.md"])).toEqual([]);
  });
  it("dedupes and reports every distinct category that matched, not just the first", () => {
    const files = ["server/migrations/0001_init.sql", "server/migrations/0002_x.sql", "package.json"];
    expect(mergeRequiresHumanGlobs(files).sort()).toEqual(["dependency manifest", "migrations/**"]);
  });
  it("a workflow-shaped path elsewhere in the tree doesn't false-positive — only the repo-root .github/workflows/**", () => {
    expect(mergeRequiresHumanGlobs(["docs/.github/workflows/ci.yml"])).toEqual([]);
  });
});

describe("computeMergeBriefing — single-run PR", () => {
  const stat = { add: 34428, del: 2340, files: [...Array.from({ length: 273 }, (_, i) => `src/f${i}.ts`), "src/auth/session.ts"] };

  it("carries the real diff stat as structured fields, not just prose", () => {
    const b = computeMergeBriefing({ runName: "Governance to SOTA", authoredBy: "agent-1", verdict: null, stat, modules: [] });
    expect(b.add).toBe(34428);
    expect(b.del).toBe(2340);
    expect(b.filesChanged).toBe(274);
    expect(b.summary).toContain("34428+/2340");
    expect(b.summary).toContain("274 file(s)");
  });

  it("surfaces the actual sensitive file(s), not just the flag in `impact`", () => {
    const b = computeMergeBriefing({ runName: "x", authoredBy: "agent-1", verdict: null, stat, modules: [] });
    expect(b.risk).toBe("high");
    expect(b.impact).toContain("includes a sensitive area");
    expect(b.sensitiveFiles).toEqual(["src/auth/session.ts"]); // the EVIDENCE, addressable — not just the boolean
  });

  it("distinguishes authoredBy from reviewedBy — makes independent review visible", () => {
    const b = computeMergeBriefing({
      runName: "x",
      authoredBy: "agent-1",
      verdict: { by: "agent-2", reason: "looks correct, tests added", decision: "approve" },
      stat: { add: 3, del: 1, files: ["a.ts"] },
      modules: [],
    });
    expect(b.authoredBy).toBe("agent-1");
    expect(b.reviewedBy).toBe("agent-2");
    expect(b.reviewDecision).toBe("approve");
    expect(b.recommendation).toBe("merge");
    expect(b.rationale).toBe("agent-2: looks correct, tests added");
  });

  it("a flagged review forces 'rework', not 'merge'", () => {
    const b = computeMergeBriefing({
      runName: "x",
      authoredBy: "agent-1",
      verdict: { by: "agent-2", reason: "missing error handling", decision: "flag" },
      stat: { add: 3, del: 1, files: ["a.ts"] },
      modules: [],
    });
    expect(b.recommendation).toBe("rework");
    expect(b.reviewDecision).toBe("flag");
  });

  it("no recorded review → honest null, not a fabricated approval", () => {
    const b = computeMergeBriefing({ runName: "x", authoredBy: "agent-1", verdict: null, stat: { add: 3, del: 1, files: ["a.ts"] }, modules: [] });
    expect(b.reviewedBy).toBeNull();
    expect(b.reviewDecision).toBeNull();
    expect(b.rationale).toMatch(/no ai review recorded/i);
  });

  it("no mapped module shows up as a structured field, not just prose", () => {
    const b = computeMergeBriefing({ runName: "x", authoredBy: null, verdict: null, stat: { add: 1, del: 1, files: ["random.ts"] }, modules: [] });
    expect(b.modules).toEqual([]);
    expect(b.impact).toContain("no mapped module");
  });

  it("a diff touching a requires-human path is forced to high risk even when tiny — and an approving reviewer doesn't override the marker", () => {
    const b = computeMergeBriefing({
      runName: "x",
      authoredBy: "agent-1",
      verdict: { by: "agent-2", reason: "looks fine", decision: "approve" },
      stat: { add: 1, del: 1, files: [".github/workflows/deploy.yml"] },
      modules: [],
    });
    expect(b.requiresHuman).toBe(true);
    expect(b.requiresHumanGlobs).toEqual([".github/workflows/**"]);
    expect(b.risk).toBe("high");
  });

  it("an ordinary diff carries requiresHuman:false and an empty glob list", () => {
    const b = computeMergeBriefing({ runName: "x", authoredBy: null, verdict: null, stat: { add: 3, del: 1, files: ["src/ui/button.tsx"] }, modules: [] });
    expect(b.requiresHuman).toBe(false);
    expect(b.requiresHumanGlobs).toEqual([]);
  });
});

describe("computeFeatureMergeBriefing — batched feature PR", () => {
  const stat = { add: 20, del: 5, files: ["src/a.ts", "src/b.ts"] };

  it("any flagged sibling forces rework for the whole batch, never hidden by clean siblings", () => {
    const b = computeFeatureMergeBriefing({ featureName: "Checkout", taskNames: ["do X", "do Y"], stat, modules: [], flaggedCount: 1, anyReviewed: true });
    expect(b.recommendation).toBe("rework");
    expect(b.reviewDecision).toBe("flag");
    expect(b.rationale).toMatch(/1 of 2 task/);
  });

  it("no siblings reviewed → honest null, not a blanket approval", () => {
    const b = computeFeatureMergeBriefing({ featureName: "Checkout", taskNames: ["do X"], stat, modules: [], flaggedCount: 0, anyReviewed: false });
    expect(b.reviewDecision).toBeNull();
    expect(b.recommendation).toBe("merge"); // still the default action — just not falsely "reviewed"
  });

  it("a batch has no single author/reviewer — both null (per-task detail lives in rationale)", () => {
    const b = computeFeatureMergeBriefing({ featureName: "Checkout", taskNames: ["do X"], stat, modules: [], flaggedCount: 0, anyReviewed: true });
    expect(b.authoredBy).toBeNull();
    expect(b.reviewedBy).toBeNull();
    expect(b.reviewDecision).toBe("approve");
  });

  it("a batch touching a requires-human path is forced to high risk, even with no flagged siblings", () => {
    const b = computeFeatureMergeBriefing({
      featureName: "Checkout",
      taskNames: ["do X"],
      stat: { add: 2, del: 0, files: ["package.json"] },
      modules: [],
      flaggedCount: 0,
      anyReviewed: true,
    });
    expect(b.requiresHuman).toBe(true);
    expect(b.requiresHumanGlobs).toEqual(["dependency manifest"]);
    expect(b.risk).toBe("high");
  });
});
