// v4: repo-native memory sync, wired into the orchestrator's worktree
// provisioning (provisionCwd) — proves assign() actually projects the
// project's portable memory (Project.contextSummary) into the freshly
// provisioned worktree's own CLAUDE.md / .cursor/rules / Copilot
// instructions files. The sync's own filesystem behavior (marker merge,
// idempotent re-sync, no-op when unset) is pinned in
// tests/repo-memory-sync.test.ts; this file is the orchestrator wiring only —
// same harness as tests/agent-context-wiring.test.ts.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { Agent, ProviderId, ServerEvent, HitlItem } from "@skynet/shared";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { Operations } from "../apps/server/src/operations.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import { CLAUDE_MD_PATH, CURSOR_RULE_PATH, COPILOT_INSTRUCTIONS_PATH } from "../apps/server/src/repo-memory-sync.js";

class RecordingBus implements Bus {
  events: ServerEvent[] = [];
  publish(_ws: string, event: ServerEvent): void {
    this.events.push(event);
  }
  subscribe(): () => void {
    return () => {};
  }
}

class RecordingHandle implements RunnerHandle {
  readonly provider: ProviderId = "claude";
  async pause(): Promise<void> {}
  async message(): Promise<void> {}
  async resume(): Promise<void> {}
  async stop(): Promise<void> {}
}

class RecordingProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  specs: StartSpec[] = [];
  async start(spec: StartSpec, _events: RunnerEvents): Promise<RunnerHandle> {
    this.specs.push(spec);
    return new RecordingHandle();
  }
}

describe("repo-native memory sync wiring — orchestrator.assign() provisions the worktree with it", () => {
  let repo: string;
  let store: MemoryStore;
  let bus: RecordingBus;
  let hub: Hub;
  let provider: RecordingProvider;
  let orchestrator: Orchestrator;
  let ops: Operations;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "repo-memory-sync-wiring-repo-"));
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "t@t"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
    execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "base"]);

    store = new MemoryStore({ seed: false });
    bus = new RecordingBus();
    hub = new Hub(store, bus);
    provider = new RecordingProvider();
    orchestrator = new Orchestrator(store, hub, provider);
    ops = new Operations({ store, hub, orchestrator });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("projects the project's contextSummary into the provisioned worktree's vendor files", async () => {
    await store.putAgent({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
    const created = await ops.createProject(DEFAULT_WORKSPACE, { name: "Acme", goal: "Ship it", repoPath: repo });
    // contextSummary is system-owned (set by steward/context.ts's condensation,
    // never directly via UpdateProjectRequest) — write it straight to the
    // store, the same shortcut the condensation pass itself uses.
    await store.putProject({ ...created, contextSummary: "The billing service owns invoicing; never touch it from checkout." });
    const task = await ops.createTask(DEFAULT_WORKSPACE, created.id, { text: "Add a health check endpoint" });

    const run = await ops.assignTask(DEFAULT_WORKSPACE, created.id, task.id);

    expect(provider.specs).toHaveLength(1);
    const cwd = provider.specs[0]!.cwd!;
    expect(cwd).toBeTruthy();

    const claude = readFileSync(join(cwd, CLAUDE_MD_PATH), "utf8");
    expect(claude).toContain("The billing service owns invoicing");

    const copilot = readFileSync(join(cwd, COPILOT_INSTRUCTIONS_PATH), "utf8");
    expect(copilot).toContain("The billing service owns invoicing");

    expect(existsSync(join(cwd, CURSOR_RULE_PATH))).toBe(true);

    void run;
  });

  it("projects nothing when the project has no contextSummary yet", async () => {
    await store.putAgent({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
    const project = await ops.createProject(DEFAULT_WORKSPACE, { name: "Acme", goal: "Ship it", repoPath: repo });
    const task = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "Add a health check endpoint" });

    await ops.assignTask(DEFAULT_WORKSPACE, project.id, task.id);

    const cwd = provider.specs[0]!.cwd!;
    expect(existsSync(join(cwd, CLAUDE_MD_PATH))).toBe(false);
    expect(existsSync(join(cwd, COPILOT_INSTRUCTIONS_PATH))).toBe(false);
    expect(existsSync(join(cwd, CURSOR_RULE_PATH))).toBe(false);
  });
});
