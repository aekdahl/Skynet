// githubIssuePlan is the PURE state→issue-action mapping behind task→source
// write-back: which comment/close/reopen a Skynet transition produces on the
// linked GitHub issue. Pinning it keeps the write-back predictable without a
// live GitHub. See docs/task-source-sync.md.
import { describe, it, expect } from "vitest";
import { githubIssuePlan } from "../apps/server/src/task-sync.js";

describe("githubIssuePlan", () => {
  it("→ done closes the issue with a comment", () => {
    const p = githubIssuePlan("review", "done");
    expect(p.state).toBe("closed");
    expect(p.comment).toMatch(/done/i);
  });

  it("→ review comments but does NOT change issue state", () => {
    const p = githubIssuePlan("todo", "review");
    expect(p.state).toBeUndefined();
    expect(p.comment).toMatch(/review/i);
  });

  it("moving back OUT of done reopens the issue", () => {
    const p = githubIssuePlan("done", "triage");
    expect(p.state).toBe("open");
    expect(p.comment).toMatch(/reopen/i);
  });

  it("intermediate board moves touch the issue with nothing", () => {
    expect(githubIssuePlan("backlog", "triage")).toEqual({});
    expect(githubIssuePlan("triage", "todo")).toEqual({});
    expect(githubIssuePlan("todo", "ongoing")).toEqual({});
  });

  it("a no-op (same state) does nothing", () => {
    expect(githubIssuePlan("done", "done")).toEqual({});
  });
});
