// HTTP + engine guard for the per-run PRE-MERGE preview ("Preview this change"):
// GET/POST /api/runs/:id/preview{,/start,/stop}. Drives the REAL Fastify app at
// the paths the web client posts to, with a REAL git repo whose run branch
// (`agent/<runId>`) carries a tiny dev server. Asserts the preview actually
// spins that branch — not the integration branch — so an operator sees the
// change before it merges. Also locks the "no commits yet" and scoping guards.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE, Project, TaskRun, type ProviderId } from "@skynet/shared";
import { registerApi } from "../apps/server/src/api.js";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { Operations } from "../apps/server/src/operations.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import { projectPreview } from "../apps/server/src/preview/project-preview.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

class NullBus implements Bus {
  publish(): void {}
  subscribe(): () => void { return () => {}; }
}
class NoopProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  async start(spec: StartSpec, _events: RunnerEvents): Promise<RunnerHandle> {
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

const AUTH = { authorization: "Bearer dev-cyberdyne" }; // → DEFAULT_WORKSPACE
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (repo: string, ...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe", env: GIT_ENV });

// A minimal dev server: reads $PORT and serves a marker so we can prove WHICH
// branch is live. Committed onto the run branch only.
const SERVER_JS =
  'require("http").createServer((_q,r)=>{r.writeHead(200,{"content-type":"text/html"});r.end("<h1>RUN-BRANCH-PREVIEW-OK</h1>")})' +
  '.listen(Number(process.env.PORT),"127.0.0.1");';

describe("HTTP + engine: per-run pre-merge preview (/api/runs/:id/preview)", () => {
  let app: FastifyInstance;
  let store: MemoryStore;
  let repo: string;
  const wtRoot = join(process.cwd(), ".skynet-worktrees");

  const seedRun = async (id: string, branch: string) => {
    await store.putProject(
      Project.parse({ id: "p-prev", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [id], status: "active", repoPath: repo, gitBacked: true }),
    );
    await store.putRun(
      TaskRun.parse({
        id, workspaceId: DEFAULT_WORKSPACE, projectId: "p-prev", name: "the change", status: "review",
        agentId: null, provider: "claude", model: "opus", branch, modules: [], progress: 0.5, plan: [],
        modifiedFiles: [], log: [], startedAt: 0, lastHeartbeatAt: 0,
      }),
    );
  };

  beforeEach(async () => {
    store = new MemoryStore({ seed: false });
    const hub = new Hub(store, new NullBus());
    const orchestrator = new Orchestrator(store, hub, new NoopProvider());
    const ops = new Operations({ store, hub, orchestrator });
    app = Fastify();
    await registerApi(app, { operations: ops, orchestrator });
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "Not found" }));
    await app.ready();

    // A real repo: a base commit, then a run branch carrying the dev server.
    repo = mkdtempSync(join(tmpdir(), "skynet-runprev-"));
    git(repo, "init", "-q", ".");
    git(repo, "config", "user.email", "t@t");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "README"), "base\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "base");
    git(repo, "checkout", "-q", "-b", "agent/r-prev");
    mkdirSync(join(repo, ".skynet"));
    writeFileSync(join(repo, ".skynet", "preview.json"), JSON.stringify({ dev: "node server.js" }) + "\n");
    writeFileSync(join(repo, "server.js"), SERVER_JS);
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "the change");
    git(repo, "checkout", "-q", "-"); // leave the primary worktree off the run branch
  });

  afterEach(async () => {
    await projectPreview.stopAll().catch(() => undefined);
    await app.close();
    rmSync(repo, { recursive: true, force: true });
    rmSync(wtRoot, { recursive: true, force: true });
  });

  it("previews the RUN's branch (pre-merge), serving that branch's content", async () => {
    await seedRun("r-prev", "agent/r-prev");

    const res = await app.inject({ method: "POST", url: "/api/runs/r-prev/preview/start", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const state = res.json();
    expect(state.status).toBe("live");
    expect(state.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(state.recipe).toMatchObject({ source: "descriptor" });

    // The served page must be the RUN branch's content (proves we spun the
    // change under review, not the integration branch / base).
    const body = await fetch(state.url).then((r) => r.text());
    expect(body).toContain("RUN-BRANCH-PREVIEW-OK");

    // Status route reflects the live preview; stop tears it down.
    const status = await app.inject({ method: "GET", url: "/api/runs/r-prev/preview", headers: AUTH });
    expect(status.json().status).toBe("live");
    const stopped = await app.inject({ method: "POST", url: "/api/runs/r-prev/preview/stop", headers: AUTH });
    expect(stopped.json().status).toBe("stopped");
  }, 30_000);

  it("a run with no branch yet fails with a clear reason (not a raw git error)", async () => {
    await seedRun("r-empty", "agent/does-not-exist");
    const res = await app.inject({ method: "POST", url: "/api/runs/r-empty/preview/start", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const state = res.json();
    expect(state.status).toBe("failed");
    expect(state.error).toMatch(/no commits to preview yet/i);
  }, 15_000);

  it("is workspace-scoped + registered (domain 404 for an unknown run, not a missing-route 404)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/runs/nope/preview", headers: AUTH });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "TaskRun not found" });
  });

  it("does not leak the preview worktree after stop", async () => {
    await seedRun("r-prev", "agent/r-prev");
    await app.inject({ method: "POST", url: "/api/runs/r-prev/preview/start", headers: AUTH });
    await app.inject({ method: "POST", url: "/api/runs/r-prev/preview/stop", headers: AUTH });
    // git worktree list should no longer reference a preview-run_* dir.
    const list = git(repo, "worktree", "list").toString();
    expect(list).not.toMatch(/preview-run_/);
  }, 30_000);
});
