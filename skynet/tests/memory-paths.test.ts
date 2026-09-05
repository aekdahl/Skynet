// Memory v0, phase 1: pure scope → relative-path resolution, per
// docs/memory-format.md's layout.
import { describe, it, expect } from "vitest";
import { memoryFilePath, memorySlug, InvalidMemoryScopeError } from "../apps/server/src/memory-paths.js";

describe("memoryFilePath", () => {
  it("resolves each scope per the spec's layout", () => {
    expect(memoryFilePath("workspace", "acme-web")).toBe(".skynet/memory/workspace.md");
    expect(memoryFilePath("project", "acme-web")).toBe(".skynet/memory/projects/acme-web.md");
    expect(memoryFilePath("area", "acme-web", { areaSlug: "billing" })).toBe(".skynet/memory/areas/acme-web/billing.md");
    expect(memoryFilePath("agent", "acme-web", { agentFamily: "claude" })).toBe(".skynet/memory/agents/claude.md");
  });

  it("throws for area/agent missing their required slug", () => {
    expect(() => memoryFilePath("area", "acme-web")).toThrow(InvalidMemoryScopeError);
    expect(() => memoryFilePath("agent", "acme-web")).toThrow(InvalidMemoryScopeError);
  });
});

describe("memorySlug", () => {
  it("lowercases, collapses non-alphanumeric runs to one dash, trims, caps at 24", () => {
    expect(memorySlug("Acme Web!!")).toBe("acme-web");
    expect(memorySlug("--leading and trailing--")).toBe("leading-and-trailing");
    expect(memorySlug("A very long project name that goes on and on")).toHaveLength(24);
  });
});
