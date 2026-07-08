// ─── Orchestrator-backed executor ──────────────────────────────────────────
// Drives a scenario through the REAL Skynet orchestrator against a throwaway git
// repo, auto-resolving HITL gates, and captures artifacts (diff / log / hitl /
// status) for the judge. Boots the server stack in-process — no HTTP server.
//
// Smoke-test (no API key needed): RUNNER=mock exercises the whole loop with the
// canned mock runner. Real scenarios: leave RUNNER unset (uses the runner's
// provider, e.g. claude) with ANTHROPIC_API_KEY set. See README.md.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Artifacts, Executor, Scenario } from "./types.js";

const WORKSPACE = "cyberdyne"; // DEFAULT_WORKSPACE
const PROVIDER = process.env.SKYNET_EVAL_PROVIDER || "claude"; // runner's provider (RUNNER can override)
const TIMEOUT_MS = Number(process.env.SKYNET_EVAL_TIMEOUT_MS ?? 180_000);

// Server singletons, lazily booted once (config is captured at import time, so
// env must be set before the first dynamic import — see makeExecutor()).
type Booted = {
  store: import("../apps/server/src/store/store.js").Store;
  hub: import("../apps/server/src/hub.js").Hub;
  bus: import("../apps/server/src/bus.js").Bus;
  orchestrator: import("../apps/server/src/orchestrator.js").Orchestrator;
  repo: string;
};
let booted: Promise<Booted> | null = null;

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

async function boot(): Promise<Booted> {
  // A throwaway integration repo with a `main` base commit. Every agent gets its
  // own worktree/branch cut from here.
  const repo = mkdtempSync(join(tmpdir(), "skynet-eval-repo-"));
  execFileSync("git", ["init", "-b", "main", repo]);
  git(repo, "config", "user.email", "eval@skynet.local");
  git(repo, "config", "user.name", "Skynet Eval");
  writeFileSync(join(repo, "README.md"), "# eval fixture\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "base");

  // Point the orchestrator at the repo BEFORE importing config (import-time capture).
  process.env.STORE ??= "memory";
  process.env.BUS ??= "memory";
  process.env.SKYNET_INTEGRATION_REPO = repo;
  process.env.SKYNET_WORKTREES_DIR = join(repo, "..", "skynet-eval-wt-" + process.pid);
  process.env.SKYNET_BASE_BRANCH = "main";

  const { MemoryStore } = await import("../apps/server/src/store/memory.js");
  const { InProcessBus } = await import("../apps/server/src/bus.js");
  const { Hub } = await import("../apps/server/src/hub.js");
  const { Orchestrator } = await import("../apps/server/src/orchestrator.js");

  const store = new MemoryStore({ seed: false });
  const bus = new InProcessBus();
  const hub = new Hub(store, bus);
  const orchestrator = new Orchestrator(store, hub);
  return { store, hub, bus, orchestrator, repo };
}

export function makeExecutor(): Executor {
  return {
    async run(scenario: Scenario): Promise<Artifacts> {
      booted ??= boot();
      const { store, hub, bus, orchestrator, repo } = await booted;
      const started = Date.now();

      // Fleet runner + project + backlog task for this scenario.
      const rid = `runner-${scenario.id}`;
      await hub.upsertRunner({
        id: rid, workspaceId: WORKSPACE, name: rid,
        provider: PROVIDER as never, model: "opus-4.8", status: "idle", idleSince: started,
      });
      const pid = `proj-${scenario.id}`;
      await hub.upsertProject({
        id: pid, workspaceId: WORKSPACE, name: scenario.title, goal: scenario.task,
        agentIds: [], status: "active", repoPath: null, gitBacked: false,
      });
      const tid = `task-${scenario.id}`;
      await hub.upsertTask({ id: tid, workspaceId: WORKSPACE, projectId: pid, text: scenario.task, state: "backlog", agentId: null });

      // Capture events + auto-resolve every HITL (default: approve). A richer
      // per-scenario HITL script can key off scenario.hitl later.
      const hitl: NonNullable<Artifacts["hitl"]> = [];
      const unsub = bus.subscribe(WORKSPACE, (ev) => {
        if (ev.type === "hitl.raised") {
          const item = ev.item;
          hitl.push({ kind: item.kind, title: item.title, why: item.why, resolvedWith: "approve" });
          const resolution = { action: "approve" as const, optionIndex: null, guidance: null, by: "eval", at: Date.now() };
          void hub.resolveHitl(item.id, resolution).then((r) => {
            if (r?.resolution?.at === resolution.at) void orchestrator.deliver(item, resolution);
          });
        }
      });

      let agentId = "";
      let finalStatus = "unknown";
      try {
        const agent = await orchestrator.assignTask(pid, tid);
        agentId = agent.id;

        // Wait until the agent reaches a terminal state (done) or we time out.
        const deadline = started + TIMEOUT_MS;
        while (Date.now() < deadline) {
          const a = await store.getAgent(agentId);
          finalStatus = a?.status ?? "gone";
          if (finalStatus === "done") break;
          await new Promise((r) => setTimeout(r, 500));
        }

        const a = await store.getAgent(agentId);
        const log = (a?.log ?? []).map((l) => l.line);
        let diff = "";
        try {
          diff = git(repo, "diff", `main...${a?.branch ?? "HEAD"}`);
        } catch {
          /* branch may be gone after merge; diff is best-effort */
        }
        return {
          diff,
          log,
          hitl,
          prOpened: false,
          finalStatus,
          wallMs: Date.now() - started,
          notes: `provider=${PROVIDER} runnerOverride=${process.env.RUNNER ?? "(none)"}`,
        };
      } finally {
        unsub();
        if (agentId) await orchestrator.stopAgent(agentId).catch(() => undefined);
        // Drop the agent branch so repeated runs don't collide.
        const a = await store.getAgent(agentId).catch(() => undefined);
        if (a?.branch) git(repo, "branch", "-D", a.branch);
      }
    },
  };
}
