// S11: the execution intents (start_task / queue_tasks / start_feature /
// process_backlog) were fully built and DELIBERATELY switched off — the web
// dock couldn't execute them, so teaching Steward to propose one would have
// produced a confirm chip that did nothing. This pins the three things that had
// to become true together, because any one of them alone re-breaks the feature.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const KINDS = ["start_task", "queue_tasks", "start_feature", "process_backlog"] as const;

describe("execution intents are wired end to end", () => {
  it("Steward is told they exist", () => {
    // Without this the capability is unreachable: the validator accepts these
    // kinds, but the model never proposes one because it doesn't know them.
    const src = read("../apps/server/src/steward/assistant.ts");
    const system = src.slice(src.indexOf("const SYSTEM"), src.indexOf("export function validateProjectAction"));
    for (const k of KINDS) expect(system, `SYSTEM never mentions ${k}`).toContain(`"kind":"${k}"`);
  });

  it("the dock can actually run them", () => {
    // The original reason they were gated. The dock's exhaustiveness guard
    // makes a MISSING case a compile error, but a case that silently no-ops
    // would still type-check — so assert they route to the endpoint.
    const dock = read("../apps/web/src/components/steward-dock.tsx");
    for (const k of KINDS) expect(dock, `dock has no case for ${k}`).toContain(`case "${k}":`);
    expect(dock).toContain("api.executeStewardAction");
  });

  it("the client calls the execution endpoint, not a plain task mutation", () => {
    const client = read("../apps/web/src/lib/client.ts");
    expect(client).toContain("/steward/actions");
    for (const k of KINDS) expect(client, `client action union is missing ${k}`).toContain(`| "${k}"`);
  });

  it("the outcome is reported, not swallowed", () => {
    // A composite routinely does less than it looks like it will — tasks get
    // excluded as already-running, never-triaged-clear, or over today's budget.
    // A chip that just says "done" would hide exactly the part that matters.
    const dock = read("../apps/web/src/components/steward-dock.tsx");
    expect(dock).toContain("describeOutcome");
    for (const reason of ["unclear", "already-running", "over-budget"]) {
      expect(dock, `outcome never explains "${reason}"`).toContain(reason);
    }
  });

  it("Steward is told NOT to propose these speculatively", () => {
    // add_task became proactive in the same change; these must not. Writing
    // work down is free, starting agents spends real money.
    const src = read("../apps/server/src/steward/assistant.ts");
    expect(src).toContain("Never propose one of these speculatively");
  });
});
