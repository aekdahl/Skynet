// Time-limited admin promotion (ROADMAP.md) — ADMIN-granted, never
// self-service: an existing admin promotes a NAMED viewer to a bounded
// full-authority window (POST /api/operators/:operatorId/promote). Depends on
// the read-only viewer role (a prior ROADMAP item): promoting only matters
// for an operator whose base role is scoped.
//
// Three layers: MemoryElevationStore's grant()/activeUntil()/list()
// interplay in isolation (no HTTP), auth.ts's resolvePrincipal() merging a
// live grant into a session-resolved principal, then the real routes
// end-to-end via app.inject (mirrors tests/viewer-role-routes.test.ts's
// pattern) — including the loophole this design is built to close: a
// CURRENTLY-ELEVATED viewer's live scopes look identical to a real admin's,
// so the promote route must check the caller's PERSISTED role, not their
// live scopes, or an elevated viewer could re-grant/self-extend indefinitely.
import { describe, it, expect, beforeAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { configureAuth, resolvePrincipal, hasScope } from "../apps/server/src/auth.js";
import { MemorySessionStore } from "../apps/server/src/auth/sessions.js";
import { MemoryOperatorDirectory, makeOperator } from "../apps/server/src/auth/operators.js";
import { MemoryElevationStore } from "../apps/server/src/auth/elevations.js";
import { registerAuthRoutes } from "../apps/server/src/auth/routes.js";
import { registerApi } from "../apps/server/src/api.js";
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

describe("MemoryElevationStore: grant()/activeUntil()/list() interplay", () => {
  it("a grant is active until it lapses, then activeUntil sweeps it and logs a separate expiry event", async () => {
    const store = new MemoryElevationStore();
    const { expiresAt } = await store.grant(DEFAULT_WORKSPACE, "v", "admin-1", 60_000);
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(await store.activeUntil(DEFAULT_WORKSPACE, "v")).toBe(expiresAt);

    const events = await store.list(DEFAULT_WORKSPACE);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "grant", operatorId: "v", grantedBy: "admin-1", expiresAt });
  });

  it("an already-lapsed grant (negative ttl) reads as inactive immediately and logs its own expiry entry", async () => {
    const store = new MemoryElevationStore();
    const { expiresAt } = await store.grant(DEFAULT_WORKSPACE, "v", "admin-1", -1);

    expect(await store.activeUntil(DEFAULT_WORKSPACE, "v")).toBeNull();
    const events = await store.list(DEFAULT_WORKSPACE);
    // Newest first: the expiry (observed just now, on the activeUntil() call
    // above) precedes the grant that was recorded a moment earlier.
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: "expiry", operatorId: "v", expiresAt });
    expect(events[1]).toMatchObject({ kind: "grant", operatorId: "v", expiresAt });
    // A second read after the sweep is a no-op — no duplicate expiry entries.
    expect(await store.activeUntil(DEFAULT_WORKSPACE, "v")).toBeNull();
    expect(await store.list(DEFAULT_WORKSPACE)).toHaveLength(2);
  });

  it("re-granting replaces the previous active window rather than stacking", async () => {
    const store = new MemoryElevationStore();
    await store.grant(DEFAULT_WORKSPACE, "v", "admin-1", 60_000);
    const second = await store.grant(DEFAULT_WORKSPACE, "v", "admin-2", 5_000);
    expect(await store.activeUntil(DEFAULT_WORKSPACE, "v")).toBe(second.expiresAt);
  });

  it("an operator with no grant reads as inactive, no crash", async () => {
    const store = new MemoryElevationStore();
    expect(await store.activeUntil(DEFAULT_WORKSPACE, "nobody")).toBeNull();
  });

  it("workspaces are isolated — a grant/list in one never leaks into another", async () => {
    const store = new MemoryElevationStore();
    await store.grant(DEFAULT_WORKSPACE, "v", "admin-1", 60_000);
    expect(await store.activeUntil("resistance", "v")).toBeNull();
    expect(await store.list("resistance")).toEqual([]);
  });
});

describe("resolvePrincipal: an admin-granted elevation is checked on EVERY session resolve", () => {
  it("a viewer's session resolves scoped, then full-authority once granted, then reverts on its own after the window lapses", async () => {
    const sessions = new MemorySessionStore();
    const elevations = new MemoryElevationStore();
    const session = await sessions.create({ workspaceId: DEFAULT_WORKSPACE, operatorId: "v", scopes: ["observe"] }, 60_000);
    configureAuth({ sessions, elevations });

    const before = await resolvePrincipal(session.token);
    expect(before?.scopes).toEqual(["observe"]);
    expect(hasScope(before!, "author")).toBe(false);

    const { expiresAt } = await elevations.grant(DEFAULT_WORKSPACE, "v", "admin-1", 10_000);

    const during = await resolvePrincipal(session.token);
    expect(during?.scopes).toBeUndefined(); // full authority
    expect(during?.elevatedUntil).toBe(expiresAt);
    expect(hasScope(during!, "author")).toBe(true);
    expect(hasScope(during!, "admin")).toBe(true);
    // Base identity is preserved throughout — elevation only widens scope.
    expect(during?.workspaceId).toBe(DEFAULT_WORKSPACE);
    expect(during?.operatorId).toBe("v");

    await elevations.grant(DEFAULT_WORKSPACE, "v", "admin-1", -1); // force it into the past
    const after = await resolvePrincipal(session.token);
    expect(after?.scopes).toEqual(["observe"]); // reverted to base — no logout involved
    expect(after?.elevatedUntil).toBeUndefined();
  });

  it("elevation is never applied to a dev-token or service-token principal — only session-resolved (human) ones", async () => {
    const elevations = new MemoryElevationStore();
    // "jordan" is the dev-token operatorId for DEFAULT_WORKSPACE (auth.ts's
    // TOKENS map) — grant it an elevation and confirm the dev-token path
    // (which never touches `sessions`/`elevations`) is unaffected either way.
    await elevations.grant(DEFAULT_WORKSPACE, "jordan", "admin-1", 60_000);
    configureAuth({ elevations });
    const resolved = await resolvePrincipal("dev-cyberdyne");
    expect(resolved?.elevatedUntil).toBeUndefined();
  });
});

const ADMIN_EMAIL = "admin@cyberdyne.dev";
const ADMIN_PASSWORD = "admin-pw";
const VIEWER_EMAIL = "viewer@cyberdyne.dev";
const VIEWER_PASSWORD = "viewer-pw";
const OTHER_VIEWER_EMAIL = "other-viewer@cyberdyne.dev";
const OTHER_VIEWER_PASSWORD = "other-viewer-pw";

describe("POST /api/operators/:operatorId/promote — real Fastify app, real stores", () => {
  let app: FastifyInstance;
  let elevations: MemoryElevationStore;
  const ORIG_TTL = config.elevationTtlMs;
  const ORIG_MAX_TTL = config.elevationMaxTtlMs;

  beforeAll(async () => {
    const sessions = new MemorySessionStore();
    const operators = new MemoryOperatorDirectory([
      makeOperator("admin", DEFAULT_WORKSPACE, ADMIN_EMAIL, ADMIN_PASSWORD, "admin"),
      makeOperator("viewer", DEFAULT_WORKSPACE, VIEWER_EMAIL, VIEWER_PASSWORD, "viewer"),
      makeOperator("viewer2", DEFAULT_WORKSPACE, OTHER_VIEWER_EMAIL, OTHER_VIEWER_PASSWORD, "viewer"),
    ]);
    elevations = new MemoryElevationStore();
    configureAuth({ sessions, elevations });

    const store = new MemoryStore({ seed: false });
    const hub = new Hub(store, new NullBus());
    const orchestrator = new Orchestrator(store, hub, new NullProvider());
    const operations = new Operations({ store, hub, orchestrator });

    app = Fastify();
    await registerAuthRoutes(app, { sessions, operators, elevations });
    await registerApi(app, { operations, orchestrator });
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "Not found" }));
    await app.ready();

    config.elevationTtlMs = 5 * 60_000;
    config.elevationMaxTtlMs = 10 * 60_000;
  });

  const login = async (email: string, password: string): Promise<string> => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
    expect(res.statusCode).toBe(200);
    return (res.json() as { token: string }).token;
  };
  const mutate = (token: string) =>
    app.inject({ method: "POST", url: "/api/projects", headers: { authorization: `Bearer ${token}` }, payload: { name: "P", goal: "g" } });
  const promote = (token: string, targetOperatorId: string, ttlMs?: number) =>
    app.inject({
      method: "POST",
      url: `/api/operators/${targetOperatorId}/promote`,
      headers: { authorization: `Bearer ${token}` },
      payload: ttlMs ? { ttlMs } : {},
    });

  it("before promoting: the viewer reads work, a mutation is refused (viewer scope)", async () => {
    const token = await login(VIEWER_EMAIL, VIEWER_PASSWORD);
    const read = await app.inject({ method: "GET", url: "/api/snapshot", headers: { authorization: `Bearer ${token}` } });
    expect(read.statusCode).toBe(200);
    expect((await mutate(token)).statusCode).toBe(403);
  });

  it("a viewer cannot promote itself or anyone else — never self-service", async () => {
    const viewerToken = await login(VIEWER_EMAIL, VIEWER_PASSWORD);
    const self = await promote(viewerToken, "viewer");
    expect(self.statusCode).toBe(403);
    const other = await promote(viewerToken, "viewer2");
    expect(other.statusCode).toBe(403);
    // Neither attempt actually granted anything.
    expect(await elevations.activeUntil(DEFAULT_WORKSPACE, "viewer")).toBeNull();
    expect(await elevations.activeUntil(DEFAULT_WORKSPACE, "viewer2")).toBeNull();
  });

  it("an admin promotes a named viewer; that viewer's SAME session now succeeds at the mutation; /me reflects it", async () => {
    const adminToken = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    const viewerToken = await login(VIEWER_EMAIL, VIEWER_PASSWORD);

    const res = await promote(adminToken, "viewer");
    expect(res.statusCode).toBe(200);
    const { expiresAt } = res.json() as { expiresAt: number };
    expect(expiresAt).toBeGreaterThan(Date.now());

    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${viewerToken}` } });
    const principal = (me.json() as { principal: { scopes?: string[]; elevatedUntil?: number } }).principal;
    expect(principal.scopes).toBeUndefined();
    expect(principal.elevatedUntil).toBe(expiresAt);

    expect((await mutate(viewerToken)).statusCode).not.toBe(403);

    const events = await elevations.list(DEFAULT_WORKSPACE);
    expect(events[0]).toMatchObject({ kind: "grant", operatorId: "viewer", grantedBy: "admin", expiresAt });
  });

  it("a CURRENTLY-ELEVATED viewer still cannot grant a promotion — the persisted role is checked, not the live scope", async () => {
    const adminToken = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    const viewerToken = await login(VIEWER_EMAIL, VIEWER_PASSWORD);
    expect((await promote(adminToken, "viewer")).statusCode).toBe(200); // viewer is now elevated

    // The elevated viewer's OWN principal now has scopes: undefined — same
    // shape as a real admin's — but the promote route must still refuse it.
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${viewerToken}` } });
    expect((me.json() as { principal: { scopes?: string[] } }).principal.scopes).toBeUndefined();

    const selfExtend = await promote(viewerToken, "viewer");
    expect(selfExtend.statusCode).toBe(403);
    const promoteOther = await promote(viewerToken, "viewer2");
    expect(promoteOther.statusCode).toBe(403);
    expect(await elevations.activeUntil(DEFAULT_WORKSPACE, "viewer2")).toBeNull();
  });

  it("promoting an unknown operator 404s", async () => {
    const adminToken = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    expect((await promote(adminToken, "nobody")).statusCode).toBe(404);
  });

  it("promoting an operator who is already an admin is refused (nothing to promote)", async () => {
    const adminToken = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    const res = await promote(adminToken, "admin");
    expect(res.statusCode).toBe(400);
  });

  it("a requested TTL beyond elevationMaxTtlMs is clamped, not honored verbatim", async () => {
    const adminToken = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    const before = Date.now();
    const res = await promote(adminToken, "viewer2", 24 * 60 * 60 * 1000); // 1 day — way over the 10m cap
    expect(res.statusCode).toBe(200);
    const { expiresAt } = res.json() as { expiresAt: number };
    expect(expiresAt).toBeLessThanOrEqual(before + config.elevationMaxTtlMs + 2000);
  });

  it("GET /api/operators is admin-only — a viewer is refused, an admin sees the non-secret roster", async () => {
    const viewerToken = await login(VIEWER_EMAIL, VIEWER_PASSWORD);
    expect((await app.inject({ method: "GET", url: "/api/operators", headers: { authorization: `Bearer ${viewerToken}` } })).statusCode).toBe(403);

    const adminToken = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    const res = await app.inject({ method: "GET", url: "/api/operators", headers: { authorization: `Bearer ${adminToken}` } });
    expect(res.statusCode).toBe(200);
    const roster = res.json() as Array<{ operatorId: string; email: string; role: string }>;
    expect(roster.find((o) => o.operatorId === "viewer")).toMatchObject({ email: VIEWER_EMAIL, role: "viewer" });
    // Never leaks salt/hash.
    for (const o of roster) expect(Object.keys(o).sort()).toEqual(["email", "operatorId", "role"]);
  });

  it("GET /api/auth/elevations returns this workspace's grant + expiry events, newest first", async () => {
    const res = await app.inject({ method: "GET", url: "/api/auth/elevations", headers: { authorization: "Bearer dev-cyberdyne" } });
    expect(res.statusCode).toBe(200);
    const events = res.json() as Array<{ at: number }>;
    expect(events.length).toBeGreaterThan(0);
    for (let i = 1; i < events.length; i++) expect(events[i - 1].at).toBeGreaterThanOrEqual(events[i].at);
  });

  it("logging out does not clear the elevation log (it's append-only, no delete route exists)", async () => {
    const eventsBefore = (await elevations.list(DEFAULT_WORKSPACE)).length;
    const token = await login(VIEWER_EMAIL, VIEWER_PASSWORD);
    await app.inject({ method: "POST", url: "/api/auth/logout", headers: { authorization: `Bearer ${token}` } });
    expect((await elevations.list(DEFAULT_WORKSPACE)).length).toBe(eventsBefore);
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
