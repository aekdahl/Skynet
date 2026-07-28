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
    const out = renderContext("what's on the roadmap?", ctx, undefined, docs);
    expect(out).toContain("PROJECT DOCS");
    expect(out).toContain("item 1: dark mode");
    // The operator message is still framed as untrusted data, before the docs.
    expect(out.indexOf("OPERATOR MESSAGE")).toBeLessThan(out.indexOf("PROJECT DOCS"));
  });

  it("omits the section entirely when there are no docs", () => {
    expect(renderContext("hi", ctx)).not.toContain("PROJECT DOCS");
    expect(renderContext("hi", ctx, undefined, "   ")).not.toContain("PROJECT DOCS");
  });
});
