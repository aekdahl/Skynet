// Read-only (viewer) role — HTTP-level proof that the mutation gate actually
// runs where it matters: the real Fastify app, at the real routes the web
// client posts to. requiredScope() (auth-guard.ts) is unit-tested on its own
// (auth-hardening.test.ts); this drives it end-to-end through the onRequest
// hook (api.ts) against a principal carrying only the "observe" scope — the
// same shape a viewer login (auth/operators.ts) or a scoped service token
// resolves to (auth.ts's hasScope treats them identically; there's no
// viewer-specific code path to fall out of sync).
//
// Table-driven rather than one test per route: the interesting fact is "every
// mutation route in the table is denied," not each route's individual wiring
// (that's covered elsewhere, e.g. api-run-lifecycle-routes.test.ts).
import { describe, it, expect, beforeAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { registerApi } from "../apps/server/src/api.js";
import { registerSecretsRoutes } from "../apps/server/src/secrets/routes.js";
import { registerGithubRoutes } from "../apps/server/src/github/routes.js";
import { registerEvalsRoutes } from "../apps/server/src/evals/index.js";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { Operations } from "../apps/server/src/operations.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { ProviderId } from "@skynet/shared";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";
import { configureAuth } from "../apps/server/src/auth.js";
import { MemoryServiceTokenStore } from "../apps/server/src/auth/service-tokens.js";

class NullBus implements Bus {
  publish(): void {}
  subscribe(): () => void {
    return () => {};
  }
}
class NullProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  async start(spec: StartSpec, _events: RunnerEvents): Promise<RunnerHandle> {
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

// Every route below requires an id/param — the scope check runs in the
// onRequest hook BEFORE the handler (and before any params/body validation),
// so a fake id is enough: the request never gets far enough to need a real one.
const MUTATION_ROUTES: Array<{ method: "POST" | "PATCH" | "PUT" | "DELETE"; path: string; note: string }> = [
  { method: "POST", path: "/api/projects", note: "create project" },
  { method: "PATCH", path: "/api/projects/p-1", note: "update project" },
  { method: "DELETE", path: "/api/projects/p-1", note: "delete project" },
  { method: "POST", path: "/api/projects/p-1/tasks", note: "create task" },
  { method: "POST", path: "/api/projects/p-1/tasks/t-1/assign", note: "assign task" },
  { method: "POST", path: "/api/projects/p-1/tasks/t-1/state", note: "transition task" },
  { method: "POST", path: "/api/runs/r-1/pause", note: "pause agent" },
  { method: "POST", path: "/api/runs/r-1/stop", note: "stop agent" },
  { method: "POST", path: "/api/runs/r-1/fork", note: "fork agent" },
  { method: "POST", path: "/api/hitl/h-1/resolve", note: "resolve HITL (approver)" },
  { method: "POST", path: "/api/merges/r-1/merge", note: "merge ready PR (approver)" },
  { method: "POST", path: "/api/merges/r-1/dismiss", note: "dismiss ready PR (approver)" },
  { method: "POST", path: "/api/fleet/runners", note: "configure runner" },
  { method: "DELETE", path: "/api/fleet/runners/f-1", note: "retire runner" },
  { method: "PATCH", path: "/api/settings/fleet", note: "update fleet settings" },
  { method: "POST", path: "/api/credentials", note: "create provider credential" },
  { method: "PUT", path: "/api/secrets/anthropic", note: "set/rotate a provider key" },
  { method: "DELETE", path: "/api/secrets/anthropic", note: "remove a provider key" },
  { method: "PUT", path: "/api/github/pat", note: "connect GitHub via PAT" },
  { method: "DELETE", path: "/api/github", note: "disconnect GitHub" },
  { method: "POST", path: "/api/evals/some-scenario/run", note: "run an eval scenario" },
];

const READ_ROUTES: Array<{ path: string }> = [
  { path: "/api/snapshot" },
  { path: "/api/projects" },
  { path: "/api/audit" },
  { path: "/api/secrets" },
];

describe("viewer role: an observe-only principal is denied every mutation route, reads still work", () => {
  let app: FastifyInstance;
  let viewerToken: string;
  let approverToken: string;
  let fullAuthorityHeader: { authorization: string };

  beforeAll(async () => {
    const store = new MemoryStore({ seed: false });
    const hub = new Hub(store, new NullBus());
    const orchestrator = new Orchestrator(store, hub, new NullProvider());
    const operations = new Operations({ store, hub, orchestrator });

    // One shared store for the whole file — configureAuth() is a module-level
    // singleton (auth.ts), so reconfiguring it mid-file would silently orphan
    // tokens minted before the swap.
    const serviceTokens = new MemoryServiceTokenStore();
    configureAuth({ serviceTokens });
    viewerToken = (
      await serviceTokens.create({
        workspaceId: DEFAULT_WORKSPACE,
        operatorId: "viewer-token",
        scopes: ["observe"],
        label: "viewer-role-test",
      })
    ).token;
    approverToken = (
      await serviceTokens.create({
        workspaceId: DEFAULT_WORKSPACE,
        operatorId: "approver-token",
        scopes: ["observe", "approver"],
        label: "approver-role-test",
      })
    ).token;
    fullAuthorityHeader = { authorization: "Bearer dev-cyberdyne" }; // dev token: scopes undefined

    app = Fastify();
    await registerApi(app, { operations, orchestrator });
    await registerSecretsRoutes(app, operations);
    await registerGithubRoutes(app);
    await registerEvalsRoutes(app);
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "Not found" }));
    await app.ready();
  });

  for (const { method, path, note } of MUTATION_ROUTES) {
    it(`403s ${method} ${path} (${note})`, async () => {
      const res = await app.inject({
        method,
        url: path,
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: method === "DELETE" ? undefined : {},
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: expect.stringContaining("scope") });
    });
  }

  for (const { path } of READ_ROUTES) {
    it(`allows GET ${path} for an observe-only principal`, async () => {
      const res = await app.inject({ method: "GET", url: path, headers: { authorization: `Bearer ${viewerToken}` } });
      expect(res.statusCode).toBe(200);
    });
  }

  // Sanity: the new hook must not have accidentally narrowed a full-authority
  // principal — it should still reach the route handler (a 400/404 from the
  // handler itself is fine here; only a 403 from the SCOPE gate would mean the
  // hook over-applied).
  it("does not block a full-authority (unscoped) principal at the scope gate", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/settings/fleet",
      headers: fullAuthorityHeader,
      payload: {},
    });
    expect(res.statusCode).not.toBe(403);
  });

  it("a scoped-but-approver-capable token IS allowed to resolve HITL (author alone would not be)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/hitl/h-1/resolve",
      headers: { authorization: `Bearer ${approverToken}` },
      payload: { action: "approve" },
    });
    // Not 403 — it may still 400/404 downstream (unknown hitlId), but the
    // scope gate itself must let it through.
    expect(res.statusCode).not.toBe(403);
  });
});
