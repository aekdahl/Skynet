// Momentum Rollout, phase 1a: pull_request / pull_request_review / check_run /
// deployment_status webhooks parse into a GithubSignal, resolve to the task
// behind the PR/branch, and publish `github.signal` onto that task's
// workspace bus. Modeled on github-webhook.test.ts (issues): a pure-parser
// layer (parseGithubSignal) + Operations.publishGithubSignal, then the real
// Fastify route end-to-end with a valid HMAC signature — payload shapes below
// are minimal but structurally accurate to GitHub's own documented webhook
// fields (action, repository.full_name, pull_request.{number,merged,head.ref},
// review.state, check_run.{conclusion,pull_requests[].number}, deployment.ref,
// deployment_status.state).
import { createHmac } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { Project, ServerEvent, Task, TaskRun } from "@skynet/shared";
import { config } from "../apps/server/src/config.js";
import { parseGithubSignal, registerGithubWebhookRoutes } from "../apps/server/src/github/webhook.js";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { Operations } from "../apps/server/src/operations.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerProvider } from "@skynet/runner-sdk";

class RecordingBus implements Bus {
  events: ServerEvent[] = [];
  publish(_ws: string, event: ServerEvent): void {
    this.events.push(event);
  }
  subscribe(): () => void {
    return () => {};
  }
}
const provider = {} as RunnerProvider;

const project: Project = {
  id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [],
  status: "active", repoPath: null, gitBacked: false, repo: "acme/app", syncSourceStatus: true,
} as Project;

const mkRun = (over: Partial<TaskRun> = {}): TaskRun => ({
  id: "r1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", name: "do X", status: "review",
  agentId: null, provider: "claude", credentialId: null, model: "opus-4.8", branch: "agent/r1",
  modules: [], progress: 1, plan: [], usage: null, modifiedFiles: [], log: [], startedAt: 0,
  lastHeartbeatAt: 0, visual: false, previewUrl: null, dependsOn: [], parentId: null,
  branchFromStep: null, archived: false, pr: null, ...over,
});
const mkTask = (over: Partial<Task> = {}): Task => ({
  id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "do X", state: "review", runId: "r1",
  ...over,
} as Task);

async function setup() {
  const store = new MemoryStore({ seed: false });
  const bus = new RecordingBus();
  const hub = new Hub(store, bus);
  const orch = new Orchestrator(store, hub, provider);
  const ops = new Operations({ store, hub, orchestrator: orch });
  await store.putProject(project);
  return { store, ops, bus };
}

// ── Pure parser ──────────────────────────────────────────────────────────────
describe("parseGithubSignal", () => {
  const repo = { full_name: "acme/app" };

  it("pull_request opened → pr_opened, carrying the PR number/url/branch", () => {
    const s = parseGithubSignal("pull_request", {
      action: "opened",
      repository: repo,
      pull_request: { number: 42, merged: false, html_url: "https://github.com/acme/app/pull/42", head: { ref: "agent/r1" } },
    });
    expect(s).toEqual({
      repo: "acme/app", prNumber: 42, kind: "pr_opened",
      payload: { prNumber: 42, prUrl: "https://github.com/acme/app/pull/42", branch: "agent/r1" },
    });
  });

  it("pull_request ready_for_review → pr_ready_for_review", () => {
    const s = parseGithubSignal("pull_request", {
      action: "ready_for_review",
      repository: repo,
      pull_request: { number: 42, merged: false, html_url: "u", head: { ref: "agent/r1" } },
    });
    expect(s?.kind).toBe("pr_ready_for_review");
  });

  it("pull_request closed + merged:true → pr_merged (not just 'closed')", () => {
    const s = parseGithubSignal("pull_request", {
      action: "closed",
      repository: repo,
      pull_request: { number: 42, merged: true, html_url: "u", head: { ref: "agent/r1" } },
    });
    expect(s?.kind).toBe("pr_merged");
  });

  it("pull_request closed + merged:false → pr_closed (abandoned, not merged)", () => {
    const s = parseGithubSignal("pull_request", {
      action: "closed",
      repository: repo,
      pull_request: { number: 42, merged: false, html_url: "u", head: { ref: "agent/r1" } },
    });
    expect(s?.kind).toBe("pr_closed");
  });

  it("pull_request — ignores an action outside opened/closed/ready_for_review (e.g. synchronize)", () => {
    expect(parseGithubSignal("pull_request", { action: "synchronize", repository: repo, pull_request: { number: 42 } })).toBeNull();
  });

  it("pull_request_review submitted+approved → review_approved", () => {
    const s = parseGithubSignal("pull_request_review", {
      action: "submitted", repository: repo,
      pull_request: { number: 42, html_url: "u" }, review: { state: "approved" },
    });
    expect(s).toEqual({
      repo: "acme/app", prNumber: 42, kind: "review_approved",
      payload: { prNumber: 42, prUrl: "u", reviewState: "approved", reviewBody: "" },
    });
  });

  it("pull_request_review submitted+changes_requested → review_changes_requested, carrying the review body", () => {
    const s = parseGithubSignal("pull_request_review", {
      action: "submitted", repository: repo,
      pull_request: { number: 42, html_url: "u" }, review: { state: "changes_requested", body: "please add a test for the empty-input case" },
    });
    expect(s?.kind).toBe("review_changes_requested");
    expect(s?.payload.reviewBody).toBe("please add a test for the empty-input case");
  });

  it("pull_request_review — ignores a non-submitted action (e.g. dismissed) and an uninteresting state (e.g. commented)", () => {
    expect(parseGithubSignal("pull_request_review", { action: "dismissed", repository: repo, pull_request: { number: 42 }, review: { state: "approved" } })).toBeNull();
    expect(parseGithubSignal("pull_request_review", { action: "submitted", repository: repo, pull_request: { number: 42 }, review: { state: "commented" } })).toBeNull();
  });

  it("check_run completed+success (linked to a PR) → check_succeeded", () => {
    const s = parseGithubSignal("check_run", {
      action: "completed", repository: repo,
      check_run: { name: "build", conclusion: "success", head_sha: "abc123", pull_requests: [{ number: 42 }] },
    });
    expect(s).toEqual({
      repo: "acme/app", prNumber: 42, kind: "check_succeeded",
      payload: { prNumber: 42, checkName: "build", sha: "abc123", conclusion: "success" },
    });
  });

  it("check_run completed+failure → check_failed", () => {
    const s = parseGithubSignal("check_run", {
      action: "completed", repository: repo,
      check_run: { name: "test", conclusion: "failure", head_sha: "abc123", pull_requests: [{ number: 42 }] },
    });
    expect(s?.kind).toBe("check_failed");
  });

  it("check_run — ignores a run with no linked PR (nothing to resolve against yet)", () => {
    const s = parseGithubSignal("check_run", {
      action: "completed", repository: repo,
      check_run: { name: "build", conclusion: "success", head_sha: "abc123", pull_requests: [] },
    });
    expect(s).toBeNull();
  });

  it("deployment_status state:success → deploy_succeeded, resolved by branch (no PR number)", () => {
    const s = parseGithubSignal("deployment_status", {
      action: "created", repository: repo,
      deployment: { ref: "agent/r1", environment: "production" },
      deployment_status: { state: "success" },
    });
    expect(s).toEqual({ repo: "acme/app", branch: "agent/r1", kind: "deploy_succeeded", payload: { environment: "production", state: "success" } });
  });

  it("deployment_status state:failure → deploy_failed", () => {
    const s = parseGithubSignal("deployment_status", {
      action: "created", repository: repo,
      deployment: { ref: "agent/r1", environment: "production" },
      deployment_status: { state: "failure" },
    });
    expect(s?.kind).toBe("deploy_failed");
  });

  it("deployment_status — ignores an in-between state (e.g. pending/in_progress)", () => {
    expect(parseGithubSignal("deployment_status", { repository: repo, deployment: { ref: "r" }, deployment_status: { state: "in_progress" } })).toBeNull();
  });

  it("returns null for an event type it doesn't handle, and for a missing repository", () => {
    expect(parseGithubSignal("push", { repository: repo, ref: "refs/heads/main" })).toBeNull();
    expect(parseGithubSignal("pull_request", { action: "opened", pull_request: { number: 1 } })).toBeNull();
  });
});

// ── Operations.publishGithubSignal — resolve to a task, publish on the bus ──
describe("Operations.publishGithubSignal", () => {
  it("resolves a PR-keyed signal via the run's OWN pr.repo+pr.number, publishes github.signal", async () => {
    const { store, ops, bus } = await setup();
    await store.putRun(mkRun({ pr: { number: 42, url: "u", repo: "acme/app", branch: "agent/r1", base: "main", state: "open", openedAt: 0, briefing: null, dismissed: false } }));
    await store.putTask(mkTask());

    const res = await ops.publishGithubSignal({ repo: "acme/app", prNumber: 42, kind: "pr_merged", payload: { prNumber: 42 } });
    expect(res).toEqual({ published: true });
    expect(bus.events).toContainEqual({ type: "github.signal", taskId: "t1", kind: "pr_merged", payload: { prNumber: 42 } });
  });

  it("resolves a branch-keyed signal (deployment_status) via Project.repo + TaskRun.branch", async () => {
    const { store, ops, bus } = await setup();
    await store.putRun(mkRun());
    await store.putTask(mkTask());

    const res = await ops.publishGithubSignal({ repo: "acme/app", branch: "agent/r1", kind: "deploy_succeeded", payload: { environment: "production", state: "success" } });
    expect(res).toEqual({ published: true });
    expect(bus.events).toContainEqual({ type: "github.signal", taskId: "t1", kind: "deploy_succeeded", payload: { environment: "production", state: "success" } });
  });

  it("is a silent no-op — published:false, nothing on the bus — when no run matches", async () => {
    const { store, ops, bus } = await setup();
    await store.putRun(mkRun({ pr: { number: 42, url: "u", repo: "acme/app", branch: "agent/r1", base: "main", state: "open", openedAt: 0, briefing: null, dismissed: false } }));
    await store.putTask(mkTask());

    const res = await ops.publishGithubSignal({ repo: "acme/app", prNumber: 999, kind: "pr_merged", payload: {} });
    expect(res).toEqual({ published: false });
    expect(bus.events).toHaveLength(0);
  });

  it("is a silent no-op when the run matches but no task points at it (runId detached)", async () => {
    const { store, ops, bus } = await setup();
    await store.putRun(mkRun({ pr: { number: 42, url: "u", repo: "acme/app", branch: "agent/r1", base: "main", state: "open", openedAt: 0, briefing: null, dismissed: false } }));
    // no task put — nothing has runId: "r1"

    const res = await ops.publishGithubSignal({ repo: "acme/app", prNumber: 42, kind: "pr_merged", payload: {} });
    expect(res).toEqual({ published: false });
    expect(bus.events).toHaveLength(0);
  });
});

// ── The real route, HMAC-signed, end-to-end ──────────────────────────────────
describe("POST /webhooks/github — PR/review/check/deploy signals", () => {
  let app: FastifyInstance;
  let store: MemoryStore;
  let bus: RecordingBus;
  const ORIG_SECRET = config.githubWebhookSecret;
  const SECRET = "test-webhook-secret";

  const sign = (body: string) => `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
  const post = async (event: string, payload: unknown) => {
    const body = JSON.stringify(payload);
    return app.inject({
      method: "POST", url: "/webhooks/github",
      headers: { "content-type": "application/json", "x-github-event": event, "x-hub-signature-256": sign(body) },
      payload: body,
    });
  };

  beforeEach(async () => {
    config.githubWebhookSecret = SECRET;
    const built = await setup();
    store = built.store;
    bus = built.bus;
    await store.putRun(mkRun({ pr: { number: 42, url: "u", repo: "acme/app", branch: "agent/r1", base: "main", state: "open", openedAt: 0, briefing: null, dismissed: false } }));
    await store.putTask(mkTask());
    app = Fastify();
    await registerGithubWebhookRoutes(app, { operations: built.ops });
    await app.ready();
  });

  afterEach(async () => {
    config.githubWebhookSecret = ORIG_SECRET;
    await app.close();
  });

  it("a validly-signed pull_request 'closed, merged' resolves to the task and lands on the bus", async () => {
    const res = await post("pull_request", {
      action: "closed", repository: { full_name: "acme/app" },
      pull_request: { number: 42, merged: true, html_url: "https://github.com/acme/app/pull/42", head: { ref: "agent/r1" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ published: true });
    expect(bus.events.some((e) => e.type === "github.signal" && e.taskId === "t1" && e.kind === "pr_merged")).toBe(true);
  });

  it("a validly-signed pull_request_review 'submitted, approved' resolves and publishes", async () => {
    const res = await post("pull_request_review", {
      action: "submitted", repository: { full_name: "acme/app" },
      pull_request: { number: 42, html_url: "u" }, review: { state: "approved" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ published: true });
    expect(bus.events.some((e) => e.type === "github.signal" && e.kind === "review_approved")).toBe(true);
  });

  it("a validly-signed check_run 'completed, success' linked to the PR resolves and publishes", async () => {
    const res = await post("check_run", {
      action: "completed", repository: { full_name: "acme/app" },
      check_run: { name: "build", conclusion: "success", head_sha: "sha1", pull_requests: [{ number: 42 }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ published: true });
    expect(bus.events.some((e) => e.type === "github.signal" && e.kind === "check_succeeded")).toBe(true);
  });

  it("a validly-signed deployment_status 'success' resolves by branch and publishes", async () => {
    const res = await post("deployment_status", {
      action: "created", repository: { full_name: "acme/app" },
      deployment: { ref: "agent/r1", environment: "production" }, deployment_status: { state: "success" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ published: true });
    expect(bus.events.some((e) => e.type === "github.signal" && e.kind === "deploy_succeeded")).toBe(true);
  });

  it("401s on a bad signature, even for a signal event type", async () => {
    const body = JSON.stringify({ action: "closed", repository: { full_name: "acme/app" }, pull_request: { number: 42, merged: true } });
    const res = await app.inject({
      method: "POST", url: "/webhooks/github",
      headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-hub-signature-256": "sha256=deadbeef" },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
    expect(bus.events).toHaveLength(0);
  });

  it("202s (never errors) a validly-signed signal that can't be resolved to a task", async () => {
    const res = await post("pull_request", {
      action: "closed", repository: { full_name: "acme/app" },
      pull_request: { number: 9999, merged: true, html_url: "u", head: { ref: "no-such-branch" } },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ignored: true });
    expect(bus.events).toHaveLength(0);
  });

  it("202s (never errors) an unrecognized action within a supported event type", async () => {
    const res = await post("pull_request", {
      action: "synchronize", repository: { full_name: "acme/app" }, pull_request: { number: 42 },
    });
    expect(res.statusCode).toBe(202);
  });

  it("the existing `issues` event still creates a task exactly as before (purely additive)", async () => {
    const body = JSON.stringify({
      action: "opened", repository: { full_name: "acme/app" },
      issue: { number: 7, title: "Fix login redirect", body: "It loops.", html_url: "https://x/7" },
    });
    const res = await app.inject({
      method: "POST", url: "/webhooks/github",
      headers: { "content-type": "application/json", "x-github-event": "issues", "x-hub-signature-256": sign(body) },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ created: 1 });
  });

  it("still 202s an out-of-scope event type (e.g. push)", async () => {
    const res = await post("push", { ref: "refs/heads/main" });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ignored: true });
  });
});
