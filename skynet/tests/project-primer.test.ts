// S2: Project.primer — an editable "what we're building & how" doc that
// rides every agent prompt via S1's buildAgentContext (`=== PRIMER ===`), plus
// a one-click auto-draft endpoint. This file pins:
//   1. Operations normalizes create/update the same way instructions does
//      (blank/whitespace-only clears back to null).
//   2. The orchestrator wiring: assignTask/forkAgent's StartSpec.task actually
//      carries Project.primer (extends tests/project-instructions.test.ts's
//      goal/feature wiring tests with the same shape, for the same reason —
//      buildAgentContext is correct in isolation, but nothing else proved
//      every real call site actually passes `primer` through).
//   3. Operations.draftProjectPrimer — never persists the draft, 404s on an
//      unknown project, and surfaces the underlying primer-draft.js failure
//      as-is. The actual repo-digest + consult logic is unit-tested in
//      tests/primer-draft.test.ts; here `draftPrimer` is mocked (same
//      approach tests/task-linter-ops.test.ts uses for `lintTask`).
//   4. The HTTP route (POST /api/projects/:id/primer/draft) actually reaches
//      Operations.draftProjectPrimer (mirrors tests/api-run-lifecycle-routes.test.ts).
import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { Agent, Project, ProviderId, ServerEvent } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { registerApi } from "../apps/server/src/api.js";
import { Hub } from "../apps/server/src/hub.js";
import { Operations } from "../apps/server/src/operations.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

const draftPrimer = vi.fn<(ws: string, project: Project) => Promise<string>>();
vi.mock("../apps/server/src/primer-draft.js", () => ({
  draftPrimer: (ws: string, project: Project) => draftPrimer(ws, project),
}));

class NullBus implements Bus {
  publish(_ws: string, _e: ServerEvent): void {}
  subscribe(): () => void {
    return () => {};
  }
}

class RunningProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  async start(spec: StartSpec, _events: RunnerEvents): Promise<RunnerHandle> {
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

function setup() {
  const store = new MemoryStore();
  const hub = new Hub(store, new NullBus());
  const ops = new Operations({ store, hub, orchestrator: new Orchestrator(store, hub, new RunningProvider()) });
  return { store, ops };
}

// ── 1) Operations — primer create + update normalization ────────────────

describe("Operations — primer create + update normalization", () => {
  it("createProject defaults primer to null (never set at creation)", async () => {
    const { ops } = setup();
    const p = await ops.createProject(DEFAULT_WORKSPACE, { name: "Acme", goal: "" });
    expect(p.primer).toBeNull();
  });

  it("updateProject sets the primer and trims it", async () => {
    const { ops } = setup();
    const p = await ops.createProject(DEFAULT_WORKSPACE, { name: "Acme", goal: "" });
    const set = await ops.updateProject(DEFAULT_WORKSPACE, p.id, { primer: "\n  ## Stack\nTypeScript.\n  " });
    expect(set.primer).toBe("## Stack\nTypeScript.");
  });

  it("updateProject clears the primer with an empty string or null", async () => {
    const { ops } = setup();
    const p = await ops.createProject(DEFAULT_WORKSPACE, { name: "Acme", goal: "" });
    await ops.updateProject(DEFAULT_WORKSPACE, p.id, { primer: "## Stack" });
    const clearedNull = await ops.updateProject(DEFAULT_WORKSPACE, p.id, { primer: null });
    expect(clearedNull.primer).toBeNull();
    await ops.updateProject(DEFAULT_WORKSPACE, p.id, { primer: "## Stack" });
    const clearedBlank = await ops.updateProject(DEFAULT_WORKSPACE, p.id, { primer: "   \n\t " });
    expect(clearedBlank.primer).toBeNull();
  });

  it("updateProject leaves the primer alone when the field is undefined in the patch", async () => {
    const { ops } = setup();
    const p = await ops.createProject(DEFAULT_WORKSPACE, { name: "Acme", goal: "" });
    await ops.updateProject(DEFAULT_WORKSPACE, p.id, { primer: "## Stack" });
    const after = await ops.updateProject(DEFAULT_WORKSPACE, p.id, { autonomy: false });
    expect(after.primer).toBe("## Stack");
    expect(after.autonomy).toBe(false);
  });
});

// ── 2) Orchestrator — StartSpec.task actually carries Project.primer ────

class RecordingProvider2 implements RunnerProvider {
  readonly id: ProviderId = "claude";
  specs: StartSpec[] = [];
  async start(spec: StartSpec, _events: RunnerEvents): Promise<RunnerHandle> {
    this.specs.push(spec);
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

async function setupRecording() {
  const store = new MemoryStore();
  const hub = new Hub(store, new NullBus());
  const provider = new RecordingProvider2();
  const orchestrator = new Orchestrator(store, hub, provider);
  const ops = new Operations({ store, hub, orchestrator });
  const runner: Agent = {
    id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1",
    provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0,
  } as Agent;
  await store.putAgent(runner);
  return { ops, provider };
}

describe("Orchestrator — StartSpec.task carries Project.primer", () => {
  it("assignTask: the primer appears under its own === PRIMER === section", async () => {
    const { ops, provider } = await setupRecording();
    const p = await ops.createProject(DEFAULT_WORKSPACE, { name: "Acme", goal: "" });
    await ops.updateProject(DEFAULT_WORKSPACE, p.id, { primer: "## Stack\nTypeScript monorepo, pnpm workspaces." });
    const t = await ops.createTask(DEFAULT_WORKSPACE, p.id, { text: "Add a health check endpoint" });
    await ops.assignTask(DEFAULT_WORKSPACE, p.id, t.id);

    const { task } = provider.specs[0]!;
    expect(task).toContain("=== PRIMER ===");
    expect(task).toContain("TypeScript monorepo, pnpm workspaces.");
  });

  it("assignTask: no primer set emits no === PRIMER === section", async () => {
    const { ops, provider } = await setupRecording();
    const p = await ops.createProject(DEFAULT_WORKSPACE, { name: "Acme", goal: "" });
    const t = await ops.createTask(DEFAULT_WORKSPACE, p.id, { text: "Add a health check endpoint" });
    await ops.assignTask(DEFAULT_WORKSPACE, p.id, t.id);

    const { task } = provider.specs[0]!;
    expect(task).not.toContain("=== PRIMER ===");
  });

  it("forkAgent: the fork's brief ALSO carries the project's primer", async () => {
    const { ops, provider } = await setupRecording();
    const p = await ops.createProject(DEFAULT_WORKSPACE, { name: "Acme", goal: "" });
    await ops.updateProject(DEFAULT_WORKSPACE, p.id, { primer: "## Layout\napps/server, apps/web." });
    const t = await ops.createTask(DEFAULT_WORKSPACE, p.id, { text: "Add a health check endpoint" });
    const run = await ops.assignTask(DEFAULT_WORKSPACE, p.id, t.id);
    provider.specs.length = 0;

    await ops.forkAgent(DEFAULT_WORKSPACE, run.id);

    const { task } = provider.specs[0]!;
    expect(task).toContain("=== PRIMER ===");
    expect(task).toContain("apps/server, apps/web.");
  });
});

// ── 3) Operations.draftProjectPrimer — never persists, surfaces failures ──

describe("Operations — draftProjectPrimer", () => {
  beforeEach(() => draftPrimer.mockReset());

  it("returns the drafted text without saving it onto the project", async () => {
    const { store, ops } = setup();
    const p = await ops.createProject(DEFAULT_WORKSPACE, { name: "Acme", goal: "" });
    draftPrimer.mockResolvedValue("## Stack\nDrafted from the repo.");

    const result = await ops.draftProjectPrimer(DEFAULT_WORKSPACE, p.id);
    expect(result.draft).toBe("## Stack\nDrafted from the repo.");

    const stored = await store.getProject(p.id);
    expect(stored?.primer).toBeNull(); // the draft was never auto-saved
  });

  it("404s for an unknown project", async () => {
    const { ops } = setup();
    await expect(ops.draftProjectPrimer(DEFAULT_WORKSPACE, "nope")).rejects.toThrow();
  });

  // The underlying primer-draft.js failure path (no bound repo, unreadable
  // repo, empty consult reply) is unit-tested directly, unmocked, in
  // tests/primer-draft.test.ts; the HTTP route test below re-proves that a
  // rejection here surfaces as a clear 400, end to end.
});

// ── 4) HTTP route: POST /api/projects/:id/primer/draft ──────────────────

const AUTH = { authorization: "Bearer dev-cyberdyne" }; // → DEFAULT_WORKSPACE

describe("HTTP route: project primer draft", () => {
  let app: FastifyInstance;
  let ops: Operations;

  beforeEach(async () => {
    draftPrimer.mockReset();
    const store = new MemoryStore({ seed: false });
    const hub = new Hub(store, new NullBus());
    const orchestrator = new Orchestrator(store, hub, new RunningProvider());
    ops = new Operations({ store, hub, orchestrator });
    app = Fastify();
    await registerApi(app, { operations: ops, orchestrator });
  });

  it("POST /api/projects/:id/primer/draft returns the drafted text", async () => {
    const p = await ops.createProject(DEFAULT_WORKSPACE, { name: "Acme", goal: "" });
    draftPrimer.mockResolvedValue("## Stack\nDrafted via HTTP.");

    const res = await app.inject({ method: "POST", url: `/api/projects/${p.id}/primer/draft`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ draft: "## Stack\nDrafted via HTTP." });
  });

  it("surfaces a draft failure as a 400 with the clear error message", async () => {
    const p = await ops.createProject(DEFAULT_WORKSPACE, { name: "Acme", goal: "" });
    draftPrimer.mockImplementation(() => { throw new Error("This project has no bound repository to draft a primer from — connect a local folder or GitHub repo first."); });

    const res = await app.inject({ method: "POST", url: `/api/projects/${p.id}/primer/draft`, headers: AUTH });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/no bound repository/);
  });

  it("404s for an unknown project id", async () => {
    const res = await app.inject({ method: "POST", url: `/api/projects/does-not-exist/primer/draft`, headers: AUTH });
    expect(res.statusCode).toBe(404);
  });
});
