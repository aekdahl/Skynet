// Momentum Rollout Phase 26 (TASK 29) — the roadmap doc view's pure AST
// shaping, checked against hand-built fixtures matching the real parser's
// node shapes (packages/shared/src/roadmap-doc.ts / apps/server/src/roadmap/ast.ts).
import { describe, it, expect } from "vitest";
import type { RoadmapAstNode, RoadmapChecklistItemNode, RoadmapHeadingNode, RoadmapParagraphNode } from "@skynet/shared";
import { groupRoadmapSections, machineBlocks, classifyMachineLine } from "../apps/web/src/kanban/roadmap-view.js";

const heading = (text: string, raw?: string): RoadmapHeadingNode => ({ type: "heading", level: 2, text, raw: raw ?? `## ${text}\n` });

const item = (over: Partial<RoadmapChecklistItemNode> & Pick<RoadmapChecklistItemNode, "id" | "text" | "state">): RoadmapChecklistItemNode => ({
  type: "checklistItem", indent: 0, marker: " ", checked: false, links: [],
  acceptanceCriteria: null, author: null, authorRef: null, addedAt: null, claimedByHuman: false,
  taskIds: [], promisedDate: null, forecast: null, questionIds: [], blameSha: null,
  raw: `- [ ] ${over.text}\n`,
  ...over,
});

const paragraph = (text: string): RoadmapParagraphNode => ({ type: "paragraph", text, links: [], raw: `${text}\n` });
const blank: RoadmapAstNode = { type: "blank", raw: "\n" };

describe("groupRoadmapSections", () => {
  it("groups lines under their nearest preceding ## heading", () => {
    const ast: RoadmapAstNode[] = [
      heading("Phase 1"),
      item({ id: "a", text: "A", state: "done" }),
      item({ id: "b", text: "B", state: "todo" }),
      heading("Phase 2"),
      item({ id: "c", text: "C", state: "in_progress" }),
    ];
    const sections = groupRoadmapSections(ast);
    expect(sections).toHaveLength(2);
    expect(sections[0]!.headingText).toBe("Phase 1");
    expect(sections[0]!.lines.map((l) => l.id)).toEqual(["a", "b"]);
    expect(sections[1]!.headingText).toBe("Phase 2");
    expect(sections[1]!.lines.map((l) => l.id)).toEqual(["c"]);
  });

  it("content before the first heading is its own section with headingText: null", () => {
    const ast: RoadmapAstNode[] = [paragraph("intro prose"), heading("Phase 1"), item({ id: "a", text: "A", state: "todo" })];
    const sections = groupRoadmapSections(ast);
    expect(sections).toHaveLength(2);
    expect(sections[0]!.headingText).toBeNull();
    expect(sections[0]!.intent).toBe("intro prose");
  });

  it("the FIRST paragraph right after a heading becomes intent; a later paragraph does not", () => {
    const ast: RoadmapAstNode[] = [
      heading("Phase 1"),
      blank,
      paragraph("what this phase is about"),
      item({ id: "a", text: "A", state: "todo" }),
      paragraph("some trailing prose, not a second intent"),
    ];
    const sections = groupRoadmapSections(ast);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.intent).toBe("what this phase is about");
    expect(sections[0]!.lines).toHaveLength(1);
  });

  it("a heading with no lines and no intent still produces an (empty) section", () => {
    const ast: RoadmapAstNode[] = [heading("Empty phase")];
    const sections = groupRoadmapSections(ast);
    expect(sections).toEqual([{ headingText: "Empty phase", intent: null, lines: [] }]);
  });

  it("an empty doc produces no sections", () => {
    expect(groupRoadmapSections([])).toEqual([]);
  });
});

describe("machineBlocks", () => {
  it("extracts a closed fence's content, stripping the fence delimiters and any lang tag", () => {
    const raw = "```yaml\nfoo: done\nbar: todo\n```\n";
    const ast: RoadmapAstNode[] = [{ type: "other", raw }];
    const blocks = machineBlocks(ast);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ index: 0, lang: "yaml", lines: ["foo: done", "bar: todo"] });
  });

  it("a fence with no lang tag reports lang: null", () => {
    const ast: RoadmapAstNode[] = [{ type: "other", raw: "```\nplain content\n```\n" }];
    expect(machineBlocks(ast)[0]!.lang).toBeNull();
  });

  it("an unclosed fence (ran to EOF) keeps every content line, since there's no close delimiter to strip", () => {
    const ast: RoadmapAstNode[] = [{ type: "other", raw: "```\nline one\nline two" }];
    expect(machineBlocks(ast)[0]!.lines).toEqual(["line one", "line two"]);
  });

  it("a non-fence 'other' node (e.g. a blockquote) isn't treated as a machine block", () => {
    const ast: RoadmapAstNode[] = [{ type: "other", raw: "> a blockquote, not a fence\n" }];
    expect(machineBlocks(ast)).toEqual([]);
  });

  it("preserves document order and index across multiple blocks", () => {
    const ast: RoadmapAstNode[] = [
      heading("Phase 1"),
      { type: "other", raw: "```\nfirst\n```\n" },
      item({ id: "a", text: "A", state: "todo" }),
      { type: "other", raw: "```\nsecond\n```\n" },
    ];
    const blocks = machineBlocks(ast);
    expect(blocks.map((b) => b.index)).toEqual([1, 3]);
    expect(blocks.map((b) => b.lines[0])).toEqual(["first", "second"]);
  });
});

describe("classifyMachineLine", () => {
  it("classifies comment markers dimmed regardless of style", () => {
    expect(classifyMachineLine("# a comment")).toBe("comment");
    expect(classifyMachineLine("// a comment")).toBe("comment");
    expect(classifyMachineLine("<!-- a comment -->")).toBe("comment");
  });

  it("classifies a bare recognized state word by its meaning", () => {
    expect(classifyMachineLine("done")).toBe("state-done");
    expect(classifyMachineLine("SHIPPED")).toBe("state-done");
    expect(classifyMachineLine("in_progress")).toBe("state-in-progress");
    expect(classifyMachineLine("todo")).toBe("state-todo");
  });

  it("classifies a trailing `key: value` state word by its meaning", () => {
    expect(classifyMachineLine("status: done")).toBe("state-done");
    expect(classifyMachineLine("state = todo,")).toBe("state-todo");
  });

  it("ordinary content (no state word, not a comment) is plain", () => {
    expect(classifyMachineLine("generated 2026-01-01T00:00:00Z")).toBe("plain");
    expect(classifyMachineLine("")).toBe("plain");
  });
});
