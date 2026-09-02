// Phase 24 (TASK 27) — a `push` webhook touching a project's roadmap path
// triggers a re-parse and keeps the cached RoadmapDoc's sync state honest.
// Two layers, same split as github-webhook.test.ts: Operations.handleGithubRoadmapPush
// / syncProjectRoadmap (domain logic) and the real Fastify route (HMAC
// signature verification, event filtering).
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { Project } from "@skynet/shared";
import { config } from "../apps/server/src/config.js";
import { registerGithubWebhookRoutes, parseGithubPush, pushTouchesProjectRoadmap } from "../apps/server/src/github/webhook.js";
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

let repo: string;
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

const PUSH_PAYLOAD = (over: Record<string, unknown> = {}) => ({
  ref: "refs/heads/main",
  after: "deadbeefcafe",
  repository: { full_name: "acme/app" },
  commits: [{ added: [], removed: [], modified: ["ROADMAP.md"] }],
  ...over,
});

describe("parseGithubPush / pushTouchesProjectRoadmap (pure)", () => {
  it("extracts repo, commitSha, and every touched path across all commits, not just the last", () => {
    const parsed = parseGithubPush(
      PUSH_PAYLOAD({
        commits: [
          { added: ["a.txt"], removed: [], modified: [] },
          { added: [], removed: [], modified: ["ROADMAP.md"] },
          { added: [], removed: ["old.md"], modified: [] },
        ],
      }),
    );
    expect(parsed?.repo).toBe("acme/app");
    expect(parsed?.commitSha).toBe("deadbeefcafe");
    expect([...parsed!.touchedPaths].sort()).toEqual(["ROADMAP.md", "a.txt", "old.md"]);
  });

  it("returns null for a payload missing repo/after/commits", () => {
    expect(parseGithubPush({ ref: "refs/heads/main" })).toBeNull();
    expect(parseGithubPush("not an object")).toBeNull();
  });

  it("matches the default candidates when no override is set, and ONLY the override when one is", () => {
    const paths = new Set(["docs/ROADMAP.md"]);
    expect(pushTouchesProjectRoadmap(paths, null)).toBe(true); // default candidate
    expect(pushTouchesProjectRoadmap(paths, "ROADMAP.md")).toBe(false); // override doesn't match
    expect(pushTouchesProjectRoadmap(new Set(["ROADMAP.md"]), "docs/ROADMAP.md")).toBe(false); // override excludes the default
  });
});

describe("Operations.handleGithubRoadmapPush / syncProjectRoadmap", () => {
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "skynet-roadmap-push-"));
    execFileSync("git", ["init", "-b", "main", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "t@t.local"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "T"]);
    writeFileSync(join(repo, "ROADMAP.md"), "# Roadmap\n\n- [ ] First item\n");
    git("add", "-A");
    git("commit", "-m", "init");
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  const mkProject = (over: Partial<Project> = {}): Project =>
    ({
      id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [],
      status: "active", repoPath: repo, gitBacked: true, repo: "acme/app", syncSourceStatus: true, roadmapPath: null,
      ...over,
    }) as Project;

  async function setup(projectOver: Partial<Project> = {}) {
    const store = new MemoryStore({ seed: false });
    const hub = new Hub(store, new NullBus());
    const orch = new Orchestrator(store, hub, provider);
    const ops = new Operations({ store, hub, orchestrator: orch });
    await store.putProject(mkProject(projectOver));
    return { store, ops };
  }

  it("syncProjectRoadmap parses the real repo content and lands on in_sync", async () => {
    const { store, ops } = await setup();
    const doc = await ops.syncProjectRoadmap(DEFAULT_WORKSPACE, "p1", { commitSha: "abc123" });
    expect(doc.syncState).toBe("in_sync");
    expect(doc.commitSha).toBe("abc123");
    expect(doc.raw).toContain("First item");
    expect(doc.ast.some((n) => n.type === "checklistItem")).toBe(true);

    const cached = await store.getRoadmapDoc("p1");
    expect(cached?.syncState).toBe("in_sync");
  });

  it("a second sync reconciles line identity against the first — an unrelated line's id survives an edit elsewhere", async () => {
    const { ops } = await setup();
    const first = await ops.syncProjectRoadmap(DEFAULT_WORKSPACE, "p1", { commitSha: "sha1" });
    const firstItem = first.ast.find((n) => n.type === "checklistItem")!;

    writeFileSync(join(repo, "ROADMAP.md"), "# Roadmap\n\n- [ ] First item\n- [ ] A second item added later\n");
    git("add", "-A");
    git("commit", "-m", "add a second item");

    const second = await ops.syncProjectRoadmap(DEFAULT_WORKSPACE, "p1", { commitSha: "sha2" });
    const secondFirstItem = second.ast.find((n) => n.type === "checklistItem" && n.text === "First item");
    expect(secondFirstItem?.id).toBe(firstItem.id);
    expect(second.ast.filter((n) => n.type === "checklistItem")).toHaveLength(2);
    expect(second.commitSha).toBe("sha2");
  });

  it("handleGithubRoadmapPush syncs only projects whose roadmap the push actually touched", async () => {
    const { store, ops } = await setup();
    await store.putProject(mkProject({ id: "p2", repo: "acme/other" })); // different repo — must not sync
    await store.putProject(mkProject({ id: "p3", repo: "acme/app", roadmapPath: "docs/ROADMAP.md" })); // same repo, different path — must not sync on a ROADMAP.md-only push

    const { syncedProjectIds } = await ops.handleGithubRoadmapPush({ repo: "acme/app", commitSha: "pushsha1", touchedPaths: new Set(["ROADMAP.md"]) });
    expect(syncedProjectIds).toEqual(["p1"]);

    const p1Doc = await store.getRoadmapDoc("p1");
    expect(p1Doc?.syncState).toBe("in_sync");
    expect(p1Doc?.commitSha).toBe("pushsha1");
    expect(await store.getRoadmapDoc("p2")).toBeUndefined();
    expect(await store.getRoadmapDoc("p3")).toBeUndefined();
  });

  it("a push that doesn't touch any bound project's roadmap syncs nothing", async () => {
    const { store, ops } = await setup();
    const { syncedProjectIds } = await ops.handleGithubRoadmapPush({ repo: "acme/app", commitSha: "x", touchedPaths: new Set(["src/index.ts"]) });
    expect(syncedProjectIds).toEqual([]);
    expect(await store.getRoadmapDoc("p1")).toBeUndefined();
  });

  it("syncProjectRoadmap lands on unparseable when the project's repo can't be read at all", async () => {
    const { store, ops } = await setup({ id: "p-missing", repoPath: "/no/such/path/at/all", repo: "acme/missing" });
    const doc = await ops.syncProjectRoadmap(DEFAULT_WORKSPACE, "p-missing", { commitSha: "x" });
    expect(doc.syncState).toBe("unparseable");
    expect(await store.getRoadmapDoc("p-missing")).toMatchObject({ syncState: "unparseable" });
  });
});

describe("POST /webhooks/github (push)", () => {
  let app: FastifyInstance;
  let ops: Operations;
  let store: MemoryStore;
  const ORIG_SECRET = config.githubWebhookSecret;
  const SECRET = "test-webhook-secret";
  const sign = (body: string) => `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "skynet-roadmap-push-http-"));
    execFileSync("git", ["init", "-b", "main", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "t@t.local"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "T"]);
    writeFileSync(join(repo, "ROADMAP.md"), "# Roadmap\n\n- [ ] Only item\n");
    execFileSync("git", ["-C", repo, "add", "-A"]);
    execFileSync("git", ["-C", repo, "commit", "-m", "init"]);
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  beforeEach(async () => {
    config.githubWebhookSecret = SECRET;
    store = new MemoryStore({ seed: false });
    const hub = new Hub(store, new NullBus());
    const orch = new Orchestrator(store, hub, provider);
    ops = new Operations({ store, hub, orchestrator: orch });
    await store.putProject({
      id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [],
      status: "active", repoPath: repo, gitBacked: true, repo: "acme/app", syncSourceStatus: true, roadmapPath: null,
    } as Project);
    app = Fastify();
    await registerGithubWebhookRoutes(app, { operations: ops });
    await app.ready();
  });
  afterEach(async () => {
    config.githubWebhookSecret = ORIG_SECRET;
    await app.close();
  });

  it("a validly-signed push touching ROADMAP.md syncs the project and returns 200", async () => {
    const body = JSON.stringify(PUSH_PAYLOAD());
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: { "content-type": "application/json", "x-github-event": "push", "x-hub-signature-256": sign(body) },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ syncedProjectIds: ["p1"] });

    const doc = await store.getRoadmapDoc("p1");
    expect(doc?.syncState).toBe("in_sync");
    expect(doc?.commitSha).toBe("deadbeefcafe");
    expect(doc?.raw).toContain("Only item");
  });

  it("a push that doesn't touch ROADMAP.md is a 202 ignore, same contract as an unrelated event", async () => {
    const body = JSON.stringify(PUSH_PAYLOAD({ commits: [{ added: [], removed: [], modified: ["src/index.ts"] }] }));
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: { "content-type": "application/json", "x-github-event": "push", "x-hub-signature-256": sign(body) },
      payload: body,
    });
    expect(res.statusCode).toBe(202);
    expect(await store.getRoadmapDoc("p1")).toBeUndefined();
  });

  it("401s a push with a bad signature — never syncs on an unverified payload", async () => {
    const body = JSON.stringify(PUSH_PAYLOAD());
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: { "content-type": "application/json", "x-github-event": "push", "x-hub-signature-256": "sha256=bad" },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
    expect(await store.getRoadmapDoc("p1")).toBeUndefined();
  });
});
