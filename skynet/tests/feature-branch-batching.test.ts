// Feature-scoped branch batching (ROADMAP.md): a task under a Feature merges
// into a shared `skynet/feature/<id>` branch (step 1) instead of its own PR;
// once every task under it is done, that branch merges up into the project's
// integration branch or opens one aggregate PR (step 2). The heavy real-git
// coverage lives in merge.test.ts — this file is the pure discriminator
// orchestrator.ts's callback wiring / HITL raising rely on to tell step 2
// (no single owning run) apart from step 1 and the default per-run merge.
import { describe, it, expect } from "vitest";
import { isFeatureUpMerge } from "../apps/server/src/orchestrator.js";
import type { MergeRequest } from "../apps/server/src/merge.js";

const base = { runId: "r-1", projectId: "payments", workspaceId: "cyberdyne" };

describe("isFeatureUpMerge", () => {
  it("is false for a normal per-run merge (no feature involved)", () => {
    const req: MergeRequest = { ...base, agentBranch: "agent/r-1" };
    expect(isFeatureUpMerge(req)).toBe(false);
  });

  it("is false for step 1 — a task merging INTO its feature branch (featureId set)", () => {
    const req: MergeRequest = { ...base, agentBranch: "agent/r-1", featureId: "f-1" };
    expect(isFeatureUpMerge(req)).toBe(false);
  });

  it("is true for step 2 — the feature branch itself merging up (source is a feature branch, no destination featureId)", () => {
    const req: MergeRequest = { ...base, agentBranch: "skynet/feature/f-1" };
    expect(isFeatureUpMerge(req)).toBe(true);
  });

  it("is false if both featureId and a feature-branch source are set (destination override always wins — not a real request shape orchestrator.ts ever builds, but the discriminator must stay unambiguous)", () => {
    const req: MergeRequest = { ...base, agentBranch: "skynet/feature/f-1", featureId: "f-2" };
    expect(isFeatureUpMerge(req)).toBe(false);
  });
});
