// Interop surface (v3 "Interop surface" roadmap item) — an OpenAI-compatible
// endpoint (apps/server/src/interop/openai.ts) plus a plain REST job-
// submission API (apps/server/src/interop/rest.ts), so external tools that
// don't speak MCP can still drive Skynet. Both routes were already fully
// implemented and wired into index.ts, but had ZERO test coverage anywhere in
// the repo (confirmed by grep before writing this file) — this closes that
// gap. Drives the REAL Fastify routes + a real Orchestrator against a
// throwaway git repo with a scripted provider (same harness shape as
// full-loop.test.ts), not mocks — the thing worth proving is that an external
// HTTP caller genuinely gets a real run out of these endpoints, with the same
// auth/project-scoping /mcp already enforces.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { ProviderId, Agent } from "@skynet/shared";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";
// Every server-side module below is imported DYNAMICALLY inside beforeAll,
// AFTER the SKYNET_INTEGRATION_REPO/SKYNET_WORKTREES_DIR env vars are set —
// same discipline as full-loop.test.ts/merge-conflict-ask-agent.test.ts.
// config.ts reads those env vars ONCE into a plain object at module-EVAL
// time (`integrationRepo: process.env.SKYNET_INTEGRATION_REPO || undefined`),
// not lazily per call — a single eager top-level `import { x } from
// "../apps/server/src/whatever.js"` anywhere in this file (even one that
// looks unrelated to git) would force config.ts to evaluate against
// whatever the env vars happened to be at FILE-LOAD time, before this
// suite's own beforeAll ever runs. Caught live: an earlier draft statically
// imported registerApi/registerOpenAiCompat/registerInteropRest at the top
// of the file (transitively pulling in operations.ts → config.ts too early)
// and every "real diff" test silently self-completed straight to "done"
// with no worktree, no branch, no HITL — the orchestrator was running
// against an unconfigured (undefined) integration repo the whole time.

const AUTH = { authorization: "Bearer dev-cyberdyne" }; // → DEFAULT_WORKSPACE, full authority

// Same deterministic-agent shape as full-loop.test.ts: writes one file into
// its own worktree then completes, so the run lands in "review" (a diff HITL
// is raised) rather than needing a real approval to reach a terminal status —
// exactly what waitForOutcome/isTerminal treat as done waiting.
class ScriptedProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    writeFileSync(join(spec.cwd!, "feature.txt"), "hello from the fleet\n");
    setTimeout(() => events.onCompleted(spec.runId, spec.branch), 0);
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

// A provider whose run never completes on its own — used for tests that only
// need the run to EXIST (list/get), not finish, so they aren't racing a
// background completion.
class StuckProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  async start(spec: StartSpec): Promise<RunnerHandle> {
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

let Hub: typeof import("../apps/server/src/hub.js").Hub;
let Orchestrator: typeof import("../apps/server/src/orchestrator.js").Orchestrator;
let Operations: typeof import("../apps/server/src/operations.js").Operations;
let MemoryStore: typeof import("../apps/server/src/store/memory.js").MemoryStore;
let InProcessBus: typeof import("../apps/server/src/bus.js").InProcessBus;
let configureAuth: typeof import("../apps/server/src/auth.js").configureAuth;
let MemoryServiceTokenStore: typeof import("../apps/server/src/auth/service-tokens.js").MemoryServiceTokenStore;
let registerApi: typeof import("../apps/server/src/api.js").registerApi;
let registerOpenAiCompat: typeof import("../apps/server/src/interop/openai.js").registerOpenAiCompat;
let registerInteropRest: typeof import("../apps/server/src/interop/rest.js").registerInteropRest;
let repo: string, worktreesDir: string;

const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const waitFor = async (pred: () => Promise<boolean>, ms = 15_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not met in time");
};

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "skynet-interop-repo-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "skynet-interop-wt-"));
  execFileSync("git", ["init", "-b", "main", repo]);
  git("config", "user.email", "test@skynet.local");
  git("config", "user.name", "Test");
  writeFileSync(join(repo, "README.md"), "# base\n");
  git("add", "-A");
  git("commit", "-m", "base");
  process.env.STORE = "memory";
  process.env.BUS = "memory";
  process.env.SKYNET_INTEGRATION_REPO = repo;
  process.env.SKYNET_WORKTREES_DIR = worktreesDir;
  process.env.SKYNET_BASE_BRANCH = "main";
  delete process.env.RUNNER;
  ({ Hub } = await import("../apps/server/src/hub.js"));
  ({ Orchestrator } = await import("../apps/server/src/orchestrator.js"));
  ({ Operations } = await import("../apps/server/src/operations.js"));
  ({ MemoryStore } = await import("../apps/server/src/store/memory.js"));
  ({ InProcessBus } = await import("../apps/server/src/bus.js"));
  ({ configureAuth } = await import("../apps/server/src/auth.js"));
  ({ MemoryServiceTokenStore } = await import("../apps/server/src/auth/service-tokens.js"));
  ({ registerApi } = await import("../apps/server/src/api.js"));
  ({ registerOpenAiCompat } = await import("../apps/server/src/interop/openai.js"));
  ({ registerInteropRest } = await import("../apps/server/src/interop/rest.js"));
});
afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(worktreesDir, { recursive: true, force: true });
});

/** One fresh store/app per test, real repo underneath. `provider` picks the
 *  scripted behavior (defaults to the completes-with-a-diff one). */
async function setup(provider: RunnerProvider = new ScriptedProvider()) {
  git("checkout", "-f", "main");
  git("branch", "--list", "agent/*")
    .split("\n")
    .filter(Boolean)
    .forEach((b) => {
      try {
        git("branch", "-D", b.replace("*", "").trim());
      } catch {
        /* ignore */
      }
    });

  const store = new MemoryStore({ seed: false });
  const bus = new InProcessBus();
  const hub = new Hub(store, bus);
  const orchestrator = new Orchestrator(store, hub, provider);
  const operations = new Operations({ store, hub, orchestrator });
  const serviceTokens = new MemoryServiceTokenStore();
  configureAuth({ serviceTokens }); // no sessions/elevations needed — dev token + service tokens only

  const app = Fastify();
  await registerApi(app, { operations, orchestrator }); // installs the req.principal auth hook
  await registerOpenAiCompat(app, { operations, bus });
  await registerInteropRest(app, { operations });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "Not found" }));
  await app.ready();

  const p1 = await operations.createProject(DEFAULT_WORKSPACE, { name: "Checkout revamp", goal: "ship it" });
  const p2 = await operations.createProject(DEFAULT_WORKSPACE, { name: "Search relevance", goal: "improve it" });
  await store.putAgent({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);

  return { app, store, hub, bus, operations, serviceTokens, p1, p2 };
}

/** Mints a real project-scoped service token and returns its Authorization header. */
async function scopedAuth(serviceTokens: InstanceType<typeof MemoryServiceTokenStore>, projectIds: string[]) {
  const token = await serviceTokens.create({ workspaceId: DEFAULT_WORKSPACE, operatorId: "mcp:scoped", scopes: ["observe", "author"], label: "scoped", projectIds });
  return { authorization: `Bearer ${token.token}` };
}

describe("GET /v1/models (OpenAI-compat)", () => {
  it("lists the workspace's projects as models", async () => {
    const { app, p1, p2 } = await setup();
    const res = await app.inject({ method: "GET", url: "/v1/models", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { object: string; data: Array<{ id: string; object: string; name: string }> };
    expect(body.object).toBe("list");
    const ids = body.data.map((m) => m.id);
    expect(ids).toContain(p1.id);
    expect(ids).toContain(p2.id);
    expect(body.data.find((m) => m.id === p1.id)).toMatchObject({ object: "model", name: "Checkout revamp" });
  });

  it("a project-scoped token only sees its own projects as models", async () => {
    const { app, serviceTokens, p1 } = await setup();
    const headers = await scopedAuth(serviceTokens, [p1.id]);
    const res = await app.inject({ method: "GET", url: "/v1/models", headers });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { data: Array<{ id: string }> }).data.map((m) => m.id);
    expect(ids).toEqual([p1.id]);
  });
});

describe("POST /v1/chat/completions (OpenAI-compat)", () => {
  it("an unknown model 404s with an OpenAI-shaped error", async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions", headers: AUTH,
      payload: { model: "nonexistent", messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { type: "invalid_request_error" } });
  });

  it("no user message 400s", async () => {
    const { app, p1 } = await setup();
    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions", headers: AUTH,
      payload: { model: p1.id, messages: [{ role: "system", content: "be nice" }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { type: "invalid_request_error" } });
  });

  it("creates a real task+run in the target project and returns its outcome once the run reaches review", async () => {
    const { app, store, p1 } = await setup();
    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions", headers: AUTH,
      payload: { model: p1.id, messages: [{ role: "user", content: "Add the feature file" }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      object: string; choices: Array<{ message: { role: string; content: string } }>;
      skynet: { runId: string; taskId: string; status: string };
    };
    expect(body.object).toBe("chat.completion");
    expect(body.skynet.status).toBe("review");
    expect(body.choices[0]!.message.content).toMatch(/ready for review/i);

    const run = await store.getRun(body.skynet.runId);
    expect(run?.projectId).toBe(p1.id);
    const task = (await store.listTasks(DEFAULT_WORKSPACE)).find((t) => t.id === body.skynet.taskId);
    expect(task?.projectId).toBe(p1.id);
  });

  it("folds prior conversation turns into the task's description as context, using the LAST user message as the task text", async () => {
    const { app, store, p1 } = await setup();
    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions", headers: AUTH,
      payload: {
        model: p1.id,
        messages: [
          { role: "user", content: "First ask: set up the scaffold" },
          { role: "assistant", content: "Done, scaffold is up" },
          { role: "user", content: "Add the feature file" },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const { skynet } = res.json() as { skynet: { taskId: string } };
    const task = (await store.listTasks(DEFAULT_WORKSPACE)).find((t) => t.id === skynet.taskId);
    expect(task?.text).toBe("Add the feature file");
    expect(task?.description).toContain("First ask: set up the scaffold");
    expect(task?.description).toContain("Done, scaffold is up");
  });

  it("streams the completion as SSE chunks, with the run/task handle riding the FIRST chunk", async () => {
    const { app, p1 } = await setup();
    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions", headers: AUTH,
      payload: { model: p1.id, messages: [{ role: "user", content: "Add the feature file" }], stream: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const events = res.body.split("\n\n").filter((s) => s.startsWith("data: ") && s !== "data: [DONE]").map((s) => JSON.parse(s.slice(6)));
    expect(res.body).toContain("data: [DONE]");
    expect(events[0]!.skynet).toMatchObject({ runId: expect.any(String), taskId: expect.any(String) });
    expect(events[0]!.choices[0].delta).toEqual({ role: "assistant" });
    const last = events[events.length - 1]!;
    expect(last.choices[0].finish_reason).toBe("stop");
    const contentChunk = events.find((e) => typeof e.choices[0].delta.content === "string");
    expect(contentChunk?.choices[0].delta.content).toMatch(/ready for review/i);
  });

  it("a project-scoped token can't target a project outside its scope — reads as an unknown model, not a leak", async () => {
    const { app, serviceTokens, p1, p2 } = await setup();
    const headers = await scopedAuth(serviceTokens, [p1.id]);
    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions", headers,
      payload: { model: p2.id, messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { message: string } }).error.message).toMatch(/unknown model/i);
  });

  it("matching by project NAME (case-insensitively) works when the caller doesn't know the id", async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions", headers: AUTH,
      payload: { model: "checkout revamp", messages: [{ role: "user", content: "Add the feature file" }] },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("GET /v1/projects (interop REST)", () => {
  it("lists the workspace's projects", async () => {
    const { app, p1, p2 } = await setup();
    const res = await app.inject({ method: "GET", url: "/v1/projects", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { data: Array<{ id: string }> }).data.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining([p1.id, p2.id]));
  });

  it("a project-scoped token only sees its own projects", async () => {
    const { app, serviceTokens, p1 } = await setup();
    const headers = await scopedAuth(serviceTokens, [p1.id]);
    const res = await app.inject({ method: "GET", url: "/v1/projects", headers });
    expect((res.json() as { data: Array<{ id: string }> }).data.map((p) => p.id)).toEqual([p1.id]);
  });
});

describe("GET /v1/runs + POST /v1/runs (interop REST)", () => {
  it("POST creates a real task+run and returns 201 with a run summary", async () => {
    const { app, store, p1 } = await setup(new StuckProvider());
    const res = await app.inject({ method: "POST", url: "/v1/runs", headers: AUTH, payload: { projectId: p1.id, text: "Do the thing" } });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { taskId: string; run: { id: string; projectId: string; status: string } };
    expect(body.run.projectId).toBe(p1.id);
    expect(body.run.status).toBe("running");
    expect(await store.getRun(body.run.id)).toBeTruthy();
  });

  it("POST refuses a project-scoped token targeting an out-of-scope project", async () => {
    const { app, serviceTokens, p1, p2 } = await setup(new StuckProvider());
    const headers = await scopedAuth(serviceTokens, [p1.id]);
    const res = await app.inject({ method: "POST", url: "/v1/runs", headers, payload: { projectId: p2.id, text: "Do the thing" } });
    expect(res.statusCode).toBe(403);
  });

  it("POST 400s on a missing/empty body field", async () => {
    const { app, p1 } = await setup(new StuckProvider());
    const res = await app.inject({ method: "POST", url: "/v1/runs", headers: AUTH, payload: { projectId: p1.id, text: "" } });
    expect(res.statusCode).toBe(400);
  });

  it("GET lists runs, filterable by projectId and status, paginated and sorted newest-heartbeat-first", async () => {
    const { app, store, p1, p2 } = await setup(new StuckProvider());
    // setup()'s own single fleet agent ("r1") can only hold ONE run at a
    // time — a second concurrent run needs a second idle agent, or the
    // second POST correctly 409s (NoCapacityError) and never creates a run.
    await store.putAgent({ id: "r2", workspaceId: DEFAULT_WORKSPACE, name: "r2", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);

    const postA = await app.inject({ method: "POST", url: "/v1/runs", headers: AUTH, payload: { projectId: p1.id, text: "task A" } });
    const postB = await app.inject({ method: "POST", url: "/v1/runs", headers: AUTH, payload: { projectId: p2.id, text: "task B" } });
    expect(postA.statusCode).toBe(201);
    expect(postB.statusCode).toBe(201);

    const all = await app.inject({ method: "GET", url: "/v1/runs", headers: AUTH });
    expect(all.statusCode).toBe(200);
    const allBody = all.json() as { data: Array<{ projectId: string }>; total: number };
    expect(allBody.total).toBe(2);

    const p1Only = await app.inject({ method: "GET", url: `/v1/runs?projectId=${p1.id}`, headers: AUTH });
    const p1Body = p1Only.json() as { data: Array<{ projectId: string }>; total: number };
    expect(p1Body.total).toBe(1);
    expect(p1Body.data[0]!.projectId).toBe(p1.id);

    const statusFiltered = await app.inject({ method: "GET", url: "/v1/runs?status=running", headers: AUTH });
    expect((statusFiltered.json() as { total: number }).total).toBe(2);

    const paged = await app.inject({ method: "GET", url: "/v1/runs?limit=1&offset=0", headers: AUTH });
    const pagedBody = paged.json() as { data: unknown[]; limit: number; offset: number; total: number };
    expect(pagedBody.data).toHaveLength(1);
    expect(pagedBody.limit).toBe(1);
    expect(pagedBody.total).toBe(2);
  });

  it("GET only returns a project-scoped token's own runs", async () => {
    const { app, serviceTokens, p1, p2 } = await setup(new StuckProvider());
    await app.inject({ method: "POST", url: "/v1/runs", headers: AUTH, payload: { projectId: p1.id, text: "task A" } });
    await app.inject({ method: "POST", url: "/v1/runs", headers: AUTH, payload: { projectId: p2.id, text: "task B" } });

    const headers = await scopedAuth(serviceTokens, [p1.id]);
    const res = await app.inject({ method: "GET", url: "/v1/runs", headers });
    const body = res.json() as { data: Array<{ projectId: string }>; total: number };
    expect(body.total).toBe(1);
    expect(body.data[0]!.projectId).toBe(p1.id);
  });
});

describe("GET /v1/runs/:id (interop REST)", () => {
  it("returns a run summary, and includes a diff only when ?diff=true", async () => {
    const { app, p1 } = await setup();
    const created = await app.inject({ method: "POST", url: "/v1/runs", headers: AUTH, payload: { projectId: p1.id, text: "Add the feature file" } });
    const { run } = created.json() as { run: { id: string } };
    await waitFor(async () => (await app.inject({ method: "GET", url: `/v1/runs/${run.id}`, headers: AUTH })).json().status === "review");

    const plain = await app.inject({ method: "GET", url: `/v1/runs/${run.id}`, headers: AUTH });
    expect(plain.statusCode).toBe(200);
    expect(plain.json()).not.toHaveProperty("diff");

    const withDiff = await app.inject({ method: "GET", url: `/v1/runs/${run.id}?diff=true`, headers: AUTH });
    const body = withDiff.json() as { diff: { files: string[]; add: number; del: number } | null };
    expect(body.diff?.files).toContain("feature.txt");
    expect(body.diff?.add).toBeGreaterThan(0);
  });

  it("an unknown run id 404s", async () => {
    const { app } = await setup();
    const res = await app.inject({ method: "GET", url: "/v1/runs/nope", headers: AUTH });
    expect(res.statusCode).toBe(404);
  });

  it("a project-scoped token can't fetch a run outside its scope — 404, not a leak", async () => {
    const { app, serviceTokens, p1, p2 } = await setup(new StuckProvider());
    const created = await app.inject({ method: "POST", url: "/v1/runs", headers: AUTH, payload: { projectId: p2.id, text: "task B" } });
    const { run } = created.json() as { run: { id: string } };

    const headers = await scopedAuth(serviceTokens, [p1.id]);
    const res = await app.inject({ method: "GET", url: `/v1/runs/${run.id}`, headers });
    expect(res.statusCode).toBe(404);
  });
});
