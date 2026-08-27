// The Coverage panel's flat list answers "what do I fix next"; the tree answers
// "WHERE are the gaps". That second question is the one that says whether a
// subsystem is understood, and it's a property of the hierarchy — so the
// derivation from flat axes to tree is worth pinning.
import { describe, it, expect } from "vitest";
import { buildCoverageTree, pathsToGaps, type CoverageNode, type ScenarioAxis } from "@skynet/shared";

const axis = (name: string, file: string, cases: Array<[string, boolean]>): ScenarioAxis => ({
  name,
  file,
  kind: "union",
  cases: cases.map(([value, covered]) => ({ value, covered })),
  covered: cases.filter(([, c]) => c).length,
  total: cases.length,
});

/** Compact shape for asserting structure without drowning in object literals. */
const shape = (n: CoverageNode): unknown =>
  n.children.length === 0 ? `${n.name} ${n.covered}/${n.total}` : { [`${n.name} ${n.covered}/${n.total}`]: n.children.map(shape) };

describe("buildCoverageTree", () => {
  it("nests axes under their file and directory", () => {
    const t = buildCoverageTree([
      axis("A", "apps/server/a.ts", [["x", true], ["y", false]]),
      axis("B", "apps/web/b.ts", [["z", true]]),
    ]);
    expect(shape(t)).toEqual({
      " 2/3": [
        {
          // `apps` branches, so it stays a level of its own; the gap-bearing
          // side sorts first.
          "apps 2/3": [
            { "server 1/2": [{ "a.ts 1/2": ["A 1/2"] }] },
            { "web 1/1": [{ "b.ts 1/1": ["B 1/1"] }] },
          ],
        },
      ],
    });
  });

  it("rolls counts up through every level", () => {
    const t = buildCoverageTree([
      axis("A", "src/deep/a.ts", [["x", true], ["y", false], ["z", false]]),
      axis("B", "src/deep/b.ts", [["p", true]]),
    ]);
    expect(t.covered).toBe(2);
    expect(t.total).toBe(4);
    expect(t.gaps).toBe(2);
    // `src/deep` is an un-branching chain, so it collapses to one row.
    expect(t.children[0]!.name).toBe("src/deep");
    expect(t.children[0]!.gaps).toBe(2);
  });

  it("collapses an un-branching directory chain into one row", () => {
    const t = buildCoverageTree([axis("A", "a/b/c/d.ts", [["x", true]])]);
    expect(t.children.map((c) => c.name)).toEqual(["a/b/c"]);
    expect(t.children[0]!.children.map((c) => c.name)).toEqual(["d.ts"]);
  });

  it("stops collapsing where the tree actually branches", () => {
    const t = buildCoverageTree([
      axis("A", "a/b/one.ts", [["x", true]]),
      axis("B", "a/c/two.ts", [["y", true]]),
    ]);
    // `a` has two children, so it must stay its own level.
    expect(t.children.map((c) => c.name)).toEqual(["a"]);
    expect(t.children[0]!.children.map((c) => c.name).sort()).toEqual(["b", "c"]);
  });

  it("keeps the top level intact when the whole repo sits under one directory", () => {
    // Regression: collapsing is applied bottom-up, and the synthetic root must
    // never absorb its only child — that would silently drop a real level.
    const t = buildCoverageTree([
      axis("A", "src/a.ts", [["x", false]]),
      axis("B", "src/b.ts", [["y", false]]),
    ]);
    expect(t.path).toBe("");
    expect(t.name).toBe("");
    expect(t.children.map((c) => c.name)).toEqual(["src"]);
    expect(t.total).toBe(2);
  });

  it("sorts siblings by gap count first, so the worst area is on top", () => {
    const t = buildCoverageTree([
      axis("Clean", "clean/a.ts", [["x", true], ["y", true]]),
      axis("Holey", "holey/b.ts", [["x", false], ["y", false], ["z", false]]),
      axis("Some", "some/c.ts", [["x", true], ["y", false]]),
    ]);
    expect(t.children.map((c) => c.name)).toEqual(["holey", "some", "clean"]);
  });

  it("keeps two same-named axes in different files apart", () => {
    const t = buildCoverageTree([
      axis("Status", "a/one.ts", [["x", true]]),
      axis("Status", "b/two.ts", [["y", false]]),
    ]);
    const leaves = t.children.flatMap((d) => d.children.flatMap((f) => f.children));
    expect(leaves).toHaveLength(2);
    expect(new Set(leaves.map((l) => l.path)).size).toBe(2);
  });

  it("returns an empty root rather than throwing when there's nothing to scan", () => {
    const t = buildCoverageTree([]);
    expect(t.children).toEqual([]);
    expect(t.total).toBe(0);
    expect(t.gaps).toBe(0);
  });

  it("ignores an axis with no usable file path instead of inventing a node", () => {
    const t = buildCoverageTree([axis("A", "", [["x", false]])]);
    expect(t.children).toEqual([]);
  });
});

describe("pathsToGaps — open straight to the problems", () => {
  it("returns the branches leading to a gap, and nothing else", () => {
    const t = buildCoverageTree([
      axis("Holey", "src/bad/a.ts", [["x", false]]),
      axis("Clean", "src/good/b.ts", [["y", true]]),
    ]);
    const open = pathsToGaps(t);
    expect(open).toContain("src/bad");
    expect(open).toContain("src/bad/a.ts");
    expect(open.some((p) => p.includes("good"))).toBe(false);
  });

  it("names no branches at all when every case is mentioned", () => {
    const t = buildCoverageTree([axis("Clean", "src/a.ts", [["x", true]])]);
    expect(pathsToGaps(t)).toEqual([]);
  });
});
