// parseIntent is the PURE core of the conversational bridge: it turns the LLM's
// raw JSON reply into a validated action drawn ONLY from the closed five-action
// whitelist, and only when every referenced id exists in the grounding context.
// A misparse, an unknown id, or an injected instruction can never escalate past
// this function — these tests pin that.
import { describe, it, expect } from "vitest";
import { parseIntent, type Action, type IntentContext } from "../apps/server/src/telegram/intent.js";

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
