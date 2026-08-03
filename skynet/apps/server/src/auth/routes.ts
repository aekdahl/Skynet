// ─── Auth routes ──────────────────────────────────────────────────────────
// Real login (W6): exchange credentials for a session. /login is the only
// public /api route (it issues the token); /logout and /me run behind the
// workspace-auth hook like everything else. The session token is returned in
// the body (for Bearer use) AND set as an httpOnly cookie (for browser use).

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { config, now } from "../config.js";
import { cookieToken, tokenFrom, SESSION_COOKIE, type Principal } from "../auth.js";
import { TelegramClient } from "../telegram/client.js";
import { mfaEnabled, createChallenge, verifyChallenge } from "./mfa.js";
import type { SessionStore } from "./sessions.js";
import type { ServiceTokenStore } from "./service-tokens.js";
import type { OperatorDirectory } from "./operators.js";

const LoginRequest = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
});

// Second-factor exchange: a login challenge id + the Telegram OTP (or a recovery code).
const MfaRequest = z.object({
  challengeId: z.string().min(1),
  code: z.string().min(1),
});

// Mirrors the Scope tuple in auth.ts. A minted token is narrowed to this subset.
const CreateServiceTokenRequest = z.object({
  label: z.string().min(1),
  scopes: z.array(z.enum(["observe", "author", "approver", "admin"])).min(1),
  ttlMs: z.number().int().positive().nullable().optional(),
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
  // Issue a session (httpOnly cookie + body token). Shared by the direct-login
  // and the MFA second-factor paths.
  async function issueSession(reply: FastifyReply, principal: Principal) {
    const session = await sessions.create(principal, config.sessionTtlMs);
    setSessionCookie(reply, session.token, session.expiresAt);
    return { token: session.token, principal, expiresAt: session.expiresAt };
  }

  app.post("/api/auth/login", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = LoginRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    const principal = operators.verify(body.data.email, body.data.password);
    if (!principal) return reply.code(401).send({ error: "Invalid credentials" });
    // No MFA (or broken-glass via SKYNET_MFA_DISABLE): issue the session directly.
    if (!mfaEnabled()) return issueSession(reply, principal);
    // MFA on: don't issue a session yet. Send a one-time code to the owner's
    // Telegram and require it (or a recovery code) at /api/auth/mfa. The code
    // never leaves the server except via Telegram, so a stolen password alone
    // can't complete the login.
    const { challengeId, code } = createChallenge(principal);
    if (config.telegramBotToken && config.telegramOwnerChatId) {
      try {
        await new TelegramClient(config.telegramBotToken).sendMessage(
          config.telegramOwnerChatId,
          `Skynet login code: ${code}\nExpires in 5 minutes. If this wasn't you, ignore it.`,
        );
      } catch (err) {
        req.log.warn(`[mfa] Telegram OTP send failed (use a recovery code): ${(err as Error).message}`);
      }
    } else {
      req.log.warn("[mfa] enabled but no Telegram configured — log in with a recovery code.");
    }
    return { mfaRequired: true, challengeId };
  });

  // Second factor: exchange a challenge + OTP (or a recovery code) for a session.
  app.post("/api/auth/mfa", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = MfaRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    const principal = verifyChallenge(body.data.challengeId, body.data.code);
    if (!principal) return reply.code(401).send({ error: "Invalid or expired code" });
    return issueSession(reply, principal);
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

/**
 * Service-token administration (MCP / programmatic access). All routes run
 * behind the workspace-auth hook and are restricted to full-authority principals
 * (human logins) — a scoped token cannot mint or manage tokens, so it can never
 * escalate its own privileges or those of its peers. Tokens are always scoped to
 * the caller's own workspace.
 */
export async function registerServiceTokenRoutes(
  app: FastifyInstance,
  deps: { serviceTokens: ServiceTokenStore },
): Promise<void> {
  const { serviceTokens } = deps;

  // Only a human operator (no scopes = full authority) may manage tokens.
  const requireHuman = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (req.principal!.scopes !== undefined) {
      reply.code(403).send({ error: "Service tokens can only be managed by an operator" });
      return false;
    }
    return true;
  };

  // Mint a token — the raw secret is returned ONCE here and never again.
  app.post("/api/service-tokens", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!requireHuman(req, reply)) return reply;
    const body = CreateServiceTokenRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    const created = await serviceTokens.create({
      workspaceId: req.principal!.workspaceId,
      operatorId: `token:${body.data.label}`, // attribution in the audit trail
      scopes: body.data.scopes,
      label: body.data.label,
      ttlMs: body.data.ttlMs ?? null,
    });
    // Return the secret token plus the metadata; callers must store it now.
    return reply.code(201).send({ token: created.token, id: created.id, scopes: body.data.scopes, label: created.label, expiresAt: created.expiresAt });
  });

  // List this workspace's tokens as non-secret metadata.
  app.get("/api/service-tokens", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!requireHuman(req, reply)) return reply;
    return serviceTokens.list(req.principal!.workspaceId);
  });

  // Revoke a token by id (scoped to the caller's workspace).
  app.delete<{ Params: { id: string } }>("/api/service-tokens/:id", async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    if (!requireHuman(req, reply)) return reply;
    const metas = await serviceTokens.list(req.principal!.workspaceId);
    if (!metas.some((m) => m.id === req.params.id)) return reply.code(404).send({ error: "Token not found" });
    await serviceTokens.revoke(req.params.id);
    return { ok: true };
  });
}
