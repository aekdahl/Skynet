// Manual "Switch agent" (Operations.reassignTaskAgent / Orchestrator.
// reassignRunToAgent): move a STILL-LIVE task's run to a specific,
// operator-chosen idle agent — never via an escalation, unlike the existing
// "Reassign" flow (escalation.test.ts / escalation-reassign-interrupted-
// git.test.ts). Drives the real orchestrator against a real throwaway git
// repo (same harness as those two files) so the worktree/branch/committed-
// and-uncommitted work is verifiably the SAME across the switch, not just
// asserted by code reading.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { ProviderId, ServerEvent } from "@skynet/shared";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

class NullBus implements Bus {
  publish(_ws: string, _e: ServerEvent): void {}
  subscribe(): () => void { return () => {}; }
}

class Handle implements RunnerHandle {
  readonly provider: ProviderId = "claude";
  stopCalls = 0;
  constructor(readonly runId: string) {}
  async pause(): Promise<void> {}
  async message(): Promise<void> {}
  async resume(): Promise<void> {}
  async stop(): Promise<void> { this.stopCalls++; }
}

class ControllableProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  handles = new Map<string, Handle>();
  starts: StartSpec[] = [];
  async start(spec: StartSpec, _events: RunnerEvents): Promise<RunnerHandle> {
    this.starts.push(spec);
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
  repo = mkdtempSync(join(tmpdir(), "skynet-switch-agent-repo-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "skynet-switch-agent-wt-"));
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
  ({ Operations } = await import("../apps/server/src/operations.js"));
  ({ MemoryStore } = await import("../apps/server/src/store/memory.js"));
});
afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(worktreesDir, { recursive: true, force: true });
});

const setup = async (projectId: string) => {
  const store = new MemoryStore({ seed: false });
  const hub = new Hub(store, new NullBus());
  const provider = new ControllableProvider();
  const orchestrator = new Orchestrator(store, hub, provider);
  const ops = new Operations({ store, hub, orchestrator });
  await store.putAgent({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 });
  await store.putAgent({ id: "r2", workspaceId: DEFAULT_WORKSPACE, name: "r2", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 });
  const project = await ops.createProject(DEFAULT_WORKSPACE, { name: projectId, goal: "ship it" }); // no repoPath → falls back to SKYNET_INTEGRATION_REPO
  const task = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "do the thing" });
  const run = await ops.assignTask(DEFAULT_WORKSPACE, project.id, task.id); // r1 picks it up, genuinely live — never escalated
  return { store, ops, provider, project, task, run };
};

describe("reassignTaskAgent — switch a still-live run to a specific agent", () => {
  it("stops r1, keeps the same worktree/branch/uncommitted work, and resumes on r2", async () => {
    const { store, ops, provider, task, run } = await setup("p-switch");
    const oldHandle = provider.handles.get(run.id)!;
    const cwd = provider.starts[0]!.cwd!;

    // Real, uncommitted work r1 left behind — the whole point of "switch",
    // not "restart clean".
    writeFileSync(join(cwd, "wip.txt"), "uncommitted work from r1\n");

    await ops.reassignTaskAgent(DEFAULT_WORKSPACE, task.id, "r2");

    expect(oldHandle.stopCalls).toBeGreaterThanOrEqual(1); // r1's session was actually stopped
    expect((await store.getAgent("r1"))?.status).toBe("idle"); // freed
    expect((await store.getAgent("r2"))?.status).toBe("busy"); // claimed

    expect(provider.starts.length).toBe(2); // r2's own start() call
    const secondStart = provider.starts[1]!;
    expect(secondStart.cwd).toBe(cwd); // the SAME worktree, not a fresh one
    expect(readFileSync(join(cwd, "wip.txt"), "utf8")).toBe("uncommitted work from r1\n"); // never wiped
    expect(secondStart.task).toContain("An operator manually reassigned this task to you mid-run");
    expect(secondStart.task).not.toContain("escalated"); // never framed as a stuck-agent handoff

    const finalRun = await store.getRun(run.id);
    expect(finalRun?.agentId).toBe("r2");
    expect(finalRun?.status).toBe("running");
    expect((await store.getTask(task.id))?.state).toBe("ongoing");
  });

  it("throws and leaves the run untouched when the target agent is busy", async () => {
    const { store, ops, provider, task, run } = await setup("p-busy");
    await store.putAgent({ id: "r2", workspaceId: DEFAULT_WORKSPACE, name: "r2", provider: "claude", model: "opus-4.8", status: "busy", idleSince: null });
    const oldHandle = provider.handles.get(run.id)!;

    await expect(ops.reassignTaskAgent(DEFAULT_WORKSPACE, task.id, "r2")).rejects.toThrow(/busy/i);

    expect(oldHandle.stopCalls).toBe(0); // r1's live session was never touched
    expect((await store.getAgent("r1"))?.status).toBe("busy"); // still working it
    expect(provider.starts.length).toBe(1); // no second start() call
    expect((await store.getRun(run.id))?.agentId).toBe("r1");
  });

  it("throws when targeting the SAME agent already running the task — it's busy with this very run, never idle", async () => {
    const { store, ops, provider, task, run } = await setup("p-same-agent");
    const oldHandle = provider.handles.get(run.id)!;

    // r1 is the agent already assigned/live on this run — acquireSpecificAgent
    // requires the target to be idle, and r1 is "busy" precisely because it's
    // running this task, so reassigning to itself is always rejected, not a
    // silent no-op.
    await expect(ops.reassignTaskAgent(DEFAULT_WORKSPACE, task.id, "r1")).rejects.toThrow(/busy/i);

    expect(oldHandle.stopCalls).toBe(0); // never touched
    expect((await store.getAgent("r1"))?.status).toBe("busy"); // unchanged
    expect(provider.starts.length).toBe(1); // no second start() call
    expect((await store.getRun(run.id))?.agentId).toBe("r1");
    expect((await store.getTask(task.id))?.state).toBe("ongoing"); // untouched
  });

  it("throws and leaves the run untouched when the target agent doesn't exist", async () => {
    const { store, ops, provider, task, run } = await setup("p-ghost");
    const oldHandle = provider.handles.get(run.id)!;

    await expect(ops.reassignTaskAgent(DEFAULT_WORKSPACE, task.id, "no-such-agent")).rejects.toThrow();

    expect(oldHandle.stopCalls).toBe(0);
    expect((await store.getAgent("r1"))?.status).toBe("busy");
    expect(provider.starts.length).toBe(1);
    expect((await store.getRun(run.id))?.agentId).toBe("r1");
  });

  it("refuses a task that isn't ongoing, before ever touching the orchestrator", async () => {
    const { store, ops, provider, task } = await setup("p-not-ongoing");
    const current = (await store.getTask(task.id))!;
    await store.putTask({ ...current, state: "done", runId: null });

    await expect(ops.reassignTaskAgent(DEFAULT_WORKSPACE, task.id, "r2")).rejects.toThrow(/ongoing/i);

    expect(provider.starts.length).toBe(1); // only the original assign — no reassign attempt reached the orchestrator
  });
});
