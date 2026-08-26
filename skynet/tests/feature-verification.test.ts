// Feature-level verification (Project.deepReview opt-in, reused — no new
// project setting): once every task under a Feature is done and the feature
// branch merges into the project's integration branch (local-only, no
// GitHub), a bounded second agent browses the live MERGED preview and checks
// the FEATURE as a whole — grounded on its description + every sibling
// task's text — before the feature is marked "shipped". A flag holds the
// feature back from shipping (the code stays merged either way) and its
// findings flow into the self-replenishing backlog like a normal review's.
//
// Real git + a real (tiny) preview process (same harness as
// deep-review.test.ts); two real tasks merging into a feature branch (same
// harness as feature-brief-orchestrator.test.ts's local-only sibling).
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, Feature, HitlItem, Project, Resolution, ServerEvent, Task } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import { ProjectPreviewManager } from "../apps/server/src/preview/project-preview.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

class NullBus implements Bus {
  publish(_ws: string, _e: ServerEvent): void {}
  subscribe(): () => void {
    return () => {};
  }
}

// Plays both roles the same single provider needs to: a normal task-doer run
// (write a file, complete) for t1/t2's own assignment, and the verification
// harness's own bounded run (browser evidence + a verdict line) — told apart
// by the synthetic runId `runFeatureVerification` mints (`review-feature-
// verify-<featureId>-<seq>`, never a real task's run id).
class FeatureProvider implements RunnerProvider {
  readonly id = "claude" as const;
  starts: StartSpec[] = [];
  constructor(private verdictReply = '{"verdict":"approve","reason":"feature works end to end"}') {}
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    this.starts.push(spec);
    if (spec.runId.startsWith("review-feature-verify-")) {
      setTimeout(() => {
        events.onLog(spec.runId, "▸ mcp__browser__browser_navigate", "navigate to the preview");
        events.onLog(spec.runId, this.verdictReply);
        events.onCompleted(spec.runId, spec.branch);
      }, 0);
    } else {
      writeFileSync(join(spec.cwd!, `${spec.runId}.txt`), `work for ${spec.runId}\n`);
      setTimeout(() => events.onCompleted(spec.runId, spec.branch), 0);
    }
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

let repo: string;
let worktreesDir: string;
const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: ["ignore", "pipe", "pipe"] }).toString();

function freshRepo() {
  repo = mkdtempSync(join(tmpdir(), "skynet-featverify-repo-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "skynet-featverify-wt-"));
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git("config", "user.email", "t@skynet.local");
  git("config", "user.name", "T");
  // A `.skynet/preview.json` descriptor — the fastest deterministic recipe so
  // startRun reaches "live" quickly, same as deep-review.test.ts. Committed on
  // main, so it survives into the feature branch and then the integration
  // branch after both tasks merge — no separate recipe commit needed.
  mkdirSync(join(repo, ".skynet"));
  writeFileSync(join(repo, ".skynet", "preview.json"), JSON.stringify({ dev: "node server.js" }));
  writeFileSync(join(repo, "server.js"), "require('http').createServer((_q,r)=>r.end('ok')).listen(process.env.PORT);");
  writeFileSync(join(repo, "README.md"), "base\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
}

const waitFor = async (pred: () => Promise<boolean> | boolean, ms = 15_000): Promise<void> => {
  const dl = Date.now() + ms;
  while (Date.now() < dl) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("timeout");
};

/** Assign a task, approve its diff, and wait for its step-1 merge into the
 *  feature branch to finish (task reaches `done`) — mirrors feature-brief-
 *  orchestrator.test.ts's identical helper. */
async function runTaskToDone(
  store: MemoryStore,
  orch: Orchestrator,
  taskId: string,
  projectId: string,
): Promise<void> {
  await orch.assignTask(projectId, taskId);
  const findOpenDiff = async (): Promise<HitlItem | undefined> => {
    const task = await store.getTask(taskId);
    if (!task?.runId) return undefined;
    return (await store.listQueue(DEFAULT_WORKSPACE)).find((h) => h.kind === "diff" && h.runId === task.runId && !h.resolvedAt);
  };
  await waitFor(async () => (await findOpenDiff()) != null);
  const item = (await findOpenDiff())!;
  const resolution: Resolution = { action: "approve", optionIndex: null, guidance: null, targetBranch: null, memoryNote: null, resetWork: false, by: "op-1", at: Date.now() };
  await orch.deliver(item, resolution);
  await waitFor(async () => (await store.getTask(taskId))?.state === "done");
}

async function setup(opts: { deepReview: boolean; verdictReply?: string; secondAgent?: boolean }) {
  freshRepo();
  const store = new MemoryStore({ seed: false });
  const hub = new Hub(store, new NullBus());
  const provider = new FeatureProvider(opts.verdictReply);
  const previewMgr = new ProjectPreviewManager(worktreesDir);
  const orch = new Orchestrator(store, hub, provider, previewMgr);
  const project: Project = {
    id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [],
    status: "active", repoPath: repo, gitBacked: true, deepReview: opts.deepReview,
  } as Project;
  await store.putProject(project);
  await store.putAgent({ id: "a1", workspaceId: DEFAULT_WORKSPACE, name: "a1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
  if (opts.secondAgent !== false) {
    await store.putAgent({ id: "a2", workspaceId: DEFAULT_WORKSPACE, name: "a2", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0, canReview: true } as Agent);
  }
  const feature: Feature = {
    id: "f1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", name: "Rate limiting",
    description: "Add a request rate limiter to the API.", status: "active", milestoneId: null,
    archived: false, createdAt: Date.now(), pr: null, sizeWarning: null, verification: null,
  };
  await store.putFeature(feature);
  await store.putTask({ id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "add limiter middleware", state: "backlog", runId: null, featureId: "f1" } as Task);
  await store.putTask({ id: "t2", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "add limiter tests", state: "backlog", runId: null, featureId: "f1" } as Task);
  return { store, hub, orch, provider };
}

async function completeBothTasks(store: MemoryStore, orch: Orchestrator): Promise<void> {
  await runTaskToDone(store, orch, "t1", "p1");
  await runTaskToDone(store, orch, "t2", "p1");
}

describe("feature verification — deepReview off", () => {
  it("ships the feature exactly as before — no verification run, verification stays null", async () => {
    const { store, orch, provider } = await setup({ deepReview: false });
    await completeBothTasks(store, orch);
    await waitFor(async () => (await store.getFeature("f1"))?.status === "shipped");

    const feature = (await store.getFeature("f1"))!;
    expect(feature.verification).toBeNull();
    expect(provider.starts.some((s) => s.runId.startsWith("review-feature-verify-"))).toBe(false);
  }, 20_000);
});

describe("feature verification — deepReview on", () => {
  it("passing verification ships the feature and records a real browser-driven pass verdict", async () => {
    const { store, orch, provider } = await setup({ deepReview: true });
    await completeBothTasks(store, orch);
    await waitFor(async () => (await store.getFeature("f1"))?.status === "shipped");

    const feature = (await store.getFeature("f1"))!;
    expect(feature.verification?.decision).toBe("pass");
    expect(feature.verification?.reason).toContain("feature works end to end");

    const verifyRun = provider.starts.find((s) => s.runId.startsWith("review-feature-verify-"));
    expect(verifyRun).toBeDefined();
    expect(verifyRun!.browser).toBe(true);
    expect(verifyRun!.disallowedTools).toEqual(expect.arrayContaining(["Edit", "MultiEdit", "Write", "NotebookEdit", "Bash"]));
    expect(verifyRun!.task).toContain("Rate limiting"); // feature name
    expect(verifyRun!.task).toContain("add limiter middleware"); // t1
    expect(verifyRun!.task).toContain("add limiter tests"); // t2
    expect(verifyRun!.task).toMatch(/http:\/\/127\.0\.0\.1:\d+/); // live preview URL
  }, 20_000);

  it("a flagged verification does NOT ship the feature, and its proposal becomes a new backlog task", async () => {
    const { store, orch } = await setup({
      deepReview: true,
      verdictReply: '{"verdict":"flag","reason":"the limiter never actually blocks requests","proposals":[{"title":"fix limiter threshold check","why":"off-by-one lets one extra request through","scope":"in-scope"}]}',
    });
    await completeBothTasks(store, orch);
    await waitFor(async () => (await store.getFeature("f1"))?.verification != null);

    const feature = (await store.getFeature("f1"))!;
    expect(feature.status).toBe("active"); // never marked shipped
    expect(feature.verification?.decision).toBe("flag");
    expect(feature.verification?.reason).toContain("never actually blocks");

    await waitFor(async () => (await store.listTasks(DEFAULT_WORKSPACE)).some((t) => t.text === "fix limiter threshold check"));
    const proposed = (await store.listTasks(DEFAULT_WORKSPACE)).find((t) => t.text === "fix limiter threshold check")!;
    expect(proposed.featureId).toBe("f1"); // attached to the same feature it was found on
  }, 20_000);

  it("a single-agent project still gets verification — unlike per-diff review, the doer isn't excluded from reviewing its own feature", async () => {
    // Deliberate design choice (see verifyFeatureBeforeShip's doc comment):
    // per-diff deep review always excludes the run's own doer as reviewer,
    // but a multi-task Feature usually has several doers and no single
    // "the" author to exclude — a project with only ONE agent total would
    // otherwise NEVER get feature-level verification at all.
    const { store, orch, provider } = await setup({ deepReview: true, secondAgent: false });
    await completeBothTasks(store, orch);
    await waitFor(async () => (await store.getFeature("f1"))?.status === "shipped");

    const feature = (await store.getFeature("f1"))!;
    expect(feature.verification?.decision).toBe("pass");
    expect(provider.starts.some((s) => s.runId.startsWith("review-feature-verify-"))).toBe(true);
  }, 20_000);
});
