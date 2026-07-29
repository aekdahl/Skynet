// Phase 3 in the REAL orchestrator: a project that opted into auto-merge has a
// SMALL finished diff integrated without a human — through the same diff-review →
// merge path a human approve uses — while a LARGE diff (or an opted-out project)
// still stops for review. Hermetic: a throwaway git repo + a scripted provider
// that writes N files onto its branch and completes. No LLM, no credentials.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { ProviderId, Project, Agent, Task, HitlItem } from "@skynet/shared";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";
import type { Bus } from "../apps/server/src/bus.js";

class NullBus implements Bus {
  publish(): void {}
  subscribe(): () => void {
    return () => {};
  }
}

// Writes `files` small files into its worktree, then completes — the orchestrator
// commits the diff, raises the review, and (Phase 3) may auto-merge it.
class DiffProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  constructor(private readonly files: number) {}
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    for (let i = 0; i < this.files; i++) writeFileSync(join(spec.cwd!, `f${i}.txt`), `hello ${i}\n`);
    setTimeout(() => events.onCompleted(spec.runId, spec.branch), 0);
    return {
      runId: spec.runId,
      provider: this.id,
      async pause() {},
      async resume() {},
      async message() {},
      async stop() {},
    };
  }
}

let Hub: typeof import("../apps/server/src/hub.js").Hub;
let Orchestrator: typeof import("../apps/server/src/orchestrator.js").Orchestrator;
let MemoryStore: typeof import("../apps/server/src/store/memory.js").MemoryStore;
let repo: string, worktreesDir: string;

const waitFor = async (pred: () => Promise<boolean>, ms = 15_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("condition not met in time");
};

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "skynet-am-repo-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "skynet-am-wt-"));
  execFileSync("git", ["init", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@skynet.local"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  writeFileSync(join(repo, "README.md"), "# base\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-m", "base"]);
  process.env.STORE = "memory";
  process.env.BUS = "memory";
  process.env.SKYNET_INTEGRATION_REPO = repo;
  process.env.SKYNET_WORKTREES_DIR = worktreesDir;
  process.env.SKYNET_BASE_BRANCH = "main";
  process.env.SKYNET_AUTO_MERGE_MAX_FILES = "5";
  process.env.SKYNET_AUTO_MERGE_MAX_LINES = "40";
  delete process.env.RUNNER;
  ({ Hub } = await import("../apps/server/src/hub.js"));
  ({ Orchestrator } = await import("../apps/server/src/orchestrator.js"));
  ({ MemoryStore } = await import("../apps/server/src/store/memory.js"));
});
afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(worktreesDir, { recursive: true, force: true });
});

async function start(autoMerge: boolean, files: number) {
  const store = new MemoryStore({ seed: false });
  const hub = new Hub(store, new NullBus());
  const orchestrator = new Orchestrator(store, hub, new DiffProvider(files));
  const pid = `p-${files}-${autoMerge}`;
  await store.putProject({
    id: pid, workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [], status: "active",
    approvalLevel: "trusted", approvalRules: [], autoMergeSmallDiffs: autoMerge, repoPath: null, gitBacked: false,
  } as Project);
  await store.putAgent({ id: `a-${pid}`, workspaceId: DEFAULT_WORKSPACE, name: "a", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
  await store.putTask({ id: `t-${pid}`, workspaceId: DEFAULT_WORKSPACE, projectId: pid, text: "do it", state: "backlog", runId: null } as Task);
  const r = await orchestrator.assignTask(pid, `t-${pid}`);
  const openDiff = async (): Promise<HitlItem | undefined> =>
    (await store.listQueue(DEFAULT_WORKSPACE)).find((q) => q.runId === r.id && q.kind === "diff" && q.resolvedAt == null);
  return { store, run: r, openDiff };
}

describe("Phase 3 — auto-merge small diffs (local path)", () => {
  it("opted-in + small diff → auto-merged to done, no human, recorded as policy:diff", async () => {
    const t = await start(true, 1); // 1 small file
    await waitFor(async () => (await t.store.getRun(t.run.id))?.status === "done");
    expect(await t.openDiff()).toBeUndefined(); // never waited on a human
    const audit = await t.store.listAudit(DEFAULT_WORKSPACE);
    expect(audit.some((a) => a.action === "approve" && a.operatorId === "policy:diff")).toBe(true);
  });

  it("opted-in but LARGE diff (too many files) → still stops for review", async () => {
    const t = await start(true, 6); // 6 files > maxFiles(5)
    await waitFor(async () => (await t.openDiff()) != null);
    expect((await t.store.getRun(t.run.id))?.status).toBe("review");
  });

  it("opted-OUT + small diff → still stops for review", async () => {
    const t = await start(false, 1);
    await waitFor(async () => (await t.openDiff()) != null);
    expect((await t.store.getRun(t.run.id))?.status).toBe("review");
  });
});
