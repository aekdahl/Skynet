// The v3 "inbound-trigger" primitive: a GitHub `issues` webhook creates a task
// directly, instead of waiting on a manual "Import issues" click. Two layers:
// Operations.handleGithubIssueEvent (domain logic + dedup + opt-in gate) and
// the route (HMAC signature verification, event filtering) at the real
// Fastify app — mirrors resync-source.test.ts / crystallize-brief-routes.test.ts.
import { createHmac } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { Project } from "@skynet/shared";
import { config } from "../apps/server/src/config.js";
import { registerGithubWebhookRoutes } from "../apps/server/src/github/webhook.js";
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
    status: "active", repoPath: null, gitBacked: false, repo: "acme/app", syncSourceStatus: true,
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

const ISSUE_PAYLOAD = (action: string, over: Record<string, unknown> = {}) => ({
  action,
  repository: { full_name: "acme/app" },
  issue: { number: 7, title: "Fix login redirect", body: "It loops.", html_url: "https://x/7" },
  ...over,
});

describe("Operations.handleGithubIssueEvent", () => {
  it("creates a task for an opened issue on an opted-in project", async () => {
    const { store, ops } = await setup();
    const res = await ops.handleGithubIssueEvent({
      action: "opened",
      repo: "acme/app",
      issue: { number: 7, title: "Fix login redirect", body: "It loops.", url: "https://x/7" },
    });
    expect(res).toEqual({ created: 1 });
    const tasks = await store.listTasks(DEFAULT_WORKSPACE);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ text: "Fix login redirect", description: "It loops.", source: { kind: "github_issue", repo: "acme/app", number: 7 } });
  });

  it("is idempotent — a redelivered/labeled event doesn't duplicate the task", async () => {
    const { store, ops } = await setup();
    await ops.createTask(DEFAULT_WORKSPACE, "p1", { text: "Fix login redirect", source: { kind: "github_issue", repo: "acme/app", number: 7, url: "https://x/7" } });
    const res = await ops.handleGithubIssueEvent({
      action: "labeled",
      repo: "acme/app",
      issue: { number: 7, title: "Fix login redirect", body: null, url: "https://x/7" },
    });
    expect(res).toEqual({ created: 0 });
    expect(await store.listTasks(DEFAULT_WORKSPACE)).toHaveLength(1);
  });

  it("ignores a project that hasn't opted in (syncSourceStatus off)", async () => {
    const { store, ops } = await setup({ syncSourceStatus: false });
    const res = await ops.handleGithubIssueEvent({
      action: "opened",
      repo: "acme/app",
      issue: { number: 7, title: "X", body: null, url: "https://x/7" },
    });
    expect(res).toEqual({ created: 0 });
    expect(await store.listTasks(DEFAULT_WORKSPACE)).toHaveLength(0);
  });

  it("ignores a repo with no matching project", async () => {
    const { store, ops } = await setup();
    const res = await ops.handleGithubIssueEvent({
      action: "opened",
      repo: "someone/else",
      issue: { number: 1, title: "X", body: null, url: "https://x/1" },
    });
    expect(res).toEqual({ created: 0 });
    expect(await store.listTasks(DEFAULT_WORKSPACE)).toHaveLength(0);
  });

  it("ignores an event action it doesn't act on (e.g. closed)", async () => {
    const { store, ops } = await setup();
    const res = await ops.handleGithubIssueEvent({
      action: "closed",
      repo: "acme/app",
      issue: { number: 7, title: "X", body: null, url: "https://x/7" },
    });
    expect(res).toEqual({ created: 0 });
    expect(await store.listTasks(DEFAULT_WORKSPACE)).toHaveLength(0);
  });
});

describe("POST /webhooks/github", () => {
  let app: FastifyInstance;
  let ops: Operations;
  const ORIG_SECRET = config.githubWebhookSecret;
  const SECRET = "test-webhook-secret";

  const sign = (body: string) => `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

  beforeEach(async () => {
    config.githubWebhookSecret = SECRET;
    const built = await setup();
    ops = built.ops;
    app = Fastify();
    await registerGithubWebhookRoutes(app, { operations: ops });
    await app.ready();
  });

  afterEach(async () => {
    config.githubWebhookSecret = ORIG_SECRET;
    await app.close();
  });

  it("404s when the feature isn't configured (no secret)", async () => {
    config.githubWebhookSecret = undefined;
    const res = await app.inject({ method: "POST", url: "/webhooks/github", headers: { "content-type": "application/json" }, payload: "{}" });
    expect(res.statusCode).toBe(404);
  });

  it("401s on a missing or bad signature", async () => {
    const body = JSON.stringify(ISSUE_PAYLOAD("opened"));
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: { "content-type": "application/json", "x-github-event": "issues", "x-hub-signature-256": "sha256=deadbeef" },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
  });

  it("creates a task from a validly-signed `issues opened` event", async () => {
    const body = JSON.stringify(ISSUE_PAYLOAD("opened"));
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: { "content-type": "application/json", "x-github-event": "issues", "x-hub-signature-256": sign(body) },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ created: 1 });
  });

  it("202s (ignored) for a non-issues event even with a valid signature", async () => {
    const body = JSON.stringify({ ref: "refs/heads/main" });
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: { "content-type": "application/json", "x-github-event": "push", "x-hub-signature-256": sign(body) },
      payload: body,
    });
    expect(res.statusCode).toBe(202);
  });
});
