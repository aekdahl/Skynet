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
  tasks: [{ id: "t1", text: "login bug", state: "backlog", projectId: "p1" }],
  fleet: [],
  providers: [],
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

// ── Execution parity: confirm → the SAME Operations method the board calls ──
function makeControl(consult: () => Promise<string | null>) {
  const transitionTask = vi.fn(async () => ({}) as never);
  const updateProject = vi.fn(async () => ({}) as never);
  const notes: string[] = [];
  const operations = {
    listHitl: async () => [],
    listRuns: async () => [],
    listProjects: async () => [{ id: "p1", name: "Web" }],
    listTasks: async () => [{ id: "t1", text: "login bug", state: "backlog", projectId: "p1", archived: false }],
    listAgents: async () => [],
    listProviders: async () => [],
    resolveHitl: vi.fn(),
    createTask: vi.fn(),
    assignTask: vi.fn(),
    archiveTask: vi.fn(),
    createProject: vi.fn(),
    configureRunner: vi.fn(),
    transitionTask,
    updateProject,
    updateTask: vi.fn(),
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
  return { handle, transitionTask, updateProject, notes };
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
