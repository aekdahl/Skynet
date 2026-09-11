// Orchestrator.dispatchFeatureHandoff + Operations.resolveHandoffHitl —
// drafting each role's artifact via a scripted `consult`, raising it as a
// `handoff` HITL, and (on approve) the real commit for the two file-writing
// roles. Uses a real throwaway git repo (repoPath) so the CHANGELOG.md/
// README.md read+commit path is genuine, not mocked — same reasoning as
// bakeoff-judge.test.ts's own real-git harness.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { ProviderId, Agent, HitlItem } from "@skynet/shared";
import type { ConsultSpec, RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";
import type { Bus } from "../apps/server/src/bus.js";

class NullBus implements Bus {
  publish(): void {}
  subscribe(): () => void {
    return () => {};
  }
}

/** Never actually started (dispatchFeatureHandoff only calls `consult`) — the
 *  `start` implementation exists only to satisfy RunnerProvider's interface. */
class ScriptedConsultProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  calls: string[] = [];
  constructor(private reply: string) {}
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    setTimeout(() => events.onCompleted(spec.runId, spec.branch), 0);
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
  consult = async (_spec: ConsultSpec, question: string): Promise<string> => {
    this.calls.push(question);
    return this.reply;
  };
}

let Hub: typeof import("../apps/server/src/hub.js").Hub;
let Orchestrator: typeof import("../apps/server/src/orchestrator.js").Orchestrator;
let Operations: typeof import("../apps/server/src/operations.js").Operations;
let MemoryStore: typeof import("../apps/server/src/store/memory.js").MemoryStore;
let repo: string;

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "skynet-handoff-repo-"));
  execFileSync("git", ["init", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@t.local"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "T"]);
  writeFileSync(join(repo, "README.md"), "# Skynet\n\nA fleet of coding agents.\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-m", "base"]);
  process.env.STORE = "memory";
  process.env.BUS = "memory";
  delete process.env.RUNNER;
  ({ Hub } = await import("../apps/server/src/hub.js"));
  ({ Orchestrator } = await import("../apps/server/src/orchestrator.js"));
  ({ Operations } = await import("../apps/server/src/operations.js"));
  ({ MemoryStore } = await import("../apps/server/src/store/memory.js"));
}, 60_000);
afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

function harness(reply: string) {
  const store = new MemoryStore({ seed: false });
  const hub = new Hub(store, new NullBus());
  const provider = new ScriptedConsultProvider(reply);
  const orchestrator = new Orchestrator(store, hub, provider);
  const ops = new Operations({ store, hub, orchestrator });
  return { store, hub, provider, orchestrator, ops };
}

const openHandoffs = async (store: InstanceType<typeof MemoryStore>): Promise<HitlItem[]> =>
  (await store.listQueue(DEFAULT_WORKSPACE)).filter((q) => q.kind === "handoff" && q.resolvedAt == null);

describe("Orchestrator.dispatchFeatureHandoff", () => {
  it("change-manager: drafts a CHANGELOG.md entry and raises a handoff HITL with a scaffolded file (none existed yet)", async () => {
    const { store, orchestrator, provider } = harness("## Bake-off peer review\n\n- Agents now pick the winner themselves.");
    await store.putAgent({ id: "cm", workspaceId: DEFAULT_WORKSPACE, name: "cm", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
    const project = await store.putProject({
      id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", repoPath: repo, roleAgents: { changeManager: "cm", docsWriter: null, releaseComms: null },
    } as never);

    await orchestrator.dispatchFeatureHandoff(DEFAULT_WORKSPACE, project, "feature", "f1", "Cross-vendor bake-offs", "Peer review lands.", "change-manager", "cm");

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toMatch(/Cross-vendor bake-offs/);
    const [item] = await openHandoffs(store);
    expect(item).toBeDefined();
    expect(item.handoffRole).toBe("change-manager");
    expect(item.handoffFilePath).toBe("CHANGELOG.md");
    expect(item.handoffBaseline).toBeNull(); // CHANGELOG.md doesn't exist yet
    expect(item.handoffContent).toBe("# Changelog\n\n## Bake-off peer review\n\n- Agents now pick the winner themselves.\n");
    expect(item.runId).toBe(`handoff:${item.id}`);
  });

  it("docs-writer: drafts an updated README.md against the real current content", async () => {
    const { store, orchestrator } = harness("# Skynet\n\nA fleet of coding agents.\n\n- Now with agent-to-agent handoff on ship.\n");
    await store.putAgent({ id: "dw", workspaceId: DEFAULT_WORKSPACE, name: "dw", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
    const project = await store.putProject({
      id: "p2", workspaceId: DEFAULT_WORKSPACE, name: "P", repoPath: repo, roleAgents: { changeManager: null, docsWriter: "dw", releaseComms: null },
    } as never);

    await orchestrator.dispatchFeatureHandoff(DEFAULT_WORKSPACE, project, "feature", "f1", "Handoff on ship", null, "docs-writer", "dw");

    const item = (await openHandoffs(store)).find((h) => h.handoffRole === "docs-writer")!;
    expect(item.handoffFilePath).toBe("README.md");
    expect(item.handoffBaseline).toBe("# Skynet\n\nA fleet of coding agents.\n");
    expect(item.handoffContent).toContain("agent-to-agent handoff on ship");
  });

  it("release-comms: drafts a plain announcement, no file", async () => {
    const { store, orchestrator } = harness("Agents now review each other's work and pick a winner — no human required for the routine case.");
    await store.putAgent({ id: "rc", workspaceId: DEFAULT_WORKSPACE, name: "rc", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
    const project = await store.putProject({
      id: "p3", workspaceId: DEFAULT_WORKSPACE, name: "P", repoPath: repo, roleAgents: { changeManager: null, docsWriter: null, releaseComms: "rc" },
    } as never);

    await orchestrator.dispatchFeatureHandoff(DEFAULT_WORKSPACE, project, "feature", "f1", "Handoff on ship", null, "release-comms", "rc");

    const item = (await openHandoffs(store)).find((h) => h.handoffRole === "release-comms")!;
    expect(item.handoffFilePath).toBeNull();
    expect(item.handoffContent).toBeNull();
    expect(item.handoffDraftText).toMatch(/pick a winner/);
  });

  it("raises NO HITL when the reply fails the sanity floor (too short to be usable)", async () => {
    const { store, orchestrator } = harness("ok");
    await store.putAgent({ id: "cm2", workspaceId: DEFAULT_WORKSPACE, name: "cm2", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
    const project = await store.putProject({
      id: "p4", workspaceId: DEFAULT_WORKSPACE, name: "P", repoPath: repo, roleAgents: { changeManager: "cm2", docsWriter: null, releaseComms: null },
    } as never);

    await orchestrator.dispatchFeatureHandoff(DEFAULT_WORKSPACE, project, "feature", "f2", "Too short", null, "change-manager", "cm2");

    expect((await openHandoffs(store)).filter((h) => h.projectId === "p4")).toHaveLength(0);
  });

  it("is a silent no-op when the configured agent no longer exists", async () => {
    const { store, orchestrator } = harness("- whatever");
    const project = await store.putProject({
      id: "p5", workspaceId: DEFAULT_WORKSPACE, name: "P", repoPath: repo, roleAgents: { changeManager: "ghost", docsWriter: null, releaseComms: null },
    } as never);
    await expect(
      orchestrator.dispatchFeatureHandoff(DEFAULT_WORKSPACE, project, "feature", "f3", "Ghost agent", null, "change-manager", "ghost"),
    ).resolves.toBeUndefined();
    expect((await openHandoffs(store)).filter((h) => h.projectId === "p5")).toHaveLength(0);
  });
});

describe("Operations.resolveHandoffHitl", () => {
  it("approve commits a change-manager's CHANGELOG.md entry for real", async () => {
    const changelogPath = join(repo, "CHANGELOG.md");
    expect(existsSync(changelogPath)).toBe(false); // no earlier test commits it — dispatch only reads, never writes
    const { store, orchestrator, ops } = harness("## Real commit\n\n- This entry lands on disk.");
    await store.putAgent({ id: "cm3", workspaceId: DEFAULT_WORKSPACE, name: "cm3", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
    const project = await store.putProject({
      id: "p6", workspaceId: DEFAULT_WORKSPACE, name: "P", repoPath: repo, roleAgents: { changeManager: "cm3", docsWriter: null, releaseComms: null },
    } as never);
    await orchestrator.dispatchFeatureHandoff(DEFAULT_WORKSPACE, project, "feature", "f4", "Real commit test", null, "change-manager", "cm3");
    const item = (await openHandoffs(store)).find((h) => h.projectId === "p6")!;

    await ops.resolveHitl(DEFAULT_WORKSPACE, item.id, { action: "approve" }, "operator1");

    const onDisk = readFileSync(changelogPath, "utf8");
    expect(onDisk).toBe("# Changelog\n\n## Real commit\n\n- This entry lands on disk.\n");
    const resolved = await store.getHitl(item.id);
    expect(resolved?.resolvedAt).not.toBeNull();
  });

  it("reject resolves the HITL without touching the repo", async () => {
    const { store, orchestrator, ops } = harness("## Rejected entry\n\n- Should never land.");
    await store.putAgent({ id: "cm4", workspaceId: DEFAULT_WORKSPACE, name: "cm4", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
    const project = await store.putProject({
      id: "p7", workspaceId: DEFAULT_WORKSPACE, name: "P", repoPath: repo, roleAgents: { changeManager: "cm4", docsWriter: null, releaseComms: null },
    } as never);
    await orchestrator.dispatchFeatureHandoff(DEFAULT_WORKSPACE, project, "feature", "f5", "Reject test", null, "change-manager", "cm4");
    const item = (await openHandoffs(store)).find((h) => h.projectId === "p7")!;

    await ops.resolveHitl(DEFAULT_WORKSPACE, item.id, { action: "reject" }, "operator1");

    const onDisk = readFileSync(join(repo, "CHANGELOG.md"), "utf8");
    expect(onDisk).not.toContain("Should never land");
    const resolved = await store.getHitl(item.id);
    expect(resolved?.resolution?.action).toBe("reject");
  });
});
