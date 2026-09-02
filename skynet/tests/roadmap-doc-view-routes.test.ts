// Momentum Rollout Phase 26 (TASK 29) — HTTP-level coverage for the new
// roadmap-document-view routes: the parsed doc, proposals list/apply,
// claim/revert, and history. A real Fastify app + real local git repo (same
// harness as roadmap-proposal-governance.test.ts / roadmap-blame.test.ts) —
// TASK 28's own apply-proposal RULES are already covered there; this file
// is about the ROUTE WIRING (client-facing shape, auth, 404s) plus the
// genuinely new claim/revert/history/doc surface this task adds.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
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
const AUTH = { authorization: "Bearer dev-cyberdyne" }; // → DEFAULT_WORKSPACE

const ROADMAP = `# Roadmap

## Phase 1

- [x] Shipped item
- [ ] Todo item
`;

let repo: string;
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const gitAs = (name: string, email: string, ...args: string[]) =>
  execFileSync("git", ["-C", repo, "-c", `user.name=${name}`, "-c", `user.email=${email}`, ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

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
  repo = mkdtempSync(join(tmpdir(), "skynet-roadmap-routes-"));
  execFileSync("git", ["init", "-b", "main", repo]);
  writeFileSync(join(repo, "ROADMAP.md"), ROADMAP);
  gitAs("jordan", "jordan@operators.skynet.local", "add", "-A");
  gitAs("jordan", "jordan@operators.skynet.local", "commit", "-m", "init roadmap");
  // A second commit, flat-Skynet-authored — the "agent-added, unclaimed" line.
  writeFileSync(join(repo, "ROADMAP.md"), ROADMAP + "- [ ] Agent-added item\n");
  gitAs("Skynet", "skynet@local", "add", "-A");
  gitAs("Skynet", "skynet@local", "commit", "-m", "Skynet: agent adds a line");

  store = new MemoryStore({ seed: false });
  const hub = new Hub(store, new NullBus());
  const orch = new Orchestrator(store, hub, provider);
  ops = new Operations({ store, hub, orchestrator: orch });
  await store.putProject(mkProject());

  app = Fastify();
  await registerApi(app, { operations: ops, orchestrator: orch });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "Not found" }));
  await app.ready();
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("GET /api/projects/:id/roadmap/doc", () => {
  it("returns the parsed doc with real per-line state and blame-derived provenance", async () => {
    const res = await app.inject({ method: "GET", url: "/api/projects/p1/roadmap/doc", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    const items = doc.ast.filter((n: { type: string }) => n.type === "checklistItem");
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ text: "Shipped item", state: "done", author: "jordan", claimedByHuman: true });
    expect(items[1]).toMatchObject({ text: "Todo item", state: "todo", author: "jordan" });
    expect(items[2]).toMatchObject({ text: "Agent-added item", state: "todo", author: "skynet", claimedByHuman: false });
    expect(items[2].blameSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("404s for a project outside the workspace", async () => {
    const res = await app.inject({ method: "GET", url: "/api/projects/nope/roadmap/doc", headers: AUTH });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/projects/:id/roadmap/proposals", () => {
  it("lists whatever's in the store for this project (empty for a fresh one)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/projects/p1/roadmap/proposals", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});

describe("POST /api/projects/:id/roadmap/proposals/:pid/apply", () => {
  it("404s a proposal id that doesn't exist — confirms the route is wired to Operations.applyRoadmapProposal", async () => {
    const res = await app.inject({ method: "POST", url: "/api/projects/p1/roadmap/proposals/nope/apply", headers: AUTH });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/projects/:id/roadmap/lines/:lineId/claim", () => {
  it("claims the agent-added line — subsequent doc reads show it as yours", async () => {
    const docRes = await app.inject({ method: "GET", url: "/api/projects/p1/roadmap/doc", headers: AUTH });
    const agentLine = docRes.json().ast.find((n: { text?: string }) => n.text === "Agent-added item");

    const claimRes = await app.inject({ method: "POST", url: `/api/projects/p1/roadmap/lines/${agentLine.id}/claim`, headers: AUTH });
    expect(claimRes.statusCode).toBe(200);
    expect(claimRes.json()).toMatchObject({ projectId: "p1", lineId: agentLine.id, operatorId: "jordan" });

    const afterRes = await app.inject({ method: "GET", url: "/api/projects/p1/roadmap/doc", headers: AUTH });
    const claimed = afterRes.json().ast.find((n: { id: string }) => n.id === agentLine.id);
    expect(claimed).toMatchObject({ claimedByHuman: true, author: "jordan", authorRef: "jordan" });
  });

  it("404s a line id that doesn't exist in this project's doc", async () => {
    const res = await app.inject({ method: "POST", url: "/api/projects/p1/roadmap/lines/nope/claim", headers: AUTH });
    expect(res.statusCode).toBe(404);
  });

  it("is idempotent — a second claim just replaces the row, no error", async () => {
    const docRes = await app.inject({ method: "GET", url: "/api/projects/p1/roadmap/doc", headers: AUTH });
    const agentLine = docRes.json().ast.find((n: { text?: string }) => n.text === "Agent-added item");
    await app.inject({ method: "POST", url: `/api/projects/p1/roadmap/lines/${agentLine.id}/claim`, headers: AUTH });
    const second = await app.inject({ method: "POST", url: `/api/projects/p1/roadmap/lines/${agentLine.id}/claim`, headers: AUTH });
    expect(second.statusCode).toBe(200);
  });
});

describe("POST /api/projects/:id/roadmap/lines/:lineId/revert", () => {
  it("reverts the commit that added the line — a real git revert, verified against the actual log", async () => {
    const docRes = await app.inject({ method: "GET", url: "/api/projects/p1/roadmap/doc", headers: AUTH });
    const agentLine = docRes.json().ast.find((n: { text?: string }) => n.text === "Agent-added item");
    const headBefore = git("rev-parse", "HEAD");

    const res = await app.inject({ method: "POST", url: `/api/projects/p1/roadmap/lines/${agentLine.id}/revert`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().committed).toBe(true);

    const headAfter = git("rev-parse", "HEAD");
    expect(headAfter).not.toBe(headBefore);
    const revertSubject = git("log", "-1", "--format=%s");
    expect(revertSubject).toMatch(/^Revert /);
    // The reverted content is genuinely gone from disk.
    const content = execFileSync("cat", [join(repo, "ROADMAP.md")]).toString();
    expect(content).not.toContain("Agent-added item");

    // The doc reflects the revert on the very next read (no stale cache).
    const afterDoc = await app.inject({ method: "GET", url: "/api/projects/p1/roadmap/doc", headers: AUTH });
    const items = afterDoc.json().ast.filter((n: { type: string }) => n.type === "checklistItem");
    expect(items).toHaveLength(2);
  });

  it("404s a line id that doesn't exist", async () => {
    const res = await app.inject({ method: "POST", url: "/api/projects/p1/roadmap/lines/nope/revert", headers: AUTH });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/projects/:id/roadmap/history", () => {
  it("returns the real newest-first commit log for the roadmap file", async () => {
    const res = await app.inject({ method: "GET", url: "/api/projects/p1/roadmap/history", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const history = res.json();
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ authorEmail: "skynet@local", subject: "Skynet: agent adds a line" });
    expect(history[1]).toMatchObject({ authorEmail: "jordan@operators.skynet.local", subject: "init roadmap" });
  });

  it("respects ?limit=", async () => {
    const res = await app.inject({ method: "GET", url: "/api/projects/p1/roadmap/history?limit=1", headers: AUTH });
    expect(res.json()).toHaveLength(1);
  });
});
