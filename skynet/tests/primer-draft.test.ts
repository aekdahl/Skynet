// S2: primer-draft.ts — the deterministic repo digest + one-consult-call draft
// itself (Operations.draftProjectPrimer's wiring, and the never-auto-saved
// contract, are covered in tests/project-primer.test.ts with this module
// mocked out). Here `draftPrimer` runs for REAL against a throwaway local
// repo, with only `oneShotText` (the actual LLM call) stubbed — same
// "mock the model, not the deterministic logic around it" discipline as
// task-linter.test.ts.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { Project } from "@skynet/shared";
import { draftPrimer } from "../apps/server/src/primer-draft.js";

const oneShotText = vi.fn<(opts: { prompt: string; model?: string; cwd?: string; apiKey?: string }) => Promise<string>>();
vi.mock("@skynet/runner-sdk/claude", () => ({
  oneShotText: (opts: { prompt: string; model?: string; cwd?: string; apiKey?: string }) => oneShotText(opts),
}));

const baseProject = (over: Partial<Project> = {}): Project =>
  ({
    id: "p1",
    workspaceId: DEFAULT_WORKSPACE,
    name: "Acme",
    goal: "Ship the checkout redesign",
    runIds: [],
    status: "active",
    autonomy: true,
    approvalLevel: "trusted",
    approvalRules: [],
    repoPath: null,
    gitBacked: false,
    repo: undefined,
    instructions: null,
    primer: null,
    ...over,
  }) as Project;

describe("draftPrimer — no bound repo", () => {
  it("throws a clear error and never calls the model", async () => {
    await expect(draftPrimer(DEFAULT_WORKSPACE, baseProject())).rejects.toThrow(/no bound repository/);
    expect(oneShotText).not.toHaveBeenCalled();
  });
});

describe("draftPrimer — local repo digest + draft", () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "skynet-primer-draft-"));
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "acme", scripts: { build: "tsc", test: "vitest run" } }, null, 2));
    writeFileSync(join(repo, "README.md"), "# Acme\n\nA checkout redesign project.\n");
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src", "index.ts"), "export const x = 1;\n");
    mkdirSync(join(repo, "node_modules", "some-dep"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "some-dep", "index.js"), "module.exports = {};\n");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("returns a non-empty draft grounded on the digest (package.json, README, tree)", async () => {
    oneShotText.mockReset();
    oneShotText.mockResolvedValue("## Stack\nTypeScript, vitest.\n\n## Layout\nsrc/ holds the code.\n");

    const draft = await draftPrimer(DEFAULT_WORKSPACE, baseProject({ repoPath: repo }));
    expect(draft).toBe("## Stack\nTypeScript, vitest.\n\n## Layout\nsrc/ holds the code.\n".trim());

    expect(oneShotText).toHaveBeenCalledTimes(1);
    const { prompt } = oneShotText.mock.calls[0]![0];
    // The digest actually reached the model's prompt.
    expect(prompt).toContain("package.json");
    expect(prompt).toContain("checkout redesign project");
    expect(prompt).toContain("src/index.ts");
    // Noise directories never leak into the digest.
    expect(prompt).not.toContain("node_modules");
    expect(prompt).not.toContain(".git/");
    // The project's goal grounds the ask.
    expect(prompt).toContain("Ship the checkout redesign");
  });

  it("wraps a consult failure with a clear message", async () => {
    oneShotText.mockReset();
    oneShotText.mockImplementation(() => { throw new Error("provider unavailable"); });

    await expect(draftPrimer(DEFAULT_WORKSPACE, baseProject({ repoPath: repo }))).rejects.toThrow(/Couldn't draft a primer.*provider unavailable/);
  });

  it("throws when the model returns an empty draft", async () => {
    oneShotText.mockReset();
    oneShotText.mockResolvedValue("   \n  ");

    await expect(draftPrimer(DEFAULT_WORKSPACE, baseProject({ repoPath: repo }))).rejects.toThrow(/empty draft/);
  });

  it("caps an oversized draft rather than storing it unbounded", async () => {
    oneShotText.mockReset();
    oneShotText.mockResolvedValue("x".repeat(20_000));

    const draft = await draftPrimer(DEFAULT_WORKSPACE, baseProject({ repoPath: repo }));
    expect(draft.length).toBeLessThanOrEqual(12_000);
  });
});

describe("draftPrimer — repo with nothing readable", () => {
  it("throws a clear error when the bound local folder has no manifest/README/tree to ground a draft on", async () => {
    const empty = mkdtempSync(join(tmpdir(), "skynet-primer-empty-"));
    try {
      oneShotText.mockReset();
      await expect(draftPrimer(DEFAULT_WORKSPACE, baseProject({ repoPath: empty }))).rejects.toThrow(/Couldn't read anything/);
      expect(oneShotText).not.toHaveBeenCalled();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
