import { describe, expect, it } from "vitest";
import { parseMarkdown, sectionsFromBlocks, headingIsShipped } from "../apps/web/src/components/markdown.js";

const sample = `# Skynet — Roadmap

Intro paragraph before any section.

## v0 — MVP · the local desktop app  ✓ shipped

**Goal:** an operator installs the desktop app.

1. [x] **Live Claude execution** — drive Claude Code.
2. [x] **Worktree-per-runner provisioning** — isolated worktree.

## v0.5 — UX release polish

- [~] **Polish pass** — in progress.
- [ ] **More polish** — planned.
`;

describe("headingIsShipped", () => {
  it("is true for the v0 shipped heading", () => {
    expect(headingIsShipped("v0 — MVP · the local desktop app  ✓ shipped")).toBe(true);
  });
  it("is false for a non-shipped heading", () => {
    expect(headingIsShipped("v0.5 — UX release polish")).toBe(false);
  });
});

describe("sectionsFromBlocks", () => {
  const { lead, sections } = sectionsFromBlocks(parseMarkdown(sample));

  it("puts the pre-## title + intro in lead", () => {
    expect(lead.length).toBeGreaterThan(0);
    // The h1 title lands in lead, not in any section.
    expect(lead.some((b) => b.kind === "h" && b.level === 1)).toBe(true);
    expect(lead.some((b) => b.kind === "p")).toBe(true);
  });

  it("yields one section per ## with the right heading + non-empty body", () => {
    expect(sections).toHaveLength(2);
    expect(sections[0]!.heading).toContain("✓ shipped");
    expect(sections[1]!.heading).toBe("v0.5 — UX release polish");
    for (const s of sections) expect(s.body.length).toBeGreaterThan(0);
  });

  it("keeps a section's list items inside its body", () => {
    expect(sections[0]!.body.some((b) => b.kind === "list")).toBe(true);
  });
});
