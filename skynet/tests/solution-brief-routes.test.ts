// SolutionBrief HTTP routes (S4): list/create/get/update/delete under
// /api/projects/:id/briefs, exercised at the real Fastify app so the
// project-mismatch 404 guard and — the highest-stakes rule — the approval
// scope gate are proven end to end, not just unit-tested in isolation. See
// solution-brief.test.ts for the Operations-layer CRUD/stamping coverage this
// file deliberately doesn't repeat.
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

describe("SolutionBrief HTTP routes", () => {
  let app: FastifyInstance;
  let ops: Operations;
  let authorToken: string; // scoped: can create/edit briefs but not approve them
  const fullAuthority = { authorization: "Bearer dev-cyberdyne" }; // dev token: scopes undefined

  let projectId: string;

  beforeAll(async () => {
    const store = new MemoryStore();
    const hub = new Hub(store, new NullBus());
    const orchestrator = new Orchestrator(store, hub, new NullProvider());
    ops = new Operations({ store, hub, orchestrator });

    const serviceTokens = new MemoryServiceTokenStore();
    configureAuth({ serviceTokens });
    authorToken = (
      await serviceTokens.create({
        workspaceId: DEFAULT_WORKSPACE,
        operatorId: "agent-token",
        scopes: ["observe", "author"],
        label: "solution-brief-route-test",
      })
    ).token;

    app = Fastify();
    await registerApi(app, { operations: ops, orchestrator });
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "Not found" }));
    await app.ready();

    const project = await ops.createProject(DEFAULT_WORKSPACE, { name: "P", goal: "ship" });
    projectId = project.id;
  });

  it("creates, lists, gets, and deletes a brief", async () => {
    const create = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/briefs`,
      headers: fullAuthority,
      payload: { title: "Reconcile webhooks", problem: "double-posts" },
    });
    expect(create.statusCode).toBe(200);
    const brief = create.json();
    expect(brief.title).toBe("Reconcile webhooks");
    expect(brief.status).toBe("draft");

    const list = await app.inject({ method: "GET", url: `/api/projects/${projectId}/briefs`, headers: fullAuthority });
    expect(list.statusCode).toBe(200);
    expect(list.json().map((b: { id: string }) => b.id)).toContain(brief.id);

    const get = await app.inject({ method: "GET", url: `/api/projects/${projectId}/briefs/${brief.id}`, headers: fullAuthority });
    expect(get.statusCode).toBe(200);
    expect(get.json().id).toBe(brief.id);

    const del = await app.inject({ method: "DELETE", url: `/api/projects/${projectId}/briefs/${brief.id}`, headers: fullAuthority });
    expect(del.statusCode).toBe(200);
    const gone = await app.inject({ method: "GET", url: `/api/projects/${projectId}/briefs/${brief.id}`, headers: fullAuthority });
    expect(gone.statusCode).toBe(404);
  });

  it("404s a brief fetched through the WRONG project's URL (nested :id/:bid mismatch)", async () => {
    const otherProject = await ops.createProject(DEFAULT_WORKSPACE, { name: "Other", goal: "" });
    const brief = await ops.createBrief(DEFAULT_WORKSPACE, projectId, { title: "In P" });

    const mismatched = await app.inject({
      method: "GET",
      url: `/api/projects/${otherProject.id}/briefs/${brief.id}`,
      headers: fullAuthority,
    });
    expect(mismatched.statusCode).toBe(404);

    const patchMismatch = await app.inject({
      method: "PATCH",
      url: `/api/projects/${otherProject.id}/briefs/${brief.id}`,
      headers: fullAuthority,
      payload: { title: "sneaky" },
    });
    expect(patchMismatch.statusCode).toBe(404);
    expect((await ops.getBrief(DEFAULT_WORKSPACE, brief.id)).title).toBe("In P"); // untouched
  });

  it("PATCHes non-approval fields with an agent-scoped (author) token — plain edits ARE allowed", async () => {
    const brief = await ops.createBrief(DEFAULT_WORKSPACE, projectId, { title: "Editable" });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}/briefs/${brief.id}`,
      headers: { authorization: `Bearer ${authorToken}` },
      payload: { title: "Renamed by agent", status: "building" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ title: "Renamed by agent", status: "building" });
  });

  // ── the approval-stamp rule: human/API only, never agent-scoped ─────────
  describe("approving a brief (status: 'approved')", () => {
    it("403s an agent-scoped (author) token trying to approve", async () => {
      const brief = await ops.createBrief(DEFAULT_WORKSPACE, projectId, { title: "Needs approval" });
      const res = await app.inject({
        method: "PATCH",
        url: `/api/projects/${projectId}/briefs/${brief.id}`,
        headers: { authorization: `Bearer ${authorToken}` },
        payload: { status: "approved" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: expect.stringContaining("agent-scoped") });
      // Untouched — the rejected request never reached Operations.
      expect((await ops.getBrief(DEFAULT_WORKSPACE, brief.id)).status).toBe("draft");
    });

    it("allows a full-authority (human/unscoped) token to approve, and stamps approvedAt/approvedBy server-side", async () => {
      const brief = await ops.createBrief(DEFAULT_WORKSPACE, projectId, { title: "Approve me" });
      const before = Date.now();
      const res = await app.inject({
        method: "PATCH",
        url: `/api/projects/${projectId}/briefs/${brief.id}`,
        headers: fullAuthority,
        payload: { status: "approved" },
      });
      expect(res.statusCode).toBe(200);
      const approved = res.json();
      expect(approved.status).toBe("approved");
      expect(approved.approvedBy).toBe("jordan"); // dev-cyberdyne's operatorId
      expect(approved.approvedAt).toBeGreaterThanOrEqual(before);
    });

    it("ignores a client-supplied approvedAt/approvedBy stamp — the server's own value wins", async () => {
      const brief = await ops.createBrief(DEFAULT_WORKSPACE, projectId, { title: "Spoof attempt" });
      const res = await app.inject({
        method: "PATCH",
        url: `/api/projects/${projectId}/briefs/${brief.id}`,
        headers: fullAuthority,
        payload: { status: "approved", approvedAt: 1, approvedBy: "not-jordan" },
      });
      expect(res.statusCode).toBe(200);
      const approved = res.json();
      expect(approved.approvedBy).toBe("jordan"); // not "not-jordan" — the spoofed value was dropped
      expect(approved.approvedAt).not.toBe(1);
    });
  });
});
