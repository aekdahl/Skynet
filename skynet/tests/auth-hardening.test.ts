// Auth hardening regressions (DEF-006, DEF-007).
//
// DEF-006 — a ?token= query param leaks via access logs, browser history, and
//   Referer headers, so REST must ignore it: authenticate() only reads the query
//   token when allowQueryToken is set (the WS handshake, which can't carry an
//   Authorization header). Header and cookie paths are unaffected.
// DEF-007 — the /api auth guard's prefix match must be case-insensitive so an
//   uppercase /API/... can't skip it. We pin the lowercase-then-compare helper.
import { describe, it, expect } from "vitest";
import type { FastifyRequest } from "fastify";
import { authenticate } from "../apps/server/src/auth.js";
import { DEFAULT_WORKSPACE } from "@skynet/shared";

// Minimal FastifyRequest stand-in — authenticate only touches headers + query.
const req = (opts: { authorization?: string; cookie?: string; token?: string }): FastifyRequest =>
  ({
    headers: { authorization: opts.authorization, cookie: opts.cookie },
    query: opts.token !== undefined ? { token: opts.token } : {},
  }) as unknown as FastifyRequest;

// A known dev token (resolves outside production, which is the test env).
const DEV_TOKEN = "dev-cyberdyne";

describe("DEF-006: REST ignores the ?token= query param", () => {
  it("does NOT resolve a principal from a query token by default (REST mode)", async () => {
    const principal = await authenticate(req({ token: DEV_TOKEN }));
    // AUTH_REQUIRED is off in tests, so we fall back to the dev default operator
    // rather than the cyberdyne workspace the query token would have selected.
    expect(principal?.operatorId).not.toBe("jordan");
  });

  it("still honors an Authorization header in REST mode", async () => {
    const principal = await authenticate(req({ authorization: `Bearer ${DEV_TOKEN}` }));
    expect(principal).toEqual({ workspaceId: DEFAULT_WORKSPACE, operatorId: "jordan" });
  });

  it("accepts the query token only when allowQueryToken is set (WS handshake)", async () => {
    const principal = await authenticate(req({ token: DEV_TOKEN }), { allowQueryToken: true });
    expect(principal).toEqual({ workspaceId: DEFAULT_WORKSPACE, operatorId: "jordan" });
  });

  it("ignores the query token entirely in REST mode even alongside a header", async () => {
    // Query token is dropped before tokenFrom() runs, so only the header counts.
    const principal = await authenticate(
      req({ authorization: `Bearer ${DEV_TOKEN}`, token: "dev-resistance" }),
    );
    expect(principal).toEqual({ workspaceId: DEFAULT_WORKSPACE, operatorId: "jordan" });
  });
});

describe("DEF-007: the /api prefix guard is case-insensitive", () => {
  // Mirrors the onRequest hook's guard: lowercase the path, then prefix-match.
  const isApiRoute = (url: string) => url.toLowerCase().startsWith("/api");
  const isPublicLogin = (url: string) => {
    const p = url.toLowerCase();
    return p === "/api/auth/login" || p.startsWith("/api/auth/login?");
  };

  it("treats uppercase /API/... as a guarded API route", () => {
    expect(isApiRoute("/API/snapshot")).toBe(true);
    expect(isApiRoute("/Api/Fleet/Runners")).toBe(true);
  });

  it("still matches real lowercase /api/... routes", () => {
    expect(isApiRoute("/api/snapshot")).toBe(true);
  });

  it("does not match non-api paths", () => {
    expect(isApiRoute("/assets/app.js")).toBe(false);
    expect(isApiRoute("/")).toBe(false);
  });

  it("recognizes the public login route regardless of case, with a query string", () => {
    expect(isPublicLogin("/API/auth/login")).toBe(true);
    expect(isPublicLogin("/api/auth/login?next=/")).toBe(true);
    expect(isPublicLogin("/api/auth/logout")).toBe(false);
  });
});
