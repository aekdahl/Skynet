// End-to-end proof of the approval policy in the REAL orchestrator: a command
// gate raised mid-run is auto-resolved (or not) per the project's approval level,
// through the same raise→resolve→deliver path a human approval uses — so the
// runner is resumed and the decision lands in the audit trail. Hermetic: a
// throwaway git repo + a scripted provider that raises one approval gate.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { ProviderId, Project, Agent, Task, Resolution, HitlItem, ApprovalLevel } from "@skynet/shared";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";
import type { Bus } from "../apps/server/src/bus.js";

class NullBus implements Bus {
  publish(): void {}
  subscribe(): () => void {
    return () => {};
  }
}

// Raises exactly one `approval` command gate shortly after start (via setTimeout
// so the orchestrator has registered the live handle first), and records any
// resume() the orchestrator delivers back.
class ApprovalProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  resumes: Resolution[] = [];
  constructor(private readonly command: string, private readonly risk: "low" | "medium" | "high") {}
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    setTimeout(() => {
      events.onHitl(spec.runId, {
        kind: "approval",
        title: `Run: ${this.command}`,
        why: "the agent wants to run a shell command",
        risk: this.risk,
        rationale: null,
        command: this.command,
        options: null,
        recommended: null,
        steps: null,
        diff: null,
      });
    }, 0);
    return {
      runId: spec.runId,
      provider: this.id,
      async pause() {},
      resume: async (decision?: Resolution) => {
        if (decision) this.resumes.push(decision);
      },
      async message() {},
      async stop() {},
    };
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
  repo = mkdtempSync(join(tmpdir(), "skynet-appr-repo-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "skynet-appr-wt-"));
  execFileSync("git", ["init", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@skynet.local"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
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

/** Assign a task to a fresh run whose scripted agent raises `command` at `risk`,
 *  under a project with the given approval `level`. Returns handles for asserting. */
async function run(level: ApprovalLevel, command: string, risk: "low" | "medium" | "high", opts: { trustRun?: boolean } = {}) {
  const store = new MemoryStore({ seed: false });
  const hub = new Hub(store, new NullBus());
  const provider = new ApprovalProvider(command, risk);
  const orchestrator = new Orchestrator(store, hub, provider);
  const pid = `p-${Math.round(Math.random() * 1e9)}`;
  await store.putProject({
    id: pid, workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [], status: "active",
    approvalLevel: level, approvalRules: [], repoPath: null, gitBacked: false,
  } as Project);
  await store.putAgent({ id: `a-${pid}`, workspaceId: DEFAULT_WORKSPACE, name: "a", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
  await store.putTask({ id: `t-${pid}`, workspaceId: DEFAULT_WORKSPACE, projectId: pid, text: "do it", state: "backlog", runId: null } as Task);
  const r = await orchestrator.assignTask(pid, `t-${pid}`);
  // Trust the run BEFORE its (setTimeout-scheduled) gate fires, mirroring an
  // operator picking "Allow rest of run" earlier in the run.
  if (opts.trustRun) orchestrator.trustRunCommands(r.id);
  const openApproval = async (): Promise<HitlItem | undefined> =>
    (await store.listQueue(DEFAULT_WORKSPACE)).find((q) => q.runId === r.id && q.kind === "approval" && q.resolvedAt == null);
  const anyApproval = async (): Promise<HitlItem | undefined> =>
    (await store.listQueue(DEFAULT_WORKSPACE)).find((q) => q.runId === r.id && q.kind === "approval");
  return { store, provider, run: r, openApproval, anyApproval };
}

describe("approval policy — auto-resolve in the orchestrator", () => {
  it("trusted auto-approves a medium command (runner resumed, no open gate, audited)", async () => {
    const t = await run("trusted", "npm test", "medium");
    await waitFor(async () => t.provider.resumes.length > 0);
    expect(t.provider.resumes[0]!.action).toBe("approve");
    expect(t.provider.resumes[0]!.by).toMatch(/^policy:trusted/);
    expect(await t.openApproval()).toBeUndefined(); // raised then resolved — nothing left waiting
    const audit = await t.store.listAudit(DEFAULT_WORKSPACE);
    expect(audit.some((a) => a.action === "approve" && a.operatorId.startsWith("policy:"))).toBe(true);
  });

  it("manual leaves the same command for a human (open gate, no resume)", async () => {
    const t = await run("manual", "npm test", "medium");
    await waitFor(async () => (await t.anyApproval()) != null);
    expect(await t.openApproval()).toBeDefined(); // still waiting on a human
    expect(t.provider.resumes).toHaveLength(0);
  });

  it("trusted still gates a high-risk boundary command (git push)", async () => {
    const t = await run("trusted", "git push origin main", "high");
    await waitFor(async () => (await t.anyApproval()) != null);
    expect(await t.openApproval()).toBeDefined(); // boundary op — always a human
    expect(t.provider.resumes).toHaveLength(0);
  });

  it("run trust ('allow rest of run') auto-approves a manual project's medium command", async () => {
    const t = await run("manual", "npm test", "medium", { trustRun: true });
    await waitFor(async () => t.provider.resumes.length > 0);
    expect(t.provider.resumes[0]!.by).toBe("policy:run");
    expect(await t.openApproval()).toBeUndefined();
  });
});
