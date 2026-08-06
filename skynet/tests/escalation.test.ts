// Escalation: a run can HALT and hand off to a human — the agent gives up, or a
// guard trips (too many failures / too long). The human helps & resumes,
// reassigns, or stops it. These drive the REAL orchestrator with a controllable
// provider (captures the RunnerEvents, records resume/stop on the handle) so the
// raise → HITL → resolve → deliver path is exercised end to end.
import { describe, it, expect, beforeEach } from "vitest";
import type { HitlItem, ProviderId, Resolution, ServerEvent } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { Operations } from "../apps/server/src/operations.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
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
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
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

  it("Stop (reject) an escalation → the run ends and the runner is torn down", async () => {
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
  });

  it("Help & resume (modify) an agent escalation → the live agent resumes with guidance", async () => {
    const { run, events, handle } = await assignRun();
    events.onHitl(run.id, {
      kind: "escalation", title: "Need a decision", why: "which auth flow?", risk: "medium", rationale: null,
      command: null, options: null, recommended: null, steps: null, diff: null,
    });
    await waitFor(async () => bus.raised().some((i) => i.kind === "escalation"));
    const esc = bus.raised().find((i) => i.kind === "escalation")!;

    await ops.resolveHitl(DEFAULT_WORKSPACE, esc.id, { action: "modify", guidance: "Use the device-code flow." }, "op-1");
    await waitFor(async () => handle.resumeCalls.length > 0);
    expect(handle.resumeCalls[0]?.action).toBe("modify");
    expect(handle.resumeCalls[0]?.guidance).toBe("Use the device-code flow.");
    expect((await store.getRun(run.id))?.status).toBe("running");
  });

  it("too many failures → auto-escalate (not a silent 'review' spin)", async () => {
    const { run, events } = await assignRun();
    // First failures park in `review` (the existing behaviour), not escalation.
    events.onFailed(run.id, "attempt 1 crashed");
    await waitFor(async () => (await store.getRun(run.id))?.status === "review");
    expect(bus.raised().some((i) => i.kind === "escalation")).toBe(false);

    events.onFailed(run.id, "attempt 2 crashed");
    await waitFor(async () => (await store.getRun(run.id))?.status === "review");
    // The 3rd failure (default SKYNET_RUN_MAX_FAILURES=3) escalates to a human.
    events.onFailed(run.id, "attempt 3 crashed");
    await waitFor(async () => bus.raised().some((i) => i.kind === "escalation"));

    const esc = bus.raised().find((i) => i.kind === "escalation")!;
    expect(esc.flags).toContain("failures");
    expect(esc.why).toMatch(/3 failed attempts/i);
    expect((await store.getRun(run.id))?.status).toBe("waiting");
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
