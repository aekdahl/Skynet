// Feedback-loop responders (ROADMAP v3) — Orchestrator.reengageOnFeedback,
// the entry point the rule engine's `reengage_run` action calls into. Drives
// a REAL orchestrator (real git repo + worktree, same harness as
// escalation-reassign-interrupted-git.test.ts) through assign → (simulated)
// review → reengage, and asserts a second agent process starts in the SAME
// worktree/branch with the feedback note baked into its prompt — plus the
// eligibility gate that keeps a still-running run from being interrupted.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { HitlItem, ProviderId, ServerEvent } from "@skynet/shared";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

class RecordingBus implements Bus {
  events: ServerEvent[] = [];
  publish(_ws: string, event: ServerEvent): void {
    this.events.push(event);
  }
  subscribe(): () => void { return () => {}; }
}

class Handle implements RunnerHandle {
  readonly provider: ProviderId = "claude";
  stopCalls = 0;
  constructor(readonly runId: string) {}
  async pause(): Promise<void> {}
  async message(): Promise<void> {}
  async resume(): Promise<void> {}
  async stop(): Promise<void> {
    this.stopCalls++;
  }
}

class ControllableProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  events = new Map<string, RunnerEvents>();
  handles = new Map<string, Handle>();
  starts: StartSpec[] = [];
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    this.starts.push(spec);
    this.events.set(spec.runId, events);
    const h = new Handle(spec.runId);
    this.handles.set(spec.runId, h);
    return h;
  }
}

let Hub: typeof import("../apps/server/src/hub.js").Hub;
let Orchestrator: typeof import("../apps/server/src/orchestrator.js").Orchestrator;
let Operations: typeof import("../apps/server/src/operations.js").Operations;
let MemoryStore: typeof import("../apps/server/src/store/memory.js").MemoryStore;
let repo: string, worktreesDir: string;

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "skynet-reengage-repo-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "skynet-reengage-wt-"));
  execFileSync("git", ["init", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@skynet.local"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  writeFileSync(join(repo, "shared.txt"), "base\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-m", "base"]);
  process.env.STORE = "memory";
  process.env.BUS = "memory";
  process.env.SKYNET_INTEGRATION_REPO = repo;
  process.env.SKYNET_WORKTREES_DIR = worktreesDir;
  process.env.SKYNET_BASE_BRANCH = "main";
  delete process.env.RUNNER;
  ({ Hub } = await import("../apps/server/src/hub.js"));
  ({ Orchestrator } = await import("../apps/server/src/orchestrator.js"));
  ({ Operations } = await import("../apps/server/src/operations.js"));
  ({ MemoryStore } = await import("../apps/server/src/store/memory.js"));
});
afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(worktreesDir, { recursive: true, force: true });
});

async function setup() {
  const store = new MemoryStore({ seed: false });
  const bus = new RecordingBus();
  const hub = new Hub(store, bus);
  const provider = new ControllableProvider();
  const orchestrator = new Orchestrator(store, hub, provider);
  const ops = new Operations({ store, hub, orchestrator });
  await store.putAgent({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 });
  await store.putAgent({ id: "r2", workspaceId: DEFAULT_WORKSPACE, name: "r2", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 });
  const project = await ops.createProject(DEFAULT_WORKSPACE, { name: "P", goal: "" }); // no repoPath → falls back to SKYNET_INTEGRATION_REPO
  const task = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "do the thing" });
  const run = await ops.assignTask(DEFAULT_WORKSPACE, project.id, task.id);
  return { store, orchestrator, provider, run };
}

describe("Orchestrator.reengageOnFeedback — feedback-loop responders", () => {
  it("re-engages a run sitting in review: same worktree/branch, note in the prompt, session resume via parentId", async () => {
    const { store, orchestrator, provider, run } = await setup();

    // Simulate the run finishing and reaching review — compute freed, no live
    // handle — exactly the state a check_failed/review_changes_requested
    // webhook targets in practice.
    await store.putAgent({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 });
    const midRun = await store.getRun(run.id);
    await store.putRun({ ...midRun!, status: "review" });

    const result = await orchestrator.reengageOnFeedback(run.id, 'CI check "build" failed (PR #42)');
    expect(result).toEqual({ engaged: true });
    expect(provider.starts).toHaveLength(2);

    const relaunch = provider.starts[1]!;
    expect(relaunch.runId).toBe(run.id);
    expect(relaunch.branch).toBe(run.branch);
    expect(relaunch.parentId).toBe(run.id);
    expect(relaunch.task).toContain('CI check "build" failed');
    expect(relaunch.task).toContain(run.branch);

    const finalRun = await store.getRun(run.id);
    expect(finalRun?.status).toBe("running");
    expect(finalRun?.log.some((l) => l.line.includes("re-engaged after PR feedback"))).toBe(true);
  });

  it("skips a run that's still actively running — never interrupts live work", async () => {
    const { orchestrator, provider, run } = await setup(); // run.status is "running" right after assignTask

    const result = await orchestrator.reengageOnFeedback(run.id, "a stale CI ping");
    expect(result.engaged).toBe(false);
    expect(result.reason).toContain("running");
    expect(provider.starts).toHaveLength(1); // no second start
  });

  it("skips an already-merged run", async () => {
    const { store, orchestrator, provider, run } = await setup();
    const midRun = await store.getRun(run.id);
    await store.putRun({ ...midRun!, status: "done", mergedAt: Date.now() });

    const result = await orchestrator.reengageOnFeedback(run.id, "a late webhook for a merged PR");
    expect(result).toEqual({ engaged: false, reason: "already merged" });
    expect(provider.starts).toHaveLength(1);
  });
});
