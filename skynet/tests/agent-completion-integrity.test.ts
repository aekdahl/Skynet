// Regression guard: a successful agent's edits are committed + routed to review,
// never silently dropped as "done".
//
// The bug (reproduced in the acceptance eval): a real runner's finish() emitted
// onStatus("done") BEFORE handing off to the orchestrator's commit → review →
// merge integration. An observer polling that window saw the agent "done" while
// its worktree edits were still uncommitted — the diff came back empty and the
// work looked lost. "done" is the ORCHESTRATOR's decision, taken only after the
// diff is committed (→ review → merge) or confirmed genuinely empty.
//
// This drives the REAL orchestrator against a throwaway git repo with a fake
// provider that reproduces the exact defect — it edits the worktree, then reports
// onStatus("done") + onCompleted like the old runners. The orchestrator must
// ignore the premature "done", commit the edit, and land the agent in "review"
// with a non-empty diff. It fails on the pre-fix orchestrator and passes after.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { ProviderId, Project, Agent, ServerEvent, Task } from "@skynet/shared";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";
import type { Bus } from "../apps/server/src/bus.js";

// Records every published event in order, so we can assert the *sequence* of
// status transitions (the race is about ordering, not just the final state).
class RecordingBus implements Bus {
  events: ServerEvent[] = [];
  publish(_ws: string, event: ServerEvent): void {
    this.events.push(event);
  }
  subscribe(): () => void {
    return () => {};
  }
}

// A runner that mimics the OLD, buggy finish() contract: it makes a real edit in
// its worktree, then (next tick, after start() returns so the orchestrator has
// registered the live handle) reports onStatus("done") *before* onCompleted.
// `edit` lets a case opt out of writing (to exercise the genuine no-change path).
class PrematureDoneProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  constructor(private edit: (cwd: string) => void) {}
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    if (spec.cwd) this.edit(spec.cwd);
    setTimeout(() => {
      events.onProgress(spec.runId, 1, []);
      events.onStatus(spec.runId, "done"); // premature — the defect under test
      events.onCompleted(spec.runId, spec.branch);
    }, 0);
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

// A runner that fails outright (binary missing, auth error, crash) — it reports
// onFailed instead of doing work. The orchestrator escalates it (Resume/Reassign/
// Stop) rather than silently parking in "review" with nothing to act on; the
// task stays "ongoing" — the same lane every other escalation uses, its card
// locked but showing a visible "⏸ <title>" wait-tag from the open HITL.
class FailingProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    setTimeout(() => events.onFailed(spec.runId, "boom — runner crashed"), 0);
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

// Loaded via dynamic import in beforeAll, AFTER env is set — config captures the
// integration repo / worktrees dir at import time (see evals/executor.ts).
let Hub: typeof import("../apps/server/src/hub.js").Hub;
let Orchestrator: typeof import("../apps/server/src/orchestrator.js").Orchestrator;
let MemoryStore: typeof import("../apps/server/src/store/memory.js").MemoryStore;

let repo: string;
let worktreesDir: string;

const git = (...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

const waitFor = async (pred: () => Promise<boolean>, ms = 5000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not met in time");
};

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "skynet-completion-repo-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "skynet-completion-wt-"));
  execFileSync("git", ["init", "-b", "main", repo]);
  git("config", "user.email", "test@skynet.local");
  git("config", "user.name", "Test");
  writeFileSync(join(repo, "sum.ts"), "export const sum = (a: number, b: number) => a - b;\n");
  git("add", "-A");
  git("commit", "-m", "base");

  // Must be set before importing config (import-time capture).
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

type Store = InstanceType<typeof MemoryStore>;
let store: Store;
let bus: RecordingBus;

async function seed(): Promise<{ hub: import("../apps/server/src/hub.js").Hub }> {
  store = new MemoryStore({ seed: false });
  bus = new RecordingBus();
  const hub = new Hub(store, bus);
  const project: Project = {
    id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [], status: "active",
    repoPath: null, gitBacked: false,
  };
  const runner: Agent = {
    id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1",
    provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0,
  };
  const task: Task = {
    id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "fix sum", state: "backlog", runId: null,
  };
  await store.putProject(project);
  await store.putAgent(runner);
  await store.putTask(task);
  return { hub };
}

// Index of the first published event matching a predicate (-1 if none).
const idxOf = (events: ServerEvent[], pred: (e: ServerEvent) => boolean) => events.findIndex(pred);

describe("agent completion integrity: successful work is never silently dropped", () => {
  beforeEach(() => {
    git("checkout", "-f", "main");
    git("branch", "--list", "agent/*").split("\n").filter(Boolean)
      .forEach((b) => { try { git("branch", "-D", b.replace("*", "").trim()); } catch { /* ignore */ } });
  });

  it("an agent that edits its worktree lands in 'review' with a committed diff — no premature 'done'", async () => {
    const provider = new PrematureDoneProvider((cwd) => {
      writeFileSync(join(cwd, "sum.ts"), "export const sum = (a: number, b: number) => a + b;\n");
    });
    const { hub } = await seed();
    const orchestrator = new Orchestrator(store, hub, provider);

    const agent = await orchestrator.assignTask("p1", "t1");
    // Wait until the orchestrator has driven the completion (→ review).
    await waitFor(async () => (await store.getRun(agent.id))?.status === "review");

    const after = await store.getRun(agent.id);
    expect(after?.status).toBe("review"); // committed & awaiting approval, NOT done
    expect(after?.status).not.toBe("done");

    // A diff review gate was raised for the operator.
    const diffRaised = bus.events.some((e) => e.type === "hitl.raised" && e.item.kind === "diff");
    expect(diffRaised).toBe(true);

    // The edit was committed onto the agent's branch — the work is not lost.
    const diff = git("diff", `main...${after!.branch}`);
    expect(diff).toContain("a + b");
    expect(diff.length).toBeGreaterThan(0);

    // The core invariant: no premature "done". If a "done" status is ever
    // published, it must come AFTER the diff review is raised (i.e. only via the
    // post-approval merge), never in the window where the edit is uncommitted.
    const doneIdx = idxOf(bus.events, (e) => e.type === "run.status" && e.status === "done");
    const reviewIdx = idxOf(bus.events, (e) => e.type === "hitl.raised" && e.item.kind === "diff");
    if (doneIdx !== -1) expect(doneIdx).toBeGreaterThan(reviewIdx);
  });

  it("an agent that makes no change still completes as 'done' (orchestrator-owned)", async () => {
    const provider = new PrematureDoneProvider(() => { /* touch nothing */ });
    const { hub } = await seed();
    const orchestrator = new Orchestrator(store, hub, provider);

    const agent = await orchestrator.assignTask("p1", "t1");
    await waitFor(async () => (await store.getRun(agent.id))?.status === "done");

    const after = await store.getRun(agent.id);
    expect(after?.status).toBe("done"); // genuine no-op → orchestrator sets done
    // No spurious diff review for an empty change.
    expect(bus.events.some((e) => e.type === "hitl.raised" && e.item.kind === "diff")).toBe(false);
    // And a completion event was published.
    expect(bus.events.some((e) => e.type === "run.completed")).toBe(true);
  });

  it("a runner FAILURE escalates the run (actionable, not silently parked) — task stays 'ongoing'", async () => {
    // A runner crash used to just flip the RUN to a silent 'review' with no
    // HITL (and, in an earlier bug, without even moving the task, stranding a
    // "review" chip on a locked Ongoing card). Both are gone: the run escalates
    // — an actionable Resume/Reassign/Stop card — and the task stays 'ongoing',
    // the same lane every other escalation (turn budget, stalled, 3-strikes)
    // uses, its locked card showing a "⏸ <title>" wait-tag from the open HITL.
    const provider = new FailingProvider();
    const { hub } = await seed();
    const orchestrator = new Orchestrator(store, hub, provider);

    const agent = await orchestrator.assignTask("p1", "t1");
    await waitFor(async () => (await store.getRun(agent.id))?.status === "waiting");

    expect((await store.getRun(agent.id))?.status).toBe("waiting"); // resumable, not "review"
    expect((await store.getTask("t1"))?.state).toBe("ongoing");
    const esc = (await store.listQueue(DEFAULT_WORKSPACE)).find(
      (q) => q.runId === agent.id && q.kind === "escalation",
    );
    expect(esc).toBeDefined();
    expect(esc!.resolvedAt).toBeNull();
  });
});
