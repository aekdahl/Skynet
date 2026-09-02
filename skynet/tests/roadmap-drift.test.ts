// Phase 28 (TASK 31) — HTTP-level coverage for the Drift dashboard's two new
// server actions: ORPHANS' "propose N roadmap lines" (POST .../roadmap/
// proposals, riding TASK 28's real proposeRoadmapChange) and ONE DECISION's
// "MOVE IT TO Q4"/"KEEP AND RE-DATE Q3" (POST .../roadmap/commit-edit, a
// direct attributed commit with no proposal). Same real-Fastify-app +
// real-local-git-repo harness as roadmap-doc-view-routes.test.ts — the
// underlying RULES (Rule 1-4, attribution) are already covered by
// roadmap-proposal-governance.test.ts; this file is about these two ROUTES
// actually producing real store/repo effects.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { Agent, DEFAULT_WORKSPACE } from "@skynet/shared";
import type { Project } from "@skynet/shared";
import { registerApi } from "../apps/server/src/api.js";
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
const AUTH = { authorization: "Bearer dev-cyberdyne" }; // → DEFAULT_WORKSPACE, operatorId "jordan"

const ROADMAP = `# Roadmap

## Phase 1

- [ ] First item
- [ ] Second item
`;

let repo: string;
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

const mkProject = (): Project =>
  ({
    id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [],
    status: "active", repoPath: repo, gitBacked: true, repo: null, syncSourceStatus: false, roadmapPath: null,
    autonomy: true, approvalLevel: "trusted",
  }) as Project;

let app: FastifyInstance;
let store: MemoryStore;
let ops: Operations;

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "skynet-roadmap-drift-"));
  execFileSync("git", ["init", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@t.local"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "T"]);
  writeFileSync(join(repo, "ROADMAP.md"), ROADMAP);
  git("add", "-A");
  git("commit", "-m", "init roadmap");

  store = new MemoryStore({ seed: false });
  const hub = new Hub(store, new NullBus());
  const orch = new Orchestrator(store, hub, provider);
  ops = new Operations({ store, hub, orchestrator: orch });
  await store.putProject(mkProject());
  await store.putAgent(Agent.parse({ id: "agent-a", workspaceId: DEFAULT_WORKSPACE, name: "Agent A", provider: "claude", model: "sonnet", status: "idle" }));

  app = Fastify();
  await registerApi(app, { operations: ops, orchestrator: orch });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "Not found" }));
  await app.ready();
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

async function syncedDoc() {
  const res = await app.inject({ method: "GET", url: "/api/projects/p1/roadmap/doc", headers: AUTH });
  return res.json();
}

describe("POST /api/projects/:id/roadmap/proposals (Drift's ORPHANS panel)", () => {
  it("creates a real, governed RoadmapProposal — retrievable from the store afterward, not a fire-and-forget", async () => {
    const doc = await syncedDoc();
    const section = doc.sections[0].id;

    const res = await app.inject({
      method: "POST",
      url: "/api/projects/p1/roadmap/proposals",
      headers: AUTH,
      payload: {
        agentId: "agent-a",
        section,
        headline: "Cover 2 orphan tasks with a roadmap line",
        diff: { added: ["- [ ] **Orphan task A**", "- [ ] **Orphan task B**"], removed: [], context: "" },
        reasoning: "2 tasks have no roadmap line linking to them.",
      },
    });
    expect(res.statusCode).toBe(200);
    const created = res.json();
    expect(created.state).toBe("open");
    expect(created.diff.added).toEqual(["- [ ] **Orphan task A**", "- [ ] **Orphan task B**"]);

    // Really persisted — a second, independent read confirms it, and the
    // agent-initiated path also raises a roadmap_edit Inbox card (TASK 30).
    const listRes = await app.inject({ method: "GET", url: "/api/projects/p1/roadmap/proposals", headers: AUTH });
    expect(listRes.json()).toHaveLength(1);
    expect(listRes.json()[0].id).toBe(created.id);

    const queue = await store.listQueue(DEFAULT_WORKSPACE);
    const card = queue.find((h) => h.roadmapProposalId === created.id);
    expect(card).toMatchObject({ kind: "roadmap_edit" });
  });

  it("400s a malformed body — never silently drops an invalid proposal", async () => {
    const res = await app.inject({ method: "POST", url: "/api/projects/p1/roadmap/proposals", headers: AUTH, payload: { agentId: "agent-a" } });
    expect(res.statusCode).toBe(400);
  });

  it("404s an unknown agentId — same NotFoundError the underlying Operations method already throws", async () => {
    const doc = await syncedDoc();
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/p1/roadmap/proposals",
      headers: AUTH,
      payload: { agentId: "nope", section: doc.sections[0].id, headline: "x", diff: { added: [], removed: [], context: "" }, reasoning: "x" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/projects/:id/roadmap/commit-edit (Drift's ONE DECISION panel)", () => {
  it("commits the diff to the real repo, authored as the operator, with no RoadmapProposal or HITL involved", async () => {
    const before = readFileSync(join(repo, "ROADMAP.md"), "utf8");

    const res = await app.inject({
      method: "POST",
      url: "/api/projects/p1/roadmap/commit-edit",
      headers: AUTH,
      payload: {
        diff: { added: ["- [ ] First item — promised: Q4 2026\n"], removed: ["- [ ] First item"], context: "- [ ] First item\n- [ ] Second item\n" },
        message: "Skynet: move First item to Q4 (Drift dashboard)",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ committed: true });

    const after = readFileSync(join(repo, "ROADMAP.md"), "utf8");
    expect(after).not.toBe(before);
    expect(after).toContain("promised: Q4 2026");
    expect(after).not.toContain("- [ ] First item\n"); // the old line is gone, not just appended-to

    // Real attribution — same convention TASK 28's own commit path uses.
    const raw = git("cat-file", "commit", "HEAD");
    const authorLine = raw.split("\n").find((l) => l.startsWith("author "))!;
    expect(authorLine).toContain("jordan <jordan@operators.skynet.local>");

    // No proposal or Inbox card was created for this — it's a direct commit.
    const proposalsRes = await app.inject({ method: "GET", url: "/api/projects/p1/roadmap/proposals", headers: AUTH });
    expect(proposalsRes.json()).toEqual([]);
  });

  it("400s a malformed body", async () => {
    const res = await app.inject({ method: "POST", url: "/api/projects/p1/roadmap/commit-edit", headers: AUTH, payload: {} });
    expect(res.statusCode).toBe(400);
  });
});
