// ─── Roadmap markdown → AST (Phase 24) ──────────────────────────────────────
// Splits a ROADMAP.md file into blocks WITHOUT line identity (see identity.ts
// for that) or a project/commit wrapper (see sync.ts). The one hard guarantee
// this file exists to keep: `serializeRoadmapAst(parseRoadmapAst(raw)) ===
// raw` for ANY input, always.
//
// That guarantee holds by construction, not by careful reconstruction: every
// node keeps `raw`, the EXACT original source span it came from (including
// its own trailing newline), and serialization is just
// `ast.map(n => n.raw).join("")`. Metadata (heading level, checklist marker,
// extracted links, table cells) is read OFF that raw text, never used to
// regenerate it — so a markdown shape this parser doesn't deeply model (a
// code fence, a blockquote — neither appears in ROADMAP.md today, but might
// later) still round-trips untouched via the "other" catch-all.

import type {
  RoadmapAstNode,
  RoadmapChecklistItemNode,
  RoadmapHeadingNode,
  RoadmapHrNode,
  RoadmapLink,
  RoadmapListItemNode,
  RoadmapParagraphNode,
  RoadmapTableNode,
} from "@skynet/shared";

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*$/;
const HR_RE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const CHECKLIST_RE = /^(\s*)([-*+])\s+\[([ xX~])\]\s+(.*?)\s*$/;
const LIST_ITEM_RE = /^(\s*)([-*+])\s+(.*?)\s*$/;
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const LINK_RE = /\[([^\]]*)\]\(([^)]*)\)/g;

/** Splits `raw` into physical lines, each KEEPING its own trailing `\n` (or
 *  none, for a final line with no trailing newline). Joining the result with
 *  `""` reproduces `raw` exactly — the one primitive everything else here is
 *  built on. */
function splitLinesKeepEnds(raw: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "\n") {
      lines.push(raw.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < raw.length) lines.push(raw.slice(start));
  return lines;
}

function stripEol(line: string): string {
  return line.endsWith("\n") ? line.slice(0, -1) : line;
}

function extractLinks(text: string): RoadmapLink[] {
  const links: RoadmapLink[] = [];
  for (const m of text.matchAll(LINK_RE)) links.push({ text: m[1]!, url: m[2]! });
  return links;
}

/** Splits a GFM table row on unescaped `|`, trimming each cell and dropping
 *  the empty cell a row's own leading/trailing pipe produces. `\|` inside a
 *  cell is unescaped to a literal `|`, same as GFM itself renders it. */
function splitTableRow(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\" && line[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (c === "|") {
      cells.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  cells.push(cur);
  if (cells.length && cells[0]!.trim() === "") cells.shift();
  if (cells.length && cells[cells.length - 1]!.trim() === "") cells.pop();
  return cells.map((c) => c.trim());
}

/** Parse `raw` ROADMAP.md content into an ordered, byte-preserving AST. Pure —
 *  no line identity assigned yet (every checklistItem's `id` is `""` here;
 *  see identity.ts's `assignLineIdentity`, which is the only thing allowed to
 *  fill it in). */
export function parseRoadmapAst(raw: string): RoadmapAstNode[] {
  const physical = splitLinesKeepEnds(raw);
  const nodes: RoadmapAstNode[] = [];
  let i = 0;

  while (i < physical.length) {
    const line = physical[i]!;
    const content = stripEol(line);

    // Fenced code block — consume through the matching close fence (or EOF),
    // verbatim, as one opaque node.
    const fenceMatch = FENCE_RE.exec(content);
    if (fenceMatch) {
      const fence = fenceMatch[1]!;
      let raw2 = line;
      let j = i + 1;
      while (j < physical.length) {
        raw2 += physical[j]!;
        const closed = stripEol(physical[j]!).trim() === fence || new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`).test(stripEol(physical[j]!));
        j++;
        if (closed) break;
      }
      nodes.push({ type: "other", raw: raw2 });
      i = j;
      continue;
    }

    if (content.trim() === "") {
      nodes.push({ type: "blank", raw: line });
      i++;
      continue;
    }

    const heading = HEADING_RE.exec(content);
    if (heading) {
      const node: RoadmapHeadingNode = { type: "heading", level: heading[1]!.length, text: heading[2]!, raw: line };
      nodes.push(node);
      i++;
      continue;
    }

    // HR must be checked before checklist/list — `---` alone would otherwise
    // never reach a bullet regex anyway (no `[`/text after it), but check
    // order explicitly so intent is clear.
    if (HR_RE.test(content)) {
      const node: RoadmapHrNode = { type: "hr", raw: line };
      nodes.push(node);
      i++;
      continue;
    }

    const checklist = CHECKLIST_RE.exec(content);
    if (checklist) {
      const text = checklist[4]!;
      const node: RoadmapChecklistItemNode = {
        type: "checklistItem",
        id: "", // assigned by identity.ts
        indent: checklist[1]!.length,
        marker: checklist[3]! as " " | "x" | "~",
        text,
        checked: checklist[3]!.toLowerCase() === "x",
        state: checklist[3]! === "~" ? "in_progress" : checklist[3]!.toLowerCase() === "x" ? "done" : "todo",
        links: extractLinks(text),
        acceptanceCriteria: null,
        author: null,
        authorRef: null,
        addedAt: null,
        claimedByHuman: false,
        taskIds: [],
        promisedDate: null,
        forecast: null,
        questionIds: [],
        raw: line,
      };
      nodes.push(node);
      i++;
      continue;
    }

    const listItem = LIST_ITEM_RE.exec(content);
    if (listItem) {
      const text = listItem[3]!;
      const node: RoadmapListItemNode = { type: "listItem", indent: listItem[1]!.length, text, links: extractLinks(text), raw: line };
      nodes.push(node);
      i++;
      continue;
    }

    if (TABLE_ROW_RE.test(content)) {
      let raw2 = line;
      const rows: string[][] = [splitTableRow(content)];
      let j = i + 1;
      while (j < physical.length && TABLE_ROW_RE.test(stripEol(physical[j]!))) {
        rows.push(splitTableRow(stripEol(physical[j]!)));
        raw2 += physical[j]!;
        j++;
      }
      const node: RoadmapTableNode = { type: "table", rows, raw: raw2 };
      nodes.push(node);
      i = j;
      continue;
    }

    // Paragraph — group consecutive plain-text lines (a bolded intro that
    // wraps across source lines) into one node.
    {
      let raw2 = line;
      const texts = [content];
      let j = i + 1;
      while (j < physical.length) {
        const nextContent = stripEol(physical[j]!);
        if (
          nextContent.trim() === "" ||
          HEADING_RE.test(nextContent) ||
          HR_RE.test(nextContent) ||
          CHECKLIST_RE.test(nextContent) ||
          LIST_ITEM_RE.test(nextContent) ||
          TABLE_ROW_RE.test(nextContent) ||
          FENCE_RE.test(nextContent)
        ) {
          break;
        }
        texts.push(nextContent);
        raw2 += physical[j]!;
        j++;
      }
      const text = texts.join("\n");
      const node: RoadmapParagraphNode = { type: "paragraph", text, links: extractLinks(text), raw: raw2 };
      nodes.push(node);
      i = j;
      continue;
    }
  }

  return nodes;
}

/** The inverse of `parseRoadmapAst` — always exactly `ast.map(n =>
 *  n.raw).join("")`. A separate named function (not inlined at call sites)
 *  so the round-trip guarantee reads as one deliberate, tested contract. */
export function serializeRoadmapAst(ast: RoadmapAstNode[]): string {
  return ast.map((n) => n.raw).join("");
}
