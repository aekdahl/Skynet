// ─── Auth routes ──────────────────────────────────────────────────────────
// Real login (W6): exchange credentials for a session. /login is the only
// public /api route (it issues the token); /logout and /me run behind the
// workspace-auth hook like everything else. The session token is returned in
// the body (for Bearer use) AND set as an httpOnly cookie (for browser use).

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { config, now } from "../config.js";
import { cookieToken, tokenFrom, SESSION_COOKIE } from "../auth.js";
import type { SessionStore } from "./sessions.js";
import type { OperatorDirectory } from "./operators.js";

const LoginRequest = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
});

export interface AuthRouteDeps {
  sessions: SessionStore;
  operators: OperatorDirectory;
}

function setSessionCookie(reply: FastifyReply, token: string, expiresAt: number): void {
  const maxAge = Math.max(0, Math.floor((expiresAt - now()) / 1000));
  const secure = config.nodeEnv === "production" ? "; Secure" : "";
  reply.header(
    "set-cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`,
  );
}

function clearSessionCookie(reply: FastifyReply): void {
  reply.header("set-cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export async function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): Promise<void> {
  const { sessions, operators } = deps;

  // Public — the one /api route reachable without an existing token.
  app.post("/api/auth/login", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = LoginRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    const principal = operators.verify(body.data.email, body.data.password);
    if (!principal) return reply.code(401).send({ error: "Invalid credentials" });
    const session = await sessions.create(principal, config.sessionTtlMs);
    setSessionCookie(reply, session.token, session.expiresAt);
    return { token: session.token, principal, expiresAt: session.expiresAt };
  });

  // Authenticated — destroy the presented session and clear the cookie.
  app.post("/api/auth/logout", async (req: FastifyRequest, reply: FastifyReply) => {
    const token =
      cookieToken(req.headers.cookie) ?? tokenFrom(req.headers.authorization, undefined);
    if (token) await sessions.destroy(token);
    clearSessionCookie(reply);
    return { ok: true };
  });

  // Authenticated — who am I? (the hook has already set req.principal or 401'd).
  app.get("/api/auth/me", async (req: FastifyRequest) => ({ principal: req.principal }));
}
