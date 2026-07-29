// ─── Orchestrator ─────────────────────────────────────────────────────────
// TaskRun lifecycle (Backend Brief §04): provision a runner, start an agent on a
// task, route HITL gates, deliver decisions, fork, complete. Phase 0 uses the
// mock runner; real providers drop in behind the same runner-sdk interface.

import type { TaskRun, HitlItem, Project, Resolution, Agent, Task, TaskAssignment, ProviderId, ProviderInfo } from "@skynet/shared";
import {
  type HitlRaise,
  type RunnerEvents,
  type RunnerHandle,
  type RunnerProvider,
} from "@skynet/runner-sdk";
import { basename } from "node:path";
import { classifyCommand } from "./command-safety.js";
import { decideAutoApproval } from "./approval-policy.js";
import { config, now } from "./config.js";
import { githubService } from "./github/index.js";
import type { Hub } from "./hub.js";
import { MergeEngine, type MergeRequest } from "./merge.js";
import { loadModuleMap, type ModuleMap } from "./modules-map.js";
import { providerUsableFromEnv } from "./provider-env.js";
import { secretService } from "./secrets/index.js";
import { previewService } from "./preview/index.js";
import { projectPreview } from "./preview/project-preview.js";
import type { Store } from "./store/store.js";
import { WorktreeProvisioner } from "./worktrees.js";

interface LiveAgent {
  handle: RunnerHandle;
  agentId: string | null;
  taskId: string | null;
  /** The agent's branch (used as its merge-queue source). */
  branch: string;
  /** Set when the agent runs in a real worktree; enables the commit→review→merge
   *  loop. The ref the branch was cut from, for diffing. */
  baseRef?: string;
  /** The git backend (worktrees + merge queue) this agent is integrating into,
   *  resolved from its project's repo. Unset in the Phase 0 / no-repo flow. */
  git?: GitContext;
  /** Set when a question this agent raised went unanswered and was auto-resolved
   *  by the no-operator-answer timeout. If it then finishes with no change, it's
   *  surfaced as needs-attention rather than a silent "done". */
  blockedUnanswered?: boolean;
}

/** The git integration backend bound to one repo: an isolated worktree per agent
 *  feeding a serialized merge queue. Resolved per project (its own local repo
 *  when git-backed, else the server-global integration repo) and cached by repo
 *  path so each repo keeps exactly one worktree provisioner + one merge queue. */
interface GitContext {
  repo: string;
  worktrees: WorktreeProvisioner;
  merge: MergeEngine;
}

export class NoCapacityError extends Error {
  constructor(message?: string) {
    super(message ?? "No idle runner available");
    this.name = "NoCapacityError";
  }
}

/** No runner can execute — the fleet is empty, or the executor has no API key.
 *  The route maps this to 409 so agent creation is refused rather than spawning
 *  an agent that can only fail. */
export class RunnerNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerNotConfiguredError";
  }
}

/** A task can't be assigned because it's already handled (assigned or done). The
 *  route maps this to 409 so a double-assign is rejected, never double-spawned. */
export class TaskAlreadyAssignedError extends Error {
  constructor(message: string, readonly agent?: TaskRun) {
    super(message);
    this.name = "TaskAlreadyAssignedError";
  }
}

/**
 * PURE: extract a trailing `{"estMinutes": N}` JSON tag off the triage LLM's
 * reply. Returns the body (with the tag stripped) and the parsed minutes when
 * present. Tolerates a code fence around the tag; ignores non-numeric or
 * malformed values (a bad tag stays a missing estimate — never fabricates a
 * duration). Exported for the unit tests.
 */
export function splitEstMinutesTag(raw: string): { body: string; estMinutes: number | null } {
  const trimmed = (raw ?? "").trim();
  const noFence = trimmed.replace(/\n?```\s*$/, "").trimEnd();
  // Match the LAST balanced top-level {...} on the tail.
  const end = noFence.lastIndexOf("}");
  if (end === -1) return { body: trimmed, estMinutes: null };
  let depth = 0;
  let start = -1;
  for (let i = end; i >= 0; i--) {
    const c = noFence[i];
    if (c === "}") depth++;
    else if (c === "{") {
      depth--;
      if (depth === 0) { start = i; break; }
    }
  }
  if (start < 0) return { body: trimmed, estMinutes: null };
  try {
    const obj = JSON.parse(noFence.slice(start, end + 1)) as { estMinutes?: unknown };
    if (typeof obj.estMinutes === "number" && Number.isFinite(obj.estMinutes) && obj.estMinutes > 0) {
      const body = noFence.slice(0, start).replace(/```[a-zA-Z]*\s*$/, "").trim();
      return { body, estMinutes: Math.round(obj.estMinutes) };
    }
  } catch {
    /* not a JSON tail — whole reply is the body */
  }
  return { body: trimmed, estMinutes: null };
}

export class Orchestrator {
  private live = new Map<string, LiveAgent>();
  // Global kill switch. When paused, the autonomy loop is a no-op (no new work is
  // triaged, picked, or auto-reviewed) — set by the Telegram /stop kill switch and
  // cleared by /resume. The janitorial loops (reaper/GC) are deliberately NOT
  // gated by this: "stop all processing" means halt live runs + pause autonomy,
  // not freeze orphan cleanup.
  private paused = false;
  private chatWaiters = new Map<string, (reply: string) => void>();
  // Pending no-operator-answer timers for open `question` HITLs, keyed by item id.
  private questionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private seq = 0;
  // Serializes runner acquisition (find-idle → mark-busy). The find and the busy
  // write are separated by an `await`, so without this two concurrent acquires
  // could both observe the SAME idle runner and hand it to two agents (TOCTOU
  // double-booking). Every acquire chains onto this promise so the read-check-
  // write runs atomically; a busy-marked runner is persisted before the next
  // acquire's find() reads, so it can never be re-selected. Mirrors the Hub's
  // per-hitl-id resolve mutex.
  private acquireLock: Promise<unknown> = Promise.resolve();
  // One lazily-loaded provider backend per provider id (real backends are heavy).
  private providers = new Map<string, Promise<RunnerProvider>>();
  // One module map per repo path, resolved from a project's OWN repo when it's
  // git-backed (its `.skynet/modules.json`), else the server-global integration
  // repo. Cached so the map file is read at most once per repo, not per diff —
  // and so a project bound to its own repo never silently uses the fallback of
  // some other repo's catalog. See moduleMapFor().
  private moduleMaps = new Map<string, ModuleMap>();
  // One git backend per repo path (worktrees + serialized merge queue), built on
  // demand. Keyed by repo so a project's local repo and the global integration
  // repo each get their own queue.
  private gitCtx = new Map<string, GitContext>();
  // Runs parked at a diff review, keyed by runId. The live entry is dropped when
  // a review is raised (compute is freed while a human reviews), so this holds
  // the little that a `modify` needs to resume the run for a revision in its
  // still-present worktree (see reviseAfterReview / deliver()). Cleared on merge.
  private reviews = new Map<string, { git: GitContext; baseRef: string; taskId: string | null }>();
  // Runs HALTED on an escalation (agent gave up, too long, or too many failures),
  // keyed by runId. Holds the worktree/git context a resume/reassign needs even
  // after the live handle is torn down. Presence = "already escalated" (so a
  // guard doesn't re-raise). Cleared when the escalation is resolved or the run
  // completes. See escalate() / deliverEscalation() / relaunchEscalated().
  private escalations = new Map<string, { git?: GitContext; baseRef?: string; taskId: string | null; source: string }>();
  // Per-run failure counter (onFailed): past config.runMaxFailures the run is
  // escalated instead of parked in `review`. Cleared on success/resolution.
  private failCounts = new Map<string, number>();

  // `providerOverride` is a test seam — inject a runner provider directly instead
  // of resolving the runner's own provider. Production always passes (store, hub) only.
  constructor(private store: Store, private hub: Hub, private providerOverride?: RunnerProvider) {}

  /** Build (or reuse) the git backend for a repo path. Cached so each repo keeps
   *  exactly one worktree provisioner and one serialized merge queue (§2). */
  private gitContextForRepo(repo: string): GitContext {
    let ctx = this.gitCtx.get(repo);
    if (!ctx) {
      const worktrees = new WorktreeProvisioner(repo, config.baseBranch, config.worktreesDir);
      const merge = new MergeEngine(
        repo,
        config.baseBranch,
        {
          onMerged: (req) => this.completeMerged(req.runId, req.agentBranch),
          onConflict: (req, files) => this.raiseMergeHitl(req, files),
          onChecksFailed: async (req, out) => {
            await this.hub.runLog(req.runId, `checks failed: ${out.slice(0, 200)}`);
            await this.hub.runStatus(req.runId, "review");
          },
          onMergeFailed: (req, reason) => this.raiseMergeFailedHitl(req, reason),
          onLog: (id, line) => void this.hub.runLog(id, line),
        },
        config.checkCmd,
        worktrees.root, // scratch integration worktrees live beside the agent worktrees
      );
      ctx = { repo, worktrees, merge };
      this.gitCtx.set(repo, ctx);
    }
    return ctx;
  }

  /** Resolve the git backend for a project: its own local repo when git-backed,
   *  else the server-global integration repo, else none (Phase 0 → runnerCwd). */
  private gitContextFor(project?: Project | null): GitContext | undefined {
    const repo = project?.gitBacked && project.repoPath ? project.repoPath : config.integrationRepo;
    return repo ? this.gitContextForRepo(repo) : undefined;
  }

  /** Resolve (and cache) the module map for a project: its own repo when
   *  git-backed (reads `<repoPath>/.skynet/modules.json`), else the server-global
   *  integration repo. Cached per repo path so the map is read once, and so a
   *  project's own catalog is used rather than a static global one (#3). */
  private moduleMapFor(project?: Project | null): ModuleMap {
    const repo = project?.gitBacked && project.repoPath ? project.repoPath : config.integrationRepo;
    const key = repo ?? "";
    let map = this.moduleMaps.get(key);
    if (!map) {
      map = loadModuleMap(repo);
      this.moduleMaps.set(key, map);
    }
    return map;
  }

  /** Resolve the git backend for an existing agent (prefers the live entry, else
   *  looks it up via the agent's project). Used by post-completion cleanup. */
  private async gitContextForAgent(runId: string): Promise<GitContext | undefined> {
    const live = this.live.get(runId);
    if (live?.git) return live.git;
    const agent = await this.store.getRun(runId);
    const project = agent ? await this.store.getProject(agent.projectId) : null;
    return this.gitContextFor(project);
  }

  // Resolve the execution backend for an agent. The provider is the fleet
  // runner's own provider (runner.provider) — there is no global override and no
  // mock. Real backends load on demand (heavy) and are cached per id.
  private getProvider(id: string): Promise<RunnerProvider> {
    // Test seam: an injected provider short-circuits resolution.
    if (this.providerOverride) return Promise.resolve(this.providerOverride);
    let p = this.providers.get(id);
    if (!p) {
      p = (() => {
        switch (id) {
          case "claude":
            return import("@skynet/runner-sdk/claude").then((m) => new m.ClaudeRunnerProvider());
          case "codex":
            return import("@skynet/runner-sdk/codex").then((m) => new m.CodexRunnerProvider());
          case "gemini":
            return import("@skynet/runner-sdk/gemini").then((m) => new m.GeminiRunnerProvider());
          case "cursor":
            return import("@skynet/runner-sdk/cursor").then((m) => new m.CursorRunnerProvider());
          case "copilot":
            return import("@skynet/runner-sdk/copilot").then((m) => new m.CopilotRunnerProvider());
          case "hermes":
            return import("@skynet/runner-sdk/hermes").then((m) => new m.HermesRunnerProvider());
          default:
            // An unresolvable provider is a loud error — there is no mock fallback.
            return Promise.reject(new Error(`Unknown runner provider "${id}" (expected claude|codex|gemini|cursor|copilot|hermes).`));
        }
      })();
      this.providers.set(id, p);
    }
    return p;
  }

  private slug(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32);
  }

  private events(): RunnerEvents {
    return {
      onLog: (runId, line, detail) => void this.hub.runLog(runId, line, detail),
      onProgress: (runId, progress, plan) => void this.hub.runProgress(runId, progress, plan),
      onUsage: (runId, usage) => void this.hub.runUsage(runId, usage),
      onHeartbeat: (runId) => void this.hub.runHeartbeat(runId),
      // "done" is the ORCHESTRATOR's decision, made in complete()/completeMerged
      // only AFTER a finished agent's diff has been committed → reviewed → merged
      // (or confirmed genuinely empty). A runner that flips itself to "done" on
      // finish() would mark the agent done while its edits are still uncommitted;
      // an observer polling that window sees a premature "done" with an empty diff
      // and the work looks silently dropped. Ignore a runner-emitted "done" here —
      // onCompleted drives the real terminal transition. Other statuses
      // (running/waiting/review) pass through unchanged.
      onStatus: (runId, status) => {
        if (status === "done") return;
        void this.hub.runStatus(runId, status);
      },
      onHitl: (runId, raise) => void this.raise(runId, raise),
      onCompleted: (runId, branch) => void this.complete(runId, branch),
      onFailed: (runId, reason) => void this.fail(runId, reason),
      onChatReply: (runId, text) => {
        const waiter = this.chatWaiters.get(runId);
        if (waiter) {
          waiter(text);
          this.chatWaiters.delete(runId);
        }
        void this.hub.runLog(runId, `↳ ${text}`);
      },
    };
  }

  private async raise(runId: string, raise: HitlRaise): Promise<void> {
    const agent = await this.store.getRun(runId);
    if (!agent) return;
    // A clarifying `question` gets an optional no-operator-answer deadline so a
    // headless/idle run doesn't hang forever waiting on a human (0 = disabled).
    const timeout = config.hitlQuestionTimeoutMs;
    const expiresAt = raise.kind === "question" && timeout > 0 ? now() + timeout : null;
    // Enrich a command-approval gate with the safety classifier's real severity +
    // reason, so the operator sees WHY it's risky (not just a flat "medium"). The
    // runner already decided to gate; this only adds honest, specific context.
    let risk = raise.risk;
    const why = raise.why;
    let flags: string[] = [];
    if (raise.kind === "approval" && raise.command) {
      const verdict = classifyCommand(raise.command);
      const rank = { low: 0, medium: 1, high: 2 } as const;
      if (rank[verdict.risk] > rank[risk]) risk = verdict.risk;
      // Surface the classifier's real reasons as scannable chips (not buried in
      // prose) so the operator sees exactly WHY this needs approval.
      if (verdict.risk !== "low") flags = verdict.reasons.filter((r) => !/read-only|no-op/i.test(r));
    }
    const item: HitlItem = {
      id: `q-${runId}-${++this.seq}`,
      workspaceId: agent.workspaceId,
      runId,
      kind: raise.kind,
      title: raise.title,
      why,
      risk,
      rationale: raise.rationale ?? null,
      raisedAt: now(),
      expiresAt,
      resolvedAt: null,
      resolution: null,
      command: raise.command ?? null,
      options: raise.options ?? null,
      recommended: raise.recommended ?? null,
      steps: raise.steps ?? null,
      diff: raise.diff ?? null,
      flags: raise.kind === "escalation" ? [...flags, "agent"] : flags,
    };
    // Auto-approve a reversible, in-sandbox command gate per the project's
    // approval policy (see approval-policy.ts), so the operator isn't asked to
    // confirm every command. Boundary ops (high-risk / deny) and non-command
    // gates fall through to a human. The gate is still raised + recorded, then
    // immediately resolved through the normal path, so the audit trail shows
    // exactly what was auto-approved and by which policy — nothing runs invisibly.
    if (raise.kind === "approval") {
      const project = await this.store.getProject(agent.projectId);
      const auto = decideAutoApproval({
        command: raise.command,
        level: project?.approvalLevel ?? "trusted",
        rules: project?.approvalRules ?? [],
      });
      if (auto) {
        await this.hub.raiseHitl(item);
        const resolution: Resolution = { action: "approve", optionIndex: null, guidance: null, by: auto.by, at: now() };
        await this.hub.runLog(runId, `auto-approved (${auto.by}): ${item.command ?? item.title}`);
        const resolved = await this.hub.resolveHitl(item.id, resolution);
        if (resolved && resolved.resolution?.at === resolution.at) await this.deliver(item, resolution);
        return;
      }
    }
    // Agent-driven escalation: the run is HALTED on the live gate. Capture the
    // worktree/git context so a later resume/reassign works, and mark it escalated.
    if (raise.kind === "escalation") {
      const live = this.live.get(runId);
      this.escalations.set(runId, { git: live?.git, baseRef: live?.baseRef, taskId: live?.taskId ?? null, source: "agent" });
      await this.hub.runStatus(runId, "waiting"); // an escalation gate always blocks the run
      await this.hub.runLog(runId, `escalated by the agent — ${raise.title}`);
    }
    await this.hub.raiseHitl(item);
    if (expiresAt != null) {
      this.questionTimers.set(item.id, setTimeout(() => void this.expireQuestion(item), timeout));
    }
  }

  /** No operator answered a `question` within its window: auto-resolve it as
   *  "no answer" through the normal resolve→deliver path so the audit records it,
   *  the Inbox clears, and the agent is told to conclude WITHOUT guessing. */
  private async expireQuestion(item: HitlItem): Promise<void> {
    this.questionTimers.delete(item.id);
    const current = await this.store.getHitl(item.id);
    if (!current || current.resolvedAt != null) return; // a human got there first
    const resolution: Resolution = {
      action: "reject",
      optionIndex: null,
      guidance: null,
      by: "system:timeout",
      at: now(),
    };
    const resolved = await this.hub.resolveHitl(item.id, resolution);
    if (resolved && resolved.resolution?.at === resolution.at) {
      // Remember the agent concluded only because its question went unanswered,
      // so complete() can surface it as needs-attention instead of "done".
      const live = this.live.get(item.runId);
      if (live) live.blockedUnanswered = true;
      await this.hub.runLog(
        item.runId,
        `no operator answer within ${Math.round(config.hitlQuestionTimeoutMs / 1000)}s — asking the agent to conclude without guessing`,
      );
      await this.deliver(item, resolution);
    }
  }

  private async complete(runId: string, branch: string): Promise<void> {
    const live = this.live.get(runId);
    // The agent finished a turn → it's no longer failing/stuck; reset the guards.
    this.failCounts.delete(runId);
    this.escalations.delete(runId);

    // Real loop: the agent ran in an isolated worktree → commit its diff onto
    // its branch and raise a review. Approving it enqueues the branch onto the
    // merge queue (deliver → merge.enqueue → completeMerged).
    if (live?.git && live.baseRef !== undefined) {
      const wt = live.git.worktrees;
      const agent = await this.store.getRun(runId);
      const res = await wt
        .commitAll(runId, `Skynet agent ${runId}${agent ? `: ${agent.name}` : ""}`)
        .catch((err) => {
          void this.hub.runLog(runId, `commit failed: ${(err as Error).message}`);
          // A git error is NOT "nothing to integrate" — the agent may have real
          // edits we simply couldn't commit. Falling through to done would drop
          // them silently, so surface it for attention instead.
          return { committed: false, error: true } as const;
        });

      if (res.committed) {
        const stat = await wt.diffStat(runId, live.baseRef);
        await this.freeRunner(live.agentId); // compute is done; awaiting review
        await this.hub.runStatus(runId, "review");
        // The run produced a diff → its task enters the review column (a human or
        // an autonomous reviewer resolves the diff HITL, which merges → done).
        if (live.taskId) {
          const task = await this.store.getTask(live.taskId);
          if (task) await this.hub.upsertTask({ ...task, state: "review" });
        }
        await this.raiseDiffReview(runId, stat);
        // Keep what a `modify` review resolution needs to resume this run for a
        // revision — its worktree survives (retire only happens on merge).
        this.reviews.set(runId, { git: live.git, baseRef: live.baseRef, taskId: live.taskId });
        this.live.delete(runId);
        return;
      }

      if ("error" in res && res.error) {
        // Couldn't commit a finished agent's worktree — needs-attention, never a
        // silent "done" that would lose the (possibly real) uncommitted work.
        await this.freeRunner(live.agentId);
        await this.hub.runStatus(runId, "review");
        this.live.delete(runId);
        return;
      }

      // Nothing to integrate — retire the worktree and complete plainly.
      await this.hub.runLog(runId, "no changes to integrate");
      await wt.retire(runId).catch(() => undefined);
    } else if (live?.git) {
      await live.git.worktrees.retire(runId).catch(() => undefined);
    }

    // Reached here with no diff. If the agent only stopped because a question it
    // raised went unanswered, it did no real work — surface it as needs-attention
    // (never a silent "done"), leave its task open, and don't mark it completed.
    if (live?.blockedUnanswered) {
      await this.freeRunner(live.agentId);
      await this.hub.runStatus(runId, "review");
      await this.hub.runLog(runId, "concluded without an answer to its question — needs attention (no change made)");
      this.live.delete(runId);
      return;
    }

    // Phase 0 / no-diff completion: free the runner, finish the task & agent.
    // The orchestrator sets "done" HERE (not the runner) — this is the only place
    // a genuinely change-free agent becomes terminal, so a runner's own "done" is
    // ignored (see events().onStatus) and can never precede real integration.
    await this.freeRunner(live?.agentId ?? null);
    if (live?.taskId) {
      const task = await this.store.getTask(live.taskId);
      if (task) await this.hub.upsertTask({ ...task, state: "done" });
    }
    await this.hub.runStatus(runId, "done");
    await this.hub.runCompleted(runId, branch);
    this.live.delete(runId);
  }

  /**
   * A runner could not execute (binary missing, auth failure, crash). Surface it
   * loudly and free the runner — but never mark the agent done, complete the
   * task, or integrate a branch. A broken runner must not look like success.
   */
  private async fail(runId: string, reason: string): Promise<void> {
    // Count failures on this run; past the threshold, hand it to a human
    // (escalation) instead of quietly parking in `review` for another doomed try.
    const count = (this.failCounts.get(runId) ?? 0) + 1;
    this.failCounts.set(runId, count);
    if (config.runMaxFailures > 0 && count >= config.runMaxFailures) {
      await this.escalate(runId, `${count} failed attempts — latest: ${reason}`, "failures");
      return;
    }
    const live = this.live.get(runId);
    await this.freeRunner(live?.agentId ?? null);
    await this.hub.runLog(runId, `runner failed — ${reason}. Not completed; needs attention.`);
    await this.hub.runStatus(runId, "review"); // visible needs-attention, NOT "done"
    if (live?.git) await live.git.worktrees.retire(runId).catch(() => undefined);
    this.live.delete(runId);
  }

  /** Startup failed (no runner configured, worktree provisioning, runner.start
   *  threw): free the runner, surface it, and leave the agent visibly errored —
   *  never silently degraded. The caller rethrows so the API returns the error. */
  private async failStartup(runId: string, agentId: string, reason: string): Promise<void> {
    await this.freeRunner(agentId);
    await this.hub.runLog(runId, `failed to start — ${reason}. Needs attention.`);
    await this.hub.runStatus(runId, "review");
    // A worktree may have been provisioned before start threw — retire it.
    const ctx = await this.gitContextForAgent(runId).catch(() => undefined);
    if (ctx) await ctx.worktrees.retire(runId).catch(() => undefined);
    this.live.delete(runId);
  }

  /** Return a runner to the idle pool (no-op if it's already gone). */
  private async freeRunner(agentId: string | null): Promise<void> {
    if (!agentId) return;
    const runner = await this.store.getAgent(agentId);
    if (runner) await this.hub.upsertAgent({ ...runner, status: "idle", idleSince: now() });
  }

  /** Raise the `diff` review that gates a finished agent's branch into the queue. */
  private async raiseDiffReview(runId: string, stat: { add: number; del: number; files: string[] }): Promise<void> {
    const agent = await this.store.getRun(runId);
    if (!agent) return;
    // Modules the diff ACTUALLY touched, derived from the changed files via the
    // project's own module map — not the agent's declared scope (`agent.modules`,
    // initialized []), which would under- or mis-report what changed (#6).
    const project = await this.store.getProject(agent.projectId);
    const modules = this.moduleMapFor(project).modulesForFiles(stat.files);
    // Record what actually changed on the run so every view reflects it (the run
    // itself, not just the review card). `modifiedFiles` was never populated.
    await this.hub.runModifiedFiles(runId, stat.files);
    await this.hub.raiseHitl({
      id: `q-diff-${runId}-${++this.seq}`,
      workspaceId: agent.workspaceId,
      runId,
      kind: "diff",
      // Concise, scannable title — the run/task is shown separately in every view
      // (queue card, audit row, run header), so embedding the whole task prompt
      // here just bloats the row. The stats + branch live in `why`.
      title: `Review diff — ${stat.add}+/${stat.del}− (${stat.files.length} file${stat.files.length === 1 ? "" : "s"})`,
      why: `Finished on ${agent.branch} — ${stat.add}+/${stat.del}- across ${stat.files.length} file(s). Approve to integrate.`,
      risk: stat.del > 200 || stat.files.length > 40 ? "high" : "medium",
      raisedAt: now(),
      expiresAt: null,
      resolvedAt: null,
      resolution: null,
      rationale: null,
      command: null,
      options: null,
      recommended: null,
      steps: null,
      diff: { add: stat.add, del: stat.del, modules },
      flags: [],
    });
  }

  /**
   * Whether a provider can actually execute: a CLI-login provider (cursor /
   * copilot), a provider with a credential env var, or one with a stored
   * per-workspace secret. There is no mock — no credential means nothing runs.
   */
  private async providerUsable(
    workspaceId: string,
    provider: Agent["provider"],
    credentialId?: string | null,
  ): Promise<boolean> {
    // An injected provider (test seam / a deliberately-supplied backend, see
    // getProvider) is a working provider — credentialing is the injector's
    // responsibility, so it's usable regardless of env/secret.
    if (this.providerOverride) return true;
    const credId = credentialId ?? provider;
    if (credId === provider) {
      // Default credential: broad ambient-env detection (OAuth/gateway tokens too)
      // OR a stored default key.
      if (providerUsableFromEnv(provider)) return true;
      return (await secretService.resolve(workspaceId, provider)) !== undefined;
    }
    // Named credential: no ambient-env fallback — it must carry its own stored key.
    return (await secretService.resolve(workspaceId, credId)) !== undefined;
  }

  /**
   * Run a runner-acquisition critical section serially. Each call chains onto the
   * previous one so the find-idle → mark-busy sequence inside `fn` is atomic with
   * respect to every other acquisition, closing the double-booking TOCTOU. A
   * prior failure never poisons the chain (we swallow it for the NEXT waiter; the
   * failing call still rejects to its own caller).
   */
  private acquireExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.acquireLock.catch(() => undefined).then(fn);
    this.acquireLock = run.catch(() => undefined);
    return run;
  }

  /** Acquire an idle agent whose provider can actually execute; mark it busy.
   *  Serialized via acquireExclusive so find-idle → mark-busy is atomic (closes
   *  the double-booking TOCTOU). Empty fleet or no key for any idle agent →
   *  RunnerNotConfiguredError (409); agents exist but all busy → NoCapacityError. */
  private acquireAgent(
    workspaceId: string,
    eligible?: TaskAssignment,
  ): Promise<{ id: string; provider: TaskRun["provider"]; model: string; credentialId: string | null }> {
    return this.acquireExclusive(async () => {
      const runners = await this.store.listAgents(workspaceId);
      if (runners.length === 0) {
        throw new RunnerNotConfiguredError("No agent configured — add one in Fleet before assigning tasks.");
      }
      // `agents` mode restricts the pool to the eligible set; `any`/undefined
      // considers the whole fleet (historical behavior).
      const inPool = (id: string) =>
        eligible?.mode === "agents" ? eligible.agentIds.includes(id) : true;
      const eligibleRunners = runners.filter((r) => inPool(r.id));
      if (eligible?.mode === "agents" && eligibleRunners.length === 0) {
        throw new NoCapacityError("None of this task's assigned agents exist in the fleet.");
      }
      const idle = eligibleRunners.filter((r) => r.status === "idle");
      if (idle.length === 0) {
        throw new NoCapacityError(
          eligible?.mode === "agents"
            ? "This task's assigned agents are all busy — it waits until one frees up."
            : undefined,
        );
      }
      for (const r of idle) {
        if (await this.providerUsable(workspaceId, r.provider, r.credentialId)) {
          await this.hub.upsertAgent({ ...r, status: "busy", idleSince: null });
          return { id: r.id, provider: r.provider, model: r.model, credentialId: r.credentialId ?? null };
        }
      }
      throw new RunnerNotConfiguredError(
        "No credential for any available agent — add a key for its provider/credential in Settings (or sign in a CLI-login provider). Nothing runs without one.",
      );
    });
  }

  /**
   * Acquire an idle runner, or PROVISION a fresh one on demand when the fleet is
   * fully occupied — used by fork so a family can branch even when every runner
   * is busy (a fork shouldn't be blocked waiting for capacity). The new runner
   * inherits the requested provider/model. Gated on a usable provider, so we
   * never spin up a runner the executor has no credential for.
   */
  private acquireOrProvisionRunner(
    workspaceId: string,
    provider: TaskRun["provider"],
    model: string,
    credentialId?: string | null,
  ): Promise<{ id: string; provider: TaskRun["provider"]; model: string; credentialId: string | null }> {
    return this.acquireExclusive(async () => {
      const runners = await this.store.listAgents(workspaceId);
      // Prefer an idle agent whose provider/credential can actually execute.
      for (const r of runners.filter((r) => r.status === "idle")) {
        if (await this.providerUsable(workspaceId, r.provider, r.credentialId)) {
          await this.hub.upsertAgent({ ...r, status: "busy", idleSince: null });
          return { id: r.id, provider: r.provider, model: r.model, credentialId: r.credentialId ?? null };
        }
      }
      // None idle+usable → provision one for the requested provider + credential,
      // but only if that credential is usable (else nothing can run).
      if (!(await this.providerUsable(workspaceId, provider, credentialId))) {
        throw new RunnerNotConfiguredError(
          `No credential for provider "${provider}" — add a key in Settings (or sign in a CLI-login provider). Nothing runs without one.`,
        );
      }
      const id = `runner-auto-${++this.seq}`;
      const runner: Agent = { id, workspaceId, name: id, provider, credentialId: credentialId ?? null, model, status: "busy", idleSince: null };
      await this.hub.upsertAgent(runner);
      return { id, provider, model, credentialId: credentialId ?? null };
    });
  }

  /**
   * Provision the runner's working directory. Without an integration repo this
   * is the shared config.runnerCwd (Phase 0). With one configured, isolation is
   * REQUIRED: a fresh worktree on `branch`. If that fails we throw rather than
   * silently dropping runs into a shared dir where their branches would
   * collide — the caller surfaces it as a failed agent.
   */
  private async provisionCwd(
    git: GitContext | undefined,
    runId: string,
    branch: string,
    baseRef?: string,
  ): Promise<{ cwd: string | undefined; baseRef?: string }> {
    if (!git) return { cwd: config.runnerCwd };
    const prov = await git.worktrees.provision(runId, branch, { baseRef });
    await this.hub.runLog(runId, `worktree ready on ${branch} (from ${prov.baseRef})`);
    return { cwd: prov.cwd, baseRef: prov.baseRef };
  }

  // ── assignTask ────────────────────────────────────────────────────────────
  async assignTask(projectId: string, taskId: string): Promise<TaskRun> {
    const task = await this.store.getTask(taskId);
    if (!task || task.projectId !== projectId) throw new Error("Task not found");
    const project = await this.store.getProject(projectId);
    if (!project) throw new Error("Project not found");

    // DEF-005: a completed task has nothing to (re)assign — refuse rather than
    // spawn an agent on already-finished work.
    if (task.state === "done") {
      throw new TaskAlreadyAssignedError("Task is already done");
    }

    // DEF-003: re-assigning a task that already owns a live agent must be
    // idempotent — return the existing agent instead of acquiring a second
    // runner and spawning a duplicate (which orphaned the first agent and left
    // its runner stuck "busy"). Only a done/missing agent frees the task to be
    // (re)assigned.
    if (task.runId) {
      const existing = await this.store.getRun(task.runId);
      if (existing && existing.status !== "done") return existing;
    }

    // A human explicitly assigning an `unassigned` task means "any agent" — persist
    // that so the task carries a real eligibility set once it leaves backlog (the
    // deterministic autonomy loop never makes this assumption; it parks unassigned
    // tasks instead). An `agents` pin restricts acquisition to that pool.
    const current: TaskAssignment = task.assignment ?? { mode: "unassigned", agentIds: [] };
    const assignment: TaskAssignment =
      current.mode === "unassigned" ? { mode: "any", agentIds: [] } : current;
    const runner = await this.acquireAgent(project.workspaceId, assignment);
    const runId = `${this.slug(task.text)}-${++this.seq}`;
    // runId is unique → unique branch & worktree path (two same-named tasks
    // never collide on the same branch).
    const branch = `agent/${runId}`;
    // W5: reserve a sandboxed live-preview URL for visual deliverables.
    const preview = await previewService.resolve({
      workspaceId: project.workspaceId,
      projectId,
      projectName: project.name,
      projectGoal: project.goal,
      runId,
      branch,
      seedVisual: false,
    });
    const agent: TaskRun = {
      id: runId,
      workspaceId: project.workspaceId,
      projectId,
      name: task.text,
      status: "running",
      agentId: runner.id,
      provider: runner.provider,
      credentialId: runner.credentialId,
      model: runner.model,
      branch,
      modules: [],
      progress: 0,
      plan: [],
      usage: null,
      modifiedFiles: [],
      log: [],
      startedAt: now(),
      lastHeartbeatAt: now(),
      visual: preview.visual,
      previewUrl: preview.previewUrl,
      dependsOn: [],
      parentId: null,
      branchFromStep: null,
      archived: false,
    };

    // Resolve the runner provider first — fail fast (before mutating state) if
    // it can't be resolved, rather than silently running a fake one.
    const provider = await this.getProvider(runner.provider);

    await this.hub.createRun(agent);
    await this.hub.upsertTask({ ...task, state: "ongoing", runId, assignment });
    await this.hub.upsertProject({ ...project, runIds: [...project.runIds, runId] });

    // Git backend for this project's repo (local repoPath, else global) — drives
    // the isolated worktree + which merge queue this agent integrates into.
    const git = this.gitContextFor(project);
    try {
      // Isolated worktree cut from the project's integration tip (or base).
      const { cwd, baseRef } = await this.provisionCwd(git, runId, branch, git?.merge.integrationBranch(projectId));
      // Inject this workspace's provider key (env fallback when none is stored).
      const apiKey = await secretService.resolve(project.workspaceId, runner.credentialId ?? runner.provider);
      // The agent gets the full brief: the short name plus the longer
      // description when one exists (the run's display name stays the short text).
      const brief = task.description ? `${task.text}\n\n${task.description}` : task.text;
      const handle = await provider.start(
        { runId, projectId, task: brief, model: runner.model, branch, cwd, apiKey },
        this.events(),
      );
      this.live.set(runId, { handle, agentId: runner.id, taskId, branch, baseRef, git });
    } catch (err) {
      await this.failStartup(runId, runner.id, (err as Error).message);
      throw err;
    }
    return agent;
  }

  // ── fork ──────────────────────────────────────────────────────────────────
  async fork(parentId: string): Promise<TaskRun> {
    const parent = await this.store.getRun(parentId);
    if (!parent) throw new Error("Parent agent not found");

    // Fork provisions capacity on demand: if no runner is idle, spin one up
    // (inheriting the parent's provider/model) rather than refusing the fork.
    const runner = await this.acquireOrProvisionRunner(parent.workspaceId, parent.provider, parent.model, parent.credentialId);
    const runId = `${this.slug(parent.name)}-fork-${++this.seq}`;
    const stepIndex = Math.max(0, parent.plan.findIndex((s) => s.state === "now"));
    const forkBranch = `${parent.branch}-fork`;
    const project = await this.store.getProject(parent.projectId);
    // W5: a fork is its own branch, so it gets its own preview URL (inherits the
    // parent's visual nature as the seed signal).
    const preview = await previewService.resolve({
      workspaceId: parent.workspaceId,
      projectId: parent.projectId,
      projectName: project?.name ?? "",
      projectGoal: project?.goal ?? "",
      runId,
      branch: forkBranch,
      seedVisual: parent.visual,
    });
    const agent: TaskRun = {
      ...parent,
      id: runId,
      name: `${parent.name} (fork)`,
      status: "running",
      agentId: runner.id,
      provider: runner.provider,
      credentialId: runner.credentialId,
      model: runner.model,
      branch: `agent/${runId}`,
      progress: parent.progress,
      log: [],
      startedAt: now(),
      lastHeartbeatAt: now(),
      visual: preview.visual,
      previewUrl: preview.previewUrl,
      parentId,
      branchFromStep: stepIndex,
    };

    const provider = await this.getProvider(runner.provider); // fail fast if it can't resolve

    await this.hub.createRun(agent);
    if (project) await this.hub.upsertProject({ ...project, runIds: [...project.runIds, runId] });

    const git = this.gitContextFor(project);
    try {
      // A fork branches from its parent (family-internal integration, §7).
      const { cwd, baseRef } = await this.provisionCwd(git, runId, agent.branch, parent.branch);
      const apiKey = await secretService.resolve(parent.workspaceId, runner.credentialId ?? runner.provider);
      const handle = await provider.start(
        { runId, projectId: parent.projectId, task: parent.name, model: runner.model, branch: agent.branch, cwd, parentId, branchFromStep: stepIndex, apiKey },
        this.events(),
      );
      this.live.set(runId, { handle, agentId: runner.id, taskId: null, branch: agent.branch, baseRef, git });
    } catch (err) {
      await this.failStartup(runId, runner.id, (err as Error).message);
      throw err;
    }
    return agent;
  }

  // ── deliver a resolved decision ────────────────────────────────────────────
  async deliver(item: HitlItem, resolution: Resolution): Promise<void> {
    const runId = item.runId;

    // Answered (by a human or the timeout) — cancel any pending expiry timer.
    const timer = this.questionTimers.get(item.id);
    if (timer) {
      clearTimeout(timer);
      this.questionTimers.delete(item.id);
    }

    // Escalation has its own resolution semantics (help & resume / reassign / stop).
    if (item.kind === "escalation") {
      await this.deliverEscalation(item, resolution);
      return;
    }

    // diff-approve / merge-retry → integrate the agent's branch. This is the
    // post-approval half of the `approveBeforePush` guardrail: the diff review
    // gated here, so reaching this point means an operator approved the push.
    if (resolution.action === "approve" && (item.kind === "diff" || item.kind === "merge")) {
      const agent = await this.store.getRun(runId);
      if (agent) {
        const project = await this.store.getProject(agent.projectId);
        const git = this.gitContextFor(project);
        const conn = await githubService.get(agent.workspaceId);
        // GitHub PR flow: workspace connected, project bound to one repo, and a
        // worktree to push from. Otherwise fall back to the local merge queue
        // (against the project's own repo when git-backed, else the global one).
        if (conn?.connected && project?.repo && git) {
          await this.pushToGithub(git, agent, project.repo, project);
          return;
        }
        if (git) {
          await this.hub.runStatus(runId, "review");
          await this.hub.runLog(runId, item.kind === "merge" ? "retrying merge after reconciliation" : "diff approved — queued for merge");
          git.merge.enqueue({ runId, projectId: agent.projectId, agentBranch: agent.branch, workspaceId: agent.workspaceId });
          return;
        }
      }
    }

    // Review feedback loop: a `modify` on a finished run's diff/merge review is a
    // request to revise before it can merge. Compute was freed for the review, so
    // there's no live handle — re-acquire one and resume the run in its worktree
    // with the guidance (reviseAfterReview), rather than silently dropping it.
    if ((item.kind === "diff" || item.kind === "merge") && resolution.action === "modify" && !this.live.has(runId)) {
      await this.reviseAfterReview(runId, resolution.guidance ?? "");
      return;
    }

    const live = this.live.get(runId);
    if (live) {
      await live.handle.resume(resolution);
    } else {
      // No live runner to receive the decision (e.g. a seeded/demo agent or one
      // whose runner already exited). Be honest: record that it couldn't be
      // delivered — don't fake a resume by flipping the agent back to "running".
      await this.hub.runLog(runId, `decision "${resolution.action}" recorded, but no live runner is attached — not delivered to an agent`);
    }
  }

  /** A `modify` on a finished run's diff review: re-acquire compute and resume the
   *  agent in its existing worktree with the reviewer's guidance so it can revise
   *  and re-submit. The worktree still holds the committed work (retire happens
   *  only on merge), so a fresh turn edits on top of it; on the agent's next
   *  completion, complete() re-commits and re-raises the review. Loops until the
   *  operator approves. */
  private async reviseAfterReview(runId: string, guidance: string): Promise<void> {
    const review = this.reviews.get(runId);
    const run = await this.store.getRun(runId);
    if (!run || !review) {
      await this.hub.runLog(runId, `revision requested but this run is no longer resumable — not applied`);
      return;
    }
    let acq: { id: string; provider: TaskRun["provider"]; model: string };
    try {
      acq = await this.acquireOrProvisionRunner(run.workspaceId, run.provider, run.model, run.credentialId);
    } catch (err) {
      await this.hub.runLog(runId, `cannot revise — ${(err as Error).message}`);
      return;
    }
    const provider = await this.getProvider(acq.provider);
    const cwd = review.git.worktrees.pathFor(runId);
    const apiKey = await secretService.resolve(run.workspaceId, run.credentialId ?? run.provider);
    const revisePrompt =
      `A reviewer looked at your work and asked for changes before it can be merged:\n\n${guidance}\n\n` +
      `Your previous output is already in the working directory (branch ${run.branch}). Read it, make ` +
      `only the changes needed to address the request, then stop.`;
    await this.hub.runStatus(runId, "running");
    if (review.taskId) {
      const task = await this.store.getTask(review.taskId);
      if (task) await this.hub.upsertTask({ ...task, state: "ongoing" });
    }
    await this.hub.runLog(runId, "revising per review guidance");
    try {
      const handle = await provider.start(
        { runId, projectId: run.projectId, task: revisePrompt, model: run.model, branch: run.branch, cwd, apiKey },
        this.events(),
      );
      this.live.set(runId, { handle, agentId: acq.id, taskId: review.taskId, branch: run.branch, baseRef: review.baseRef, git: review.git });
      this.reviews.delete(runId);
    } catch (err) {
      await this.failStartup(runId, acq.id, (err as Error).message);
    }
  }

  // ── Escalation: halt a run that can't finish and hand it to a human ─────────

  /** System-driven escalation (too long / too many failures): halt the run and
   *  hand it to a human. Captures the worktree context so it can be resumed,
   *  frees the runner (but never retires the worktree), and raises an
   *  `escalation` HITL. Idempotent per run. Agent-driven escalation goes through
   *  raise() instead (the live gate stays parked). */
  private async escalate(runId: string, reason: string, source: "timeout" | "failures"): Promise<void> {
    if (this.escalations.has(runId)) return; // already escalated — don't re-raise
    const run = await this.store.getRun(runId);
    if (!run) return;
    const live = this.live.get(runId);
    const git = live?.git ?? (await this.gitContextForAgent(runId).catch(() => undefined));
    this.escalations.set(runId, { git, baseRef: live?.baseRef, taskId: live?.taskId ?? null, source });
    // Halt the stuck/failed session so it stops holding its slot + burning
    // tokens, and free the runner — but DO NOT retire the worktree (resume needs it).
    if (live) await live.handle.stop().catch(() => undefined);
    await this.freeRunner(live?.agentId ?? null);
    this.live.delete(runId);
    const item: HitlItem = {
      id: `q-${runId}-${++this.seq}`,
      workspaceId: run.workspaceId,
      runId,
      kind: "escalation",
      title: source === "timeout" ? "Run stuck — needs a human" : "Run keeps failing — needs a human",
      why: reason,
      risk: "medium",
      rationale: null,
      raisedAt: now(),
      expiresAt: null,
      resolvedAt: null,
      resolution: null,
      command: null,
      options: null,
      recommended: null,
      steps: null,
      diff: null,
      flags: [source],
    };
    await this.hub.runStatus(runId, "waiting");
    await this.hub.raiseHitl(item);
    await this.hub.runLog(runId, `escalated (${source}) — ${reason}`);
  }

  /** Resolve an `escalation`: help & resume (modify), reassign, or stop (reject). */
  private async deliverEscalation(item: HitlItem, resolution: Resolution): Promise<void> {
    const runId = item.runId;
    const live = this.live.get(runId);
    if (resolution.action === "reject") {
      // Stop: abandon the run cleanly and reclaim its worktree.
      if (live) await live.handle.stop().catch(() => undefined);
      await this.freeRunner(live?.agentId ?? null);
      this.live.delete(runId);
      const git = this.escalations.get(runId)?.git ?? live?.git;
      if (git) await git.worktrees.retire(runId).catch(() => undefined);
      this.escalations.delete(runId);
      this.failCounts.delete(runId);
      await this.hub.runStatus(runId, "done");
      await this.hub.runLog(runId, "escalation resolved — operator stopped the run");
      return;
    }
    // Agent-driven escalation still holds a live gate → resume it in place with
    // the operator's guidance (preserves the agent's session context). modify only.
    if (resolution.action === "modify" && live) {
      await this.hub.runStatus(runId, "running");
      await live.handle.resume(resolution);
      this.escalations.delete(runId);
      this.failCounts.delete(runId);
      await this.hub.runLog(runId, "escalation resolved — resuming the agent with your guidance");
      return;
    }
    // Reassign, or help a run whose handle was already torn down → relaunch a
    // fresh session in the worktree (it picks up the committed work + guidance).
    await this.relaunchEscalated(runId, resolution.guidance?.trim() || "", resolution.action === "reassign");
  }

  /** Re-acquire compute for an escalated run and start a fresh session in its
   *  worktree with the operator's guidance. `reassign` moves it to a DIFFERENT
   *  runner (acquire the replacement BEFORE freeing the current, so the same idle
   *  runner isn't re-picked). */
  private async relaunchEscalated(runId: string, guidance: string, reassign: boolean): Promise<void> {
    const run = await this.store.getRun(runId);
    const ctx = this.escalations.get(runId);
    if (!run) return;
    const live = this.live.get(runId);
    const git = ctx?.git ?? live?.git ?? (await this.gitContextForAgent(runId).catch(() => undefined));
    if (!git) {
      await this.hub.runLog(runId, "cannot resume — this run has no worktree to continue in");
      return;
    }
    let acq: { id: string; provider: TaskRun["provider"]; model: string };
    try {
      if (!reassign && live) {
        await live.handle.stop().catch(() => undefined);
        await this.freeRunner(live.agentId);
        this.live.delete(runId);
      }
      acq = await this.acquireOrProvisionRunner(run.workspaceId, run.provider, run.model);
      if (reassign && live) {
        await live.handle.stop().catch(() => undefined);
        await this.freeRunner(live.agentId);
        this.live.delete(runId);
      }
    } catch (err) {
      await this.hub.runLog(runId, `cannot ${reassign ? "reassign" : "resume"} — ${(err as Error).message}`);
      await this.hub.runStatus(runId, "waiting"); // stays escalated for another try
      return;
    }
    const provider = await this.getProvider(acq.provider);
    const cwd = git.worktrees.pathFor(runId);
    const apiKey = await secretService.resolve(run.workspaceId, run.provider);
    const prompt = reassign
      ? `You are taking over a task another agent escalated because it got stuck. Its work so far is already in the working directory (branch ${run.branch}).${guidance ? `\n\nOperator guidance:\n\n${guidance}` : ""}\n\nReview what's there, then continue and finish the task. If you also get stuck, escalate (AskUserQuestion with header "ESCALATE").`
      : `You escalated this task for help, and the operator responded:\n\n${guidance || "(no specific guidance — use your best judgement, or escalate again if still blocked)"}\n\nYour work so far is already in the working directory (branch ${run.branch}). Continue with this guidance and finish, or escalate again (AskUserQuestion with header "ESCALATE") if you're still blocked.`;
    await this.hub.runStatus(runId, "running");
    if (ctx?.taskId) {
      const task = await this.store.getTask(ctx.taskId);
      if (task) await this.hub.upsertTask({ ...task, state: "ongoing" });
    }
    await this.hub.runLog(runId, reassign ? "reassigned to another runner after escalation" : "resuming after escalation with operator guidance");
    try {
      const handle = await provider.start(
        { runId, projectId: run.projectId, task: prompt, model: run.model, branch: run.branch, cwd, apiKey },
        this.events(),
      );
      this.live.set(runId, { handle, agentId: acq.id, taskId: ctx?.taskId ?? null, branch: run.branch, baseRef: ctx?.baseRef ?? config.baseBranch, git });
      this.escalations.delete(runId);
      this.failCounts.delete(runId);
    } catch (err) {
      await this.failStartup(runId, acq.id, (err as Error).message);
    }
  }

  /** Merge committed: free the runner, mark the owning task done, finish the agent. */
  private async completeMerged(runId: string, branch: string): Promise<void> {
    const review = this.reviews.get(runId);
    this.reviews.delete(runId); // integrated — no longer awaiting a revise
    const agent = await this.store.getRun(runId);
    await this.freeRunner(agent?.agentId ?? null);
    // Advance the owning task to done alongside the run. Resolve it by the EXACT
    // taskId we stashed when the review was raised (reliable), falling back to a
    // runId match. The find-by-runId alone left tasks stranded in `review` after
    // their run reached `done` (an incoherent lifecycle) whenever that lookup came
    // up empty — a task's `runId` is set at assign, but this closes the gap and,
    // if a task still can't be resolved, says so loudly rather than silently
    // leaving it behind.
    const taskId =
      review?.taskId ??
      (agent ? (await this.store.listTasks(agent.workspaceId)).find((t) => t.runId === runId)?.id : undefined);
    if (taskId) {
      const task = await this.store.getTask(taskId);
      if (task && task.state !== "done") await this.hub.upsertTask({ ...task, state: "done" });
    } else {
      await this.hub.runLog(runId, "merged, but could not resolve the owning task to mark it done");
    }
    await this.hub.runStatus(runId, "done");
    await this.hub.runCompleted(runId, branch);
    const live = this.live.get(runId);
    if (live) {
      await live.handle.stop().catch(() => undefined);
      this.live.delete(runId);
    }
    // Integrated — retire the agent's worktree (the branch is kept in history).
    const ctx = await this.gitContextForAgent(runId).catch(() => undefined);
    if (ctx) await ctx.worktrees.retire(runId).catch(() => undefined);
    // A change just landed on the integration branch → nudge a live preview to
    // re-point at the new tip so the operator sees the app update (docs/live-preview.md).
    if (agent?.projectId) void projectPreview.refresh(agent.projectId).catch(() => undefined);
  }

  /**
   * Integrate an approved agent branch via GitHub: run the safety preflight,
   * then (if clean) mint an installation token, push the branch, and open a PR.
   * The agent stays in `review` until the PR is merged on GitHub. Enforcement is
   * server-side here — the runner never had credentials to push around it.
   */
  /**
   * The real diff of a run's branch (unified patch + stat), for the diff-review
   * UI. Lazily produced from the worktree so patches never bloat the snapshot.
   * Returns an empty patch if the run has no git worktree (non-git project) or
   * it's already been retired.
   */
  async runDiff(runId: string): Promise<{ patch: string; add: number; del: number; files: string[] }> {
    const review = this.reviews.get(runId);
    const ctx = review?.git ?? (await this.gitContextForAgent(runId).catch(() => undefined));
    if (!ctx) return { patch: "", add: 0, del: 0, files: [] };
    // The worktree is branched off the project's integration tip, NOT `main`, so
    // diff against that base — the review's captured baseRef when we have it,
    // else the project's integration branch.
    const run = await this.store.getRun(runId);
    const baseRef = review?.baseRef ?? (run ? ctx.merge.integrationBranch(run.projectId) : config.baseBranch);
    const stat = await ctx.worktrees.diffStat(runId, baseRef);
    const patch = await ctx.worktrees.patch(runId, baseRef);
    return { patch, add: stat.add, del: stat.del, files: stat.files };
  }

  private async pushToGithub(git: GitContext, agent: TaskRun, repo: string, project?: Project | null): Promise<void> {
    const worktreePath = git.worktrees.pathFor(agent.id);
    const stat = await git.worktrees.diffStat(agent.id, config.baseBranch);
    const modules = this.moduleMapFor(project).modulesForFiles(stat.files);
    await this.hub.runStatus(agent.id, "review");
    try {
      const result = await githubService.pushAndOpenPr({
        workspaceId: agent.workspaceId,
        runId: agent.id,
        repo,
        branch: agent.branch,
        baseBranch: config.baseBranch,
        worktreePath,
        changedFiles: stat.files,
        modules,
        allowedModules: agent.modules, // [] = unconstrained (no scope declared)
        force: false,
        title: agent.name,
        body: `Automated by Skynet agent \`${agent.id}\`.\n\n${stat.add}+/${stat.del}- across ${stat.files.length} file(s).`,
      });
      if (!result.ok) {
        await this.hub.runLog(agent.id, `push blocked by safety policy: ${result.violations.map((v) => v.message).join("; ")}`);
        return;
      }
      await this.hub.runLog(agent.id, `pushed ${agent.branch} → opened PR ${result.pr?.url ?? "(opened)"}`);

      // The operator's approval IS the approval — merge the PR and complete the
      // task (→ done). If GitHub blocks the merge (branch protection / required
      // checks or reviews), surface that and leave the run in review rather than
      // pretending it integrated. Without this the run/task sat in review forever.
      if (!result.pr) {
        await this.hub.runLog(agent.id, "PR did not return a number — can't merge automatically; merge it on GitHub to complete.");
        return;
      }
      const merge = await githubService
        .mergePr(agent.workspaceId, repo, result.pr.number)
        .catch((err: unknown) => ({ merged: false, reason: (err as Error).message }));
      if (merge.merged) {
        await this.hub.runLog(agent.id, `merged PR ${result.pr.url ?? `#${result.pr.number}`}`);
        await this.completeMerged(agent.id, agent.branch);
      } else {
        await this.hub.runStatus(agent.id, "review");
        await this.hub.runLog(agent.id, `PR opened but not merged — ${merge.reason ?? "blocked by GitHub"}. Merge it on GitHub to complete.`);
      }
    } catch (err) {
      await this.hub.runLog(agent.id, `GitHub push failed: ${(err as Error).message}`);
    }
  }

  /** One open merge gate per run — approving one that fails again may raise a
   *  successor, but two simultaneously open ones are always noise. */
  private async hasOpenMergeGate(workspaceId: string, runId: string): Promise<boolean> {
    const queue = await this.store.listQueue(workspaceId);
    return queue.some((q) => q.runId === runId && q.kind === "merge" && q.resolvedAt == null);
  }

  /** Merge couldn't run (NOT a textual conflict) → an honest gate with git's
   *  real reason, never a phantom "Merge conflict — 0 files". */
  private async raiseMergeFailedHitl(req: MergeRequest, reason: string): Promise<void> {
    const agent = await this.store.getRun(req.runId);
    if (!agent) return;
    await this.hub.runStatus(req.runId, "review");
    if (await this.hasOpenMergeGate(agent.workspaceId, req.runId)) return;
    await this.hub.raiseHitl({
      id: `q-merge-${req.runId}-${++this.seq}`,
      workspaceId: agent.workspaceId,
      runId: req.runId,
      kind: "merge",
      title: "Integration failed — not a conflict",
      why: `git could not merge ${req.agentBranch}: ${reason}. Fix the repo state, then approve to retry (reject bounces the run back for revision).`,
      risk: "high",
      raisedAt: now(),
      expiresAt: null,
      resolvedAt: null,
      resolution: null,
      rationale: null,
      command: null,
      options: null,
      recommended: null,
      steps: null,
      diff: { add: 0, del: 0, modules: agent.modules },
      flags: [reason],
    });
  }

  /** Textual merge conflict → raise a `merge` HITL for an operator to reconcile. */
  private async raiseMergeHitl(req: MergeRequest, files: string[]): Promise<void> {
    const agent = await this.store.getRun(req.runId);
    if (!agent) return;
    await this.hub.runStatus(req.runId, "review");
    if (await this.hasOpenMergeGate(agent.workspaceId, req.runId)) return;
    await this.hub.raiseHitl({
      id: `q-merge-${req.runId}-${++this.seq}`,
      workspaceId: agent.workspaceId,
      runId: req.runId,
      kind: "merge",
      title: `Merge conflict — ${files.length} file${files.length === 1 ? "" : "s"}`,
      why: `${files.length} file(s) conflict integrating ${req.agentBranch}. Reconcile, then approve to retry.`,
      risk: "high",
      raisedAt: now(),
      expiresAt: null,
      resolvedAt: null,
      resolution: null,
      rationale: null,
      command: null,
      options: null,
      recommended: null,
      steps: null,
      diff: { add: 0, del: 0, modules: agent.modules },
      flags: files, // the conflicting files — shown as chips
    });
  }

  // ── chat ────────────────────────────────────────────────────────────────────
  async chat(runId: string, text: string): Promise<string> {
    await this.hub.runLog(runId, `you: ${text}`);
    const live = this.live.get(runId);

    // No live session (finished, in review, or the server restarted since it ran)
    // → answer statelessly via the provider, grounded in the agent's stored log.
    // A `done` agent is also answered statelessly even if a stale live entry
    // lingers: it has nothing left to relay to, so we must never block on its
    // handle's chat waiter (which would hang until the 45s timeout).
    if (!live || (await this.store.getRun(runId))?.status === "done") {
      const reply = await this.consultFinished(runId, text);
      await this.hub.runLog(runId, `↳ ${reply}`);
      return reply;
    }

    return this.liveChat(runId, text, live);
  }

  /**
   * Streaming counterpart of {@link chat}: yields the reply as text deltas so
   * the UI can render it live. The stateless (finished / no-live-session) path —
   * the "ask me anything about what shipped" case — streams token-level deltas
   * from the provider's consultStream. The live-session path has no delta
   * protocol yet, so it yields the single reply as one chunk (same content as
   * chat(), just over the streaming transport — keeps the client uniform).
   */
  async *chatStream(runId: string, text: string): AsyncGenerator<string> {
    await this.hub.runLog(runId, `you: ${text}`);
    const live = this.live.get(runId);
    if (!live || (await this.store.getRun(runId))?.status === "done") {
      let full = "";
      for await (const delta of this.consultFinishedStream(runId, text)) {
        full += delta;
        yield delta;
      }
      await this.hub.runLog(runId, `↳ ${full}`);
      return;
    }
    yield await this.liveChat(runId, text, live);
  }

  /** The live-session chat turn: relay to the running handle and resolve with
   *  its reply (or a timeout note). Shared by chat() + chatStream(). */
  private liveChat(runId: string, text: string, live: { handle: RunnerHandle }): Promise<string> {
    return new Promise<string>((resolve) => {
      // A real model turn can take well over 5s; give it room before giving up.
      const timer = setTimeout(() => {
        this.chatWaiters.delete(runId);
        resolve("(no reply yet — it may still be working; check the agent's log)");
      }, 45_000);
      this.chatWaiters.set(runId, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      void live.handle.message(text);
    });
  }

  /**
   * BYOK intent-parse path for the Telegram conversational bridge. Interpret a
   * natural-language operator message using the operator's OWN provider key —
   * never a Skynet-hosted model. Iterate the fleet, pick the FIRST provider that
   * has a resolvable key AND a stateless `.consult`, and ask it `question` (the
   * classifier instruction) with `context` (the operator message + workspace
   * snapshot) as grounding data. Returns the raw model reply, or `null` when no
   * provider/key/consult is available (the caller then falls back to slash
   * commands). Reuses the same consult plumbing as assessTask/autoReview.
   *
   * The operator message rides inside `context` as DATA (not as the question),
   * so a misparse or a prompt-injection attempt can only ever produce a reply
   * the caller re-validates against a closed whitelist — it can never escalate.
   */
  async consult(
    ws: string,
    question: string,
    context?: string,
    system?: string,
  ): Promise<string | null> {
    // Candidate (provider, model) pairs to interpret with: the configured fleet
    // agents first (real model choices), THEN a fallback to a consult-capable
    // provider that has a resolvable key even when NO agent is configured yet —
    // so conversational control works before the fleet exists. Without this
    // fallback, a key set in .env/skynet.env was ignored unless a Claude *agent*
    // happened to be in the fleet. (Today Claude is the only provider with
    // `.consult`; the catalog lookup keeps this correct if others gain it.)
    const agents = await this.store.listAgents(ws).catch(() => [] as Agent[]);
    const candidates: Array<{ provider: ProviderId; model: string }> = agents.map((a) => ({
      provider: a.provider,
      model: a.model,
    }));
    if (!candidates.some((c) => c.provider === "claude")) {
      const claude = (await this.store.listProviders().catch(() => [] as ProviderInfo[])).find(
        (p) => p.id === "claude",
      );
      const models = claude?.models ?? [];
      // Prefer a cheap/fast model for a tiny classification call.
      const model =
        models.find((m) => /haiku/i.test(m)) ??
        models.find((m) => /sonnet/i.test(m)) ??
        models[0] ??
        "sonnet-4.6";
      candidates.push({ provider: "claude", model });
    }

    for (const c of candidates) {
      const apiKey = await secretService.resolve(ws, c.provider).catch(() => undefined);
      if (!apiKey) continue;
      let provider: RunnerProvider;
      try {
        provider = await this.getProvider(c.provider);
      } catch {
        continue; // unresolvable provider — try the next candidate
      }
      if (!provider.consult) continue;
      try {
        return await provider.consult(
          {
            task: system ? "Interpret an operator remote-control message" : "Classify an operator remote-control message",
            model: c.model,
            cwd: config.runnerCwd,
            apiKey,
            context,
            ...(system ? { system } : {}),
          },
          question,
        );
      } catch {
        // A provider round-trip failure is treated as "no interpretation" — the
        // caller degrades to slash commands rather than guessing.
        return null;
      }
    }
    return null;
  }

  /** Answer a follow-up when there's no live session, via the provider's
   *  stateless consult, grounded in the stored log — works even across a server
   *  restart. The reply is truthful about the agent's actual status (DEF-002):
   *  we only say "finished" when the agent is really done. */
  private async consultFinished(runId: string, question: string): Promise<string> {
    let reply = "";
    for await (const delta of this.consultFinishedStream(runId, question)) reply += delta;
    return reply;
  }

  /** Streaming form of {@link consultFinished}: yields the provider's answer as
   *  text deltas (via consultStream when available, else the whole consult() as
   *  one chunk). The status/availability guard replies are yielded whole. */
  private async *consultFinishedStream(runId: string, question: string): AsyncGenerator<string> {
    const agent = await this.store.getRun(runId);
    if (!agent) {
      yield `(${runId}) no such agent.`;
      return;
    }
    const provider = await this.getProvider(agent.provider);
    if (!provider.consult && !provider.consultStream) {
      // No stateless consult available. Don't claim the agent "finished" unless
      // it actually did — otherwise chatting a running/waiting agent gets a
      // misleading canned reply.
      yield agent.status === "done"
        ? "This agent has finished; follow-up chat isn't supported for its runner."
        : `This agent is ${agent.status}, but chat isn't wired to a live runner in this config, so I can't relay your message to it right now.`;
      return;
    }
    const apiKey = await secretService.resolve(agent.workspaceId, agent.credentialId ?? agent.provider);
    const context = agent.log.slice(-40).map((l) => l.line).join("\n").slice(-4000);
    const spec = { task: agent.name, model: agent.model, cwd: config.runnerCwd, apiKey, context };
    try {
      if (provider.consultStream) {
        yield* provider.consultStream(spec, question);
      } else {
        yield await provider.consult!(spec, question);
      }
    } catch (err) {
      yield `couldn't look into that right now (${(err as Error).message}).`;
    }
  }

  /**
   * Detach an agent's live session — stop its runner if live, free the runner it
   * holds (so a stuck "busy" runner is released), retire its worktree, and record
   * why. Works even for an ORPHAN (no live handle after a restart): the agent's
   * recorded agentId is the only handle to the stuck runner.
   *
   * It deliberately does NOT change the agent's status: the caller owns the
   * terminal state. Operator "stop" ({@link haltAgent}) and the reaper mark the
   * agent done themselves; a restart-orphan is left running/waiting so a
   * follow-up chat can still report its real status (DEF-002) rather than a
   * misleading "finished".
   */
  async stopAgent(runId: string, reason = "stopped by operator"): Promise<void> {
    const agent = await this.store.getRun(runId);
    if (!agent) return;
    const live = this.live.get(runId);
    if (live) await live.handle.stop().catch(() => undefined);
    // Free the runner using the live mapping OR the agent's recorded agentId
    // (an orphan has no live entry, so agent.agentId is the only handle).
    await this.freeRunner(live?.agentId ?? agent.agentId ?? null);
    const ctx = live?.git ?? (await this.gitContextForAgent(runId).catch(() => undefined));
    if (ctx) await ctx.worktrees.retire(runId).catch(() => undefined);
    await this.hub.runLog(runId, reason);
    this.live.delete(runId);
  }

  /**
   * Reap presumed-dead runs: a `running`/`waiting` agent whose heartbeat has
   * been silent past `config.agentReapMs` (a live runner beats every few
   * seconds, so prolonged silence means the runner crashed or the server
   * restarted and orphaned it). `review` runs are intentionally parked with no
   * runner awaiting operator approval, so they never beat and are NOT reaped.
   * Runs periodically and once at startup (which clears restart orphans).
   */
  /** Limbo runs already warned about this process — warn once, not every sweep. */
  private limboWarned = new Set<string>();

  /**
   * Worktree GC (boot + interval). Two safe reclaims and one warning:
   *  1. Remove ZOMBIE worktrees — a worktree under our root whose branch belongs
   *     to no live run (run done/archived, or unknown entirely — e.g. a crash or
   *     a memory-store restart forgot it). Live runs (running/waiting/paused/
   *     review) keep theirs: the revise loop + diff review depend on them.
   *  2. Delete agent/* BRANCHES already merged into their project's integration
   *     branch, once no live run uses them — integrated refs are pure clutter
   *     (and a branch held by a stale worktree blocks checkouts elsewhere).
   *  3. SURFACE (never delete) limbo: a run parked in `review` with no open gate
   *     and a heartbeat older than worktreeTtlDays — its worktree may hold the
   *     only copy of unmerged work, so reclaiming it is a human decision.
   */
  async gcWorktrees(): Promise<{ worktreesRemoved: number; branchesDeleted: number; limbo: number }> {
    const stats = { worktreesRemoved: 0, branchesDeleted: 0, limbo: 0 };
    const runs = await this.store.listAllRuns().catch(() => [] as TaskRun[]);
    const fleet = await this.store.listAllAgents().catch(() => [] as Agent[]);

    // Discover every git context we own: the global integration repo + each
    // git-backed project repo (workspaces derived from what the store knows).
    const workspaces = new Set<string>([...runs.map((r) => r.workspaceId), ...fleet.map((a) => a.workspaceId)]);
    const projects: Project[] = [];
    for (const ws of workspaces) projects.push(...(await this.store.listProjects(ws).catch(() => [] as Project[])));
    const byRepo = new Map<string, { ctx: GitContext; projects: Project[] }>();
    if (config.integrationRepo) {
      const ctx = this.gitContextForRepo(config.integrationRepo);
      byRepo.set(ctx.repo, { ctx, projects: [] });
    }
    for (const p of projects) {
      const ctx = this.gitContextFor(p);
      if (!ctx) continue;
      const entry = byRepo.get(ctx.repo) ?? { ctx, projects: [] };
      entry.projects.push(p);
      byRepo.set(ctx.repo, entry);
    }

    const liveBranches = new Set(runs.filter((r) => r.status !== "done" && !r.archived).map((r) => r.branch));
    for (const { ctx, projects: ps } of byRepo.values()) {
      // 1. Zombie worktrees (ours only — list() is scoped to our root).
      for (const wt of await ctx.worktrees.list().catch(() => [])) {
        if (basename(wt.path).startsWith("integration-")) continue; // merge-engine scratch, self-managed
        if (wt.branch && liveBranches.has(wt.branch)) continue;
        await ctx.worktrees.removeAt(wt.path).catch(() => undefined);
        stats.worktreesRemoved++;
      }
      // 2. Integrated agent branches nobody live is using.
      for (const p of ps) {
        const merged = await ctx.worktrees.mergedAgentBranches(ctx.merge.integrationBranch(p.id)).catch(() => []);
        for (const name of merged) {
          if (liveBranches.has(name)) continue;
          await ctx.worktrees.deleteBranch(name).catch(() => undefined);
          stats.branchesDeleted++;
        }
      }
    }

    // 3. Limbo surfacing — parked reviews with nothing asking for a decision.
    const cutoff = now() - config.worktreeTtlDays * 24 * 60 * 60 * 1000;
    for (const r of runs) {
      if (r.status !== "review" || r.archived || r.lastHeartbeatAt > cutoff) continue;
      const open = (await this.store.listQueue(r.workspaceId).catch(() => [] as HitlItem[])).some(
        (q) => q.runId === r.id && q.resolvedAt == null,
      );
      if (open) continue; // a gate is waiting — the operator already has a handle
      stats.limbo++;
      if (this.limboWarned.has(r.id)) continue;
      this.limboWarned.add(r.id);
      await this.hub
        .runLog(
          r.id,
          `parked in review ${config.worktreeTtlDays}+ days with no open gate — worktree kept (may hold unmerged work); resolve, stop, or archive to reclaim`,
        )
        .catch(() => undefined);
    }
    return stats;
  }

  async reapStaleAgents(): Promise<void> {
    await this.sweepStuckRuns().catch(() => undefined);
    const ms = config.agentReapMs;
    if (!ms || ms <= 0) return; // disabled
    const cutoff = now() - ms;
    const runs = await this.store.listAllRuns().catch(() => [] as TaskRun[]);
    for (const a of runs) {
      if (a.status !== "running" && a.status !== "waiting") continue;
      if (a.lastHeartbeatAt > cutoff) continue;
      const silentSec = Math.round((now() - a.lastHeartbeatAt) / 1000);
      // Detach the (presumed-dead) session + free its runner, then mark it
      // terminal — a reaped agent isn't coming back, so it must not linger
      // "running" and get reaped again on the next sweep.
      await this.stopAgent(a.id, `reaped — no heartbeat for ${silentSec}s; runner freed`).catch(() => undefined);
      await this.hub.runStatus(a.id, "done").catch(() => undefined);
      await this.hub.runCompleted(a.id, a.branch).catch(() => undefined);
    }
  }

  /** "Too long" guard: a run that has been actively `running` past config
   *  .runStuckMs (since it started) without finishing is escalated to a human
   *  rather than left to spin. 0 disables. Skips runs already escalated or parked
   *  on another gate (only `running` counts as "at it too long"). */
  private async sweepStuckRuns(): Promise<void> {
    const ms = config.runStuckMs;
    if (!ms || ms <= 0) return; // disabled
    const runs = await this.store.listAllRuns().catch(() => [] as TaskRun[]);
    for (const a of runs) {
      if (a.status !== "running") continue;
      if (this.escalations.has(a.id)) continue;
      if (now() - a.startedAt < ms) continue;
      const mins = Math.round((now() - a.startedAt) / 60_000);
      await this.escalate(a.id, `working for ${mins} min without finishing`, "timeout").catch(() => undefined);
    }
  }

  private autonomyTicking = false;

  /**
   * Autonomy loop: for each project with `autonomy` on and idle-agent capacity,
   * do the low-risk moves so tasks flow without a human — triage a backlog item
   * (agent writes an assessment), start an auto-pick todo task, and review a
   * finished run (approve → merge → done, else flag it for a human). The human
   * gate (triage → todo) is never crossed here. Bounded per project per tick.
   */
  async tickAutonomy(): Promise<void> {
    if (!config.autonomyMs || config.autonomyMs <= 0) return;
    if (this.paused) return; // kill switch engaged — no autonomous work until /resume
    if (this.autonomyTicking) return; // never overlap ticks
    this.autonomyTicking = true;
    try {
      const allAgents = await this.store.listAllAgents().catch(() => [] as Agent[]);
      const workspaces = [...new Set(allAgents.map((a) => a.workspaceId))];
      for (const ws of workspaces) {
        const projects = (await this.store.listProjects(ws)).filter((p) => p.autonomy);
        if (projects.length === 0) continue;
        const tasks = await this.store.listTasks(ws);
        for (const p of projects) {
          // Re-read idle capacity per project (an earlier project may have used it).
          const idle = (await this.store.listAgents(ws)).filter((a) => a.status === "idle");
          if (idle.length === 0) break; // no capacity left in this workspace
          const mine = tasks.filter((t) => t.projectId === p.id);
          try {
            // 1) Triage one backlog item → assessment, move to triage. Skip
            //    `unassigned` tasks: leaving backlog requires an eligibility choice,
            //    and autonomy never guesses one — those stay parked for a human.
            const backlog = mine.find(
              (t) => t.state === "backlog" && (t.assignment?.mode ?? "unassigned") !== "unassigned",
            );
            if (backlog) {
              const { assessment, estimatedDurationMs } = await this.assessTask(ws, idle[0]!, backlog);
              // Only OVERWRITE an existing estimate when triage produced a new
              // one — leaves an operator-set estimate intact if triage failed
              // to guess (or on retriage of a task that already had one).
              const nextEst = estimatedDurationMs != null
                ? estimatedDurationMs
                : backlog.estimatedDurationMs;
              await this.hub.upsertTask({ ...backlog, state: "triage", assessment, estimatedDurationMs: nextEst });
            }
            // 2) Start auto-pick todo tasks (todo → ongoing) while capacity lasts.
            //    Each honors its own eligibility set via assignTask → acquireAgent, so
            //    a task whose pinned agents are busy is skipped (continue) rather than
            //    stalling pickups for tasks whose agents ARE free.
            for (const t of mine.filter(
              (t) => t.state === "todo" && t.autoPick && (t.assignment?.mode ?? "unassigned") !== "unassigned",
            )) {
              try {
                await this.assignTask(p.id, t.id);
              } catch {
                continue; // this task's agents busy / no credential — try the next
              }
            }
            // 3) Review a finished run: approve → merge/done, else flag for a human.
            const review = mine.find((t) => t.state === "review" && t.runId && !t.reviewFlaggedReason);
            if (review?.runId) {
              const open = (await this.store.listQueue(ws)).find(
                (h) => h.runId === review.runId && !h.resolvedAt,
              );
              if (open) await this.autoReview(ws, idle[0]!, review, open);
            }
          } catch (err) {
            await this.hub.runLog(p.id, `autonomy skipped ${p.id}: ${(err as Error).message}`).catch(() => undefined);
          }
        }
      }
    } finally {
      this.autonomyTicking = false;
    }
  }

  /**
   * A short agent-written assessment for autonomous triage — plus a rough
   * duration estimate parsed from a trailing JSON tag on the model's reply.
   * The model is asked to end with `{"estMinutes": N}` where N is its best
   * guess of how long a competent coding agent would take. We convert to ms,
   * cap at 24h (so a runaway estimate doesn't blow out the timeline), and
   * fall back to null when the tag is missing or malformed — a missing
   * estimate stays a missing estimate (never a fabricated 0).
   *
   * Falls back to a deterministic note when the provider has no stateless
   * consult (e.g. mock) — no estimate in that case either.
   */
  private async assessTask(
    ws: string,
    agent: Agent,
    task: Task,
  ): Promise<{ assessment: string; estimatedDurationMs: number | null }> {
    try {
      const provider = await this.getProvider(agent.provider);
      if (!provider.consult) {
        return {
          assessment: `Auto-triaged — "${task.text}" looks actionable; no blockers noted.`,
          estimatedDurationMs: null,
        };
      }
      const apiKey = await secretService.resolve(ws, agent.credentialId ?? agent.provider);
      const reply = await provider.consult(
        { task: task.description ? `${task.text}\n\n${task.description}` : task.text, model: agent.model, cwd: config.runnerCwd, apiKey },
        [
          "You are triaging a backlog item for a coding project.",
          "In 2-3 short lines: is the ask clear, rough effort (S/M/L), and any risks? Be terse.",
          'END your reply with a JSON tag on its OWN line estimating a competent coding agent\'s duration in minutes:',
          '  {"estMinutes": 30}',
          "Use a positive integer, roughly bounded by S≈15, M≈60, L≈240; omit the tag ONLY if the ask is too ambiguous to guess.",
        ].join("\n"),
      );
      const raw = reply.trim();
      // Peel the trailing {"estMinutes": N} JSON tag off the shown assessment,
      // same shape as splitProposedAction — last balanced object on the tail.
      const parsed = splitEstMinutesTag(raw);
      const estimatedDurationMs =
        parsed.estMinutes != null && parsed.estMinutes > 0
          ? Math.min(parsed.estMinutes * 60_000, 24 * 60 * 60_000) // cap at 24h
          : null;
      const assessment = (parsed.body || raw).slice(0, 500) || `Auto-triaged — "${task.text}".`;
      return { assessment, estimatedDurationMs };
    } catch (err) {
      return {
        assessment: `Auto-triaged — "${task.text}" (assessment unavailable: ${(err as Error).message}).`,
        estimatedDurationMs: null,
      };
    }
  }

  /** Autonomous review of a finished run's open HITL: approve → resolve (merges →
   *  done via the normal path), else flag the task for a human. */
  private async autoReview(ws: string, agent: Agent, task: Task, hitl: HitlItem): Promise<void> {
    const run = task.runId ? await this.store.getRun(task.runId) : undefined;
    let approve = true;
    let reason = "auto-approved";
    try {
      const provider = await this.getProvider(agent.provider);
      if (provider.consult && run) {
        const apiKey = await secretService.resolve(ws, agent.credentialId ?? agent.provider);
        const context = run.log.slice(-30).map((l) => l.line).join("\n").slice(-3000);
        const reply = await provider.consult(
          { task: task.text, model: agent.model, cwd: config.runnerCwd, apiKey, context },
          `Review whether this run satisfies the task "${task.text}". Reply on the FIRST line with exactly APPROVE or FLAG, then a one-line reason.`,
        );
        const head = reply.trim().split("\n")[0]?.toUpperCase() ?? "";
        approve = !head.includes("FLAG");
        reason = reply.trim().slice(0, 300) || reason;
      }
    } catch (err) {
      approve = false;
      reason = `review consult failed: ${(err as Error).message}`;
    }
    // The consult above is slow (an LLM round-trip); meanwhile an operator — or
    // another actor — may have resolved this same gate and driven the run to
    // done. Re-validate against fresh state before writing so autonomy defers to
    // whatever already happened and never clobbers a task that moved on (a stale
    // `{...task, state:"review"}` write would knock a merged→done task back to
    // review). DEF-001: derive the write from fresh state, not the snapshot.
    const freshHitl = await this.store.getHitl(hitl.id);
    if (!freshHitl || freshHitl.resolvedAt) return; // already handled — defer
    const freshTask = await this.store.getTask(task.id);
    if (!freshTask || freshTask.state !== "review" || freshTask.runId !== task.runId) return;
    if (approve) {
      const resolution: Resolution = { action: "approve", optionIndex: null, guidance: null, by: "autonomy", at: now() };
      const resolved = await this.hub.resolveHitl(hitl.id, resolution);
      if (resolved && resolved.resolution?.at === resolution.at) await this.deliver(hitl, resolution);
    } else {
      await this.hub.upsertTask({ ...freshTask, reviewFlaggedReason: reason });
    }
  }

  /**
   * Release runners that are persisted "busy" but held by no live agent —
   * "orphaned busy" state. It happens across a restart (the in-memory live map
   * is empty, but the file/pg store still says busy) or if a freeRunner was ever
   * missed. Left alone, such a runner shows "busy" forever with no work, and the
   * retire guard refuses to remove it. Runs once at startup, where nothing is
   * live yet — so any busy runner is definitionally an orphan and safe to reset.
   * `isBusy` (the live map) is the source of truth for "actually executing".
   */
  async reconcileRunners(): Promise<void> {
    const runners = await this.store.listAllAgents().catch(() => [] as Agent[]);
    for (const r of runners) {
      if (r.status === "busy" && !this.isBusy(r.id)) {
        await this.hub.upsertAgent({ ...r, status: "idle", idleSince: now() });
      }
    }
  }

  /** Pause a running/waiting agent — halts its runner but keeps the session. */
  async pauseAgent(runId: string): Promise<TaskRun | undefined> {
    const agent = await this.store.getRun(runId);
    if (!agent || agent.status === "done" || agent.status === "paused") return agent;
    const live = this.live.get(runId);
    if (live) await live.handle.pause().catch(() => undefined);
    await this.hub.runStatus(runId, "paused");
    return this.store.getRun(runId);
  }

  /** Resume a paused agent back into the running state. */
  async resumeAgent(runId: string): Promise<TaskRun | undefined> {
    const agent = await this.store.getRun(runId);
    if (!agent || agent.status !== "paused") return agent;
    const live = this.live.get(runId);
    if (live) await live.handle.resume().catch(() => undefined);
    await this.hub.runStatus(runId, "running");
    return this.store.getRun(runId);
  }

  /** Operator "stop / remove": halt execution, free the runner, mark the agent done. */
  async haltAgent(runId: string): Promise<TaskRun | undefined> {
    const agent = await this.store.getRun(runId);
    if (!agent) return undefined;
    const live = this.live.get(runId);
    if (live?.agentId) {
      const runner = await this.store.getAgent(live.agentId);
      if (runner) await this.hub.upsertAgent({ ...runner, status: "idle", idleSince: now() });
    }
    await this.stopAgent(runId); // stop the handle + retire the worktree + drop the session
    // stopAgent detaches but leaves the status untouched — halt is the terminal
    // operator action, so mark it done and emit the completion event.
    if (agent.status !== "done") {
      await this.hub.runStatus(runId, "done");
      await this.hub.runCompleted(runId, agent.branch);
    }
    // A stopped run integrates no change, so its owning task must not be left
    // stranded "ongoing" (or "review") with no live run behind it — that reads as
    // in-progress while nothing is working it. Return the task to `todo` (cleanly
    // re-pickable) and archive+detach the dead run, mirroring the abandon path
    // (transitionTask ongoing/review → todo). Invariant: an `ongoing` task always
    // has a live run.
    const task = (await this.store.listTasks(agent.workspaceId)).find((t) => t.runId === runId);
    if (task && (task.state === "ongoing" || task.state === "review")) {
      await this.hub.setRunArchived(runId, true).catch(() => undefined);
      await this.hub.upsertTask({ ...task, state: "todo", runId: null, reviewFlaggedReason: null });
    }
    return this.store.getRun(runId);
  }

  isBusy(agentId: string): boolean {
    for (const l of this.live.values()) if (l.agentId === agentId) return true;
    return false;
  }

  /** Kill switch state — read/write the pause flag. When paused, tickAutonomy is
   *  a no-op; live runs are unaffected until {@link stopAll} halts them. */
  setPaused(p: boolean): void {
    this.paused = p;
  }
  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Remote kill switch: pause autonomy AND halt every in-flight run. "Stop all
   * processing" = no new autonomous work + no live runs still executing. The
   * janitorial loops (reaper/GC) keep running by design. Each run is halted
   * independently (a per-run failure is logged and skipped so one bad run can't
   * abort the sweep). Returns how many runs were stopped.
   */
  async stopAll(reason: string): Promise<number> {
    this.paused = true;
    // Snapshot the fleet first (haltAgent mutates run status as we go).
    const runs = await this.store.listAllRuns().catch(() => [] as TaskRun[]);
    const live = runs.filter((r) => r.status === "running" || r.status === "waiting");
    let stopped = 0;
    for (const run of live) {
      try {
        await this.haltAgent(run.id);
        stopped++;
      } catch (err) {
        // One run failing to halt must not abort the sweep — record and continue.
        await this.hub.runLog(run.id, `kill switch: failed to halt — ${(err as Error).message}`).catch(() => undefined);
      }
    }
    console.log(`[orchestrator] kill switch: ${reason} — paused autonomy, halted ${stopped} run(s)`);
    return stopped;
  }
}
