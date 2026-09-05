// Memory v0, phase 1: turns a project's current facts into the compact prompt
// text agent-context.ts's memory section renders. Pure — fixture facts only.
import { describe, it, expect } from "vitest";
import { factsDigest } from "../apps/server/src/memory-digest.js";
import type { MemoryFact } from "../apps/server/src/memory-format-reader.js";

const fact = (heading: string, body = "", over: Partial<MemoryFact> = {}): MemoryFact => ({
  heading, body, id: "x", source: "operator", author: "j", created: "2026-01-01T00:00:00Z", confidence: "stated", extra: {}, ...over,
});

describe("factsDigest", () => {
  it("returns undefined when there's nothing to say", () => {
    expect(factsDigest([])).toBeUndefined();
    expect(factsDigest([{ label: "workspace", facts: [] }])).toBeUndefined();
  });

  it("labels each section and bullets its facts, with body appended after an em-dash", () => {
    const digest = factsDigest([
      { label: "workspace", facts: [fact("Prefer snake_case for Python files", "Stated by jordan.")] },
      { label: "acme-web", facts: [fact("Review the billing webhook closely")] },
    ]);
    expect(digest).toBe(
      "[workspace]\n- Prefer snake_case for Python files — Stated by jordan.\n[acme-web]\n- Review the billing webhook closely",
    );
  });

  it("omits a section entirely when it has no facts, rather than an empty label", () => {
    const digest = factsDigest([
      { label: "workspace", facts: [] },
      { label: "claude", facts: [fact("Always run npm test before finishing")] },
    ]);
    expect(digest).not.toContain("[workspace]");
    expect(digest).toContain("[claude]");
  });

  it("caps a section at 30 facts and a body at 200 chars", () => {
    const many = Array.from({ length: 35 }, (_, i) => fact(`Fact ${i}`));
    const digest = factsDigest([{ label: "workspace", facts: many }])!;
    expect(digest.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(30);

    const longBody = "a".repeat(300);
    const capped = factsDigest([{ label: "workspace", facts: [fact("h", longBody)] }])!;
    expect(capped).toContain(`${"a".repeat(200)}…`);
    expect(capped).not.toContain("a".repeat(201));
  });
});
