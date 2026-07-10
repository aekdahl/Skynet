// Regression for the no-over-gating fix: the Claude runner must not raise a
// blocking mid-run approval for trivial file edits (a one-word comment fix
// shouldn't pause for sign-off) — edits are reviewed wholesale in the end-of-run
// diff review. The genuinely risky/irreversible surface (shell + unknown tools)
// must still gate. Mirrors eval scenarios `no-over-gating` and `risky-command-gate`.
import { describe, it, expect } from "vitest";
import { isAutoAllowed } from "../packages/runner-sdk/src/claude.js";

describe("Claude runner tool-gating policy", () => {
  it("auto-allows read-only tools and file edits (no per-edit approval)", () => {
    for (const t of [
      "Read", "LS", "Glob", "Grep", "NotebookRead", "TodoWrite",
      "Edit", "MultiEdit", "Write", "NotebookEdit",
    ]) {
      expect(isAutoAllowed(t)).toBe(true);
    }
  });

  it("gates shell commands and unrecognized tools", () => {
    expect(isAutoAllowed("Bash")).toBe(false); // risky/irreversible — must gate
    expect(isAutoAllowed("SomeFutureTool")).toBe(false); // fail closed on unknown
  });
});
