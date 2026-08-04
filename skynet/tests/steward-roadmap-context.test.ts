// Steward can only propose roadmap actions if it can SEE the project's features
// + milestones and resolve their ids. prepareStewardCall must fold both into the
// grounded prompt (so the model references real ids) and into the action context
// (so validateProjectAction accepts those ids). Grounded with a real MemoryStore;
// no LLM call (prepareStewardCall only builds the prompt).
import { describe, it, expect, beforeAll } from "vitest";
import { Feature, Milestone, Project, Task, DEFAULT_WORKSPACE } from "@skynet/shared";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import { prepareStewardCall } from "../apps/server/src/steward/assistant.js";
import { resetMasterKeyCache } from "../apps/server/src/secrets/crypto.js";

const WS = DEFAULT_WORKSPACE;

describe("prepareStewardCall — roadmap grounding", () => {
  beforeAll(() => {
    // A valid master key so secretService.resolve() (called for the api key) works.
    process.env.SKYNET_MASTER_KEY = Buffer.alloc(32, 9).toString("base64");
    resetMasterKeyCache();
  });

  it("includes features + milestones in the prompt AND the action context", async () => {
    const store = new MemoryStore({ seed: false });
    const now = 1_700_000_000_000;
    const project = Project.parse({ id: "p-1", workspaceId: WS, name: "Takeoff", goal: "ship", runIds: [], status: "active" });
    await store.putProject(project);
    await store.putMilestone(Milestone.parse({ id: "m-1", workspaceId: WS, projectId: "p-1", name: "Public beta", createdAt: now }));
    await store.putFeature(Feature.parse({ id: "f-1", workspaceId: WS, projectId: "p-1", name: "Checkout", milestoneId: "m-1", createdAt: now }));
    await store.putTask(Task.parse({ id: "t-1", workspaceId: WS, projectId: "p-1", text: "wire stripe", state: "todo", featureId: "f-1" }));

    const call = await prepareStewardCall(store, { workspaceId: WS, project, question: "what's the roadmap?" });

    // Prompt grounding — the model can see the names, statuses, and ids to link against.
    // (Assert on the STATUS section headers, not the bare words, which also appear
    // in the SYSTEM prompt's action instructions.)
    expect(call.prompt).toContain("FEATURES (task groupings)");
    expect(call.prompt).toContain("Checkout");
    expect(call.prompt).toContain("MILESTONES (roadmap)");
    expect(call.prompt).toContain("Public beta");
    expect(call.prompt).toContain("f-1"); // the task's feature tag / feature id
    expect(call.prompt).toContain("m-1");

    // Action context — validateProjectAction resolves ids against these.
    expect(call.actionCtx.features).toEqual([{ id: "f-1", name: "Checkout" }]);
    expect(call.actionCtx.milestones).toEqual([{ id: "m-1", name: "Public beta" }]);
  });

  it("omits the roadmap sections when a project has none", async () => {
    const store = new MemoryStore({ seed: false });
    const project = Project.parse({ id: "p-2", workspaceId: WS, name: "Bare", goal: "", runIds: [], status: "active" });
    await store.putProject(project);
    const call = await prepareStewardCall(store, { workspaceId: WS, project, question: "hi" });
    expect(call.prompt).not.toContain("FEATURES (task groupings)");
    expect(call.prompt).not.toContain("MILESTONES (roadmap)");
    expect(call.actionCtx.features).toEqual([]);
    expect(call.actionCtx.milestones).toEqual([]);
  });
});
