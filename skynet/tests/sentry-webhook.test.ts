// The v3 "inbound-trigger" primitive's Sentry instance: an `issue` webhook
// creates a task directly, mirroring tests/github-webhook.test.ts's own
// structure exactly (Operations.handleSentryIssueEvent's domain logic + the
// real Fastify route's signature verification).
import { createHmac } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { Project } from "@skynet/shared";
import { config } from "../apps/server/src/config.js";
import { registerSentryWebhookRoutes, parseSentryWebhook } from "../apps/server/src/sentry/webhook.js";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { Operations } from "../apps/server/src/operations.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerProvider } from "@skynet/runner-sdk";

class NullBus implements Bus {
  publish(): void {}
  subscribe(): () => void {
    return () => {};
  }
}
const provider = {} as RunnerProvider;

const mk = (over: Partial<Project> = {}): Project =>
  ({
    id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [],
    status: "active", repoPath: null, gitBacked: false,
    sentryProject: { org: "acme", project: "web" },
    ...over,
  }) as Project;

async function setup(projectOver: Partial<Project> = {}) {
  const store = new MemoryStore({ seed: false });
  const hub = new Hub(store, new NullBus());
  const orch = new Orchestrator(store, hub, provider);
  const ops = new Operations({ store, hub, orchestrator: orch });
  await store.putProject(mk(projectOver));
  return { store, ops };
}

const ISSUE_PAYLOAD = (over: Record<string, unknown> = {}) => ({
  action: "created",
  data: {
    issue: {
      id: "123456",
      shortId: "WEB-1",
      title: "TypeError: Cannot read properties of undefined",
      culprit: "handleClick(app/checkout.tsx)",
      permalink: "https://acme.sentry.io/organizations/acme/issues/123456/",
      project: { slug: "web" },
    },
  },
  ...over,
});

describe("parseSentryWebhook", () => {
  it("parses a valid issue.created payload into a signal", () => {
    const signal = parseSentryWebhook("issue", ISSUE_PAYLOAD());
    expect(signal).toEqual({
      org: "acme",
      project: "web",
      issueId: "123456",
      shortId: "WEB-1",
      title: "TypeError: Cannot read properties of undefined",
      culprit: "handleClick(app/checkout.tsx)",
      url: "https://acme.sentry.io/organizations/acme/issues/123456/",
    });
  });

  it("returns null for a resource this doesn't act on (e.g. installation)", () => {
    expect(parseSentryWebhook("installation", ISSUE_PAYLOAD())).toBeNull();
  });

  it("returns null for an action other than 'created' (e.g. resolved)", () => {
    expect(parseSentryWebhook("issue", ISSUE_PAYLOAD({ action: "resolved" }))).toBeNull();
  });

  it("returns null when the payload is missing required fields", () => {
    expect(parseSentryWebhook("issue", { action: "created", data: { issue: {} } })).toBeNull();
  });

  it("falls back to parsing the org slug out of the permalink when it's not nested under project.organization", () => {
    const signal = parseSentryWebhook("issue", ISSUE_PAYLOAD());
    expect(signal?.org).toBe("acme");
  });
});

describe("Operations.handleSentryIssueEvent", () => {
  it("creates a task for a new issue on a bound project", async () => {
    const { store, ops } = await setup();
    const res = await ops.handleSentryIssueEvent({
      org: "acme", project: "web", issueId: "123456", shortId: "WEB-1",
      title: "TypeError: Cannot read properties of undefined", culprit: "handleClick(app/checkout.tsx)",
      url: "https://acme.sentry.io/organizations/acme/issues/123456/",
    });
    expect(res).toEqual({ created: 1 });
    const tasks = await store.listTasks(DEFAULT_WORKSPACE);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      text: "TypeError: Cannot read properties of undefined",
      description: "handleClick(app/checkout.tsx)",
      source: { kind: "sentry_issue", org: "acme", project: "web", issueId: "123456" },
    });
  });

  it("is idempotent — a redelivered webhook for the same issue doesn't duplicate the task", async () => {
    const { store, ops } = await setup();
    const signal = { org: "acme", project: "web", issueId: "123456", shortId: "WEB-1", title: "X", culprit: "", url: "" };
    await ops.handleSentryIssueEvent(signal);
    const res = await ops.handleSentryIssueEvent(signal);
    expect(res).toEqual({ created: 0 });
    expect(await store.listTasks(DEFAULT_WORKSPACE)).toHaveLength(1);
  });

  it("ignores a project with no Sentry binding", async () => {
    const { store, ops } = await setup({ sentryProject: null });
    const res = await ops.handleSentryIssueEvent({ org: "acme", project: "web", issueId: "1", shortId: "", title: "X", culprit: "", url: "" });
    expect(res).toEqual({ created: 0 });
    expect(await store.listTasks(DEFAULT_WORKSPACE)).toHaveLength(0);
  });

  it("ignores an org/project slug with no matching binding", async () => {
    const { store, ops } = await setup();
    const res = await ops.handleSentryIssueEvent({ org: "someone-else", project: "web", issueId: "1", shortId: "", title: "X", culprit: "", url: "" });
    expect(res).toEqual({ created: 0 });
    expect(await store.listTasks(DEFAULT_WORKSPACE)).toHaveLength(0);
  });
});

describe("POST /webhooks/sentry", () => {
  let app: FastifyInstance;
  let ops: Operations;
  const ORIG_SECRET = config.sentryWebhookSecret;
  const SECRET = "test-sentry-secret";

  const sign = (body: string) => createHmac("sha256", SECRET).update(body).digest("hex");

  beforeEach(async () => {
    config.sentryWebhookSecret = SECRET;
    const built = await setup();
    ops = built.ops;
    app = Fastify();
    await registerSentryWebhookRoutes(app, { operations: ops });
    await app.ready();
  });

  afterEach(async () => {
    config.sentryWebhookSecret = ORIG_SECRET;
    await app.close();
  });

  it("404s when the feature isn't configured (no secret)", async () => {
    config.sentryWebhookSecret = undefined;
    const res = await app.inject({ method: "POST", url: "/webhooks/sentry", headers: { "content-type": "application/json" }, payload: "{}" });
    expect(res.statusCode).toBe(404);
  });

  it("401s on a missing or bad signature", async () => {
    const body = JSON.stringify(ISSUE_PAYLOAD());
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/sentry",
      headers: { "content-type": "application/json", "sentry-hook-resource": "issue", "sentry-hook-signature": "deadbeef" },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
  });

  it("creates a task from a validly-signed issue.created event", async () => {
    const body = JSON.stringify(ISSUE_PAYLOAD());
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/sentry",
      headers: { "content-type": "application/json", "sentry-hook-resource": "issue", "sentry-hook-signature": sign(body) },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ created: 1 });
  });

  it("202s (ignored) for a non-issue resource even with a valid signature", async () => {
    const body = JSON.stringify({ action: "created" });
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/sentry",
      headers: { "content-type": "application/json", "sentry-hook-resource": "installation", "sentry-hook-signature": sign(body) },
      payload: body,
    });
    expect(res.statusCode).toBe(202);
  });
});
