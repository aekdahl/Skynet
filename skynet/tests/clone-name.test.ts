// Duplicating a fleet agent suggests a fresh name: bump a trailing number, else
// append "-copy", always skipping names already in the fleet so the copy reads
// as its own agent. This locks that behavior (the UI pre-fills it; the operator
// can still rename).
import { describe, it, expect } from "vitest";
import { suggestCloneName } from "../apps/web/src/views/fleet.js";

const set = (...names: string[]) => new Set(names);

describe("suggestCloneName", () => {
  it("bumps a trailing number, preserving zero-padding width", () => {
    expect(suggestCloneName("claude-agent-01", set("claude-agent-01"))).toBe("claude-agent-02");
    expect(suggestCloneName("agent-9", set("agent-9"))).toBe("agent-10");
  });

  it("skips numbers already taken", () => {
    expect(
      suggestCloneName("claude-agent-01", set("claude-agent-01", "claude-agent-02", "claude-agent-03")),
    ).toBe("claude-agent-04");
  });

  it("appends -copy when there's no trailing number", () => {
    expect(suggestCloneName("worker", set("worker"))).toBe("worker-copy");
  });

  it("disambiguates repeated -copy names", () => {
    expect(suggestCloneName("worker", set("worker", "worker-copy"))).toBe("worker-copy-2");
    expect(suggestCloneName("worker", set("worker", "worker-copy", "worker-copy-2"))).toBe("worker-copy-3");
  });
});
