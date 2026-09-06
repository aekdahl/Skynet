// Chat → canvas handoff (ROADMAP.md, hosted-only) — GET /handoff/:token
// exchanges a short-lived, single-use token (auth/link-exchange.ts) for a
// real session and redirects straight into the target view. Drives the REAL
// Fastify route via app.inject(), modeled on
// tests/auth-mfa-session-ttl.test.ts's pattern (registerAuthRoutes + a real
// MemorySessionStore) rather than mocking the route.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuthRoutes } from "../apps/server/src/auth/routes.js";
import { MemorySessionStore } from "../apps/server/src/auth/sessions.js";
import { MemoryOperatorDirectory } from "../apps/server/src/auth/operators.js";
import { MemoryElevationStore } from "../apps/server/src/auth/elevations.js";
import { createLinkExchange } from "../apps/server/src/auth/link-exchange.js";
import { WorkspaceSettings } from "@skynet/shared";

const operationsStub = {
  getWorkspaceSettings: async (ws: string) => WorkspaceSettings.parse({ workspaceId: ws }),
};

const PRINCIPAL = { workspaceId: "cyberdyne", operatorId: "telegram:998877" };

describe("GET /handoff/:token", () => {
  let app: FastifyInstance;
  let sessions: MemorySessionStore;

  beforeEach(async () => {
    sessions = new MemorySessionStore();
    app = Fastify();
    await registerAuthRoutes(app, {
      sessions,
      operators: new MemoryOperatorDirectory([]),
      elevations: new MemoryElevationStore(),
      operations: operationsStub,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("a valid token issues a real session and redirects to /?st=<token><hash>", async () => {
    const exchangeToken = createLinkExchange(PRINCIPAL, "#/agent/r-123");
    const res = await app.inject({ method: "GET", url: `/handoff/${exchangeToken}` });

    expect(res.statusCode).toBe(302);
    const location = res.headers.location as string;
    expect(location).toMatch(/^\/\?st=[^&]+#\/agent\/r-123$/);

    // The cookie is also set (belt-and-suspenders — see the route's own doc
    // comment for why the SPA doesn't actually rely on it).
    expect(String(res.headers["set-cookie"] ?? "")).toMatch(/skynet_session=/);

    // The `st=` token resolves to the SAME principal the exchange named.
    const sessionToken = decodeURIComponent(location.match(/^\/\?st=([^&]+)#/)![1]!);
    await expect(sessions.resolve(sessionToken)).resolves.toEqual(PRINCIPAL);
  });

  it("is single-use: a second request with the same exchange token falls back to a normal login", async () => {
    const exchangeToken = createLinkExchange(PRINCIPAL, "#/agent/r-123");
    const first = await app.inject({ method: "GET", url: `/handoff/${exchangeToken}` });
    expect(first.statusCode).toBe(302);

    const second = await app.inject({ method: "GET", url: `/handoff/${exchangeToken}` });
    expect(second.statusCode).toBe(302);
    expect(second.headers.location).toBe("/");
  });

  it("an invalid/garbage token falls back to a normal login — no session, no cookie", async () => {
    const res = await app.inject({ method: "GET", url: "/handoff/not-a-real-token" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/");
    expect(res.headers["set-cookie"]).toBeUndefined();
  });
});
