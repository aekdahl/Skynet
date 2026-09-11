// Memory v0, phase 2 — every approved decision carrying a `memoryNote` ("+
// Also remember") becomes a real memory fact automatically, no operator
// authoring step. Same harness as memory-operations.test.ts (that phase 1
// suite is the model for this one): a real throwaway git repo, real
// Operations/Orchestrator/Hub, parse the real git commit object rather than
// trust the return value alone.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { Project, TaskRun, HitlItem } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { Operations } from "../apps/server/src/operations.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerProvider } from "@skynet/runner-sdk";

class NullBus implements Bus {
  publish(): void {}
  subscribe(): () => void {
    return () => {};
  }
}
const provider = {} as RunnerProvider;

let repo: string;
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const memoryPath = () => join(repo, ".skynet", "memory", "workspace.md");

const mkProject = (over: Partial<Project> = {}): Project =>
  ({
    id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "Acme Web", goal: "", runIds: ["r1"],
    status: "active", repoPath: repo, gitBacked: true, repo: null, syncSourceStatus: false,
    ...over,
  }) as Project;

// A plain, never-provisioned run — deliver() falls through to its "no live
// runner, no worktree on disk" honest no-op for an approval-kind gate with
// no existing worktree (resumeDecisionOnFreshRunner's git.worktrees.exists
// check returns false), so this never touches the stub `provider` above.
const mkRun = (over: Partial<TaskRun> = {}): TaskRun =>
  ({
    id: "r1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", name: "Fix the thing",
    status: "review", agentId: "a1", provider: "claude", credentialId: null, model: "opus-4.8",
    endpoint: null, merge: null, handoff: null, branch: "agent/r1", modules: [], progress: 1,
    plan: [], usage: null, modifiedFiles: [], log: [], startedAt: 0, lastHeartbeatAt: 0,
    visual: false, previewUrl: null, dependsOn: [], parentId: null, branchFromStep: null,
    bakeoffId: null, archived: false, pr: null, mergedAt: null, flyDeployment: null,
    ...over,
  }) as TaskRun;

const mkHitl = (over: Partial<HitlItem> = {}): HitlItem =>
  ({
    id: "q1", workspaceId: DEFAULT_WORKSPACE, runId: "r1", bakeoffId: null, kind: "approval",
    title: "Run `npm install left-pad`", why: "installs a new dependency", risk: "medium",
    raisedAt: 0, expiresAt: null, resolvedAt: null, resolution: null, rationale: null,
    command: null, options: null, recommended: null, steps: null, diff: null, output: null,
    flags: [], sourceBranchOverride: null, projectId: null, roadmapProposalId: null,
    ...over,
  }) as HitlItem;

async function setup(projectOver: Partial<Project> = {}) {
  const store = new MemoryStore({ seed: false });
  const hub = new Hub(store, new NullBus());
  const orch = new Orchestrator(store, hub, provider);
  const ops = new Operations({ store, hub, orchestrator: orch });
  await store.putProject(mkProject(projectOver));
  await store.putRun(mkRun());
  return { store, ops };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "skynet-memory-decision-"));
  execFileSync("git", ["init", "-b", "main", repo]);
  git("config", "user.email", "t@t.local");
  git("config", "user.name", "T");
  writeFileSync(join(repo, "README.md"), "hi\n");
  git("add", "-A");
  git("commit", "-m", "init");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("decision-derived memory capture (Memory v0, phase 2)", () => {
  it("approving with a memory note writes a source=decision fact to workspace.md, authored by the operator", async () => {
    const { store, ops } = await setup();
    await store.putHitl(mkHitl());

    const resolved = await ops.resolveHitl(DEFAULT_WORKSPACE, "q1", { action: "approve", memoryNote: "Never install left-pad again" }, "jordan");
    expect(resolved.resolution?.memoryNote).toBe("Never install left-pad again");

    const raw = readFileSync(memoryPath(), "utf8");
    expect(raw).toContain("scope: workspace");
    expect(raw).toContain("## Never install left-pad again");
    expect(raw).toContain("source=decision");
    expect(raw).toContain("confidence=derived");
    expect(raw).toContain("run=r1");
    expect(raw).toContain("hitl=q1");
    expect(raw).toContain("author=jordan");
    expect(raw).toContain('Captured from an approve decision on "Run `npm install left-pad`"');

    const sha = git("rev-parse", "HEAD");
    const commit = git("cat-file", "commit", sha);
    expect(commit.split("\n").find((l) => l.startsWith("author "))).toContain("jordan <jordan@operators.skynet.local>");
  });

  it("approving with no memory note writes nothing", async () => {
    const { store, ops } = await setup();
    await store.putHitl(mkHitl());
    await ops.resolveHitl(DEFAULT_WORKSPACE, "q1", { action: "approve" }, "jordan");
    expect(existsSync(memoryPath())).toBe(false);
  });

  it("a reject carries no memory note (Operations forces it null off-approve) — writes nothing", async () => {
    const { store, ops } = await setup();
    await store.putHitl(mkHitl());
    await ops.resolveHitl(DEFAULT_WORKSPACE, "q1", { action: "reject", memoryNote: "should be ignored" }, "jordan");
    expect(existsSync(memoryPath())).toBe(false);
  });

  it("a chat-only project (no bound repo) is a silent no-op — the approval itself still succeeds", async () => {
    const { store, ops } = await setup({ repoPath: null, gitBacked: false, repo: null });
    await store.putHitl(mkHitl());
    const resolved = await ops.resolveHitl(DEFAULT_WORKSPACE, "q1", { action: "approve", memoryNote: "won't be captured" }, "jordan");
    expect(resolved.resolution?.action).toBe("approve");
    // Nothing to assert on disk — there's no repo to have written into.
  });

  it("resolving an already-resolved item again does not double-write", async () => {
    const { store, ops } = await setup();
    await store.putHitl(mkHitl());
    await ops.resolveHitl(DEFAULT_WORKSPACE, "q1", { action: "approve", memoryNote: "Only once" }, "jordan");
    await ops.resolveHitl(DEFAULT_WORKSPACE, "q1", { action: "approve", memoryNote: "Only once" }, "jordan");

    const raw = readFileSync(memoryPath(), "utf8");
    expect(raw.split("## Only once").length - 1).toBe(1); // exactly one occurrence
  });

  it("a second, different decision appends as its own fact — the first fact's bytes are untouched", async () => {
    const { store, ops } = await setup();
    await store.putHitl(mkHitl({ id: "q1", runId: "r1" }));
    await store.putRun(mkRun({ id: "r2" }));
    await store.putHitl(mkHitl({ id: "q2", runId: "r2" }));

    await ops.resolveHitl(DEFAULT_WORKSPACE, "q1", { action: "approve", memoryNote: "First decision" }, "jordan");
    await ops.resolveHitl(DEFAULT_WORKSPACE, "q2", { action: "approve", memoryNote: "Second decision" }, "jordan");

    const raw = readFileSync(memoryPath(), "utf8");
    expect(raw).toContain("## First decision");
    expect(raw).toContain("## Second decision");
    expect(raw.indexOf("## First decision")).toBeLessThan(raw.indexOf("## Second decision"));
  });
});
