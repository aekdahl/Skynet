// Security fix (High, auth/routes.ts) — POST /api/service-tokens's requireHuman
// checked only the live, elevation-inflated `scopes` value, not the caller's
// PERSISTED role, the way requireAdmin deliberately does. A viewer temporarily
// elevated to full authority (break-glass) could mint a standalone,
// independently-stored bearer token with a high scope set and NO forced
// expiry — one that survives long after the elevation itself lapses.
//
// Fix: requireTokenManager looks up the caller's persisted role (never trusts
// live scopes) and, for anyone who ISN'T a persisted admin — i.e. only ever
// reachable here via an ACTIVE elevation grant, since a plain non-elevated
// viewer is already blocked upstream by the workspace mutation-scope gate —
// clamps any minted token's ttlMs to whatever remains of THEIR OWN elevation
// window. Real admins are completely unaffected (still get `ttlMs: null` =
// no forced expiry when they ask for it). Mirrors admin-promotion.test.ts's
// own real-Fastify-app pattern for testing this exact class of loophole.
import { describe, it, expect, beforeAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { configureAuth } from "../apps/server/src/auth.js";
import { MemorySessionStore } from "../apps/server/src/auth/sessions.js";
import { MemoryOperatorDirectory, makeOperator } from "../apps/server/src/auth/operators.js";
import { MemoryElevationStore } from "../apps/server/src/auth/elevations.js";
import { MemoryServiceTokenStore } from "../apps/server/src/auth/service-tokens.js";
import { registerAuthRoutes, registerServiceTokenRoutes } from "../apps/server/src/auth/routes.js";
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

const ADMIN_EMAIL = "admin@cyberdyne.dev";
const ADMIN_PASSWORD = "admin-pw";
const VIEWER_EMAIL = "viewer@cyberdyne.dev";
const VIEWER_PASSWORD = "viewer-pw";

describe("service-token routes — elevated-viewer loophole (real Fastify app, real stores)", () => {
  let app: FastifyInstance;
  let elevations: MemoryElevationStore;
  let serviceTokens: MemoryServiceTokenStore;
  const ORIG_MAX_TTL = config.elevationMaxTtlMs;

  beforeAll(async () => {
    const sessions = new MemorySessionStore();
    const operators = new MemoryOperatorDirectory([
      makeOperator("admin", DEFAULT_WORKSPACE, ADMIN_EMAIL, ADMIN_PASSWORD, "admin"),
      makeOperator("viewer", DEFAULT_WORKSPACE, VIEWER_EMAIL, VIEWER_PASSWORD, "viewer"),
    ]);
    elevations = new MemoryElevationStore();
    serviceTokens = new MemoryServiceTokenStore();
    configureAuth({ sessions, elevations, serviceTokens }); // serviceTokens too — a minted token must actually resolve as a bearer principal

    const store = new MemoryStore({ seed: false });
    const hub = new Hub(store, new NullBus());
    const orchestrator = new Orchestrator(store, hub, new NullProvider());
    const operations = new Operations({ store, hub, orchestrator });

    app = Fastify();
    // registerApi installs the global onRequest hook that resolves
    // req.principal for every /api route (api.ts:144) — registerAuthRoutes/
    // registerServiceTokenRoutes only define routes, same as admin-promotion.
    // test.ts's own setup.
    await registerAuthRoutes(app, { sessions, operators, elevations, operations });
    await registerServiceTokenRoutes(app, { serviceTokens, operators, operations });
    await registerApi(app, { operations, orchestrator });
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "Not found" }));
    await app.ready();

    config.elevationMaxTtlMs = 10 * 60_000; // 10m, so a "way over the cap" request is meaningfully distinct
  });

  const login = async (email: string, password: string): Promise<string> => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
    expect(res.statusCode).toBe(200);
    return (res.json() as { token: string }).token;
  };
  const promote = (adminToken: string, targetOperatorId: string) =>
    app.inject({ method: "POST", url: `/api/operators/${targetOperatorId}/promote`, headers: { authorization: `Bearer ${adminToken}` }, payload: {} });
  const mintToken = (token: string, body: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/service-tokens", headers: { authorization: `Bearer ${token}` }, payload: body });
  const listTokens = (token: string) => app.inject({ method: "GET", url: "/api/service-tokens", headers: { authorization: `Bearer ${token}` } });
  const deleteToken = (token: string, id: string) =>
    app.inject({ method: "DELETE", url: `/api/service-tokens/${id}`, headers: { authorization: `Bearer ${token}` } });

  it("a plain (non-elevated) viewer is refused on all three routes — the pre-existing, still-correct baseline", async () => {
    const viewerToken = await login(VIEWER_EMAIL, VIEWER_PASSWORD);
    expect((await mintToken(viewerToken, { label: "x", scopes: ["observe"] })).statusCode).toBe(403);
    expect((await listTokens(viewerToken)).statusCode).toBe(403);
    expect((await deleteToken(viewerToken, "nonexistent")).statusCode).toBe(403);
  });

  it("a real admin still mints a token with NO forced expiry when none is requested — the fix doesn't regress legitimate admin use", async () => {
    const adminToken = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    const res = await mintToken(adminToken, { label: "admin-tool", scopes: ["admin"] });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { expiresAt: number | null; id: string };
    expect(body.expiresAt).toBeNull();
    await deleteToken(adminToken, body.id); // clean up
  });

  it("an ELEVATED viewer CAN still mint a token (break-glass isn't shut out entirely) — but never with a null/no-expiry ttl", async () => {
    const adminToken = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    const viewerToken = await login(VIEWER_EMAIL, VIEWER_PASSWORD);
    expect((await promote(adminToken, "viewer")).statusCode).toBe(200); // viewer is now elevated

    // Confirm the exact shape of the loophole this closes: the elevated
    // viewer's live principal now looks exactly like an admin's.
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${viewerToken}` } });
    expect((me.json() as { principal: { scopes?: string[] } }).principal.scopes).toBeUndefined();

    // Requesting NO ttl (the old exploit's move: mint a permanent token).
    const res = await mintToken(viewerToken, { label: "elevated-mint", scopes: ["admin"] });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { expiresAt: number | null; id: string };
    expect(body.expiresAt).not.toBeNull(); // MANDATORY — never a standing/no-expiry token for a non-admin
    expect(body.expiresAt!).toBeGreaterThan(Date.now());
    // Bounded by the elevation window, not by config.elevationMaxTtlMs (which
    // is much larger here) — the token cannot outlive the specific grant.
    const { expiresAt: elevationExpiresAt } = (await elevations.list(DEFAULT_WORKSPACE))[0] as { expiresAt: number };
    expect(body.expiresAt!).toBeLessThanOrEqual(elevationExpiresAt + 1000); // small clock-skew allowance
    await deleteToken(adminToken, body.id); // clean up (as the real admin, to also exercise that path)
  });

  it("an elevated viewer's requested ttl is clamped DOWN to the remaining elevation window even if it asks for less than that window but more than what's left", async () => {
    const adminToken = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    const viewerToken = await login(VIEWER_EMAIL, VIEWER_PASSWORD);
    const promoted = await promote(adminToken, "viewer");
    const { expiresAt: elevationExpiresAt } = promoted.json() as { expiresAt: number };
    const remaining = elevationExpiresAt - Date.now();

    // Ask for something clearly larger than what's left of the elevation.
    const res = await mintToken(viewerToken, { label: "over-ask", scopes: ["observe"], ttlMs: remaining + 5 * 60_000 });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { expiresAt: number; id: string };
    expect(body.expiresAt).toBeLessThanOrEqual(elevationExpiresAt + 1000);
    await deleteToken(adminToken, body.id);
  });

  it("an elevated viewer CAN list and revoke tokens (the same persisted-role-aware gate applies uniformly)", async () => {
    const adminToken = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    const viewerToken = await login(VIEWER_EMAIL, VIEWER_PASSWORD);
    await promote(adminToken, "viewer");

    const minted = await mintToken(viewerToken, { label: "for-list-test", scopes: ["observe"] });
    const { id } = minted.json() as { id: string };

    const list = await listTokens(viewerToken);
    expect(list.statusCode).toBe(200);
    expect((list.json() as Array<{ id: string }>).some((t) => t.id === id)).toBe(true);

    expect((await deleteToken(viewerToken, id)).statusCode).toBe(200);
    expect((await listTokens(viewerToken)).json()).not.toContainEqual(expect.objectContaining({ id }));
  });

  it("once the elevation lapses, the SAME (now-reverted) viewer session is refused again on all three routes", async () => {
    const adminToken = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    const viewerToken = await login(VIEWER_EMAIL, VIEWER_PASSWORD);
    await promote(adminToken, "viewer");
    expect((await mintToken(viewerToken, { label: "during", scopes: ["observe"] })).statusCode).toBe(201);

    // Force the grant into the past — same technique admin-promotion.test.ts
    // uses to simulate a lapsed window without a real sleep.
    await elevations.grant(DEFAULT_WORKSPACE, "viewer", "admin", -1);

    expect((await mintToken(viewerToken, { label: "after", scopes: ["observe"] })).statusCode).toBe(403);
    expect((await listTokens(viewerToken)).statusCode).toBe(403);
    expect((await deleteToken(viewerToken, "whatever")).statusCode).toBe(403);
  });

  it("a scoped service token itself can never manage other tokens — the pre-existing 'no self-escalation' guarantee holds", async () => {
    const adminToken = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    const minted = await mintToken(adminToken, { label: "scoped-caller", scopes: ["admin"] });
    const { token: scopedToken, id } = minted.json() as { token: string; id: string };

    expect((await mintToken(scopedToken, { label: "escalate", scopes: ["admin"] })).statusCode).toBe(403);
    expect((await listTokens(scopedToken)).statusCode).toBe(403);
    await deleteToken(adminToken, id);
  });

  it("restores config", () => {
    config.elevationMaxTtlMs = ORIG_MAX_TTL;
  });
});
