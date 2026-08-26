// ─── GitHub inbound webhook ────────────────────────────────────────────────
// The v3 "inbound-trigger" primitive (ROADMAP.md) — a webhook creates a task,
// instead of the operator having to click "Import issues" or wait for a
// re-sync. This is its first concrete instance: an `issues` event
// (opened/reopened/labeled) turns straight into a Skynet task via
// Operations.handleGithubIssueEvent.
//
// Deliberately mounted OUTSIDE /api: auth-guard.ts only gates /api + /mcp with
// a bearer-token principal, and GitHub can't carry one — the HMAC signature
// (GITHUB_WEBHOOK_SECRET, shared by the whole App, same secret docs/
// github-integration.md's "Webhook events" list is verified against) IS the
// auth here. Verification needs the exact raw bytes GitHub signed, so this
// route gets its own content-type parser that keeps the raw buffer instead of
// fastify's default parsed-JSON body — scoped to an encapsulated plugin so no
// other route's body parsing changes.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";
import type { Operations } from "../operations.js";

function verifySignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(rawBody).digest("hex"), "utf8");
  const given = Buffer.from(header.slice("sha256=".length), "utf8");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export async function registerGithubWebhookRoutes(app: FastifyInstance, deps: { operations: Operations }): Promise<void> {
  await app.register(async (scoped) => {
    scoped.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

    scoped.post("/webhooks/github", async (req: FastifyRequest, reply: FastifyReply) => {
      // Unset secret = the feature isn't configured for this deploy — 404
      // rather than 401 so the endpoint's mere existence isn't advertised.
      if (!config.githubWebhookSecret) return reply.code(404).send({ error: "Not found" });
      const raw = req.body as Buffer | undefined;
      const signature = req.headers["x-hub-signature-256"] as string | undefined;
      if (!Buffer.isBuffer(raw) || !verifySignature(config.githubWebhookSecret, raw, signature)) {
        return reply.code(401).send({ error: "Bad signature" });
      }
      // Ack (2xx) anything we don't act on — GitHub disables a webhook after
      // enough non-2xx responses, and most event types (push, check_run, …)
      // are legitimately out of scope for this first instance.
      const event = req.headers["x-github-event"] as string | undefined;
      if (event !== "issues") return reply.code(202).send({ ignored: true });
      let payload: { action?: string; repository?: { full_name?: string }; issue?: { number?: number; title?: string; body?: string | null; html_url?: string } };
      try {
        payload = JSON.parse(raw.toString("utf8"));
      } catch {
        return reply.code(400).send({ error: "Bad JSON" });
      }
      const repo = payload.repository?.full_name;
      const issue = payload.issue;
      if (!repo || !issue?.number || !issue?.title || !payload.action) return reply.code(202).send({ ignored: true });
      const { created } = await deps.operations.handleGithubIssueEvent({
        action: payload.action,
        repo,
        issue: { number: issue.number, title: issue.title, body: issue.body ?? null, url: issue.html_url ?? "" },
      });
      return reply.code(200).send({ created });
    });
  });
}
