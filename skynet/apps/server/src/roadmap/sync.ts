// ─── Roadmap doc parse orchestration (Phase 24) ─────────────────────────────
// Ties the pure pieces (ast.ts, identity.ts, sections.ts) into one
// `RoadmapDoc`. Pure itself — no repo I/O, no store — so it's testable with
// nothing but strings. See Operations.syncProjectRoadmap for the part that
// actually reads a project's repo and persists the result.

import type { RoadmapDoc } from "@skynet/shared";
import { parseRoadmapAst } from "./ast.js";
import { assignLineIdentity } from "./identity.js";
import { buildSections } from "./sections.js";

export function parseRoadmapDoc(input: {
  workspaceId: string;
  projectId: string;
  path: string;
  raw: string;
  commitSha: string | null;
  syncedAt: number;
  previousAst?: RoadmapDoc["ast"] | null;
}): RoadmapDoc {
  const parsed = parseRoadmapAst(input.raw);
  const ast = assignLineIdentity(parsed, input.previousAst);
  return {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    path: input.path,
    commitSha: input.commitSha,
    syncedAt: input.syncedAt,
    syncState: "in_sync",
    raw: input.raw,
    ast,
    sections: buildSections(ast),
  };
}
