// A resume/reassign of an escalated run whose worktree was cleaned up (reaper,
// restart, disk hygiene) used to spawn the agent into a nonexistent cwd — which
// the SDK misreports as "native binary exists but failed to launch ... libc
// mismatch", an error that sent a real production debugging session chasing
// glibc-vs-musl ghosts. The branch (and thus all committed work) survives such
// cleanup, so the orchestrator now re-attaches a fresh worktree from the branch
// before relaunching, and the Claude runner refuses a missing cwd with the
// truthful reason. These pin all three layers: the provisioner's reattach, the
// orchestrator's relaunch recovery, and the runner's honest guard.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

// Captures each run's RunnerEvents and every StartSpec so a test can drive
// onHitl and assert what cwd the relaunch handed the provider.
class ControllableProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  events = new Map<string, RunnerEvents>();
  specs: StartSpec[] = [];
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    this.specs.push(spec);
    this.events.set(spec.runId, events);
    return new Handle(spec.runId);
  }
}

let Hub: typeof import("../apps/server/src/hub.js").Hub;
let Orchestrator: typeof import("../apps/server/src/orchestrator.js").Orchestrator;
let Operations: typeof import("../apps/server/src/operations.js").Operations;
let MemoryStore: typeof import("../apps/server/src/store/memory.js").MemoryStore;
let WorktreeProvisioner: typeof import("../apps/server/src/worktrees.js").WorktreeProvisioner;

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
  repo = mkdtempSync(join(tmpdir(), "skynet-reattach-repo-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "skynet-reattach-wt-"));
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
  ({ WorktreeProvisioner } = await import("../apps/server/src/worktrees.js"));
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(worktreesDir, { recursive: true, force: true });
});

// ── Provisioner: reattach ────────────────────────────────────────────────────

describe("WorktreeProvisioner.reattach", () => {
  it("re-creates a retired run's worktree from its branch with committed work intact", async () => {
    const wt = new WorktreeProvisioner(repo, "main", worktreesDir);
    const { cwd } = await wt.provision("run-keep", "agent/keep");
    writeFileSync(join(cwd, "work.txt"), "precious\n");
    await wt.commitAll("run-keep", "agent work");
    await wt.retire("run-keep"); // the reaper/hygiene path: directory gone, branch stays
    expect(wt.exists("run-keep")).toBe(false);

    const back = await wt.reattach("run-keep", "agent/keep");
    expect(back.cwd).toBe(wt.pathFor("run-keep"));
    expect(existsSync(join(back.cwd, "work.txt"))).toBe(true); // work preserved, not re-cut from base
  });

  it("throws a plain-language error when the branch is gone too", async () => {
    const wt = new WorktreeProvisioner(repo, "main", worktreesDir);
    await wt.provision("run-lost", "agent/lost");
    await wt.retire("run-lost");
    execFileSync("git", ["-C", repo, "branch", "-D", "agent/lost"]);
    await expect(wt.reattach("run-lost", "agent/lost")).rejects.toThrow(/branch agent\/lost no longer exists/);
  });

  it("never deletes or re-cuts the branch (unlike provision)", async () => {
    const wt = new WorktreeProvisioner(repo, "main", worktreesDir);
    const { cwd } = await wt.provision("run-sha", "agent/sha");
    writeFileSync(join(cwd, "work.txt"), "precious\n");
    const { sha } = await wt.commitAll("run-sha", "agent work");
    await wt.retire("run-sha");
    await wt.reattach("run-sha", "agent/sha");
    expect(await wt.headSha("run-sha")).toBe(sha); // same commit — nothing rewritten
  });
});

// ── Orchestrator: relaunch recovers a pruned worktree ───────────────────────

describe("relaunchEscalated re-attaches a cleaned-up worktree", () => {
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

  const escalate = async (runId: string) => {
    provider.events.get(runId)!.onHitl(runId, {
      kind: "escalation", title: "Stuck", why: "cannot proceed", risk: "medium", rationale: null,
      command: null, options: null, recommended: null, steps: null, diff: null,
    });
    await waitFor(async () => (await store.listQueue(DEFAULT_WORKSPACE)).some((h) => h.kind === "escalation" && !h.resolvedAt));
    return (await store.listQueue(DEFAULT_WORKSPACE)).find((h) => h.kind === "escalation" && !h.resolvedAt)!;
  };

  it("restores the worktree from the surviving branch and relaunches (work preserved)", async () => {
    await store.putAgent({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 });
    await store.putAgent({ id: "r2", workspaceId: DEFAULT_WORKSPACE, name: "r2", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 });
    const project = await ops.createProject(DEFAULT_WORKSPACE, { name: "P", goal: "", repo: undefined });
    const task = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "do the thing" });
    const run = await ops.assignTask(DEFAULT_WORKSPACE, project.id, task.id);
    await waitFor(async () => provider.events.has(run.id));
    const cwd = provider.specs.find((s) => s.runId === run.id)!.cwd!;

    // The agent commits real work, then escalates.
    writeFileSync(join(cwd, "work.txt"), "precious\n");
    execFileSync("git", ["-C", cwd, "add", "-A"]);
    execFileSync("git", ["-C", cwd, "-c", "user.name=T", "-c", "user.email=t@skynet.local", "commit", "-m", "agent work"]);
    const esc = await escalate(run.id);

    // The worktree is cleaned up while the run sits escalated (reaper/restart).
    execFileSync("git", ["-C", repo, "worktree", "remove", "--force", cwd]);
    expect(existsSync(cwd)).toBe(false);

    // Reassign → the orchestrator must re-attach from the branch, not spawn into a ghost dir.
    await ops.resolveHitl(DEFAULT_WORKSPACE, esc.id, { action: "reassign" }, "op-1");
    await waitFor(async () => (await store.getRun(run.id))?.status === "running");

    const relaunch = provider.specs.filter((s) => s.runId === run.id).at(-1)!;
    expect(existsSync(relaunch.cwd!)).toBe(true); // cwd exists again
    expect(existsSync(join(relaunch.cwd!, "work.txt"))).toBe(true); // committed work preserved
    const log = (await store.getRun(run.id))?.log ?? [];
    expect(log.some((l) => l.line.includes("re-attached from branch"))).toBe(true);
  });

  it("raises a truthful escalation (no relaunch) when the branch is gone too", async () => {
    await store.putAgent({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 });
    await store.putAgent({ id: "r2", workspaceId: DEFAULT_WORKSPACE, name: "r2", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 });
    const project = await ops.createProject(DEFAULT_WORKSPACE, { name: "P", goal: "", repo: undefined });
    const task = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "do the thing" });
    const run = await ops.assignTask(DEFAULT_WORKSPACE, project.id, task.id);
    await waitFor(async () => provider.events.has(run.id));
    const cwd = provider.specs.find((s) => s.runId === run.id)!.cwd!;
    const esc = await escalate(run.id);

    // Worktree AND branch both gone — nothing to recover.
    execFileSync("git", ["-C", repo, "worktree", "remove", "--force", cwd]);
    const branch = (await store.getRun(run.id))!.branch;
    execFileSync("git", ["-C", repo, "branch", "-D", branch]);

    const startsBefore = provider.specs.length;
    await ops.resolveHitl(DEFAULT_WORKSPACE, esc.id, { action: "reassign" }, "op-1");
    // A fresh, actionable escalation is raised instead of a doomed relaunch.
    await waitFor(async () => (await store.listQueue(DEFAULT_WORKSPACE)).some((h) => h.kind === "escalation" && !h.resolvedAt && h.id !== esc.id));
    expect(provider.specs.length).toBe(startsBefore); // provider.start never called
    const log = (await store.getRun(run.id))?.log ?? [];
    expect(log.some((l) => l.line.includes("worktree is gone and branch"))).toBe(true);
  });
});

// ── Claude runner: honest guard for a missing cwd ───────────────────────────

describe("Claude runner refuses a nonexistent cwd with the truthful reason", () => {
  it("fails fast, mentioning the cleaned-up worktree — not a libc mismatch", async () => {
    const { ClaudeRunnerProvider, __setClaudeTestHooks } = await import("../packages/runner-sdk/src/claude.js");
    const queryFn = vi.fn();
    __setClaudeTestHooks({ query: queryFn as never });
    const events = {
      onLog: vi.fn(), onProgress: vi.fn(), onHeartbeat: vi.fn(), onStatus: vi.fn(),
      onHitl: vi.fn(), onCompleted: vi.fn(), onFailed: vi.fn(), onChatReply: vi.fn(), onUsage: vi.fn(),
    } satisfies RunnerEvents;
    const provider = new ClaudeRunnerProvider();
    await provider.start(
      { runId: "a1", projectId: "p1", task: "t", model: "sonnet-4.6", branch: "agent/a1", apiKey: "k", cwd: join(tmpdir(), "skynet-no-such-worktree") },
      events,
    );
    expect(events.onFailed).toHaveBeenCalledWith("a1", expect.stringContaining("does not exist"));
    expect(events.onFailed).toHaveBeenCalledWith("a1", expect.stringContaining("worktree was likely cleaned up"));
    expect(queryFn).not.toHaveBeenCalled(); // never tried to spawn into the ghost dir
    __setClaudeTestHooks(null);
  });
});
