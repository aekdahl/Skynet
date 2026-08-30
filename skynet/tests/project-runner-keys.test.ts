// A project can be confined to a set of provider KEYS (secret-store credential
// ids). Assignment to that project may then only land on a fleet runner whose
// key (credentialId ?? provider) is in the set — enforced in the orchestrator so
// it holds for EVERY caller (human, autonomy loop, or MCP token), not just one.
import { describe, it, expect } from "vitest";
import type { ProviderId, Agent, HitlItem, Project, Task, TaskRun } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { NoReviewerAvailableError, Orchestrator } from "../apps/server/src/orchestrator.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

class NullBus implements Bus {
  publish(): void {}
  subscribe(): () => void {
    return () => {};
  }
}

// Keeps every run "running" so a started agent stays live. Used as the provider
// override, which also short-circuits providerUsable() to true — so the test
// exercises KEY confinement in isolation, not credential resolution.
class RunningProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  async start(spec: StartSpec, _events: RunnerEvents): Promise<RunnerHandle> {
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

// Two idle runners on DIFFERENT keys (both provider-default, so effective key ===
// provider id): a claude one and a gemini one.
function seed(store: MemoryStore, enabledRunnerCredentialIds: string[]) {
  const project: Project = {
    id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "Proj", goal: "", runIds: [], status: "active", enabledRunnerCredentialIds,
  } as Project;
  const task: Task = { id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "do it", state: "backlog", runId: null } as Task;
  const runners: Agent[] = [
    { id: "r-claude", workspaceId: DEFAULT_WORKSPACE, name: "r-claude", provider: "claude", credentialId: null, model: "opus", status: "idle", idleSince: 0 },
    { id: "r-gemini", workspaceId: DEFAULT_WORKSPACE, name: "r-gemini", provider: "gemini", credentialId: null, model: "g", status: "idle", idleSince: 0 },
  ];
  return Promise.all([store.putProject(project), store.putTask(task), ...runners.map((r) => store.putAgent(r))]);
}

const build = (store: MemoryStore) => new Orchestrator(store, new Hub(store, new NullBus()), new RunningProvider());

// Also answers `consult()` (the LLM call triage and periodic auto-review make)
// with a scripted reply — RunningProvider only implements `start()`, which is
// all assignment-gating needs, but the post-assignment picking sites below
// (triage / auto-review) go through consult() first.
class ConsultingProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  consulted = 0;
  constructor(private reply = '{"verdict":"approve","reason":"looks good"}') {}
  async start(spec: StartSpec, _events: RunnerEvents): Promise<RunnerHandle> {
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
  async consult(): Promise<string> {
    this.consulted++;
    return this.reply;
  }
}

// Same two runners as `seed()` above (claude + gemini, different keys), but
// the claude one is BUSY — isolates "no idle runner on an allowed key" from
// assignment gating, to prove the picking sites that act on an ALREADY-
// assigned task (triage, periodic auto-review, manual request-review) also
// honor the allowlist instead of falling back to the workspace's other idle
// runner just because it happens to be free.
function seedPickingWithClaudeBusy(store: MemoryStore, taskOverrides: Partial<Task> = {}) {
  const project: Project = {
    id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "Proj", goal: "", runIds: [], status: "active",
    enabledRunnerCredentialIds: ["claude"],
  } as Project;
  const task: Task = {
    id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "do it", state: "backlog", runId: null,
    assignment: { mode: "any", agentIds: [] }, ...taskOverrides,
  } as Task;
  const runners: Agent[] = [
    { id: "r-claude", workspaceId: DEFAULT_WORKSPACE, name: "r-claude", provider: "claude", credentialId: null, model: "opus", status: "busy", idleSince: 0 },
    { id: "r-gemini", workspaceId: DEFAULT_WORKSPACE, name: "r-gemini", provider: "gemini", credentialId: null, model: "g", status: "idle", idleSince: 0, canReview: true },
  ];
  return Promise.all([store.putProject(project), store.putTask(task), ...runners.map((r) => store.putAgent(r))]);
}

const mkReviewFixture = (): { run: TaskRun; hitl: HitlItem } => ({
  run: {
    id: "r1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", name: "do it", status: "review",
    runnerId: null, agentId: "r-claude", model: "opus", branch: "agent/r1", modules: [], progress: 1,
    plan: [], modifiedFiles: [], log: [], startedAt: 0, lastHeartbeatAt: 0, visual: false,
    previewUrl: null, dependsOn: [], parentId: null, branchFromStep: null, archived: false,
  },
  hitl: {
    id: "q1", workspaceId: DEFAULT_WORKSPACE, runId: "r1", kind: "diff", title: "Review",
    why: "", risk: "medium", raisedAt: 0, expiresAt: null, resolvedAt: null, resolution: null,
    command: null, options: null, recommended: null, steps: null, diff: null,
  },
});

describe("project runner-key confinement (post-assignment picking)", () => {
  it("skips triage rather than triaging on a disallowed-key idle runner", async () => {
    const store = new MemoryStore({ seed: false });
    await seedPickingWithClaudeBusy(store);
    const provider = new ConsultingProvider();
    const orch = new Orchestrator(store, new Hub(store, new NullBus()), provider);
    await orch.tickAutonomy();
    expect((await store.getTask("t1"))?.state).toBe("backlog"); // never triaged
    expect(provider.consulted).toBe(0);
    expect((await store.getAgent("r-gemini"))?.status).toBe("idle"); // never touched
  });

  it("skips periodic auto-review rather than reviewing on a disallowed-key idle runner", async () => {
    const store = new MemoryStore({ seed: false });
    await seedPickingWithClaudeBusy(store, { state: "review", runId: "r1" });
    const { run, hitl } = mkReviewFixture();
    await store.putRun(run);
    await store.putHitl(hitl);
    const provider = new ConsultingProvider();
    const orch = new Orchestrator(store, new Hub(store, new NullBus()), provider);
    await orch.tickAutonomy();
    expect((await store.getTask("t1"))?.reviewVerdict).toBeFalsy();
    expect((await store.getTask("t1"))?.state).toBe("review"); // left for a human
    expect(provider.consulted).toBe(0);
    expect((await store.getHitl("q1"))?.resolvedAt).toBeNull();
  });

  it("requestReview (manual) refuses when the only idle runner is on a disallowed key", async () => {
    const store = new MemoryStore({ seed: false });
    await seedPickingWithClaudeBusy(store, { state: "review", runId: "r1" });
    const { run, hitl } = mkReviewFixture();
    await store.putRun(run);
    await store.putHitl(hitl);
    const orch = build(store);
    await expect(orch.requestReview(DEFAULT_WORKSPACE, "t1")).rejects.toThrow(NoReviewerAvailableError);
    expect((await store.getTask("t1"))?.reviewVerdict).toBeFalsy();
  });
});

describe("project runner-key confinement (assignment gating)", () => {
  it("assigns only onto a runner whose key is enabled for the project", async () => {
    const store = new MemoryStore({ seed: false });
    await seed(store, ["claude"]); // project may only run on the claude key
    const run = await build(store).assignTask("p1", "t1");
    expect(run.provider).toBe("claude");
    // The gemini runner was skipped even though it was idle & usable.
    expect((await store.getAgent("r-gemini"))?.status).toBe("idle");
    expect((await store.getAgent("r-claude"))?.status).toBe("busy");
  });

  it("refuses assignment when no idle runner is on an enabled key", async () => {
    const store = new MemoryStore({ seed: false });
    await seed(store, ["codex"]); // neither runner is on the codex key
    await expect(build(store).assignTask("p1", "t1")).rejects.toThrow(/provider key enabled for this project/);
    // Nothing was acquired — both runners stay idle.
    expect((await store.listAgents(DEFAULT_WORKSPACE)).every((r) => r.status === "idle")).toBe(true);
  });

  it("an empty allowlist means any key (unchanged behavior)", async () => {
    const store = new MemoryStore({ seed: false });
    await seed(store, []); // no confinement
    const run = await build(store).assignTask("p1", "t1");
    // Falls to the first idle runner in fleet order (the claude one).
    expect(run.provider).toBe("claude");
  });
});
