import { describe, it, expect } from "vitest";
import { HitlItem, Resolution } from "@skynet/shared";
import { decisionResumePrompt } from "../apps/server/src/decision-resume.js";

// The recovery prompt is pure string assembly off the ALREADY-structured
// decision (action / optionIndex / guidance) — no parsing of free text. These
// pin the per-kind × per-action wording so the re-acquired runner is told
// exactly what the operator decided and to reorient from its worktree.

const item = (over: Partial<HitlItem>): HitlItem =>
  HitlItem.parse({
    id: "q-1",
    workspaceId: "w",
    runId: "r-1",
    kind: "approval",
    title: "run a shell command",
    why: "touches the filesystem",
    risk: "medium",
    raisedAt: 1,
    ...over,
  });

const res = (over: Partial<Resolution>): Resolution =>
  Resolution.parse({ action: "approve", by: "op", at: 2, ...over });

describe("decisionResumePrompt", () => {
  it("approval + approve → proceed with the paused action, incl. the command", () => {
    const p = decisionResumePrompt(item({ kind: "approval", command: "rm -rf build" }), res({ action: "approve" }), "run/r-1");
    expect(p).toMatch(/operator approved the action you paused on — rm -rf build/);
    expect(p).toMatch(/Proceed with it now/);
    expect(p).toMatch(/branch run\/r-1/); // reorient tail names the worktree branch
  });

  it("approval + reject → do not proceed, revise", () => {
    const p = decisionResumePrompt(item({ kind: "approval", command: "git push --force" }), res({ action: "reject" }), "b");
    expect(p).toMatch(/rejected the action you paused on — git push --force/);
    expect(p).toMatch(/Do not proceed/);
  });

  it("approval + modify → carries the operator directive verbatim", () => {
    const p = decisionResumePrompt(item({ kind: "approval" }), res({ action: "modify", guidance: "use the staging bucket, not prod" }), "b");
    expect(p).toMatch(/directive: use the staging bucket, not prod/);
  });

  it("question + option → delivers the chosen option as the answer", () => {
    const p = decisionResumePrompt(
      item({ kind: "question", title: "which DB?", options: ["Postgres", "SQLite"] }),
      res({ action: "option", optionIndex: 1 }),
      "b",
    );
    expect(p).toMatch(/You paused to ask: "which DB\?"/);
    expect(p).toMatch(/operator answered: SQLite/);
  });

  it("question + free-form guidance (no option) → delivers the guidance", () => {
    const p = decisionResumePrompt(
      item({ kind: "question", title: "which region?", options: ["us", "eu"] }),
      res({ action: "modify", guidance: "ap-southeast-1" }),
      "b",
    );
    expect(p).toMatch(/operator answered: ap-southeast-1/);
  });

  it("question with neither option nor guidance → best-judgement fallback", () => {
    const p = decisionResumePrompt(item({ kind: "question", title: "?", options: ["a", "b"] }), res({ action: "approve" }), "b");
    expect(p).toMatch(/best judgement/);
  });

  it("plan + approve → execute the plan", () => {
    const p = decisionResumePrompt(item({ kind: "plan", title: "migration plan" }), res({ action: "approve" }), "b");
    expect(p).toMatch(/approved the plan you proposed/);
  });

  it("every prompt tells the fresh session to reorient from the worktree", () => {
    for (const kind of ["approval", "question", "plan"] as const) {
      const p = decisionResumePrompt(item({ kind, options: kind === "question" ? ["x"] : null }), res({ action: "approve" }), "b");
      expect(p).toMatch(/read the working directory to reorient/);
    }
  });
});
