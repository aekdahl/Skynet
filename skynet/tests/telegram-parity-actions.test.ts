// Telegram parity: the 7 Steward kinds ported into validateAction (reorder_task,
// request_review, resync_source, set_schedule, set_assignment, pause_key,
// resume_key). Pure — fixture grounding only. Each gets a happy path and its
// rejection path, mirroring the existing validateAction cases (never trust an id
// the model proposes without checking it against the WORKSPACE CONTEXT).
import { describe, it, expect } from "vitest";
import { validateAction, type IntentContext } from "../apps/server/src/telegram/intent.js";

const ctx: IntentContext = {
  gates: [],
  projects: [{ id: "p1", name: "Proj" }],
  tasks: [{ id: "t1", text: "Ship it", state: "review", projectId: "p1" }],
  fleet: [{ id: "a1", name: "Claude Worker", provider: "anthropic", model: "claude-sonnet-5", status: "idle" }],
  providers: [],
  features: [],
  milestones: [],
};

describe("validateAction — Telegram parity kinds", () => {
  it("reorder_task resolves the task/direction and derives projectId", () => {
    const a = validateAction({ action: "reorder_task", taskId: "t1", direction: "up" }, ctx);
    expect(a).toEqual({ kind: "reorder_task", taskId: "t1", projectId: "p1", direction: "up" });
  });

  it("reorder_task rejects an unrecognized direction", () => {
    expect(validateAction({ action: "reorder_task", taskId: "t1", direction: "sideways" }, ctx)?.kind).toBe("none");
  });

  it("request_review resolves the task", () => {
    const a = validateAction({ action: "request_review", taskId: "t1" }, ctx);
    expect(a).toEqual({ kind: "request_review", taskId: "t1", projectId: "p1" });
  });

  it("request_review rejects an unknown taskId", () => {
    expect(validateAction({ action: "request_review", taskId: "ghost" }, ctx)?.kind).toBe("none");
  });

  it("resync_source resolves the project", () => {
    const a = validateAction({ action: "resync_source", projectId: "p1" }, ctx);
    expect(a).toEqual({ kind: "resync_source", projectId: "p1" });
  });

  it("resync_source rejects an unknown project", () => {
    expect(validateAction({ action: "resync_source", projectId: "ghost" }, ctx)?.kind).toBe("none");
  });

  it("set_schedule passes through whichever of estimatedDurationMs/plannedStartAt is present", () => {
    const a = validateAction({ action: "set_schedule", taskId: "t1", estimatedDurationMs: 1_800_000 }, ctx);
    expect(a).toEqual({ kind: "set_schedule", taskId: "t1", projectId: "p1", estimatedDurationMs: 1_800_000 });
  });

  it("set_schedule rejects when neither field is present", () => {
    expect(validateAction({ action: "set_schedule", taskId: "t1" }, ctx)?.kind).toBe("none");
  });

  it("set_assignment keeps only agentIds that resolve against the fleet", () => {
    const a = validateAction({ action: "set_assignment", taskId: "t1", mode: "agents", agentIds: ["a1", "ghost"] }, ctx);
    expect(a).toEqual({ kind: "set_assignment", taskId: "t1", projectId: "p1", mode: "agents", agentIds: ["a1"] });
  });

  it("set_assignment refuses 'agents' mode when no listed agent resolves", () => {
    expect(validateAction({ action: "set_assignment", taskId: "t1", mode: "agents", agentIds: ["ghost"] }, ctx)?.kind).toBe("none");
  });

  it("pause_key requires both a credentialId and a reason", () => {
    expect(validateAction({ action: "pause_key", credentialId: "cred-1" }, ctx)?.kind).toBe("none");
    const a = validateAction({ action: "pause_key", credentialId: "cred-1", reason: "rotating it" }, ctx);
    expect(a).toEqual({ kind: "pause_key", credentialId: "cred-1", reason: "rotating it" });
  });

  it("resume_key just needs a credentialId", () => {
    const a = validateAction({ action: "resume_key", credentialId: "cred-1" }, ctx);
    expect(a).toEqual({ kind: "resume_key", credentialId: "cred-1" });
  });
});
