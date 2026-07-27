// HTTP route-level guard for the local folder browser: GET /api/fs/list. It
// powers the project folder picker, and the web client + FolderPicker depend on
// it — but a refactor once dropped the route from api.ts (leaving listDir
// orphaned), so every picker call 404'd and no test noticed (the modal just
// showed an empty "…"). This drives the REAL Fastify app at the path the client
// posts to, asserting the route exists and returns a well-formed listing.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ProviderId } from "@skynet/shared";
import { registerApi } from "../apps/server/src/api.js";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { Operations } from "../apps/server/src/operations.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
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

const AUTH = { authorization: "Bearer dev-cyberdyne" };
// vitest runs with NODE_ENV=test → config.allowLocalFs defaults on (local build).

describe("HTTP route: GET /api/fs/list (folder picker)", () => {
  let app: FastifyInstance;
  let base: string;

  beforeEach(async () => {
    const store = new MemoryStore({ seed: false });
    const hub = new Hub(store, new NullBus());
    const orchestrator = new Orchestrator(store, hub, new NoopProvider());
    const ops = new Operations({ store, hub, orchestrator });
    app = Fastify();
    await registerApi(app, { operations: ops, orchestrator });
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "Not found" }));
    await app.ready();

    // A known layout: base/ with a plain subdir + a nested git repo.
    base = mkdtempSync(join(tmpdir(), "skynet-fslist-"));
    mkdirSync(join(base, "plain"));
    const repo = join(base, "myrepo");
    execFileSync("git", ["init", "-q", repo]);
  });
  afterEach(async () => {
    await app.close();
    rmSync(base, { recursive: true, force: true });
  });

  const list = async (path?: string) => {
    const q = path ? `?path=${encodeURIComponent(path)}` : "";
    const res = await app.inject({ method: "GET", url: `/api/fs/list${q}`, headers: AUTH });
    return res;
  };

  it("is registered (not 404) and returns a listing for a real dir", async () => {
    const res = await list(base);
    expect(res.statusCode).toBe(200); // the regression: this was 404
    const body = res.json();
    expect(body.exists).toBe(true);
    expect(isAbsolute(body.path)).toBe(true);
    const names = body.entries.map((e: { name: string }) => e.name).sort();
    expect(names).toEqual(["myrepo", "plain"]);
    // The nested repo is flagged so the picker can badge it.
    const repo = body.entries.find((e: { name: string }) => e.name === "myrepo");
    expect(repo.isGitRepo).toBe(true);
  });

  it("flags the listed dir itself as a git repo", async () => {
    const body = (await list(join(base, "myrepo"))).json();
    expect(body.exists).toBe(true);
    expect(body.isGitRepo).toBe(true);
  });

  it("expands a leading ~ to the home dir", async () => {
    const body = (await list("~")).json();
    expect(body.path).toBe(homedir());
    expect(body.exists).toBe(true);
  });

  it("reports exists:false for a nonexistent path (typed-path validation)", async () => {
    const body = (await list(join(base, "no", "such", "dir"))).json();
    expect(body.exists).toBe(false);
    expect(body.entries).toEqual([]);
  });

  it("defaults to the home dir when no path is given", async () => {
    const body = (await list()).json();
    expect(body.path).toBe(homedir());
    expect(body.exists).toBe(true);
  });
});
