// Conflict detection — the "no double work" signal (Backend Brief §09, VCS §4).
// A module is contested when two DIFFERENT active families both touch it; a fork
// and its parent are one family and must never flag each other. This is a pure
// function, so it's covered deterministically here rather than as a fragile
// real-agent simulation journey (agent modules come from real edits).
import { describe, it, expect } from "vitest";
import type { TaskRun } from "@skynet/shared";
import { computeConflicts, computeFileCollisions, familyOf } from "../apps/server/src/derive/conflicts.js";

// computeConflicts only reads id/status/modules/parentId — a partial run is enough.
const run = (id: string, modules: string[], extra: Partial<TaskRun> = {}): TaskRun =>
  ({ id, status: "running", modules, parentId: null, projectId: "p1", modifiedFiles: [], ...extra }) as unknown as TaskRun;

// computeFileCollisions additionally reads projectId/modifiedFiles.
const runF = (id: string, files: string[], extra: Partial<TaskRun> = {}): TaskRun =>
  run(id, [], { modifiedFiles: files, ...extra });

describe("computeConflicts", () => {
  it("flags a module two different families both touch", () => {
    const c = computeConflicts([run("a", ["billing"]), run("b", ["billing"])]);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ moduleId: "billing" });
    expect(c[0]!.runIds.slice().sort()).toEqual(["a", "b"]);
  });

  it("does not flag non-overlapping modules", () => {
    expect(computeConflicts([run("a", ["billing"]), run("b", ["auth"])])).toHaveLength(0);
  });

  it("excludes done runs — only active work contends", () => {
    expect(
      computeConflicts([run("a", ["billing"]), run("b", ["billing"], { status: "done" })]),
    ).toHaveLength(0);
  });

  it("a fork and its parent are one family — never flag each other", () => {
    expect(
      computeConflicts([run("parent", ["billing"]), run("fork", ["billing"], { parentId: "parent" })]),
    ).toHaveLength(0);
  });

  it("flags a fork against an UNRELATED run on the same module", () => {
    const c = computeConflicts([
      run("parent", ["billing"]),
      run("fork", ["billing"], { parentId: "parent" }),
      run("other", ["billing"]),
    ]);
    expect(c).toHaveLength(1);
    expect(c[0]!.runIds.slice().sort()).toEqual(["fork", "other", "parent"]);
  });

  it("familyOf collapses a fork onto its parent", () => {
    expect(familyOf(run("fork", [], { parentId: "p" }))).toBe("p");
    expect(familyOf(run("solo", []))).toBe("solo");
  });

  it("familyOf without a run lookup stays single-hop (today's behavior, unchanged)", () => {
    // No byId map — same as before this walked to root at all.
    expect(familyOf(run("grandchild", [], { parentId: "child" }))).toBe("child");
  });

  it("familyOf walks a multi-level parentId chain to the root", () => {
    const grandparent = run("grandparent", []);
    const parent = run("parent", [], { parentId: "grandparent" });
    const child = run("child", [], { parentId: "parent" });
    const byId = new Map([grandparent, parent, child].map((r) => [r.id, r]));
    expect(familyOf(grandparent, byId)).toBe("grandparent");
    expect(familyOf(parent, byId)).toBe("grandparent");
    expect(familyOf(child, byId)).toBe("grandparent");
  });

  it("familyOf stops at a missing/broken link rather than throwing", () => {
    const orphan = run("orphan", [], { parentId: "nowhere" });
    const byId = new Map([[orphan.id, orphan]]);
    expect(familyOf(orphan, byId)).toBe("nowhere");
  });

  it("familyOf stops on a cycle rather than looping forever", () => {
    const a = run("a", [], { parentId: "b" });
    const b = run("b", [], { parentId: "a" });
    const byId = new Map([a, b].map((r) => [r.id, r]));
    // Terminates (doesn't hang) — the exact id it stops at isn't the point,
    // only that a broken/cyclic chain can never infinite-loop the derive step.
    expect(familyOf(a, byId)).toBe("a");
    expect(familyOf(b, byId)).toBe("b");
  });

  it("a 3-level parentId chain (grandparent → parent → child) is one family — never flag each other", () => {
    // A fork of a fork — already reachable today (the Fork action has no
    // depth limit) — and, later, a worker→manager delegation chain.
    expect(
      computeConflicts([
        run("grandparent", ["billing"]),
        run("parent", ["billing"], { parentId: "grandparent" }),
        run("child", ["billing"], { parentId: "parent" }),
      ]),
    ).toHaveLength(0);
  });

  it("a 3-level chain still flags against a genuinely unrelated run", () => {
    const c = computeConflicts([
      run("grandparent", ["billing"]),
      run("parent", ["billing"], { parentId: "grandparent" }),
      run("child", ["billing"], { parentId: "parent" }),
      run("other", ["billing"]),
    ]);
    expect(c).toHaveLength(1);
    expect(c[0]!.runIds.slice().sort()).toEqual(["child", "grandparent", "other", "parent"]);
  });

  it("bake-off siblings are one family — never flag each other", () => {
    expect(
      computeConflicts([
        run("a", ["billing"], { bakeoffId: "bo1" }),
        run("b", ["billing"], { bakeoffId: "bo1" }),
      ]),
    ).toHaveLength(0);
  });

  it("different bake-offs on the same module still conflict-flag each other", () => {
    const c = computeConflicts([
      run("a", ["billing"], { bakeoffId: "bo1" }),
      run("b", ["billing"], { bakeoffId: "bo2" }),
    ]);
    expect(c).toHaveLength(1);
    expect(c[0]!.runIds.slice().sort()).toEqual(["a", "b"]);
  });

  it("familyOf gives bake-off siblings a shared bakeoff: root, without needing a byId map", () => {
    expect(familyOf(run("a", [], { bakeoffId: "bo1" }))).toBe("bakeoff:bo1");
    expect(familyOf(run("b", [], { bakeoffId: "bo1" }))).toBe("bakeoff:bo1");
  });

  it("a fork of a bake-off sibling inherits the bake-off family", () => {
    const sibling = run("sibling", [], { bakeoffId: "bo1" });
    const fork = run("fork", [], { parentId: "sibling" });
    const byId = new Map([sibling, fork].map((r) => [r.id, r]));
    expect(familyOf(fork, byId)).toBe("bakeoff:bo1");
  });

  it("a finished (done) parent is still walked to resolve its active child's family", () => {
    // The done filter only applies to which runs CONTEND for a module — the
    // id lookup for walking parentId is built from every run, active or not.
    expect(
      computeConflicts([
        run("parent", ["billing"], { status: "done" }),
        run("child", ["billing"], { parentId: "parent" }),
        run("other", ["billing"]),
      ]),
    ).toHaveLength(1); // child vs other — parent is done, doesn't contend itself
  });
});

describe("computeFileCollisions", () => {
  it("flags a file two different families on the SAME project both touched", () => {
    const c = computeFileCollisions([runF("a", ["src/x.ts"]), runF("b", ["src/x.ts"])]);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ file: "src/x.ts" });
    expect(c[0]!.runIds.slice().sort()).toEqual(["a", "b"]);
  });

  it("does not flag non-overlapping files", () => {
    expect(computeFileCollisions([runF("a", ["src/x.ts"]), runF("b", ["src/y.ts"])])).toHaveLength(0);
  });

  it("excludes done runs", () => {
    expect(
      computeFileCollisions([runF("a", ["src/x.ts"]), runF("b", ["src/x.ts"], { status: "done" })]),
    ).toHaveLength(0);
  });

  it("a fork and its parent are one family — never flag each other", () => {
    expect(
      computeFileCollisions([runF("parent", ["src/x.ts"]), runF("fork", ["src/x.ts"], { parentId: "parent" })]),
    ).toHaveLength(0);
  });

  it("never flags the same path across two DIFFERENT projects", () => {
    expect(
      computeFileCollisions([runF("a", ["src/x.ts"], { projectId: "p1" }), runF("b", ["src/x.ts"], { projectId: "p2" })]),
    ).toHaveLength(0);
  });
});
