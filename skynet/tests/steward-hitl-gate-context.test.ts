// Governance-to-SOTA — Steward-side approve-in-flow. resolve_hitl can only act on
// a REAL open gate (see ProjectActionContext.gates's doc comment in assistant.ts),
// so prepareStewardCall must fetch this project's open gates and fold them into
// both the grounded prompt (OPEN GATES) and the action context. A HitlItem carries
// no projectId of its own (except the projectId-only roadmap_edit kind) — its
// project is reached by joining through the run it's attached to, mirroring
// Operations.listDecisions. Grounded with a real MemoryStore; no LLM call
// (prepareStewardCall only builds the prompt).
import { describe, it, expect, beforeAll } from "vitest";
import { HitlItem, Project, TaskRun, DEFAULT_WORKSPACE } from "@skynet/shared";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import { prepareStewardCall } from "../apps/server/src/steward/assistant.js";
import { resetMasterKeyCache } from "../apps/server/src/secrets/crypto.js";

const WS = DEFAULT_WORKSPACE;

function run(over: Partial<TaskRun> & { id: string; projectId: string }): TaskRun {
  return TaskRun.parse({
    workspaceId: WS, name: "r", status: "running", agentId: null, provider: "claude", model: "m",
    branch: "b", modules: [], progress: 0, plan: [], modifiedFiles: [], log: [], startedAt: 0, lastHeartbeatAt: 0,
    ...over,
  });
}

function gate(over: Partial<HitlItem> & { id: string; runId: string }): HitlItem {
  return HitlItem.parse({
    workspaceId: WS, bakeoffId: null, kind: "approval", title: "t", why: "w", risk: "medium",
    raisedAt: 1, expiresAt: null, resolvedAt: null, resolution: null, command: "deploy", options: null,
    recommended: null, steps: null, diff: null, output: null, rationale: null, flags: [],
    sourceBranchOverride: null, projectId: null, roadmapProposalId: null,
    ...over,
  });
}

describe("prepareStewardCall — open HITL gate grounding", () => {
  beforeAll(() => {
    process.env.SKYNET_MASTER_KEY = Buffer.alloc(32, 9).toString("base64");
    resetMasterKeyCache();
  });

  it("includes an open gate on this project's run in the prompt AND the action context", async () => {
    const store = new MemoryStore({ seed: false });
    const project = Project.parse({ id: "p-1", workspaceId: WS, name: "Takeoff", goal: "", runIds: [], status: "active" });
    await store.putProject(project);
    await store.putRun(run({ id: "r-1", projectId: "p-1" }));
    await store.putHitl(gate({ id: "g-1", runId: "r-1", kind: "approval", title: "Deploy to prod", risk: "high" }));

    const call = await prepareStewardCall(store, { workspaceId: WS, project, question: "what needs my attention?" });

    expect(call.prompt).toContain("OPEN GATES (needs your decision");
    expect(call.prompt).toContain("[g-1]");
    expect(call.prompt).toContain("Deploy to prod");
    expect(call.actionCtx.gates).toEqual([{ id: "g-1", kind: "approval", title: "Deploy to prod", risk: "high", options: null }]);
  });

  it("excludes a gate on ANOTHER project's run", async () => {
    const store = new MemoryStore({ seed: false });
    const project = Project.parse({ id: "p-1", workspaceId: WS, name: "Takeoff", goal: "", runIds: [], status: "active" });
    const other = Project.parse({ id: "p-2", workspaceId: WS, name: "Other", goal: "", runIds: [], status: "active" });
    await store.putProject(project);
    await store.putProject(other);
    await store.putRun(run({ id: "r-2", projectId: "p-2" }));
    await store.putHitl(gate({ id: "g-2", runId: "r-2" }));

    const call = await prepareStewardCall(store, { workspaceId: WS, project, question: "hi" });

    expect(call.prompt).not.toContain("OPEN GATES (needs your decision");
    expect(call.actionCtx.gates).toEqual([]);
  });

  it("excludes an already-resolved gate", async () => {
    const store = new MemoryStore({ seed: false });
    const project = Project.parse({ id: "p-1", workspaceId: WS, name: "Takeoff", goal: "", runIds: [], status: "active" });
    await store.putProject(project);
    await store.putRun(run({ id: "r-1", projectId: "p-1" }));
    await store.putHitl(gate({ id: "g-3", runId: "r-1", resolvedAt: 5, resolution: { action: "approve", optionIndex: null, guidance: null, targetBranch: null, memoryNote: null, resetWork: false, by: "op-1", at: 5 } }));

    const call = await prepareStewardCall(store, { workspaceId: WS, project, question: "hi" });

    expect(call.prompt).not.toContain("OPEN GATES (needs your decision");
    expect(call.actionCtx.gates).toEqual([]);
  });

  it("includes a roadmap_edit gate by its own projectId — it has no run behind it", async () => {
    const store = new MemoryStore({ seed: false });
    const project = Project.parse({ id: "p-1", workspaceId: WS, name: "Takeoff", goal: "", runIds: [], status: "active" });
    await store.putProject(project);
    // roadmap_edit carries no real runId (TASK 30 — no TaskRun behind a roadmap
    // proposal); the id here never resolves to a run, mirroring production.
    await store.putHitl(
      gate({ id: "g-4", runId: "roadmap:p-1", kind: "roadmap_edit", projectId: "p-1", title: "Edit ROADMAP.md", roadmapProposalId: "prop-1" }),
    );

    const call = await prepareStewardCall(store, { workspaceId: WS, project, question: "hi" });

    expect(call.prompt).toContain("OPEN GATES (needs your decision");
    expect(call.actionCtx.gates).toEqual([{ id: "g-4", kind: "roadmap_edit", title: "Edit ROADMAP.md", risk: "medium", options: null }]);
  });

  it("omits OPEN GATES entirely when there are none", async () => {
    const store = new MemoryStore({ seed: false });
    const project = Project.parse({ id: "p-1", workspaceId: WS, name: "Takeoff", goal: "", runIds: [], status: "active" });
    await store.putProject(project);
    const call = await prepareStewardCall(store, { workspaceId: WS, project, question: "hi" });
    expect(call.prompt).not.toContain("OPEN GATES (needs your decision");
    expect(call.actionCtx.gates).toEqual([]);
  });
});
