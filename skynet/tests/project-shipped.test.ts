// A project is "shipped" only when EVERY task is done — not merely when its runs
// are done. Unstarted backlog tasks have no run, so the old runs-all-done check
// badged a project "✓ shipped" while work still sat in the backlog. This locks
// the task-based rule the Home subway + project overview badges use.
import { describe, it, expect } from "vitest";
import type { Task } from "@skynet/shared";
import { projectShipped } from "../apps/web/src/lib/derive.js";

const t = (projectId: string, state: Task["state"]): Task =>
  ({ id: `t-${Math.random()}`, projectId, state } as Task);

describe("projectShipped", () => {
  it("true only when the project has tasks and all are done", () => {
    expect(projectShipped([t("p", "done"), t("p", "done")], "p")).toBe(true);
  });

  it("false when any task is still in the backlog (the reported bug)", () => {
    // 8 done runs but 6 backlog items → NOT shipped.
    const tasks = [...Array(8)].map(() => t("p", "done")).concat([...Array(6)].map(() => t("p", "backlog")));
    expect(projectShipped(tasks, "p")).toBe(false);
  });

  it("false when work is mid-flight (todo/ongoing/review)", () => {
    expect(projectShipped([t("p", "done"), t("p", "ongoing")], "p")).toBe(false);
    expect(projectShipped([t("p", "review")], "p")).toBe(false);
  });

  it("false for a project with no tasks (nothing to have shipped)", () => {
    expect(projectShipped([], "p")).toBe(false);
    expect(projectShipped([t("other", "done")], "p")).toBe(false); // only another project's tasks
  });

  it("ignores tasks belonging to other projects", () => {
    expect(projectShipped([t("p", "done"), t("other", "backlog")], "p")).toBe(true);
  });
});
