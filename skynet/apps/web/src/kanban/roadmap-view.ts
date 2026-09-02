// ─── Roadmap document view — pure shaping (Phase 26 — TASK 29) ─────────────
// Groups a parsed RoadmapDoc's flat AST into sections + their lines, and
// picks the fenced "machine-managed" blocks out of it — kept separate from
// roadmap-view.tsx (the rendering layer) specifically so it's testable
// without a DOM, same rationale as health-metrics.ts/home-metrics.ts.
import type { RoadmapAstNode, RoadmapChecklistItemNode } from "@skynet/shared";

export interface RoadmapSectionView {
  /** null for any content before the first `##` heading. */
  headingText: string | null;
  /** The first paragraph immediately after the heading, before any
   *  checklist item/hr/table — the section's own "why this exists" prose,
   *  when the doc has one. null when there isn't one. */
  intent: string | null;
  lines: RoadmapChecklistItemNode[];
}

/** Walks the AST once, splitting on every level-2 heading. A checklist item
 *  at any indent counts (nesting isn't modeled separately — see this
 *  module's own top comment on scope); a paragraph only becomes `intent`
 *  when it's the FIRST real content after the heading (an intent line that
 *  comes after the checklist has started is just body prose, not a header). */
export function groupRoadmapSections(ast: RoadmapAstNode[]): RoadmapSectionView[] {
  const out: RoadmapSectionView[] = [];
  let current: RoadmapSectionView = { headingText: null, intent: null, lines: [] };
  let pastIntentPosition = false;
  const hasContent = (s: RoadmapSectionView) => s.headingText != null || s.intent != null || s.lines.length > 0;

  for (const node of ast) {
    if (node.type === "heading" && node.level === 2) {
      if (hasContent(current)) out.push(current);
      current = { headingText: node.text, intent: null, lines: [] };
      pastIntentPosition = false;
      continue;
    }
    if (node.type === "checklistItem") {
      current.lines.push(node);
      pastIntentPosition = true;
      continue;
    }
    if (node.type === "paragraph") {
      if (!pastIntentPosition && current.intent == null) current.intent = node.text;
      pastIntentPosition = true;
      continue;
    }
    if (node.type !== "blank") pastIntentPosition = true;
  }
  if (hasContent(current)) out.push(current);
  return out;
}

export interface MachineBlock {
  /** Stable-enough key for React's list rendering — the block's own raw text
   *  hashed isn't worth it at this scale; position in the doc is enough. */
  index: number;
  /** The fence's info-string, if any (e.g. "yaml" in ` ```yaml `) — used as
   *  a header label when present. */
  lang: string | null;
  /** Fence-delimiter lines stripped; each entry is one line of content. */
  lines: string[];
}

const FENCE_OPEN_RE = /^\s*(`{3,}|~{3,})\s*([\w-]*)\s*$/;

/** Every fenced code block in the doc — `ast.ts`'s "other" catch-all node
 *  type is the only thing a code fence parses to (see ast.ts's own comment:
 *  a fence is consumed verbatim as one opaque node). A ROADMAP.md fence is
 *  the closest thing to a machine-generated, not-hand-edited block this
 *  doc's markdown convention has room for (see RoadmapStateBlock's own doc
 *  comment) — rendered distinctly (mono, collapsible) rather than as a
 *  generic paragraph. */
export function machineBlocks(ast: RoadmapAstNode[]): MachineBlock[] {
  const out: MachineBlock[] = [];
  ast.forEach((node, index) => {
    if (node.type !== "other") return;
    // `raw` is the opening fence line through the closing fence line (or
    // through EOF if never closed — see ast.ts's own fence-consuming loop),
    // each physical line still carrying its own trailing "\n". Splitting on
    // "\n" then leaves a trailing "" artifact for any raw text that itself
    // ends in a newline — drop it before inspecting the real last line.
    const physicalLines = node.raw.split("\n");
    if (physicalLines[physicalLines.length - 1] === "") physicalLines.pop();
    const openMatch = FENCE_OPEN_RE.exec(physicalLines[0] ?? "");
    if (!openMatch) return; // "other" also covers blockquotes etc. — only a real fence counts
    const last = physicalLines[physicalLines.length - 1] ?? "";
    const closed = physicalLines.length > 1 && FENCE_OPEN_RE.test(last);
    const lines = closed ? physicalLines.slice(1, -1) : physicalLines.slice(1);
    out.push({ index, lang: openMatch[2] || null, lines });
  });
  return out;
}

/** A fenced block's line, classified for coloring — a `#`/`//`/`<!--`
 *  comment reads dim (text-faint); a line whose ONLY meaningful token is a
 *  recognized state word gets that state's meaning color; everything else
 *  is plain content. */
export type MachineLineKind = "comment" | "state-done" | "state-in-progress" | "state-todo" | "plain";

const STATE_WORDS: Record<string, MachineLineKind> = {
  done: "state-done", shipped: "state-done", complete: "state-done", completed: "state-done",
  "in_progress": "state-in-progress", "in-progress": "state-in-progress", "in-flight": "state-in-progress", inflight: "state-in-progress",
  todo: "state-todo", pending: "state-todo", blocked: "state-todo",
};

export function classifyMachineLine(line: string): MachineLineKind {
  const trimmed = line.trim();
  if (trimmed.startsWith("#") || trimmed.startsWith("//") || trimmed.startsWith("<!--")) return "comment";
  const bareWord = /^[\w-]+$/.test(trimmed) ? trimmed.toLowerCase() : null;
  const trailingWord = /[:=]\s*([\w-]+)\s*,?$/.exec(trimmed)?.[1]?.toLowerCase() ?? null;
  const word = bareWord ?? trailingWord;
  if (word && STATE_WORDS[word]) return STATE_WORDS[word]!;
  return "plain";
}
