// Conflict detection — the "no double work" signal (Backend Brief §09, VCS §4).
// A module is contested when two DIFFERENT active families both touch it; a fork
// and its parent are one family and must never flag each other. This is a pure
// function, so it's covered deterministically here rather than as a fragile
// real-agent simulation journey (agent modules come from real edits).
import { describe, it, expect } from "vitest";
import type { TaskRun } from "@skynet/shared";
import { computeConflicts, familyOf } from "../apps/server/src/derive/conflicts.js";

// computeConflicts only reads id/status/modules/parentId — a partial run is enough.
const run = (id: string, modules: string[], extra: Partial<TaskRun> = {}): TaskRun =>
  ({ id, status: "running", modules, parentId: null, ...extra }) as unknown as TaskRun;

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
});
