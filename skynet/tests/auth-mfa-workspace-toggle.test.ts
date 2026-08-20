// Login verification (MFA), live-toggleable per workspace — Settings' new
// "Require a verification code on login" checkbox (WorkspaceSettings.
// requireLoginVerification), no restart / env var edit needed. Required
// either server-wide (SKYNET_MFA=true, an infra-level override) OR by the
// logging-in operator's own workspace's live toggle — see mfa.ts's
// mfaEnabled(). The SSH break-glass (SKYNET_MFA_DISABLE) always wins over
// both. tests/auth-mfa-session-ttl.test.ts covers the env-var-only path and
// the TTL behavior; this file is specifically the workspace-toggle path.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { WorkspaceSettings } from "@skynet/shared";
import { registerAuthRoutes } from "../apps/server/src/auth/routes.js";
import { MemorySessionStore } from "../apps/server/src/auth/sessions.js";
import { MemoryOperatorDirectory, makeOperator } from "../apps/server/src/auth/operators.js";
import { MemoryElevationStore } from "../apps/server/src/auth/elevations.js";
import { config } from "../apps/server/src/config.js";

const EMAIL = "op@example.com";
const PASSWORD = "correct-horse-battery-staple";
const WS = "cyberdyne";

const ORIG_MFA = config.mfa;
const ORIG_BREAK_GLASS = config.mfaBreakGlass;

describe("login verification — workspace-level live toggle", () => {
  let app: FastifyInstance;
  let requireLoginVerification: boolean;

  beforeEach(async () => {
    requireLoginVerification = false; // each test flips this before logging in
    const sessions = new MemorySessionStore();
    const operators = new MemoryOperatorDirectory([makeOperator("op", WS, EMAIL, PASSWORD)]);
    app = Fastify();
    await registerAuthRoutes(app, {
      sessions,
      operators,
      elevations: new MemoryElevationStore(),
      operations: {
        // A minimal stub — only the one field mfaEnabled() actually reads.
        // Reads `requireLoginVerification` fresh on every call (a closure
        // over the `let` above), same as the real Operations.getWorkspaceSettings
        // would reflect a live Settings PATCH without needing a restart.
        getWorkspaceSettings: async (ws: string) => WorkspaceSettings.parse({ workspaceId: ws, requireLoginVerification }),
      },
    });
    await app.ready();
    config.mfa = false; // env flag OFF for every test here — proving the toggle alone drives it
    config.mfaBreakGlass = false;
  });

  afterEach(async () => {
    await app.close();
    config.mfa = ORIG_MFA;
    config.mfaBreakGlass = ORIG_BREAK_GLASS;
  });

  it("toggle OFF (default): password alone issues a session, no MFA step", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: EMAIL, password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { token?: string; mfaRequired?: boolean };
    expect(body.token).toBeTruthy();
    expect(body.mfaRequired).toBeUndefined();
  });

  it("toggle ON, env flag OFF: login still requires the second factor — the workspace setting alone is enough", async () => {
    requireLoginVerification = true;
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: EMAIL, password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { token?: string; mfaRequired?: boolean; challengeId?: string };
    expect(body.mfaRequired).toBe(true);
    expect(body.token).toBeUndefined();
    expect(body.challengeId).toBeTruthy();
  });

  it("toggle ON but SKYNET_MFA_DISABLE break-glass set: skips MFA regardless of the workspace toggle", async () => {
    requireLoginVerification = true;
    config.mfaBreakGlass = true;
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: EMAIL, password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { token?: string; mfaRequired?: boolean };
    expect(body.token).toBeTruthy();
    expect(body.mfaRequired).toBeUndefined();
  });

  it("toggle OFF but the server-wide env flag is on: the env flag alone still forces MFA", async () => {
    config.mfa = true;
    requireLoginVerification = false;
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: EMAIL, password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { mfaRequired?: boolean };
    expect(body.mfaRequired).toBe(true);
  });
});
