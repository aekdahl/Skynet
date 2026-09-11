// Fleet-ops + remove_credential Steward actions (validateProjectAction). Pure —
// fixture grounding only. Each new kind gets a happy path and an id-not-found
// rejection, mirroring how the other validateProjectAction cases already behave
// (never trust an id the model proposes without checking it against the context).
import { describe, it, expect } from "vitest";
import { validateProjectAction, type ProjectActionContext } from "../apps/server/src/steward/assistant.js";

const ctx: ProjectActionContext = {
  project: { id: "p1", name: "Proj" },
  tasks: [
    { id: "t1", text: "Ship the thing", state: "ongoing", runId: "r1" },
    { id: "t2", text: "Backlog item", state: "backlog", runId: null },
  ],
  agents: [{ id: "a1", name: "Claude Worker" }],
};

describe("validateProjectAction — fleet ops", () => {
  it("reassign_run resolves a known task + agent", () => {
    const a = validateProjectAction({ kind: "reassign_run", taskId: "t1", agentId: "a1" }, ctx);
    expect(a).toEqual(expect.objectContaining({ kind: "reassign_run", taskId: "t1", agentId: "a1" }));
  });

  it("reassign_run refuses an unknown agent id", () => {
    expect(validateProjectAction({ kind: "reassign_run", taskId: "t1", agentId: "ghost" }, ctx)).toBeNull();
  });

  it("retire_runner resolves a known agent, workspace-scoped (no taskId)", () => {
    const a = validateProjectAction({ kind: "retire_runner", agentId: "a1" }, ctx);
    expect(a).toEqual(expect.objectContaining({ kind: "retire_runner", agentId: "a1" }));
  });

  it("retire_runner refuses an unknown agent id", () => {
    expect(validateProjectAction({ kind: "retire_runner", agentId: "ghost" }, ctx)).toBeNull();
  });

  it.each(["pause_run", "resume_run", "stop_run"] as const)("%s resolves the task's live runId", (kind) => {
    const a = validateProjectAction({ kind, taskId: "t1" }, ctx);
    expect(a).toEqual(expect.objectContaining({ kind, taskId: "t1", runId: "r1" }));
  });

  it.each(["pause_run", "resume_run", "stop_run"] as const)("%s refuses a task with no live run", (kind) => {
    expect(validateProjectAction({ kind, taskId: "t2" }, ctx)).toBeNull();
  });

  it.each(["pause_run", "resume_run", "stop_run"] as const)("%s refuses an unknown taskId", (kind) => {
    expect(validateProjectAction({ kind, taskId: "ghost" }, ctx)).toBeNull();
  });
});

describe("validateProjectAction — remove_credential", () => {
  it("resolves a credentialId (no grounding list — same as pause_key/resume_key)", () => {
    const a = validateProjectAction({ kind: "remove_credential", credentialId: "cred-1" }, ctx);
    expect(a).toEqual(expect.objectContaining({ kind: "remove_credential", credentialId: "cred-1" }));
  });

  it("refuses an empty credentialId", () => {
    expect(validateProjectAction({ kind: "remove_credential", credentialId: "" }, ctx)).toBeNull();
  });
});
