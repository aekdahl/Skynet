// Bake-off peer review: instead of a human eyeballing N sibling diffs and
// clicking "Pick this one", an eligible NON-participant fleet agent compares
// them and picks a winner (Orchestrator.autoJudgeBakeoff). Drives the real
// Orchestrator/Operations against a real throwaway git repo (no mocked diff
// content) so each sibling produces a genuine diff to compare, and the
// resulting pick flows through the SAME deliver()/collapseBakeoff path a
// human's "Pick this one" click already uses — this suite adds no new merge
// logic, only a new way to arrive at an "approve" resolution.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { ProviderId, Agent, HitlItem } from "@skynet/shared";
import type { ConsultSpec, RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";
import type { Bus } from "../apps/server/src/bus.js";

class NullBus implements Bus {
  publish(): void {}
  subscribe(): () => void {
    return () => {};
  }
}

// Writes a file unique to this run (so every sibling produces its own real,
// distinct diff against the same base commit) then completes — same shape as
// bakeoff.test.ts's ScriptedProvider. `consult` additionally routes on
// question text so this mock only records the COMPARISON question, the same
// way request-review.test.ts's ReviewableProvider isolates autoReview's
// question from the diff-walkthrough/merge-brief consults firing alongside it.
class JudgingProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  judgeCalls: string[] = [];
  constructor(private verdict: string = '{"winner":"A","reason":"cleanest diff"}') {}
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    writeFileSync(join(spec.cwd!, `${spec.runId}.txt`), `written by ${spec.runId}\n`);
    setTimeout(() => events.onCompleted(spec.runId, spec.branch), 0);
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
  consult = async (_spec: ConsultSpec, question: string): Promise<string> => {
    if (/Compare these \d+ independent attempts/.test(question)) {
      this.judgeCalls.push(question);
      return this.verdict;
    }
    return "{}"; // diff walkthrough / merge brief — not what these tests cover
  };
}

let Hub: typeof import("../apps/server/src/hub.js").Hub;
let Orchestrator: typeof import("../apps/server/src/orchestrator.js").Orchestrator;
let NoOpenBakeoffReviewError: typeof import("../apps/server/src/orchestrator.js").NoOpenBakeoffReviewError;
let BakeoffAlreadyJudgedError: typeof import("../apps/server/src/orchestrator.js").BakeoffAlreadyJudgedError;
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
  repo = mkdtempSync(join(tmpdir(), "skynet-bo-judge-repo-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "skynet-bo-judge-wt-"));
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
  ({ Orchestrator, NoOpenBakeoffReviewError, BakeoffAlreadyJudgedError, NoReviewerAvailableError } = await import("../apps/server/src/orchestrator.js"));
  ({ Operations } = await import("../apps/server/src/operations.js"));
  ({ MemoryStore } = await import("../apps/server/src/store/memory.js"));
}, 60_000);
afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(worktreesDir, { recursive: true, force: true });
});

function harness(verdict?: string) {
  const store = new MemoryStore({ seed: false });
  const hub = new Hub(store, new NullBus());
  const provider = new JudgingProvider(verdict);
  const orchestrator = new Orchestrator(store, hub, provider);
  const ops = new Operations({ store, hub, orchestrator });
  return { store, hub, provider, orchestrator, ops };
}

const openDiffs = (store: InstanceType<typeof MemoryStore>) => async (): Promise<HitlItem[]> =>
  (await store.listQueue(DEFAULT_WORKSPACE)).filter((q) => q.kind === "diff" && q.resolvedAt == null);

describe("bake-off peer review", () => {
  it("an eligible non-participant judges a 3-way bake-off and its pick auto-resolves under an autonomous project", async () => {
    const { store, provider, ops } = harness('{"winner":"B","reason":"only one that handles the edge case"}');
    // 3 participants — a real DISTINCT-provider comparison, same test-seam as
    // bakeoff.test.ts (all resolve to the one injected JudgingProvider).
    await store.putAgent({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
    await store.putAgent({ id: "r2", workspaceId: DEFAULT_WORKSPACE, name: "r2", provider: "codex", model: "gpt-5.2-codex", status: "idle", idleSince: 0 } as Agent);
    await store.putAgent({ id: "r3", workspaceId: DEFAULT_WORKSPACE, name: "r3", provider: "gemini", model: "gemini-3-pro", status: "idle", idleSince: 0 } as Agent);
    // A 4th agent, idle, none of the 3 participants — the judge.
    await store.putAgent({ id: "judge", workspaceId: DEFAULT_WORKSPACE, name: "judge", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);

    const project = await ops.createProject(DEFAULT_WORKSPACE, { name: "P", goal: "", repo: undefined, autonomy: true });
    const task = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "bake-off task" });
    const runs = await ops.startBakeoff(DEFAULT_WORKSPACE, project.id, task.id, ["claude", "codex", "gemini"]);
    expect(runs).toHaveLength(3);
    await waitFor(async () => (await openDiffs(store)()).length === 3);

    await ops.requestBakeoffJudgment(DEFAULT_WORKSPACE, task.id);

    // Exactly one comparison consult, offering all 3 candidates.
    expect(provider.judgeCalls).toHaveLength(1);

    const runB = runs.find((r) => r.provider === "codex")!;
    const judged = await store.getTask(task.id);
    expect(judged?.bakeoffVerdict).toMatchObject({ winnerRunId: runB.id, reason: "only one that handles the edge case", by: "judge" });

    // The pick auto-resolved (project.autonomy: true) — collapseBakeoff ran:
    // the other two are retired, the task is repointed at the winner, and its
    // own diff goes on to merge through the ordinary local merge queue.
    const [loserA, loserC] = [runs.find((r) => r.provider === "claude")!, runs.find((r) => r.provider === "gemini")!];
    expect((await store.getRun(loserA.id))?.status).toBe("done");
    expect((await store.getRun(loserC.id))?.status).toBe("done");
    await waitFor(async () => (await store.getRun(runB.id))?.mergedAt != null);
    const finalTask = await store.getTask(task.id);
    expect(finalTask?.bakeoffId).toBeNull();
    expect(finalTask?.state).toBe("done");
  });

  it("records the verdict but does NOT auto-resolve when the project isn't autonomous", async () => {
    const { store, ops } = harness('{"winner":"A","reason":"picks the first one"}');
    await store.putAgent({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
    await store.putAgent({ id: "r2", workspaceId: DEFAULT_WORKSPACE, name: "r2", provider: "codex", model: "gpt-5.2-codex", status: "idle", idleSince: 0 } as Agent);
    await store.putAgent({ id: "judge", workspaceId: DEFAULT_WORKSPACE, name: "judge", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);

    const project = await ops.createProject(DEFAULT_WORKSPACE, { name: "P", goal: "", repo: undefined, autonomy: false });
    const task = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "bake-off task" });
    const runs = await ops.startBakeoff(DEFAULT_WORKSPACE, project.id, task.id, ["claude", "codex"]);
    await waitFor(async () => (await openDiffs(store)()).length === 2);

    await ops.requestBakeoffJudgment(DEFAULT_WORKSPACE, task.id);

    const judged = await store.getTask(task.id);
    expect(judged?.bakeoffVerdict?.winnerRunId).toBe(runs[0]!.id);
    // Neither sibling retired, both diff HITLs still open — a human still
    // has to click "Pick this one", just now informed.
    const openAfter = await openDiffs(store)();
    expect(openAfter).toHaveLength(2);
    expect(judged?.bakeoffId).toBe(runs[0]!.bakeoffId); // still in flight
  });

  it("an unreadable judge reply flags for a human — no winner is guessed, nothing auto-resolves", async () => {
    const { store, provider, ops } = harness("not json at all");
    await store.putAgent({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
    await store.putAgent({ id: "r2", workspaceId: DEFAULT_WORKSPACE, name: "r2", provider: "codex", model: "gpt-5.2-codex", status: "idle", idleSince: 0 } as Agent);
    await store.putAgent({ id: "judge", workspaceId: DEFAULT_WORKSPACE, name: "judge", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);

    const project = await ops.createProject(DEFAULT_WORKSPACE, { name: "P", goal: "", repo: undefined, autonomy: true });
    const task = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "bake-off task" });
    const runs = await ops.startBakeoff(DEFAULT_WORKSPACE, project.id, task.id, ["claude", "codex"]);
    await waitFor(async () => (await openDiffs(store)()).length === 2);

    await ops.requestBakeoffJudgment(DEFAULT_WORKSPACE, task.id);

    expect(provider.judgeCalls).toHaveLength(1);
    const judged = await store.getTask(task.id);
    expect(judged?.bakeoffVerdict?.winnerRunId).toBeNull();
    expect(judged?.bakeoffVerdict?.reason).toMatch(/wasn't a readable verdict/);
    const openAfter = await openDiffs(store)();
    expect(openAfter).toHaveLength(2); // nothing resolved despite autonomy: true
    expect((await store.getRun(runs[0]!.id))?.status).not.toBe("done");
    expect((await store.getRun(runs[1]!.id))?.status).not.toBe("done");
  });

  it("throws NoOpenBakeoffReviewError for a task that was never part of a bake-off", async () => {
    const { ops } = harness();
    const project = await ops.createProject(DEFAULT_WORKSPACE, { name: "P", goal: "", repo: undefined });
    const task = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "task" });
    // No bakeoffId at all — nothing to judge.
    await expect(ops.requestBakeoffJudgment(DEFAULT_WORKSPACE, task.id)).rejects.toThrow(NoOpenBakeoffReviewError);
  });

  it("throws BakeoffAlreadyJudgedError on a second manual request", async () => {
    const { store, ops } = harness('{"winner":"A","reason":"first pass"}');
    await store.putAgent({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
    await store.putAgent({ id: "r2", workspaceId: DEFAULT_WORKSPACE, name: "r2", provider: "codex", model: "gpt-5.2-codex", status: "idle", idleSince: 0 } as Agent);
    await store.putAgent({ id: "judge", workspaceId: DEFAULT_WORKSPACE, name: "judge", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
    const project = await ops.createProject(DEFAULT_WORKSPACE, { name: "P", goal: "", repo: undefined, autonomy: false });
    const task = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "bake-off task" });
    await ops.startBakeoff(DEFAULT_WORKSPACE, project.id, task.id, ["claude", "codex"]);
    await waitFor(async () => (await openDiffs(store)()).length === 2);

    await ops.requestBakeoffJudgment(DEFAULT_WORKSPACE, task.id); // first pass — records a verdict
    await expect(ops.requestBakeoffJudgment(DEFAULT_WORKSPACE, task.id)).rejects.toThrow(BakeoffAlreadyJudgedError);
  });

  it("throws NoReviewerAvailableError when every idle agent is a bake-off participant", async () => {
    const { store, provider, ops } = harness();
    await store.putAgent({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
    await store.putAgent({ id: "r2", workspaceId: DEFAULT_WORKSPACE, name: "r2", provider: "codex", model: "gpt-5.2-codex", status: "idle", idleSince: 0 } as Agent);
    // No 4th agent — only the 2 participants exist.
    const project = await ops.createProject(DEFAULT_WORKSPACE, { name: "P", goal: "", repo: undefined });
    const task = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "bake-off task" });
    await ops.startBakeoff(DEFAULT_WORKSPACE, project.id, task.id, ["claude", "codex"]);
    await waitFor(async () => (await openDiffs(store)()).length === 2);

    await expect(ops.requestBakeoffJudgment(DEFAULT_WORKSPACE, task.id)).rejects.toThrow(NoReviewerAvailableError);
    expect(provider.judgeCalls).toHaveLength(0);
  });
});
