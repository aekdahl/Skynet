// Pre-work exploration (grounding a draft brief against the repo) has no run or
// agent to inherit a model from, so it was hardcoded — and hardcoded to Opus,
// which kept an expensive model in the loop for every workspace no matter what
// its fleet was set to. This reads code and reports back; it does not need the
// strongest model available.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WorkspaceSettings, UpdateWorkspaceSettingsRequest } from "@skynet/shared";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("exploration model is a setting, not a constant", () => {
  it("defaults to a mid-tier model", () => {
    expect(WorkspaceSettings.parse({ workspaceId: "w" }).exploreModel).toBe("sonnet-5");
  });

  it("an operator can change it", () => {
    expect(UpdateWorkspaceSettingsRequest.parse({ exploreModel: "deepseek-v4-flash" }).exploreModel).toBe("deepseek-v4-flash");
  });

  it("refuses an empty model rather than silently falling back", () => {
    expect(UpdateWorkspaceSettingsRequest.safeParse({ exploreModel: "" }).success).toBe(false);
  });

  it("accepts an unlisted model — the catalog is advisory", () => {
    // Same rule as every other model field: a model released after this build
    // must still be usable without a catalog edit.
    expect(UpdateWorkspaceSettingsRequest.parse({ exploreModel: "kimi-k3" }).exploreModel).toBe("kimi-k3");
  });

  it("no Opus model id is hardcoded on the exploration path any more", () => {
    const src = read("../apps/server/src/orchestrator.ts");
    expect(src).not.toContain('const EXPLORE_MODEL = "opus');
    expect(src).toContain("EXPLORE_MODEL_FALLBACK");
    // …and the fallback itself is mid-tier.
    expect(src).toMatch(/EXPLORE_MODEL_FALLBACK = "sonnet/);
  });

  it("the exploration call reads the setting, not the constant", () => {
    const src = read("../apps/server/src/orchestrator.ts");
    expect(src).toContain("exploreModel = (await this.fleetPolicy(ws)).exploreModel || EXPLORE_MODEL_FALLBACK");
    expect(src).toContain("model: exploreModel,");
  });
});
