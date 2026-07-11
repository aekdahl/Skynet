// ─── Orchestrator-backed executor ──────────────────────────────────────────
// Drives a scenario through the REAL Skynet orchestrator against a throwaway git
// repo, auto-resolving HITL gates, and captures artifacts (diff / log / hitl /
// status) for the judge. Boots the server stack in-process — no HTTP server.
//
// Real runs only: agents execute on the fleet runner's own provider (e.g.
// claude), which needs a credential present (ANTHROPIC_API_KEY, or the
// CLAUDE_CODE_OAUTH_TOKEN / gateway the runner-sdk understands). There is no
// mock — without a credential nothing runs, and the scenario surfaces that
// rather than grading a fake run. See README.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Artifacts, Executor, Scenario } from "./types.js";

const WORKSPACE = "cyberdyne"; // DEFAULT_WORKSPACE
const PROVIDER = process.env.SKYNET_EVAL_PROVIDER || "claude"; // the fleet runner's provider
const TIMEOUT_MS = Number(process.env.SKYNET_EVAL_TIMEOUT_MS ?? 180_000);

// Server singletons, lazily booted once (config is captured at import time, so
// env must be set before the first dynamic import — see makeExecutor()).
type Booted = {
  store: import("../apps/server/src/store/store.js").Store;
  hub: import("../apps/server/src/hub.js").Hub;
  bus: import("../apps/server/src/bus.js").Bus;
  orchestrator: import("../apps/server/src/orchestrator.js").Orchestrator;
  repo: string;
  baseSha: string; // the clean base commit; every scenario resets main to it
};
let booted: Promise<Booted> | null = null;

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

/** Capture the agent's net change for the judge — and, critically, never a
 *  silent empty string. The change lands on the agent branch (cut from `base`,
 *  so `base...branch` excludes the scenario fixture that sits on `base` and
 *  yields only the agent's edits). After a clean merge the agent branch may be
 *  pruned, so fall back to the project's integration branch, where the merged
 *  net change lives. If BOTH come up empty the agent finished without
 *  integrating anything — record why, rather than handing the judge a bare ""
 *  it can only read as "no evidence" (which is how a run silently scores 2/5). */
function captureDiff(
  repo: string,
  branch: string | undefined,
  projectId: string,
  finalStatus: string,
): { diff: string; diffNote: string } {
  const base = process.env.SKYNET_BASE_BRANCH || "main";
  const tryDiff = (range: string): string => {
    try {
      return git(repo, "diff", range);
    } catch {
      return ""; // ref may not exist (branch pruned, integration never created)
    }
  };
  if (branch) {
    const d = tryDiff(`${base}...${branch}`);
    if (d) return { diff: d, diffNote: "" };
  }
  const integ = `skynet/integration/${projectId}`;
  const merged = tryDiff(`${base}..${integ}`);
  if (merged) return { diff: merged, diffNote: `diff captured from ${integ} (agent branch unavailable)` };
  return {
    diff: "",
    diffNote:
      `no diff: agent branch ${branch ?? "(none)"} has no commit beyond ${base}, and ${integ} ` +
      `did not advance (finalStatus=${finalStatus}) — the runner finished without integrating a ` +
      `change (it likely errored/aborted before writing an edit, or produced no change).`,
  };
}

async function boot(): Promise<Booted> {
  // A throwaway integration repo with a `main` base commit. Every agent gets its
  // own worktree/branch cut from here.
  const repo = mkdtempSync(join(tmpdir(), "skynet-eval-repo-"));
  execFileSync("git", ["init", "-b", "main", repo]);
  git(repo, "config", "user.email", "eval@skynet.local");
  git(repo, "config", "user.name", "Skynet Eval");
  writeFileSync(join(repo, "README.md"), "# eval fixture\n");
  // Realistic ignores so an agent's test/tooling runs (e.g. `npx vitest` writing
  // node_modules/.vite caches) don't leak into the branch diff and swamp the
  // minimality signal — every real repo ignores these.
  writeFileSync(
    join(repo, ".gitignore"),
    ["node_modules/", "dist/", "*.log", ".DS_Store", ".vite/", "coverage/"].join("\n") + "\n",
  );
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "base");
  const baseSha = git(repo, "rev-parse", "HEAD");

  // Real runs only: agents execute on their fleet runner's own provider (there
  // is no mock). Without a provider credential, nothing runs and the scenario
  // surfaces that rather than grading a fake run.

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
  return { store, hub, bus, orchestrator, repo, baseSha };
}

export function makeExecutor(): Executor {
  return {
    async run(scenario: Scenario): Promise<Artifacts> {
      booted ??= boot();
      const { store, hub, bus, orchestrator, repo, baseSha } = await booted;
      const started = Date.now();

      // Isolate this scenario: reset main to the clean base, then lay down the
      // scenario's fixture as a commit the agent will branch from.
      git(repo, "checkout", "-f", "main");
      git(repo, "reset", "--hard", baseSha);
      git(repo, "clean", "-fd");
      if (scenario.fixture) {
        for (const [rel, content] of Object.entries(scenario.fixture)) {
          const abs = join(repo, rel);
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, content);
        }
        git(repo, "add", "-A");
        git(repo, "commit", "-m", `fixture: ${scenario.id}`);
      }

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
      // Give the agent the governing policy the way a real repo would (via its
      // instructions), so safety scenarios test judgment against a KNOWN policy
      // rather than telepathy. Judge sees it via `setup`; the agent sees it here.
      const taskText = scenario.policy ? `${scenario.task}\n\n[Repository policy] ${scenario.policy}` : scenario.task;
      await hub.upsertTask({ id: tid, workspaceId: WORKSPACE, projectId: pid, text: taskText, state: "backlog", agentId: null });

      // Capture events + resolve each HITL from the scenario's scripted replies
      // (consumed in order; default approve once exhausted).
      const hitl: NonNullable<Artifacts["hitl"]> = [];
      let replyIdx = 0;
      // The authoritative "what the agent produced" diff, captured at review time
      // (see below). We must grab it BEFORE approving the integrate gate, because
      // approving triggers the merge — which consumes the branch and leaves
      // `git diff main...branch` empty afterward.
      let reviewDiff = "";
      // Set when the success path raises its integrate gate. Lets the wait loop
      // tell a real "review" (changes awaiting merge) from a failure that also
      // parks the agent at "review" (runner error / needs-attention).
      let sawDiffReview = false;
      const unsub = bus.subscribe(WORKSPACE, (ev) => {
        if (ev.type !== "hitl.raised") return;
        const item = ev.item;
        // The final `diff` review gates the branch into the merge queue. It is NOT
        // one of the agent's own decision gates, so always approve it and don't
        // let it consume a scripted reply meant for a work gate.
        const isDiffReview = item.kind === "diff";
        if (isDiffReview) sawDiffReview = true;
        const reply = isDiffReview
          ? { action: "approve" as const }
          : scenario.replies?.[replyIdx++] ?? { action: "approve" as const };
        hitl.push({ kind: item.kind, title: item.title, why: item.why, resolvedWith: reply.action });
        const resolution = {
          action: reply.action,
          optionIndex: reply.optionIndex ?? null,
          guidance: reply.guidance ?? null,
          by: "eval",
          at: Date.now(),
        };
        void (async () => {
          // Capture the branch diff at review time — the branch is committed but
          // not yet merged, so this is the real proof of the agent's work.
          if (isDiffReview) {
            try {
              const a = await store.getAgent(item.agentId);
              if (a?.branch) reviewDiff = git(repo, "diff", `main...${a.branch}`);
            } catch {
              /* best-effort */
            }
          }
          const r = await hub.resolveHitl(item.id, resolution);
          if (r?.resolution?.at === resolution.at) await orchestrator.deliver(item, resolution);
        })();
      });

      let agentId = "";
      let finalStatus = "unknown";
      try {
        const agent = await orchestrator.assignTask(pid, tid);
        agentId = agent.id;

        // Wait for a terminal state: "done" (merged, or completed with no changes)
        // or a failure. A runner failure parks the agent at "review" with no
        // integrate gate pending — distinguish it from the transient "review" the
        // success path passes through (which always has a diff gate) via a short
        // grace window, so failed runs report promptly instead of timing out.
        const deadline = started + TIMEOUT_MS;
        let reviewSince = 0;
        while (Date.now() < deadline) {
          const a = await store.getAgent(agentId);
          finalStatus = a?.status ?? "gone";
          if (finalStatus === "done") break;
          if (finalStatus === "review" && !sawDiffReview) {
            if (!reviewSince) reviewSince = Date.now();
            else if (Date.now() - reviewSince > 2000) break; // failure / needs-attention, nothing to integrate
          } else {
            reviewSince = 0;
          }
          await new Promise((r) => setTimeout(r, 500));
        }

        const a = await store.getAgent(agentId);
        const log = (a?.log ?? []).map((l) => l.line);
        // Prefer the diff captured at review time (committed, before the merge
        // consumed the branch) — the most reliable proof of the agent's work.
        // When we never saw a review (no changes, timeout, or a failure parked at
        // "review"), fall back to captureDiff, which tries the branch/integration
        // ranges and records a diagnostic in `notes` instead of a silent empty "".
        let diff = reviewDiff;
        let diffNote = "";
        if (!diff) {
          ({ diff, diffNote } = captureDiff(repo, a?.branch, pid, finalStatus));
        }
        // A runner (not agent) failure — API 529/auth/crash — is an infra flake,
        // not an agent verdict. Flag it so `run` re-runs rather than scoring it.
        const failLine = log.find((l) => /runner failed|did not complete cleanly|529|Overloaded/i.test(l));
        return {
          diff,
          log,
          hitl,
          // The eval repo is local (no remote), so the "PR" analog is the
          // orchestrator's diff-review gate raised on completion ("approve to
          // integrate"). If it fired, the agent routed its change onto a branch
          // for review instead of writing to the default branch — that IS the
          // prOnly outcome. (Was hardcoded false, so this half was unscorable.)
          prOpened: hitl.some((h) => h.kind === "diff"),
          finalStatus,
          ...(failLine ? { runnerError: failLine } : {}),
          wallMs: Date.now() - started,
          notes: `provider=${PROVIDER}` + (diffNote ? ` · ${diffNote}` : ""),
        };
      } finally {
        unsub();
        if (agentId) await orchestrator.stopAgent(agentId).catch(() => undefined);
        // Best-effort: drop the agent branch (may already be gone after merge).
        // The next run's start-of-run reset restores main to the clean base.
        const a = await store.getAgent(agentId).catch(() => undefined);
        if (a?.branch) {
          try {
            git(repo, "branch", "-D", a.branch);
          } catch {
            /* already gone */
          }
        }
      }
    },
  };
}
