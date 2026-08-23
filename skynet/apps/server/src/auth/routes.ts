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
import type { OperatorDirectory, OperatorRecord } from "./operators.js";
import type { ElevationStore } from "./elevations.js";

const LoginRequest = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
});

// Second-factor exchange: a login challenge id + the Telegram OTP (or a recovery code).
const MfaRequest = z.object({
  challengeId: z.string().min(1),
  code: z.string().min(1),
});

// Time-limited admin promotion, ADMIN-granted: ttlMs is a request, not a
// grant — the route clamps it to elevationMaxTtlMs.
const PromoteRequest = z.object({
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
  elevations: ElevationStore;
  operations: Pick<Operations, "getWorkspaceSettings">;
}

/** A minimal, non-secret view of an operator record for the promotion UI —
 *  never leaks salt/hash. */
function operatorSummary(r: OperatorRecord): { operatorId: string; email: string; role: OperatorRecord["role"] } {
  return { operatorId: r.operatorId, email: r.email, role: r.role };
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
  const { sessions, operators, elevations, operations } = deps;

  // Never trust a live Principal's CURRENT scopes for an admin-only check —
  // a temporarily-elevated viewer's scopes look identical to a real admin's
  // (scopes: undefined, same as hasScope() sees for a genuine admin). Look up
  // the caller's PERSISTED role in the directory instead; this is the one
  // check that actually closes the "elevated viewer re-grants/self-extends"
  // loophole. Returns the caller's own record on success (reply already sent
  // on failure) so callers don't re-look-it-up.
  function requireAdmin(req: FastifyRequest, reply: FastifyReply): OperatorRecord | undefined {
    const principal = req.principal!;
    const record = operators.getByIdentity(principal.workspaceId, principal.operatorId);
    if (!record || record.role !== "admin") {
      reply.code(403).send({ error: "Only an admin may do this." });
      return undefined;
    }
    return record;
  }

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
    // Required either server-wide (SKYNET_MFA=true) or by this operator's own
    // workspace's live Settings toggle — see mfa.ts's mfaEnabled doc. Broken-
    // glass (SKYNET_MFA_DISABLE) always wins over both, checked inside it.
    const { requireLoginVerification } = await operations.getWorkspaceSettings(principal.workspaceId);
    if (!mfaEnabled(requireLoginVerification)) return issueSession(reply, principal, { mfa: false });
    // MFA on: don't issue a session yet. Send a one-time code to the owner's
    // Telegram and require it (or a recovery code) at /api/auth/mfa. The code
    // never leaves the server except via Telegram, so a stolen password alone
    // can't complete the login.
    //
    // `reused` means an earlier attempt (retried form submit, a double click,
    // a script hitting this endpoint more than once) already has a live,
    // unexpired code out for this exact operator — reuse it silently rather
    // than minting + Telegram-sending another. Without this, a handful of
    // repeated login attempts in a short window used to flood Telegram with
    // one fresh code apiece, all racing each other before any single one got
    // used.
    const { challengeId, code, reused } = createChallenge(principal);
    if (reused) return { mfaRequired: true, challengeId };
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

  // This workspace's operator roster, as a non-secret summary — lets the
  // admin-promotion UI list who's a viewer (and thus promotable) without any
  // general account-management surface. Admin-only: a viewer doesn't need
  // (and per DEF-006-style discipline, shouldn't casually see) the full list
  // of other operators' emails in the workspace.
  app.get("/api/operators", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdmin(req, reply)) return reply;
    return operators.listByWorkspace(req.principal!.workspaceId).map(operatorSummary);
  });

  // Time-limited admin promotion (ROADMAP.md) — ADMIN-granted, never
  // self-service: an existing admin promotes a NAMED viewer to a bounded
  // full-authority window. requireAdmin checks the CALLER's persisted role
  // (not their current scopes — see its own comment for why that distinction
  // is load-bearing, not stylistic).
  app.post<{ Params: { operatorId: string } }>("/api/operators/:operatorId/promote", async (req, reply) => {
    const admin = requireAdmin(req, reply);
    if (!admin) return reply;
    const body = PromoteRequest.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    const target = operators.getByIdentity(admin.workspaceId, req.params.operatorId);
    if (!target) return reply.code(404).send({ error: "Unknown operator." });
    if (target.role !== "viewer") {
      return reply.code(400).send({ error: "Only a viewer can be promoted (this operator is already an admin)." });
    }
    const ttlMs = Math.min(body.data.ttlMs ?? config.elevationTtlMs, config.elevationMaxTtlMs);
    const result = await elevations.grant(admin.workspaceId, target.operatorId, admin.operatorId, ttlMs);
    return { operatorId: target.operatorId, expiresAt: result.expiresAt };
  });

  // The elevation audit trail (grants AND observed expiries — see
  // elevations.ts) — append-only (no archive/delete route). Any authenticated
  // principal in the workspace may read it, same visibility as GET /api/audit.
  app.get("/api/auth/elevations", async (req: FastifyRequest) => elevations.list(req.principal!.workspaceId));
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
