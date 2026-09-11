// Review feedback loop: resolving a diff review must resume the agent to
// REVISE (in its existing worktree) and re-raise the review, not silently
// swallow the operator's feedback. Drives the REAL orchestrator against a
// throwaway git repo with a two-turn fake provider. Two historical
// regressions are pinned here:
//
//   - `modify` + guidance: regression guard for the acceptance eval "Apply
//     modify guidance", which failed because the diff review auto-approved
//     and the orchestrator tore the run down at review (a modify was never
//     delivered).
//   - `reject` with NO guidance: clicking "Reject" on a `diff` or `merge`
//     HITL used to be a silent no-op once the run parked in review (no live
//     handle — deliver() had no path for reject on those kinds, so it fell
//     through to the "not delivered" log line and the operator saw nothing
//     happen). Reject on diff/merge now mirrors the verifier gate's existing
//     reject semantics: bounce the agent back to revise (reviseAfterReview),
//     same as Modify, working even with zero typed guidance.
//
// Both turn 1 write PR_DESCRIPTION.md (no marker section); the revise turn
// (same worktree) appends the marker. Asserts the round-trip: the branch
// gains the marker section, then an approve merges it to done.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { ProviderId, Project, Agent, Task, Resolution, HitlItem } from "@skynet/shared";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";
import type { Bus } from "../apps/server/src/bus.js";

class NullBus implements Bus {
  publish(): void {}
  subscribe(): () => void { return () => {}; }
}

// Turn 1: write a PR description with no Rollback section. Revise turn (the file
// already exists in the worktree): append the requested Rollback section. Mirrors
// a real agent reading its own prior output and revising in place.
class ModifyTwoTurnProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  starts = 0;
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    this.starts++;
    const file = join(spec.cwd!, "PR_DESCRIPTION.md");
    if (!existsSync(file)) {
      writeFileSync(file, "# Add CSV export\n\n## Summary\n\nAdds exportCsv.\n");
    } else {
      writeFileSync(file, readFileSync(file, "utf8") + "\n## Rollback\n\nRevert the commit: `git revert <sha>`.\n");
    }
    setTimeout(() => events.onCompleted(spec.runId, spec.branch), 0);
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

// Turn 1: write a PR description. Revise turn (file already exists in the
// worktree): append a marker so the test can see a second turn actually ran.
class RejectTwoTurnProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  starts = 0;
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    this.starts++;
    const file = join(spec.cwd!, "PR_DESCRIPTION.md");
    if (!existsSync(file)) {
      writeFileSync(file, "# Add CSV export\n\n## Summary\n\nAdds exportCsv.\n");
    } else {
      writeFileSync(file, readFileSync(file, "utf8") + "\n## Revised\n\nAddressed reviewer rejection.\n");
    }
    setTimeout(() => events.onCompleted(spec.runId, spec.branch), 0);
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

let Hub: typeof import("../apps/server/src/hub.js").Hub;
let Orchestrator: typeof import("../apps/server/src/orchestrator.js").Orchestrator;
let MemoryStore: typeof import("../apps/server/src/store/memory.js").MemoryStore;
let repo: string, worktreesDir: string;

const git = (...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const waitFor = async (pred: () => Promise<boolean>, ms = 5000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await pred()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error("condition not met in time");
};

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "skynet-revise-repo-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "skynet-revise-wt-"));
  execFileSync("git", ["init", "-b", "main", repo]);
  git("config", "user.email", "test@skynet.local");
  git("config", "user.name", "Test");
  writeFileSync(join(repo, "README.md"), "# base\n");
  git("add", "-A");
  git("commit", "-m", "base");
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

beforeEach(() => {
  git("checkout", "-f", "main");
  git("branch", "--list", "agent/*").split("\n").filter(Boolean)
    .forEach((b) => { try { git("branch", "-D", b.replace("*", "").trim()); } catch { /* ignore */ } });
});

describe("review feedback loop: modify guidance is applied", () => {
  it("modify resumes the agent to revise (adds the Rollback section), then approve merges", async () => {
    const store = new MemoryStore({ seed: false });
    const hub = new Hub(store, new NullBus());
    const provider = new ModifyTwoTurnProvider();
    const orchestrator = new Orchestrator(store, hub, provider);

    await store.putProject({ id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [], status: "active", repoPath: null, gitBacked: false } as Project);
    await store.putAgent({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
    await store.putTask({ id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "Write a PR description", state: "backlog", runId: null } as Task);

    const openDiff = async (): Promise<HitlItem | undefined> =>
      (await store.listQueue(DEFAULT_WORKSPACE)).find((q) => q.kind === "diff" && q.resolvedAt == null);
    const resolve = async (item: HitlItem, action: Resolution["action"], guidance?: string) => {
      const resolution: Resolution = { action, optionIndex: null, guidance: guidance ?? null, targetBranch: null, memoryNote: null, by: "test", at: Date.now() };
      const r = await hub.resolveHitl(item.id, resolution);
      if (r?.resolution?.at === resolution.at) await orchestrator.deliver(item, resolution);
    };

    const run = await orchestrator.assignTask("p1", "t1");

    // Turn 1 → first diff review; the branch has the PR description but NO Rollback.
    await waitFor(openDiff);
    const first = (await store.getRun(run.id))!;
    expect(git("diff", `main...${first.branch}`)).toContain("PR_DESCRIPTION.md");
    expect(git("diff", `main...${first.branch}`)).not.toContain("Rollback");

    // Operator asks for changes: add a Rollback section.
    await resolve((await openDiff())!, "modify", "Include a Rollback section with concrete steps.");

    // The agent revises in place and re-raises the review — branch now has Rollback.
    await waitFor(async () => git("diff", `main...${(await store.getRun(run.id))!.branch}`).includes("Rollback"));
    expect(provider.starts).toBe(2); // resumed for a second turn
    await waitFor(openDiff); // a fresh diff review for the revised work

    // Approve the revision → merges → done.
    await resolve((await openDiff())!, "approve");
    await waitFor(async () => (await store.getRun(run.id))?.status === "done");

    const integ = git("show", `skynet/integration/p1:PR_DESCRIPTION.md`);
    expect(integ).toContain("## Rollback");
  });
});

describe("review feedback loop: reject bounces the agent to revise (not a silent no-op)", () => {
  it("reject with NO typed guidance on a diff review still resumes the agent, then approve merges", async () => {
    const store = new MemoryStore({ seed: false });
    const hub = new Hub(store, new NullBus());
    const provider = new RejectTwoTurnProvider();
    const orchestrator = new Orchestrator(store, hub, provider);

    // Distinct project/agent/task ids from the "modify" scenario above: both
    // tests share the same throwaway repo (one beforeAll for the file), and a
    // shared project id would reuse "p1"'s already-merged integration branch,
    // conflicting with this scenario's own PR_DESCRIPTION.md history.
    await store.putProject({ id: "p2", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [], status: "active", repoPath: null, gitBacked: false } as Project);
    await store.putAgent({ id: "r2", workspaceId: DEFAULT_WORKSPACE, name: "r2", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
    await store.putTask({ id: "t2", workspaceId: DEFAULT_WORKSPACE, projectId: "p2", text: "Write a PR description", state: "backlog", runId: null } as Task);

    const openDiff = async (): Promise<HitlItem | undefined> =>
      (await store.listQueue(DEFAULT_WORKSPACE)).find((q) => q.kind === "diff" && q.resolvedAt == null);
    const resolve = async (item: HitlItem, action: Resolution["action"], guidance?: string) => {
      const resolution: Resolution = { action, optionIndex: null, guidance: guidance ?? null, targetBranch: null, memoryNote: null, by: "test", at: Date.now() };
      const r = await hub.resolveHitl(item.id, resolution);
      if (r?.resolution?.at === resolution.at) await orchestrator.deliver(item, resolution);
    };

    const run = await orchestrator.assignTask("p2", "t2");

    // Turn 1 → first diff review; the branch has the PR description but no
    // "Revised" marker yet.
    await waitFor(openDiff);
    const first = (await store.getRun(run.id))!;
    expect(git("diff", `main...${first.branch}`)).toContain("PR_DESCRIPTION.md");
    expect(git("diff", `main...${first.branch}`)).not.toContain("Revised");

    // Operator clicks the plain "Reject" button — no typed guidance, exactly
    // what queue.tsx sends (`resolveHitl(item.id, "reject")`).
    expect(provider.starts).toBe(1);
    await resolve((await openDiff())!, "reject");

    // This must NOT be the silent "not delivered" no-op: the agent is resumed
    // for a second turn in the SAME worktree/branch and revises the work.
    await waitFor(async () => git("diff", `main...${(await store.getRun(run.id))!.branch}`).includes("Revised"));
    expect(provider.starts).toBe(2);
    expect((await store.getRun(run.id))!.branch).toBe(first.branch);
    await waitFor(openDiff); // a fresh diff review for the revised work

    // Approve the revision → merges → done, proving the run is still healthy.
    await resolve((await openDiff())!, "approve");
    await waitFor(async () => (await store.getRun(run.id))?.status === "done");

    const integ = git("show", `skynet/integration/p2:PR_DESCRIPTION.md`);
    expect(integ).toContain("## Revised");
  });
});
