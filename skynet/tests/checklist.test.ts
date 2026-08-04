// PURE markdown-checklist helpers behind repo-file task sync (Phase 2): parse the
// `- [ ] …` items, and flip a specific item's box on completion — anchored by
// label so unrelated edits don't misfire, and a no-match safely no-ops.
import { describe, it, expect } from "vitest";
import { parseChecklist, setChecklistItem, repoFileChecked } from "../apps/server/src/tasks/checklist.js";

const MD = `# Roadmap

- [ ] Ship login
- [x] Set up CI
  - [ ] Nested subtask
* [ ] Bullet-star item
Not a checklist line.
`;

describe("parseChecklist", () => {
  it("extracts every checklist item with its checked state (any bullet/indent)", () => {
    expect(parseChecklist(MD)).toEqual([
      { label: "Ship login", checked: false },
      { label: "Set up CI", checked: true },
      { label: "Nested subtask", checked: false },
      { label: "Bullet-star item", checked: false },
    ]);
  });
  it("returns [] for markdown with no checklist", () => {
    expect(parseChecklist("# Title\n\njust prose")).toEqual([]);
  });
});

describe("setChecklistItem", () => {
  it("checks the matching item (case-insensitive) and preserves indent/bullet", () => {
    const out = setChecklistItem(MD, "ship login", true);
    expect(out).not.toBeNull();
    expect(out).toContain("- [x] Ship login");
    expect(out).toContain("- [x] Set up CI"); // untouched
    expect(out).toContain("  - [ ] Nested subtask"); // untouched, indent kept
  });
  it("unchecks an item (regress)", () => {
    expect(setChecklistItem(MD, "Set up CI", false)).toContain("- [ ] Set up CI");
  });
  it("returns null when no item matches (never clobber a renamed/removed line)", () => {
    expect(setChecklistItem(MD, "does not exist", true)).toBeNull();
  });
  it("returns null when the box is already in the target state (no-op)", () => {
    expect(setChecklistItem(MD, "Set up CI", true)).toBeNull(); // already [x]
  });
});

describe("repoFileChecked", () => {
  it("→ done checks; leaving done unchecks; other moves + no-ops are null", () => {
    expect(repoFileChecked("review", "done")).toBe(true);
    expect(repoFileChecked("done", "triage")).toBe(false);
    expect(repoFileChecked("backlog", "triage")).toBeNull();
    expect(repoFileChecked("done", "done")).toBeNull();
  });
});
