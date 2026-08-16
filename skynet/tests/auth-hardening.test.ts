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
import { isGuardedPath, isPublicLogin, requiredScope, requiresAuth } from "../apps/server/src/auth-guard.js";
import { isCorsOriginAllowed } from "../apps/server/src/cors-policy.js";
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
  // Assert against the real predicates the onRequest hook uses (auth-guard.ts),
  // so production and the test can't drift.
  it("treats uppercase /API/... as a guarded route", () => {
    expect(isGuardedPath("/API/snapshot")).toBe(true);
    expect(isGuardedPath("/Api/Fleet/Runners")).toBe(true);
  });

  it("still matches real lowercase /api/... and /mcp routes", () => {
    expect(isGuardedPath("/api/snapshot")).toBe(true);
    expect(isGuardedPath("/mcp")).toBe(true);
    expect(isGuardedPath("/MCP")).toBe(true);
  });

  it("does not match non-api paths", () => {
    expect(isGuardedPath("/assets/app.js")).toBe(false);
    expect(isGuardedPath("/")).toBe(false);
  });

  it("recognizes the public login route regardless of case, with a query string", () => {
    expect(isPublicLogin("/API/auth/login")).toBe(true);
    expect(isPublicLogin("/api/auth/login?next=/")).toBe(true);
    expect(isPublicLogin("/api/auth/logout")).toBe(false);
  });

  it("requires auth on guarded routes but exempts the public login route", () => {
    expect(requiresAuth("/api/snapshot")).toBe(true);
    expect(requiresAuth("/API/snapshot")).toBe(true);
    expect(requiresAuth("/mcp")).toBe(true);
    // Login is guarded-prefix but public, so it must NOT require auth.
    expect(requiresAuth("/api/auth/login")).toBe(false);
    expect(requiresAuth("/API/auth/login")).toBe(false);
    expect(requiresAuth("/api/auth/login?next=/")).toBe(false);
    // Non-api paths pass through untouched.
    expect(requiresAuth("/assets/app.js")).toBe(false);
    expect(requiresAuth("/ws")).toBe(false);
    expect(requiresAuth("/")).toBe(false);
  });
});

describe("requiredScope: the viewer-role mutation gate", () => {
  it("never requires a scope for reads (GET/HEAD), on /api or /mcp", () => {
    expect(requiredScope("GET", "/api/snapshot")).toBeNull();
    expect(requiredScope("GET", "/api/projects/p-1/roadmap")).toBeNull();
    expect(requiredScope("HEAD", "/api/snapshot")).toBeNull();
  });

  it("excludes /mcp entirely — every tool call there is already scope-gated per-tool", () => {
    expect(requiredScope("POST", "/mcp")).toBeNull();
    expect(requiredScope("POST", "/MCP")).toBeNull();
  });

  it("exempts personal auth actions and the dry-run/judge endpoints", () => {
    expect(requiredScope("POST", "/api/auth/logout")).toBeNull();
    // Load-bearing, not a convenience: /api/auth/elevate is how a viewer
    // ESCAPES the "author" gate below — it can't itself require "author".
    expect(requiredScope("POST", "/api/auth/elevate")).toBeNull();
    expect(requiredScope("POST", "/api/telegram/simulate")).toBeNull();
    expect(requiredScope("POST", "/api/simulation/grade")).toBeNull();
    expect(requiredScope("POST", "/api/simulation/judge")).toBeNull();
    expect(requiredScope("POST", "/api/steward/chat")).toBeNull();
    expect(requiredScope("POST", "/api/steward/chat/stream")).toBeNull();
  });

  it("requires \"approver\" for HITL resolve and every merge-decision route", () => {
    expect(requiredScope("POST", "/api/hitl/h-1/resolve")).toBe("approver");
    expect(requiredScope("POST", "/api/merges/r-1/merge")).toBe("approver");
    expect(requiredScope("POST", "/api/merges/r-1/rework")).toBe("approver");
    expect(requiredScope("POST", "/api/merges/r-1/update-branch")).toBe("approver");
    expect(requiredScope("POST", "/api/merges/r-1/dismiss")).toBe("approver");
  });

  it("defaults every other non-GET /api route to \"author\"", () => {
    expect(requiredScope("POST", "/api/projects")).toBe("author");
    expect(requiredScope("PATCH", "/api/projects/p-1")).toBe("author");
    expect(requiredScope("DELETE", "/api/projects/p-1")).toBe("author");
    expect(requiredScope("POST", "/api/projects/p-1/tasks/t-1/assign")).toBe("author");
    expect(requiredScope("PUT", "/api/settings/env")).toBe("author");
    expect(requiredScope("POST", "/api/credentials")).toBe("author");
    expect(requiredScope("PUT", "/api/github/pat")).toBe("author");
  });

  it("is case-insensitive on the path, matching the DEF-007 guard's own convention", () => {
    expect(requiredScope("POST", "/API/Hitl/h-1/Resolve")).toBe("approver");
    expect(requiredScope("POST", "/API/Projects")).toBe("author");
  });
});

describe("#7: scoped CORS allowlist (no reflect-any in production)", () => {
  const allowlist = ["https://app.example.com", "https://ops.example.com"];

  it("is permissive in dev/test (localhost dev unaffected)", () => {
    expect(isCorsOriginAllowed("https://evil.example", { devMode: true, allowlist: [] })).toBe(true);
    expect(isCorsOriginAllowed("http://localhost:5173", { devMode: true, allowlist })).toBe(true);
  });

  it("allows an allowlisted origin in production", () => {
    expect(isCorsOriginAllowed("https://app.example.com", { devMode: false, allowlist })).toBe(true);
    expect(isCorsOriginAllowed("https://ops.example.com", { devMode: false, allowlist })).toBe(true);
  });

  it("rejects a non-allowlisted origin in production", () => {
    expect(isCorsOriginAllowed("https://evil.example", { devMode: false, allowlist })).toBe(false);
    // Exact match only — no substring/suffix bypass.
    expect(isCorsOriginAllowed("https://app.example.com.evil.com", { devMode: false, allowlist })).toBe(false);
  });

  it("allows same-origin / non-CORS requests (no Origin header) in production", () => {
    expect(isCorsOriginAllowed(undefined, { devMode: false, allowlist })).toBe(true);
  });

  it("defaults CLOSED when the allowlist is empty in production (no reflect-any)", () => {
    expect(isCorsOriginAllowed("https://app.example.com", { devMode: false, allowlist: [] })).toBe(false);
    // A no-Origin request still passes (nothing cross-origin to gate).
    expect(isCorsOriginAllowed(undefined, { devMode: false, allowlist: [] })).toBe(true);
  });
});
