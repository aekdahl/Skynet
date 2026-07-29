// The in-app project assistant can now propose a project/task action (confirm-
// first). The model appends a final-line {"proposeAction": <action>} only when the
// operator clearly asks to change something; splitProposedAction peels it off the
// shown reply and validates it against THIS project's tasks — so a misparse or an
// injected instruction can never touch a task outside the project. These are the
// pure guarantees the UI's confirm chip relies on.
import { describe, it, expect } from "vitest";
import {
  splitProposedAction,
  validateProjectAction,
  type ProjectActionContext,
} from "../apps/server/src/project-assistant.js";

const ctx: ProjectActionContext = {
  project: { id: "p-1", name: "Takeoff" },
  tasks: [
    { id: "t-1", text: "fix login redirect", state: "review" },
    { id: "t-2", text: "add metrics", state: "backlog" },
  ],
};

describe("validateProjectAction — whitelist + project-scoped id resolution", () => {
  it("add_task needs non-empty text", () => {
    expect(validateProjectAction({ kind: "add_task", text: "write docs" }, ctx)).toMatchObject({
      kind: "add_task",
      text: "write docs",
    });
    expect(validateProjectAction({ kind: "add_task", text: "  " }, ctx)).toBeNull();
  });

  it("add_task carries an optional description", () => {
    expect(
      validateProjectAction({ kind: "add_task", text: "write docs", description: "cover the API" }, ctx),
    ).toMatchObject({ kind: "add_task", text: "write docs", description: "cover the API" });
    // description is optional — omitted stays undefined
    expect(validateProjectAction({ kind: "add_task", text: "write docs" }, ctx).description).toBeUndefined();
  });

  it("move_task resolves the task id and validates the target state", () => {
    expect(validateProjectAction({ kind: "move_task", taskId: "t-1", to: "done" }, ctx)).toMatchObject({
      kind: "move_task",
      taskId: "t-1",
      to: "done",
    });
    // unknown task id → never touches anything
    expect(validateProjectAction({ kind: "move_task", taskId: "t-999", to: "done" }, ctx)).toBeNull();
    // bogus state
    expect(validateProjectAction({ kind: "move_task", taskId: "t-1", to: "shipped" }, ctx)).toBeNull();
  });

  it("rename_task / set_task_desc / reorder_task require a known task", () => {
    expect(validateProjectAction({ kind: "rename_task", taskId: "t-2", text: "add Prometheus metrics" }, ctx)).toMatchObject({ kind: "rename_task", taskId: "t-2" });
    expect(validateProjectAction({ kind: "set_task_desc", taskId: "t-1", description: "302 loop on Safari" }, ctx)).toMatchObject({ kind: "set_task_desc", taskId: "t-1" });
    expect(validateProjectAction({ kind: "reorder_task", taskId: "t-2", direction: "up" }, ctx)).toMatchObject({ kind: "reorder_task", direction: "up" });
    expect(validateProjectAction({ kind: "reorder_task", taskId: "t-2", direction: "sideways" }, ctx)).toBeNull();
    expect(validateProjectAction({ kind: "rename_task", taskId: "nope", text: "x" }, ctx)).toBeNull();
  });

  it("remove_task resolves the id", () => {
    expect(validateProjectAction({ kind: "remove_task", taskId: "t-1" }, ctx)).toMatchObject({ kind: "remove_task", taskId: "t-1" });
    expect(validateProjectAction({ kind: "remove_task", taskId: "ghost" }, ctx)).toBeNull();
  });

  it("archive_task resolves the id (soft-hide, recoverable)", () => {
    const a = validateProjectAction({ kind: "archive_task", taskId: "t-1" }, ctx);
    expect(a).toMatchObject({ kind: "archive_task", taskId: "t-1" });
    // Chip label distinguishes it from a hard delete so the operator can tell what will happen.
    expect(a?.summary).toMatch(/archive/i);
    expect(a?.summary).toContain("fix login redirect");
    expect(validateProjectAction({ kind: "archive_task", taskId: "ghost" }, ctx)).toBeNull();
  });

  it("project edits validate their fields", () => {
    expect(validateProjectAction({ kind: "rename_project", name: "Liftoff" }, ctx)).toMatchObject({ kind: "rename_project", name: "Liftoff" });
    expect(validateProjectAction({ kind: "set_goal", goal: "ship v1" }, ctx)).toMatchObject({ kind: "set_goal", goal: "ship v1" });
    expect(validateProjectAction({ kind: "set_autonomy", autonomy: false }, ctx)).toMatchObject({ kind: "set_autonomy", autonomy: false });
    expect(validateProjectAction({ kind: "set_autonomy", autonomy: "off" }, ctx)).toBeNull(); // not a boolean
    expect(validateProjectAction({ kind: "set_status", status: "paused" }, ctx)).toMatchObject({ kind: "set_status", status: "paused" });
    expect(validateProjectAction({ kind: "set_status", status: "frozen" }, ctx)).toBeNull();
  });

  it("every validated action carries a human summary for the confirm chip", () => {
    const a = validateProjectAction({ kind: "move_task", taskId: "t-1", to: "done" }, ctx);
    expect(a?.summary).toContain("fix login redirect");
    expect(a?.summary.length).toBeGreaterThan(0);
  });

  it("rejects unknown kinds", () => {
    expect(validateProjectAction({ kind: "delete_project" }, ctx)).toBeNull();
    expect(validateProjectAction({}, ctx)).toBeNull();
    expect(validateProjectAction(null, ctx)).toBeNull();
  });
});

describe("splitProposedAction — reply/action split", () => {
  it("returns the whole text as reply when there is no proposal", () => {
    const r = splitProposedAction("The roadmap has 3 open items: A, B, C.", ctx);
    expect(r.action).toBeNull();
    expect(r.reply).toBe("The roadmap has 3 open items: A, B, C.");
  });

  it("splits a trailing proposeAction off the reply and validates it", () => {
    const raw = 'Sure — moving that to done.\n{"proposeAction":{"kind":"move_task","taskId":"t-1","to":"done"}}';
    const r = splitProposedAction(raw, ctx);
    expect(r.reply).toBe("Sure — moving that to done.");
    expect(r.action).toMatchObject({ kind: "move_task", taskId: "t-1", to: "done" });
  });

  it("tolerates a code-fenced JSON tail", () => {
    const raw = 'Will do.\n```json\n{"proposeAction":{"kind":"add_task","text":"write onboarding docs"}}\n```';
    const r = splitProposedAction(raw, ctx);
    expect(r.reply).toBe("Will do.");
    expect(r.action).toMatchObject({ kind: "add_task", text: "write onboarding docs" });
  });

  it("drops an invalid proposed action but keeps the reply", () => {
    const raw = 'On it.\n{"proposeAction":{"kind":"move_task","taskId":"t-999","to":"done"}}';
    const r = splitProposedAction(raw, ctx);
    expect(r.reply).toBe("On it.");
    expect(r.action).toBeNull(); // unknown task id never escalates
  });

  it("supplies a fallback reply when the model sent only the action", () => {
    const r = splitProposedAction('{"proposeAction":{"kind":"add_task","text":"x"}}', ctx);
    expect(r.action).toMatchObject({ kind: "add_task" });
    expect(r.reply.length).toBeGreaterThan(0); // never an empty bubble
  });

  it("does not mistake a JSON object in prose for a proposal", () => {
    const raw = 'The config looks like {"port": 8080} in the file.';
    const r = splitProposedAction(raw, ctx);
    expect(r.action).toBeNull();
    expect(r.reply).toBe(raw);
  });
});
