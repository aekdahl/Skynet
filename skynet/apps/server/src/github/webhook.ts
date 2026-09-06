// ─── GitHub inbound webhook ────────────────────────────────────────────────
// The v3 "inbound-trigger" primitive (ROADMAP.md) — a webhook creates a task,
// instead of the operator having to click "Import issues" or wait for a
// re-sync. Its first concrete instance: an `issues` event (opened/reopened/
// labeled) turns straight into a Skynet task via Operations.handleGithubIssueEvent.
//
// Momentum Rollout, phase 1a additionally parses pull_request/
// pull_request_review/check_run/deployment_status into a `GithubSignal`
// (parseGithubSignal, pure/testable), resolves it to a task via
// Operations.publishGithubSignal, and publishes it on that task's workspace
// bus (`github.signal`). This phase does NOT write a Transition — that's the
// rule engine's job, subscribing to the signal downstream.
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
import type { GithubSignalKind, GithubSignalPayload } from "@skynet/shared";
import { config } from "../config.js";
import type { Operations } from "../operations.js";
import { ROADMAP_PATHS } from "../steward/docs.js";

function verifySignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(rawBody).digest("hex"), "utf8");
  const given = Buffer.from(header.slice("sha256=".length), "utf8");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** What a parsed PR/review/check/deploy webhook resolves to — handed straight
 *  to Operations.publishGithubSignal for task resolution + bus publish. */
export interface GithubSignal {
  repo: string;
  kind: GithubSignalKind;
  payload: GithubSignalPayload;
  prNumber?: number;
  branch?: string;
}

const GITHUB_SIGNAL_EVENTS = new Set(["pull_request", "pull_request_review", "check_run", "deployment_status"]);

/**
 * Momentum Rollout, phase 1a: turn a raw PR/review/check/deploy webhook body
 * into a `GithubSignal`, or `null` for anything this phase doesn't act on
 * (an action outside the set below, or a payload missing a field it needs).
 * Pure — no store/bus access — so it's unit-testable without a running app,
 * same discipline as every other consult/webhook parser in this codebase.
 *
 * `action` alone is ambiguous for `pull_request`'s "closed" (merged vs.
 * abandoned) — collapsed into a distinct GithubSignalKind here, once, rather
 * than making every downstream consumer re-derive it from `pull_request.merged`.
 */
export function parseGithubSignal(event: string, payload: unknown): GithubSignal | null {
  if (!GITHUB_SIGNAL_EVENTS.has(event) || typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const repo = (p.repository as { full_name?: string } | undefined)?.full_name;
  if (!repo) return null;
  const action = typeof p.action === "string" ? p.action : undefined;

  if (event === "pull_request") {
    const pr = p.pull_request as { number?: number; merged?: boolean; html_url?: string; head?: { ref?: string } } | undefined;
    if (!pr?.number) return null;
    const payloadOut: GithubSignalPayload = { prNumber: pr.number, prUrl: pr.html_url ?? "", branch: pr.head?.ref ?? "" };
    if (action === "opened") return { repo, prNumber: pr.number, kind: "pr_opened", payload: payloadOut };
    if (action === "ready_for_review") return { repo, prNumber: pr.number, kind: "pr_ready_for_review", payload: payloadOut };
    if (action === "closed") return { repo, prNumber: pr.number, kind: pr.merged ? "pr_merged" : "pr_closed", payload: payloadOut };
    return null;
  }

  if (event === "pull_request_review") {
    if (action !== "submitted") return null;
    const pr = p.pull_request as { number?: number; html_url?: string } | undefined;
    const review = p.review as { state?: string; body?: string } | undefined;
    if (!pr?.number || !review?.state) return null;
    const kind: GithubSignalKind | null =
      review.state === "approved" ? "review_approved" : review.state === "changes_requested" ? "review_changes_requested" : null;
    if (!kind) return null;
    return {
      repo,
      prNumber: pr.number,
      kind,
      payload: { prNumber: pr.number, prUrl: pr.html_url ?? "", reviewState: review.state, reviewBody: review.body ?? "" },
    };
  }

  if (event === "check_run") {
    if (action !== "completed") return null;
    const checkRun = p.check_run as
      | { name?: string; conclusion?: string; head_sha?: string; pull_requests?: Array<{ number?: number }> }
      | undefined;
    if (!checkRun?.conclusion) return null;
    // Only checks linked to a PR resolve today — a check on a plain branch
    // push with no open PR has nothing to match a task's TaskRun.pr against.
    const prNumber = checkRun.pull_requests?.[0]?.number;
    if (!prNumber) return null;
    const kind: GithubSignalKind | null =
      checkRun.conclusion === "success" ? "check_succeeded" : checkRun.conclusion === "failure" ? "check_failed" : null;
    if (!kind) return null;
    return {
      repo,
      prNumber,
      kind,
      payload: { prNumber, checkName: checkRun.name ?? "", sha: checkRun.head_sha ?? "", conclusion: checkRun.conclusion },
    };
  }

  if (event === "deployment_status") {
    const status = p.deployment_status as { state?: string } | undefined;
    const deployment = p.deployment as { ref?: string; environment?: string } | undefined;
    if (!status?.state || !deployment?.ref) return null;
    const kind: GithubSignalKind | null =
      status.state === "success" ? "deploy_succeeded" : status.state === "failure" ? "deploy_failed" : null;
    if (!kind) return null;
    return { repo, branch: deployment.ref, kind, payload: { environment: deployment.environment ?? "", state: status.state } };
  }

  return null;
}

/** What a `push` event resolves to, if it's worth acting on at all — a real
 *  repo + a new HEAD + at least one file genuinely touched by the push
 *  (across every commit in it, not just the last one — a force-push or a
 *  multi-commit push can touch ROADMAP.md in an earlier commit only). */
export interface RoadmapPush {
  repo: string;
  commitSha: string;
  touchedPaths: Set<string>;
}

/**
 * Phase 24 (TASK 27) — parse a raw `push` webhook body into `{repo, commitSha,
 * touchedPaths}`, or `null` for anything this can't act on (missing repo/
 * after/commits, a payload that doesn't shape up). Pure — no store/bus
 * access — same discipline as `parseGithubSignal` above. `touchedPaths` is
 * everything added/removed/modified across EVERY commit in the push, not
 * just `head_commit`, so a roadmap edit buried mid-push (not the latest
 * commit) still triggers a resync.
 */
export function parseGithubPush(payload: unknown): RoadmapPush | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const repo = (p.repository as { full_name?: string } | undefined)?.full_name;
  const commitSha = typeof p.after === "string" ? p.after : undefined;
  const commits = p.commits;
  if (!repo || !commitSha || !Array.isArray(commits)) return null;

  const touchedPaths = new Set<string>();
  for (const c of commits as Array<{ added?: unknown; removed?: unknown; modified?: unknown }>) {
    for (const arr of [c.added, c.removed, c.modified]) {
      if (!Array.isArray(arr)) continue;
      for (const path of arr) if (typeof path === "string") touchedPaths.add(path);
    }
  }
  return { repo, commitSha, touchedPaths };
}

/** Whether `touchedPaths` includes the path THIS project's roadmap actually
 *  resolves to — its explicit `roadmapPath` override when set (tried
 *  EXCLUSIVELY, matching resolveRoadmapDoc's own "an override that's gone
 *  missing reads as not-found, not a silent fall-back elsewhere" contract),
 *  else any of the default `ROADMAP_PATHS` candidates. */
export function pushTouchesProjectRoadmap(touchedPaths: Set<string>, roadmapPathOverride: string | null): boolean {
  if (roadmapPathOverride) return touchedPaths.has(roadmapPathOverride);
  return ROADMAP_PATHS.some((p) => touchedPaths.has(p));
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
      // enough non-2xx responses, and most event types (push, …) are
      // legitimately out of scope here.
      const event = req.headers["x-github-event"] as string | undefined;

      if (event === "issues") {
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
      }

      // Momentum Rollout, phase 1a: pull_request / pull_request_review /
      // check_run / deployment_status — parse, resolve to a task, publish onto
      // the bus. A signal that can't be resolved (unparseable payload, or no
      // task/run matches) is a silent 202, same "never error a webhook GitHub
      // might disable" contract as the issues path above.
      if (event && GITHUB_SIGNAL_EVENTS.has(event)) {
        let payload: unknown;
        try {
          payload = JSON.parse(raw.toString("utf8"));
        } catch {
          return reply.code(400).send({ error: "Bad JSON" });
        }
        const signal = parseGithubSignal(event, payload);
        if (!signal) return reply.code(202).send({ ignored: true });
        const { published } = await deps.operations.publishGithubSignal(signal);
        // A signal that parsed fine but couldn't be resolved to a known task
        // (no run has this PR/branch) is ALSO a 202, same as an unparseable
        // one — never a hard failure GitHub could count against the hook.
        if (!published) return reply.code(202).send({ ignored: true });
        return reply.code(200).send({ published: true });
      }

      // Phase 24 (TASK 27) — a push touching a bound project's roadmap doc
      // triggers a re-parse. Same "never error a webhook GitHub might
      // disable" contract as every other event here: an unparseable payload
      // or a push that doesn't touch any project's roadmap is a silent 202.
      if (event === "push") {
        let payload: unknown;
        try {
          payload = JSON.parse(raw.toString("utf8"));
        } catch {
          return reply.code(400).send({ error: "Bad JSON" });
        }
        const push = parseGithubPush(payload);
        if (!push) return reply.code(202).send({ ignored: true });
        const { syncedProjectIds } = await deps.operations.handleGithubRoadmapPush(push);
        if (syncedProjectIds.length === 0) return reply.code(202).send({ ignored: true });
        return reply.code(200).send({ syncedProjectIds });
      }

      return reply.code(202).send({ ignored: true });
    });
  });
}
