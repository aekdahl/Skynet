// `Project.deepReview` opt-in: instead of a stateless one-shot consult reading
// the last 30 log lines, the reviewer is a SECOND real bounded agent run (with
// browser tools) that opens a live preview of the run's own branch and actually
// exercises the change before writing its verdict. Drives a REAL git repo + a
// REAL (tiny, dependency-free) preview process via an injected ProjectPreviewManager
// pointed at an isolated worktrees dir — the same "drive the real thing" spirit
// as preview-latest-combine.test.ts, not a mocked preview.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, HitlItem, Project, ServerEvent, Task, TaskRun } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import { ProjectPreviewManager } from "../apps/server/src/preview/project-preview.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

class NullBus implements Bus {
  publish(_ws: string, _e: ServerEvent): void {}
  subscribe(): () => void { return () => {}; }
}

// A stub provider that plays BOTH roles (doer's credential isn't exercised here
// — the run/hitl are seeded directly, mirroring autonomy.test.ts's review-flow
// tests) — only the REVIEWER'S `start()`/`consult()` calls are exercised.
class ReviewProvider implements RunnerProvider {
  readonly id = "claude" as const;
  starts: StartSpec[] = [];
  consults = 0;
  constructor(private verdictReply = '{"verdict":"approve","reason":"looks good in the browser"}') {}
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    this.starts.push(spec);
    // Simulate the reviewer: one browser action (→ "evidence"), then its verdict
    // as a plain text line (no `detail`, matching how claude.ts logs prose),
    // then onCompleted — mirroring the ACTUAL sequence claude.ts's drain() loop
    // produces for a tool-call line + a final prose message.
    setTimeout(() => {
      events.onLog(spec.runId, "▸ mcp__browser__browser_navigate", "navigate to the preview");
      events.onLog(spec.runId, this.verdictReply);
      events.onCompleted(spec.runId, spec.branch);
    }, 0);
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
  async consult(): Promise<string> {
    this.consults++;
    return '{"verdict":"flag","reason":"consult path used — should not happen when deepReview succeeds"}';
  }
}

let repo: string;
let worktreesDir: string;
const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: ["ignore", "pipe", "pipe"] }).toString();

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "skynet-deepreview-repo-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "skynet-deepreview-wt-"));
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git("config", "user.email", "t@skynet.local");
  git("config", "user.name", "T");
  // A `.skynet/preview.json` descriptor is the fastest deterministic recipe —
  // no package.json/npm install needed, so `startRun` reaches "live" quickly.
  mkdirSync(join(repo, ".skynet"));
  writeFileSync(join(repo, ".skynet", "preview.json"), JSON.stringify({ dev: "node server.js" }));
  writeFileSync(join(repo, "server.js"), "require('http').createServer((_q,r)=>r.end('ok')).listen(process.env.PORT);");
  writeFileSync(join(repo, "README.md"), "base\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(worktreesDir, { recursive: true, force: true });
});

// A branch off main with a real commit — `projectPreview.startRun`'s
// branch-exists guard requires one, matching a run that actually committed.
function branchWith(name: string) {
  git("checkout", "-q", "-b", name);
  writeFileSync(join(repo, "CHANGED.md"), "changed\n");
  git("add", "-A");
  git("commit", "-q", "-m", name);
  git("checkout", "-q", "main");
}

const idleAgent: Agent = {
  id: "a1", workspaceId: DEFAULT_WORKSPACE, name: "a1", provider: "claude",
  model: "opus-4.8", status: "idle", idleSince: 0,
};
// A SECOND idle agent — the run's own agent (a1) is never its own reviewer.
const reviewerAgent: Agent = {
  id: "a2", workspaceId: DEFAULT_WORKSPACE, name: "a2", provider: "claude",
  model: "opus-4.8", status: "idle", idleSince: 0, canReview: true,
};
const mkTask = (over: Partial<Task>): Task => ({
  id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "do X", state: "review",
  runId: "r1", autoPick: false, assessment: null, reviewVerdict: null, lint: null,
  assignment: { mode: "any", agentIds: [] }, ...over,
});
const mkHitl = (over: Partial<HitlItem> = {}): HitlItem => ({
  id: "q1", workspaceId: DEFAULT_WORKSPACE, runId: "r1", kind: "diff", title: "Review",
  why: "", risk: "medium", raisedAt: 0, expiresAt: null, resolvedAt: null, resolution: null,
  command: null, options: null, recommended: null, steps: null,
  diff: { add: 3, del: 1, modules: [], files: ["a.ts", "b.ts"], walkthrough: null, mergeBrief: null, defaultTargetBranch: null },
  ...over,
});
const mkRun = (over: Partial<TaskRun> = {}): TaskRun => ({
  id: "r1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", name: "do X", status: "review",
  agentId: "a1", provider: "claude", credentialId: null, model: "opus-4.8", branch: "agent/r1",
  modules: [], progress: 1, plan: [], usage: null, modifiedFiles: [], log: [], startedAt: 0,
  lastHeartbeatAt: 0, visual: false, previewUrl: null, dependsOn: [], parentId: null,
  branchFromStep: null, archived: false, pr: null, mergedAt: null,
  ...over,
});

async function setup(opts: { deepReview: boolean; verdictReply?: string }) {
  const store = new MemoryStore();
  const hub = new Hub(store, new NullBus());
  const provider = new ReviewProvider(opts.verdictReply);
  const previewMgr = new ProjectPreviewManager(worktreesDir);
  const orch = new Orchestrator(store, hub, provider, previewMgr);
  const project: Project = {
    id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [],
    status: "active", autonomy: true, repoPath: repo, gitBacked: true, deepReview: opts.deepReview,
  };
  await store.putProject(project);
  await store.putAgent(idleAgent);
  await store.putAgent(reviewerAgent);
  return { store, orch, provider, previewMgr };
}

describe("deep review — deepReview off", () => {
  it("leaves the plain consult path byte-for-byte untouched", async () => {
    const { store, orch, provider } = await setup({ deepReview: false });
    await store.putRun(mkRun());
    await store.putHitl(mkHitl());
    await store.putTask(mkTask({}));
    await orch.tickAutonomy();
    expect(provider.consults).toBe(1); // the plain consult path ran
    expect(provider.starts).toHaveLength(0); // no review-run was ever started
    const t = await store.getTask("t1");
    expect(t?.reviewVerdict?.decision).toBe("flag"); // the consult stub's canned reply
    expect(t?.reviewVerdict?.evidence ?? null).toBeNull(); // nothing to report — consult, not deep review
  });
});

describe("deep review — deepReview on", () => {
  it("starts a real bounded review run with browser tools + the preview URL in the brief, and records evidence", async () => {
    branchWith("agent/r1");
    const { store, orch, provider } = await setup({ deepReview: true });
    await store.putRun(mkRun());
    await store.putHitl(mkHitl());
    await store.putTask(mkTask({}));
    await orch.tickAutonomy();

    expect(provider.consults).toBe(0); // deep review succeeded — consult never needed
    expect(provider.starts).toHaveLength(1);
    const spec = provider.starts[0]!;
    expect(spec.browser).toBe(true);
    expect(spec.maxTurns).toBe(20);
    expect(spec.disallowedTools).toEqual(expect.arrayContaining(["Edit", "MultiEdit", "Write", "NotebookEdit", "Bash"]));
    expect(spec.task).toMatch(/http:\/\/127\.0\.0\.1:\d+/); // the live preview URL, in the brief
    expect(spec.task).toContain("do X"); // the task text
    expect(spec.task).toContain("a.ts"); // the diff stat's file list
    expect(spec.branch).toBe("agent/r1");

    const t = await store.getTask("t1");
    expect(t?.reviewVerdict?.decision).toBe("approve");
    expect(t?.reviewVerdict?.reason).toContain("looks good in the browser");
    expect(t?.reviewVerdict?.evidence).toEqual(["mcp__browser__browser_navigate"]);
  }, 20_000);

  it("reviewer ≠ author is still enforced under deep review (self-review never happens)", async () => {
    branchWith("agent/r1");
    const store = new MemoryStore();
    const hub = new Hub(store, new NullBus());
    const provider = new ReviewProvider();
    const previewMgr = new ProjectPreviewManager(worktreesDir);
    const orch = new Orchestrator(store, hub, provider, previewMgr);
    const project: Project = {
      id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [],
      status: "active", autonomy: true, repoPath: repo, gitBacked: true, deepReview: true,
    };
    await store.putProject(project);
    await store.putAgent(idleAgent); // ONLY the doer is idle — no eligible reviewer
    await store.putRun(mkRun());
    await store.putHitl(mkHitl());
    await store.putTask(mkTask({}));
    await orch.tickAutonomy();

    expect(provider.starts).toHaveLength(0); // no review run — no eligible reviewer at all
    expect(provider.consults).toBe(0);
    const t = await store.getTask("t1");
    expect(t?.reviewVerdict).toBeNull();
    expect((await store.getHitl("q1"))?.resolvedAt).toBeNull();
  }, 20_000);

  it("falls back to the consult path when the branch has no commits (preview can't start)", async () => {
    // No `branchWith("agent/r1")` — the branch doesn't exist, so
    // projectPreview.startRun's own guard fails cleanly before any process spawns.
    const { store, orch, provider } = await setup({ deepReview: true });
    await store.putRun(mkRun());
    await store.putHitl(mkHitl());
    await store.putTask(mkTask({}));
    await orch.tickAutonomy();

    expect(provider.starts).toHaveLength(0); // deep review never got a live preview
    expect(provider.consults).toBe(1); // fell back to consult
    const t = await store.getTask("t1");
    expect(t?.reviewVerdict?.decision).toBe("flag"); // consult stub's canned reply
  }, 20_000);

  it("falls back to consult when the reviewer's reply isn't a readable verdict (never blocks the pipeline)", async () => {
    branchWith("agent/r1");
    const { store, orch, provider } = await setup({ deepReview: true, verdictReply: "I looked around, seems fine I guess" });
    await store.putRun(mkRun());
    await store.putHitl(mkHitl());
    await store.putTask(mkTask({}));
    await orch.tickAutonomy();

    // The review run DID start (so provider.starts recorded it) but its
    // unreadable reply must not be trusted as a real verdict — fall back.
    expect(provider.starts).toHaveLength(1);
    expect(provider.consults).toBe(1);
    const t = await store.getTask("t1");
    expect(t?.reviewVerdict?.decision).toBe("flag"); // the consult stub's canned reply
    expect(t?.reviewVerdict?.evidence ?? null).toBeNull(); // fell back — no deep-review evidence recorded
  }, 20_000);

  it("falls back to consult when the reviewer's provider isn't Claude (browser tools are Claude-only)", async () => {
    branchWith("agent/r1");
    const store = new MemoryStore();
    const hub = new Hub(store, new NullBus());
    const provider = new ReviewProvider();
    const previewMgr = new ProjectPreviewManager(worktreesDir);
    const orch = new Orchestrator(store, hub, provider, previewMgr);
    const project: Project = {
      id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [],
      status: "active", autonomy: true, repoPath: repo, gitBacked: true, deepReview: true,
    };
    await store.putProject(project);
    await store.putAgent(idleAgent);
    await store.putAgent({ ...reviewerAgent, provider: "codex" }); // non-Claude reviewer
    await store.putRun(mkRun());
    await store.putHitl(mkHitl());
    await store.putTask(mkTask({}));
    await orch.tickAutonomy();

    expect(provider.starts).toHaveLength(0); // never attempted a browser-driven run
    expect(provider.consults).toBe(1); // fell back
  }, 20_000);
});
