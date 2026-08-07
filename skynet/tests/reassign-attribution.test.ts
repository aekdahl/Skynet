// When an escalated run is REASSIGNED, it moves to a different runner. The board
// and subway attribute runs by `agentId`, so the persisted run must be updated to
// the new agent — otherwise it stays drawn under the agent it was escalated from
// (now idle), looking like a stray/duplicate station. This drives the REAL
// orchestrator against a throwaway git repo (so the run has a worktree to be
// relaunched in) with a controllable provider, escalates, reassigns, and asserts
// the run's agentId moved to the replacement runner.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { ProviderId, Resolution, ServerEvent } from "@skynet/shared";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";
import type { Bus } from "../apps/server/src/bus.js";

class NullBus implements Bus {
  publish(_ws: string, _e: ServerEvent): void {}
  subscribe(): () => void {
    return () => {};
  }
}

class Handle implements RunnerHandle {
  readonly provider: ProviderId = "claude";
  constructor(readonly runId: string) {}
  async pause(): Promise<void> {}
  async message(): Promise<void> {}
  async resume(_d?: Resolution): Promise<void> {}
  async stop(): Promise<void> {}
}

// Captures each run's RunnerEvents so a test can drive onHitl; never self-completes.
class ControllableProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  events = new Map<string, RunnerEvents>();
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    this.events.set(spec.runId, events);
    return new Handle(spec.runId);
  }
}

let Hub: typeof import("../apps/server/src/hub.js").Hub;
let Orchestrator: typeof import("../apps/server/src/orchestrator.js").Orchestrator;
let Operations: typeof import("../apps/server/src/operations.js").Operations;
let MemoryStore: typeof import("../apps/server/src/store/memory.js").MemoryStore;

let repo: string;
let worktreesDir: string;

const waitFor = async (pred: () => Promise<boolean>, ms = 5000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not met in time");
};

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "skynet-reassign-repo-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "skynet-reassign-wt-"));
  execFileSync("git", ["init", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@skynet.local"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "T"]);
  writeFileSync(join(repo, "README.md"), "seed\n");
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

describe("reassign re-attributes the run to the new agent", () => {
  let store: InstanceType<typeof MemoryStore>;
  let provider: ControllableProvider;
  let ops: InstanceType<typeof Operations>;

  beforeEach(() => {
    store = new MemoryStore({ seed: false });
    provider = new ControllableProvider();
    const hub = new Hub(store, new NullBus());
    const orchestrator = new Orchestrator(store, hub, provider);
    ops = new Operations({ store, hub, orchestrator });
  });

  it("moves run.agentId from the escalated-from runner to the replacement", async () => {
    // Two idle runners: r1 takes the task, r2 is the reassign target.
    await store.putAgent({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 });
    await store.putAgent({ id: "r2", workspaceId: DEFAULT_WORKSPACE, name: "r2", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 });
    const project = await ops.createProject(DEFAULT_WORKSPACE, { name: "P", goal: "", repo: undefined });
    const task = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "do the thing" });
    const run = await ops.assignTask(DEFAULT_WORKSPACE, project.id, task.id);
    expect(run.agentId).toBe("r1");
    await waitFor(async () => provider.events.has(run.id)); // worktree provisioned + started

    // The agent escalates for help.
    provider.events.get(run.id)!.onHitl(run.id, {
      kind: "escalation", title: "Stuck", why: "cannot proceed", risk: "medium", rationale: null,
      command: null, options: null, recommended: null, steps: null, diff: null,
    });
    await waitFor(async () => (await store.listQueue(DEFAULT_WORKSPACE)).some((h) => h.kind === "escalation" && !h.resolvedAt));
    const esc = (await store.listQueue(DEFAULT_WORKSPACE)).find((h) => h.kind === "escalation" && !h.resolvedAt)!;

    // Reassign → relaunch on a DIFFERENT runner; the persisted run must follow.
    await ops.resolveHitl(DEFAULT_WORKSPACE, esc.id, { action: "reassign" }, "op-1");
    await waitFor(async () => (await store.getRun(run.id))?.agentId === "r2");

    const after = await store.getRun(run.id);
    expect(after?.agentId).toBe("r2"); // re-attributed — no longer drawn under r1
    expect(after?.status).toBe("running");
    expect((await store.getAgent("r1"))?.status).toBe("idle"); // escalated-from runner freed
  });
});
