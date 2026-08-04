// resolveFocusProject is the PURE core that lets the workspace Steward dock act on
// a project without a project page open: it reads the conversation to decide WHICH
// project the operator means. These tests pin the "focus from chat" behavior —
// current-message-first, newest-history-next, single-unambiguous-match-wins — that
// turns "…in Takeoff?" → "can you do anything with it?" into an action on Takeoff.
import { describe, it, expect } from "vitest";
import { resolveFocusProject, type ChatTurn } from "../apps/server/src/steward/assistant.js";

const projects = [
  { id: "p-takeoff", name: "Takeoff" },
  { id: "p-web", name: "Web" },
  { id: "p-api", name: "API" },
];

describe("resolveFocusProject — focus from the conversation", () => {
  it("resolves a project named in the current question", () => {
    expect(resolveFocusProject(projects, "Are there any backlog tasks in Takeoff?")).toBe("p-takeoff");
  });

  it("walks back to history when the current question has no project (the Takeoff case)", () => {
    const history: ChatTurn[] = [
      { role: "user", content: "Are there any backlog tasks in Takeoff?" },
      { role: "assistant", content: "Yes — Takeoff has 1 task in its backlog." },
    ];
    expect(resolveFocusProject(projects, "Are you able to do anything with the task?", history)).toBe("p-takeoff");
  });

  it("prefers the most recent mention when history spans multiple projects", () => {
    const history: ChatTurn[] = [
      { role: "user", content: "How's Takeoff doing?" }, // older
      { role: "assistant", content: "Web has 3 runs going." }, // newer → wins
    ];
    expect(resolveFocusProject(projects, "and the tasks?", history)).toBe("p-web");
  });

  it("returns null when a single message names two projects (ambiguous — never guess)", () => {
    expect(resolveFocusProject(projects, "Compare Takeoff and Web for me")).toBeNull();
  });

  it("stops at the first project-naming message even if an older one is unambiguous", () => {
    const history: ChatTurn[] = [{ role: "user", content: "Tell me about Takeoff" }];
    // Current question names two → ambiguous → null, without falling through to history.
    expect(resolveFocusProject(projects, "Takeoff or Web?", history)).toBeNull();
  });

  it("matches an exact project id token", () => {
    expect(resolveFocusProject(projects, "what's the status of p-api?")).toBe("p-api");
  });

  it("matches names as whole words, not substrings", () => {
    // "API" must not match inside "capability"; "Web" must not match inside "website".
    expect(resolveFocusProject(projects, "what are the team's capabilities on the website?")).toBeNull();
  });

  it("returns null when no project is referenced", () => {
    expect(resolveFocusProject(projects, "what's running right now?")).toBeNull();
    expect(resolveFocusProject(projects, "")).toBeNull();
  });

  it("returns null when there are no projects", () => {
    expect(resolveFocusProject([], "anything about Takeoff?")).toBeNull();
  });
});
