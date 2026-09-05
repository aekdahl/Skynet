// Memory v0, phase 1 — does a project's `.skynet/memory/*.md` facts actually
// reach the real StartSpec.task a runner receives, at the genuine "an agent
// is starting FRESH" moments (assign, fork, reassign/escalation-relaunch) —
// not just prove the pure factsDigest/buildAgentContext functions themselves
// (see memory-digest.test.ts / agent-context.test.ts). Real git worktrees,
// same harness as agent-context-wiring.test.ts / roadmap-proposal-governance.test.ts,
// since memory is read straight off disk for a repoPath-bound project.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { Agent, Project, ProviderId, ServerEvent, Task } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { Operations } from "../apps/server/src/operations.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

class NullBus implements Bus {
  publish(): void {}
  subscribe(): () => void {
    return () => {};
  }
}

class RecordingProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  starts: StartSpec[] = [];
  async start(spec: StartSpec, _events: RunnerEvents): Promise<RunnerHandle> {
    this.starts.push(spec);
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

let repo: string;
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "skynet-memory-wiring-"));
  execFileSync("git", ["init", "-b", "main", repo]);
  git("config", "user.email", "t@t.local");
  git("config", "user.name", "T");
  writeFileSync(join(repo, "README.md"), "hi\n");
  git("add", "-A");
  git("commit", "-m", "init");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

const writeMemoryFile = (relPath: string, content: string) => {
  const abs = join(repo, ".skynet", "memory", relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
};

const WORKSPACE_MEMORY = `---
skynet_memory_version: 0.1
scope: workspace
---

## Never touch the payments module without a human review
<!-- skynet:fact id=f1 source=operator author=jordan created=2026-08-01T00:00:00.000Z confidence=stated -->

The last agent that touched it broke prod billing.
`;

const AGENT_MEMORY = `---
skynet_memory_version: 0.1
scope: agent
agent_family: claude
---

## Prefer small, focused commits
<!-- skynet:fact id=f2 source=operator author=jordan created=2026-08-01T00:00:00.000Z confidence=stated -->
`;

async function setup() {
  const store = new MemoryStore({ seed: false });
  const hub = new Hub(store, new NullBus());
  const provider = new RecordingProvider();
  const orchestrator = new Orchestrator(store, hub, provider);
  const ops = new Operations({ store, hub, orchestrator });
  const project: Project = {
    id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "Acme", goal: "", runIds: [],
    status: "active", repoPath: repo, gitBacked: true, repo: null, syncSourceStatus: false,
  } as Project;
  await store.putProject(project);
  const runner: Agent = {
    id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0,
  };
  await store.putAgent(runner);
  return { store, orchestrator, ops, provider, project };
}

describe("memory injection wiring — assignTask", () => {
  it("workspace + agent-family facts both reach the real StartSpec.task", async () => {
    writeMemoryFile("workspace.md", WORKSPACE_MEMORY);
    writeMemoryFile("agents/claude.md", AGENT_MEMORY);
    const { store, orchestrator, provider } = await setup();
    const task: Task = { id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "Add a health check endpoint", state: "todo", runId: null } as Task;
    await store.putTask(task);

    await orchestrator.assignTask("p1", "t1");

    expect(provider.starts).toHaveLength(1);
    const { task: prompt } = provider.starts[0]!;
    expect(prompt).toContain("=== MEMORY (operator-authored facts) ===");
    expect(prompt).toContain("[workspace]");
    expect(prompt).toContain("Never touch the payments module without a human review");
    expect(prompt).toContain("The last agent that touched it broke prod billing.");
    expect(prompt).toContain("[claude]");
    expect(prompt).toContain("Prefer small, focused commits");
  });

  it("a project with no memory files gets no MEMORY section at all — not an empty/error one", async () => {
    const { store, orchestrator, provider } = await setup();
    const task: Task = { id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "Add a health check endpoint", state: "todo", runId: null } as Task;
    await store.putTask(task);

    await orchestrator.assignTask("p1", "t1");

    expect(provider.starts).toHaveLength(1);
    expect(provider.starts[0]!.task).not.toContain("=== MEMORY");
  });

  it("a chat-only project (no repoPath/repo) is skipped cleanly — no MEMORY section, no error", async () => {
    const store = new MemoryStore({ seed: false });
    const hub = new Hub(store, new NullBus());
    const provider = new RecordingProvider();
    const orchestrator = new Orchestrator(store, hub, provider);
    const project: Project = {
      id: "p2", workspaceId: DEFAULT_WORKSPACE, name: "Chat Only", goal: "", runIds: [],
      status: "active", repoPath: null, gitBacked: false, repo: null, syncSourceStatus: false,
    } as Project;
    await store.putProject(project);
    await store.putAgent({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 });
    const task: Task = { id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p2", text: "Draft an answer", state: "todo", runId: null } as Task;
    await store.putTask(task);

    await orchestrator.assignTask("p2", "t1");

    expect(provider.starts).toHaveLength(1);
    expect(provider.starts[0]!.task).not.toContain("=== MEMORY");
  });
});

