// Manual "Request review" — force a review pass on demand rather than waiting
// for a periodic tick to happen to find an idle reviewer on its own. Drives
// the real Orchestrator/Operations against a real throwaway git repo (no
// mocked review logic) so the honest failure modes (already reviewed / no
// open gate / no reviewer free) and the success path (a verdict gets recorded
// via the SAME autoReview the periodic tick uses) are exercised end to end.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { ProviderId, Project, Agent, Task, HitlItem } from "@skynet/shared";
import type { ConsultSpec, RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";
import type { Bus } from "../apps/server/src/bus.js";

class NullBus implements Bus {
  publish(): void {}
  subscribe(): () => void {
    return () => {};
  }
}

// Every run completion also fires OTHER consults (a diff walkthrough, a merge
// brief) unrelated to review — this mock only records the ones that are
// actually autoReview's "does this satisfy the task" question, so assertions
// aren't coupled to how many unrelated consults the diff-raise pipeline
// happens to make.
class ReviewableProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  reviewConsultCalls: string[] = [];
  constructor(private verdict: string = '{"verdict":"approve","reason":"looks fine"}') {}
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    writeFileSync(join(spec.cwd!, "feature.txt"), "hello\n");
    setTimeout(() => events.onCompleted(spec.runId, spec.branch), 0);
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
  consult = async (_spec: ConsultSpec, question: string): Promise<string> => {
    if (/Review whether this run satisfies/.test(question)) {
      this.reviewConsultCalls.push(question);
      return this.verdict;
    }
    return "{}"; // diff walkthrough / merge brief — not what these tests cover
  };
}

let Hub: typeof import("../apps/server/src/hub.js").Hub;
let Orchestrator: typeof import("../apps/server/src/orchestrator.js").Orchestrator;
let NoOpenReviewGateError: typeof import("../apps/server/src/orchestrator.js").NoOpenReviewGateError;
let AlreadyReviewedError: typeof import("../apps/server/src/orchestrator.js").AlreadyReviewedError;
let NoReviewerAvailableError: typeof import("../apps/server/src/orchestrator.js").NoReviewerAvailableError;
let Operations: typeof import("../apps/server/src/operations.js").Operations;
let MemoryStore: typeof import("../apps/server/src/store/memory.js").MemoryStore;
let repo: string, worktreesDir: string;

const waitFor = async (pred: () => Promise<boolean>, ms = 8000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not met in time");
};

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "skynet-request-review-repo-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "skynet-request-review-wt-"));
  execFileSync("git", ["init", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@t.local"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "T"]);
  writeFileSync(join(repo, "README.md"), "# base\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-m", "base"]);
  process.env.STORE = "memory";
  process.env.BUS = "memory";
  process.env.SKYNET_INTEGRATION_REPO = repo;
  process.env.SKYNET_WORKTREES_DIR = worktreesDir;
  process.env.SKYNET_BASE_BRANCH = "main";
  delete process.env.RUNNER;
  ({ Hub } = await import("../apps/server/src/hub.js"));
  ({ Orchestrator, NoOpenReviewGateError, AlreadyReviewedError, NoReviewerAvailableError } = await import("../apps/server/src/orchestrator.js"));
  ({ Operations } = await import("../apps/server/src/operations.js"));
  ({ MemoryStore } = await import("../apps/server/src/store/memory.js"));
}, 30_000);
afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(worktreesDir, { recursive: true, force: true });
});

const openDiffFor = (store: InstanceType<typeof MemoryStore>, runId: string) => async (): Promise<HitlItem | undefined> =>
  (await store.listQueue(DEFAULT_WORKSPACE)).find((q) => q.runId === runId && q.kind === "diff" && q.resolvedAt == null);

function harness(verdict?: string) {
  const store = new MemoryStore({ seed: false });
  const hub = new Hub(store, new NullBus());
  const provider = new ReviewableProvider(verdict);
  const orchestrator = new Orchestrator(store, hub, provider);
  const ops = new Operations({ store, hub, orchestrator });
  return { store, hub, provider, orchestrator, ops };
}

describe("requestReview", () => {
  // Distinct task text per test — branch naming is a pure slug of the task
  // text plus a per-orchestrator disambiguation counter that resets fresh
  // each `harness()`, so two tests sharing text would fight over the same
  // branch name in the one shared throwaway repo/worktreesDir.
  it("records a verdict via the same autoReview an idle SECOND agent would give on the periodic tick", async () => {
    const { store, provider, ops } = harness();
    await store.putAgent({ id: "doer", workspaceId: DEFAULT_WORKSPACE, name: "doer", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
    const project = await ops.createProject(DEFAULT_WORKSPACE, { name: "P", goal: "", repo: undefined });
    const task = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "task alpha" });
    const run = await ops.assignTask(DEFAULT_WORKSPACE, project.id, task.id); // "doer" picks it up
    await waitFor(openDiffFor(store, run.id));

    // Only NOW does a second, genuinely idle, review-eligible agent exist.
    await store.putAgent({ id: "reviewer", workspaceId: DEFAULT_WORKSPACE, name: "reviewer", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);

    await ops.requestReview(DEFAULT_WORKSPACE, task.id);

    const reviewed = await store.getTask(task.id);
    expect(reviewed?.reviewVerdict).toMatchObject({ decision: "approve", reason: "looks fine", by: "reviewer" });
    expect(provider.reviewConsultCalls).toHaveLength(1);
  });

  it("throws AlreadyReviewedError instead of silently no-op'ing on a task with an existing verdict", async () => {
    const { store, provider, ops } = harness();
    await store.putAgent({ id: "doer", workspaceId: DEFAULT_WORKSPACE, name: "doer", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
    await store.putAgent({ id: "reviewer", workspaceId: DEFAULT_WORKSPACE, name: "reviewer", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
    // autonomy: false — an approve verdict is recorded but does NOT auto-merge,
    // so the task stays in `review` (with a verdict) for the second call to
    // actually hit AlreadyReviewedError rather than "no longer in review".
    const project = await ops.createProject(DEFAULT_WORKSPACE, { name: "P", goal: "", repo: undefined, autonomy: false });
    const task = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "task bravo" });
    const run = await ops.assignTask(DEFAULT_WORKSPACE, project.id, task.id);
    await waitFor(openDiffFor(store, run.id));

    await ops.requestReview(DEFAULT_WORKSPACE, task.id); // first pass — records a verdict

    await expect(ops.requestReview(DEFAULT_WORKSPACE, task.id)).rejects.toThrow(AlreadyReviewedError);
    expect(provider.reviewConsultCalls).toHaveLength(1); // never called a second time
  });

  it("throws NoReviewerAvailableError when the only agent is the run's own doer", async () => {
    const { store, provider, ops } = harness();
    await store.putAgent({ id: "doer", workspaceId: DEFAULT_WORKSPACE, name: "doer", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
    const project = await ops.createProject(DEFAULT_WORKSPACE, { name: "P", goal: "", repo: undefined });
    const task = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "task charlie" });
    const run = await ops.assignTask(DEFAULT_WORKSPACE, project.id, task.id);
    await waitFor(openDiffFor(store, run.id));
    // "doer" may be idle again now (finished), but it's the SAME agent — the
    // "not the run's own doer" exclusion, not a lack of idle agents, is what
    // this test guards against a naive "any idle agent" implementation.

    await expect(ops.requestReview(DEFAULT_WORKSPACE, task.id)).rejects.toThrow(NoReviewerAvailableError);
    expect(provider.reviewConsultCalls).toHaveLength(0);
  });

  it("throws NoOpenReviewGateError for a task that isn't in review", async () => {
    const { ops } = harness();
    const project = await ops.createProject(DEFAULT_WORKSPACE, { name: "P", goal: "", repo: undefined });
    const task = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "task delta" });
    await expect(ops.requestReview(DEFAULT_WORKSPACE, task.id)).rejects.toThrow(NoOpenReviewGateError);
  });

  it("a task that doesn't exist (or belongs to another workspace) 404s via NotFoundError, not a review-specific error", async () => {
    const { ops } = harness();
    await expect(ops.requestReview(DEFAULT_WORKSPACE, "nonexistent")).rejects.toThrow(/not found|Task/i);
  });
});
