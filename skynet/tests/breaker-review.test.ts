// `Project.breakerReview` opt-in (requires `deepReview`): after the deepReview
// reviewer approves, a SECOND real bounded agent run — adversarial this time —
// tries to break the change against the SAME kind of live preview. Mirrors
// deep-review.test.ts's harness exactly (a REAL throwaway git repo + a REAL
// dependency-free preview process via an injected ProjectPreviewManager) since
// the breaker reuses runDeepReview's whole mechanism, just with an opposite
// framing and a structurally different verdict.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, HitlItem, Project, Resolution, ServerEvent, Task, TaskRun } from "@skynet/shared";
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

// Plays the reviewer AND the breaker (they're sequential, never concurrent) —
// distinguished by StartSpec.runId's prefix (runDeepReview uses "review-",
// runBreakerReview uses "breaker-") — plus consult, for the plain fallback.
class ReviewAndBreakProvider implements RunnerProvider {
  readonly id = "claude" as const;
  starts: StartSpec[] = [];
  consults = 0;
  constructor(
    private reviewerReply = '{"verdict":"approve","reason":"looks good in the browser"}',
    private breakerReply = '{"findings":[],"verdict":"clean"}',
  ) {}
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    this.starts.push(spec);
    const reply = spec.runId.startsWith("breaker-") ? this.breakerReply : this.reviewerReply;
    setTimeout(() => {
      events.onLog(spec.runId, "▸ mcp__browser__browser_navigate", "navigate to the preview");
      events.onLog(spec.runId, reply);
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
  repo = mkdtempSync(join(tmpdir(), "skynet-breaker-repo-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "skynet-breaker-wt-"));
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git("config", "user.email", "t@skynet.local");
  git("config", "user.name", "T");
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

async function setup(opts: { deepReview: boolean; breakerReview: boolean; reviewerReply?: string; breakerReply?: string }) {
  const store = new MemoryStore();
  const hub = new Hub(store, new NullBus());
  const provider = new ReviewAndBreakProvider(opts.reviewerReply, opts.breakerReply);
  const previewMgr = new ProjectPreviewManager(worktreesDir);
  const orch = new Orchestrator(store, hub, provider, previewMgr);
  const project: Project = {
    id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [],
    status: "active", autonomy: true, repoPath: repo, gitBacked: true,
    deepReview: opts.deepReview, breakerReview: opts.breakerReview,
  };
  await store.putProject(project);
  await store.putAgent(idleAgent);
  await store.putAgent(reviewerAgent);
  return { store, orch, provider, previewMgr };
}

describe("breaker review — a broken finding of real severity flags the task", () => {
  it("a medium-severity reproduced finding flips approve → flag, findings recorded", async () => {
    branchWith("agent/r1");
    const { store, orch, provider } = await setup({
      deepReview: true,
      breakerReview: true,
      breakerReply: '{"findings":[{"severity":"medium","what":"crashes on an empty POST body","repro":"POST /api/widgets with {}"}],"verdict":"broken"}',
    });
    await store.putRun(mkRun());
    await store.putHitl(mkHitl());
    await store.putTask(mkTask({}));
    await orch.tickAutonomy();

    // Both the verifier AND the breaker actually ran.
    expect(provider.starts).toHaveLength(2);
    expect(provider.starts[0]!.runId).toMatch(/^review-/);
    const breakerSpec = provider.starts[1]!;
    expect(breakerSpec.runId).toMatch(/^breaker-/);
    expect(breakerSpec.browser).toBe(true);
    expect(breakerSpec.maxTurns).toBe(12); // tighter than the verifier's 20
    // Edits stay off; Bash stays AVAILABLE (gated for real, not disallowed) —
    // unlike the reviewer, which disallows it outright.
    expect(breakerSpec.disallowedTools).toEqual(expect.arrayContaining(["Edit", "MultiEdit", "Write", "NotebookEdit", "WebFetch", "WebSearch"]));
    expect(breakerSpec.disallowedTools).not.toContain("Bash");
    expect(breakerSpec.task).toContain("live preview"); // it got the same kind of preview brief

    const t = await store.getTask("t1");
    expect(t?.reviewVerdict?.decision).toBe("flag"); // flipped from the verifier's approve
    expect(t?.reviewVerdict?.reason).toContain("crashes on an empty POST body");
    expect(t?.reviewVerdict?.breaker?.verdict).toBe("broken");
    expect(t?.reviewVerdict?.breaker?.findings).toHaveLength(1);
    expect(t?.reviewVerdict?.breaker?.findings[0]?.repro).toContain("POST /api/widgets");
    expect(t?.reviewVerdict?.breaker?.note).toBeNull();
  }, 20_000);

  it("only LOW-severity findings on a broken verdict do NOT flip the verdict (severity floor)", async () => {
    branchWith("agent/r1");
    const { store, orch } = await setup({
      deepReview: true,
      breakerReview: true,
      breakerReply: '{"findings":[{"severity":"low","what":"minor visual glitch on hover","repro":"hover the button"}],"verdict":"broken"}',
    });
    await store.putRun(mkRun());
    await store.putHitl(mkHitl());
    await store.putTask(mkTask({}));
    await orch.tickAutonomy();

    const t = await store.getTask("t1");
    expect(t?.reviewVerdict?.decision).toBe("approve"); // the verifier's approve stands
    expect(t?.reviewVerdict?.breaker?.verdict).toBe("broken"); // still recorded honestly
    expect(t?.reviewVerdict?.breaker?.findings).toHaveLength(1);
  }, 20_000);
});

describe("breaker review — a clean pass leaves the verifier's approve standing", () => {
  it("clean verdict: approve stands, findings (the attempts) are still recorded", async () => {
    branchWith("agent/r1");
    const { store, orch } = await setup({
      deepReview: true,
      breakerReview: true,
      breakerReply: '{"findings":[{"severity":"low","what":"tried an empty payload, form validated correctly","repro":"POST /api/widgets with {}"}],"verdict":"clean"}',
    });
    await store.putRun(mkRun());
    await store.putHitl(mkHitl());
    await store.putTask(mkTask({}));
    await orch.tickAutonomy();

    const t = await store.getTask("t1");
    expect(t?.reviewVerdict?.decision).toBe("approve");
    expect(t?.reviewVerdict?.breaker?.verdict).toBe("clean");
    expect(t?.reviewVerdict?.breaker?.findings).toHaveLength(1); // "what was attempted" is visible, not just silence
    expect(t?.reviewVerdict?.breaker?.note).toBeNull();
  }, 20_000);

  it("unreadable breaker output: approve stands, recorded as clean WITH a note", async () => {
    branchWith("agent/r1");
    const { store, orch, provider } = await setup({
      deepReview: true,
      breakerReview: true,
      breakerReply: "I poked around a bunch and honestly couldn't find anything, seems fine",
    });
    await store.putRun(mkRun());
    await store.putHitl(mkHitl());
    await store.putTask(mkTask({}));
    await orch.tickAutonomy();

    expect(provider.starts).toHaveLength(2); // the breaker DID start and run
    const t = await store.getTask("t1");
    expect(t?.reviewVerdict?.decision).toBe("approve"); // never blocks the pipeline
    expect(t?.reviewVerdict?.breaker?.verdict).toBe("clean");
    expect(t?.reviewVerdict?.breaker?.note).toBeTruthy(); // but it's visibly a note, not a real clean pass
  }, 20_000);
});

describe("breaker review — skip conditions", () => {
  it("skipped entirely when the verifier itself flags — never spend a breaker run confirming a rejection", async () => {
    branchWith("agent/r1");
    const { store, orch, provider } = await setup({
      deepReview: true,
      breakerReview: true,
      reviewerReply: '{"verdict":"flag","reason":"broken layout on mobile"}',
    });
    await store.putRun(mkRun());
    await store.putHitl(mkHitl());
    await store.putTask(mkTask({}));
    await orch.tickAutonomy();

    expect(provider.starts).toHaveLength(1); // only the verifier ran
    expect(provider.starts[0]!.runId).toMatch(/^review-/);
    const t = await store.getTask("t1");
    expect(t?.reviewVerdict?.decision).toBe("flag"); // the verifier's own flag, untouched
    expect(t?.reviewVerdict?.reason).toContain("broken layout on mobile");
    expect(t?.reviewVerdict?.breaker ?? null).toBeNull(); // breaker never ran — nothing to record
  }, 20_000);

  it("breakerReview requires deepReview — a project with breakerReview on but deepReview off never runs either lens", async () => {
    branchWith("agent/r1");
    const { store, orch, provider } = await setup({ deepReview: false, breakerReview: true });
    await store.putRun(mkRun());
    await store.putHitl(mkHitl());
    await store.putTask(mkTask({}));
    await orch.tickAutonomy();

    expect(provider.starts).toHaveLength(0); // deepReview off → falls to plain consult, no bounded run at all
    expect(provider.consults).toBe(1);
    const t = await store.getTask("t1");
    expect(t?.reviewVerdict?.breaker ?? null).toBeNull();
  }, 20_000);

  it("breakerReview off (deepReview on): the verifier alone runs, no breaker", async () => {
    branchWith("agent/r1");
    const { store, orch, provider } = await setup({ deepReview: true, breakerReview: false });
    await store.putRun(mkRun());
    await store.putHitl(mkHitl());
    await store.putTask(mkTask({}));
    await orch.tickAutonomy();

    expect(provider.starts).toHaveLength(1);
    expect(provider.starts[0]!.runId).toMatch(/^review-/);
    const t = await store.getTask("t1");
    expect(t?.reviewVerdict?.decision).toBe("approve");
    expect(t?.reviewVerdict?.breaker ?? null).toBeNull();
  }, 20_000);
});

// Do #5: "standard command gates still apply to everything else it tries to
// do" — unlike the reviewer (Bash categorically removed), the breaker's Bash
// approval gates route through the SAME classifyCommand + decideAutoApproval
// path a real run's Bash gate would (see raise()), auto-resolved against the
// project's OWN trust level since there's no human here to ask.
class BashGateProvider implements RunnerProvider {
  readonly id = "claude" as const;
  starts: StartSpec[] = [];
  resolutions: Resolution[] = [];
  constructor(private bashCommand: string, private breakerReply = '{"findings":[],"verdict":"clean"}') {}
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    this.starts.push(spec);
    const isBreaker = spec.runId.startsWith("breaker-");
    const handle: RunnerHandle = {
      runId: spec.runId,
      provider: this.id,
      async pause() {},
      async message() {},
      resume: async (d) => { if (d) this.resolutions.push(d); },
      async stop() {},
    };
    setTimeout(() => {
      if (!isBreaker) {
        events.onLog(spec.runId, '{"verdict":"approve","reason":"looks good"}');
        events.onCompleted(spec.runId, spec.branch);
        return;
      }
      // Simulate the breaker attempting a Bash command mid-run — the SAME
      // shape claude.ts's actionTitle() produces for a real Bash call.
      events.onHitl(spec.runId, {
        kind: "approval",
        title: `Run a shell command: ${this.bashCommand}`,
        why: "Runs a shell command in the agent's isolated worktree.",
        risk: "medium",
        command: this.bashCommand,
        rationale: null,
        options: null,
        recommended: null,
        steps: null,
        diff: null,
      });
      setTimeout(() => {
        events.onLog(spec.runId, "▸ mcp__browser__browser_navigate", "navigate");
        events.onLog(spec.runId, this.breakerReply);
        events.onCompleted(spec.runId, spec.branch);
      }, 0);
    }, 0);
    return handle;
  }
  async consult(): Promise<string> {
    return '{"verdict":"flag","reason":"should not happen"}';
  }
}

describe("breaker review — Bash gate reuses the project's real command-safety/approval policy", () => {
  it("a low-risk read-only command auto-approves under the project's trust level", async () => {
    branchWith("agent/r1");
    const store = new MemoryStore();
    const hub = new Hub(store, new NullBus());
    const provider = new BashGateProvider("ls -la");
    const previewMgr = new ProjectPreviewManager(worktreesDir);
    const orch = new Orchestrator(store, hub, provider, previewMgr);
    const project: Project = {
      id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [],
      status: "active", autonomy: true, repoPath: repo, gitBacked: true,
      deepReview: true, breakerReview: true, approvalLevel: "trusted", approvalRules: [],
    };
    await store.putProject(project);
    await store.putAgent(idleAgent);
    await store.putAgent(reviewerAgent);
    await store.putRun(mkRun());
    await store.putHitl(mkHitl());
    await store.putTask(mkTask({}));
    await orch.tickAutonomy();

    expect(provider.resolutions).toHaveLength(1);
    expect(provider.resolutions[0]!.action).toBe("approve");
    expect(provider.resolutions[0]!.by).toMatch(/^policy:/); // real policy attribution, not a blanket rubber stamp
  }, 20_000);

  it("a high-risk boundary command is denied — no human here to approve it, regardless of trust level", async () => {
    branchWith("agent/r1");
    const store = new MemoryStore();
    const hub = new Hub(store, new NullBus());
    const provider = new BashGateProvider("git push origin main --force");
    const previewMgr = new ProjectPreviewManager(worktreesDir);
    const orch = new Orchestrator(store, hub, provider, previewMgr);
    const project: Project = {
      id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [],
      status: "active", autonomy: true, repoPath: repo, gitBacked: true,
      deepReview: true, breakerReview: true, approvalLevel: "trusted", approvalRules: [],
    };
    await store.putProject(project);
    await store.putAgent(idleAgent);
    await store.putAgent(reviewerAgent);
    await store.putRun(mkRun());
    await store.putHitl(mkHitl());
    await store.putTask(mkTask({}));
    await orch.tickAutonomy();

    expect(provider.resolutions).toHaveLength(1);
    expect(provider.resolutions[0]!.action).toBe("reject"); // never silently runs a boundary op unattended
  }, 20_000);
});
