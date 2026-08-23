// Brain-parity: Telegram's conversational assistant gains the in-app Steward's
// project-management actions (move/rename/describe tasks; rename/goal/autonomy/
// status projects), validated against the grounding context the same way and
// executed through the SAME Operations methods the board uses. Validation is
// PURE; execution goes through createOwnerControl's confirm state machine.
import { describe, it, expect, vi } from "vitest";
import { validateAction, type IntentContext } from "../apps/server/src/telegram/intent.js";
import { createOwnerControl, type ControlOps, type ControlOrch } from "../apps/server/src/telegram/index.js";

const OWNER = "111";

const ctx: IntentContext = {
  gates: [],
  projects: [{ id: "p1", name: "Web" }],
  tasks: [
    { id: "t1", text: "login bug", state: "backlog", projectId: "p1" },
    { id: "t2", text: "signup bug", state: "backlog", projectId: "p1" },
  ],
  fleet: [],
  providers: [],
  features: [{ id: "f1", name: "Auth", projectId: "p1", milestoneId: null }],
  milestones: [],
};

describe("validateAction — project actions", () => {
  it("move_task: accepts a known task + lane, resolves projectId from the task", () => {
    expect(validateAction({ action: "move_task", taskId: "t1", state: "todo" }, ctx)).toEqual({
      kind: "move_task",
      taskId: "t1",
      projectId: "p1",
      state: "todo",
    });
  });
  it("move_task: rejects an unknown lane or unknown task (contained, never guesses)", () => {
    expect(validateAction({ action: "move_task", taskId: "t1", state: "nowhere" }, ctx)?.kind).toBe("none");
    expect(validateAction({ action: "move_task", taskId: "t9", state: "todo" }, ctx)?.kind).toBe("none");
  });
  it("rename_task: requires a non-empty new title", () => {
    expect(validateAction({ action: "rename_task", taskId: "t1", newText: "fix login" }, ctx)).toMatchObject({
      kind: "rename_task", taskId: "t1", newText: "fix login",
    });
    expect(validateAction({ action: "rename_task", taskId: "t1", newText: "  " }, ctx)?.kind).toBe("none");
  });
  it("set_task_desc: allows an empty string (clears the description)", () => {
    expect(validateAction({ action: "set_task_desc", taskId: "t1", description: "" }, ctx)).toMatchObject({
      kind: "set_task_desc", taskId: "t1", description: "",
    });
  });
  it("rename_project / set_goal: known project required", () => {
    expect(validateAction({ action: "rename_project", projectId: "p1", projectName: "Website" }, ctx)).toMatchObject({
      kind: "rename_project", projectId: "p1", projectName: "Website",
    });
    expect(validateAction({ action: "set_goal", projectId: "p9", projectGoal: "x" }, ctx)?.kind).toBe("none");
  });
  it("set_autonomy: requires a boolean", () => {
    expect(validateAction({ action: "set_autonomy", projectId: "p1", autonomy: false }, ctx)).toEqual({
      kind: "set_autonomy", projectId: "p1", autonomy: false,
    });
    expect(validateAction({ action: "set_autonomy", projectId: "p1", autonomy: "yes" }, ctx)?.kind).toBe("none");
  });
  it("set_status: only a known status", () => {
    expect(validateAction({ action: "set_status", projectId: "p1", projectStatus: "paused" }, ctx)).toMatchObject({
      kind: "set_status", projectStatus: "paused",
    });
    expect(validateAction({ action: "set_status", projectId: "p1", projectStatus: "banana" }, ctx)?.kind).toBe("none");
  });
});

describe("validateAction — execution intents (S10/S11)", () => {
  it("start_task: resolves a known task, projectId from the task", () => {
    expect(validateAction({ action: "start_task", taskId: "t1" }, ctx)).toEqual({
      kind: "start_task", taskId: "t1", projectId: "p1",
    });
    expect(validateAction({ action: "start_task", taskId: "nope" }, ctx)?.kind).toBe("none");
  });
  it("queue_tasks: every id must resolve and share one project", () => {
    expect(validateAction({ action: "queue_tasks", taskIds: ["t1", "t2"] }, ctx)).toEqual({
      kind: "queue_tasks", taskIds: ["t1", "t2"], projectId: "p1",
    });
    expect(validateAction({ action: "queue_tasks", taskIds: ["t1", "nope"] }, ctx)?.kind).toBe("none");
    expect(validateAction({ action: "queue_tasks", taskIds: [] }, ctx)?.kind).toBe("none");
  });
  it("start_feature: resolves a known feature + execMode, defaults feasibleOnly true", () => {
    expect(validateAction({ action: "start_feature", featureId: "f1", execMode: "start_now" }, ctx)).toEqual({
      kind: "start_feature", featureId: "f1", projectId: "p1", execMode: "start_now", feasibleOnly: true,
    });
    expect(validateAction({ action: "start_feature", featureId: "nope", execMode: "queue" }, ctx)?.kind).toBe("none");
    expect(validateAction({ action: "start_feature", featureId: "f1", execMode: "sideways" }, ctx)?.kind).toBe("none");
  });
  it("process_backlog: known project required, feasibleOnly defaults true", () => {
    expect(validateAction({ action: "process_backlog", projectId: "p1" }, ctx)).toEqual({
      kind: "process_backlog", projectId: "p1", feasibleOnly: true,
    });
    expect(validateAction({ action: "process_backlog", projectId: "p1", feasibleOnly: false }, ctx)).toMatchObject({ feasibleOnly: false });
    expect(validateAction({ action: "process_backlog", projectId: "nope" }, ctx)?.kind).toBe("none");
  });
});

// ── Execution parity: confirm → the SAME Operations method the board calls ──
function makeControl(consult: () => Promise<string | null>, opts: { executeStewardAction?: ReturnType<typeof vi.fn> } = {}) {
  const transitionTask = vi.fn(async () => ({}) as never);
  const updateProject = vi.fn(async () => ({}) as never);
  const executeStewardAction = opts.executeStewardAction ?? vi.fn();
  const notes: string[] = [];
  const operations = {
    listHitl: async () => [],
    listRuns: async () => [],
    listProjects: async () => [{ id: "p1", name: "Web" }],
    listTasks: async () => [
      { id: "t1", text: "login bug", state: "backlog", projectId: "p1", archived: false },
      { id: "t2", text: "signup bug", state: "backlog", projectId: "p1", archived: false },
    ],
    listAgents: async () => [],
    listProviders: async () => [],
    listFeatures: async () => [{ id: "f1", name: "Auth", projectId: "p1" }],
    listMilestones: async () => [],
    resolveHitl: vi.fn(),
    createTask: vi.fn(),
    assignTask: vi.fn(),
    archiveTask: vi.fn(),
    createProject: vi.fn(),
    configureRunner: vi.fn(),
    transitionTask,
    updateProject,
    updateTask: vi.fn(),
    executeStewardAction,
  } as unknown as ControlOps;
  const orchestrator = { consult: vi.fn(consult), stopAll: vi.fn(), setPaused: vi.fn(), isPaused: () => false } as unknown as ControlOrch;
  const { handle } = createOwnerControl({
    controlEnabled: true,
    ownerChatId: OWNER,
    operations,
    orchestrator,
    notify: async (t) => { notes.push(t); return { messageId: 1 }; },
    onQuit: () => undefined,
  });
  return { handle, transitionTask, updateProject, executeStewardAction, notes };
}

describe("project actions — propose then execute on confirm", () => {
  it("move_task: confirmed → operations.transitionTask(ws, taskId, lane, operator)", async () => {
    const c = makeControl(async () =>
      JSON.stringify({ reply: "Moving it.", action: { action: "move_task", taskId: "t1", state: "todo" } }),
    );
    await c.handle(OWNER, "move the login task to todo"); // proposes
    expect(c.transitionTask).not.toHaveBeenCalled(); // nothing runs before confirm
    expect(c.notes.at(-1)).toMatch(/reply yes \/ no/i);
    await c.handle(OWNER, "yes"); // confirm
    expect(c.transitionTask).toHaveBeenCalledTimes(1);
    expect(c.transitionTask.mock.calls[0]?.slice(1, 3)).toEqual(["t1", "todo"]);
  });

  it("set_autonomy: confirmed → operations.updateProject(ws, id, { autonomy })", async () => {
    const c = makeControl(async () =>
      JSON.stringify({ reply: "Turning it off.", action: { action: "set_autonomy", projectId: "p1", autonomy: false } }),
    );
    await c.handle(OWNER, "turn off autonomy for Web");
    await c.handle(OWNER, "yes");
    expect(c.updateProject).toHaveBeenCalledTimes(1);
    expect(c.updateProject.mock.calls[0]?.[2]).toEqual({ autonomy: false });
  });
});

// ── Execution intents (S10/S11): the SAME one-pending-action machine, but the
// three composites dry-run BEFORE the confirm message is even sent — the
// pending text IS the preview, not a blind "sure?". ──────────────────────────
describe("execution intents — dry-run preview, then confirm executes", () => {
  it("start_feature: dry-runs BEFORE the pending message is sent, the confirm text carries the preview, and confirming executes for real (dryRun undefined)", async () => {
    const outcome = vi.fn(async (_ws: string, _projectId: string, _action: unknown, _operatorId: string, opts?: { dryRun?: boolean }) =>
      opts?.dryRun
        ? { started: [], queued: ["t1", "t2"], excluded: [], autonomyEnabled: true, estimatedCostUsd: 4, dryRun: true }
        : { started: [], queued: ["t1", "t2"], excluded: [], autonomyEnabled: true, estimatedCostUsd: 4, dryRun: false },
    );
    const c = makeControl(
      async () => JSON.stringify({ reply: "On it.", action: { action: "start_feature", featureId: "f1", execMode: "queue" } }),
      { executeStewardAction: outcome },
    );

    await c.handle(OWNER, "build feature Auth"); // proposes — dry-run must already have happened
    expect(outcome).toHaveBeenCalledTimes(1);
    expect(outcome.mock.calls[0]?.[4]).toEqual({ dryRun: true }); // the FIRST call is the preview, not the real thing
    // The confirm message shown to the owner carries the real dry-run numbers.
    const pendingMsg = c.notes.at(-1)!;
    expect(pendingMsg).toContain("2 queued");
    expect(pendingMsg).toContain("~$4.00");
    expect(pendingMsg).toMatch(/autonomy on/);

    await c.handle(OWNER, "yes"); // confirm
    expect(outcome).toHaveBeenCalledTimes(2);
    expect(outcome.mock.calls[1]?.[4]).toBeUndefined(); // the SECOND call is the real execute — no dryRun
    expect(c.notes.at(-1)).toMatch(/2 queued/); // the success line reports the real outcome
  });

  it("start_feature: excluded reasons show up in the preview text", async () => {
    const outcome = vi.fn(async () => ({
      started: [], queued: ["t1"], excluded: [{ taskId: "t2", reason: "over-budget" as const }],
      autonomyEnabled: false, estimatedCostUsd: 2, dryRun: true,
    }));
    const c = makeControl(
      async () => JSON.stringify({ reply: "On it.", action: { action: "start_feature", featureId: "f1", execMode: "start_now" } }),
      { executeStewardAction: outcome },
    );
    await c.handle(OWNER, "start feature Auth now");
    expect(c.notes.at(-1)).toContain("over today's budget");
  });

  it("a non-affirmative reply cancels a previewed composite without ever calling executeStewardAction a second (real) time", async () => {
    const outcome = vi.fn(async () => ({ started: [], queued: ["t1"], excluded: [], autonomyEnabled: false, estimatedCostUsd: 2, dryRun: true }));
    const c = makeControl(
      async () => JSON.stringify({ reply: "On it.", action: { action: "process_backlog", projectId: "p1" } }),
      { executeStewardAction: outcome },
    );
    await c.handle(OWNER, "process the backlog");
    expect(outcome).toHaveBeenCalledTimes(1); // the preview only
    await c.handle(OWNER, "no");
    expect(outcome).toHaveBeenCalledTimes(1); // still just the preview — never confirmed
  });

  it("start_task never dry-runs — it's a direct single-task start, same as the dock", async () => {
    const outcome = vi.fn(async () => ({ started: ["t1"], queued: [], excluded: [], autonomyEnabled: false, estimatedCostUsd: 2, dryRun: false }));
    const c = makeControl(
      async () => JSON.stringify({ reply: "Starting it.", action: { action: "start_task", taskId: "t1" } }),
      { executeStewardAction: outcome },
    );
    await c.handle(OWNER, "start the login bug now"); // proposes — no preview call
    expect(outcome).not.toHaveBeenCalled();
    await c.handle(OWNER, "yes");
    expect(outcome).toHaveBeenCalledTimes(1);
    expect(outcome.mock.calls[0]?.[4]).toBeUndefined();
  });
});
