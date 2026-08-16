// Time-limited admin promotion (ROADMAP.md) — self-service, sudo-style: a
// viewer re-verifies their OWN password (POST /api/auth/elevate) for a
// bounded full-authority window on their CURRENT session, which auto-reverts
// on its own once the window lapses (no logout/re-login). Depends on the
// read-only viewer role (a prior ROADMAP item): elevating only matters for a
// session that started out SCOPED.
//
// Two layers: MemorySessionStore's resolve()/elevate() interplay in isolation
// (no HTTP), then the real route end-to-end via app.inject (mirrors
// tests/viewer-role-routes.test.ts's pattern).
import { describe, it, expect, beforeAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { hasScope } from "../apps/server/src/auth.js";
import { MemorySessionStore } from "../apps/server/src/auth/sessions.js";
import { MemoryOperatorDirectory, makeOperator } from "../apps/server/src/auth/operators.js";
import { MemoryElevationLog } from "../apps/server/src/auth/elevation-log.js";
import { registerAuthRoutes } from "../apps/server/src/auth/routes.js";
import { registerApi } from "../apps/server/src/api.js";
import { configureAuth } from "../apps/server/src/auth.js";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { Operations } from "../apps/server/src/operations.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { ProviderId } from "@skynet/shared";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";
import { config } from "../apps/server/src/config.js";

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

describe("MemorySessionStore: elevate()/resolve() interplay", () => {
  it("a viewer session resolves scoped, then full-authority once elevated, then reverts on its own after the window lapses", async () => {
    const sessions = new MemorySessionStore();
    const session = await sessions.create({ workspaceId: DEFAULT_WORKSPACE, operatorId: "v", scopes: ["observe"] }, 60_000);

    const before = await sessions.resolve(session.token);
    expect(before?.scopes).toEqual(["observe"]);
    expect(hasScope(before!, "author")).toBe(false);

    const result = await sessions.elevate(session.token, 10_000);
    expect(result?.expiresAt).toBeGreaterThan(Date.now());

    const during = await sessions.resolve(session.token);
    expect(during?.scopes).toBeUndefined(); // full authority
    expect(during?.elevatedUntil).toBe(result!.expiresAt);
    expect(hasScope(during!, "author")).toBe(true);
    expect(hasScope(during!, "admin")).toBe(true);

    // Base identity is preserved throughout — elevation only widens scope.
    expect(during?.workspaceId).toBe(DEFAULT_WORKSPACE);
    expect(during?.operatorId).toBe("v");
  });

  it("an already-lapsed window (negative ttl) reverts immediately — no separate sweep/cleanup needed", async () => {
    const sessions = new MemorySessionStore();
    const session = await sessions.create({ workspaceId: DEFAULT_WORKSPACE, operatorId: "v", scopes: ["observe"] }, 60_000);
    await sessions.elevate(session.token, -1); // already in the past

    const after = await sessions.resolve(session.token);
    expect(after?.scopes).toEqual(["observe"]); // reverted to base — no logout involved
    expect(after?.elevatedUntil).toBeUndefined();
  });

  it("a full-authority (admin) session can also elevate — harmless no-op, still full authority", async () => {
    const sessions = new MemorySessionStore();
    const session = await sessions.create({ workspaceId: DEFAULT_WORKSPACE, operatorId: "a" }, 60_000);
    await sessions.elevate(session.token, 10_000);
    const resolved = await sessions.resolve(session.token);
    expect(resolved?.scopes).toBeUndefined();
  });

  it("elevate() on a missing or already-expired session returns undefined", async () => {
    const sessions = new MemorySessionStore();
    expect(await sessions.elevate("no-such-token", 10_000)).toBeUndefined();

    const expired = await sessions.create({ workspaceId: DEFAULT_WORKSPACE, operatorId: "v", scopes: ["observe"] }, -1);
    expect(await sessions.elevate(expired.token, 10_000)).toBeUndefined();
  });
});

describe("operators.findEmail — identity lookup for the elevate flow", () => {
  it("resolves the login email for an already-authenticated (workspaceId, operatorId)", () => {
    const dir = new MemoryOperatorDirectory([
      makeOperator("viewer", DEFAULT_WORKSPACE, "viewer@cyberdyne.dev", "skynet", "viewer"),
      makeOperator("viewer", "resistance", "other-viewer@resistance.dev", "skynet", "viewer"),
    ]);
    // Same operatorId, different workspace — must not cross-resolve.
    expect(dir.findEmail(DEFAULT_WORKSPACE, "viewer")).toBe("viewer@cyberdyne.dev");
    expect(dir.findEmail("resistance", "viewer")).toBe("other-viewer@resistance.dev");
    expect(dir.findEmail(DEFAULT_WORKSPACE, "nobody")).toBeUndefined();
  });
});

const EMAIL = "viewer@cyberdyne.dev";
const PASSWORD = "correct-horse-battery-staple";
const WRONG_ORIGIN_EMAIL = "admin@cyberdyne.dev";

describe("POST /api/auth/elevate — real Fastify app, real session store", () => {
  let app: FastifyInstance;
  let sessions: MemorySessionStore;
  let elevationLog: MemoryElevationLog;
  const ORIG_TTL = config.elevationTtlMs;
  const ORIG_MAX_TTL = config.elevationMaxTtlMs;

  beforeAll(async () => {
    sessions = new MemorySessionStore();
    const operators = new MemoryOperatorDirectory([
      makeOperator("viewer", DEFAULT_WORKSPACE, EMAIL, PASSWORD, "viewer"),
      makeOperator("admin", DEFAULT_WORKSPACE, WRONG_ORIGIN_EMAIL, "other-pw"),
    ]);
    elevationLog = new MemoryElevationLog();
    configureAuth({ sessions });

    const store = new MemoryStore({ seed: false });
    const hub = new Hub(store, new NullBus());
    const orchestrator = new Orchestrator(store, hub, new NullProvider());
    const operations = new Operations({ store, hub, orchestrator });

    app = Fastify();
    await registerAuthRoutes(app, { sessions, operators, elevationLog });
    await registerApi(app, { operations, orchestrator });
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "Not found" }));
    await app.ready();

    config.elevationTtlMs = 5 * 60_000;
    config.elevationMaxTtlMs = 10 * 60_000;
  });

  const loginAsViewer = async (): Promise<string> => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: EMAIL, password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    return (res.json() as { token: string }).token;
  };

  it("before elevating: reads work, a mutation is refused (viewer scope)", async () => {
    const token = await loginAsViewer();
    const read = await app.inject({ method: "GET", url: "/api/snapshot", headers: { authorization: `Bearer ${token}` } });
    expect(read.statusCode).toBe(200);
    const mutate = await app.inject({ method: "POST", url: "/api/projects", headers: { authorization: `Bearer ${token}` }, payload: {} });
    expect(mutate.statusCode).toBe(403);
  });

  it("correct password elevates the session; the same mutation now succeeds; /me reflects it", async () => {
    const token = await loginAsViewer();

    const elevate = await app.inject({
      method: "POST",
      url: "/api/auth/elevate",
      headers: { authorization: `Bearer ${token}` },
      payload: { password: PASSWORD },
    });
    expect(elevate.statusCode).toBe(200);
    const { elevatedUntil } = elevate.json() as { elevatedUntil: number };
    expect(elevatedUntil).toBeGreaterThan(Date.now());

    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${token}` } });
    const principal = (me.json() as { principal: { scopes?: string[]; elevatedUntil?: number } }).principal;
    expect(principal.scopes).toBeUndefined();
    expect(principal.elevatedUntil).toBe(elevatedUntil);

    const mutate = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "P", goal: "g" },
    });
    expect(mutate.statusCode).not.toBe(403);

    const events = await elevationLog.list(DEFAULT_WORKSPACE);
    expect(events[0]).toMatchObject({ workspaceId: DEFAULT_WORKSPACE, operatorId: "viewer", expiresAt: elevatedUntil });
  });

  it("wrong password is refused; the session stays scoped", async () => {
    const token = await loginAsViewer();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/elevate",
      headers: { authorization: `Bearer ${token}` },
      payload: { password: "not-the-password" },
    });
    expect(res.statusCode).toBe(401);
    const mutate = await app.inject({ method: "POST", url: "/api/projects", headers: { authorization: `Bearer ${token}` }, payload: {} });
    expect(mutate.statusCode).toBe(403); // still a viewer
  });

  it("a requested TTL beyond elevationMaxTtlMs is clamped, not honored verbatim", async () => {
    const token = await loginAsViewer();
    const before = Date.now();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/elevate",
      headers: { authorization: `Bearer ${token}` },
      payload: { password: PASSWORD, ttlMs: 24 * 60 * 60 * 1000 }, // 1 day — way over the 10m cap
    });
    expect(res.statusCode).toBe(200);
    const { elevatedUntil } = res.json() as { elevatedUntil: number };
    expect(elevatedUntil).toBeLessThanOrEqual(before + config.elevationMaxTtlMs + 2000);
  });

  it("GET /api/auth/elevations returns this workspace's grants, newest first", async () => {
    const res = await app.inject({ method: "GET", url: "/api/auth/elevations", headers: { authorization: "Bearer dev-cyberdyne" } });
    expect(res.statusCode).toBe(200);
    const events = res.json() as Array<{ operatorId: string; at: number; expiresAt: number }>;
    expect(events.length).toBeGreaterThan(0);
    for (let i = 1; i < events.length; i++) expect(events[i - 1].at).toBeGreaterThanOrEqual(events[i].at);
  });

  it("logging out does not clear the elevation log (it's append-only, no delete route exists)", async () => {
    const eventsBefore = (await elevationLog.list(DEFAULT_WORKSPACE)).length;
    const token = await loginAsViewer();
    await app.inject({ method: "POST", url: "/api/auth/logout", headers: { authorization: `Bearer ${token}` } });
    expect((await elevationLog.list(DEFAULT_WORKSPACE)).length).toBe(eventsBefore);
  });

  it("no /api route exists to archive/delete an elevation event", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/auth/elevations", headers: { authorization: "Bearer dev-cyberdyne" } });
    expect(res.statusCode).toBe(404);
  });

  // Restore module-scoped config after this suite (mirrors auth-mfa-session-ttl.test.ts's pattern).
  it("restores config", () => {
    config.elevationTtlMs = ORIG_TTL;
    config.elevationMaxTtlMs = ORIG_MAX_TTL;
  });
});
