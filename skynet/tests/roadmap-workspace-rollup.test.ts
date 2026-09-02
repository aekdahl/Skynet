// Phase 29 (TASK 32) — "six repos, one quarter": a workspace-wide roll-up
// over every project the caller already has access to, scoped by the same
// principal.projectIds allowlist mcp/project-scope.ts enforces everywhere
// else (no new access-control surface). Real git repos, exactly like
// roadmap-proposal-governance.test.ts's own harness.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { Principal } from "../apps/server/src/auth.js";
import type { Project } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { Operations } from "../apps/server/src/operations.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerProvider } from "@skynet/runner-sdk";

class NullBus implements Bus {
  publish(): void {}
  subscribe(): () => void {
    return () => {};
  }
}
const provider = {} as RunnerProvider;

const UNRESTRICTED: Principal = { workspaceId: DEFAULT_WORKSPACE, operatorId: "op-1" };

let repoA: string;
let repoB: string;
const git = (repo: string, ...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const initRepo = (repo: string, roadmap?: string) => {
  execFileSync("git", ["init", "-b", "main", repo]);
  git(repo, "config", "user.email", "t@t.local");
  git(repo, "config", "user.name", "T");
  if (roadmap) writeFileSync(join(repo, "ROADMAP.md"), roadmap);
  else writeFileSync(join(repo, "README.md"), "no roadmap here\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "init");
};

const mkProject = (over: Partial<Project> = {}): Project =>
  ({
    id: "pA", workspaceId: DEFAULT_WORKSPACE, name: "Repo A", goal: "", runIds: [],
    status: "active", repoPath: repoA, gitBacked: true, repo: "acme/a", syncSourceStatus: false, roadmapPath: null,
    autonomy: true, approvalLevel: "trusted", enabledRunnerCredentialIds: [],
    ...over,
  }) as Project;

const ROADMAP_A = `# A\n\n## Now\n- [ ] Task with an id <!--#a1-->\n`;
const ROADMAP_B = `# B\n\n## Now\n- [ ] Task with an id <!--#b1-->\n`;

async function setup() {
  const store = new MemoryStore({ seed: false });
  const hub = new Hub(store, new NullBus());
  const orch = new Orchestrator(store, hub, provider);
  const ops = new Operations({ store, hub, orchestrator: orch });
  return { store, ops };
}

beforeEach(() => {
  repoA = mkdtempSync(join(tmpdir(), "skynet-rollup-a-"));
  repoB = mkdtempSync(join(tmpdir(), "skynet-rollup-b-"));
});
afterEach(() => {
  rmSync(repoA, { recursive: true, force: true });
  rmSync(repoB, { recursive: true, force: true });
});

describe("getWorkspaceRoadmapRollup — access scope", () => {
  it("an unrestricted principal (every human/workspace token today) sees every accessible project", async () => {
    initRepo(repoA, ROADMAP_A);
    initRepo(repoB, ROADMAP_B);
    const { store, ops } = await setup();
    await store.putProject(mkProject());
    await store.putProject(mkProject({ id: "pB", name: "Repo B", repoPath: repoB, repo: "acme/b" }));

    const rollup = await ops.getWorkspaceRoadmapRollup(DEFAULT_WORKSPACE, UNRESTRICTED);
    expect(rollup.rows.map((r) => r.projectId).sort()).toEqual(["pA", "pB"]);
  });

  it("a project-scoped principal only sees the projects in its allowlist — the other project simply doesn't appear", async () => {
    initRepo(repoA, ROADMAP_A);
    initRepo(repoB, ROADMAP_B);
    const { store, ops } = await setup();
    await store.putProject(mkProject());
    await store.putProject(mkProject({ id: "pB", name: "Repo B", repoPath: repoB, repo: "acme/b" }));

    const scoped: Principal = { workspaceId: DEFAULT_WORKSPACE, operatorId: "mcp:scoped", projectIds: ["pA"] };
    const rollup = await ops.getWorkspaceRoadmapRollup(DEFAULT_WORKSPACE, scoped);
    expect(rollup.rows.map((r) => r.projectId)).toEqual(["pA"]);
    // Not an error, not a dashed row either — genuinely invisible, same as
    // every other project-scoped read in this codebase.
    expect(rollup.noRoadmapProjects.map((p) => p.projectId)).not.toContain("pB");
  });
});

describe("getWorkspaceRoadmapRollup — no roadmap file", () => {
  it("a project with no ROADMAP.md renders the dashed row, not an error, and never appears in `rows`", async () => {
    initRepo(repoA); // README only, no ROADMAP.md
    const { store, ops } = await setup();
    await store.putProject(mkProject());

    const rollup = await ops.getWorkspaceRoadmapRollup(DEFAULT_WORKSPACE, UNRESTRICTED);
    expect(rollup.rows).toEqual([]);
    expect(rollup.noRoadmapProjects).toEqual([{ projectId: "pA", projectName: "Repo A" }]);
  });

  it("a project with no bound repo at all is skipped entirely — not a dashed row, not a normal row", async () => {
    const { store, ops } = await setup();
    await store.putProject(mkProject({ repoPath: null, repo: null }));

    const rollup = await ops.getWorkspaceRoadmapRollup(DEFAULT_WORKSPACE, UNRESTRICTED);
    expect(rollup.rows).toEqual([]);
    expect(rollup.noRoadmapProjects).toEqual([]);
  });
});

describe("scaffoldProjectRoadmap — create one from the board", () => {
  it("produces a real committed file with roadmapPath set afterward, correctly attributed", async () => {
    initRepo(repoA); // no ROADMAP.md yet
    const { store, ops } = await setup();
    await store.putProject(mkProject());

    const doc = await ops.scaffoldProjectRoadmap(DEFAULT_WORKSPACE, "pA", "jordan");
    expect(doc.raw).toContain("Repo A Roadmap");

    // The file is really there, on disk, in the repo.
    expect(existsSync(join(repoA, "ROADMAP.md"))).toBe(true);
    expect(readFileSync(join(repoA, "ROADMAP.md"), "utf8")).toContain("Repo A Roadmap");

    // roadmapPath is set — a later resolveRoadmapDoc/rollup no longer needs
    // to fall back to the default-candidate search.
    expect((await store.getProject("pA"))?.roadmapPath).toBe("ROADMAP.md");

    // Real commit, real author (TASK 28's same attribution path).
    const sha = git(repoA, "rev-parse", "HEAD");
    const raw = git(repoA, "cat-file", "commit", sha);
    expect(raw.split("\n").find((l) => l.startsWith("author "))).toContain("jordan <jordan@operators.skynet.local>");
    expect(raw).toContain("scaffold ROADMAP.md");

    // And the project now shows up as a normal row, not a dashed one.
    const rollup = await ops.getWorkspaceRoadmapRollup(DEFAULT_WORKSPACE, UNRESTRICTED);
    expect(rollup.rows.map((r) => r.projectId)).toEqual(["pA"]);
    expect(rollup.noRoadmapProjects).toEqual([]);
  });

  it("refuses to scaffold over an already-existing roadmap file", async () => {
    initRepo(repoA, ROADMAP_A);
    const { store, ops } = await setup();
    await store.putProject(mkProject());

    await expect(ops.scaffoldProjectRoadmap(DEFAULT_WORKSPACE, "pA", "jordan")).rejects.toThrow(/already has a roadmap/);
  });
});

describe("cross-repo milestone grouping", () => {
  it("groups a heading shared by 2+ projects; a repo's own unique heading stays out of `milestones`", async () => {
    initRepo(repoA, `# A\n\n## Now\n- [ ] a1\n\n## Only in A\n- [ ] a2\n`);
    initRepo(repoB, `# B\n\n## Now\n- [ ] b1\n`);
    const { store, ops } = await setup();
    await store.putProject(mkProject());
    await store.putProject(mkProject({ id: "pB", name: "Repo B", repoPath: repoB, repo: "acme/b" }));

    const rollup = await ops.getWorkspaceRoadmapRollup(DEFAULT_WORKSPACE, UNRESTRICTED);
    const names = rollup.milestones.map((m) => m.name);
    expect(names).toEqual(["Now"]); // shared by both repos
    expect(names).not.toContain("Only in A"); // unique to one repo — not a "cross-repo" group

    const nowGroup = rollup.milestones.find((m) => m.name === "Now")!;
    expect(nowGroup.repos.map((r) => r.projectId).sort()).toEqual(["pA", "pB"]);
  });
});
