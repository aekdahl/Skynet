// Escalation: a run can HALT and hand off to a human — the agent gives up, or a
// guard trips (too many failures / too long). The human helps & resumes,
// reassigns, or stops it. These drive the REAL orchestrator with a controllable
// provider (captures the RunnerEvents, records resume/stop on the handle) so the
// raise → HITL → resolve → deliver path is exercised end to end.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HitlItem, ProviderId, Resolution, ServerEvent } from "@skynet/shared";
import { DEFAULT_WORKSPACE, WorkspaceSettings } from "@skynet/shared";
import { config } from "../apps/server/src/config.js";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { Operations } from "../apps/server/src/operations.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import { WorktreeProvisioner } from "../apps/server/src/worktrees.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

class RecordingBus implements Bus {
  events: ServerEvent[] = [];
  publish(_ws: string, event: ServerEvent): void {
    this.events.push(event);
  }
  subscribe(): () => void {
    return () => {};
  }
  raised(): HitlItem[] {
    return this.events.filter((e) => e.type === "hitl.raised").map((e) => (e as { item: HitlItem }).item);
  }
}

class Handle implements RunnerHandle {
  readonly provider: ProviderId = "claude";
  resumeCalls: Array<Resolution | undefined> = [];
  stopCalls = 0;
  constructor(readonly runId: string) {}
  async pause(): Promise<void> {}
  async message(): Promise<void> {}
  async resume(decision?: Resolution): Promise<void> {
    this.resumeCalls.push(decision);
  }
  async stop(): Promise<void> {
    this.stopCalls++;
  }
}

// Captures the RunnerEvents + handle for each started run so a test can drive
// onHitl/onFailed and assert resume/stop.
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

describe("escalation — agent hands off / guards trip → human resolves", () => {
  let store: MemoryStore;
  let bus: RecordingBus;
  let hub: Hub;
  let ops: Operations;
  let orchestrator: Orchestrator;
  let provider: ControllableProvider;

  const assignRun = async () => {
    await store.putAgent({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 });
    const project = await ops.createProject(DEFAULT_WORKSPACE, { name: "P", goal: "", repo: undefined });
    const task = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "do the thing" });
    const run = await ops.assignTask(DEFAULT_WORKSPACE, project.id, task.id);
    return { run, events: provider.events.get(run.id)!, handle: provider.handles.get(run.id)! };
  };

  beforeEach(() => {
    store = new MemoryStore({ seed: false });
    bus = new RecordingBus();
    hub = new Hub(store, bus);
    provider = new ControllableProvider();
    orchestrator = new Orchestrator(store, hub, provider);
    ops = new Operations({ store, hub, orchestrator });
  });

  it("agent hands off (onHitl escalation) → an escalation gate + the run waits", async () => {
    const { run, events } = await assignRun();
    events.onStatus(run.id, "waiting");
    events.onHitl(run.id, {
      kind: "escalation", title: "Blocked on the API contract", why: "The endpoint shape is undocumented and I can't infer it safely.",
      risk: "medium", rationale: "Tried reading the OpenAPI spec and the tests — neither pins the response shape.",
      command: null, options: null, recommended: null, steps: null, diff: null,
    });
    await waitFor(async () => bus.raised().some((i) => i.kind === "escalation"));

    const esc = bus.raised().find((i) => i.kind === "escalation")!;
    expect(esc.runId).toBe(run.id);
    expect(esc.flags).toContain("agent");
    expect((await store.getRun(run.id))?.status).toBe("waiting");
  });

  it("Stop (reject) an escalation → the run ends, the runner is torn down, AND the task is freed back to todo", async () => {
    const { run, events, handle } = await assignRun();
    events.onHitl(run.id, {
      kind: "escalation", title: "Stuck", why: "cannot proceed", risk: "medium", rationale: null,
      command: null, options: null, recommended: null, steps: null, diff: null,
    });
    await waitFor(async () => bus.raised().some((i) => i.kind === "escalation"));
    const esc = bus.raised().find((i) => i.kind === "escalation")!;

    await ops.resolveHitl(DEFAULT_WORKSPACE, esc.id, { action: "reject" }, "op-1");
    await waitFor(async () => (await store.getRun(run.id))?.status === "done");
    expect(handle.stopCalls).toBeGreaterThanOrEqual(1);
    expect((await store.getAgent("r1"))?.status).toBe("idle"); // runner freed
    // The invariant haltAgent (plain "Stop run" on a live run) already upholds:
    // a stopped run integrates no change, so its task must not be left
    // stranded "ongoing" with no live run behind it. Found live on a real
    // deployment — deliverEscalation's reject branch was a separate
    // implementation that skipped this sync, orphaning every task stopped via
    // an escalation card (not the plain Stop button) permanently in "ongoing".
    const freed = (await store.listTasks(DEFAULT_WORKSPACE))[0]!;
    expect(freed.state).toBe("todo");
    expect(freed.runId).toBeNull();
    expect(freed.reviewVerdict).toBeNull();
  });

  it("Help & resume (modify) a CHAT-ONLY run's agent escalation → the live agent resumes with guidance (no worktree to relaunch into)", async () => {
    // assignRun()'s project has no repoPath/repo — gitContextFor resolves to
    // undefined, so this run's LiveAgent has no `git` (see LiveAgent.scratchCwd).
    // raise() deliberately does NOT free the runner for that case — there'd be
    // no worktree for relaunchEscalated to reacquire into, so the live handle
    // staying parked (and modify resuming it directly) is this run's only real
    // path, not just an optimization. See the git-backed test below for the
    // opposite case, where the runner IS freed at raise time.
    const { run, events, handle } = await assignRun();
    events.onHitl(run.id, {
      kind: "escalation", title: "Need a decision", why: "which auth flow?", risk: "medium", rationale: null,
      command: null, options: null, recommended: null, steps: null, diff: null,
    });
    await waitFor(async () => bus.raised().some((i) => i.kind === "escalation"));
    expect(handle.stopCalls).toBe(0); // NOT freed — chat-only, nothing to reacquire into
    expect((await store.getAgent("r1"))?.status).toBe("busy");
    const esc = bus.raised().find((i) => i.kind === "escalation")!;

    await ops.resolveHitl(DEFAULT_WORKSPACE, esc.id, { action: "modify", guidance: "Use the device-code flow." }, "op-1");
    await waitFor(async () => handle.resumeCalls.length > 0);
    expect(handle.resumeCalls[0]?.action).toBe("modify");
    expect(handle.resumeCalls[0]?.guidance).toBe("Use the device-code flow.");
    expect((await store.getRun(run.id))?.status).toBe("running");
  });

  it("Dismiss an agent escalation → clears the card without any FURTHER side effect (raise() already stopped/freed it)", async () => {
    const { run, events, handle } = await assignRun();
    events.onHitl(run.id, {
      kind: "escalation", title: "Need a decision", why: "which auth flow?", risk: "medium", rationale: null,
      command: null, options: null, recommended: null, steps: null, diff: null,
    });
    await waitFor(async () => bus.raised().some((i) => i.kind === "escalation"));
    const esc = bus.raised().find((i) => i.kind === "escalation")!;
    expect((await store.getRun(run.id))?.status).toBe("waiting");

    const resolved = await ops.resolveHitl(DEFAULT_WORKSPACE, esc.id, { action: "dismiss" }, "op-1");
    expect(resolved.resolvedAt).not.toBeNull();
    // No side effect on the run at all — not stopped, not resumed, status untouched.
    expect(handle.stopCalls).toBe(0);
    expect(handle.resumeCalls.length).toBe(0);
    expect((await store.getRun(run.id))?.status).toBe("waiting");
    expect((await store.getAgent("r1"))?.status).toBe("busy"); // runner never freed
  });

  it("Dismiss a stuck-review escalation → restores status to 'review' (what it actually still is)", async () => {
    const store2 = new MemoryStore({ seed: false });
    const bus2 = new RecordingBus();
    const hub2 = new Hub(store2, bus2);
    const orch2 = new Orchestrator(store2, hub2);
    const ops2 = new Operations({ store: store2, hub: hub2, orchestrator: orch2 });
    await store2.putProject({
      id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [],
      status: "active", repoPath: null, gitBacked: false,
    } as never);
    await store2.putRun({
      id: "r-done-review", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", name: "r", status: "review",
      agentId: null, provider: "claude", model: "opus-4.8", branch: "agent/r", modules: [],
      progress: 1, plan: [], usage: null, modifiedFiles: [], log: [], startedAt: 0, lastHeartbeatAt: Date.now(),
      visual: false, previewUrl: null, dependsOn: [], parentId: null, branchFromStep: null, archived: false,
    } as never);

    await orch2.gcWorktrees();
    const esc = (await store2.listQueue(DEFAULT_WORKSPACE)).find((q) => q.kind === "escalation")!;
    expect(esc.flags).toContain("stuck-review");
    expect((await store2.getRun("r-done-review"))?.status).toBe("waiting"); // forced so the card surfaces

    await ops2.resolveHitl(DEFAULT_WORKSPACE, esc.id, { action: "dismiss" }, "op-1");
    expect((await store2.getRun("r-done-review"))?.status).toBe("review"); // restored — it never stopped being true
  });

  it("every generic failure auto-escalates immediately (not a silent 'review' spin)", async () => {
    const { run, events } = await assignRun();
    // A single failure must escalate right away — nothing retries a run on its
    // own, so silently absorbing the first couple of failures just dead-ends the
    // task in `review` with no HITL. See fail() in orchestrator.ts.
    events.onFailed(run.id, "attempt 1 crashed");
    await waitFor(async () => bus.raised().some((i) => i.kind === "escalation"));

    const esc = bus.raised().find((i) => i.kind === "escalation")!;
    expect(esc.flags).toContain("failures");
    expect(esc.why).toMatch(/1 failed attempt/i);
    expect((await store.getRun(run.id))?.status).toBe("waiting"); // resumable, not silently "review"
  });

  it("runMaxFailures=0 opts back into the old silent 'review' parking", async () => {
    const before = config.runMaxFailures;
    config.runMaxFailures = 0;
    try {
      const { run, events } = await assignRun();
      events.onFailed(run.id, "attempt 1 crashed");
      await waitFor(async () => (await store.getRun(run.id))?.status === "review");
      expect(bus.raised().some((i) => i.kind === "escalation")).toBe(false);
    } finally {
      config.runMaxFailures = before;
    }
  });

  it("running out of turns escalates immediately (resumable), not counted as a failure", async () => {
    const { run, events } = await assignRun();
    // A single error_max_turns must escalate straight away — it's a resumable
    // checkpoint, not one of the N failures that trip the failure-count guard.
    events.onFailed(run.id, "error_max_turns");
    await waitFor(async () => bus.raised().some((i) => i.kind === "escalation"));

    const esc = bus.raised().find((i) => i.kind === "escalation")!;
    expect(esc.flags).toContain("turns");
    expect(esc.title).toMatch(/ran out of turns/i);
    expect(esc.why).toMatch(/turn budget/i);
    expect((await store.getRun(run.id))?.status).toBe("waiting"); // escalated, not "review"
  });

  it("a reaped (heartbeat-silent) running agent escalates as resumable — not a dead-end 'done'", async () => {
    const { run, handle } = await assignRun();
    // Simulate a crashed/orphaned runner: still `running`, but its heartbeat went
    // silent long ago (epoch is well past any reap cutoff).
    const cur = (await store.getRun(run.id))!;
    await store.putRun({ ...cur, status: "running", lastHeartbeatAt: 0 });

    await orchestrator.reapStaleAgents();

    // Instead of stopping + marking it done (which would retire the worktree and
    // drop the work), the reaper routes it into the escalation → Resume path.
    await waitFor(async () => bus.raised().some((i) => i.kind === "escalation"));
    const esc = bus.raised().find((i) => i.kind === "escalation")!;
    expect(esc.runId).toBe(run.id);
    expect(esc.flags).toContain("stalled");
    expect(esc.title).toMatch(/went silent/i);
    expect((await store.getRun(run.id))?.status).toBe("waiting"); // resumable, not "done"
    expect(handle.stopCalls).toBeGreaterThanOrEqual(1); // dead session torn down
    expect((await store.getAgent("r1"))?.status).toBe("idle"); // runner freed

    // Idempotent: a second sweep must not re-raise or clobber the open card.
    await orchestrator.reapStaleAgents();
    expect(bus.raised().filter((i) => i.kind === "escalation").length).toBe(1);
    expect((await store.getRun(run.id))?.status).toBe("waiting");
  });

  it("a reaped (heartbeat-silent) run parked on a normal gate is freed AND its task is un-stranded — not left 'ongoing' showing a done run", async () => {
    const { run, events, handle } = await assignRun();
    // Parked on a plain (non-escalation, non-auto-approved) gate — the runner
    // itself reports "waiting" for this branch, unlike the escalation kind
    // which the orchestrator sets internally (see the "agent hands off" test).
    events.onStatus(run.id, "waiting");
    events.onHitl(run.id, {
      kind: "question", title: "Which auth flow?", why: "need to pick one before continuing",
      risk: "medium", rationale: null, command: null, options: ["OAuth", "SAML"], recommended: null, steps: null, diff: null,
    });
    await waitFor(async () => (await store.getRun(run.id))?.status === "waiting");
    expect(bus.raised().some((i) => i.kind === "question")).toBe(true); // a real gate, not an escalation

    // Simulate the session dying while parked here: heartbeat goes stale.
    const cur = (await store.getRun(run.id))!;
    await store.putRun({ ...cur, status: "waiting", lastHeartbeatAt: 0 });

    await orchestrator.reapStaleAgents();

    await waitFor(async () => (await store.getRun(run.id))?.status === "done");
    expect(handle.stopCalls).toBeGreaterThanOrEqual(1); // dead session torn down
    expect((await store.getAgent("r1"))?.status).toBe("idle"); // runner freed
    // Reported live: this reap path used to leave the owning task stranded
    // "ongoing" — a kanban card sitting in a mid-pipeline column while its
    // run's own status chip read "done". Same invariant haltAgent/
    // settleArchivedRun uphold on every other termination path.
    const freed = (await store.listTasks(DEFAULT_WORKSPACE))[0]!;
    expect(freed.state).toBe("todo");
    expect(freed.runId).toBeNull();
    expect(freed.reviewVerdict).toBeNull();
  });

  it("out of credits trips the key breaker: escalates once, pauses new runs on the key, resume clears it", async () => {
    const { run, events } = await assignRun();
    // The runner hits a billing wall (surfaced as the provider's own message).
    events.onFailed(run.id, "Your credit balance is too low to access the Anthropic API");
    await waitFor(async () => bus.raised().some((i) => i.kind === "escalation"));

    const esc = bus.raised().find((i) => i.kind === "escalation")!;
    expect(esc.flags).toContain("billing");
    expect(esc.title).toMatch(/out of credits/i);
    expect(esc.runId).toBe(run.id);
    expect((await store.getRun(run.id))?.status).toBe("waiting"); // resumable, not a dead "review"

    // The key is now paused: a NEW task on the same provider/key can't be
    // assigned to the (now-idle) runner — no doomed run, a clear billing message.
    const project = await ops.createProject(DEFAULT_WORKSPACE, { name: "P2", goal: "", repo: undefined });
    const t2 = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "next" });
    await expect(ops.assignTask(DEFAULT_WORKSPACE, project.id, t2.id)).rejects.toThrow(/out of credits\/quota/i);

    // Resuming the escalation (operator topped up) clears the breaker → assignable again.
    await ops.resolveHitl(DEFAULT_WORKSPACE, esc.id, { action: "reassign" }, "op-1");
    await waitFor(async () => {
      try {
        await ops.assignTask(DEFAULT_WORKSPACE, project.id, t2.id);
        return true;
      } catch {
        return false;
      }
    });
  });

  it("Reassign with no worktree fails gracefully — the run stays escalated, no crash", async () => {
    const { run, events } = await assignRun(); // non-git project → no worktree to relaunch in
    events.onHitl(run.id, {
      kind: "escalation", title: "Stuck", why: "cannot proceed", risk: "medium", rationale: null,
      command: null, options: null, recommended: null, steps: null, diff: null,
    });
    await waitFor(async () => bus.raised().some((i) => i.kind === "escalation"));
    const esc = bus.raised().find((i) => i.kind === "escalation")!;

    await ops.resolveHitl(DEFAULT_WORKSPACE, esc.id, { action: "reassign" }, "op-1");
    // No git backend → relaunch can't proceed; the run must remain waiting (not crash / not "done").
    await waitFor(async () => (await store.getRun(run.id))?.status === "waiting");
    expect((await store.getRun(run.id))?.status).toBe("waiting");
  });
});

// A "Runner went silent" escalation (the reaper's stalled-agent path) is the
// exact shape a real server restart produces: this.live is in-memory, so a
// restart orphans every previously-running agent — the next reap sweep
// escalates all of them as "stalled", and the FIRST thing an operator does is
// click Resume. If that resume attempt itself fails to start (a provider
// outage, a misconfigured key — anything), the run must NOT be stranded: no
// dead-ending into "review" with nothing to click, and critically no retiring
// the worktree that holds the agent's actual prior work. These use a REAL git
// repo (unlike the lightweight harness above) so the worktree's on-disk
// survival is a genuine assertion, not a mocked one.
describe("escalation — a failed resume attempt re-raises instead of dead-ending", () => {
  let store: MemoryStore;
  let bus: RecordingBus;
  let hub: Hub;
  let ops: Operations;
  let orchestrator: Orchestrator;
  let repo: string;
  let provider: FlakyProvider;

  class FlakyProvider implements RunnerProvider {
    readonly id: ProviderId = "claude";
    events = new Map<string, RunnerEvents>();
    handles = new Map<string, Handle>();
    /** Set true right before the call you want to fail; auto-resets after one use. */
    failNextStart = false;
    async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
      if (this.failNextStart) {
        this.failNextStart = false;
        throw new Error("provider unavailable (simulated)");
      }
      this.events.set(spec.runId, events);
      const h = new Handle(spec.runId);
      this.handles.set(spec.runId, h);
      return h;
    }
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "esc-repo-"));
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "t@t"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
    writeFileSync(join(repo, "README.md"), "base\n");
    execFileSync("git", ["-C", repo, "add", "-A"]);
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "base"]);

    store = new MemoryStore({ seed: false });
    bus = new RecordingBus();
    hub = new Hub(store, bus);
    provider = new FlakyProvider();
    orchestrator = new Orchestrator(store, hub, provider);
    ops = new Operations({ store, hub, orchestrator });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("a resume attempt that fails to start does NOT retire the worktree or dead-end the run — it re-raises for another try", async () => {
    await store.putAgent({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 });
    const project = await ops.createProject(DEFAULT_WORKSPACE, { name: "P", goal: "", repoPath: repo });
    const task = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "do the thing" });
    const run = await ops.assignTask(DEFAULT_WORKSPACE, project.id, task.id);
    const worktrees = new WorktreeProvisioner(repo, "main");
    expect(worktrees.exists(run.id)).toBe(true); // sanity: provisioning actually happened

    // Simulate what a real server restart does: the in-memory live handle is
    // gone, the heartbeat is frozen, and the next reap sweep escalates it.
    const cur = (await store.getRun(run.id))!;
    await store.putRun({ ...cur, status: "running", lastHeartbeatAt: 0 });
    await orchestrator.reapStaleAgents();
    await waitFor(async () => bus.raised().some((i) => i.kind === "escalation"));
    const esc1 = bus.raised().find((i) => i.kind === "escalation")!;
    expect(esc1.flags).toContain("stalled");
    expect((await store.getAgent("r1"))?.status).toBe("idle"); // freed by the reap, ready to relaunch onto

    // Click "Help & resume" — but the provider fails to start this time.
    provider.failNextStart = true;
    await ops.resolveHitl(DEFAULT_WORKSPACE, esc1.id, { action: "modify", guidance: "try again" }, "op-1");

    // A SECOND, actionable escalation must appear — never a dead end.
    await waitFor(async () => bus.raised().filter((i) => i.kind === "escalation").length >= 2);
    const escalations = bus.raised().filter((i) => i.kind === "escalation");
    expect(escalations).toHaveLength(2);
    const esc2 = escalations[1]!;
    expect(esc2.runId).toBe(run.id);
    expect(esc2.why).toMatch(/resume failed/i);
    expect(esc2.flags).toContain("stalled"); // the original escalation reason carries forward

    const runAfterFailure = await store.getRun(run.id);
    expect(runAfterFailure?.status).toBe("waiting"); // NOT "review" (no diff to act on), NOT "done"
    expect((await store.getTask(task.id))?.state).not.toBe("done");

    // The worktree — the agent's real prior work — must still be there.
    expect(worktrees.exists(run.id)).toBe(true);

    // And a follow-up resume, now succeeding, actually relaunches the run.
    await ops.resolveHitl(DEFAULT_WORKSPACE, esc2.id, { action: "modify", guidance: "try again" }, "op-1");
    await waitFor(async () => (await store.getRun(run.id))?.status === "running");
    expect(provider.events.has(run.id)).toBe(true); // the second, SUCCESSFUL start landed
  });

  it("a reassign that can't acquire ANY runner does NOT dead-end the run — it re-raises for another try", async () => {
    await store.putAgent({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 });
    // Fleet capped at the one runner that exists — so once it's unavailable,
    // acquireOrProvisionRunner has nothing to acquire AND can't auto-provision.
    await store.putWorkspaceSettings(WorkspaceSettings.parse({ workspaceId: DEFAULT_WORKSPACE, maxRunners: 1 }));
    const project = await ops.createProject(DEFAULT_WORKSPACE, { name: "P", goal: "", repoPath: repo });
    const task = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "do the thing" });
    const run = await ops.assignTask(DEFAULT_WORKSPACE, project.id, task.id);
    const worktrees = new WorktreeProvisioner(repo, "main");

    const cur = (await store.getRun(run.id))!;
    await store.putRun({ ...cur, status: "running", lastHeartbeatAt: 0 });
    await orchestrator.reapStaleAgents();
    await waitFor(async () => bus.raised().some((i) => i.kind === "escalation"));
    const esc1 = bus.raised().find((i) => i.kind === "escalation")!;

    // The runner the reap freed has since picked up other work, or left the
    // fleet entirely (removed/disabled) — either way, by the time the operator
    // clicks Reassign there is nothing within the cap to reassign onto.
    const r1 = (await store.getAgent("r1"))!;
    await store.putAgent({ ...r1, status: "busy", idleSince: null });

    await ops.resolveHitl(DEFAULT_WORKSPACE, esc1.id, { action: "reassign" }, "op-1");

    // A SECOND, actionable escalation must appear — never a dead end.
    await waitFor(async () => bus.raised().filter((i) => i.kind === "escalation").length >= 2);
    const escalations = bus.raised().filter((i) => i.kind === "escalation");
    expect(escalations).toHaveLength(2);
    const esc2 = escalations[1]!;
    expect(esc2.runId).toBe(run.id);
    expect(esc2.why).toMatch(/reassign failed/i);

    const runAfterFailure = await store.getRun(run.id);
    expect(runAfterFailure?.status).toBe("waiting"); // NOT "review", NOT "done"
    expect(worktrees.exists(run.id)).toBe(true); // the worktree survives

    // Free up capacity and confirm a follow-up reassign now succeeds.
    await store.putAgent({ ...r1, status: "idle", idleSince: 0 });
    await ops.resolveHitl(DEFAULT_WORKSPACE, esc2.id, { action: "reassign" }, "op-1");
    await waitFor(async () => (await store.getRun(run.id))?.status === "running");
  });
});

// "Send to Todo" and "Reassign" both used to have exactly one hardcoded
// behavior — the former always discarded, the latter always continued —
// with no way to ask for the other. Both now offer a real choice: keep the
// worktree (pause, resumable) or reset (discard, start clean). Real git repo
// so worktree survival/removal is a genuine on-disk assertion, not mocked.
describe("reset vs. continue — operator choice on 'Send to Todo' and 'Reassign'", () => {
  let store: MemoryStore;
  let bus: RecordingBus;
  let hub: Hub;
  let ops: Operations;
  let orchestrator: Orchestrator;
  let repo: string;
  let provider: ControllableProvider;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "esc-reset-repo-"));
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "t@t"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
    writeFileSync(join(repo, "README.md"), "base\n");
    execFileSync("git", ["-C", repo, "add", "-A"]);
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "base"]);

    store = new MemoryStore({ seed: false });
    bus = new RecordingBus();
    hub = new Hub(store, bus);
    provider = new ControllableProvider();
    orchestrator = new Orchestrator(store, hub, provider);
    ops = new Operations({ store, hub, orchestrator });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("Send to Todo, preserve:true — pauses the run (worktree kept) instead of discarding it, and a later Start resumes it in place", async () => {
    await store.putAgent({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 });
    const project = await ops.createProject(DEFAULT_WORKSPACE, { name: "P", goal: "", repoPath: repo });
    const task = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "do the thing" });
    const run = await ops.assignTask(DEFAULT_WORKSPACE, project.id, task.id);
    const worktrees = new WorktreeProvisioner(repo, "main");
    expect(worktrees.exists(run.id)).toBe(true);

    await ops.transitionTask(DEFAULT_WORKSPACE, task.id, "todo", "op-1", { preserve: true });

    const paused = await store.getTask(task.id);
    expect(paused?.state).toBe("todo");
    expect(paused?.runId).toBe(run.id); // still linked — that's how a later Start finds it
    expect((await store.getRun(run.id))?.status).toBe("waiting");
    expect(worktrees.exists(run.id)).toBe(true); // work preserved, not discarded
    expect((await store.getAgent("r1"))?.status).toBe("idle"); // runner freed either way

    // A follow-up "Start" on the same (still-Todo) task resumes the SAME run.
    const resumed = await ops.assignTask(DEFAULT_WORKSPACE, project.id, task.id);
    expect(resumed.id).toBe(run.id); // same run id — not a fresh one
    expect((await store.getRun(run.id))?.status).toBe("running");
    expect((await store.getTask(task.id))?.state).toBe("ongoing");
    expect(provider.events.has(run.id)).toBe(true); // the resume actually started a session
  });

  it("Send to Todo, preserve:false (the default) — discards the run and its worktree exactly as before", async () => {
    await store.putAgent({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 });
    const project = await ops.createProject(DEFAULT_WORKSPACE, { name: "P", goal: "", repoPath: repo });
    const task = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "do the thing" });
    const run = await ops.assignTask(DEFAULT_WORKSPACE, project.id, task.id);
    const worktrees = new WorktreeProvisioner(repo, "main");
    expect(worktrees.exists(run.id)).toBe(true);

    await ops.transitionTask(DEFAULT_WORKSPACE, task.id, "todo", "op-1");

    const reset = await store.getTask(task.id);
    expect(reset?.state).toBe("todo");
    expect(reset?.runId).toBeNull(); // detached — nothing to resume
    expect(worktrees.exists(run.id)).toBe(false); // discarded, as it always did
  });

  it("Reassign, resetWork:true — discards the old worktree and starts a brand-new run for the same task", async () => {
    await store.putAgent({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 });
    await store.putAgent({ id: "r2", workspaceId: DEFAULT_WORKSPACE, name: "r2", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 });
    const project = await ops.createProject(DEFAULT_WORKSPACE, { name: "P", goal: "", repoPath: repo });
    const task = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "do the thing" });
    const run = await ops.assignTask(DEFAULT_WORKSPACE, project.id, task.id);
    const worktrees = new WorktreeProvisioner(repo, "main");
    expect(worktrees.exists(run.id)).toBe(true);

    const cur = (await store.getRun(run.id))!;
    await store.putRun({ ...cur, status: "running", lastHeartbeatAt: 0 });
    await orchestrator.reapStaleAgents();
    await waitFor(async () => bus.raised().some((i) => i.kind === "escalation"));
    const esc = bus.raised().find((i) => i.kind === "escalation")!;

    await ops.resolveHitl(DEFAULT_WORKSPACE, esc.id, { action: "reassign", resetWork: true }, "op-1");

    // The OLD run is done and its worktree is gone — a clean slate, as asked.
    expect((await store.getRun(run.id))?.status).toBe("done");
    expect(worktrees.exists(run.id)).toBe(false);

    // The task now points at a DIFFERENT, freshly-provisioned run.
    const freshTask = await store.getTask(task.id);
    expect(freshTask?.runId).not.toBe(run.id);
    expect(freshTask?.state).toBe("ongoing");
    const newRun = await store.getRun(freshTask!.runId!);
    expect(newRun?.status).toBe("running");
    expect(worktrees.exists(newRun!.id)).toBe(true); // the new run got its own fresh worktree
  });

  it("Reassign, resetWork:false (the default) — continues in the SAME worktree exactly as before", async () => {
    await store.putAgent({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 });
    await store.putAgent({ id: "r2", workspaceId: DEFAULT_WORKSPACE, name: "r2", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 });
    const project = await ops.createProject(DEFAULT_WORKSPACE, { name: "P", goal: "", repoPath: repo });
    const task = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "do the thing" });
    const run = await ops.assignTask(DEFAULT_WORKSPACE, project.id, task.id);
    const worktrees = new WorktreeProvisioner(repo, "main");

    const cur = (await store.getRun(run.id))!;
    await store.putRun({ ...cur, status: "running", lastHeartbeatAt: 0 });
    await orchestrator.reapStaleAgents();
    await waitFor(async () => bus.raised().some((i) => i.kind === "escalation"));
    const esc = bus.raised().find((i) => i.kind === "escalation")!;

    await ops.resolveHitl(DEFAULT_WORKSPACE, esc.id, { action: "reassign" }, "op-1");

    expect((await store.getRun(run.id))?.status).toBe("running"); // same run id, relaunched
    expect((await store.getTask(task.id))?.runId).toBe(run.id);
    expect(worktrees.exists(run.id)).toBe(true);
  });
});

// A worktree-backed run's runner is no longer held idle for however long an
// agent-driven escalation takes to get a human's attention — freed the moment
// it's raised, same as a system-driven escalation already does; "Help &
// resume" reacquires fresh compute (relaunchEscalated) instead of resuming
// the old live session. Real git repo so relaunchEscalated has an actual
// worktree to reacquire into (see the chat-only test above for the case
// where it doesn't, and the old resume-in-place behavior still applies).
describe("escalation — a worktree-backed run's agent-driven escalation frees its runner", () => {
  let store: MemoryStore;
  let bus: RecordingBus;
  let hub: Hub;
  let ops: Operations;
  let orchestrator: Orchestrator;
  let repo: string;
  let provider: ControllableProvider;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "esc-git-free-repo-"));
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "t@t"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
    writeFileSync(join(repo, "README.md"), "base\n");
    execFileSync("git", ["-C", repo, "add", "-A"]);
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "base"]);

    store = new MemoryStore({ seed: false });
    bus = new RecordingBus();
    hub = new Hub(store, bus);
    provider = new ControllableProvider();
    orchestrator = new Orchestrator(store, hub, provider);
    ops = new Operations({ store, hub, orchestrator });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("raises already stopped + freed; Help & resume reacquires a FRESH session (never the old handle) carrying the guidance", async () => {
    await store.putAgent({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 });
    const project = await ops.createProject(DEFAULT_WORKSPACE, { name: "P", goal: "", repoPath: repo });
    const task = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "do the thing" });
    const run = await ops.assignTask(DEFAULT_WORKSPACE, project.id, task.id);
    const worktrees = new WorktreeProvisioner(repo, "main");
    expect(worktrees.exists(run.id)).toBe(true);

    const events = provider.events.get(run.id)!;
    const handle = provider.handles.get(run.id)!;
    events.onHitl(run.id, {
      kind: "escalation", title: "Need a decision", why: "which auth flow?", risk: "medium", rationale: null,
      command: null, options: null, recommended: null, steps: null, diff: null,
    });
    await waitFor(async () => bus.raised().some((i) => i.kind === "escalation"));
    // Stopped + freed by raise() itself — before the operator has done anything.
    expect(handle.stopCalls).toBeGreaterThanOrEqual(1);
    expect((await store.getAgent("r1"))?.status).toBe("idle");
    const esc = bus.raised().find((i) => i.kind === "escalation")!;

    await ops.resolveHitl(DEFAULT_WORKSPACE, esc.id, { action: "modify", guidance: "Use the device-code flow." }, "op-1");
    await waitFor(async () => (await store.getRun(run.id))?.status === "running");
    expect(handle.resumeCalls.length).toBe(0); // the OLD handle was never resumed
    // A brand new session was reacquired for the SAME run, in the SAME
    // worktree, carrying the guidance in its prompt (relaunchEscalated's own
    // reconstruction, not a resumed live conversation).
    expect(provider.handles.get(run.id)).not.toBe(handle);
    const relaunchSpec = provider.starts[provider.starts.length - 1]!;
    expect(relaunchSpec.runId).toBe(run.id);
    expect(relaunchSpec.task).toContain("Use the device-code flow.");
    expect(worktrees.exists(run.id)).toBe(true); // the prior work is still there to resume into
  });
});
