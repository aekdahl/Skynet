// The docs markdown renderer must handle what ROADMAP.md uses: status checkboxes
// on list items and lists nested to arbitrary depth (the old renderer collapsed
// past one level — the "hard to read" bug).
import { describe, it, expect } from "vitest";
import { parseMarkdown, parseStatus } from "../apps/web/src/components/markdown.js";

describe("parseStatus", () => {
  it("maps checkbox markers to a status and strips the token", () => {
    expect(parseStatus("[x] done thing")).toEqual({ status: "done", rest: "done thing" });
    expect(parseStatus("[~] wip thing")).toEqual({ status: "wip", rest: "wip thing" });
    expect(parseStatus("[ ] planned thing")).toEqual({ status: "todo", rest: "planned thing" });
    expect(parseStatus("no marker here")).toEqual({ status: null, rest: "no marker here" });
  });
});

describe("parseMarkdown", () => {
  it("attaches status to list items (ordered and unordered)", () => {
    const [list] = parseMarkdown("1. [x] shipped\n2. [ ] planned");
    expect(list).toMatchObject({ kind: "list", ordered: true });
    if (list?.kind !== "list") throw new Error("expected list");
    expect(list.items.map((i) => [i.status, i.text])).toEqual([
      ["done", "shipped"],
      ["todo", "planned"],
    ]);
  });

  it("nests lists by indentation to more than one level", () => {
    const md = ["- a", "  - a1", "    - a1x", "  - a2", "- b"].join("\n");
    const [list] = parseMarkdown(md);
    if (list?.kind !== "list") throw new Error("expected list");
    expect(list.items.map((i) => i.text)).toEqual(["a", "b"]);
    const a = list.items[0]!;
    expect(a.children.map((i) => i.text)).toEqual(["a1", "a2"]);
    expect(a.children[0]!.children.map((i) => i.text)).toEqual(["a1x"]); // 3rd level survives
  });

  it("folds a wrapped continuation line into the current item's text", () => {
    const [list] = parseMarkdown("- first line\n  wrapped continuation");
    if (list?.kind !== "list") throw new Error("expected list");
    expect(list.items[0]!.text).toBe("first line wrapped continuation");
  });

  it("parses headings up to level 4 and horizontal rules", () => {
    const blocks = parseMarkdown("# H1\n\n#### H4\n\n---");
    expect(blocks).toEqual([
      { kind: "h", level: 1, text: "H1" },
      { kind: "h", level: 4, text: "H4" },
      { kind: "hr" },
    ]);
  });
});
