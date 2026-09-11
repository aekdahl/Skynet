// githubIssuePlan is the PURE state→issue-action mapping behind task→source
// write-back: which comment/close/reopen a Skynet transition produces on the
// linked GitHub issue. Pinning it keeps the write-back predictable without a
// live GitHub. See docs/task-source-sync.md.
import { describe, it, expect } from "vitest";
import type { Task } from "@skynet/shared";
import { githubIssuePlan, stageLabelFor, buildExternalWebhookPayload, signWebhookBody } from "../apps/server/src/task-sync.js";

function externalTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    workspaceId: "ws",
    projectId: "p1",
    text: "Fix the thing",
    state: "todo",
    runId: null,
    source: { kind: "external", system: "linear", id: "ISSUE-42", url: "https://linear.app/acme/issue/ISSUE-42" },
    ...overrides,
  } as Task;
}

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

describe("stageLabelFor", () => {
  it("mirrors the four kanban stages the roadmap calls out", () => {
    expect(stageLabelFor("triage")).toBe("skynet:triage");
    expect(stageLabelFor("ongoing")).toBe("skynet:ongoing");
    expect(stageLabelFor("review")).toBe("skynet:review");
    expect(stageLabelFor("done")).toBe("skynet:done");
  });

  it("has no stage label for backlog/todo", () => {
    expect(stageLabelFor("backlog")).toBeNull();
    expect(stageLabelFor("todo")).toBeNull();
  });
});

describe("buildExternalWebhookPayload", () => {
  it("builds the body for an externally-sourced task", () => {
    const p = buildExternalWebhookPayload(externalTask(), "todo", "ongoing", "https://github.com/acme/web/pull/7");
    expect(p).toEqual({
      taskId: "t1",
      text: "Fix the thing",
      from: "todo",
      to: "ongoing",
      source: { kind: "external", system: "linear", id: "ISSUE-42", url: "https://linear.app/acme/issue/ISSUE-42" },
      prUrl: "https://github.com/acme/web/pull/7",
    });
  });

  it("carries a null prUrl through untouched", () => {
    const p = buildExternalWebhookPayload(externalTask(), "todo", "done", null);
    expect(p?.prUrl).toBeNull();
  });

  it("is null for a task with no source", () => {
    expect(buildExternalWebhookPayload(externalTask({ source: null }), "todo", "done", null)).toBeNull();
  });

  it("is null for a task sourced from GitHub, not external", () => {
    const task = externalTask({ source: { kind: "github_issue", repo: "acme/web", number: 42, url: "" } });
    expect(buildExternalWebhookPayload(task, "todo", "done", null)).toBeNull();
  });
});

describe("signWebhookBody", () => {
  it("produces a sha256= prefixed hex digest", () => {
    const sig = signWebhookBody("shh", '{"a":1}');
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("is deterministic for the same secret and body", () => {
    expect(signWebhookBody("shh", "same")).toBe(signWebhookBody("shh", "same"));
  });

  it("changes when the secret changes", () => {
    expect(signWebhookBody("shh", "same")).not.toBe(signWebhookBody("other", "same"));
  });

  it("changes when the body changes", () => {
    expect(signWebhookBody("shh", "one")).not.toBe(signWebhookBody("shh", "two"));
  });
});
