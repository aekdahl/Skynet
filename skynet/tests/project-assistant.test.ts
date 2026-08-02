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
  agents: [
    { id: "a-1", name: "Ada" },
    { id: "a-2", name: "Babbage" },
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

  it("set_assignment — `any` opens the task to any agent (no agentIds)", () => {
    const a = validateProjectAction({ kind: "set_assignment", taskId: "t-2", mode: "any" }, ctx);
    expect(a).toMatchObject({ kind: "set_assignment", taskId: "t-2", mode: "any", agentIds: [] });
    expect(a?.summary).toMatch(/any agent/i);
  });

  it("set_assignment — `agents` pins only to KNOWN fleet ids", () => {
    const a = validateProjectAction({ kind: "set_assignment", taskId: "t-1", mode: "agents", agentIds: ["a-1", "a-2"] }, ctx);
    expect(a).toMatchObject({ kind: "set_assignment", taskId: "t-1", mode: "agents", agentIds: ["a-1", "a-2"] });
    // Summary shows names, not ids, so the confirm chip is legible.
    expect(a?.summary).toContain("Ada");
    expect(a?.summary).toContain("Babbage");
    // Unknown agents are dropped; if none remain the action is refused (no guessing).
    expect(validateProjectAction({ kind: "set_assignment", taskId: "t-1", mode: "agents", agentIds: ["a-1", "ghost"] }, ctx)).toMatchObject({ agentIds: ["a-1"] });
    expect(validateProjectAction({ kind: "set_assignment", taskId: "t-1", mode: "agents", agentIds: ["ghost"] }, ctx)).toBeNull();
    expect(validateProjectAction({ kind: "set_assignment", taskId: "t-1", mode: "agents", agentIds: [] }, ctx)).toBeNull();
  });

  it("set_assignment — `unassigned` clears eligibility, bogus mode / task rejected", () => {
    expect(validateProjectAction({ kind: "set_assignment", taskId: "t-2", mode: "unassigned" }, ctx)).toMatchObject({ kind: "set_assignment", mode: "unassigned", agentIds: [] });
    expect(validateProjectAction({ kind: "set_assignment", taskId: "t-2", mode: "everyone" }, ctx)).toBeNull();
    expect(validateProjectAction({ kind: "set_assignment", taskId: "ghost", mode: "any" }, ctx)).toBeNull();
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
    expect(r.actions).toEqual([]);
    expect(r.reply).toBe(raw);
  });
});

// A single proposal still yields a one-item batch (back-compat: `action` = first).
describe("splitProposedAction — batches (add many, approve once)", () => {
  it("a single proposeAction is a one-item batch", () => {
    const r = splitProposedAction('Adding it.\n{"proposeAction":{"kind":"add_task","text":"write docs"}}', ctx);
    expect(r.actions).toHaveLength(1);
    expect(r.action).toMatchObject({ kind: "add_task", text: "write docs" });
    expect(r.reply).toBe("Adding it.");
  });

  it("proposeActions returns ALL valid actions in order", () => {
    const raw =
      'Adding those.\n{"proposeActions":[' +
      '{"kind":"add_task","text":"cache the dashboard"},' +
      '{"kind":"add_task","text":"rate-limit the API"},' +
      '{"kind":"move_task","taskId":"t-2","to":"triage"}]}';
    const r = splitProposedAction(raw, ctx);
    expect(r.actions.map((a) => a.kind)).toEqual(["add_task", "add_task", "move_task"]);
    expect(r.action).toMatchObject({ kind: "add_task", text: "cache the dashboard" });
    expect(r.reply).toBe("Adding those.");
  });

  it("drops invalid items from a batch (never guesses), keeps the valid ones", () => {
    const raw =
      '{"proposeActions":[' +
      '{"kind":"add_task","text":"good one"},' +
      '{"kind":"move_task","taskId":"t-nope","to":"done"},' + // unknown task → dropped
      '{"kind":"add_task","text":"  "}]}'; // empty text → dropped
    const r = splitProposedAction(raw, ctx);
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]).toMatchObject({ kind: "add_task", text: "good one" });
  });

  it("synthesizes a batch reply when the model sent only the actions", () => {
    const raw = '{"proposeActions":[{"kind":"add_task","text":"a"},{"kind":"add_task","text":"b"}]}';
    const r = splitProposedAction(raw, ctx);
    expect(r.reply).toMatch(/these 2 changes/i);
  });
});
