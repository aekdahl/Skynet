// Project-scoped agent guidance (`Project.instructions`) rides every prompt an
// agent on that project sees — the "house rules" for this codebase (packages
// to use, code structure, conventions). This test file pins the three seams:
//   1. `withInstructions` is a pure no-op when there are no instructions and a
//      labeled prefix when there are (so callers can wrap any prompt safely).
//   2. Steward's `PROJECT STATUS` grounding surfaces the instructions block
//      so the assistant can answer "what are the rules?" and honor them.
//   3. Operations normalizes create/update: blank / whitespace-only clears the
//      field back to null (unambiguous "no rules" state).
import { describe, it, expect } from "vitest";
import type { Agent, Project, Task, TaskRun, ServerEvent } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { withInstructions } from "../apps/server/src/orchestrator.js";
import { statusContext } from "../apps/server/src/steward/assistant.js";
import { Hub } from "../apps/server/src/hub.js";
import { Operations } from "../apps/server/src/operations.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { ProviderId } from "@skynet/shared";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

// ── 1) withInstructions — the composition primitive ─────────────────────

describe("withInstructions", () => {
  it("returns the body unchanged when there are no instructions", () => {
    expect(withInstructions(null, "do the thing")).toBe("do the thing");
    expect(withInstructions(undefined, "do the thing")).toBe("do the thing");
    // Whitespace-only counts as "no rules" — otherwise a stray-newline field
    // would pollute every prompt with an empty banner.
    expect(withInstructions("   \n  ", "do the thing")).toBe("do the thing");
  });

  it("prefixes a labeled banner when instructions are present", () => {
    const out = withInstructions("Use @acme/agents.", "Build the login form.");
    expect(out).toContain("=== PROJECT INSTRUCTIONS");
    expect(out).toContain("Use @acme/agents.");
    expect(out).toContain("=== TASK ===");
    expect(out).toContain("Build the login form.");
    // The instructions come BEFORE the task — an agent reading top-down sees
    // the rules before the ask, so scope-scoped disciplines can constrain
    // interpretation of the task.
    expect(out.indexOf("PROJECT INSTRUCTIONS")).toBeLessThan(out.indexOf("=== TASK ==="));
  });

  it("trims surrounding whitespace on the instructions but preserves internal newlines", () => {
    const rules = "\n\n- Use foo\n- Use bar\n\n";
    const out = withInstructions(rules, "task");
    expect(out).toContain("- Use foo\n- Use bar");
    expect(out).not.toContain("\n\n\n"); // no runaway blank lines
  });
});

// ── 2) Steward grounding — statusContext surfaces instructions ──────────

describe("statusContext with project instructions", () => {
  const baseProject: Project = {
    id: "p1",
    workspaceId: DEFAULT_WORKSPACE,
    name: "AgentFactory",
    goal: "build agents fast",
    runIds: [],
    status: "active",
    autonomy: true,
    approvalLevel: "trusted",
    approvalRules: [],
    repoPath: null,
    gitBacked: false,
    instructions: null,
  };

  it("omits the INSTRUCTIONS block when the project has none", () => {
    const ctx = statusContext(baseProject, [], []);
    expect(ctx).not.toContain("INSTRUCTIONS");
  });

  it("emits the INSTRUCTIONS block with dashed fences when the project has rules", () => {
    const withRules: Project = {
      ...baseProject,
      instructions: "Use the @acme/agents SDK.\nOne agent per directory under src/agents/.",
    };
    const ctx = statusContext(withRules, [], []);
    expect(ctx).toContain("INSTRUCTIONS (rules for every agent on this project):");
    expect(ctx).toContain("Use the @acme/agents SDK.");
    expect(ctx).toContain("One agent per directory");
    // The block is fenced so Steward doesn't confuse it with task text.
    const start = ctx.indexOf("INSTRUCTIONS (rules");
    const board = ctx.indexOf("BOARD (");
    expect(start).toBeLessThan(board); // rendered before the task board
    // Two dash lines flank the content.
    expect(ctx.slice(start, board).match(/^---$/gm)?.length).toBe(2);
  });

  it("whitespace-only instructions are treated as no rules (no empty block)", () => {
    const noisy: Project = { ...baseProject, instructions: "   \n\n  " };
    const ctx = statusContext(noisy, [], []);
    expect(ctx).not.toContain("INSTRUCTIONS");
  });
});

// Governance-to-SOTA — Steward-side approve-in-flow: OPEN GATES gives the
// model a real id to resolve_hitl against (see ProjectActionContext.gates's
// doc comment in assistant.ts) — without this section the action is dead
// code, since the model would have nothing but an invented id to propose.
describe("statusContext with open HITL gates", () => {
  const baseProject: Project = {
    id: "p1",
    workspaceId: DEFAULT_WORKSPACE,
    name: "AgentFactory",
    goal: "build agents fast",
    runIds: [],
    status: "active",
    autonomy: true,
    approvalLevel: "trusted",
    approvalRules: [],
    repoPath: null,
    gitBacked: false,
    instructions: null,
  };

  it("omits OPEN GATES when there are none", () => {
    const ctx = statusContext(baseProject, [], []);
    expect(ctx).not.toContain("OPEN GATES");
  });

  it("lists an open gate with its id, kind, title, and risk", () => {
    const gate = {
      id: "g-1", workspaceId: DEFAULT_WORKSPACE, runId: "r-1", bakeoffId: null, kind: "approval" as const,
      title: "Deploy to prod", why: "w", risk: "high", raisedAt: 1, expiresAt: null, resolvedAt: null, resolution: null,
      command: "deploy", options: null, recommended: null, steps: null, diff: null, output: null, rationale: null, flags: [],
      sourceBranchOverride: null, projectId: null, roadmapProposalId: null,
    };
    const ctx = statusContext(baseProject, [], [], [], [], [], [gate]);
    expect(ctx).toContain("OPEN GATES");
    expect(ctx).toContain("[g-1]");
    expect(ctx).toContain("approval");
    expect(ctx).toContain("Deploy to prod");
    expect(ctx).toContain("high risk");
  });

  it("numbers a question gate's options so 'option 2' maps unambiguously", () => {
    const gate = {
      id: "g-2", workspaceId: DEFAULT_WORKSPACE, runId: "r-1", bakeoffId: null, kind: "question" as const,
      title: "Which DB?", why: "w", risk: "low", raisedAt: 1, expiresAt: null, resolvedAt: null, resolution: null,
      command: null, options: ["Postgres", "MySQL"], recommended: null, steps: null, diff: null, output: null, rationale: null, flags: [],
      sourceBranchOverride: null, projectId: null, roadmapProposalId: null,
    };
    const ctx = statusContext(baseProject, [], [], [], [], [], [gate]);
    expect(ctx).toContain("1. Postgres");
    expect(ctx).toContain("2. MySQL");
  });
});

// ── 3) Operations — create/update normalization + persistence ───────────

class NullBus implements Bus {
  publish(_ws: string, _e: ServerEvent): void {}
  subscribe(): () => void {
    return () => {};
  }
}

class RunningProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  async start(spec: StartSpec, _events: RunnerEvents): Promise<RunnerHandle> {
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

function setup() {
  const store = new MemoryStore();
  const hub = new Hub(store, new NullBus());
  const ops = new Operations({ store, hub, orchestrator: new Orchestrator(store, hub, new RunningProvider()) });
  return { store, ops };
}

describe("Operations — instructions create + update normalization", () => {
  it("createProject stores instructions when provided, and trims", async () => {
    const { ops } = setup();
    const p = await ops.createProject(DEFAULT_WORKSPACE, {
      name: "Acme",
      goal: "",
      instructions: "\n  Use @acme/agents.\n  ",
    });
    expect(p.instructions).toBe("Use @acme/agents.");
  });

  it("createProject defaults to null when the field is omitted", async () => {
    const { ops } = setup();
    const p = await ops.createProject(DEFAULT_WORKSPACE, { name: "Acme", goal: "" });
    expect(p.instructions).toBeNull();
  });

  it("createProject normalizes whitespace-only to null", async () => {
    const { ops } = setup();
    const p = await ops.createProject(DEFAULT_WORKSPACE, { name: "Acme", goal: "", instructions: "  \n\t  " });
    expect(p.instructions).toBeNull();
  });

  it("updateProject sets instructions and clears them with an empty string or null", async () => {
    const { ops } = setup();
    const p = await ops.createProject(DEFAULT_WORKSPACE, { name: "Acme", goal: "" });
    // Set.
    const set = await ops.updateProject(DEFAULT_WORKSPACE, p.id, { instructions: "Rule 1" });
    expect(set.instructions).toBe("Rule 1");
    // Clear via null.
    const cleared = await ops.updateProject(DEFAULT_WORKSPACE, p.id, { instructions: null });
    expect(cleared.instructions).toBeNull();
    // Set again, then clear via an empty string (whitespace-only counts too).
    await ops.updateProject(DEFAULT_WORKSPACE, p.id, { instructions: "Rule 2" });
    const cleared2 = await ops.updateProject(DEFAULT_WORKSPACE, p.id, { instructions: "  " });
    expect(cleared2.instructions).toBeNull();
  });

  it("updateProject leaves instructions alone when the field is undefined in the patch", async () => {
    const { ops } = setup();
    const p = await ops.createProject(DEFAULT_WORKSPACE, {
      name: "Acme",
      goal: "",
      instructions: "Rules stay",
    });
    // Unrelated patch (autonomy). Instructions must not be touched.
    const after = await ops.updateProject(DEFAULT_WORKSPACE, p.id, { autonomy: false });
    expect(after.instructions).toBe("Rules stay");
    expect(after.autonomy).toBe(false);
  });
});

// ── 4) Orchestrator — the wiring itself: does instructions actually reach
// the StartSpec a runner receives? (1)-(3) above prove withInstructions() is
// correct and that Steward sees it, but not that assignTask/forkAgent (or any
// other call site) actually CALL it on the real request path — that's the
// gap this section closes. A RecordingProvider stands in for a real runner
// and captures every StartSpec handed to provider.start(); vendor-neutral, so
// this also proves the wiring for every CLI vendor (they receive the exact
// same StartSpec.task the orchestrator already built — see
// packages/runner-sdk/src/{codex,gemini,hermes}.ts, which pass spec.task
// through to argv verbatim, and cursor.ts/copilot.ts/claude.ts, which
// interpolate it into their own prompt template unchanged).

class RecordingProvider2 implements RunnerProvider {
  readonly id: ProviderId = "claude";
  specs: StartSpec[] = [];
  async start(spec: StartSpec, _events: RunnerEvents): Promise<RunnerHandle> {
    this.specs.push(spec);
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

async function setupRecording() {
  const store = new MemoryStore();
  const hub = new Hub(store, new NullBus());
  const provider = new RecordingProvider2();
  const orchestrator = new Orchestrator(store, hub, provider);
  const ops = new Operations({ store, hub, orchestrator });
  // A fleet runner to assign onto — RecordingProvider2 never actually runs
  // anything, but assignTask still needs one to acquire.
  const runner: Agent = {
    id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1",
    provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0,
  } as Agent;
  await store.putAgent(runner);
  return { store, ops, orchestrator, provider };
}

describe("Orchestrator — StartSpec.task actually carries Project.instructions", () => {
  it("assignTask: the runner's StartSpec.task is prefixed with the PROJECT INSTRUCTIONS banner", async () => {
    const { ops, provider } = await setupRecording();
    const p = await ops.createProject(DEFAULT_WORKSPACE, {
      name: "Acme",
      goal: "",
      instructions: "Always use tabs, never semicolons.",
    });
    const t = await ops.createTask(DEFAULT_WORKSPACE, p.id, { text: "Add a health check endpoint" });
    await ops.assignTask(DEFAULT_WORKSPACE, p.id, t.id);

    expect(provider.specs).toHaveLength(1);
    const { task } = provider.specs[0]!;
    expect(task).toContain("=== PROJECT INSTRUCTIONS");
    expect(task).toContain("Always use tabs, never semicolons.");
    expect(task).toContain("Add a health check endpoint");
  });

  it("assignTask: a project with no instructions is a true no-op (no banner)", async () => {
    const { ops, provider } = await setupRecording();
    const p = await ops.createProject(DEFAULT_WORKSPACE, { name: "Acme", goal: "" });
    const t = await ops.createTask(DEFAULT_WORKSPACE, p.id, { text: "Add a health check endpoint" });
    await ops.assignTask(DEFAULT_WORKSPACE, p.id, t.id);

    const { task } = provider.specs[0]!;
    expect(task).not.toContain("PROJECT INSTRUCTIONS");
    expect(task).toContain("Add a health check endpoint");
  });

  it("forkAgent: the fork's StartSpec.task ALSO carries the project's instructions", async () => {
    const { ops, provider } = await setupRecording();
    const p = await ops.createProject(DEFAULT_WORKSPACE, {
      name: "Acme",
      goal: "",
      instructions: "Use @acme/agents for all new agent code.",
    });
    const t = await ops.createTask(DEFAULT_WORKSPACE, p.id, { text: "Add a health check endpoint" });
    const run = await ops.assignTask(DEFAULT_WORKSPACE, p.id, t.id);
    provider.specs.length = 0; // only care about the fork's own spec below

    const forked = await ops.forkAgent(DEFAULT_WORKSPACE, run.id);

    expect(provider.specs).toHaveLength(1);
    const { task } = provider.specs[0]!;
    expect(task).toContain("=== PROJECT INSTRUCTIONS");
    expect(task).toContain("Use @acme/agents for all new agent code.");
    expect(forked.parentId).toBe(run.id);
  });
});

// ── 5) buildAgentContext wiring — goal + feature threading ───────────────
// S1: every agent-facing prompt now runs through buildAgentContext, which adds
// the project's goal and (when the task belongs to one) the Feature — on top
// of the instructions banner already proven above. These pin that the two
// NEW sections actually reach the runner's StartSpec.task on the two call
// sites this file already exercises (assignTask/forkAgent); the deeper
// resume/revise/escalation-resume paths are covered in
// tests/agent-context-wiring.test.ts (they need a real git worktree to reach).

describe("Orchestrator — StartSpec.task carries Project.goal and the task's Feature", () => {
  it("assignTask: the goal appears under its own === PROJECT === section", async () => {
    const { ops, provider } = await setupRecording();
    const p = await ops.createProject(DEFAULT_WORKSPACE, { name: "Acme", goal: "Ship the checkout redesign" });
    const t = await ops.createTask(DEFAULT_WORKSPACE, p.id, { text: "Add a health check endpoint" });
    await ops.assignTask(DEFAULT_WORKSPACE, p.id, t.id);

    const { task } = provider.specs[0]!;
    expect(task).toContain("=== PROJECT ===");
    expect(task).toContain("Ship the checkout redesign");
    expect(task.indexOf("=== PROJECT ===")).toBeLessThan(task.indexOf("=== TASK ==="));
  });

  it("assignTask: an empty goal emits no === PROJECT === section", async () => {
    const { ops, provider } = await setupRecording();
    const p = await ops.createProject(DEFAULT_WORKSPACE, { name: "Acme", goal: "" });
    const t = await ops.createTask(DEFAULT_WORKSPACE, p.id, { text: "Add a health check endpoint" });
    await ops.assignTask(DEFAULT_WORKSPACE, p.id, t.id);

    const { task } = provider.specs[0]!;
    expect(task).not.toContain("=== PROJECT ===");
  });

  it("assignTask: a feature-member task's brief carries the feature's name + description", async () => {
    const { ops, provider } = await setupRecording();
    const p = await ops.createProject(DEFAULT_WORKSPACE, { name: "Acme", goal: "" });
    const feature = await ops.createFeature(DEFAULT_WORKSPACE, p.id, {
      name: "Checkout redesign",
      description: "A new one-page checkout flow.",
    });
    const t = await ops.createTask(DEFAULT_WORKSPACE, p.id, { text: "Add a health check endpoint" });
    await ops.updateTask(DEFAULT_WORKSPACE, t.id, { featureId: feature.id });
    await ops.assignTask(DEFAULT_WORKSPACE, p.id, t.id);

    const { task } = provider.specs[0]!;
    expect(task).toContain("=== FEATURE ===");
    expect(task).toContain("Checkout redesign");
    expect(task).toContain("A new one-page checkout flow.");
  });

  it("assignTask: a task with no feature emits no === FEATURE === section", async () => {
    const { ops, provider } = await setupRecording();
    const p = await ops.createProject(DEFAULT_WORKSPACE, { name: "Acme", goal: "" });
    const t = await ops.createTask(DEFAULT_WORKSPACE, p.id, { text: "Add a health check endpoint" });
    await ops.assignTask(DEFAULT_WORKSPACE, p.id, t.id);

    const { task } = provider.specs[0]!;
    expect(task).not.toContain("=== FEATURE ===");
  });

  it("forkAgent: the fork's brief ALSO carries the project's goal", async () => {
    const { ops, provider } = await setupRecording();
    const p = await ops.createProject(DEFAULT_WORKSPACE, { name: "Acme", goal: "Ship the checkout redesign" });
    const t = await ops.createTask(DEFAULT_WORKSPACE, p.id, { text: "Add a health check endpoint" });
    const run = await ops.assignTask(DEFAULT_WORKSPACE, p.id, t.id);
    provider.specs.length = 0;

    await ops.forkAgent(DEFAULT_WORKSPACE, run.id);

    const { task } = provider.specs[0]!;
    expect(task).toContain("=== PROJECT ===");
    expect(task).toContain("Ship the checkout redesign");
  });
});

// Reserved-name imports kept so future tests can extend without re-adding.
void (undefined as unknown as Task);
void (undefined as unknown as TaskRun);
