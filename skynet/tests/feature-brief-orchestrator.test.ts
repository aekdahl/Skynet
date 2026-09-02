// Feature-level brief, wired end to end: once every task under a Feature is
// done, checkFeatureCompletion opens the batch's aggregate PR (a GitHub-bound
// project) and draftFeatureBrief composes the ready-to-merge card's brief —
// system-known facts (per-task verdicts, summed spend, evidence) always
// present, the consult-drafted narrative best-effort on top. Real git for the
// two tasks' step-1 merges into the shared feature branch (same harness as
// merge.test.ts / guided-merge-orchestrator.test.ts); githubService stubbed
// (no network) for step-2's PR open, same pattern as ready-merge.test.ts.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { ProviderId, Project, Agent, Task, Feature, HitlItem, Resolution } from "@skynet/shared";
import type { ConsultSpec, RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";
import type { Bus } from "../apps/server/src/bus.js";
import { FEATURE_BRIEF_SYSTEM } from "../apps/server/src/feature-brief.js";

vi.mock("../apps/server/src/github/index.js", () => ({
  githubService: {
    get: vi.fn(async () => ({ workspaceId: DEFAULT_WORKSPACE, connected: true, auth: "pat", installation: null, tokenLast4: "abcd", repos: [], safety: {} })),
    pushAndOpenPr: vi.fn(async () => ({ ok: true, pushed: true, pr: { number: 7, url: "https://github.com/acme/app/pull/7" } })),
  },
}));
import { githubService } from "../apps/server/src/github/index.js";

class NullBus implements Bus { publish(): void {} subscribe(): () => void { return () => {}; } }

const NARRATIVE_JSON = '{"narrative":"Ships a batched rate-limiting feature across the API layer."}';
const EMPTY_WALKTHROUGH_JSON = '{"summary":"n/a","comments":[]}';
const EMPTY_MERGE_BRIEF_JSON = '{"summary":"n/a","risks":[],"mitigations":[]}';

class TwoTaskProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  consultCalls: ConsultSpec[] = [];
  constructor(private readonly narrativeReply: string | null = NARRATIVE_JSON) {}
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    writeFileSync(join(spec.cwd!, `${spec.runId}.txt`), `work for ${spec.runId}\n`);
    setTimeout(() => events.onCompleted(spec.runId, spec.branch), 0);
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
  consult = async (spec: ConsultSpec): Promise<string> => {
    this.consultCalls.push(spec);
    if (spec.system === FEATURE_BRIEF_SYSTEM) {
      if (this.narrativeReply == null) throw new Error("consult unsupported for this test");
      return this.narrativeReply;
    }
    if (spec.system?.includes("MERGE")) return EMPTY_MERGE_BRIEF_JSON;
    return EMPTY_WALKTHROUGH_JSON;
  };
}

let Hub: typeof import("../apps/server/src/hub.js").Hub;
let Orchestrator: typeof import("../apps/server/src/orchestrator.js").Orchestrator;
let MemoryStore: typeof import("../apps/server/src/store/memory.js").MemoryStore;
let repo: string, worktreesDir: string;

const waitFor = async (pred: () => Promise<boolean> | boolean, ms = 8000) => {
  const dl = Date.now() + ms;
  while (Date.now() < dl) { if (await pred()) return; await new Promise((r) => setTimeout(r, 15)); }
  throw new Error("timeout");
};

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "skynet-fb-repo-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "skynet-fb-wt-"));
  execFileSync("git", ["init", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@t.local"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "T"]);
  writeFileSync(join(repo, "README.md"), "# base\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-m", "base"]);
  process.env.STORE = "memory"; process.env.BUS = "memory";
  process.env.SKYNET_INTEGRATION_REPO = repo; process.env.SKYNET_WORKTREES_DIR = worktreesDir;
  process.env.SKYNET_BASE_BRANCH = "main"; delete process.env.RUNNER;
  ({ Hub } = await import("../apps/server/src/hub.js"));
  ({ Orchestrator } = await import("../apps/server/src/orchestrator.js"));
  ({ MemoryStore } = await import("../apps/server/src/store/memory.js"));
});
afterAll(() => { rmSync(repo, { recursive: true, force: true }); rmSync(worktreesDir, { recursive: true, force: true }); });

/** Assign a task, approve its diff, and wait for its step-1 merge into the
 *  feature branch to finish (task reaches `done`). */
async function runTaskToDone(
  store: InstanceType<typeof MemoryStore>,
  orch: InstanceType<typeof Orchestrator>,
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
  const resolution: Resolution = { action: "approve", optionIndex: null, guidance: null, targetBranch: null, memoryNote: null, by: "op-1", at: Date.now() };
  await orch.deliver(item, resolution);
  await waitFor(async () => (await store.getTask(taskId))?.state === "done");
}

const setup = async (provider: RunnerProvider) => {
  const store = new MemoryStore({ seed: false });
  const hub = new Hub(store, new NullBus());
  const orch = new Orchestrator(store, hub, provider);
  const project: Project = {
    id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [],
    status: "active", repoPath: null, gitBacked: false, repo: "acme/app",
  } as Project;
  await store.putProject(project);
  await store.putAgent({ id: "a1", workspaceId: DEFAULT_WORKSPACE, name: "a1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
  const feature: Feature = {
    id: "f1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", name: "Rate limiting",
    description: null, status: "active", milestoneId: null, archived: false, createdAt: Date.now(), pr: null,
  };
  await store.putFeature(feature);
  await store.putTask({ id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "add limiter middleware", state: "backlog", runId: null, featureId: "f1" } as Task);
  await store.putTask({ id: "t2", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "add limiter tests", state: "backlog", runId: null, featureId: "f1" } as Task);
  return { store, hub, orch };
};

describe("feature-level brief — wired into checkFeatureCompletion / openPrForFeature", () => {
  it("drafts a narrative + composes per-task verdicts and summed spend once the whole batch completes", async () => {
    (githubService.pushAndOpenPr as ReturnType<typeof vi.fn>).mockClear();
    const provider = new TwoTaskProvider();
    const { store, orch } = await setup(provider);

    await runTaskToDone(store, orch, "t1", "p1");
    // Record a reviewer verdict + spend on t1's run before t2 finishes — the
    // brief composed on t2's completion should already reflect it.
    const t1 = (await store.getTask("t1"))!;
    await store.putTask({ ...t1, reviewVerdict: { decision: "approve", reason: "clean", by: "a2", at: Date.now() } });
    if (t1.runId) {
      const r1 = (await store.getRun(t1.runId))!;
      await store.putRun({ ...r1, usage: { inputTokens: 500, outputTokens: 100, costUsd: 0.02, turns: 2, durationMs: 3000 } });
    }

    await runTaskToDone(store, orch, "t2", "p1");
    const t2 = (await store.getTask("t2"))!;
    if (t2.runId) {
      const r2 = (await store.getRun(t2.runId))!;
      await store.putRun({ ...r2, usage: { inputTokens: 300, outputTokens: 80, costUsd: 0.01, turns: 1, durationMs: 1500 } });
    }

    // checkFeatureCompletion fires off the back of t2's own completeMerged —
    // give it a beat to run and call the (mocked) GitHub push.
    await waitFor(async () => (await store.getFeature("f1"))?.pr?.state === "open");
    const feature = (await store.getFeature("f1"))!;

    expect(githubService.pushAndOpenPr).toHaveBeenCalledTimes(1);
    const brief = feature.pr!.briefing!.featureBrief;
    expect(brief).not.toBeNull();
    expect(brief!.tasks.map((t) => t.taskId).sort()).toEqual(["t1", "t2"]);
    const t1Line = brief!.tasks.find((t) => t.taskId === "t1");
    expect(t1Line?.verdict).toBe("approve");
    expect(t1Line?.reviewedBy).toBe("a2");
    // Usage recorded on ONLY t1's run — spend still sums (t2's null usage excluded, not zeroed).
    expect(brief!.spend).toEqual({ cacheReadTokens: 0,
      cacheWriteTokens: 0,
      inputTokens: 800, outputTokens: 180, costUsd: 0.03, turns: 3, durationMs: 4500 });
    expect(brief!.evidenceSummary).toContain("All 1 reviewed task(s) approved by their reviewing agent.");
    expect(brief!.narrative).toBe("Ships a batched rate-limiting feature across the API layer.");
    // Grounded on the real combined diff, not a description of it.
    const briefCall = provider.consultCalls.find((c) => c.system === FEATURE_BRIEF_SYSTEM);
    expect(briefCall?.context).toContain("work for");
  });

  it("consult failure still opens the PR with a partial brief (system-composed facts, no narrative)", async () => {
    (githubService.pushAndOpenPr as ReturnType<typeof vi.fn>).mockClear();
    const provider = new TwoTaskProvider(null); // consult throws for the feature-brief call
    const { store, orch } = await setup(provider);

    await runTaskToDone(store, orch, "t1", "p1");
    await runTaskToDone(store, orch, "t2", "p1");

    await waitFor(async () => (await store.getFeature("f1"))?.pr?.state === "open");
    const feature = (await store.getFeature("f1"))!;

    expect(githubService.pushAndOpenPr).toHaveBeenCalledTimes(1); // never blocked
    const brief = feature.pr!.briefing!.featureBrief;
    expect(brief).not.toBeNull();
    expect(brief!.narrative).toBeNull();
    expect(brief!.tasks).toHaveLength(2); // system-composed half still present
  });
});
