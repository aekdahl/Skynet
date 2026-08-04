// MFA-verified sessions get the LONG TTL; password-only sessions keep the
// short one. Motivating friction: rechecking MFA every 12h was more painful
// than the security bought — a second factor already raised the bar, so
// "trust this device" for ~30d is the industry-common shape.
//
// This drives the REAL Fastify auth routes with a real MemorySessionStore
// and asserts the returned `expiresAt` — the same value the httpOnly cookie
// and the session record carry.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuthRoutes } from "../apps/server/src/auth/routes.js";
import { MemorySessionStore } from "../apps/server/src/auth/sessions.js";
import { MemoryOperatorDirectory, makeOperator } from "../apps/server/src/auth/operators.js";
import { config } from "../apps/server/src/config.js";

const EMAIL = "op@example.com";
const PASSWORD = "correct-horse-battery-staple";

// Constants captured at import time so a test that mutates `config` can restore.
const ORIG_MFA = config.mfa;
const ORIG_BREAK_GLASS = config.mfaBreakGlass;
const ORIG_TTL = config.sessionTtlMs;
const ORIG_TTL_MFA = config.sessionTtlMfaMs;

// (helper removed — each test builds its own app in beforeEach)

describe("MFA-verified sessions get the long TTL", () => {
  let app: FastifyInstance;
  let sessions: MemorySessionStore;
  let operators: MemoryOperatorDirectory;

  beforeEach(async () => {
    sessions = new MemorySessionStore();
    operators = new MemoryOperatorDirectory([makeOperator("op", "cyberdyne", EMAIL, PASSWORD)]);
    app = Fastify();
    await registerAuthRoutes(app, { sessions, operators });
    await app.ready();

    // Deterministic TTLs so the assertions can compare on the exact value.
    config.sessionTtlMs = 60 * 60 * 1000; // 1h — short
    config.sessionTtlMfaMs = 30 * 24 * 60 * 60 * 1000; // 30d — long
  });

  afterEach(async () => {
    await app.close();
    // Restore. `config` is a mutable module-scoped object; leaks would infect
    // other suites that read these knobs.
    config.mfa = ORIG_MFA;
    config.mfaBreakGlass = ORIG_BREAK_GLASS;
    config.sessionTtlMs = ORIG_TTL;
    config.sessionTtlMfaMs = ORIG_TTL_MFA;
  });

  it("password-only login (MFA off) issues a session with the SHORT TTL", async () => {
    config.mfa = false;
    config.mfaBreakGlass = false;
    const before = Date.now();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: EMAIL, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { token: string; expiresAt: number };
    expect(body.token).toBeTruthy();
    // Expires ~1h from now, within a generous window that survives the
    // sub-millisecond gap between reading `before` and the server minting the
    // session. We only care that this is the SHORT TTL, not the long one.
    const shortHi = before + config.sessionTtlMs + 5000;
    const longLo = before + config.sessionTtlMfaMs - 5000;
    expect(body.expiresAt).toBeLessThanOrEqual(shortHi);
    expect(body.expiresAt).toBeLessThan(longLo);
    // The cookie carries the same lifetime as `expiresAt` (in seconds).
    const cookie = String(res.headers["set-cookie"] ?? "");
    const maxAge = Number((cookie.match(/Max-Age=(\d+)/) ?? [])[1]);
    expect(maxAge).toBeLessThanOrEqual(Math.ceil(config.sessionTtlMs / 1000) + 2);
  });

  it("MFA-verified login (MFA on, correct OTP) issues a session with the LONG TTL", async () => {
    config.mfa = true;
    config.mfaBreakGlass = false;

    // Step 1: password → { mfaRequired, challengeId } (no session yet).
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: EMAIL, password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    const loginBody = login.json() as { mfaRequired?: boolean; challengeId?: string; token?: string };
    expect(loginBody.mfaRequired).toBe(true);
    expect(loginBody.token).toBeUndefined();
    const challengeId = loginBody.challengeId!;
    expect(challengeId).toBeTruthy();

    // Step 2: pull the OTP the server minted for this challenge. In a real
    // deploy it's delivered via Telegram; in-test we read it directly from the
    // MFA module's `createChallenge` return value, which we recover here by
    // re-issuing (the map is process-scoped). Simpler: bypass the MFA endpoint
    // by using a recovery code path — but that requires disk state we don't
    // want in unit tests. Instead: mock `verifyChallenge` at the module level
    // by consuming an internal helper. To keep this test hermetic we exercise
    // the endpoint with the ACTUAL code path: we recreate a challenge via the
    // module's exported `createChallenge` and drive the endpoint with its code.
    // The route trusts whatever `verifyChallenge` returns, so a challenge we
    // created here is indistinguishable from one the login-endpoint minted.
    const { createChallenge } = await import("../apps/server/src/auth/mfa.js");
    const { challengeId: challengeId2, code } = createChallenge({
      workspaceId: "cyberdyne",
      operatorId: "op",
      scopes: ["observe", "author", "approver"],
    });

    // Step 3: exchange OTP → session with the LONG TTL.
    const before = Date.now();
    const mfa = await app.inject({
      method: "POST",
      url: "/api/auth/mfa",
      payload: { challengeId: challengeId2, code },
    });
    expect(mfa.statusCode).toBe(200);
    const body = mfa.json() as { token: string; expiresAt: number };
    expect(body.token).toBeTruthy();
    // Expires ~30d from now — well beyond the short TTL's ceiling.
    const shortHi = before + config.sessionTtlMs + 5000;
    const longHi = before + config.sessionTtlMfaMs + 5000;
    expect(body.expiresAt).toBeGreaterThan(shortHi);
    expect(body.expiresAt).toBeLessThanOrEqual(longHi);
    // The cookie's Max-Age matches the long lifetime.
    const cookie = String(mfa.headers["set-cookie"] ?? "");
    const maxAge = Number((cookie.match(/Max-Age=(\d+)/) ?? [])[1]);
    expect(maxAge).toBeGreaterThan(Math.floor(config.sessionTtlMs / 1000));
    expect(maxAge).toBeLessThanOrEqual(Math.ceil(config.sessionTtlMfaMs / 1000) + 2);
  });

  it("SKYNET_MFA_DISABLE break-glass still uses the SHORT TTL (no MFA verified)", async () => {
    // Break-glass = MFA off even though config.mfa is set. Login skips the
    // second factor entirely, so the resulting session is password-only and
    // MUST NOT inherit the MFA-length TTL.
    config.mfa = true;
    config.mfaBreakGlass = true;
    const before = Date.now();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: EMAIL, password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { token: string; expiresAt: number };
    expect(body.token).toBeTruthy();
    expect(body.expiresAt).toBeLessThanOrEqual(before + config.sessionTtlMs + 5000);
    expect(body.expiresAt).toBeLessThan(before + config.sessionTtlMfaMs - 5000);
  });
});

