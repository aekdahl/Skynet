// Project.roadmapPath lets the operator (or Steward, via a confirmed
// set_roadmap_path action) point the Roadmap tab at a file other than the two
// default candidates (ROADMAP.md / docs/ROADMAP.md) — the fix for a repo that
// keeps its roadmap somewhere else entirely, where the tab used to be a dead
// end. resolveRoadmapDoc is the ONE place both operations.ts's
// getProjectRoadmap and Steward's own grounding resolve the doc through, so
// testing it here covers both callers.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Project, DEFAULT_WORKSPACE } from "@skynet/shared";
import { resolveRoadmapDoc } from "../apps/server/src/steward/docs.js";

const WS = DEFAULT_WORKSPACE;
const project = (repoPath: string, roadmapPath: string | null = null): Project =>
  Project.parse({
    id: "p-1", workspaceId: WS, name: "Takeoff", goal: "ship", runIds: [], status: "active",
    repoPath, roadmapPath,
  });

describe("resolveRoadmapDoc — default candidates vs. an explicit override", () => {
  it("with no override, falls back to the default candidates (unchanged behavior)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rdp-repo-"));
    try {
      writeFileSync(join(repo, "ROADMAP.md"), "# Roadmap\n");
      const doc = await resolveRoadmapDoc(WS, project(repo));
      expect(doc).toMatchObject({ path: "ROADMAP.md", source: "local" });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("an explicit override is tried EXCLUSIVELY — ignores ROADMAP.md even when it exists", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rdp-repo-"));
    try {
      writeFileSync(join(repo, "ROADMAP.md"), "# Not this one\n");
      mkdirSync(join(repo, "docs"), { recursive: true });
      writeFileSync(join(repo, "docs", "PLAN.md"), "# The real plan\n");
      const doc = await resolveRoadmapDoc(WS, project(repo, "docs/PLAN.md"));
      expect(doc).toMatchObject({ path: "docs/PLAN.md", content: "# The real plan\n", source: "local" });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("an override pointing at a file that doesn't exist is honestly 'not found' — no silent fall back to the defaults", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rdp-repo-"));
    try {
      writeFileSync(join(repo, "ROADMAP.md"), "# Would be found by default, but isn't tried\n");
      const doc = await resolveRoadmapDoc(WS, project(repo, "docs/GONE.md"));
      expect(doc).toBeNull();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
