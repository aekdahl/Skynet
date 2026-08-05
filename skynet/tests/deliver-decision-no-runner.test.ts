// Recovering a parked decision when the runner is gone (a crash, or a server
// restart that dropped the in-memory session handle). Resolving an approval whose
// run has no live handle must NOT silently drop the decision: the orchestrator
// re-acquires compute and starts a fresh turn in the run's WORKTREE carrying the
// operator's decision — the same recovery shape as escalation/revise.
//
// Faithfully simulates a restart: orch1 runs turn 1 (provisions the worktree,
// commits, raises a diff), then a SECOND orchestrator — fresh, empty live map,
// same store + repo — delivers an approval decision for that run. Asserts a fresh
// turn starts in the worktree with the decision prompt. A run with no worktree
// (nothing to resume into) still falls back to the honest "not delivered" log.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE, HitlItem, Resolution } from "@skynet/shared";
import type { ProviderId, Project, Agent, Task, ServerEvent } from "@skynet/shared";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";
import type { Bus } from "../apps/server/src/bus.js";

// Records every published event (so we can assert the run.log lines) but never
// fans out to subscribers — the orchestrator stays driven only by the events it
// passes into provider.start, exactly like production with a real bus here.
class RecordingBus implements Bus {
  events: Array<{ ws: string; event: ServerEvent }> = [];
  publish(ws: string, event: ServerEvent): void { this.events.push({ ws, event }); }
  subscribe(): () => void { return () => {}; }
  logs(runId: string): string[] {
    return this.events
      .map((e) => e.event)
      .filter((ev): ev is Extract<ServerEvent, { type: "run.log" }> => ev.type === "run.log" && ev.runId === runId)
      .map((ev) => ev.line);
  }
}

// Each turn writes/append to work.txt and completes; captures the prompt it was
// started with so the test can assert the decision was delivered.
class CapturingProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  starts = 0;
  tasks: string[] = [];
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    this.starts++;
    this.tasks.push(spec.task);
    const file = join(spec.cwd!, "work.txt");
    if (!existsSync(file)) writeFileSync(file, "turn1\n");
    else appendFileSync(file, "resumed\n");
    setTimeout(() => events.onCompleted(spec.runId, spec.branch), 0);
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

let Hub: typeof import("../apps/server/src/hub.js").Hub;
let Orchestrator: typeof import("../apps/server/src/orchestrator.js").Orchestrator;
let MemoryStore: typeof import("../apps/server/src/store/memory.js").MemoryStore;
let repo: string, worktreesDir: string;

const git = (...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const waitFor = async (pred: () => Promise<boolean>, ms = 5000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await pred()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error("condition not met in time");
};

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "skynet-deliver-repo-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "skynet-deliver-wt-"));
  execFileSync("git", ["init", "-b", "main", repo]);
  git("config", "user.email", "test@skynet.local");
  git("config", "user.name", "Test");
  writeFileSync(join(repo, "README.md"), "# base\n");
  git("add", "-A");
  git("commit", "-m", "base");
  process.env.STORE = "memory";
  process.env.BUS = "memory";
  process.env.SKYNET_INTEGRATION_REPO = repo;
  process.env.SKYNET_WORKTREES_DIR = worktreesDir;
  process.env.SKYNET_BASE_BRANCH = "main";
  delete process.env.RUNNER;
  ({ Hub } = await import("../apps/server/src/hub.js"));
  ({ Orchestrator } = await import("../apps/server/src/orchestrator.js"));
  ({ MemoryStore } = await import("../apps/server/src/store/memory.js"));
});
afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(worktreesDir, { recursive: true, force: true });
});

const approvalItem = (runId: string, command: string): HitlItem =>
  HitlItem.parse({
    id: `q-${runId}`, workspaceId: DEFAULT_WORKSPACE, runId, kind: "approval",
    title: "run a shell command", why: "touches the filesystem", risk: "medium", raisedAt: Date.now(), command,
  });
const approve = (): Resolution => Resolution.parse({ action: "approve", by: "op", at: Date.now() });

describe("deliver a decision when the runner has exited", () => {
  beforeEach(() => {
    git("checkout", "-f", "main");
    git("branch", "--list", "agent/*").split("\n").filter(Boolean)
      .forEach((b) => { try { git("branch", "-D", b.replace("*", "").trim()); } catch { /* ignore */ } });
  });

  it("re-acquires compute and resumes in the worktree with the decision", async () => {
    const store = new MemoryStore({ seed: false });
    const bus = new RecordingBus();
    const hub = new Hub(store, bus);
    const provider1 = new CapturingProvider();
    const orch1 = new Orchestrator(store, hub, provider1);

    await store.putProject({ id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [], status: "active", repoPath: null, gitBacked: false } as Project);
    await store.putAgent({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
    await store.putTask({ id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "Do the thing", state: "backlog", runId: null } as Task);

    // Turn 1 runs to a diff review → the worktree exists on disk with committed work.
    const run = await orch1.assignTask("p1", "t1");
    await waitFor(async () => (await store.listQueue(DEFAULT_WORKSPACE)).some((q) => q.kind === "diff" && q.resolvedAt == null));
    expect(existsSync(join(worktreesDir, run.id))).toBe(true);

    // Simulate a restart: a brand-new orchestrator with an EMPTY live map, same
    // store + repo. The runner is idle again after the review freed it.
    await store.putAgent({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
    const provider2 = new CapturingProvider();
    const orch2 = new Orchestrator(store, hub, provider2);

    // An operator approves a command the (now-gone) agent had paused on.
    await orch2.deliver(approvalItem(run.id, "npm run deploy"), approve());

    // A fresh turn started in the SAME worktree, carrying the decision.
    await waitFor(async () => provider2.starts === 1);
    expect(provider2.tasks[0]).toContain("approved the action you paused on — npm run deploy");
    expect(provider2.tasks[0]).toContain("read the working directory to reorient");
    await waitFor(async () => readFileSync(join(worktreesDir, run.id, "work.txt"), "utf8").includes("resumed"));
    expect(bus.logs(run.id).some((l) => /re-acquired compute to deliver "approve"/.test(l))).toBe(true);
  });

  it("falls back to the honest 'not delivered' log when there is no worktree", async () => {
    const store = new MemoryStore({ seed: false });
    const bus = new RecordingBus();
    const hub = new Hub(store, bus);
    const provider = new CapturingProvider();
    const orch = new Orchestrator(store, hub, provider);

    await store.putProject({ id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [], status: "active", repoPath: null, gitBacked: false } as Project);
    // A run that exists in the store but whose worktree was never provisioned.
    await store.putRun({ id: "r-ghost", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", agentId: "x", provider: "claude", model: "opus-4.8", branch: "agent/ghost", status: "review", startedAt: 0, log: [] } as any);

    await orch.deliver(approvalItem("r-ghost", "rm -rf /"), approve());

    expect(provider.starts).toBe(0); // no fake resume
    expect(bus.logs("r-ghost").some((l) => /no live runner is attached — not delivered/.test(l))).toBe(true);
  });
});
