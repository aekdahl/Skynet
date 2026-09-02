// groupDiffByIntent — "grouped by intent, not by file" (Review & Merge, Phase
// 15). A mechanical derivation over the diff hunks (per-file +/- parsed from
// the raw patch, files bucketed by the project's own module map) — no LLM
// involved, so this is covered deterministically here.
import { describe, it, expect } from "vitest";
import { groupDiffByIntent } from "../apps/server/src/diff-groups.js";
import { ModuleMap } from "../apps/server/src/modules-map.js";

const MAP = new ModuleMap([
  { id: "api/auth", name: "Auth", globs: ["api/auth/**"] },
  { id: "api/billing", name: "Billing", globs: ["api/billing/**"] },
]);

function patchFor(file: string, adds: number, dels: number): string {
  const lines: string[] = [`diff --git a/${file} b/${file}`, "index abc..def 100644", `--- a/${file}`, `+++ b/${file}`, "@@ -1,1 +1,1 @@"];
  for (let i = 0; i < adds; i++) lines.push(`+added line ${i}`);
  for (let i = 0; i < dels; i++) lines.push(`-removed line ${i}`);
  return lines.join("\n") + "\n";
}

describe("groupDiffByIntent", () => {
  it("returns nothing for an empty/unparseable patch", () => {
    expect(groupDiffByIntent("", MAP)).toEqual([]);
    expect(groupDiffByIntent("not a real diff", MAP)).toEqual([]);
  });

  it("groups files touching the same module together, with real per-file +/- summed", () => {
    const patch = patchFor("api/auth/login.ts", 3, 1) + patchFor("api/auth/session.ts", 2, 0);
    const groups = groupDiffByIntent(patch, MAP);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ title: "Auth", add: 5, del: 1 });
    expect(groups[0]!.files.slice().sort()).toEqual(["api/auth/login.ts", "api/auth/session.ts"]);
  });

  it("splits files across different modules into separate groups", () => {
    const patch = patchFor("api/auth/login.ts", 1, 0) + patchFor("api/billing/invoice.ts", 1, 0);
    const groups = groupDiffByIntent(patch, MAP);
    expect(groups.map((g) => g.title).sort()).toEqual(["Auth", "Billing"]);
  });

  it("buckets a file no module claims into 'Other changes' rather than dropping it", () => {
    const patch = patchFor("scripts/build.sh", 1, 0);
    const groups = groupDiffByIntent(patch, MAP);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ title: "Other changes", files: ["scripts/build.sh"] });
  });

  it("orders the largest group (by total +/-) first", () => {
    const patch = patchFor("api/billing/invoice.ts", 1, 0) + patchFor("api/auth/login.ts", 10, 5);
    const groups = groupDiffByIntent(patch, MAP);
    expect(groups.map((g) => g.title)).toEqual(["Auth", "Billing"]);
  });
});
