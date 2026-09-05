// Security: an "author"-scoped PATCH /api/projects/:id used to be able to set
// roadmapPath (or repoPath itself) to an arbitrary filesystem path with zero
// containment check — GET /api/projects/:id/roadmap then returned that file's
// raw content, giving read access to anything the server process could reach.
//
// Two independent fixes, tested separately here:
//  1. readProjectDoc (steward/docs.ts) now resolves the joined path and
//     refuses it unless it stays within repoPath — see roadmap-doc-path.test.ts
//     for the roadmapPath-specific traversal cases exercised through
//     resolveRoadmapDoc.
//  2. Operations.createProject/updateProject now refuse to accept a NEW
//     repoPath at all unless config.allowLocalFs is on — the same gate
//     /api/fs/list already applies to local-filesystem exposure (local/desktop
//     only, MUST stay off for a hosted/multi-user deployment). Without this,
//     repoPath itself could be pointed anywhere, making any "stays within
//     repoPath" check on relPath vacuous.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE, Project } from "@skynet/shared";
import { config } from "../apps/server/src/config.js";
import { Hub } from "../apps/server/src/hub.js";
import { Operations } from "../apps/server/src/operations.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import { InProcessBus } from "../apps/server/src/bus.js";
import { readProjectDoc } from "../apps/server/src/steward/docs.js";

const WS = DEFAULT_WORKSPACE;

describe("readProjectDoc — a relPath escaping repoPath never reads outside it", () => {
  let parent: string, repo: string;

  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), "docs-parent-"));
    repo = join(parent, "repo");
    mkdirSync(repo);
    writeFileSync(join(parent, "secret.txt"), "outside the repo");
  });
  afterEach(() => {
    rmSync(parent, { recursive: true, force: true });
  });

  const project = (): Project =>
    Project.parse({ id: "p1", workspaceId: WS, name: "P", goal: "", runIds: [], status: "active", repoPath: repo });

  it("a '..'-escaping relPath is treated as not-found, never read", async () => {
    const doc = await readProjectDoc(WS, project(), "../secret.txt");
    expect(doc).toBeNull();
  });

  it("an absolute relPath elsewhere on disk is treated as not-found, never read", async () => {
    const doc = await readProjectDoc(WS, project(), join(parent, "secret.txt"));
    expect(doc).toBeNull();
  });

  it("a plain in-repo relPath still reads normally (no regression)", async () => {
    writeFileSync(join(repo, "README.md"), "hello\n");
    const doc = await readProjectDoc(WS, project(), "README.md");
    expect(doc).toMatchObject({ path: "README.md", content: "hello\n", source: "local" });
  });
});

describe("Operations.createProject/updateProject — repoPath is gated by config.allowLocalFs", () => {
  const mkOps = () => {
    const store = new MemoryStore({ seed: false });
    const hub = new Hub(store, new InProcessBus());
    return { store, operations: new Operations({ store, hub, orchestrator: new Orchestrator(store, hub) }) };
  };
  let savedAllowLocalFs: boolean;

  beforeEach(() => {
    savedAllowLocalFs = config.allowLocalFs;
  });
  afterEach(() => {
    config.allowLocalFs = savedAllowLocalFs;
  });

  it("createProject refuses a repoPath when local-fs access is off", async () => {
    config.allowLocalFs = false;
    const { operations } = mkOps();
    await expect(operations.createProject(WS, { name: "P", goal: "g", repoPath: "/etc" })).rejects.toThrow(
      /local folder/i,
    );
  });

  it("createProject accepts a repoPath when local-fs access is on (no regression)", async () => {
    config.allowLocalFs = true;
    const { operations } = mkOps();
    const tmp = mkdtempSync(join(tmpdir(), "create-repo-"));
    try {
      const created = await operations.createProject(WS, { name: "P", goal: "g", repoPath: tmp });
      expect(created.repoPath).toBe(tmp);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("updateProject refuses to SET a new repoPath when local-fs access is off", async () => {
    config.allowLocalFs = true;
    const { store, operations } = mkOps();
    await store.putProject(Project.parse({ id: "p1", workspaceId: WS, name: "P", goal: "", runIds: [], status: "active" }));
    config.allowLocalFs = false;
    await expect(operations.updateProject(WS, "p1", { repoPath: "/etc" }, "op-1")).rejects.toThrow(/local folder/i);
  });

  it("updateProject still allows CLEARING repoPath to null even when local-fs access is off", async () => {
    config.allowLocalFs = true;
    const { store, operations } = mkOps();
    const tmp = mkdtempSync(join(tmpdir(), "clear-repo-"));
    try {
      await store.putProject(Project.parse({ id: "p1", workspaceId: WS, name: "P", goal: "", runIds: [], status: "active", repoPath: tmp }));
      config.allowLocalFs = false;
      const cleared = await operations.updateProject(WS, "p1", { repoPath: null }, "op-1");
      expect(cleared.repoPath).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
