// Orchestrator-level wiring for the agent-authored diff walkthrough: a real
// git worktree completes a run, raiseDiffReview drafts a walkthrough via the
// provider's `consult` (grounded on the actual patch), and the resulting diff
// HITL carries it. A provider with no `consult`, or one that replies with
// something unreadable, must never block the gate from raising.
//
// raiseDiffReview also drafts the guided-merge brief (merge-brief.ts) via a
// SECOND, concurrent consult with its own system framing — this suite pins
// the walkthrough's OWN call precisely (by routing the mock's reply on
// `spec.system`), so it stays a clean regression test for the walkthrough
// alone rather than silently coupling to the brief's behavior.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { ProviderId, Project, Agent, Task, HitlItem } from "@skynet/shared";
import type { ConsultSpec, RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";
import type { Bus } from "../apps/server/src/bus.js";
import { DIFF_WALKTHROUGH_SYSTEM } from "../apps/server/src/diff-walkthrough.js";

class NullBus implements Bus { publish(): void {} subscribe(): () => void { return () => {}; } }

const WALKTHROUGH_JSON =
  '{"summary":"Adds a greeting file.","comments":[{"file":"greeting.txt","line":1,"note":"the actual change"}]}';
const BRIEF_JSON = '{"summary":"Adds a greeting file.","risks":[],"mitigations":[]}';

class EditOnceProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  consultCalls: ConsultSpec[] = [];
  constructor(private consultReply: string | null) {}
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    writeFileSync(join(spec.cwd!, "greeting.txt"), "hello\n");
    setTimeout(() => events.onCompleted(spec.runId, spec.branch), 0);
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
  // Only wired up when a reply was configured — pins the "no consult support"
  // path (most CLI runners today) alongside the "consult but unreadable" path.
  // raiseDiffReview fires this for BOTH the walkthrough and the merge-brief
  // draft; route on `spec.system` so a configured "unreadable"/`null` reply
  // still exercises both call sites uniformly, and a configured GOOD reply
  // doesn't cross-contaminate (the walkthrough reply would incidentally also
  // parse as a valid, empty-risk brief, which would mask a real bug).
  consult = this.consultReply != null
    ? async (spec: ConsultSpec): Promise<string> => {
        this.consultCalls.push(spec);
        if (this.consultReply === WALKTHROUGH_JSON) return spec.system === DIFF_WALKTHROUGH_SYSTEM ? WALKTHROUGH_JSON : BRIEF_JSON;
        return this.consultReply!;
      }
    : undefined;
}

let Hub: typeof import("../apps/server/src/hub.js").Hub;
let Orchestrator: typeof import("../apps/server/src/orchestrator.js").Orchestrator;
let MemoryStore: typeof import("../apps/server/src/store/memory.js").MemoryStore;
let repo: string, worktreesDir: string;
const waitFor = async (pred: () => Promise<boolean>, ms = 5000) => {
  const dl = Date.now() + ms;
  while (Date.now() < dl) { if (await pred()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error("timeout");
};

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "skynet-walk-repo-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "skynet-walk-wt-"));
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

const setup = async (provider: RunnerProvider) => {
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
  return (await openDiff())!;
};

describe("diff HITL — agent-authored walkthrough", () => {
  it("drafts a walkthrough grounded on the real patch and stores it on the gate before it raises", async () => {
    const provider = new EditOnceProvider(WALKTHROUGH_JSON);
    const item = await setup(provider);

    expect(item.diff?.walkthrough?.summary).toBe("Adds a greeting file.");
    expect(item.diff?.walkthrough?.comments).toEqual([{ file: "greeting.txt", line: 1, note: "the actual change" }]);
    // Two concurrent consults (walkthrough + guided-merge brief, see the
    // suite-level comment) — grounded on the ACTUAL diff either way.
    expect(provider.consultCalls).toHaveLength(2);
    const walkthroughCall = provider.consultCalls.find((c) => c.system === DIFF_WALKTHROUGH_SYSTEM);
    expect(walkthroughCall?.context).toContain("hello");
    expect(walkthroughCall?.context).toContain("greeting.txt");
  });

  it("raises the gate with no walkthrough when the provider has no consult support (most CLI runners today)", async () => {
    const provider = new EditOnceProvider(null);
    const item = await setup(provider);
    expect(item.diff?.walkthrough).toBeNull();
    expect(item.diff?.mergeBrief).toBeNull(); // same fallback for the brief's own consult
    expect(item.diff?.add).toBeGreaterThan(0); // the gate itself is unaffected
  });

  it("raises the gate with no walkthrough when the reply is unreadable — never blocks the review", async () => {
    const provider = new EditOnceProvider("not json at all");
    const item = await setup(provider);
    expect(item.diff?.walkthrough).toBeNull();
    expect(item.diff?.mergeBrief).toBeNull();
    expect(item.diff?.files).toEqual(["greeting.txt"]);
  });
});
