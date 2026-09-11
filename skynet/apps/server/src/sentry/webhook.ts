// ─── Sentry inbound webhook ────────────────────────────────────────────────
// The v3 "inbound-trigger" primitive's Sentry instance (ROADMAP.md "Tools via
// MCP") — a new/regressed Sentry issue turns straight into a Skynet task,
// mirroring apps/server/src/github/webhook.ts's own `issues` event exactly:
// same raw-body HMAC-verification shape, same "mounted outside /api because
// the signature IS the auth" reasoning, same "never hard-fail — a webhook
// provider can disable the hook after enough non-2xx responses" contract.
//
// Sentry signs a workspace-level webhook (from an Internal Integration) with
// an HMAC-SHA256 hex digest of the raw body, under the `sentry-hook-signature`
// header, using the integration's client secret (SENTRY_WEBHOOK_SECRET here —
// a single global secret, same posture as GITHUB_WEBHOOK_SECRET: this
// codebase's webhook story is single-tenant-per-deploy, not per-workspace).
// The event kind rides `sentry-hook-resource` ("issue", "installation", …).
//
// VERIFICATION NOTE: the header names and the `data.issue.*` payload shape
// below are Sentry's documented Internal Integration convention, but were NOT
// captured against a live payload in this environment (no network egress) —
// before relying on this in production, send one real test event from a
// Sentry test integration and confirm the exact field paths, adjusting
// `parseSentryWebhook` if they differ. `extractOrgSlug`'s permalink-parsing
// fallback exists specifically because the org slug's exact nesting has
// shifted across Sentry API versions in the past — the permalink URL's
// `/organizations/<org-slug>/issues/` segment is the more stable anchor.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";
import type { Operations } from "../operations.js";

function verifySentrySignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(rawBody).digest("hex"), "utf8");
  const given = Buffer.from(header, "utf8");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** What a parsed Sentry issue webhook resolves to — handed straight to
 *  Operations.handleSentryIssueEvent for project resolution + task creation. */
export interface SentryIssueSignal {
  org: string;
  project: string;
  issueId: string;
  shortId: string;
  title: string;
  culprit: string;
  url: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";

/** A Sentry issue's org slug isn't consistently nested in the same place
 *  across API/payload versions — fall back to parsing it out of the
 *  permalink, whose `/organizations/<org>/issues/` segment has been stable. */
function extractOrgSlug(issue: Record<string, unknown>, permalink: string): string | undefined {
  const project = isRecord(issue.project) ? issue.project : undefined;
  const org = project && isRecord(project.organization) ? project.organization : undefined;
  if (typeof org?.slug === "string" && org.slug) return org.slug;
  const m = permalink.match(/\/organizations\/([^/]+)\//);
  return m?.[1];
}

/**
 * Pure — parse a raw Sentry `issue` webhook body into a SentryIssueSignal, or
 * null for anything not actionable (wrong resource, an action this doesn't
 * act on, or a payload missing a field it needs). No store/bus access —
 * unit-testable standalone, same discipline as github/webhook.ts's
 * parseGithubSignal.
 */
export function parseSentryWebhook(resource: string | undefined, payload: unknown): SentryIssueSignal | null {
  if (resource !== "issue" && resource !== "error") return null;
  if (!isRecord(payload)) return null;
  const action = typeof payload.action === "string" ? payload.action : undefined;
  // "created" = a brand-new issue; "resolved"/"assigned"/etc. aren't triggers.
  if (action !== "created") return null;
  const data = isRecord(payload.data) ? payload.data : undefined;
  const issue = data && isRecord(data.issue) ? data.issue : undefined;
  if (!issue) return null;
  const issueId = typeof issue.id === "string" ? issue.id : typeof issue.id === "number" ? String(issue.id) : undefined;
  const project = isRecord(issue.project) ? issue.project : undefined;
  const projectSlug = typeof project?.slug === "string" ? project.slug : undefined;
  const permalink = typeof issue.permalink === "string" ? issue.permalink : "";
  const org = extractOrgSlug(issue, permalink);
  if (!issueId || !projectSlug || !org) return null;
  const title = typeof issue.title === "string" ? issue.title : "Untitled Sentry issue";
  return {
    org,
    project: projectSlug,
    issueId,
    shortId: typeof issue.shortId === "string" ? issue.shortId : "",
    title,
    culprit: typeof issue.culprit === "string" ? issue.culprit : "",
    url: permalink,
  };
}

export async function registerSentryWebhookRoutes(app: FastifyInstance, deps: { operations: Operations }): Promise<void> {
  await app.register(async (scoped) => {
    scoped.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

    scoped.post("/webhooks/sentry", async (req: FastifyRequest, reply: FastifyReply) => {
      // Unset secret = the feature isn't configured for this deploy — 404
      // rather than 401 so the endpoint's mere existence isn't advertised.
      if (!config.sentryWebhookSecret) return reply.code(404).send({ error: "Not found" });
      const raw = req.body as Buffer | undefined;
      const signature = req.headers["sentry-hook-signature"] as string | undefined;
      if (!Buffer.isBuffer(raw) || !verifySentrySignature(config.sentryWebhookSecret, raw, signature)) {
        return reply.code(401).send({ error: "Bad signature" });
      }
      // Ack (2xx) anything we don't act on — Sentry disables a webhook after
      // enough non-2xx responses, and most resource/action combinations
      // (installation, comment, resolved, …) are legitimately out of scope.
      const resource = req.headers["sentry-hook-resource"] as string | undefined;
      let payload: unknown;
      try {
        payload = JSON.parse(raw.toString("utf8"));
      } catch {
        return reply.code(400).send({ error: "Bad JSON" });
      }
      const signal = parseSentryWebhook(resource, payload);
      if (!signal) return reply.code(202).send({ ignored: true });
      const { created } = await deps.operations.handleSentryIssueEvent(signal);
      return reply.code(200).send({ created });
    });
  });
}
