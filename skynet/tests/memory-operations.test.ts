// Memory v0, phase 1 — Operations.listProjectMemory / addMemoryFact: the
// operator-facing read+write surface. Real git repos, same harness as
// roadmap-proposal-governance.test.ts (that PR's own commit-attribution test
// is the model for this one — parse the real git commit object, don't trust
// the return value).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
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

let repo: string;
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

const mkProject = (over: Partial<Project> = {}): Project =>
  ({
    id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "Acme Web", goal: "", runIds: [],
    status: "active", repoPath: repo, gitBacked: true, repo: null, syncSourceStatus: false,
    ...over,
  }) as Project;

async function setup(projectOver: Partial<Project> = {}) {
  const store = new MemoryStore({ seed: false });
  const hub = new Hub(store, new NullBus());
  const orch = new Orchestrator(store, hub, provider);
  const ops = new Operations({ store, hub, orchestrator: orch });
  await store.putProject(mkProject(projectOver));
  return { store, ops };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "skynet-memory-ops-"));
  execFileSync("git", ["init", "-b", "main", repo]);
  git("config", "user.email", "t@t.local");
  git("config", "user.name", "T");
  writeFileSync(join(repo, "README.md"), "hi\n");
  git("add", "-A");
  git("commit", "-m", "init");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("addMemoryFact", () => {
  it("creates a brand-new workspace.md, committed with the operator as author, real attribution", async () => {
    const { ops } = await setup();
    const fact = await ops.addMemoryFact(
      DEFAULT_WORKSPACE, "p1",
      { scope: "workspace", heading: "Never touch payments without review", body: "Broke prod once.", area: null, agentFamily: null, supersedes: null },
      "jordan",
    );
    expect(fact.scope).toBe("workspace");
    expect(fact.source).toBe("operator");
    expect(fact.confidence).toBe("stated");
    expect(fact.author).toBe("jordan");
    expect(fact.superseded).toBe(false);

    const raw = readFileSync(join(repo, ".skynet", "memory", "workspace.md"), "utf8");
    expect(raw).toContain("scope: workspace");
    expect(raw).toContain("## Never touch payments without review");
    expect(raw).toContain("Broke prod once.");

    const sha = git("rev-parse", "HEAD");
    const commit = git("cat-file", "commit", sha);
    expect(commit.split("\n").find((l) => l.startsWith("author "))).toContain("jordan <jordan@operators.skynet.local>");
    // No agent Co-authored-by — the operator typed this directly, nobody proposed it.
    expect(commit).not.toContain("Co-authored-by");
  });

  it("project scope writes projects/<slug>.md, agent scope writes agents/<family>.md", async () => {
    const { ops } = await setup();
    await ops.addMemoryFact(DEFAULT_WORKSPACE, "p1", { scope: "project", heading: "Uses pnpm workspaces", body: "", area: null, agentFamily: null, supersedes: null }, "jordan");
    await ops.addMemoryFact(DEFAULT_WORKSPACE, "p1", { scope: "agent", heading: "Keep commits small", body: "", area: null, agentFamily: "claude", supersedes: null }, "jordan");

    expect(readFileSync(join(repo, ".skynet", "memory", "projects", "acme-web.md"), "utf8")).toContain("Uses pnpm workspaces");
    expect(readFileSync(join(repo, ".skynet", "memory", "agents", "claude.md"), "utf8")).toContain("Keep commits small");
  });

  it("area scope needs an area; agent scope needs an agentFamily", async () => {
    const { ops } = await setup();
    await expect(
      ops.addMemoryFact(DEFAULT_WORKSPACE, "p1", { scope: "area", heading: "x", body: "", area: null, agentFamily: null, supersedes: null }, "jordan"),
    ).rejects.toThrow(/needs an area/);
    await expect(
      ops.addMemoryFact(DEFAULT_WORKSPACE, "p1", { scope: "agent", heading: "x", body: "", area: null, agentFamily: null, supersedes: null }, "jordan"),
    ).rejects.toThrow(/needs an agentFamily/);
  });

  it("a second fact APPENDS — the first fact's bytes are untouched", async () => {
    const { ops } = await setup();
    await ops.addMemoryFact(DEFAULT_WORKSPACE, "p1", { scope: "workspace", heading: "First fact", body: "", area: null, agentFamily: null, supersedes: null }, "jordan");
    await ops.addMemoryFact(DEFAULT_WORKSPACE, "p1", { scope: "workspace", heading: "Second fact", body: "", area: null, agentFamily: null, supersedes: null }, "jordan");

    const raw = readFileSync(join(repo, ".skynet", "memory", "workspace.md"), "utf8");
    expect(raw).toContain("## First fact");
    expect(raw).toContain("## Second fact");
    expect(raw.indexOf("## First fact")).toBeLessThan(raw.indexOf("## Second fact"));
  });

  it("throws for a project with no bound repo", async () => {
    const { ops } = await setup({ repoPath: null, gitBacked: false, repo: null });
    await expect(
      ops.addMemoryFact(DEFAULT_WORKSPACE, "p1", { scope: "workspace", heading: "x", body: "", area: null, agentFamily: null, supersedes: null }, "jordan"),
    ).rejects.toThrow(/no bound repo/);
  });
});

describe("listProjectMemory", () => {
  it("lists facts across workspace/project/agent scopes for a local repoPath-bound project", async () => {
    const { ops } = await setup();
    await ops.addMemoryFact(DEFAULT_WORKSPACE, "p1", { scope: "workspace", heading: "Workspace fact", body: "", area: null, agentFamily: null, supersedes: null }, "jordan");
    await ops.addMemoryFact(DEFAULT_WORKSPACE, "p1", { scope: "project", heading: "Project fact", body: "", area: null, agentFamily: null, supersedes: null }, "jordan");
    await ops.addMemoryFact(DEFAULT_WORKSPACE, "p1", { scope: "agent", heading: "Agent fact", body: "", area: null, agentFamily: "claude", supersedes: null }, "jordan");

    const facts = await ops.listProjectMemory(DEFAULT_WORKSPACE, "p1");
    expect(facts.map((f) => f.heading).sort()).toEqual(["Agent fact", "Project fact", "Workspace fact"]);
    const agentFact = facts.find((f) => f.heading === "Agent fact")!;
    expect(agentFact.scope).toBe("agent");
    expect(agentFact.agentFamily).toBe("claude");
  });

  it("marks a superseded fact — still returned (history), not hidden", async () => {
    const { ops } = await setup();
    const original = await ops.addMemoryFact(DEFAULT_WORKSPACE, "p1", { scope: "workspace", heading: "Old rule", body: "", area: null, agentFamily: null, supersedes: null }, "jordan");
    await ops.addMemoryFact(DEFAULT_WORKSPACE, "p1", { scope: "workspace", heading: "New rule", body: "", area: null, agentFamily: null, supersedes: original.id }, "jordan");

    const facts = await ops.listProjectMemory(DEFAULT_WORKSPACE, "p1");
    expect(facts.find((f) => f.id === original.id)?.superseded).toBe(true);
    expect(facts.find((f) => f.heading === "New rule")?.superseded).toBe(false);
  });

  it("a project with no memory files yet returns an empty list, not an error", async () => {
    const { ops } = await setup();
    expect(await ops.listProjectMemory(DEFAULT_WORKSPACE, "p1")).toEqual([]);
  });

  it("a project with no bound repo returns an empty list, not an error", async () => {
    const { ops } = await setup({ repoPath: null, gitBacked: false, repo: null });
    expect(await ops.listProjectMemory(DEFAULT_WORKSPACE, "p1")).toEqual([]);
  });
});
