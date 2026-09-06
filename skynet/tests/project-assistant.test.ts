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
  MAX_STEWARD_ACTIONS,
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
  features: [{ id: "f-1", name: "Checkout" }],
  milestones: [{ id: "m-1", name: "Public beta" }],
  gates: [
    { id: "g-1", kind: "approval", title: "Deploy to prod", risk: "high", options: null },
    { id: "g-2", kind: "question", title: "Which DB?", risk: "low", options: ["Postgres", "MySQL"] },
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

  it("request_review resolves the id — forces a fresh review pass, not the same as archive/remove", () => {
    const a = validateProjectAction({ kind: "request_review", taskId: "t-1" }, ctx);
    expect(a).toMatchObject({ kind: "request_review", taskId: "t-1" });
    expect(a?.summary).toMatch(/review/i);
    expect(a?.summary).toContain("fix login redirect");
    expect(validateProjectAction({ kind: "request_review", taskId: "ghost" }, ctx)).toBeNull();
  });

  it("resync_source needs no fields — the whole project is the target", () => {
    const a = validateProjectAction({ kind: "resync_source" }, ctx);
    expect(a).toMatchObject({ kind: "resync_source" });
    expect(a?.summary).toMatch(/re-sync/i);
    expect(a?.summary).toContain("Takeoff"); // ctx.project.name
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

  it("add_feature — name required; optional milestone must be known", () => {
    expect(validateProjectAction({ kind: "add_feature", name: "Onboarding" }, ctx)).toMatchObject({ kind: "add_feature", name: "Onboarding" });
    expect(validateProjectAction({ kind: "add_feature", name: "  " }, ctx)).toBeNull();
    // Link to a known milestone at creation:
    expect(validateProjectAction({ kind: "add_feature", name: "Onboarding", milestoneId: "m-1" }, ctx)).toMatchObject({ kind: "add_feature", milestoneId: "m-1" });
    // An unknown milestone id is refused, not guessed.
    expect(validateProjectAction({ kind: "add_feature", name: "Onboarding", milestoneId: "m-999" }, ctx)).toBeNull();
  });

  it("add_milestone — name required; targetAt must be a number when given", () => {
    expect(validateProjectAction({ kind: "add_milestone", name: "GA" }, ctx)).toMatchObject({ kind: "add_milestone", name: "GA" });
    const dated = validateProjectAction({ kind: "add_milestone", name: "GA", targetAt: 1893456000000 }, ctx);
    expect(dated).toMatchObject({ kind: "add_milestone", targetAt: 1893456000000 });
    expect(validateProjectAction({ kind: "add_milestone", name: "GA", targetAt: "soon" }, ctx)).toBeNull();
    expect(validateProjectAction({ kind: "add_milestone", name: "" }, ctx)).toBeNull();
  });

  it("set_task_feature — links a task to a KNOWN feature (or null to unlink)", () => {
    expect(validateProjectAction({ kind: "set_task_feature", taskId: "t-1", featureId: "f-1" }, ctx)).toMatchObject({ kind: "set_task_feature", taskId: "t-1", featureId: "f-1" });
    expect(validateProjectAction({ kind: "set_task_feature", taskId: "t-1", featureId: null }, ctx)).toMatchObject({ featureId: null });
    expect(validateProjectAction({ kind: "set_task_feature", taskId: "t-1", featureId: "f-999" }, ctx)).toBeNull(); // unknown feature
    expect(validateProjectAction({ kind: "set_task_feature", taskId: "ghost", featureId: "f-1" }, ctx)).toBeNull(); // unknown task
  });

  it("set_feature_milestone — rolls a KNOWN feature into a KNOWN milestone (or null)", () => {
    expect(validateProjectAction({ kind: "set_feature_milestone", featureId: "f-1", milestoneId: "m-1" }, ctx)).toMatchObject({ kind: "set_feature_milestone", featureId: "f-1", milestoneId: "m-1" });
    expect(validateProjectAction({ kind: "set_feature_milestone", featureId: "f-1", milestoneId: null }, ctx)).toMatchObject({ milestoneId: null });
    expect(validateProjectAction({ kind: "set_feature_milestone", featureId: "f-999", milestoneId: "m-1" }, ctx)).toBeNull(); // unknown feature
    expect(validateProjectAction({ kind: "set_feature_milestone", featureId: "f-1", milestoneId: "m-999" }, ctx)).toBeNull(); // unknown milestone
  });

  it("every validated action carries a human summary for the confirm chip", () => {
    const a = validateProjectAction({ kind: "move_task", taskId: "t-1", to: "done" }, ctx);
    expect(a?.summary).toContain("fix login redirect");
    expect(a?.summary.length).toBeGreaterThan(0);
  });

  it("set_roadmap_path — points the Roadmap tab at any non-empty path, no roadmap doc required in context", () => {
    // Unlike edit_roadmap, this is the RECOVERY for ctx.roadmap being null — it
    // must validate even when no doc was found at the default candidates.
    const noRoadmapCtx: ProjectActionContext = { ...ctx, roadmap: null };
    const a = validateProjectAction({ kind: "set_roadmap_path", path: "docs/PLAN.md" }, noRoadmapCtx);
    expect(a).toMatchObject({ kind: "set_roadmap_path", path: "docs/PLAN.md" });
    expect(a?.summary).toContain("docs/PLAN.md");
    expect(validateProjectAction({ kind: "set_roadmap_path", path: "  " }, noRoadmapCtx)).toBeNull();
    expect(validateProjectAction({ kind: "set_roadmap_path" }, noRoadmapCtx)).toBeNull();
  });

  it("rejects unknown kinds", () => {
    expect(validateProjectAction({ kind: "delete_project" }, ctx)).toBeNull();
    expect(validateProjectAction({}, ctx)).toBeNull();
    expect(validateProjectAction(null, ctx)).toBeNull();
  });
});

describe("splitProposedAction — reply / multi-action split", () => {
  it("returns the whole text as reply when there is no proposal", () => {
    const r = splitProposedAction("The roadmap has 3 open items: A, B, C.", ctx);
    expect(r.actions).toEqual([]);
    expect(r.reply).toBe("The roadmap has 3 open items: A, B, C.");
  });

  it("accepts a legacy single proposeAction as a one-item list", () => {
    const raw = 'Sure — moving that to done.\n{"proposeAction":{"kind":"move_task","taskId":"t-1","to":"done"}}';
    const r = splitProposedAction(raw, ctx);
    expect(r.reply).toBe("Sure — moving that to done.");
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]).toMatchObject({ kind: "move_task", taskId: "t-1", to: "done" });
  });

  it("splits a proposeActions LIST and validates each in order", () => {
    const raw =
      'Cleaning that up.\n{"proposeActions":[{"kind":"move_task","taskId":"t-1","to":"done"},{"kind":"archive_task","taskId":"t-2"},{"kind":"add_task","text":"follow-up"}]}';
    const r = splitProposedAction(raw, ctx);
    expect(r.reply).toBe("Cleaning that up.");
    expect(r.actions.map((a) => a.kind)).toEqual(["move_task", "archive_task", "add_task"]);
  });

  it("drops invalid actions from the list but keeps the valid ones + the reply", () => {
    const raw =
      'On it.\n{"proposeActions":[{"kind":"move_task","taskId":"t-999","to":"done"},{"kind":"add_task","text":"real one"}]}';
    const r = splitProposedAction(raw, ctx);
    expect(r.reply).toBe("On it.");
    expect(r.actions).toHaveLength(1); // the unknown-task move is dropped
    expect(r.actions[0]).toMatchObject({ kind: "add_task", text: "real one" });
  });

  it("caps the batch at the action budget and reports running out", () => {
    // Relative to the budget so this keeps exercising the cap if it changes.
    const many = Array.from({ length: MAX_STEWARD_ACTIONS + 5 }, (_, i) => ({ kind: "add_task", text: `task ${i}` }));
    const raw = `Adding a lot.\n${JSON.stringify({ proposeActions: many })}`;
    const r = splitProposedAction(raw, ctx);
    expect(r.actions).toHaveLength(MAX_STEWARD_ACTIONS);
    expect(r.reply).toMatch(/ran out of action slots/i); // "report if it runs out of loops"
    expect(r.reply).toMatch(/continue/i);
  });

  it("tolerates a code-fenced JSON tail", () => {
    const raw = 'Will do.\n```json\n{"proposeActions":[{"kind":"add_task","text":"write onboarding docs"}]}\n```';
    const r = splitProposedAction(raw, ctx);
    expect(r.reply).toBe("Will do.");
    expect(r.actions[0]).toMatchObject({ kind: "add_task", text: "write onboarding docs" });
  });

  it("supplies a fallback reply when the model sent only the action(s)", () => {
    const r = splitProposedAction('{"proposeActions":[{"kind":"add_task","text":"x"}]}', ctx);
    expect(r.actions[0]).toMatchObject({ kind: "add_task" });
    expect(r.reply.length).toBeGreaterThan(0); // never an empty bubble
  });

  it("does not mistake a JSON object in prose for a proposal", () => {
    const raw = 'The config looks like {"port": 8080} in the file.';
    const r = splitProposedAction(raw, ctx);
    expect(r.actions).toEqual([]);
    expect(r.reply).toBe(raw);
  });

  it("returns no sources when the answer proposes nothing citable", () => {
    const r = splitProposedAction("The roadmap has 3 open items: A, B, C.", ctx);
    expect(r.sources).toEqual([]);
  });
});

// TASK 21 — source citations ("no claim without a chip"): a trailing
// {"sources":[...]} tag, alongside or instead of proposeActions.
describe("splitProposedAction — source citations", () => {
  it("parses a bare sources tag with no proposeActions, and strips it from the reply", () => {
    const raw = 'Run r-abc123 failed with a timeout.\n{"sources":[{"kind":"run","runId":"r-abc123"}]}';
    const r = splitProposedAction(raw, ctx);
    expect(r.reply).toBe("Run r-abc123 failed with a timeout.");
    expect(r.actions).toEqual([]);
    expect(r.sources).toEqual([{ kind: "run", runId: "r-abc123" }]);
  });

  it("parses sources alongside proposeActions in the SAME trailing object", () => {
    const raw =
      'Autonomy tripped after 3 bad runs — want me to turn it back on?\n' +
      JSON.stringify({
        proposeActions: [{ kind: "set_autonomy", autonomy: true }],
        sources: [{ kind: "breaker", projectId: "p-1" }],
      });
    const r = splitProposedAction(raw, ctx);
    expect(r.actions).toHaveLength(1);
    expect(r.sources).toEqual([{ kind: "breaker", projectId: "p-1" }]);
  });

  it("drops a source that doesn't validate (unknown kind, missing id) but keeps the rest", () => {
    const raw =
      "See below.\n" +
      JSON.stringify({
        sources: [{ kind: "commit", runId: "r-2" }, { kind: "nonsense" }, { kind: "run" }],
      });
    const r = splitProposedAction(raw, ctx);
    expect(r.sources).toEqual([{ kind: "commit", runId: "r-2" }]);
  });

  it("multiple source kinds in one citation list", () => {
    const raw =
      "Both landed.\n" +
      JSON.stringify({ sources: [{ kind: "run", runId: "r-1" }, { kind: "commit", runId: "r-1" }, { kind: "breaker", projectId: "p-9" }] });
    const r = splitProposedAction(raw, ctx);
    expect(r.sources.map((s) => s.kind)).toEqual(["run", "commit", "breaker"]);
  });
});

// S10 — execution intents. Validated the same way as every other kind (id
// resolution against ctx, refuse-don't-guess on an unknown id), but note these
// are deliberately NOT in SYSTEM's prompt text yet — see ProjectActionKind's
// doc comment in assistant.ts for why (the dock can't execute them until S11).
describe("validateProjectAction — execution intents (S10)", () => {
  it("start_task resolves a real taskId", () => {
    expect(validateProjectAction({ kind: "start_task", taskId: "t-2" }, ctx)).toMatchObject({ kind: "start_task", taskId: "t-2" });
    expect(validateProjectAction({ kind: "start_task", taskId: "nope" }, ctx)).toBeNull();
  });

  it("queue_tasks requires every id to resolve — refuses (doesn't drop) an unknown one", () => {
    expect(validateProjectAction({ kind: "queue_tasks", taskIds: ["t-1", "t-2"] }, ctx)).toMatchObject({
      kind: "queue_tasks",
      taskIds: ["t-1", "t-2"],
    });
    expect(validateProjectAction({ kind: "queue_tasks", taskIds: ["t-1", "unknown"] }, ctx)).toBeNull();
    expect(validateProjectAction({ kind: "queue_tasks", taskIds: [] }, ctx)).toBeNull();
  });

  it("queue_tasks de-dupes repeated ids", () => {
    const r = validateProjectAction({ kind: "queue_tasks", taskIds: ["t-1", "t-1"] }, ctx);
    expect(r?.taskIds).toEqual(["t-1"]);
  });

  it("start_feature resolves a real featureId + a valid execMode, defaults feasibleOnly to true", () => {
    const r = validateProjectAction({ kind: "start_feature", featureId: "f-1", execMode: "queue" }, ctx);
    expect(r).toMatchObject({ kind: "start_feature", featureId: "f-1", execMode: "queue", feasibleOnly: true });
    expect(validateProjectAction({ kind: "start_feature", featureId: "nope", execMode: "queue" }, ctx)).toBeNull();
    expect(validateProjectAction({ kind: "start_feature", featureId: "f-1", execMode: "sideways" }, ctx)).toBeNull();
  });

  it("start_feature honors an explicit feasibleOnly: false", () => {
    const r = validateProjectAction({ kind: "start_feature", featureId: "f-1", execMode: "start_now", feasibleOnly: false }, ctx);
    expect(r?.feasibleOnly).toBe(false);
  });

  it("start_feature(queue)'s summary notes the autonomy-off side effect; start_now's doesn't (nothing gets queued by start_now's assign step)", () => {
    const off = { ...ctx, autonomy: false };
    const on = { ...ctx, autonomy: true };
    expect(validateProjectAction({ kind: "start_feature", featureId: "f-1", execMode: "queue" }, off)?.summary).toMatch(/autonomy is off/);
    expect(validateProjectAction({ kind: "start_feature", featureId: "f-1", execMode: "queue" }, on)?.summary).not.toMatch(/autonomy/);
  });

  it("process_backlog defaults feasibleOnly to true and needs no other field", () => {
    expect(validateProjectAction({ kind: "process_backlog" }, ctx)).toMatchObject({ kind: "process_backlog", feasibleOnly: true });
    expect(validateProjectAction({ kind: "process_backlog", feasibleOnly: false }, ctx)).toMatchObject({ feasibleOnly: false });
  });

  it("process_backlog's summary notes the autonomy-off side effect", () => {
    const r = validateProjectAction({ kind: "process_backlog" }, { ...ctx, autonomy: false });
    expect(r?.summary).toMatch(/autonomy is off/);
  });
});

// Governance-to-SOTA — Steward-side approve-in-flow: resolve_hitl is the SAME
// approve/reject/modify/option decision the Inbox and Telegram already resolve,
// reached from chat. Every id must resolve against ctx.gates (a REAL open gate),
// never an id the model invented — mirroring every task/feature/agent check above.
describe("validateProjectAction — resolve_hitl (Governance-to-SOTA approve-in-flow)", () => {
  it("approve resolves a known gate, no extra fields needed", () => {
    const a = validateProjectAction({ kind: "resolve_hitl", hitlId: "g-1", resolveAction: "approve" }, ctx);
    expect(a).toMatchObject({ kind: "resolve_hitl", hitlId: "g-1", resolveAction: "approve" });
    expect(a?.summary).toMatch(/approve/i);
    expect(a?.summary).toContain("Deploy to prod");
  });

  it("reject resolves a known gate", () => {
    const a = validateProjectAction({ kind: "resolve_hitl", hitlId: "g-1", resolveAction: "reject" }, ctx);
    expect(a).toMatchObject({ kind: "resolve_hitl", hitlId: "g-1", resolveAction: "reject" });
    expect(a?.summary).toMatch(/reject/i);
  });

  it("refuses an unknown hitlId — never invents a gate", () => {
    expect(validateProjectAction({ kind: "resolve_hitl", hitlId: "ghost", resolveAction: "approve" }, ctx)).toBeNull();
  });

  it("refuses when ctx has no gates at all (caller never fetched them)", () => {
    const { gates: _g, ...noGates } = ctx;
    expect(validateProjectAction({ kind: "resolve_hitl", hitlId: "g-1", resolveAction: "approve" }, noGates)).toBeNull();
  });

  it("modify requires non-empty guidance — a modify with nothing to say is a no-op, not an action", () => {
    expect(validateProjectAction({ kind: "resolve_hitl", hitlId: "g-1", resolveAction: "modify" }, ctx)).toBeNull();
    expect(validateProjectAction({ kind: "resolve_hitl", hitlId: "g-1", resolveAction: "modify", guidance: "  " }, ctx)).toBeNull();
    const a = validateProjectAction({ kind: "resolve_hitl", hitlId: "g-1", resolveAction: "modify", guidance: "use a canary rollout" }, ctx);
    expect(a).toMatchObject({ kind: "resolve_hitl", hitlId: "g-1", resolveAction: "modify", guidance: "use a canary rollout" });
    expect(a?.summary).toContain("use a canary rollout");
  });

  it("option resolves a 0-based index into the gate's own options list", () => {
    const a = validateProjectAction({ kind: "resolve_hitl", hitlId: "g-2", resolveAction: "option", optionIndex: 1 }, ctx);
    expect(a).toMatchObject({ kind: "resolve_hitl", hitlId: "g-2", resolveAction: "option", optionIndex: 1 });
    expect(a?.summary).toContain("MySQL");
  });

  it("option refuses an out-of-range or non-integer index", () => {
    expect(validateProjectAction({ kind: "resolve_hitl", hitlId: "g-2", resolveAction: "option", optionIndex: 2 }, ctx)).toBeNull();
    expect(validateProjectAction({ kind: "resolve_hitl", hitlId: "g-2", resolveAction: "option", optionIndex: -1 }, ctx)).toBeNull();
    expect(validateProjectAction({ kind: "resolve_hitl", hitlId: "g-2", resolveAction: "option", optionIndex: 1.5 }, ctx)).toBeNull();
    expect(validateProjectAction({ kind: "resolve_hitl", hitlId: "g-2", resolveAction: "option" }, ctx)).toBeNull();
  });

  it("option refuses on a gate with no options (e.g. a plain approval gate)", () => {
    expect(validateProjectAction({ kind: "resolve_hitl", hitlId: "g-1", resolveAction: "option", optionIndex: 0 }, ctx)).toBeNull();
  });

  it("refuses an unknown resolveAction", () => {
    expect(validateProjectAction({ kind: "resolve_hitl", hitlId: "g-1", resolveAction: "reassign" }, ctx)).toBeNull();
    expect(validateProjectAction({ kind: "resolve_hitl", hitlId: "g-1" }, ctx)).toBeNull();
  });
});
