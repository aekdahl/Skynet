// Scenario coverage: which of a codebase's ENUMERABLE behaviour sets the tests
// exercise at all. Motivated by two real production bugs in this repo that were
// both an untested CELL in a small closed set, not an untested file:
//   • Stop-on-an-escalation-card stranded its task in "ongoing" (resolution
//     actions × task-state sync — `reject` had a test that never asserted the
//     task side)
//   • Archiving a run left it in permanent "review" limbo (archive × run status)
// Line coverage would have reported both files as covered.
import { describe, it, expect } from "vitest";
import { extractAxes, extractBehaviours, scenarioReport, type SourceFile } from "../apps/server/src/quality/scenarios.js";

const f = (path: string, content: string): SourceFile => ({ path, content });

describe("extractAxes — finds the closed sets a codebase branches on", () => {
  it("reads a string-literal union type", () => {
    const [axis] = extractAxes([f("src/a.ts", `export type Risk = "low" | "medium" | "high";`)]);
    expect(axis!.name).toBe("Risk");
    expect(axis!.kind).toBe("union");
    expect(axis!.cases.map((c) => c.value)).toEqual(["low", "medium", "high"]);
  });

  it("reads a union spread across lines, as they're actually written", () => {
    const src = `type EscalationSource =\n  | "timeout"\n  | "failures"\n  | "stalled";`;
    const [axis] = extractAxes([f("src/o.ts", src)]);
    expect(axis!.cases.map((c) => c.value)).toEqual(["timeout", "failures", "stalled"]);
  });

  it("reads a zod enum", () => {
    const [axis] = extractAxes([f("src/c.ts", `export const TaskState = z.enum(["backlog", "todo", "done"]);`)]);
    expect(axis!.kind).toBe("enum");
    expect(axis!.cases.map((c) => c.value)).toEqual(["backlog", "todo", "done"]);
  });

  it("ignores unions that aren't closed string sets — those aren't scenario axes", () => {
    const src = [
      `type Handler = (x: number) => void;`,       // not a union
      `type Mixed = "a" | number;`,                 // not all literals
      `type Alias = string;`,                       // not a set
      `type Single = "only";`,                      // one value isn't a decision
    ].join("\n");
    expect(extractAxes([f("src/x.ts", src)])).toEqual([]);
  });

  it("skips a generated-looking mega-union — too wide to reason about case by case", () => {
    const wide = Array.from({ length: 40 }, (_, i) => `"v${i}"`).join(" | ");
    expect(extractAxes([f("src/w.ts", `type Wide = ${wide};`)])).toEqual([]);
  });

  it("keeps the first declaration when a name repeats, and orders widest-first", () => {
    const axes = extractAxes([
      f("src/small.ts", `type Small = "a" | "b";`),
      f("src/big.ts", `type Big = "a" | "b" | "c" | "d";`),
      f("src/dupe.ts", `type Small = "x" | "y";`),
    ]);
    expect(axes.map((a) => a.name)).toEqual(["Big", "Small"]);
    expect(axes.find((a) => a.name === "Small")!.file).toBe("src/small.ts");
  });
});

describe("extractBehaviours — the suite's own behaviour statements", () => {
  it("collects describe/it/test titles across quote styles", () => {
    const t = f("tests/a.test.ts", `describe("outer", () => { it('inner works', () => {}); test(\`third\`, () => {}); });`);
    expect(extractBehaviours([t])).toEqual(["outer", "inner works", "third"]);
  });

  it("returns nothing for a file with no tests, rather than throwing", () => {
    expect(extractBehaviours([f("tests/empty.test.ts", "const x = 1;")])).toEqual([]);
  });
});

describe("scenarioReport — crossing the axes against the tests", () => {
  const source = f("src/orch.ts", `export type ResolveAction = "approve" | "reject" | "modify" | "dismiss";`);

  it("marks a case covered only when the tests actually mention its value", () => {
    const tests = f("tests/r.test.ts", `it("approves", () => { resolve({ action: "approve" }); });`);
    const r = scenarioReport([source], [tests]);
    const byValue = Object.fromEntries(r.axes[0]!.cases.map((c) => [c.value, c.covered]));
    expect(byValue).toEqual({ approve: true, reject: false, modify: false, dismiss: false });
    expect(r.coveredCases).toBe(1);
    expect(r.totalCases).toBe(4);
    expect(r.ratio).toBeCloseTo(0.25, 6);
  });

  it("reproduces the real bug's shape: the untested cell is the one that broke", () => {
    // `reject` existed in the code and in a test title, but the ACTION value
    // itself never appeared — exactly how the escalation-reject gap survived.
    const tests = f("tests/e.test.ts", `it("Stop (reject) an escalation ends the run", () => { go("approve"); });`);
    const r = scenarioReport([source], [tests]);
    const reject = r.axes[0]!.cases.find((c) => c.value === "reject")!;
    expect(reject.covered).toBe(false);
  });

  it("a substring inside a longer word does NOT count — only whole quoted values", () => {
    // "rejected" must not satisfy the "reject" case, or the signal is worthless.
    const tests = f("tests/s.test.ts", `it("x", () => { expect(status).toBe("rejected"); });`);
    const r = scenarioReport([source], [tests]);
    expect(r.axes[0]!.cases.find((c) => c.value === "reject")!.covered).toBe(false);
  });

  it("counts per-axis covered/total so the UI can rank by gap", () => {
    const tests = f("tests/t.test.ts", `it("x", () => { a("approve"); b("reject"); });`);
    const axis = scenarioReport([source], [tests]).axes[0]!;
    expect(axis.covered).toBe(2);
    expect(axis.total).toBe(4);
  });

  it("an empty repo reports zeros without dividing by zero", () => {
    const r = scenarioReport([], []);
    expect(r).toMatchObject({ totalCases: 0, coveredCases: 0, ratio: 0, sourceFiles: 0, testFiles: 0 });
  });

  it("reports how much it actually looked at, so an empty result is interpretable", () => {
    const r = scenarioReport([source, f("src/b.ts", "")], [f("tests/a.test.ts", "")]);
    expect(r.sourceFiles).toBe(2);
    expect(r.testFiles).toBe(1);
  });
});
