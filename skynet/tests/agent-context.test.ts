// buildAgentContext (S1: shared agent-context assembler) — the pure
// composition function every orchestrator call site now threads through
// instead of hand-rolling withInstructions(...). Orchestrator-level wiring
// (does the RIGHT project/feature/task actually reach the runner's
// StartSpec.task, at each call site) is pinned in
// tests/project-instructions.test.ts and tests/agent-context-wiring.test.ts;
// this file is the composition primitive itself — section order, omission
// rules, and the total-budget truncation.
import { describe, it, expect } from "vitest";
import type { Feature, Project } from "@skynet/shared";
import { buildAgentContext } from "../apps/server/src/agent-context.js";

type ContextProject = Pick<Project, "name" | "goal" | "instructions">;

const project = (over: Partial<ContextProject> = {}): ContextProject => ({
  name: "Acme",
  goal: "",
  instructions: null,
  ...over,
});

const feature = (over: Partial<Feature> = {}): Feature => ({
  id: "f1",
  workspaceId: "ws",
  projectId: "p1",
  name: "Checkout redesign",
  description: null,
  status: "active",
  milestoneId: null,
  archived: false,
  createdAt: 0,
  pr: null,
  sizeWarning: null,
  ...over,
});

describe("buildAgentContext — section presence + order", () => {
  it("with nothing set beyond a body, emits only === TASK ===", () => {
    const out = buildAgentContext({ project: null, body: "Add a health check endpoint" });
    expect(out).toBe("=== TASK ===\nAdd a health check endpoint");
  });

  it("emits === PROJECT === with name + goal only when the goal is non-empty", () => {
    const withGoal = buildAgentContext({ project: project({ goal: "Ship the checkout redesign" }), body: "task" });
    expect(withGoal).toContain("=== PROJECT ===");
    expect(withGoal).toContain("Acme");
    expect(withGoal).toContain("Ship the checkout redesign");

    const noGoal = buildAgentContext({ project: project({ goal: "" }), body: "task" });
    expect(noGoal).not.toContain("=== PROJECT ===");

    const whitespaceGoal = buildAgentContext({ project: project({ goal: "   \n " }), body: "task" });
    expect(whitespaceGoal).not.toContain("=== PROJECT ===");
  });

  it("emits === PROJECT INSTRUCTIONS === only when instructions are set (same semantics as withInstructions)", () => {
    const withRules = buildAgentContext({ project: project({ instructions: "Use tabs." }), body: "task" });
    expect(withRules).toContain("=== PROJECT INSTRUCTIONS");
    expect(withRules).toContain("Use tabs.");

    const noRules = buildAgentContext({ project: project({ instructions: null }), body: "task" });
    expect(noRules).not.toContain("PROJECT INSTRUCTIONS");
  });

  it("emits === FEATURE === with name + description only when a feature is passed", () => {
    const withFeature = buildAgentContext({
      project: project(),
      feature: feature({ description: "A new one-page checkout flow." }),
      body: "task",
    });
    expect(withFeature).toContain("=== FEATURE ===");
    expect(withFeature).toContain("Checkout redesign");
    expect(withFeature).toContain("A new one-page checkout flow.");

    const noDescription = buildAgentContext({ project: project(), feature: feature({ description: null }), body: "task" });
    expect(noDescription).toContain("Checkout redesign");

    const noFeature = buildAgentContext({ project: project(), body: "task" });
    expect(noFeature).not.toContain("=== FEATURE ===");
  });

  it("emits === PRIMER === / === SOLUTION BRIEF === / === IN FLIGHT === only when set (S2/S3/S8 plumbing)", () => {
    const bare = buildAgentContext({ project: project(), body: "task" });
    expect(bare).not.toContain("=== PRIMER ===");
    expect(bare).not.toContain("=== SOLUTION BRIEF ===");
    expect(bare).not.toContain("=== IN FLIGHT ===");

    const full = buildAgentContext({
      project: project(),
      primer: "Read the ARCHITECTURE.md before starting.",
      brief: "The solution is a two-phase migration.",
      siblings: ["agent/a1 is refactoring the same module"],
      body: "task",
    });
    expect(full).toContain("=== PRIMER ===");
    expect(full).toContain("Read the ARCHITECTURE.md before starting.");
    expect(full).toContain("=== SOLUTION BRIEF ===");
    expect(full).toContain("The solution is a two-phase migration.");
    expect(full).toContain("=== IN FLIGHT ===");
    expect(full).toContain("agent/a1 is refactoring the same module");
  });

  it("always emits === TASK === with the body, even when every other section is present", () => {
    const out = buildAgentContext({
      project: project({ goal: "Ship it", instructions: "Use tabs." }),
      feature: feature(),
      primer: "primer text",
      brief: "brief text",
      siblings: ["sibling"],
      body: "Add a health check endpoint",
    });
    expect(out).toContain("=== TASK ===\nAdd a health check endpoint");
    expect(out.endsWith("Add a health check endpoint")).toBe(true); // TASK is always last
  });

  it("sections appear in the fixed order: PROJECT, INSTRUCTIONS, PRIMER, FEATURE, SOLUTION BRIEF, IN FLIGHT, TASK", () => {
    const out = buildAgentContext({
      project: project({ goal: "Ship it", instructions: "Use tabs." }),
      feature: feature(),
      primer: "primer text",
      brief: "brief text",
      siblings: ["sibling"],
      body: "the ask",
    });
    const order = ["=== PROJECT ===", "=== PROJECT INSTRUCTIONS", "=== PRIMER ===", "=== FEATURE ===", "=== SOLUTION BRIEF ===", "=== IN FLIGHT ===", "=== TASK ==="];
    const indices = order.map((marker) => out.indexOf(marker));
    expect(indices.every((i) => i >= 0)).toBe(true);
    for (let i = 1; i < indices.length; i++) expect(indices[i]).toBeGreaterThan(indices[i - 1]!);
  });
});

describe("buildAgentContext — total-budget truncation", () => {
  it("drops === IN FLIGHT === first when the assembled context runs over budget", () => {
    const shortPrimer = "short primer text";
    // 10 siblings each near their own per-item cap — enough on its own to tip
    // an otherwise-under-budget context over the total cap.
    const manySiblings = Array.from({ length: 10 }, (_, i) => `sibling run agent/${i} is touching the shared module `.repeat(4));
    const out = buildAgentContext({
      project: project({ goal: "g" }),
      primer: shortPrimer,
      siblings: manySiblings,
      body: "y".repeat(4_200),
    });
    expect(out).not.toContain("=== IN FLIGHT ===");
    // Primer survives untouched — siblings were the first (and, here, only)
    // thing dropped; there was nothing left to shave.
    expect(out).toContain("=== PRIMER ===");
    expect(out).toContain(shortPrimer);
    // The task body is NEVER truncated.
    expect(out).toContain("y".repeat(4_200));
  });

  it("shaves the primer's tail (never the task body or instructions) once dropping siblings alone isn't enough", () => {
    const hugePrimer = "p".repeat(5_000);
    const instructions = "Always use tabs, never semicolons.";
    const out = buildAgentContext({
      project: project({ instructions }),
      primer: hugePrimer,
      siblings: ["one sibling"],
      body: "z".repeat(4_500),
    });
    expect(out).not.toContain("=== IN FLIGHT ===");
    expect(out).toContain("=== PRIMER ===");
    // The primer's tail was shaved — the full 5,000-char primer no longer fits.
    expect(out).not.toContain(hugePrimer);
    // Instructions and the task body are always intact, verbatim, regardless.
    expect(out).toContain(instructions);
    expect(out).toContain("z".repeat(4_500));
  });

  it("never truncates PROJECT INSTRUCTIONS or the task body even when both alone exceed the total budget", () => {
    const longInstructions = "Rule. ".repeat(2_000); // ~12,000 chars on its own
    const longBody = "Ask. ".repeat(2_000);
    const out = buildAgentContext({ project: project({ instructions: longInstructions }), body: longBody });
    expect(out).toContain(longInstructions.trim());
    expect(out).toContain(longBody);
  });
});
