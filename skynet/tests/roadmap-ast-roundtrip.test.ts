// Phase 24 — the hard guarantee parseRoadmapAst/serializeRoadmapAst exist to
// keep: parse → serialize with zero edits must produce a byte-identical
// file. Run against real-shaped ROADMAP.md excerpts (including the actual
// current ROADMAP.md itself), not just synthetic input — a hand-rolled
// parser's real failure mode is a structure the author didn't think to
// synthesize.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRoadmapAst, serializeRoadmapAst } from "../apps/server/src/roadmap/ast.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures/roadmap");
const fixtureFiles = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".md"));

describe("roadmap AST round-trip", () => {
  it("found at least the expected real + synthetic fixtures", () => {
    expect(fixtureFiles.length).toBeGreaterThanOrEqual(6);
  });

  for (const file of fixtureFiles) {
    it(`${file}: parse → serialize is byte-identical`, () => {
      const raw = readFileSync(join(FIXTURES_DIR, file), "utf8");
      const ast = parseRoadmapAst(raw);
      const serialized = serializeRoadmapAst(ast);
      expect(serialized).toBe(raw);
    });
  }

  it("every byte of the input is accounted for exactly once (raw spans concatenate with no gaps or overlaps)", () => {
    const raw = readFileSync(join(FIXTURES_DIR, "full-roadmap.md"), "utf8");
    const ast = parseRoadmapAst(raw);
    let offset = 0;
    for (const node of ast) {
      expect(raw.slice(offset, offset + node.raw.length)).toBe(node.raw);
      offset += node.raw.length;
    }
    expect(offset).toBe(raw.length);
  });

  it("classifies the real file's structure sanely (a coarse sanity check, not exhaustive)", () => {
    const raw = readFileSync(join(FIXTURES_DIR, "full-roadmap.md"), "utf8");
    const ast = parseRoadmapAst(raw);
    const counts = ast.reduce<Record<string, number>>((acc, n) => ({ ...acc, [n.type]: (acc[n.type] ?? 0) + 1 }), {});
    expect(counts.heading).toBeGreaterThan(5);
    expect(counts.checklistItem).toBeGreaterThan(50);
    expect(counts.table).toBeGreaterThan(0);
    expect(counts.hr).toBeGreaterThan(0);
  });

  it("checklist items report the checkbox marker honestly — [x]/[ ]/[~] map to checked/state correctly", () => {
    const raw = readFileSync(join(FIXTURES_DIR, "synthetic-edge-cases.md"), "utf8");
    const ast = parseRoadmapAst(raw);
    const items = ast.filter((n) => n.type === "checklistItem");
    expect(items).toHaveLength(4); // todo, done, in-progress, nested todo
    const [todo, done, inProgress, nested] = items as Array<Extract<(typeof items)[number], { type: "checklistItem" }>>;
    expect(todo!.checked).toBe(false);
    expect(todo!.state).toBe("todo");
    expect(done!.checked).toBe(true);
    expect(done!.state).toBe("done");
    expect(inProgress!.checked).toBe(false);
    expect(inProgress!.state).toBe("in_progress");
    expect(nested!.indent).toBeGreaterThan(0);
  });

  it("extracts table rows including escaped pipes, and links from prose", () => {
    const raw = readFileSync(join(FIXTURES_DIR, "synthetic-edge-cases.md"), "utf8");
    const ast = parseRoadmapAst(raw);
    const table = ast.find((n) => n.type === "table");
    expect(table).toBeTruthy();
    if (table?.type === "table") {
      expect(table.rows[0]).toEqual(["a", "b|escaped", "c"]);
      expect(table.rows[2]).toEqual(["1", "2", "3"]);
    }
    const links = ast.flatMap((n) => (n.type === "paragraph" || n.type === "checklistItem" || n.type === "listItem" ? n.links : []));
    expect(links).toContainEqual({ text: "link", url: "https://example.com" });
  });

  it("a code fence's content is never misparsed as roadmap structure", () => {
    const raw = readFileSync(join(FIXTURES_DIR, "synthetic-edge-cases.md"), "utf8");
    const ast = parseRoadmapAst(raw);
    // The fence's own body line contains a stray ``` mid-string and no real
    // checklist syntax — it must round-trip as one opaque "other" node, not
    // fragment into headings/checklist items.
    const other = ast.filter((n) => n.type === "other");
    expect(other.some((n) => n.raw.includes("not a heading, not a checklist item"))).toBe(true);
  });
});
