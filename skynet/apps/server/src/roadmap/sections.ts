// ─── Roadmap sections (Phase 24) ────────────────────────────────────────────
// A coarse, stable-id'd grouping over the ast by level-2 (`##`) heading — see
// RoadmapSection's own doc comment in packages/shared/src/roadmap-doc.ts for
// why `##` specifically. Purely derived from the ast; carries no raw text of
// its own (the ast already has that), just which line ids fall under which
// heading.

import type { RoadmapAstNode, RoadmapSection } from "@skynet/shared";
import { hashLineText } from "./identity.js";

export function buildSections(ast: RoadmapAstNode[]): RoadmapSection[] {
  const sections: RoadmapSection[] = [];
  // The preamble (H1 + intro prose before the first `##`) is always sections[0],
  // even when empty — stable indexing for callers, at the cost of one
  // possibly-empty entry.
  let current: RoadmapSection = { id: hashLineText(""), heading: null, level: 0, lineIds: [] };

  for (const node of ast) {
    if (node.type === "heading" && node.level <= 2) {
      sections.push(current);
      current = { id: hashLineText(node.text), heading: node.text, level: node.level, lineIds: [] };
      continue;
    }
    if (node.type === "checklistItem") current.lineIds.push(node.id);
  }
  sections.push(current);
  return sections;
}
