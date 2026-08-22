// S6 (optional): deep-explore grounding for a SolutionBrief (S4) — before an
// operator approves a draft, a bounded READ-ONLY agent run actually reads the
// codebase (a detached checkout of the base branch, via preview/worktree.ts's
// prepareWorktree — the same machinery the local preview and Fly deploy
// engines share) and appends its findings to the brief. Same "stub provider,
// assert the StartSpec" pattern as deep-review.test.ts — that's the template
// this feature was built from. Drives a REAL git repo (execFileSync +
// mkdtempSync), not a mocked one.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project, ServerEvent, SolutionBrief } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { Operations } from "../apps/server/src/operations.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

class NullBus implements Bus {
  publish(_ws: string, _e: ServerEvent): void {}
  subscribe(): () => void {
    return () => {};
  }
}

// A stub provider that plays the explorer role: records every StartSpec it's
// given (so a test can assert on disallowedTools etc.), then replies with
// canned output the same way claude.ts's real drain() loop would — a plain
// text log line (no `detail`), then onCompleted.
class ExploreProvider implements RunnerProvider {
  readonly id = "claude" as const;
  starts: StartSpec[] = [];
  constructor(private reply = '{"findings":["assumes X but the repo actually does Y"],"touchpoints":["src/foo.ts","src/bar.ts"]}') {}
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    this.starts.push(spec);
    setTimeout(() => {
      events.onLog(spec.runId, this.reply);
      events.onCompleted(spec.runId, spec.branch);
    }, 0);
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
  async consult(): Promise<string> {
    throw new Error("explore should never use the consult path");
  }
}

// A provider whose run never produces a readable verdict — the run "completes"
// but with unreadable prose, exercising exploreBrief's null-on-unreadable path.
class UnreadableExploreProvider implements RunnerProvider {
  readonly id = "claude" as const;
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    setTimeout(() => {
      events.onLog(spec.runId, "I looked around, seems fine I guess");
      events.onCompleted(spec.runId, spec.branch);
    }, 0);
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

// A provider whose run fails outright.
class FailingExploreProvider implements RunnerProvider {
  readonly id = "claude" as const;
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    setTimeout(() => events.onFailed(spec.runId, "boom"), 0);
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

let repo: string;
let worktreesDir: string;
const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: ["ignore", "pipe", "pipe"] }).toString();

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "skynet-explore-repo-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "skynet-explore-wt-"));
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git("config", "user.email", "t@skynet.local");
  git("config", "user.name", "T");
  writeFileSync(join(repo, "foo.ts"), "export const foo = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(worktreesDir, { recursive: true, force: true });
});

function mkBrief(over: Partial<SolutionBrief> = {}): SolutionBrief {
  return {
    id: "brief-1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1",
    title: "Add rate limiting to the login endpoint",
    problem: "Brute-force attempts aren't throttled.",
    approach: "Add a token-bucket limiter in front of /api/auth/login.",
    optionsConsidered: [], risks: ["could lock out real users on shared IPs"],
    acceptanceCriteria: ["5 failed attempts in 1m blocks for 5m"], openQuestions: [],
    status: "draft", featureId: null, createdAt: 0, updatedAt: 0,
    approvedAt: null, approvedBy: null, sourceConversation: null, exploration: null,
    ...over,
  };
}

function setup(provider: RunnerProvider, projectOver: Partial<Project> = {}) {
  const store = new MemoryStore();
  const hub = new Hub(store, new NullBus());
  const orch = new Orchestrator(store, hub, provider, undefined, worktreesDir);
  const ops = new Operations({ store, hub, orchestrator: orch });
  const project: Project = {
    id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [],
    status: "active", autonomy: true, repoPath: repo, gitBacked: true,
    ...projectOver,
  };
  return { store, hub, orch, ops, project };
}

describe("explore a solution brief — success", () => {
  it("appends findings/touchpoints, and the run is read-only (disallowedTools asserted on the StartSpec)", async () => {
    const provider = new ExploreProvider();
    const { store, ops, project } = setup(provider);
    await store.putProject(project);
    await store.putSolutionBrief(mkBrief());

    const updated = await ops.exploreBrief(DEFAULT_WORKSPACE, "p1", "brief-1");

    expect(provider.starts).toHaveLength(1);
    const spec = provider.starts[0]!;
    // The actual, testable guarantee this feature exists for: a stubbed
    // provider CANNOT mutate files — every write/edit/shell tool is denied at
    // the StartSpec level, not left to the model's judgment.
    expect(spec.disallowedTools).toEqual(expect.arrayContaining(["Edit", "MultiEdit", "Write", "NotebookEdit", "Bash"]));
    expect(spec.cwd).not.toBe(repo); // a DETACHED checkout, never the operator's own working copy
    expect(spec.task).toContain("Add rate limiting to the login endpoint");
    expect(spec.task).toContain("Brute-force attempts aren't throttled."); // the problem statement
    expect(spec.task).toContain("token-bucket limiter"); // the approach

    expect(updated.exploration).not.toBeNull();
    expect(updated.exploration?.findings).toEqual(["assumes X but the repo actually does Y"]);
    expect(updated.exploration?.touchpoints).toEqual(["src/foo.ts", "src/bar.ts"]);
    expect(updated.exploration?.at).toBeGreaterThan(0);
    // Never touches operator-authored fields or gates approval.
    expect(updated.status).toBe("draft");
    expect(updated.approach).toBe("Add a token-bucket limiter in front of /api/auth/login.");

    const stored = await store.getSolutionBrief("brief-1");
    expect(stored?.exploration).toEqual(updated.exploration);
  });

  it("re-exploring overwrites the previous exploration with a fresh one", async () => {
    const provider = new ExploreProvider('{"findings":["first pass"],"touchpoints":["a.ts"]}');
    const { store, ops, project } = setup(provider);
    await store.putProject(project);
    await store.putSolutionBrief(mkBrief());
    const first = await ops.exploreBrief(DEFAULT_WORKSPACE, "p1", "brief-1");

    provider.starts = [];
    (provider as unknown as { reply: string }).reply = '{"findings":["second pass, more thorough"],"touchpoints":["a.ts","b.ts"]}';
    const second = await ops.exploreBrief(DEFAULT_WORKSPACE, "p1", "brief-1");

    expect(second.exploration?.findings).toEqual(["second pass, more thorough"]);
    expect(second.exploration?.at).toBeGreaterThanOrEqual(first.exploration!.at);
  });
});

describe("explore a solution brief — failure leaves the brief untouched", () => {
  it("no local repo (repoPath unset): throws, brief unchanged", async () => {
    const provider = new ExploreProvider();
    const { store, ops } = setup(provider, { repoPath: null, gitBacked: false });
    await store.putProject({ id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [], status: "active", autonomy: true, repoPath: null, gitBacked: false });
    await store.putSolutionBrief(mkBrief());

    await expect(ops.exploreBrief(DEFAULT_WORKSPACE, "p1", "brief-1")).rejects.toThrow(/unchanged/i);
    expect(provider.starts).toHaveLength(0); // never even attempted a run
    expect((await store.getSolutionBrief("brief-1"))?.exploration).toBeNull();
  });

  it("the run fails outright: throws a visible error, brief unchanged", async () => {
    const provider = new FailingExploreProvider();
    const { store, ops, project } = setup(provider);
    await store.putProject(project);
    await store.putSolutionBrief(mkBrief());

    await expect(ops.exploreBrief(DEFAULT_WORKSPACE, "p1", "brief-1")).rejects.toThrow(/unchanged/i);
    expect((await store.getSolutionBrief("brief-1"))?.exploration).toBeNull();
  });

  it("an unreadable reply is never trusted as real findings: throws, brief unchanged", async () => {
    const provider = new UnreadableExploreProvider();
    const { store, ops, project } = setup(provider);
    await store.putProject(project);
    await store.putSolutionBrief(mkBrief());

    await expect(ops.exploreBrief(DEFAULT_WORKSPACE, "p1", "brief-1")).rejects.toThrow(/unchanged/i);
    expect((await store.getSolutionBrief("brief-1"))?.exploration).toBeNull();
  });

  it("a brief from another project 404s (never leaks cross-project)", async () => {
    const provider = new ExploreProvider();
    const { store, ops, project } = setup(provider);
    await store.putProject(project);
    await store.putProject({ ...project, id: "p2" });
    await store.putSolutionBrief(mkBrief({ projectId: "p2" }));

    await expect(ops.exploreBrief(DEFAULT_WORKSPACE, "p1", "brief-1")).rejects.toThrow(/not found/i);
    expect(provider.starts).toHaveLength(0);
  });
});
