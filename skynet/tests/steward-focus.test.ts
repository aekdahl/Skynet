// resolveFocusedProject picks the single local-checkout project a Telegram
// message is about, so Steward can tool-loop that repo. Ambiguity → null (fall
// back to workspace-wide grounding).
import { describe, it, expect } from "vitest";
import { resolveFocusedProject } from "../apps/server/src/steward/assistant.js";

const P = (name: string, repoPath: string | null) => ({ name, repoPath });

describe("resolveFocusedProject", () => {
  const projects = [P("Cardstack", "/repos/cardstack"), P("Billing", "/repos/billing"), P("Docs Site", null)];

  it("returns the single local-checkout project named in the message (case-insensitive)", () => {
    expect(resolveFocusedProject("what does auth do in cardstack?", projects)?.name).toBe("Cardstack");
    expect(resolveFocusedProject("summarize BILLING's roadmap", projects)?.name).toBe("Billing");
  });

  it("returns null for a project with no local checkout (nothing to tool-loop)", () => {
    // "Docs Site" is named but GitHub-only (repoPath null) → not focusable.
    expect(resolveFocusedProject("open the Docs Site readme", projects)).toBeNull();
  });

  it("returns null when the message names more than one project (ambiguous)", () => {
    expect(resolveFocusedProject("compare Cardstack and Billing", projects)).toBeNull();
  });

  it("returns null when no project is named", () => {
    expect(resolveFocusedProject("what's running right now?", projects)).toBeNull();
    expect(resolveFocusedProject("", projects)).toBeNull();
  });
});
