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
import type { Operations } from "../operations.js";
import { mfaEnabled, createChallenge, verifyChallenge } from "./mfa.js";
import type { SessionStore } from "./sessions.js";
import type { ServiceTokenStore } from "./service-tokens.js";
import type { OperatorDirectory } from "./operators.js";
import type { ElevationLog } from "./elevation-log.js";

const LoginRequest = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
});

// Second-factor exchange: a login challenge id + the Telegram OTP (or a recovery code).
const MfaRequest = z.object({
  challengeId: z.string().min(1),
  code: z.string().min(1),
});

// Time-limited admin promotion: re-verify the CURRENT session's own password.
// ttlMs is a request, not a grant — the route clamps it to elevationMaxTtlMs.
const ElevateRequest = z.object({
  password: z.string().min(1),
  ttlMs: z.number().int().positive().optional(),
});

// Mirrors the Scope tuple in auth.ts. A minted token is narrowed to this subset.
const CreateServiceTokenRequest = z.object({
  label: z.string().min(1),
  scopes: z.array(z.enum(["observe", "author", "approver", "admin"])).min(1),
  // Confine the token to these projects (all must belong to the caller's
  // workspace). Omit / empty → workspace-wide, the historical default.
  projectIds: z.array(z.string()).optional(),
  ttlMs: z.number().int().positive().nullable().optional(),
});

export interface AuthRouteDeps {
  sessions: SessionStore;
  operators: OperatorDirectory;
  elevationLog: ElevationLog;
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
  const { sessions, operators, elevationLog } = deps;

  // Public — the one /api route reachable without an existing token.
  // Issue a session (httpOnly cookie + body token). Shared by the direct-login
  // (mfa: false) and the MFA second-factor (mfa: true) paths.
  //
  // MFA-verified sessions get the longer TTL (`sessionTtlMfaMs`, default 30d)
  // because the second factor already raised the security bar — re-doing MFA
  // every 12h is more friction than it buys. Password-only sessions keep the
  // shorter TTL (`sessionTtlMs`, default 12h).
  async function issueSession(reply: FastifyReply, principal: Principal, opts: { mfa: boolean }) {
    const ttl = opts.mfa ? config.sessionTtlMfaMs : config.sessionTtlMs;
    const session = await sessions.create(principal, ttl);
    setSessionCookie(reply, session.token, session.expiresAt);
    return { token: session.token, principal, expiresAt: session.expiresAt };
  }

  app.post("/api/auth/login", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = LoginRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    const principal = operators.verify(body.data.email, body.data.password);
    if (!principal) return reply.code(401).send({ error: "Invalid credentials" });
    // No MFA (or broken-glass via SKYNET_MFA_DISABLE): issue the session directly.
    if (!mfaEnabled()) return issueSession(reply, principal, { mfa: false });
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
    return issueSession(reply, principal, { mfa: true });
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

  // Time-limited admin promotion (ROADMAP.md) — self-service, sudo-style: the
  // caller re-proves they own THIS account (their own password, again) and, if
  // correct, their CURRENT session gets a bounded full-authority window.
  // Deliberately narrow: only elevates the session that's already authenticated
  // as this operator — there's no "promote someone else" path here.
  app.post("/api/auth/elevate", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = ElevateRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    const principal = req.principal!;
    const email = operators.findEmail(principal.workspaceId, principal.operatorId);
    if (!email) return reply.code(403).send({ error: "Elevation isn't available for this session." });
    const verified = operators.verify(email, body.data.password);
    // Re-verifying by email could in principle resolve a DIFFERENT operator
    // record than the one currently signed in (e.g. two accounts sharing an
    // email is a directory bug, not something to trust silently) — require an
    // exact identity match, not just "some password matched some record".
    if (!verified || verified.operatorId !== principal.operatorId || verified.workspaceId !== principal.workspaceId) {
      return reply.code(401).send({ error: "Incorrect password." });
    }
    const token = cookieToken(req.headers.cookie) ?? tokenFrom(req.headers.authorization, undefined);
    if (!token) return reply.code(401).send({ error: "No active session to elevate." });
    const ttlMs = Math.min(body.data.ttlMs ?? config.elevationTtlMs, config.elevationMaxTtlMs);
    const result = await sessions.elevate(token, ttlMs);
    if (!result) return reply.code(401).send({ error: "Session not found or expired." });
    await elevationLog.record({
      workspaceId: principal.workspaceId,
      operatorId: principal.operatorId,
      at: now(),
      expiresAt: result.expiresAt,
      ttlMs,
    });
    return { elevatedUntil: result.expiresAt };
  });

  // The elevation audit trail — append-only (no archive/delete route; see
  // elevation-log.ts). Any authenticated principal in the workspace may read
  // it, same visibility as GET /api/audit.
  app.get("/api/auth/elevations", async (req: FastifyRequest) => elevationLog.list(req.principal!.workspaceId));
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
  deps: { serviceTokens: ServiceTokenStore; operations: Pick<Operations, "listProjects"> },
): Promise<void> {
  const { serviceTokens, operations } = deps;

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
    const ws = req.principal!.workspaceId;
    // Validate the project allowlist up front so a typo can't mint a token that
    // silently sees/does nothing. Every id must be a real project in the caller's
    // own workspace (this also prevents scoping a token at another workspace's id).
    const projectIds = body.data.projectIds ?? [];
    if (projectIds.length > 0) {
      const owned = new Set((await operations.listProjects(ws)).map((p) => p.id));
      const unknown = projectIds.filter((id) => !owned.has(id));
      if (unknown.length > 0) {
        return reply.code(400).send({ error: `Unknown project(s) for this workspace: ${unknown.join(", ")}` });
      }
    }
    const created = await serviceTokens.create({
      workspaceId: ws,
      operatorId: `token:${body.data.label}`, // attribution in the audit trail
      scopes: body.data.scopes,
      label: body.data.label,
      projectIds,
      ttlMs: body.data.ttlMs ?? null,
    });
    // Return the secret token plus the metadata; callers must store it now.
    return reply.code(201).send({ token: created.token, id: created.id, scopes: body.data.scopes, projectIds, label: created.label, expiresAt: created.expiresAt });
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
