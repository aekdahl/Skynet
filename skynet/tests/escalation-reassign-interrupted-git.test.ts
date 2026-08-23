// End-to-end reproduction of a real reported bug: reassigning an escalated
// run whose PREVIOUS agent was killed mid `git merge` (plausibly why it got
// stuck — a conflict it didn't know how to resolve) used to hand the new
// agent a half-finished merge with no idea it was there. Observed in the
// wild: the new agent ran ad-hoc git log/status/fsck trying to understand the
// repo, then got stuck the same way and escalated again. This drives the
// REAL orchestrator (real git repo + worktree) through assign → escalate →
// reassign and asserts the interrupted merge is aborted before the new agent
// ever starts, and it's told so in its own prompt.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { HitlItem, ProviderId, Resolution, ServerEvent } from "@skynet/shared";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

class RecordingBus implements Bus {
  events: ServerEvent[] = [];
  publish(_ws: string, event: ServerEvent): void {
    this.events.push(event);
  }
  subscribe(): () => void { return () => {}; }
  raised(): HitlItem[] {
    return this.events.filter((e) => e.type === "hitl.raised").map((e) => (e as { item: HitlItem }).item);
  }
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

const waitFor = async (pred: () => Promise<boolean>, ms = 3000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("condition not met in time");
};

let Hub: typeof import("../apps/server/src/hub.js").Hub;
let Orchestrator: typeof import("../apps/server/src/orchestrator.js").Orchestrator;
let Operations: typeof import("../apps/server/src/operations.js").Operations;
let MemoryStore: typeof import("../apps/server/src/store/memory.js").MemoryStore;
let repo: string, worktreesDir: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "skynet-reassign-repo-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "skynet-reassign-wt-"));
  execFileSync("git", ["init", "-b", "main", repo]);
  git(repo, "config", "user.email", "test@skynet.local");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "shared.txt"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "base");
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

describe("reassign after escalation — a worktree interrupted mid-merge is sanitized before handoff", () => {
  it("aborts the stuck merge, logs it, and tells the new agent — instead of handing it a half-finished conflict", async () => {
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
    const events = provider.events.get(run.id)!;
    const cwd = provider.starts[0]!.cwd!;

    // Simulate the killed agent's own commit, then main diverging, then a
    // merge that hits a real conflict and is left interrupted (the agent got
    // "stuck" here and was later killed by escalate()'s handle.stop()).
    writeFileSync(join(cwd, "shared.txt"), "agent version\n");
    git(cwd, "add", "-A");
    git(cwd, "-c", "user.name=T", "-c", "user.email=t@t", "commit", "-m", "agent edit");
    writeFileSync(join(repo, "shared.txt"), "main moved on\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "main edit");
    try {
      git(cwd, "merge", "main");
    } catch {
      /* expected — real conflict, left interrupted */
    }
    expect(git(cwd, "status", "--porcelain=v1")).toContain("UU shared.txt");

    // The agent hands off as stuck.
    events.onHitl(run.id, {
      kind: "escalation", title: "Stuck", why: "hit a merge conflict I couldn't resolve", risk: "medium", rationale: null,
      command: null, options: null, recommended: null, steps: null, diff: null,
    });
    await waitFor(async () => bus.raised().some((i) => i.kind === "escalation"));
    const esc = bus.raised().find((i) => i.kind === "escalation")!;

    // Operator clicks Reassign.
    await ops.resolveHitl(DEFAULT_WORKSPACE, esc.id, { action: "reassign" }, "op-1");
    await waitFor(async () => provider.starts.length === 2); // the new agent's start() call

    // The interrupted merge was aborted BEFORE the new agent started — never
    // handed a half-finished conflict to reverse-engineer. HEAD is back to
    // the agent's own last real commit (never resurrects main's changes).
    const statusAfter = git(cwd, "status", "--porcelain=v1");
    expect(statusAfter).not.toContain("UU shared.txt");
    expect(git(cwd, "rev-parse", "HEAD")).toBe(git(cwd, "rev-parse", run.branch));

    // The new agent's own prompt says so — it never has to discover this itself.
    const secondStart = provider.starts[1]!;
    expect(secondStart.task).toContain("interrupted mid-`git merge`");
    expect(secondStart.task).toContain("No need to investigate this further");

    // The run log carries the same note for the operator.
    const finalRun = await store.getRun(run.id);
    expect(finalRun?.log.some((l) => l.line.includes("interrupted git merge"))).toBe(true);
  });

  it("a run whose worktree AND branch are both gone is flagged unrecoverable — never re-escalates as a plain retry invite", async () => {
    const store = new MemoryStore({ seed: false });
    const bus = new RecordingBus();
    const hub = new Hub(store, bus);
    const provider = new ControllableProvider();
    const orchestrator = new Orchestrator(store, hub, provider);
    const ops = new Operations({ store, hub, orchestrator });

    await store.putAgent({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 });
    const project = await ops.createProject(DEFAULT_WORKSPACE, { name: "P2", goal: "" });
    const task = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "another thing" });
    const run = await ops.assignTask(DEFAULT_WORKSPACE, project.id, task.id);
    const events = provider.events.get(run.id)!;

    events.onHitl(run.id, {
      kind: "escalation", title: "Stuck", why: "cannot proceed", risk: "medium", rationale: null,
      command: null, options: null, recommended: null, steps: null, diff: null,
    });
    await waitFor(async () => bus.raised().some((i) => i.kind === "escalation"));
    const esc = bus.raised().find((i) => i.kind === "escalation")!;

    // Simulate the worst case the doc comment on the "limbo" sweep describes:
    // not just the worktree directory gone (routine — reattach handles that
    // fine) but the BRANCH gone too, e.g. a startup failure or disk-hygiene
    // sweep that cleaned up more than expected. git worktree remove alone
    // would never do this — deleting the ref directly is how we get there.
    git(repo, "worktree", "remove", "--force", join(worktreesDir, run.id.replace(/[^a-zA-Z0-9._-]/g, "_")));
    git(repo, "branch", "-D", run.branch);

    await ops.resolveHitl(DEFAULT_WORKSPACE, esc.id, { action: "reassign" }, "op-1");
    await waitFor(async () => bus.raised().filter((i) => i.kind === "escalation").length === 2);
    const reEsc = bus.raised().filter((i) => i.kind === "escalation")[1]!;

    expect(reEsc.flags).toContain("unrecoverable");
    expect(reEsc.why).toMatch(/reassign failed/i);
    expect(reEsc.why).toMatch(/branch .* no longer exists/i);
    // No new agent was ever started — nothing to hand a fresh session to.
    expect(provider.starts).toHaveLength(1);
  });
});
