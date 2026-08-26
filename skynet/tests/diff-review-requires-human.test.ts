// The diff-review gate (raiseDiffReview) is the EARLIEST review surface — a
// human decides whether to approve a branch before it even reaches a PR. The
// fixed path-policy list (migrations/**, .github/workflows/**, auth/**,
// dependency manifests — see orchestrator.ts's mergeRequiresHumanGlobs) must
// already read as high risk here, with the matched globs surfaced as chips,
// not just later on the ready-to-merge card once a PR exists.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { ProviderId, Project, Agent, Task, HitlItem, PlanStep } from "@skynet/shared";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";
import type { Bus } from "../apps/server/src/bus.js";

class NullBus implements Bus {
  publish(): void {}
  subscribe(): () => void {
    return () => {};
  }
}

// Writes a single file at the given path, then completes — no `consult`
// support, so the walkthrough/merge-brief drafts are skipped (best-effort,
// never blocks the gate) and this suite only exercises the path-policy check.
class ScriptedProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  constructor(private readonly relPath: string) {}
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    const plan: PlanStep[] = [{ title: "Edit the file", state: "now" }];
    events.onProgress(spec.runId, 0.5, plan);
    const file = join(spec.cwd!, this.relPath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "changed\n");
    setTimeout(() => events.onCompleted(spec.runId, spec.branch), 0);
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

let Hub: typeof import("../apps/server/src/hub.js").Hub;
let Orchestrator: typeof import("../apps/server/src/orchestrator.js").Orchestrator;
let MemoryStore: typeof import("../apps/server/src/store/memory.js").MemoryStore;
let repo: string, worktreesDir: string;

const waitFor = async (pred: () => Promise<boolean>, ms = 5000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not met in time");
};

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "skynet-rh-repo-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "skynet-rh-wt-"));
  execFileSync("git", ["init", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@t.local"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "T"]);
  writeFileSync(join(repo, "README.md"), "# base\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-m", "base"]);
  process.env.STORE = "memory";
  process.env.BUS = "memory";
  process.env.SKYNET_INTEGRATION_REPO = repo;
  process.env.SKYNET_WORKTREES_DIR = worktreesDir;
  process.env.SKYNET_BASE_BRANCH = "main";
  delete process.env.RUNNER;
  ({ Hub } = await import("../apps/server/src/hub.js"));
  ({ Orchestrator } = await import("../apps/server/src/orchestrator.js"));
  ({ MemoryStore } = await import("../apps/server/src/store/memory.js"));
});
afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(worktreesDir, { recursive: true, force: true });
});

const setup = async (relPath: string) => {
  const store = new MemoryStore({ seed: false });
  const hub = new Hub(store, new NullBus());
  const orchestrator = new Orchestrator(store, hub, new ScriptedProvider(relPath));
  await store.putProject({ id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [], status: "active", repoPath: null, gitBacked: false } as Project);
  await store.putAgent({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
  await store.putTask({ id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "edit the file", state: "backlog", runId: null } as Task);
  const openDiff = async (): Promise<HitlItem | undefined> =>
    (await store.listQueue(DEFAULT_WORKSPACE)).find((q) => q.kind === "diff" && q.resolvedAt == null);
  await orchestrator.assignTask("p1", "t1");
  await waitFor(async () => (await openDiff()) != null);
  return (await openDiff())!;
};

describe("diff-review gate — fixed path-policy list always reads as high risk", () => {
  it("a .github/workflows/** change is flagged and bumped to high risk, even though it's a one-line diff", async () => {
    const item = await setup(".github/workflows/ci.yml");
    expect(item.risk).toBe("high");
    expect(item.flags).toEqual([".github/workflows/**"]);
    expect(item.why).toMatch(/always needs a human look/i);
  });

  it("a dependency manifest change is flagged the same way", async () => {
    const item = await setup("package.json");
    expect(item.risk).toBe("high");
    expect(item.flags).toEqual(["dependency manifest"]);
  });

  it("an ordinary file carries no flags and stays at the size-based risk tier", async () => {
    const item = await setup("src/ui/button.tsx");
    expect(item.risk).toBe("medium"); // small diff, no policy hit — same as before this existed
    expect(item.flags).toEqual([]);
  });
});
