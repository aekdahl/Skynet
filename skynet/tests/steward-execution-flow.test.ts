// S11 acceptance-style test: the FULL propose → dry-run preview → confirm →
// execute loop, end to end, against real server pieces — no live LLM call.
// "Message → proposal" is exercised at the same seam tests/project-
// assistant.test.ts already uses (splitProposedAction on hand-built raw model
// text — the established, deterministic way this codebase tests "does a
// model's reply text produce the right action" without needing a live
// credential); "confirm → execute" runs through a REAL Operations +
// Orchestrator + MemoryStore, same harness as tests/execution-intents.test.ts.
import { describe, it, expect } from "vitest";
import type { Agent, Feature, Project, ProviderId, ServerEvent, Task, TaskRun } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { splitProposedAction, type ProjectActionContext } from "../apps/server/src/steward/assistant.js";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { Operations } from "../apps/server/src/operations.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

class NullBus implements Bus {
  publish(_ws: string, _e: ServerEvent): void {}
  subscribe(): () => void {
    return () => {};
  }
}
class AutoProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  async start(spec: StartSpec, _e: RunnerEvents): Promise<RunnerHandle> {
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

const mkProject = (over: Partial<Project> = {}): Project =>
  ({
    id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [],
    status: "active", autonomy: true, dailyBudgetUsd: null, budgetPacing: false,
    repoPath: null, gitBacked: false,
    ...over,
  } as Project);
const mkTask = (over: Partial<Task> = {}): Task =>
  ({
    id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "task", state: "todo",
    runId: null, autoPick: false, assignment: { mode: "unassigned", agentIds: [] },
    assessmentEffort: null, order: 0, archived: false, featureId: null,
    ...over,
  } as Task);
const mkFeature = (over: Partial<Feature> = {}): Feature =>
  ({
    id: "f1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", name: "Auth", description: null,
    status: "active", milestoneId: null, archived: false, createdAt: 1, pr: null,
    ...over,
  } as Feature);
const mkAgent = (over: Partial<Agent> = {}): Agent =>
  ({ id: "a1", workspaceId: DEFAULT_WORKSPACE, name: "a1", provider: "claude", model: "sonnet-5", status: "idle", idleSince: 0, ...over } as Agent);

function setup() {
  const store = new MemoryStore({ seed: false });
  const hub = new Hub(store, new NullBus());
  const orch = new Orchestrator(store, hub, new AutoProvider());
  const ops = new Operations({ store, hub, orchestrator: orch });
  return { store, ops };
}

describe("Steward surfaces (S11): propose → dry-run preview → confirm → execute", () => {
  it('a "complete build for feature X" reply yields exactly ONE start_feature proposal — never decomposed into N start_task chips', () => {
    const ctx: ProjectActionContext = {
      project: { id: "p1", name: "Web" },
      autonomy: true,
      tasks: [
        { id: "t1", text: "login flow", state: "todo" },
        { id: "t2", text: "signup flow", state: "todo" },
        { id: "t3", text: "password reset", state: "todo" },
      ],
      features: [{ id: "f1", name: "Auth" }],
    };
    // What a well-behaved model returns for a bulk request — one composite,
    // not one start_task per task (the SYSTEM prompt's explicit instruction).
    const raw = 'Building the Auth feature now.\n{"proposeActions":[{"kind":"start_feature","featureId":"f1","execMode":"start_now"}]}';
    const { reply, actions } = splitProposedAction(raw, ctx);
    expect(reply).toBe("Building the Auth feature now.");
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: "start_feature", featureId: "f1", execMode: "start_now", feasibleOnly: true });
  });

  it('a malformed "one start_task per task" reply from a non-compliant model is validated as N separate proposals — proves the SYSTEM prompt instruction is the only thing preventing this, not the validator', () => {
    // Documents the contrast: the validator itself doesn't refuse N start_task
    // actions in one batch (that's not its job — see validateProjectAction's
    // PURE per-item contract) — it's SYSTEM's instruction that steers a
    // compliant model toward the single composite tested above.
    const ctx: ProjectActionContext = {
      project: { id: "p1", name: "Web" },
      tasks: [{ id: "t1", text: "login flow", state: "todo" }, { id: "t2", text: "signup flow", state: "todo" }],
    };
    const raw = '{"proposeActions":[{"kind":"start_task","taskId":"t1"},{"kind":"start_task","taskId":"t2"}]}';
    const { actions } = splitProposedAction(raw, ctx);
    expect(actions).toHaveLength(2);
  });

  it("dry-run preview (via the resolved start_feature action) renders excluded reasons; confirming queues the tasks — real store state, not a mock", async () => {
    const { store, ops } = setup();
    await store.putProject(mkProject({ autonomy: false })); // also proves the autonomy fold-in end to end
    await store.putFeature(mkFeature());
    await store.putTask(mkTask({ id: "t1", featureId: "f1", state: "todo", order: 0, assessmentEffort: "small", assignment: { mode: "any", agentIds: [] } }));
    await store.putTask(mkTask({ id: "t2", featureId: "f1", state: "triage", order: 1 })); // not yet triaged clear → excluded

    const ctx: ProjectActionContext = {
      project: { id: "p1", name: "Web" },
      autonomy: false,
      tasks: [{ id: "t1", text: "login flow", state: "todo" }, { id: "t2", text: "signup flow", state: "triage" }],
      features: [{ id: "f1", name: "Auth" }],
    };
    const raw = 'Queuing what\'s ready.\n{"proposeActions":[{"kind":"start_feature","featureId":"f1","execMode":"queue"}]}';
    const { actions } = splitProposedAction(raw, ctx);
    expect(actions).toHaveLength(1);
    const proposed = actions[0]!;
    expect(proposed.kind).toBe("start_feature");

    // The dry-run preview — what the dock/Telegram show BEFORE confirm.
    const preview = await ops.executeStewardAction(
      DEFAULT_WORKSPACE, "p1",
      { kind: "start_feature", featureId: proposed.featureId!, execMode: proposed.execMode!, feasibleOnly: proposed.feasibleOnly! },
      "op1",
      { dryRun: true },
    );
    expect(preview.dryRun).toBe(true);
    expect(preview.queued).toEqual(["t1"]);
    expect(preview.excluded).toEqual([{ taskId: "t2", reason: "unclear" }]);
    expect(preview.autonomyEnabled).toBe(true); // reported, not yet applied
    expect((await store.getProject("p1"))?.autonomy).toBe(false); // dry-run — untouched

    // Confirm — the real execute call, same action shape.
    const outcome = await ops.executeStewardAction(
      DEFAULT_WORKSPACE, "p1",
      { kind: "start_feature", featureId: proposed.featureId!, execMode: proposed.execMode!, feasibleOnly: proposed.feasibleOnly! },
      "op1",
    );
    expect(outcome.queued).toEqual(["t1"]);

    const queued = await store.getTask("t1");
    expect(queued?.state).toBe("todo");
    expect(queued?.autoPick).toBe(true);
    const stillTriage = await store.getTask("t2");
    expect(stillTriage?.state).toBe("triage"); // excluded task genuinely untouched
    expect((await store.getProject("p1"))?.autonomy).toBe(true); // folded on for real this time
  });

  it("re-confirming after the fact is a no-op — the queued task now shows as already-running once started, never double-queued", async () => {
    const { store, ops } = setup();
    await store.putProject(mkProject());
    await store.putAgent(mkAgent());
    await store.putFeature(mkFeature());
    await store.putTask(mkTask({ id: "t1", featureId: "f1", state: "todo", assignment: { mode: "any", agentIds: [] } }));

    const action = { kind: "start_feature" as const, featureId: "f1", execMode: "start_now" as const, feasibleOnly: true };
    const first = await ops.executeStewardAction(DEFAULT_WORKSPACE, "p1", action, "op1");
    expect(first.started).toEqual(["t1"]);

    const second = await ops.executeStewardAction(DEFAULT_WORKSPACE, "p1", action, "op1");
    expect(second.started).toEqual([]);
    expect(second.excluded).toEqual([{ taskId: "t1", reason: "already-running" }]);
  });
});
