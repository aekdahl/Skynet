// Crystallize HTTP route (S5): POST /api/projects/:id/briefs/crystallize at
// the real Fastify app. Operations.crystallizeAsk is injected so this proves
// the route wiring (body validation, status mapping) without a real LLM call.
// See crystallize-brief.test.ts for the retry contract + Operations coverage.
import { describe, it, expect, beforeAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { registerApi } from "../apps/server/src/api.js";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { Operations } from "../apps/server/src/operations.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { ProviderId } from "@skynet/shared";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

class NullBus implements Bus {
  publish(): void {}
  subscribe(): () => void { return () => {}; }
}
class NullProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  async start(spec: StartSpec, _events: RunnerEvents): Promise<RunnerHandle> {
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

const VALID_REPLY = JSON.stringify({
  title: "Reconcile Stripe webhooks",
  problem: "Retries can double-post a charge.",
  approach: "Idempotency key on the ledger insert.",
});
const HISTORY = [
  { role: "user", content: "webhooks are double-posting on retry" },
  { role: "assistant", content: "we could use an idempotency key" },
];

function buildApp(ask: (prompt: string) => Promise<string>) {
  const store = new MemoryStore();
  const hub = new Hub(store, new NullBus());
  const orchestrator = new Orchestrator(store, hub, new NullProvider());
  const ops = new Operations({ store, hub, orchestrator, crystallizeAsk: ask });
  return { ops, store, orchestrator };
}

describe("POST /api/projects/:id/briefs/crystallize", () => {
  let app: FastifyInstance;
  let ops: Operations;
  const fullAuthority = { authorization: "Bearer dev-cyberdyne" };
  let projectId: string;

  beforeAll(async () => {
    const built = buildApp(async () => VALID_REPLY);
    ops = built.ops;
    app = Fastify();
    await registerApi(app, { operations: built.ops, orchestrator: built.orchestrator });
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "Not found" }));
    await app.ready();
    const project = await ops.createProject(DEFAULT_WORKSPACE, { name: "Billing", goal: "ship" });
    projectId = project.id;
  });

  it("crystallizes a real draft brief from a valid stubbed reply", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/briefs/crystallize`,
      headers: fullAuthority,
      payload: { history: HISTORY },
    });
    expect(res.statusCode).toBe(200);
    const brief = res.json();
    expect(brief.title).toBe("Reconcile Stripe webhooks");
    expect(brief.status).toBe("draft");
    expect(brief.projectId).toBe(projectId);

    const listed = await app.inject({ method: "GET", url: `/api/projects/${projectId}/briefs`, headers: fullAuthority });
    expect(listed.json().map((b: { id: string }) => b.id)).toContain(brief.id);
  });

  it("400s with no history", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/briefs/crystallize`,
      headers: fullAuthority,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: expect.stringContaining("history") });
  });

  it("400s with an empty history array", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/briefs/crystallize`,
      headers: fullAuthority,
      payload: { history: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("404s a nonexistent project", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/no-such-project/briefs/crystallize`,
      headers: fullAuthority,
      payload: { history: HISTORY },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST .../crystallize — invalid model output never creates a brief", () => {
  it("422s after the retry, and no brief lands", async () => {
    const { ops, store, orchestrator } = buildApp(async () => "not json, not ever");
    const app = Fastify();
    await registerApi(app, { operations: ops, orchestrator });
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "Not found" }));
    await app.ready();
    const project = await ops.createProject(DEFAULT_WORKSPACE, { name: "Billing", goal: "ship" });

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/briefs/crystallize`,
      headers: { authorization: "Bearer dev-cyberdyne" },
      payload: { history: HISTORY },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: expect.stringContaining("Could not draft") });
    expect(await store.listSolutionBriefs(DEFAULT_WORKSPACE)).toEqual([]);
  });
});
