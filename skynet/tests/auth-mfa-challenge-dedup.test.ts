// Reported: a handful of login attempts in a short window (a retried form
// submit, a double click, a script hitting /api/auth/login more than once)
// used to flood Telegram with a FRESH one-time code for every single attempt
// — six distinct codes, all racing each other, none of them still valid by
// the time the operator found the right one. createChallenge now reuses an
// already-active, unexpired challenge for the same operator instead of
// minting a new one each time — same code, same TTL, just not re-issued (and
// not re-sent to Telegram) needlessly.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { WorkspaceSettings } from "@skynet/shared";
import { registerAuthRoutes } from "../apps/server/src/auth/routes.js";
import { MemorySessionStore } from "../apps/server/src/auth/sessions.js";
import { MemoryOperatorDirectory, makeOperator } from "../apps/server/src/auth/operators.js";
import { MemoryElevationStore } from "../apps/server/src/auth/elevations.js";
import { createChallenge, verifyChallenge } from "../apps/server/src/auth/mfa.js";
import { config } from "../apps/server/src/config.js";
import type { Principal } from "../apps/server/src/auth.js";

const ORIG_MFA = config.mfa;
const ORIG_BREAK_GLASS = config.mfaBreakGlass;

describe("createChallenge — reuses an active challenge instead of piling up a new one", () => {
  const principal: Principal = { workspaceId: "cyberdyne", operatorId: "op" };

  it("a second call for the SAME operator before the first expires returns the SAME challengeId + code", () => {
    const first = createChallenge(principal);
    expect(first.reused).toBe(false);
    const second = createChallenge(principal);
    expect(second.reused).toBe(true);
    expect(second.challengeId).toBe(first.challengeId);
    expect(second.code).toBe(first.code);
  });

  it("a DIFFERENT operator gets its own fresh challenge — dedup is per-operator, not global", () => {
    const first = createChallenge(principal);
    const other = createChallenge({ workspaceId: "cyberdyne", operatorId: "someone-else" });
    expect(other.reused).toBe(false);
    expect(other.challengeId).not.toBe(first.challengeId);
  });

  it("once the reused challenge is consumed, the NEXT login attempt mints a genuinely fresh one", () => {
    const first = createChallenge(principal);
    const verified = verifyChallenge(first.challengeId, first.code);
    expect(verified).toBeTruthy();
    const after = createChallenge(principal);
    expect(after.reused).toBe(false); // the old one was consumed, nothing left to reuse
    expect(after.challengeId).not.toBe(first.challengeId);
  });
});

describe("POST /api/auth/login — repeated attempts reuse one challenge end to end", () => {
  const EMAIL = "op@example.com";
  const PASSWORD = "correct-horse-battery-staple";
  let app: FastifyInstance;

  beforeEach(async () => {
    const sessions = new MemorySessionStore();
    const operators = new MemoryOperatorDirectory([makeOperator("op", "cyberdyne", EMAIL, PASSWORD)]);
    app = Fastify();
    await registerAuthRoutes(app, {
      sessions,
      operators,
      elevations: new MemoryElevationStore(),
      operations: { getWorkspaceSettings: async (ws: string) => WorkspaceSettings.parse({ workspaceId: ws }) },
    });
    await app.ready();
    config.mfa = true; // force MFA on for this suite regardless of the workspace toggle
    config.mfaBreakGlass = false;
  });
  afterEach(async () => {
    await app.close();
    config.mfa = ORIG_MFA;
    config.mfaBreakGlass = ORIG_BREAK_GLASS;
  });

  it("three rapid login attempts (no Telegram configured, so no code is ever consumed) all return the SAME challengeId", async () => {
    const attempts = await Promise.all(
      Array.from({ length: 3 }, () =>
        app.inject({ method: "POST", url: "/api/auth/login", payload: { email: EMAIL, password: PASSWORD } }),
      ),
    );
    const challengeIds = attempts.map((r) => (r.json() as { challengeId: string }).challengeId);
    expect(challengeIds.every((id) => id === challengeIds[0])).toBe(true);
  });
});
