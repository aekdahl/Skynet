// Guided merge, wired into the Orchestrator: raiseDiffReview drafts a merge
// brief via the provider's `consult` (grounded on the actual patch, composed
// with the task's recorded auto-review verdict when present) and computes the
// default target branch — same "drafted BEFORE the gate raises, never blocks
// it" discipline as the diff walkthrough. Approving with a CHOSEN target
// branch (Resolution.targetBranch) merges into that branch instead of the
// project's default integration branch; leaving it unset behaves exactly as
// before this existed.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { ProviderId, Project, Agent, Task, HitlItem, Resolution } from "@skynet/shared";
import type { ConsultSpec, RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";
import type { Bus } from "../apps/server/src/bus.js";
import { MERGE_BRIEF_SYSTEM } from "../apps/server/src/merge-brief.js";

class NullBus implements Bus { publish(): void {} subscribe(): () => void { return () => {}; } }

const BRIEF_JSON =
  '{"summary":"Adds a greeting file.","risks":["new untracked-by-tests file"],"mitigations":["small, additive change"]}';
// raiseDiffReview also drafts the (unrelated, already-shipped) diff
// walkthrough concurrently with the merge brief — reply with an empty
// walkthrough for that call so this suite's provider doesn't need to care
// about it, and the ONE reply configured per test stays specific to the
// merge-brief call it's actually testing.
const EMPTY_WALKTHROUGH_JSON = '{"summary":"n/a","comments":[]}';

class EditOnceProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  consultCalls: ConsultSpec[] = [];
  constructor(private readonly fileName = "greeting.txt", private readonly consultReply: string | null = BRIEF_JSON) {}
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    writeFileSync(join(spec.cwd!, this.fileName), "hello\n");
    setTimeout(() => events.onCompleted(spec.runId, spec.branch), 0);
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
  consult = this.consultReply != null
    ? async (spec: ConsultSpec): Promise<string> => {
        this.consultCalls.push(spec);
        if (spec.system === MERGE_BRIEF_SYSTEM) return this.consultReply!;
        return EMPTY_WALKTHROUGH_JSON;
      }
    : undefined;
}

let Hub: typeof import("../apps/server/src/hub.js").Hub;
let Orchestrator: typeof import("../apps/server/src/orchestrator.js").Orchestrator;
let MemoryStore: typeof import("../apps/server/src/store/memory.js").MemoryStore;
let repo: string, worktreesDir: string;

const git = (...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

const waitFor = async (pred: () => Promise<boolean>, ms = 8000) => {
  const dl = Date.now() + ms;
  while (Date.now() < dl) { if (await pred()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error("timeout");
};

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "skynet-gm-repo-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "skynet-gm-wt-"));
  execFileSync("git", ["init", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@t.local"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "T"]);
  writeFileSync(join(repo, "README.md"), "# base\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-m", "base"]);
  process.env.STORE = "memory"; process.env.BUS = "memory";
  process.env.SKYNET_INTEGRATION_REPO = repo; process.env.SKYNET_WORKTREES_DIR = worktreesDir;
  process.env.SKYNET_BASE_BRANCH = "main"; delete process.env.RUNNER;
  ({ Hub } = await import("../apps/server/src/hub.js"));
  ({ Orchestrator } = await import("../apps/server/src/orchestrator.js"));
  ({ MemoryStore } = await import("../apps/server/src/store/memory.js"));
});
afterAll(() => { rmSync(repo, { recursive: true, force: true }); rmSync(worktreesDir, { recursive: true, force: true }); });

const setup = async (provider: RunnerProvider, fileName = "greeting.txt") => {
  const store = new MemoryStore({ seed: false });
  const hub = new Hub(store, new NullBus());
  const orchestrator = new Orchestrator(store, hub, provider);
  await store.putProject({ id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [], status: "active", repoPath: null, gitBacked: false } as Project);
  await store.putAgent({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
  await store.putTask({ id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "greet the user", state: "backlog", runId: null } as Task);
  const openDiff = async (): Promise<HitlItem | undefined> =>
    (await store.listQueue(DEFAULT_WORKSPACE)).find((q) => q.kind === "diff" && q.resolvedAt == null);
  await orchestrator.assignTask("p1", "t1");
  await waitFor(openDiff);
  void fileName;
  return { store, hub, orchestrator, item: (await openDiff())! };
};

describe("guided merge — brief + default target branch on the diff HITL", () => {
  it("drafts a merge brief grounded on the real patch and computes the default target branch before the gate raises", async () => {
    const provider = new EditOnceProvider();
    const { item } = await setup(provider);

    expect(item.diff?.mergeBrief?.summary).toBe("Adds a greeting file.");
    expect(item.diff?.mergeBrief?.risks).toEqual(["new untracked-by-tests file"]);
    expect(item.diff?.mergeBrief?.mitigations).toEqual(["small, additive change"]);
    expect(item.diff?.mergeBrief?.filesTouched).toEqual(["greeting.txt"]);
    // No GitHub connection configured → the local merge queue's integration
    // branch is the default, matching MergeEngine.integrationBranch exactly.
    expect(item.diff?.defaultTargetBranch).toBe("skynet/integration/p1");
    // Grounded on the ACTUAL diff, not a description of it. Two concurrent
    // consults fire (this one + the unrelated diff walkthrough) — find this
    // call specifically by its system framing.
    expect(provider.consultCalls).toHaveLength(2);
    const briefCall = provider.consultCalls.find((c) => c.system === MERGE_BRIEF_SYSTEM);
    expect(briefCall?.context).toContain("hello");
    expect(briefCall?.context).toContain("greeting.txt");
  });

  it("raises the gate with no brief when the provider has no consult support — never blocks the review", async () => {
    const provider = new EditOnceProvider("greeting.txt", null);
    const { item } = await setup(provider);
    expect(item.diff?.mergeBrief).toBeNull();
    // The default target branch is still computed — it doesn't depend on the LLM.
    expect(item.diff?.defaultTargetBranch).toBe("skynet/integration/p1");
    expect(item.diff?.add).toBeGreaterThan(0);
  });

  it("raises the gate with no brief when the reply is unreadable", async () => {
    const provider = new EditOnceProvider("greeting.txt", "not json at all");
    const { item } = await setup(provider);
    expect(item.diff?.mergeBrief).toBeNull();
    expect(item.diff?.files).toEqual(["greeting.txt"]);
  });
});

describe("guided merge — operator-chosen target branch", () => {
  it("approving with an explicit targetBranch merges into THAT branch, not the project default", async () => {
    const provider = new EditOnceProvider("release-file.txt");
    const { store, orchestrator, item } = await setup(provider, "release-file.txt");

    const resolution: Resolution = {
      action: "approve", optionIndex: null, guidance: null, targetBranch: "release/guided", by: "op-1", at: Date.now(),
    };
    await orchestrator.deliver(item, resolution);
    await waitFor(async () => {
      try { git("cat-file", "-e", "release/guided:release-file.txt"); return true; } catch { return false; }
    });

    expect(git("cat-file", "-t", "release/guided:release-file.txt")).toBe("blob");
    // The default integration branch was never created for this run.
    expect(git("branch", "--list", "skynet/integration/p1")).toBe("");
    void store;
  });

  it("approving with no targetBranch falls back to the gate's own default (unchanged behavior)", async () => {
    const provider = new EditOnceProvider("default-file.txt");
    const { orchestrator, item } = await setup(provider, "default-file.txt");

    const resolution: Resolution = {
      action: "approve", optionIndex: null, guidance: null, targetBranch: null, by: "op-1", at: Date.now(),
    };
    await orchestrator.deliver(item, resolution);
    await waitFor(async () => {
      try { git("cat-file", "-e", "skynet/integration/p1:default-file.txt"); return true; } catch { return false; }
    });

    expect(git("cat-file", "-t", "skynet/integration/p1:default-file.txt")).toBe("blob");
  });
});
