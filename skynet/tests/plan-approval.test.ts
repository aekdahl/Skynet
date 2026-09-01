// stepRequiresApproval — the Run Detail plan panel's "· needs approval" hint
// (TASK 17). Best-effort only: never itself gates/blocks/auto-approves
// anything (the real gate is classifyCommand at Orchestrator.raise() time
// against the actual tool call) — this only predicts from a plan step's
// free-form prose ahead of time.
import { describe, it, expect } from "vitest";
import { DEFAULT_COMMAND_POLICY } from "../apps/server/src/command-safety.js";
import { stepRequiresApproval } from "../apps/server/src/derive/plan-approval.js";

describe("stepRequiresApproval", () => {
  it("classifies a backtick-quoted read-only command as not requiring approval", () => {
    expect(stepRequiresApproval("Run `git status`", DEFAULT_COMMAND_POLICY)).toBe(false);
  });

  it("classifies a backtick-quoted destructive command as requiring approval", () => {
    expect(stepRequiresApproval("Run `rm -rf dist`", DEFAULT_COMMAND_POLICY)).toBe(true);
  });

  it("falls back to a category keyword when there's no command to classify", () => {
    expect(stepRequiresApproval("Merge the feature branch into main", DEFAULT_COMMAND_POLICY)).toBe(true);
    expect(stepRequiresApproval("Run the database migration", DEFAULT_COMMAND_POLICY)).toBe(true);
  });

  it("plain prose naming neither a command nor a gated category doesn't require approval", () => {
    expect(stepRequiresApproval("Write the README section on installation", DEFAULT_COMMAND_POLICY)).toBe(false);
  });

  it("never throws on a malformed step (e.g. a provider/test double whose plan step has no `text`)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately runtime-malformed input
    expect(stepRequiresApproval(undefined as any, DEFAULT_COMMAND_POLICY)).toBe(false);
  });
});
