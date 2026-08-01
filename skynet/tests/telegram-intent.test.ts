// parseIntent is the PURE core of the conversational bridge: it turns the LLM's
// raw JSON reply into a validated action drawn ONLY from the closed five-action
// whitelist, and only when every referenced id exists in the grounding context.
// A misparse, an unknown id, or an injected instruction can never escalate past
// this function — these tests pin that.
import { describe, it, expect } from "vitest";
import {
  parseIntent,
  parseResponse,
  renderContext,
  type Action,
  type IntentContext,
} from "../apps/server/src/telegram/intent.js";

const ctx: IntentContext = {
  gates: [
    { id: "q-1", kind: "approval", title: "deploy payments", risk: "high", command: "deploy" },
    { id: "q-2", kind: "diff", title: "refactor auth", risk: "medium" },
  ],
  projects: [
    { id: "p-web", name: "Web" },
    { id: "p-api", name: "API" },
  ],
  tasks: [
    { id: "t-1", text: "fix login", state: "backlog", projectId: "p-web" },
    { id: "t-2", text: "add metrics", state: "todo", projectId: "p-api" },
  ],
  fleet: [{ id: "a-1", name: "alpha", provider: "claude", model: "opus", status: "idle" }],
  providers: [
    { id: "claude", models: ["opus", "sonnet"], available: true },
    { id: "gemini", models: ["gemini-pro"], available: false }, // not ready (no key)
  ],
  features: [
    { id: "f-onb", name: "Onboarding", projectId: "p-web", milestoneId: null },
    { id: "f-api-auth", name: "API auth", projectId: "p-api", milestoneId: null },
  ],
  milestones: [
    { id: "m-v1-web", name: "v1.0", projectId: "p-web", targetAt: null },
    { id: "m-v1-api", name: "v1.0", projectId: "p-api", targetAt: null },
  ],
};

/** null and {kind:"none"} both mean "couldn't map". */
const isNone = (a: Action | null): boolean => a === null || a.kind === "none";

describe("parseIntent — the five whitelisted actions map when ids resolve", () => {
  it("approve", () => {
    expect(parseIntent('{"action":"approve","gateId":"q-1"}', ctx)).toEqual({ kind: "approve", gateId: "q-1" });
  });
  it("reject", () => {
    expect(parseIntent('{"action":"reject","gateId":"q-2"}', ctx)).toEqual({ kind: "reject", gateId: "q-2" });
  });
  it("add_task (resolves the project id + trims text)", () => {
    expect(parseIntent('{"action":"add_task","projectId":"p-web","taskText":"  ship it  "}', ctx)).toEqual({
      kind: "add_task",
      projectId: "p-web",
      taskText: "ship it",
    });
  });
  it("assign (resolves the task's project id from context)", () => {
    expect(parseIntent('{"action":"assign","taskId":"t-2"}', ctx)).toEqual({
      kind: "assign",
      taskId: "t-2",
      projectId: "p-api",
    });
  });
  it("add_agent (validates provider readiness + model in catalog)", () => {
    expect(parseIntent('{"action":"add_agent","provider":"claude","model":"sonnet","agentName":"beta"}', ctx)).toEqual({
      kind: "add_agent",
      provider: "claude",
      model: "sonnet",
      agentName: "beta",
    });
  });
  it("add_agent defaults to the provider's first model when none is named (no dead-end)", () => {
    // "add a claude agent" (no model) → route with claude's first catalog model,
    // not a dead-end clarifying question.
    expect(parseIntent('{"action":"add_agent","provider":"claude"}', ctx)).toEqual({
      kind: "add_agent",
      provider: "claude",
      model: "opus", // ctx.providers claude.models[0]
    });
    expect(parseIntent('{"action":"add_agent","provider":"claude","model":"  "}', ctx)).toEqual({
      kind: "add_agent",
      provider: "claude",
      model: "opus",
    });
  });
  it("create_project (requires a non-empty name; goal optional)", () => {
    expect(parseIntent('{"action":"create_project","projectName":"  Web  "}', ctx)).toEqual({
      kind: "create_project",
      projectName: "Web",
    });
    expect(
      parseIntent('{"action":"create_project","projectName":"Web","projectGoal":"the marketing site"}', ctx),
    ).toEqual({ kind: "create_project", projectName: "Web", projectGoal: "the marketing site" });
    // Empty name → none (never create an unnamed project).
    expect(parseIntent('{"action":"create_project","projectName":"  "}', ctx).kind).toBe("none");
  });

  it("remove_task (resolves the task's project id from context — reversible archive)", () => {
    expect(parseIntent('{"action":"remove_task","taskId":"t-1"}', ctx)).toEqual({
      kind: "remove_task",
      taskId: "t-1",
      projectId: "p-web",
    });
  });

  it("remove_task with an unknown task id → none (never archives an arbitrary task)", () => {
    expect(isNone(parseIntent('{"action":"remove_task","taskId":"t-999"}', ctx))).toBe(true);
    // Missing taskId entirely → none.
    expect(isNone(parseIntent('{"action":"remove_task"}', ctx))).toBe(true);
  });

  it("preview (resolves the project id from context)", () => {
    expect(parseIntent('{"action":"preview","projectId":"p-web"}', ctx)).toEqual({ kind: "preview", projectId: "p-web" });
  });
  it("preview with an unknown project id → none (never previews an arbitrary project)", () => {
    expect(isNone(parseIntent('{"action":"preview","projectId":"p-999"}', ctx))).toBe(true);
    expect(isNone(parseIntent('{"action":"preview"}', ctx))).toBe(true);
  });
  it("status", () => {
    expect(parseIntent('{"action":"status"}', ctx)).toEqual({ kind: "status" });
  });
});

describe("parseIntent — strips code fences", () => {
  it("parses a ```json fenced reply", () => {
    const raw = "```json\n{\"action\":\"approve\",\"gateId\":\"q-1\"}\n```";
    expect(parseIntent(raw, ctx)).toEqual({ kind: "approve", gateId: "q-1" });
  });
  it("parses a bare ``` fence", () => {
    expect(parseIntent("```\n{\"action\":\"status\"}\n```", ctx)).toEqual({ kind: "status" });
  });
});

describe("parseIntent — anything unresolved collapses to none (no escalation)", () => {
  it("a gate id NOT in context → none", () => {
    expect(isNone(parseIntent('{"action":"approve","gateId":"q-999"}', ctx))).toBe(true);
  });
  it("a project id NOT in context → none", () => {
    expect(isNone(parseIntent('{"action":"add_task","projectId":"p-nope","taskText":"x"}', ctx))).toBe(true);
  });
  it("a task id NOT in context → none", () => {
    expect(isNone(parseIntent('{"action":"assign","taskId":"t-999"}', ctx))).toBe(true);
  });
  it("an agent hint NOT in context → none", () => {
    expect(isNone(parseIntent('{"action":"assign","taskId":"t-1","agentId":"a-nope"}', ctx))).toBe(true);
  });
  it("a provider that isn't ready → none", () => {
    expect(isNone(parseIntent('{"action":"add_agent","provider":"gemini","model":"gemini-pro"}', ctx))).toBe(true);
  });
  it("a model not offered by the provider → none", () => {
    expect(isNone(parseIntent('{"action":"add_agent","provider":"claude","model":"gpt-4"}', ctx))).toBe(true);
  });
  it("a provider not in the catalog → none", () => {
    expect(isNone(parseIntent('{"action":"add_agent","provider":"codex","model":"o1"}', ctx))).toBe(true);
  });
  it("an action OUTSIDE the whitelist → none (never executed)", () => {
    expect(isNone(parseIntent('{"action":"delete_everything"}', ctx))).toBe(true);
    expect(isNone(parseIntent('{"action":"stop"}', ctx))).toBe(true); // kill switch is deterministic-only
  });
  it("explicit none → none", () => {
    expect(isNone(parseIntent('{"action":"none","reason":"ambiguous"}', ctx))).toBe(true);
  });
  it("malformed / non-JSON → none", () => {
    expect(isNone(parseIntent("not json at all", ctx))).toBe(true);
    expect(isNone(parseIntent("{ broken", ctx))).toBe(true);
    expect(isNone(parseIntent("", ctx))).toBe(true);
  });
  it("missing required fields → none", () => {
    expect(isNone(parseIntent('{"action":"approve"}', ctx))).toBe(true);
    expect(isNone(parseIntent('{"action":"add_task","projectId":"p-web"}', ctx))).toBe(true);
    expect(isNone(parseIntent('{"action":"add_task","projectId":"p-web","taskText":"   "}', ctx))).toBe(true);
  });
});

// parseResponse is the CURRENT contract: the assistant ALWAYS returns a helpful
// `reply`, plus an OPTIONAL single whitelisted `action` (nested under `action`).
// It degrades gracefully so the owner never hits a dead end, and the action is
// still validated against the closed whitelist + the grounding context.
describe("parseResponse — {reply, action} envelope extraction", () => {
  it("extracts both a reply AND a validated action", () => {
    const raw = JSON.stringify({ reply: "Sure — approving the deploy gate.", action: { action: "approve", gateId: "q-1" } });
    expect(parseResponse(raw, ctx)).toEqual({
      reply: "Sure — approving the deploy gate.",
      action: { kind: "approve", gateId: "q-1" },
    });
  });

  it("extracts JSON wrapped in prose (slices first { to last })", () => {
    const raw = 'Got it! Here you go:\n{"reply":"Adding that task now.","action":{"action":"add_task","projectId":"p-web","taskText":"ship it"}}\nHope that helps.';
    expect(parseResponse(raw, ctx)).toEqual({
      reply: "Adding that task now.",
      action: { kind: "add_task", projectId: "p-web", taskText: "ship it" },
    });
  });

  it("extracts JSON wrapped in a ```json code fence", () => {
    const raw = '```json\n{"reply":"Here is the status.","action":{"action":"status"}}\n```';
    expect(parseResponse(raw, ctx)).toEqual({ reply: "Here is the status.", action: { kind: "status" } });
  });

  it("a pure-chat reply has action null and a non-empty reply", () => {
    const raw = JSON.stringify({ reply: "I can approve gates, add tasks, assign work, add agents, or create projects.", action: null });
    const r = parseResponse(raw, ctx);
    expect(r.action).toBeNull();
    expect(r.reply.length).toBeGreaterThan(0);
  });

  it("a totally-non-JSON reply degrades to {reply: <raw>, action: null} (never a dead end)", () => {
    const raw = "Hey! I'm Skynet's ops assistant — ask me anything.";
    expect(parseResponse(raw, ctx)).toEqual({ reply: raw, action: null });
  });

  it("keeps the helpful reply even when the proposed action is invalid (unknown id → null)", () => {
    const raw = JSON.stringify({ reply: "I'll approve that.", action: { action: "approve", gateId: "q-999" } });
    const r = parseResponse(raw, ctx);
    expect(r.reply).toBe("I'll approve that.");
    expect(r.action).toBeNull(); // unknown gate id never escalates
  });

  it("rejects an action outside the whitelist while keeping the reply", () => {
    const raw = JSON.stringify({ reply: "Working on it.", action: { action: "delete_everything" } });
    expect(parseResponse(raw, ctx).action).toBeNull();
  });

  it("an explicit action:null is just a reply", () => {
    const raw = JSON.stringify({ reply: "Nothing to do — all clear.", action: null });
    expect(parseResponse(raw, ctx).action).toBeNull();
  });
});

// The assistant is grounded in repo content so it can answer roadmap/bug/feature
// questions over Telegram — the docs ride in a dedicated, clearly-labelled section.
describe("renderContext — PROJECT DOCS grounding", () => {
  const docs = "\n\n### PROJECT Web (p-web)\n\n=== ROADMAP.md ===\n- item 1: dark mode\n- item 2: SSO";

  it("appends a PROJECT DOCS section when docs are provided", () => {
    const out = renderContext(ctx, undefined, docs);
    expect(out).toContain("WORKSPACE CONTEXT");
    expect(out).toContain("PROJECT DOCS");
    expect(out).toContain("item 1: dark mode");
    // Docs ground answers AFTER the workspace context. The operator message is no
    // longer concatenated here — it's passed separately as the runner's question
    // (prompt-injection fix), so this data blob is pure grounding.
    expect(out.indexOf("WORKSPACE CONTEXT")).toBeLessThan(out.indexOf("PROJECT DOCS"));
  });

  it("omits the section entirely when there are no docs", () => {
    expect(renderContext(ctx)).not.toContain("PROJECT DOCS");
    expect(renderContext(ctx, undefined, "   ")).not.toContain("PROJECT DOCS");
  });
});

// ── Grouping actions (features + milestones) ────────────────────────────
// Same-project scoping is the load-bearing invariant: a cross-project
// featureId/milestoneId must be REJECTED, so a misparse or injected instruction
// can't wire a task to something outside its project.
describe("parseIntent — grouping (features + milestones)", () => {
  it("create_feature accepts a project + name; unknown project rejects", () => {
    expect(
      parseIntent(
        JSON.stringify({ action: "create_feature", projectId: "p-web", featureName: "Payments" }),
        ctx,
      ),
    ).toMatchObject({ kind: "create_feature", projectId: "p-web", featureName: "Payments" });
    // Missing name is rejected (empty title).
    expect(
      parseIntent(JSON.stringify({ action: "create_feature", projectId: "p-web", featureName: "" }), ctx),
    ).toMatchObject({ kind: "none" });
    // Unknown project id → none.
    expect(
      parseIntent(
        JSON.stringify({ action: "create_feature", projectId: "p-other", featureName: "Payments" }),
        ctx,
      ),
    ).toMatchObject({ kind: "none" });
  });

  it("create_feature rejects a milestoneId in a DIFFERENT project (no cross-project wiring)", () => {
    // p-api's milestone can't be attached to a p-web feature at creation time.
    expect(
      parseIntent(
        JSON.stringify({
          action: "create_feature",
          projectId: "p-web",
          featureName: "Payments",
          milestoneId: "m-v1-api",
        }),
        ctx,
      ),
    ).toMatchObject({ kind: "none" });
  });

  it("set_task_feature — null clears; known id in the SAME project links; wrong project rejects", () => {
    expect(
      parseIntent(JSON.stringify({ action: "set_task_feature", taskId: "t-1", featureId: null }), ctx),
    ).toMatchObject({ kind: "set_task_feature", taskId: "t-1", projectId: "p-web", featureId: null });
    expect(
      parseIntent(
        JSON.stringify({ action: "set_task_feature", taskId: "t-1", featureId: "f-onb" }),
        ctx,
      ),
    ).toMatchObject({ kind: "set_task_feature", taskId: "t-1", featureId: "f-onb", projectId: "p-web" });
    // t-1 is in p-web; f-api-auth is in p-api → reject.
    expect(
      parseIntent(
        JSON.stringify({ action: "set_task_feature", taskId: "t-1", featureId: "f-api-auth" }),
        ctx,
      ),
    ).toMatchObject({ kind: "none" });
  });

  it("archive_feature carries the feature's projectId (executor needs it)", () => {
    const a = parseIntent(JSON.stringify({ action: "archive_feature", featureId: "f-onb" }), ctx) as Action;
    expect(a).toMatchObject({ kind: "archive_feature", featureId: "f-onb", projectId: "p-web" });
    expect(
      parseIntent(JSON.stringify({ action: "archive_feature", featureId: "f-other" }), ctx),
    ).toMatchObject({ kind: "none" });
  });

  it("create_milestone accepts numeric targetAt, null, and omitted; anything else rejects", () => {
    const t = Date.UTC(2026, 5, 1);
    expect(
      parseIntent(
        JSON.stringify({ action: "create_milestone", projectId: "p-web", milestoneName: "v2", targetAt: t }),
        ctx,
      ),
    ).toMatchObject({ kind: "create_milestone", projectId: "p-web", milestoneName: "v2", targetAt: t });
    expect(
      parseIntent(
        JSON.stringify({ action: "create_milestone", projectId: "p-web", milestoneName: "v2", targetAt: null }),
        ctx,
      ),
    ).toMatchObject({ kind: "create_milestone", targetAt: null });
    expect(
      parseIntent(
        JSON.stringify({ action: "create_milestone", projectId: "p-web", milestoneName: "v2" }),
        ctx,
      ),
    ).toMatchObject({ kind: "create_milestone", milestoneName: "v2" });
    // Non-number targetAt → none. Never silently coerce.
    expect(
      parseIntent(
        JSON.stringify({ action: "create_milestone", projectId: "p-web", milestoneName: "v2", targetAt: "2026-06-01" }),
        ctx,
      ),
    ).toMatchObject({ kind: "none" });
  });

  it("set_feature_milestone — null clears; known id links; wrong project rejects", () => {
    expect(
      parseIntent(
        JSON.stringify({ action: "set_feature_milestone", featureId: "f-onb", milestoneId: null }),
        ctx,
      ),
    ).toMatchObject({ kind: "set_feature_milestone", featureId: "f-onb", milestoneId: null, projectId: "p-web" });
    expect(
      parseIntent(
        JSON.stringify({ action: "set_feature_milestone", featureId: "f-onb", milestoneId: "m-v1-web" }),
        ctx,
      ),
    ).toMatchObject({ kind: "set_feature_milestone", featureId: "f-onb", milestoneId: "m-v1-web" });
    // f-onb is p-web; m-v1-api is p-api → reject.
    expect(
      parseIntent(
        JSON.stringify({ action: "set_feature_milestone", featureId: "f-onb", milestoneId: "m-v1-api" }),
        ctx,
      ),
    ).toMatchObject({ kind: "none" });
  });

  it("set_task_milestone — null clears; known id in same project links; wrong project rejects", () => {
    expect(
      parseIntent(
        JSON.stringify({ action: "set_task_milestone", taskId: "t-1", milestoneId: "m-v1-web" }),
        ctx,
      ),
    ).toMatchObject({ kind: "set_task_milestone", taskId: "t-1", milestoneId: "m-v1-web", projectId: "p-web" });
    expect(
      parseIntent(
        JSON.stringify({ action: "set_task_milestone", taskId: "t-1", milestoneId: "m-v1-api" }),
        ctx,
      ),
    ).toMatchObject({ kind: "none" });
  });

  it("mark_milestone_shipped carries the milestone's projectId; unknown id rejects", () => {
    expect(
      parseIntent(JSON.stringify({ action: "mark_milestone_shipped", milestoneId: "m-v1-web" }), ctx),
    ).toMatchObject({ kind: "mark_milestone_shipped", milestoneId: "m-v1-web", projectId: "p-web" });
    expect(
      parseIntent(JSON.stringify({ action: "mark_milestone_shipped", milestoneId: "m-other" }), ctx),
    ).toMatchObject({ kind: "none" });
  });
});
