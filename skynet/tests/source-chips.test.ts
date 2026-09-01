// TASK 21 — "source chips navigate correctly to run/commit/breaker-event
// pages": resolveSourceChip/resolveSourceChips are the pure functions the
// dock renders through, so this pins their hrefs directly rather than
// depending on a live LLM to have cited anything in the first place.
import { describe, it, expect } from "vitest";
import type { Project, TaskRun } from "@skynet/shared";
import { resolveSourceChip, resolveSourceChips } from "../apps/web/src/lib/source-chips.js";

const mkProject = (over: Partial<Project> = {}): Project =>
  ({
    id: "p1", workspaceId: "ws", name: "Checkout", goal: "", runIds: [],
    status: "active", autonomy: true, repoPath: null, gitBacked: false,
    ...over,
  } as Project);

const mkRun = (over: Partial<TaskRun> = {}): TaskRun =>
  ({
    id: "r-abc123def", workspaceId: "ws", projectId: "p1", name: "run", status: "running",
    agentId: "a1", provider: "claude", model: "sonnet-5", branch: "agent/r-abc123def",
    modules: [], progress: 0, plan: [], modifiedFiles: [], log: [], startedAt: 0,
    lastHeartbeatAt: 0, visual: false, previewUrl: null, dependsOn: [], parentId: null,
    branchFromStep: null, archived: false,
    ...over,
  } as TaskRun);

describe("resolveSourceChip — run", () => {
  it("resolves TASK 17's run-detail hash route", () => {
    const chip = resolveSourceChip({ kind: "run", runId: "r-abc123def" }, [mkRun()], []);
    expect(chip).toEqual({ kind: "run", label: "run #abc123de", href: "#/agent/r-abc123def", external: false });
  });

  it("drops a citation for a run that no longer exists", () => {
    expect(resolveSourceChip({ kind: "run", runId: "gone" }, [mkRun()], [])).toBeNull();
  });
});

describe("resolveSourceChip — commit", () => {
  it("prefers the run's own PR url once one exists", () => {
    const run = mkRun({ pr: { number: 42, url: "https://github.com/acme/repo/pull/42", repo: "acme/repo", branch: "agent/r1", base: "main", state: "open", openedAt: 1, briefing: null, dismissed: false } });
    const chip = resolveSourceChip({ kind: "commit", runId: run.id }, [run], [mkProject({ repo: "acme/repo" })]);
    expect(chip).toEqual({ kind: "commit", label: "PR #42", href: "https://github.com/acme/repo/pull/42", external: true });
  });

  it("falls back to the branch tree url before a PR exists", () => {
    const run = mkRun({ pr: null });
    const chip = resolveSourceChip({ kind: "commit", runId: run.id }, [run], [mkProject({ repo: "acme/repo" })]);
    expect(chip).toEqual({ kind: "commit", label: "agent/r-abc123def", href: "https://github.com/acme/repo/tree/agent/r-abc123def", external: true });
  });

  it("resolves to null with no PR and no repo binding — nothing to link to", () => {
    const run = mkRun({ pr: null });
    expect(resolveSourceChip({ kind: "commit", runId: run.id }, [run], [mkProject({ repo: undefined })])).toBeNull();
  });
});

describe("resolveSourceChip — breaker", () => {
  it("resolves TASK 19's breaker panel hash route", () => {
    const chip = resolveSourceChip({ kind: "breaker", projectId: "p1" }, [], [mkProject({ name: "Checkout" })]);
    expect(chip).toEqual({ kind: "breaker", label: "Checkout breaker", href: "#/project/p1/autonomy", external: false });
  });

  it("drops a citation for a project that no longer exists", () => {
    expect(resolveSourceChip({ kind: "breaker", projectId: "gone" }, [], [])).toBeNull();
  });
});

describe("resolveSourceChips — a mixed list", () => {
  it("resolves every kind and drops unresolvable ones, preserving order", () => {
    const run = mkRun();
    const chips = resolveSourceChips(
      [
        { kind: "run", runId: run.id },
        { kind: "run", runId: "gone" },
        { kind: "breaker", projectId: "p1" },
      ],
      [run],
      [mkProject()],
    );
    expect(chips.map((c) => c.kind)).toEqual(["run", "breaker"]);
  });
});
