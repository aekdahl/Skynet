// ─── Orchestrator ─────────────────────────────────────────────────────────
// TaskRun lifecycle (Backend Brief §04): provision a runner, start an agent on a
// task, route HITL gates, deliver decisions, fork, complete. Phase 0 uses the
// mock runner; real providers drop in behind the same runner-sdk interface.

import type { TaskRun, Checkpoint, HitlItem, Project, Resolution, Agent, Task, TaskAssignment, ProviderId, ProviderInfo, MergeBriefing, Risk, Feature, Milestone, DiffWalkthrough } from "@skynet/shared";
import { WorkspaceSettings } from "@skynet/shared";
import {
  isCreditExhaustionError,
  type HitlRaise,
  type RunnerEvents,
  type RunnerHandle,
  type RunnerProvider,
} from "@skynet/runner-sdk";
import { basename } from "node:path";
import { classifyCommand } from "./command-safety.js";
import { decideAutoApproval } from "./approval-policy.js";
import { parseReviewVerdict, REVIEW_OUTPUT_INSTRUCTION } from "./review-verdict.js";
import { parseDiffWalkthrough, DIFF_WALKTHROUGH_INSTRUCTION, DIFF_WALKTHROUGH_SYSTEM } from "./diff-walkthrough.js";
import { decisionResumePrompt } from "./decision-resume.js";
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
 * PURE: extract a trailing `{"estMinutes": N, "clarity": "clear"|"unclear"}`
 * JSON tag off the triage LLM's reply. Returns the body (with the tag stripped)
 * plus each parsed field. Tolerates a code fence around the tag; ignores
 * non-numeric / malformed / missing values individually — a bad `estMinutes`
 * doesn't strip a valid `clarity` and vice versa. A missing signal stays
 * missing (never fabricated). Exported for the unit tests.
 *
 * `clarity` drives auto-promote triage→todo: only "clear" tasks auto-advance
 * (and only when they also have an eligibility set). "unclear" and null both
 * park the task in triage for a human to promote.
 */
export interface TriageTag {
  body: string;
  estMinutes: number | null;
  clarity: "clear" | "unclear" | null;
  // Grouping picks: the id of a suitable existing feature / milestone, or null.
  // Raw here — assessTask validates them against the project's actual ids (the
  // model must pick from a supplied list; we never trust a fabricated id).
  featureId: string | null;
  milestoneId: string | null;
  // Structured triage card (v1.5): rough agent-effort size and a short risks
  // list, alongside the existing estimate/clarity/grouping signals. Same
  // "missing signal stays missing" rule as every other field here.
  effort: "small" | "medium" | "large" | null;
  risks: string[] | null;
}

export function splitEstMinutesTag(raw: string): TriageTag {
  const none: TriageTag = {
    body: (raw ?? "").trim(),
    estMinutes: null,
    clarity: null,
    featureId: null,
    milestoneId: null,
    effort: null,
    risks: null,
  };
  const trimmed = (raw ?? "").trim();
  const noFence = trimmed.replace(/\n?```\s*$/, "").trimEnd();
  // Match the LAST balanced top-level {...} on the tail.
  const end = noFence.lastIndexOf("}");
  if (end === -1) return none;
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
  if (start < 0) return none;
  try {
    const obj = JSON.parse(noFence.slice(start, end + 1)) as {
      estMinutes?: unknown;
      clarity?: unknown;
      featureId?: unknown;
      milestoneId?: unknown;
      effort?: unknown;
      risks?: unknown;
    };
    // Parse each field independently — a malformed one shouldn't drop the tag.
    const estMinutes =
      typeof obj.estMinutes === "number" && Number.isFinite(obj.estMinutes) && obj.estMinutes > 0
        ? Math.round(obj.estMinutes)
        : null;
    const clarity: "clear" | "unclear" | null =
      obj.clarity === "clear" || obj.clarity === "unclear" ? obj.clarity : null;
    const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
    const featureId = str(obj.featureId);
    const milestoneId = str(obj.milestoneId);
    const effort: "small" | "medium" | "large" | null =
      obj.effort === "small" || obj.effort === "medium" || obj.effort === "large" ? obj.effort : null;
    // Cap count + length so a garbage/runaway array can't bloat the task record —
    // a legitimate risks list is a handful of short lines, never a wall of text.
    const risks = Array.isArray(obj.risks)
      ? obj.risks.filter((r): r is string => typeof r === "string" && r.trim().length > 0).map((r) => r.trim().slice(0, 140)).slice(0, 5)
      : null;
    // Only strip the tag from the body if AT LEAST ONE field parsed — if
    // none did the "JSON object" was probably a false positive in prose.
    if (estMinutes != null || clarity != null || featureId != null || milestoneId != null || effort != null || (risks != null && risks.length > 0)) {
      const body = noFence.slice(0, start).replace(/```[a-zA-Z]*\s*$/, "").trim();
      return { body, estMinutes, clarity, featureId, milestoneId, effort, risks };
    }
  } catch {
    /* not a JSON tail — whole reply is the body */
  }
  return none;
}

// Appended to every run brief. Scope creep — an agent finishing the ask and then
// wandering into unrequested adjacent work — is the #1 way a run burns its turn
// budget and stalls. Keep the agent inside the requested scope so it finishes.
const SCOPE_NOTE =
  "\n\n---\nScope discipline: do exactly what's asked above, then stop. Don't expand into adjacent or unrequested work — extra features, UI, refactors, or speculative follow-ups. When the requested change is complete, report and finish rather than inventing more scope. If you're genuinely blocked, or the task is too big for one focused session, escalate (AskUserQuestion with header \"ESCALATE\") instead of grinding through your turn budget.";

/** Prepend the project's `instructions` (the "house rules" for this codebase)
 *  to any prompt an agent will see. When there are no instructions this is a
 *  no-op — the prompt is returned unchanged, so runs on projects that never
 *  set the field behave exactly as they did before. The banner is fenced with
 *  a clear label so an agent that reads a stack of prompts knows what's
 *  project-scoped guidance vs. task-scoped ask. Exported for tests + reuse. */
export function withInstructions(instructions: string | null | undefined, body: string): string {
  const trimmed = instructions?.trim();
  if (!trimmed) return body;
  return `=== PROJECT INSTRUCTIONS (apply to every task in this project) ===\n${trimmed}\n\n=== TASK ===\n${body}`;
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
  // Key-health circuit breaker: credentials (`${ws}:${credentialId ?? provider}`)
  // known to be out of credits/quota. `providerUsable` refuses a depleted key so
  // NO new run is assigned to it (and auto-provision skips it) — stopping the
  // cascade of per-run billing failures. Cleared when a run on the key succeeds,
  // or when its escalation is resumed (operator topped up). In-memory: a restart
  // re-learns it on the next failed call, which is correct (the key may be fixed).
  private depletedKeys = new Map<string, { reason: string; at: number }>();
  // Runs already told "main moved" — so the periodic freshness sweep nudges once,
  // not every tick. Cleared if the branch catches back up (e.g. after a resync).
  private baseMovedFlagged = new Set<string>();

  // `providerOverride` is a test seam — inject a runner provider directly instead
  // of resolving the runner's own provider. Production always passes (store, hub) only.
  constructor(private store: Store, private hub: Hub, private providerOverride?: RunnerProvider) {}

  /** Build (or reuse) the git backend for a repo path + base branch. Cached so
   *  each (repo, base) keeps exactly one worktree provisioner and one serialized
   *  merge queue (§2). The base is part of the key: a project can point its runs
   *  at a feature branch instead of `main` (they cut from it, sync to it, and PR
   *  against it), so the same repo may back two contexts on different bases. */
  private gitContextForRepo(repo: string, baseBranch: string = config.baseBranch): GitContext {
    const key = `${repo} ${baseBranch}`;
    let ctx = this.gitCtx.get(key);
    if (!ctx) {
      const worktrees = new WorktreeProvisioner(repo, baseBranch, config.worktreesDir);
      const merge = new MergeEngine(
        repo,
        baseBranch,
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
      this.gitCtx.set(key, ctx);
    }
    return ctx;
  }

  /** The effective base branch for a project: its own `baseBranch` when set, else
   *  the server-global default (SKYNET_BASE_BRANCH || "main"). */
  private baseBranchFor(project?: Project | null): string {
    return project?.baseBranch ?? config.baseBranch;
  }

  /** Resolve the git backend for a project: its own local repo when git-backed,
   *  else the server-global integration repo, else none (Phase 0 → runnerCwd).
   *  Built on the project's effective base branch. */
  private gitContextFor(project?: Project | null): GitContext | undefined {
    const repo = project?.gitBacked && project.repoPath ? project.repoPath : config.integrationRepo;
    return repo ? this.gitContextForRepo(repo, this.baseBranchFor(project)) : undefined;
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
      onLogDelta: (runId, delta) => void this.hub.runLogDelta(runId, delta),
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
    // gates fall through to a human. The gate is still recorded (audit trail
    // shows what was auto-approved and by which policy — nothing runs invisibly),
    // but we go through the SILENT hub path (`raiseAndAutoResolveHitl`) so no
    // `hitl.raised` event is published — Telegram/push subscribers only ping the
    // operator when a HUMAN is actually needed. `hitl.resolved` still fires.
    if (raise.kind === "approval") {
      const project = await this.store.getProject(agent.projectId);
      const auto = decideAutoApproval({
        command: raise.command,
        level: project?.approvalLevel ?? "trusted",
        rules: project?.approvalRules ?? [],
      });
      if (auto) {
        const resolution: Resolution = { action: "approve", optionIndex: null, guidance: null, memoryNote: null, by: auto.by, at: now() };
        await this.hub.runLog(runId, `auto-approved (${auto.by}): ${item.command ?? item.title}`);
        await this.hub.raiseAndAutoResolveHitl(item, resolution);
        await this.deliver(item, resolution);
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
      memoryNote: null,
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
    // A successful turn proves the run's key works — clear any breaker on it.
    this.clearDepletedKey(await this.store.getRun(runId).catch(() => undefined));

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
        // Fetched alongside the stat (not inside raiseDiffReview) since it's the
        // same worktree/baseRef this function already has in scope — raiseDiffReview
        // only needs the text, to draft the walkthrough and hand to the HITL.
        const patch = await wt.patch(runId, live.baseRef);
        await this.freeRunner(live.agentId); // compute is done; awaiting review
        await this.hub.runStatus(runId, "review");
        // The run produced a diff → its task enters the review column (a human or
        // an autonomous reviewer resolves the diff HITL, which merges → done).
        if (live.taskId) {
          const task = await this.store.getTask(live.taskId);
          if (task) await this.hub.upsertTask({ ...task, state: "review" });
        }
        await this.raiseDiffReview(runId, stat, patch);
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
        await this.moveTaskToReview(live.taskId); // don't strand the card in Ongoing
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
      await this.moveTaskToReview(live.taskId); // don't strand the card in Ongoing
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
    // Out of credits/quota (a billing wall, not a bug): trip the key breaker so
    // the fleet stops feeding runs to a dead key, and escalate this run as
    // resumable. Checked first — it's a distinct, key-level condition, not one of
    // the N generic failures that trip the failure-count guard.
    if (isCreditExhaustionError(reason)) {
      await this.tripKeyBreaker(runId, reason);
      return;
    }
    // "Ran out of turns" is a resumable checkpoint, not a crash — the worktree +
    // committed work are intact and the runner already tried to continue on its
    // own. Escalate straight to a human (Resume / Reassign / Stop) rather than
    // counting it as a failure and parking in `review` for another doomed try.
    if (/error_max_turns|out of turns/i.test(reason)) {
      await this.escalate(
        runId,
        "The agent hit its turn budget before finishing. Its work so far is saved on the branch — resume to continue where it left off, reassign it, or stop.",
        "turns",
      );
      return;
    }
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
    await this.moveTaskToReview(live?.taskId); // don't strand the card in Ongoing
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
    await this.moveTaskToReview(this.live.get(runId)?.taskId); // don't strand the card in Ongoing
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

  /** Move a run's linked task into the `review` column. Called wherever a run
   *  enters `review` — including the needs-attention exits (commit/runner/startup
   *  failure, unanswered question), which previously flipped only the RUN to
   *  review and stranded its task in `ongoing`. The board places cards by
   *  task.state, so such a task showed a "review" chip while sitting in the
   *  Ongoing lane — locked and undraggable. Idempotent; only advances an in-flight
   *  task, never knocks a done / re-opened task back into review. */
  private async moveTaskToReview(taskId: string | null | undefined): Promise<void> {
    if (!taskId) return;
    const task = await this.store.getTask(taskId);
    if (task && task.state === "ongoing") await this.hub.upsertTask({ ...task, state: "review" });
  }

  /** Raise the `diff` review that gates a finished agent's branch into the queue. */
  private async raiseDiffReview(
    runId: string,
    stat: { add: number; del: number; files: string[] },
    patch: string,
  ): Promise<void> {
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
    const risk: Risk = stat.del > 200 || stat.files.length > 40 ? "high" : "medium";
    // Drafted BEFORE the item is raised — the reviewer should never see a diff
    // gate that later "pops in" a walkthrough. Best-effort: any failure (no
    // consult support, no credential, unreadable reply) yields null and the
    // gate raises exactly as it did before this existed.
    const walkthrough = await this.draftDiffWalkthrough(agent, project?.instructions, stat.files, patch);
    const item: HitlItem = {
      id: `q-diff-${runId}-${++this.seq}`,
      workspaceId: agent.workspaceId,
      runId,
      kind: "diff",
      // Concise, scannable title — the run/task is shown separately in every view
      // (queue card, audit row, run header), so embedding the whole task prompt
      // here just bloats the row. The stats + branch live in `why`.
      title: `Review diff — ${stat.add}+/${stat.del}− (${stat.files.length} file${stat.files.length === 1 ? "" : "s"})`,
      why: `Finished on ${agent.branch} — ${stat.add}+/${stat.del}- across ${stat.files.length} file(s). Approve to integrate.`,
      risk,
      raisedAt: now(),
      expiresAt: null,
      resolvedAt: null,
      resolution: null,
      rationale: null,
      command: null,
      options: null,
      recommended: null,
      steps: null,
      diff: { add: stat.add, del: stat.del, modules, files: stat.files, walkthrough },
      flags: [],
    };
    // `full` autonomy (see ApprovalLevel in @skynet/shared) skips even a diff's
    // OWN human decision, unconditionally — no second agent, no LLM consult.
    // This is distinct from (and stacks on top of) `autoReview` below: a
    // "trusted" multi-agent project can ALREADY merge unattended when a
    // DIFFERENT fleet agent reviews this run's diff and approves it, but that
    // needs a second agent and its favorable verdict. `full` needs neither.
    // Requires the project's `autonomy` toggle too (the master "let agents act
    // without me" switch), and still gates a `high`-risk (unusually large)
    // diff for a human even at this level. Recorded via the SILENT hub path —
    // same pattern as the command-gate auto-approver in raise() — so it's a
    // real audited decision, not a human notification that immediately
    // self-cancels.
    if (project?.approvalLevel === "full" && project.autonomy && risk !== "high") {
      const resolution: Resolution = { action: "approve", optionIndex: null, guidance: null, memoryNote: null, by: "policy:full-autonomy", at: now() };
      await this.hub.runLog(runId, `auto-merged (policy:full-autonomy): ${item.title}`);
      await this.hub.raiseAndAutoResolveHitl(item, resolution);
      await this.deliver(item, resolution);
      return;
    }
    await this.hub.raiseHitl(item);
  }

  /**
   * Ask the run's OWN provider/model to explain its diff — a stateless
   * one-shot `consult`, same pattern as `autoReview` — before the diff HITL is
   * raised. Grounded on the real patch (`context`), not the agent's
   * self-reported summary. Empty patch (no git worktree) or no `consult`
   * support (most CLI runners today) → no walkthrough, not an error.
   */
  private async draftDiffWalkthrough(
    run: TaskRun,
    projectInstructions: string | null | undefined,
    files: string[],
    patch: string,
  ): Promise<DiffWalkthrough | null> {
    if (!patch) return null;
    try {
      const provider = await this.getProvider(run.provider);
      if (!provider.consult) return null;
      const apiKey = await secretService.resolve(run.workspaceId, run.credentialId ?? run.provider);
      const reply = await provider.consult(
        {
          task: withInstructions(projectInstructions, run.name),
          model: run.model,
          cwd: config.runnerCwd,
          apiKey,
          context: patch,
          system: DIFF_WALKTHROUGH_SYSTEM,
        },
        DIFF_WALKTHROUGH_INSTRUCTION,
      );
      return parseDiffWalkthrough(reply, files);
    } catch {
      return null; // best-effort — a draft failure never blocks the review
    }
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
    // Circuit breaker: a key known to be out of credits/quota is refused for new
    // work — regardless of the provider seam — until it's topped up. Checked
    // FIRST so a depleted key can't slip through the injected-provider path.
    if (this.depletedKeys.has(this.keyId(workspaceId, provider, credentialId))) return false;
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

  /** Breaker key for a run's effective credential (`credentialId ?? provider`). */
  private keyId(workspaceId: string, provider: Agent["provider"], credentialId?: string | null): string {
    return `${workspaceId}:${credentialId ?? provider}`;
  }

  /**
   * Trip the key-health breaker for a run that failed on a billing wall (out of
   * credits/quota). Marks the credential depleted — so `providerUsable` refuses
   * it and NO new run is assigned to it (nor auto-provisioned onto it) until it's
   * topped up — logs ONE key-level notice (the first hit), then escalates THIS
   * run so it's resumable once the operator tops up. Returns without counting a
   * generic failure.
   */
  private async tripKeyBreaker(runId: string, reason: string): Promise<void> {
    const run = await this.store.getRun(runId);
    if (run) {
      const key = this.keyId(run.workspaceId, run.provider, run.credentialId);
      if (!this.depletedKeys.has(key)) {
        this.depletedKeys.set(key, { reason, at: now() });
        await this.hub
          .runLog(runId, `provider key out of credits/quota — new runs on it are paused until it's topped up (${reason})`)
          .catch(() => undefined);
      }
    }
    await this.escalate(
      runId,
      `The provider key is out of credits or quota — ${reason}. Top up the key, then resume this run; other work on the same key is paused until then.`,
      "billing",
    );
  }

  /** Clear the breaker for a run's key — its credential is working again (a run on
   *  it succeeded, or the operator resumed an escalation after topping up). */
  private clearDepletedKey(run: TaskRun | undefined): void {
    if (run) this.depletedKeys.delete(this.keyId(run.workspaceId, run.provider, run.credentialId));
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
    // The project's enabled-key allowlist (secret-store credential ids; empty =
    // any key). A runner is assignable only if its key (credentialId ?? provider)
    // is in this set — the project-level provider-key confinement.
    allowedCredentialIds: string[] = [],
    // The task's saved Start-picker preference (Task.preferredProvider/-Model).
    // A SOFT hint, not a requirement: tried first among idle+usable runners,
    // but any mismatch (no provider match, or matches but none usable) falls
    // straight through to the unchanged default pick below — a preference must
    // never block a task the way `agents`-mode eligibility legitimately can.
    preferred?: { provider?: TaskRun["provider"] | null; model?: string | null },
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
      const keyAllowed = (r: Agent) =>
        allowedCredentialIds.length === 0 || allowedCredentialIds.includes(r.credentialId ?? r.provider);
      const pooled = runners.filter((r) => inPool(r.id));
      if (eligible?.mode === "agents" && pooled.length === 0) {
        throw new NoCapacityError("None of this task's assigned agents exist in the fleet.");
      }
      // Confine to runners on a key this project is allowed to run on.
      const eligibleRunners = pooled.filter(keyAllowed);
      if (eligibleRunners.length === 0) {
        throw new NoCapacityError(
          "No fleet runner uses a provider key enabled for this project — enable one of its keys in the project's settings, or add a runner on an allowed key in Fleet.",
        );
      }
      const idle = eligibleRunners.filter((r) => r.status === "idle");
      // Try the preference FIRST, ranked exact-model > provider-only, before the
      // plain "first idle, usable" pick below. `sort` is stable, so when nothing
      // matches (every rank is 0) this reduces to the original order and the
      // loop falls straight through on its first iteration — a task with no
      // preference (or one nothing idle can satisfy) picks exactly as before.
      if (idle.length > 0 && preferred?.provider) {
        const rank = (r: Agent) =>
          r.provider !== preferred.provider ? 0 : preferred.model && r.model === preferred.model ? 2 : 1;
        for (const r of [...idle].sort((a, b) => rank(b) - rank(a))) {
          if (rank(r) === 0) break; // ranked list is sorted — no more candidates
          if (await this.providerUsable(workspaceId, r.provider, r.credentialId)) {
            await this.hub.upsertAgent({ ...r, status: "busy", idleSince: null });
            return { id: r.id, provider: r.provider, model: r.model, credentialId: r.credentialId ?? null };
          }
        }
      }
      if (idle.length === 0) {
        // Auto-scale: every eligible runner is busy. If the workspace policy
        // allows it AND we're under the fleet cap, clone an eligible runner
        // (already on an allowed key) and provision a fresh one instead of
        // making the task wait. At the cap we fall through to NoCapacityError —
        // the task queues until a runner frees up. Atomic under acquireExclusive.
        const settings = await this.fleetPolicy(workspaceId);
        const underCap = !settings.maxRunners || runners.length < settings.maxRunners;
        const template = eligibleRunners[0]; // a busy runner on an allowed key
        if (settings.autoProvisionRunners && underCap && template && (await this.providerUsable(workspaceId, template.provider, template.credentialId))) {
          const id = `runner-auto-${++this.seq}`;
          const runner: Agent = { id, workspaceId, name: id, provider: template.provider, credentialId: template.credentialId, model: template.model, status: "busy", idleSince: null, autoProvisioned: true, canReview: true, label: template.label ?? null };
          await this.hub.upsertAgent(runner);
          return { id, provider: template.provider, model: template.model, credentialId: template.credentialId ?? null };
        }
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
      // All idle runners exist but none has a usable key. If that's because the
      // key is out of credits (breaker tripped), say so — don't send the operator
      // hunting for a "missing" key that's actually just empty.
      const drained = idle
        .map((r) => this.depletedKeys.get(this.keyId(workspaceId, r.provider, r.credentialId)))
        .find((d): d is { reason: string; at: number } => d !== undefined);
      if (drained) {
        throw new RunnerNotConfiguredError(`Provider key is out of credits/quota — top it up to resume (${drained.reason}).`);
      }
      throw new RunnerNotConfiguredError(
        "No credential for any available agent — add a key for its provider/credential in Settings (or sign in a CLI-login provider). Nothing runs without one.",
      );
    });
  }

  /** The workspace fleet policy, defaulted when never set (so maxRunners=100 and
   *  the reaper TTL apply to unconfigured workspaces too). */
  private async fleetPolicy(ws: string): Promise<WorkspaceSettings> {
    return (await this.store.getWorkspaceSettings(ws)) ?? WorkspaceSettings.parse({ workspaceId: ws });
  }

  /** A project's enabled-runner-key allowlist (empty = any key). */
  private async projectKeyAllowlist(projectId: string): Promise<string[]> {
    return (await this.store.getProject(projectId))?.enabledRunnerCredentialIds ?? [];
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
    // The owning project's enabled-key allowlist (empty = any). Confines which
    // idle runner may be reused, so a fork/retry can't land on a key the project
    // isn't allowed to run on. The provisioned fallback uses the requested
    // credential, which the caller already resolved from an allowed run.
    allowedCredentialIds: string[] = [],
  ): Promise<{ id: string; provider: TaskRun["provider"]; model: string; credentialId: string | null }> {
    return this.acquireExclusive(async () => {
      const runners = await this.store.listAgents(workspaceId);
      const keyAllowed = (r: Agent) =>
        allowedCredentialIds.length === 0 || allowedCredentialIds.includes(r.credentialId ?? r.provider);
      // Prefer an idle agent that's on an allowed key AND can actually execute.
      for (const r of runners.filter((r) => r.status === "idle" && keyAllowed(r))) {
        if (await this.providerUsable(workspaceId, r.provider, r.credentialId)) {
          await this.hub.upsertAgent({ ...r, status: "busy", idleSince: null });
          return { id: r.id, provider: r.provider, model: r.model, credentialId: r.credentialId ?? null };
        }
      }
      // Respect the workspace fleet cap — fork/retry provisioning is auto-creation
      // too, so the ceiling applies here as well (0 = no cap).
      const settings = await this.fleetPolicy(workspaceId);
      if (settings.maxRunners && runners.length >= settings.maxRunners) {
        throw new NoCapacityError(`Fleet is at its maximum of ${settings.maxRunners} runners — free a runner or raise the limit in settings.`);
      }
      // None idle+usable → provision one for the requested provider + credential,
      // but only if that credential is usable (else nothing can run).
      if (!(await this.providerUsable(workspaceId, provider, credentialId))) {
        throw new RunnerNotConfiguredError(
          `No credential for provider "${provider}" — add a key in Settings (or sign in a CLI-login provider). Nothing runs without one.`,
        );
      }
      const id = `runner-auto-${++this.seq}`;
      const runner: Agent = { id, workspaceId, name: id, provider, credentialId: credentialId ?? null, model, status: "busy", idleSince: null, autoProvisioned: true, canReview: true, label: null };
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

    // An archived task is soft-hidden — never spawn a run on it (which would show
    // the archived task "running"). Defense in depth: the autonomy loop already
    // skips archived tasks; this also refuses any other caller (manual API / MCP /
    // Steward). Un-archive it first to work on it again.
    if (task.archived) {
      throw new Error("Task is archived — unarchive it before assigning");
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
    const runner = await this.acquireAgent(project.workspaceId, assignment, project.enabledRunnerCredentialIds, {
      provider: task.preferredProvider,
      model: task.preferredModel,
    });
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
      pr: null,
      mergedAt: null,
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
      // Isolated worktree cut from LATEST main: provisionCwd fetches origin and
      // branches from origin/<base> (no baseRef passed), so every run starts on
      // the newest human-merged state — not a stale local integration branch.
      const { cwd, baseRef } = await this.provisionCwd(git, runId, branch);
      // Inject this workspace's provider key (env fallback when none is stored).
      const apiKey = await secretService.resolve(project.workspaceId, runner.credentialId ?? runner.provider);
      // The agent gets the full brief: the short name plus the longer
      // description when one exists (the run's display name stays the short text).
      const taskBody = (task.description ? `${task.text}\n\n${task.description}` : task.text) + SCOPE_NOTE;
      const brief = withInstructions(project.instructions, taskBody);
      // Opt-in browser tooling is a per-workspace setting, off by default; the
      // runner decides how to expose it (Claude → a Playwright MCP server).
      const { browserTools } = await this.fleetPolicy(project.workspaceId);
      const handle = await provider.start(
        { runId, projectId, task: brief, model: runner.model, branch, cwd, apiKey, browser: browserTools, planModeGate: project.planModeGate },
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
    const runner = await this.acquireOrProvisionRunner(parent.workspaceId, parent.provider, parent.model, parent.credentialId, await this.projectKeyAllowlist(parent.projectId));
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
      mergedAt: null, // a fork is a fresh, unmerged run — never inherit the parent's
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
        {
          runId,
          projectId: parent.projectId,
          task: withInstructions(project?.instructions, parent.name),
          model: runner.model,
          branch: agent.branch,
          cwd,
          parentId,
          branchFromStep: stepIndex,
          apiKey,
        },
        this.events(),
      );
      this.live.set(runId, { handle, agentId: runner.id, taskId: null, branch: agent.branch, baseRef, git });
    } catch (err) {
      await this.failStartup(runId, runner.id, (err as Error).message);
      throw err;
    }
    return agent;
  }

  // ── checkpoint / restore ────────────────────────────────────────────────
  // Snapshot a run's worktree + plan state mid-run so a long task can be
  // rewound in place if it goes sideways — an extension of fork/resume: fork
  // branches a NEW run off wherever the parent currently sits; a checkpoint
  // pins a POINT on THIS run's own branch, and restoreCheckpoint rewinds this
  // SAME run back to it (worktree +, for Claude, the SDK session — best-effort;
  // see the runner-sdk `resumeSessionId` doc for why this can't be a perfect
  // point-in-time conversation rewind, only "resume from that session").

  /** Every checkpoint taken on a run, oldest first. */
  async listCheckpoints(runId: string): Promise<Checkpoint[]> {
    return this.store.listCheckpoints(runId);
  }

  /**
   * Manually snapshot a live run: commit whatever's uncommitted in its
   * worktree, capture the resulting sha (pinned under a stable ref so a later
   * restore's branch reset can't lose it to gc), the run's current plan +
   * progress, and — Claude only — its SDK session id. Requires a live
   * worktree: there's nothing in-flight to snapshot once a run's compute is
   * gone. (Automatic per-plan-step checkpointing was the other option here —
   * this manual trigger is the smaller, safer piece to land first: no new hook
   * into the plan-progress dataflow, no risk of checkpoint spam on a chatty
   * plan. See PR description.)
   */
  async checkpoint(runId: string, label?: string | null): Promise<Checkpoint> {
    const run = await this.store.getRun(runId);
    if (!run) throw new Error("Run not found");
    const live = this.live.get(runId);
    if (!live) throw new Error("This run isn't live — nothing in flight to checkpoint.");
    const git = live.git ?? (await this.gitContextForAgent(runId).catch(() => undefined));
    if (!git || !git.worktrees.exists(runId)) throw new Error("This run has no worktree to checkpoint.");

    await git.worktrees.commitAll(runId, `checkpoint${label ? `: ${label}` : ""}`);
    const sha = await git.worktrees.headSha(runId);
    const id = `cp-${runId}-${++this.seq}`;
    await git.worktrees.pinRef(`refs/skynet/checkpoints/${id}`, sha);

    const checkpoint: Checkpoint = {
      id,
      runId,
      workspaceId: run.workspaceId,
      label: label ?? null,
      sha,
      claudeSessionId: run.provider === "claude" ? (live.handle.getSessionId?.() ?? null) : null,
      plan: run.plan,
      progress: run.progress,
      createdAt: now(),
    };
    await this.store.putCheckpoint(checkpoint);
    await this.hub.runLog(runId, `checkpoint saved${label ? ` — "${label}"` : ""} (${sha.slice(0, 7)})`);
    return checkpoint;
  }

  /**
   * Rewind a run to an earlier checkpoint IN PLACE: stop whatever's currently
   * live, re-provision the worktree at the checkpoint's pinned sha (a hard
   * reset of the run's own branch — forward commits drop off the branch,
   * though the pinned ref keeps them reachable on disk), and relaunch the
   * provider resuming the checkpoint's captured session (Claude) so the
   * conversation, not just the git state, rewinds.
   */
  async restoreCheckpoint(runId: string, checkpointId: string): Promise<TaskRun> {
    const run = await this.store.getRun(runId);
    if (!run) throw new Error("Run not found");
    const checkpoint = await this.store.getCheckpoint(checkpointId);
    if (!checkpoint || checkpoint.runId !== runId) throw new Error("Checkpoint not found");

    const project = await this.store.getProject(run.projectId);
    const live = this.live.get(runId);
    const git = live?.git ?? this.gitContextFor(project);
    if (!git) throw new Error("This run has no git worktree to restore.");

    // Tear down any current execution before rewinding the worktree out from
    // under it — mirrors stopAgent's detach, but keeps the run's own slot
    // (status flips back to running below) rather than marking it done.
    if (live) {
      await live.handle.stop().catch(() => undefined);
      await this.freeRunner(live.agentId);
      this.live.delete(runId);
    }

    const runner = await this.acquireOrProvisionRunner(run.workspaceId, run.provider, run.model, run.credentialId, await this.projectKeyAllowlist(run.projectId));
    const provider = await this.getProvider(runner.provider);
    const { cwd, baseRef } = await this.provisionCwd(git, runId, run.branch, checkpoint.sha);
    const apiKey = await secretService.resolve(run.workspaceId, runner.credentialId ?? runner.provider);
    const resumeSessionId = run.provider === "claude" ? checkpoint.claudeSessionId : null;
    const taskId = (await this.store.listTasks(run.workspaceId)).find((t) => t.runId === runId)?.id ?? null;

    await this.hub.runProgress(runId, checkpoint.progress, checkpoint.plan);
    await this.hub.runStatus(runId, "running");
    await this.hub.runLog(
      runId,
      `restored to checkpoint${checkpoint.label ? ` "${checkpoint.label}"` : ""} (${checkpoint.sha.slice(0, 7)}) — worktree rewound, ${resumeSessionId ? "conversation resumed" : "fresh turn started"}`,
    );
    if (taskId) {
      const task = await this.store.getTask(taskId);
      if (task) await this.hub.upsertTask({ ...task, state: "ongoing" });
    }

    try {
      const handle = await provider.start(
        {
          runId,
          projectId: run.projectId,
          task: withInstructions(project?.instructions, run.name),
          model: runner.model,
          branch: run.branch,
          cwd,
          apiKey,
          resumeSessionId,
        },
        this.events(),
      );
      this.live.set(runId, { handle, agentId: runner.id, taskId, branch: run.branch, baseRef, git });
    } catch (err) {
      await this.failStartup(runId, runner.id, (err as Error).message);
      throw err;
    }
    return (await this.store.getRun(runId))!;
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
      return;
    }
    // No live runner to receive the decision — the parked session is gone (a
    // crash, or a server restart dropped the in-memory handle). Recover the way
    // an escalation/revise does: re-acquire compute and resume the run in its
    // worktree carrying the decision, so an approval/answer isn't silently lost.
    if (await this.resumeDecisionOnFreshRunner(item, resolution)) return;
    // Nothing to resume into (no worktree — e.g. a seeded/demo agent or a
    // non-git run) or an unsupported kind. Be honest: record that it couldn't be
    // delivered — don't fake a resume by flipping the agent back to "running".
    await this.hub.runLog(runId, `decision "${resolution.action}" recorded, but no live runner is attached — not delivered to an agent`);
  }

  /** A parked decision (approval / question / plan) whose runner already exited.
   *  Re-acquire compute and start a FRESH turn in the run's worktree carrying the
   *  operator's decision — the same recovery as {@link relaunchEscalated}, but for
   *  the resolve path. Returns true when it took over (resumed, or surfaced a
   *  no-compute failure); false when there's nothing to resume into (no worktree)
   *  or the kind isn't a mid-run gate, so the caller logs it as undelivered. */
  private async resumeDecisionOnFreshRunner(item: HitlItem, resolution: Resolution): Promise<boolean> {
    const runId = item.runId;
    // Only the mid-run "agent is parked, waiting on the operator" kinds resume by
    // re-prompting. diff/merge are review-stage (approve merges, modify revises —
    // both handled above) with different lifecycle semantics.
    if (item.kind !== "approval" && item.kind !== "question" && item.kind !== "plan") return false;
    const run = await this.store.getRun(runId);
    if (!run) return false;
    const git = await this.gitContextForAgent(runId).catch(() => undefined);
    // No worktree on disk → nothing committed to continue in. Fall back to the
    // honest "not delivered" log rather than launching an agent with no context.
    if (!git || !git.worktrees.exists(runId)) return false;

    let acq: { id: string; provider: TaskRun["provider"]; model: string };
    try {
      acq = await this.acquireOrProvisionRunner(run.workspaceId, run.provider, run.model, run.credentialId, await this.projectKeyAllowlist(run.projectId));
    } catch (err) {
      // Couldn't get compute right now — surface it (and park as waiting for a
      // retry) instead of the misleading "no runner attached" line.
      await this.hub.runLog(runId, `decision "${resolution.action}" recorded, but no compute is free to deliver it — ${(err as Error).message}`);
      await this.hub.runStatus(runId, "waiting");
      return true;
    }
    const provider = await this.getProvider(acq.provider);
    const cwd = git.worktrees.pathFor(runId);
    const apiKey = await secretService.resolve(run.workspaceId, run.credentialId ?? run.provider);
    const project = await this.store.getProject(run.projectId);
    const prompt = withInstructions(project?.instructions, decisionResumePrompt(item, resolution, run.branch));
    const taskId = (await this.store.listTasks(run.workspaceId)).find((t) => t.runId === runId)?.id ?? null;
    await this.hub.runStatus(runId, "running");
    if (taskId) {
      const task = await this.store.getTask(taskId);
      if (task) await this.hub.upsertTask({ ...task, state: "ongoing" });
    }
    await this.hub.runLog(runId, `re-acquired compute to deliver "${resolution.action}" — resuming in the run's worktree`);
    try {
      const handle = await provider.start(
        { runId, projectId: run.projectId, task: prompt, model: run.model, branch: run.branch, cwd, apiKey },
        this.events(),
      );
      this.live.set(runId, { handle, agentId: acq.id, taskId, branch: run.branch, baseRef: config.baseBranch, git });
    } catch (err) {
      await this.failStartup(runId, acq.id, (err as Error).message);
    }
    return true;
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
      acq = await this.acquireOrProvisionRunner(run.workspaceId, run.provider, run.model, run.credentialId, await this.projectKeyAllowlist(run.projectId));
    } catch (err) {
      await this.hub.runLog(runId, `cannot revise — ${(err as Error).message}`);
      return;
    }
    const provider = await this.getProvider(acq.provider);
    const cwd = review.git.worktrees.pathFor(runId);
    const apiKey = await secretService.resolve(run.workspaceId, run.credentialId ?? run.provider);
    const project = await this.store.getProject(run.projectId);
    const revisePrompt = withInstructions(
      project?.instructions,
      `A reviewer looked at your work and asked for changes before it can be merged:\n\n${guidance}\n\n` +
      `Your previous output is already in the working directory (branch ${run.branch}). Read it, make ` +
      `only the changes needed to address the request, then stop.`,
    );
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
  private async escalate(runId: string, reason: string, source: "timeout" | "failures" | "conflict" | "turns" | "stalled" | "billing"): Promise<void> {
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
      title:
        source === "timeout"
          ? "Run stuck — needs a human"
          : source === "conflict"
            ? "Merge conflict with main — needs a rebase"
            : source === "turns"
              ? "Ran out of turns — resume to continue"
              : source === "stalled"
                ? "Runner went silent — resume to continue"
                : source === "billing"
                  ? "Provider key out of credits — top up to resume"
                  : "Run keeps failing — needs a human",
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
    // Resuming a run implies the operator addressed whatever blocked it — if it
    // was a billing wall, clear the breaker so this run (and others on the key)
    // can acquire a runner again. Done before the worktree check so the key is
    // freed even when this particular run can't be relaunched.
    this.clearDepletedKey(run);
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
      acq = await this.acquireOrProvisionRunner(run.workspaceId, run.provider, run.model, undefined, await this.projectKeyAllowlist(run.projectId));
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
    const project = await this.store.getProject(run.projectId);
    const prompt = withInstructions(
      project?.instructions,
      reassign
        ? `You are taking over a task another agent escalated because it got stuck. Its work so far is already in the working directory (branch ${run.branch}).${guidance ? `\n\nOperator guidance:\n\n${guidance}` : ""}\n\nReview what's there, then continue and finish the task. If you also get stuck, escalate (AskUserQuestion with header "ESCALATE").`
        : `You escalated this task for help, and the operator responded:\n\n${guidance || "(no specific guidance — use your best judgement, or escalate again if still blocked)"}\n\nYour work so far is already in the working directory (branch ${run.branch}). Continue with this guidance and finish, or escalate again (AskUserQuestion with header "ESCALATE") if you're still blocked.`,
    );
    // Reflect the (re)acquired runner on the persisted run: a reassign moves the
    // run to a DIFFERENT agent, and the board/subway attribute runs by agentId —
    // without this the run stays drawn under the agent it was escalated from
    // (which is now idle), looking like a stray/duplicate station.
    const running = await this.store.getRun(runId);
    if (running) await this.hub.upsertRun({ ...running, status: "running", agentId: acq.id });
    else await this.hub.runStatus(runId, "running");
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
      this.live.set(runId, { handle, agentId: acq.id, taskId: ctx?.taskId ?? null, branch: run.branch, baseRef: ctx?.baseRef ?? this.baseBranchFor(project), git });
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
    const merged = await this.store.getRun(runId);
    if (merged) await this.hub.upsertRun({ ...merged, mergedAt: now() });
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
    // The project's effective base branch — its own `baseBranch` when set (e.g. a
    // feature branch this project stacks onto), else the global default. This is
    // what the branch syncs to, is diffed against, and PRs into.
    const base = this.baseBranchFor(project);
    // Bring the branch up to the LATEST base before the PR opens, so it merges
    // cleanly and the reviewer/GitHub never hits a stale-base conflict at merge
    // time. On conflict, escalate for a human rebase instead of opening a broken PR.
    const sync = await git.worktrees.mergeBase(agent.id);
    if (!sync.ok) {
      const files = sync.conflicts?.length ? `: ${sync.conflicts.join(", ")}` : "";
      await this.hub.runLog(agent.id, `${base} moved and merges conflict${files} — not opening a PR until it's rebased.`);
      await this.escalate(agent.id, `merge conflict with ${base}${files} — rebase the branch, then re-approve to open the PR.`, "conflict");
      return;
    }
    await this.openPrForRun(git, agent, repo, project, base, sync);
  }

  /** Push a base-synced branch and open (or refresh, idempotently) its PR, then
   *  record the ready-to-merge PR + advance the task to done. Shared by the first
   *  open (pushToGithub) and the "Update branch" re-sync (updateReadyPrBranch);
   *  the caller runs `mergeBase` first and decides how to handle a conflict. */
  private async openPrForRun(
    git: GitContext,
    agent: TaskRun,
    repo: string,
    project: Project | null | undefined,
    base: string,
    sync: { depsChanged?: boolean },
  ): Promise<void> {
    // If folding in the base changed a dependency manifest, reconcile the worktree's
    // deps so a revise loop / checks / preview run against the right ones.
    if (sync.depsChanged) {
      const r = await git.worktrees.installDeps(agent.id);
      await this.hub.runLog(
        agent.id,
        r.installed
          ? `${base} changed dependencies — re-installed (${r.note}).`
          : `${base} changed dependencies${r.note ? ` — ${r.note}` : " — no local node_modules to reconcile, skipped install"}.`,
      );
    }
    const worktreePath = git.worktrees.pathFor(agent.id);
    const stat = await git.worktrees.diffStat(agent.id, base);
    const modules = this.moduleMapFor(project).modulesForFiles(stat.files);
    await this.hub.runStatus(agent.id, "review");
    // A task imported from a GitHub issue (Task.source) gets GitHub's own
    // "Closes #N" convention in the PR body, so merging the PR auto-closes the
    // source issue — belt-and-suspenders alongside task-sync.ts's direct
    // close-on-done write-back, since the human merge and the task reaching
    // `done` don't necessarily happen in the same order.
    const sourcedTask = (await this.store.listTasks(agent.workspaceId)).find((t) => t.runId === agent.id);
    const issueRef =
      sourcedTask?.source?.kind === "github_issue"
        ? sourcedTask.source.repo === repo
          ? `#${sourcedTask.source.number}`
          : `${sourcedTask.source.repo}#${sourcedTask.source.number}`
        : null;
    try {
      const result = await githubService.pushAndOpenPr({
        workspaceId: agent.workspaceId,
        runId: agent.id,
        repo,
        branch: agent.branch,
        baseBranch: base,
        worktreePath,
        changedFiles: stat.files,
        modules,
        allowedModules: agent.modules, // [] = unconstrained (no scope declared)
        force: false,
        githubCredentialId: project?.githubCredentialId ?? null, // push to the project's pinned account
        title: agent.name,
        body: `Automated by Skynet agent \`${agent.id}\`.\n\n${stat.add}+/${stat.del}- across ${stat.files.length} file(s).${issueRef ? `\n\nCloses ${issueRef}` : ""}`,
      });
      if (!result.ok) {
        await this.hub.runLog(agent.id, `push blocked by safety policy: ${result.violations.map((v) => v.message).join("; ")}`);
        return;
      }
      await this.hub.runLog(agent.id, `pushed ${agent.branch} → opened PR ${result.pr?.url ?? "(opened)"}`);

      // Opening the PR completes the task's WORK — advance it to `done` so the
      // pipeline never stalls. Merging is decoupled: the PR is recorded as
      // "ready to merge" (with the AI reviewer's briefing) and a human makes the
      // final merge call from that list. Skynet never auto-merges to the real
      // base branch — opening the PR is automated, the merge decision is a
      // human's. The worktree + review handle are KEPT (retire happens on merge)
      // so "rework with comment" can resume the agent on the same branch.
      if (result.pr) {
        const briefing = await this.buildMergeBriefing(agent, stat, modules);
        const fresh = await this.store.getRun(agent.id);
        if (fresh) {
          await this.hub.upsertRun({
            ...fresh,
            pr: { number: result.pr.number, url: result.pr.url, repo, branch: agent.branch, base, state: "open", openedAt: now(), briefing, dismissed: false },
          });
        }
        await this.hub.runLog(agent.id, `ready to merge — ${briefing.recommendation} (risk: ${briefing.risk}). Review + merge from the Ready-to-merge list; Skynet won't auto-merge.`);
        await this.markTaskDoneForRun(agent.id);
        await this.hub.runStatus(agent.id, "done");
      } else {
        // No PR ref came back (shouldn't happen) — keep the safe parked behavior.
        await this.hub.runStatus(agent.id, "review");
        await this.hub.runLog(agent.id, "PR opened but no reference returned — merge it on GitHub to complete.");
      }
    } catch (err) {
      await this.hub.runLog(agent.id, `GitHub push failed: ${(err as Error).message}`);
    }
  }

  // Sensitive areas — a change touching these reads as higher-risk on the
  // ready-to-merge card (matched against module ids AND file paths, case-insensitive).
  private static readonly SENSITIVE =
    /(auth|login|session|token|secret|credential|password|payment|billing|charge|invoice|migration|schema|infra|deploy|terraform|k8s|kubernetes|security|permission|rbac)/i;

  /** A deterministic decision-aid for the ready-to-merge card, from data already
   *  in hand — the diff stat + mapped modules — plus the AI reviewer's recorded
   *  verdict (task.reviewVerdict) when present: approve→merge, flag→rework. No LLM
   *  call here; the reviewer already ran (see autoReview). Falls back cleanly when
   *  no review was recorded (e.g. a human approved the diff directly). */
  private async buildMergeBriefing(
    run: TaskRun,
    stat: { add: number; del: number; files: string[] },
    modules: string[],
  ): Promise<MergeBriefing> {
    const task = (await this.store.listTasks(run.workspaceId)).find((t) => t.runId === run.id);
    const verdict = task?.reviewVerdict ?? null;
    const files = stat.files;
    const sensitive = [...modules, ...files].some((s) => Orchestrator.SENSITIVE.test(s));
    const touchesTests = files.some((f) => /(\.test\.|\.spec\.|\/tests?\/|__tests__)/i.test(f));
    // Risk: a sensitive area → high; an otherwise broad change → medium; else low.
    const big = files.length > 15 || stat.del > 400 || stat.add + stat.del > 800;
    const risk: Risk = sensitive ? "high" : big ? "medium" : "low";
    const recommendation: MergeBriefing["recommendation"] = verdict?.decision === "flag" ? "rework" : "merge";
    const impact = [
      modules.length
        ? `Touches ${modules.slice(0, 6).join(", ")}${modules.length > 6 ? ` +${modules.length - 6} more` : ""}`
        : `${files.length} file(s), no mapped module`,
      sensitive ? "includes a sensitive area (auth/data/infra)" : null,
      touchesTests ? "changes tests" : "no test changes",
    ]
      .filter(Boolean)
      .join(" · ");
    return {
      summary: `${run.name} — ${stat.add}+/${stat.del}− across ${files.length} file(s)`,
      impact,
      risk,
      recommendation,
      rationale: verdict ? `${verdict.by}: ${verdict.reason}` : "No AI review recorded — merge at your discretion.",
      by: verdict?.by ?? "heuristic",
    };
  }

  /** Mark a run's owning task done (idempotent) — used the moment its PR opens,
   *  so the pipeline completes and the PR moves to the decoupled merge list. */
  private async markTaskDoneForRun(runId: string): Promise<void> {
    const run = await this.store.getRun(runId);
    if (!run) return;
    const taskId =
      this.reviews.get(runId)?.taskId ??
      (await this.store.listTasks(run.workspaceId)).find((t) => t.runId === runId)?.id;
    if (!taskId) return;
    const task = await this.store.getTask(taskId);
    if (task && task.state !== "done") await this.hub.upsertTask({ ...task, state: "done" });
  }

  // ── Ready-to-merge: the human's final PR merge decision, from the list ──────
  /** Runs whose PR is open and not set-aside — the ready-to-merge list. */
  async listReadyPrs(workspaceId: string): Promise<TaskRun[]> {
    const runs = await this.store.listAllRuns().catch(() => [] as TaskRun[]);
    return runs.filter((r) => r.workspaceId === workspaceId && r.pr?.state === "open" && !r.pr.dismissed);
  }

  /** Merge an open PR from the ready list. Success → integrate + settle to done
   *  (completeMerged). GitHub may block it (branch protection / required checks) —
   *  returned as `{merged:false, reason}`, and the PR stays ready. */
  async mergeReadyPr(
    workspaceId: string,
    runId: string,
    method: "merge" | "squash" | "rebase" = "squash",
  ): Promise<{ merged: boolean; reason?: string; blocked?: "conflict" | "checks" | "protection" }> {
    const run = await this.store.getRun(runId);
    if (!run || run.workspaceId !== workspaceId || run.pr?.state !== "open") throw new Error("No open PR for this run.");
    const res = await githubService.mergePr(workspaceId, run.pr.repo, run.pr.number, method);
    if (!res.merged) {
      const blocked = await this.classifyMergeBlock(workspaceId, run, res.reason);
      await this.hub.runLog(runId, `merge blocked (${blocked.blocked}): ${blocked.reason}`);
      return { merged: false, ...blocked };
    }
    const fresh = await this.store.getRun(runId);
    if (fresh?.pr) await this.hub.upsertRun({ ...fresh, pr: { ...fresh.pr, state: "merged" } });
    await this.hub.runLog(runId, `PR #${run.pr.number} merged (${method}).`);
    await this.completeMerged(runId, run.branch); // integrate + retire; task/run → done
    return res;
  }

  /** Explain WHY a merge was blocked — a conflict (base moved under the PR), a
   *  failing/pending check, or a policy block (branch protection / required
   *  reviews) — by reading the PR's mergeability + checks. Best-effort: if the
   *  status read fails, fall back to GitHub's own message as a policy block. */
  private async classifyMergeBlock(
    workspaceId: string,
    run: TaskRun,
    ghMessage?: string,
  ): Promise<{ reason: string; blocked: "conflict" | "checks" | "protection" }> {
    const cred = (await this.store.getProject(run.projectId))?.githubCredentialId ?? null;
    const status = await githubService.prStatus(workspaceId, run.pr!.repo, run.pr!.number, cred).catch(() => null);
    if (status?.mergeable === false) {
      return { blocked: "conflict", reason: `conflicts with ${run.pr!.base} — the base moved under this PR. Update branch to re-sync, or Rework so the agent resolves it.` };
    }
    if (status?.checks === "failing") return { blocked: "checks", reason: "required checks are failing on this PR." };
    if (status?.checks === "pending") return { blocked: "checks", reason: "required checks are still running — try again once they finish." };
    return { blocked: "protection", reason: ghMessage ?? "blocked by branch protection (required reviews/approvals)." };
  }

  /** "Update branch": fold the latest base into a ready PR's branch and re-push,
   *  so a merge blocked only by a stale base becomes mergeable again WITHOUT
   *  spinning the agent. A real textual conflict can't be auto-resolved — it
   *  returns the conflicting files so the operator can Rework (agent resolves).
   *  Works even after a restart (the worktree persists; git context is rebuilt). */
  async updateReadyPrBranch(workspaceId: string, runId: string): Promise<{ updated: boolean; conflicts?: string[] }> {
    const run = await this.store.getRun(runId);
    if (!run || run.workspaceId !== workspaceId || run.pr?.state !== "open") throw new Error("No open PR for this run.");
    const project = await this.store.getProject(run.projectId);
    const git = this.gitContextFor(project);
    if (!git) throw new Error("This project has no git backend to update the branch from.");
    const base = this.baseBranchFor(project);
    let sync: { ok: boolean; conflicts?: string[]; depsChanged?: boolean };
    try {
      sync = await git.worktrees.mergeBase(run.id);
    } catch (err) {
      await this.hub.runLog(runId, `couldn't update the branch — ${(err as Error).message}. Use Rework instead.`);
      return { updated: false, conflicts: [] };
    }
    if (!sync.ok) {
      const files = sync.conflicts?.length ? `: ${sync.conflicts.join(", ")}` : "";
      await this.hub.runLog(runId, `can't auto-update ${run.pr.branch} — real conflict with ${base}${files}. Use Rework so the agent resolves it.`);
      return { updated: false, conflicts: sync.conflicts ?? [] };
    }
    await this.openPrForRun(git, run, run.pr.repo, project, base, sync); // re-push + refresh the ready record
    await this.hub.runLog(runId, `updated ${run.pr.branch} to the latest ${base} — re-check the merge.`);
    return { updated: true };
  }

  /** Send a ready PR back for changes: optionally comment on the PR, then resume
   *  the agent to revise (new commits push to the same branch; it returns to the
   *  ready list when it re-finishes and is re-reviewed). Clears the ready record
   *  while it's being reworked. */
  async reworkReadyPr(workspaceId: string, runId: string, guidance: string, comment?: string): Promise<void> {
    const run = await this.store.getRun(runId);
    if (!run || run.workspaceId !== workspaceId || run.pr?.state !== "open") throw new Error("No open PR for this run.");
    if (comment?.trim()) {
      const cred = (await this.store.getProject(run.projectId))?.githubCredentialId ?? null;
      await githubService
        .commentIssue(workspaceId, run.pr.repo, run.pr.number, comment.trim(), cred)
        .catch((e) => this.hub.runLog(runId, `couldn't comment on PR: ${(e as Error).message}`));
    }
    await this.hub.upsertRun({ ...run, pr: null }); // leaves the ready list while revising
    await this.hub.runLog(runId, `rework requested on PR #${run.pr.number} — resuming the agent to revise.`);
    await this.reviseAfterReview(runId, guidance);
  }

  /** No-op: set a ready PR aside — hide it from the list WITHOUT touching the PR
   *  on GitHub (recoverable). */
  async dismissReadyPr(workspaceId: string, runId: string): Promise<void> {
    const run = await this.store.getRun(runId);
    if (!run || run.workspaceId !== workspaceId || !run.pr) throw new Error("No PR for this run.");
    await this.hub.upsertRun({ ...run, pr: { ...run.pr, dismissed: true } });
    await this.hub.runLog(runId, `PR #${run.pr.number} set aside (no-op) — still open on GitHub.`);
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
      diff: { add: 0, del: 0, modules: agent.modules, files: [], walkthrough: null },
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
      diff: { add: 0, del: 0, modules: agent.modules, files: [], walkthrough: null },
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
    const logText = agent.log.slice(-40).map((l) => l.line).join("\n").slice(-4000);
    // A run that didn't finish cleanly (failed / escalated / needs-attention) is
    // RESUMABLE from its own controls — so the consult must not dead-end the
    // operator by telling them to relaunch or spin up a fresh agent themselves.
    const note =
      agent.status === "done"
        ? ""
        : "SITUATION: This run did not finish — it is paused / needs attention and can be RESUMED to keep working, from the run's own controls (its escalation card: Help & resume · Reassign · Stop). You are read-only in this chat: explain what happened or advise on the work, but never tell the operator to relaunch, retry, or start a fresh agent themselves, and don't imply you can edit files or resume from here.\n\n";
    const context = note + logText;
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

  /**
   * Keep the fleet on latest main: fetch each active project's base from origin
   * (so a new run branches off fresh main), and flag any in-flight run whose
   * branch has fallen behind — a one-time nudge; the actual sync happens when its
   * PR opens (mergeBase in pushToGithub). Cheap + safe to run periodically and at
   * startup: fetch only updates remote-tracking refs, never a checked-out branch.
   */
  async syncBaseAndFlagStale(): Promise<void> {
    const runs = (await this.store.listAllRuns().catch(() => [] as TaskRun[])).filter(
      (r) => r.status !== "done" && !r.archived && r.branch,
    );
    const byProject = new Map<string, { git: GitContext | undefined; base: string }>();
    const fetched = new Set<GitContext>();
    for (const r of runs) {
      let entry = byProject.get(r.projectId);
      if (!entry) {
        const project = await this.store.getProject(r.projectId).catch(() => null);
        entry = { git: this.gitContextFor(project), base: this.baseBranchFor(project) };
        byProject.set(r.projectId, entry);
      }
      const git = entry.git;
      if (!git) continue;
      if (!fetched.has(git)) {
        await git.worktrees.fetchBase().catch(() => undefined);
        fetched.add(git);
      }
      const behind = await git.worktrees.baseAheadOf(`refs/heads/${r.branch}`).catch(() => false);
      if (behind && !this.baseMovedFlagged.has(r.id)) {
        this.baseMovedFlagged.add(r.id);
        await this.hub
          .runLog(r.id, `${entry.base} has moved since this run started — it'll be synced into the branch before its PR opens.`)
          .catch(() => undefined);
      } else if (!behind) {
        this.baseMovedFlagged.delete(r.id); // caught up (e.g. after a resync) → re-arm
      }
    }
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
      if (this.escalations.has(a.id)) continue; // already an open escalation card — don't re-raise or clobber it
      const silentSec = Math.round((now() - a.lastHeartbeatAt) / 1000);
      const reason = `reaped — no heartbeat for ${silentSec}s; runner freed`;
      // A `running` agent that went silent is presumed dead (crashed runner or a
      // server restart that orphaned it). Rather than a dead-end `done` (which
      // retires the worktree and drops any uncommitted work with no way back),
      // route it into the SAME escalation → Resume path as an out-of-turns run:
      // free the runner but KEEP the worktree, and surface a resumable card so
      // one click relaunches a fresh session on its branch.
      if (a.status === "running") {
        await this.escalate(a.id, reason, "stalled").catch(() => undefined);
        continue;
      }
      // A `waiting` run with a frozen heartbeat that ISN'T an escalation was
      // parked on a gate whose session died — free its runner + mark it terminal.
      await this.stopAgent(a.id, reason).catch(() => undefined);
      await this.hub.runStatus(a.id, "done").catch(() => undefined);
      await this.hub.runCompleted(a.id, a.branch).catch(() => undefined);
    }
  }

  /**
   * Auto-decommission: retire SYSTEM-provisioned runners (auto-scale / fork
   * created) that have sat idle past the workspace's TTL, so auto-scaled capacity
   * doesn't accumulate. Only touches `autoProvisioned` idle runners — an operator's
   * manually-added fleet is never auto-retired, and a busy runner is never touched.
   * Per-workspace TTL (retireIdleRunnersAfterMinutes; 0 = off). Returns the count
   * retired. Runs as a janitorial sweep, independent of the pause/kill switch.
   */
  async reapIdleRunners(): Promise<number> {
    const allAgents = await this.store.listAllAgents().catch(() => [] as Agent[]);
    const workspaces = [...new Set(allAgents.map((a) => a.workspaceId))];
    let retired = 0;
    for (const ws of workspaces) {
      const ttlMin = (await this.fleetPolicy(ws)).retireIdleRunnersAfterMinutes;
      if (!ttlMin || ttlMin <= 0) continue; // reaping disabled for this workspace
      const cutoff = now() - ttlMin * 60_000;
      for (const a of allAgents) {
        if (a.workspaceId !== ws || !a.autoProvisioned) continue; // operator runners are off-limits
        if (a.status !== "idle" || a.idleSince == null || a.idleSince > cutoff) continue; // busy or still fresh
        if (this.isBusy(a.id)) continue; // a live run is mid-flight despite the status
        await this.hub.deleteAgent(a.id).catch(() => undefined);
        retired++;
      }
    }
    return retired;
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
        // Iterate ALL projects — the TRIAGE step runs regardless of the project's
        // `autonomy` toggle (it's just a fleet read, no work executed). The
        // action steps (auto-pick, auto-review) still respect `autonomy` because
        // those spend real time/tokens.
        const projects = await this.store.listProjects(ws);
        if (projects.length === 0) continue;
        const tasks = await this.store.listTasks(ws);
        for (const p of projects) {
          // Re-read idle capacity per project (an earlier project may have used it).
          const idle = (await this.store.listAgents(ws)).filter((a) => a.status === "idle");
          if (idle.length === 0) break; // no capacity left in this workspace
          // Archived tasks are a soft-hide: off the board and out of the
          // assistant's grounding context — autonomy must ignore them too, or it
          // re-triages / auto-picks / auto-reviews a task the operator hid,
          // spawning a run that then shows the archived task "running".
          const mine = tasks.filter((t) => t.projectId === p.id && !t.archived);
          try {
            // 1) Triage one backlog item → assessment + duration + clarity.
            //    ALWAYS runs (no p.autonomy gate) — it's informative, not
            //    action. Skip `unassigned` tasks: an eligibility choice is still
            //    the operator's, and autonomy never guesses one.
            //    If the LLM self-reports clarity=clear, auto-promote triage→todo
            //    in the SAME write — that's the "reduce human dependence" step.
            //    Unclear (or missing signal) parks in triage for a human read.
            const backlog = mine.find(
              (t) => t.state === "backlog" && (t.assignment?.mode ?? "unassigned") !== "unassigned",
            );
            if (backlog) {
              const { assessment, assessmentEffort, assessmentRisks, estimatedDurationMs, clarity, featureId, milestoneId } =
                await this.assessTask(ws, idle[0]!, backlog);
              // Only OVERWRITE an existing estimate when triage produced a new
              // one — leaves an operator-set estimate intact if triage failed
              // to guess (or on retriage of a task that already had one).
              const nextEst = estimatedDurationMs != null
                ? estimatedDurationMs
                : backlog.estimatedDurationMs;
              // File under a suitable feature/milestone — but only when the task
              // isn't ALREADY grouped, so triage never clobbers an operator's
              // choice. A feature carries its milestone (assessTask nulls a direct
              // milestone when a feature was picked).
              const nextFeatureId = backlog.featureId ?? featureId;
              const nextMilestoneId = backlog.featureId || backlog.milestoneId ? backlog.milestoneId : milestoneId;
              // Auto-promote to todo when the LLM said "clear" — the eligibility
              // check above already guarantees the task can leave backlog.
              const nextState: Task["state"] = clarity === "clear" ? "todo" : "triage";
              await this.hub.upsertTask({
                ...backlog,
                state: nextState,
                assessment,
                assessmentEffort,
                assessmentRisks,
                estimatedDurationMs: nextEst,
                featureId: nextFeatureId,
                milestoneId: nextMilestoneId,
              });
            }
            // 2) Start auto-pick todo tasks (todo → ongoing) while capacity lasts.
            //    Gated by `p.autonomy` — this is where money/time actually gets
            //    spent, so it stays under the project autonomy toggle. Also
            //    honors each task's eligibility set via assignTask → acquireAgent.
            //    Fired concurrently, not awaited one at a time: acquireAgent's
            //    find-idle→mark-busy step is already serialized by acquireExclusive
            //    (orchestrator.ts:752), so racing N eligible tasks here is safe —
            //    it just lets their (slower) provider-session starts overlap
            //    instead of queuing behind each other. allSettled isolates each
            //    task's failure (busy fleet, no credential) from the rest, same
            //    as the try/catch/continue this replaces. Sorted by `order` (the
            //    same rank field the ↑/↓ column control writes) before firing so
            //    that when capacity is short, the acquireExclusive queue — which
            //    serializes in call order — grants idle agents to the
            //    highest-priority tasks first instead of array/insertion order.
            if (p.autonomy) {
              const pickable = mine
                .filter((t) => t.state === "todo" && t.autoPick && (t.assignment?.mode ?? "unassigned") !== "unassigned")
                .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
              await Promise.allSettled(pickable.map((t) => this.assignTask(p.id, t.id)));
            }
            // 3) Review a finished run — runs REGARDLESS of `p.autonomy`.
            //    Recording a verdict is diagnostic (an LLM consult), not a
            //    spending action, so every review-state task deserves a
            //    reviewer's opinion for the human's audit trail. The
            //    APPROVE-and-merge step inside autoReview stays gated on
            //    `p.autonomy` — verdict recorded either way; auto-resolve
            //    only when the project has opted in to autonomous spending.
            //    Skip tasks that already carry a verdict (idempotent) so we
            //    don't rewrite the same LLM call every tick.
            const review = mine.find((t) => t.state === "review" && t.runId && !t.reviewVerdict);
            if (review?.runId) {
              // The reviewer must NOT be the agent that did the work — a run
              // reviewing itself is a rubber-stamp that opens a PR without a real
              // second look. Pick the first idle agent that (a) isn't the run's
              // own agent and (b) is reviewer-eligible (Agent.canReview, default
              // true). If none is free, leave it for a human this tick rather than
              // self-approve — a later tick retries when another agent frees up.
              const doerId = (await this.store.getRun(review.runId))?.agentId;
              const reviewer = idle.find((a) => a.id !== doerId && a.canReview !== false);
              if (reviewer) {
                const open = (await this.store.listQueue(ws)).find(
                  (h) => h.runId === review.runId && !h.resolvedAt,
                );
                if (open) await this.autoReview(ws, reviewer, review, open, p.autonomy);
              }
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
   * A short agent-written assessment for autonomous triage — plus a duration
   * estimate, a clarity self-report, and the structured triage card
   * (effort size + a short risks list), all parsed from a trailing JSON tag
   * on the model's reply the same defensive, field-based way as the
   * auto-review verdict (never regex/keyword-classify free text — see
   * `splitEstMinutesTag`). We convert minutes to ms (cap 24h) and use
   * clarity to gate auto-promote (triage→todo). A missing signal stays
   * missing — never fabricated. `assessment` doubles as the card's summary
   * line; `assessmentEffort`/`assessmentRisks` are additive siblings, so a
   * task assessed before this shipped (or by the no-consult/error fallback
   * below) just renders its `assessment` alone. Falls back to a
   * deterministic note when the provider has no stateless consult (e.g. mock).
   */
  private async assessTask(
    ws: string,
    agent: Agent,
    task: Task,
  ): Promise<{
    assessment: string;
    assessmentEffort: "small" | "medium" | "large" | null;
    assessmentRisks: string[];
    estimatedDurationMs: number | null;
    clarity: "clear" | "unclear" | null;
    featureId: string | null;
    milestoneId: string | null;
  }> {
    try {
      const provider = await this.getProvider(agent.provider);
      if (!provider.consult) {
        return {
          assessment: `Auto-triaged — "${task.text}" looks actionable; no blockers noted.`,
          assessmentEffort: null,
          assessmentRisks: [],
          estimatedDurationMs: null,
          clarity: null,
          featureId: null,
          milestoneId: null,
        };
      }
      const apiKey = await secretService.resolve(ws, agent.credentialId ?? agent.provider);
      const project = await this.store.getProject(task.projectId);
      // Offer the project's OPEN features + milestones so triage can file the task
      // under a suitable one. The model must pick an id FROM these lists (or null);
      // we validate its pick against them below — never trust a fabricated id.
      const features = (await this.store.listFeatures(ws).catch(() => [] as Feature[]))
        .filter((f) => f.projectId === task.projectId && !f.archived && f.status !== "shipped");
      const milestones = (await this.store.listMilestones(ws).catch(() => [] as Milestone[]))
        .filter((m) => m.projectId === task.projectId && !m.archived && m.status !== "shipped");
      const groupingInstr =
        features.length || milestones.length
          ? [
              "",
              "GROUPING: file this task under a suitable EXISTING feature and/or milestone if one clearly fits.",
              features.length ? `Features (id — name): ${features.map((f) => `${f.id} — ${f.name}`).join("; ")}` : "Features: (none)",
              milestones.length ? `Milestones (id — name): ${milestones.map((m) => `${m.id} — ${m.name}`).join("; ")}` : "Milestones: (none)",
              'Add "featureId" and/or "milestoneId" to the JSON tag with an id COPIED EXACTLY from the lists above — or null if none clearly fits. Prefer a feature (its milestone is inherited); set milestoneId directly only when no feature fits. Do NOT invent ids; when unsure, use null.',
            ].join("\n")
          : "";
      // The estimate is for AGENT wall-clock time, not human developer time —
      // these differ by an order of magnitude on typical coding tasks (an
      // autonomous agent's 20-minute feature is a person's afternoon). Without
      // this anchor the LLM defaults to its stronger "human developer time"
      // prior and returns estimates 10–30× too high, so we spell it out AND
      // give concrete agent-wall-clock anchors for S/M/L.
      const taskBody = task.description ? `${task.text}\n\n${task.description}` : task.text;
      const reply = await provider.consult(
        { task: withInstructions(project?.instructions, taskBody), model: agent.model, cwd: config.runnerCwd, apiKey },
        [
          "You are triaging a backlog item for a coding project.",
          "In ONE short line: summarize the ask (is it clear, what's the gist). Be terse — the effort size and any risks go in the JSON tag below, not this line.",
          "END your reply with a JSON tag on its OWN line:",
          '  {"estMinutes": <int>, "clarity": "clear"|"unclear", "effort": "small"|"medium"|"large", "risks": ["<short risk>", ...]}',
          "estMinutes = the AGENT'S wall-clock time to complete this task — NOT a human developer's time.",
          "An autonomous coding agent works fast: a task that would take a person hours typically takes an agent minutes.",
          "Anchors (agent wall-clock): small ≈ 5m (rename, config tweak, single small edit), medium ≈ 20m (a real feature — new endpoint, migration, small refactor), large ≈ 60m (multi-file change, cross-module work). Cap at 240m even for very large asks. `effort` should agree with `estMinutes`.",
          "clarity = \"clear\" ONLY if the ask is well-scoped and actionable AS WRITTEN (an agent could start without more info).",
          '"unclear" if it needs clarification, is missing acceptance criteria, or the scope is ambiguous. When in doubt, choose "unclear".',
          '"risks" = 0-3 short, CONCRETE risks specific to this task (e.g. "touches auth — check session handling", "no tests in this area yet") — omit the field entirely (not an empty array) if you see none worth flagging; never pad with generic filler like "could have bugs".',
          "Omit any field you can't confidently supply; a missing signal is honest, a fabricated one is not." + groupingInstr,
        ].join("\n"),
      );
      const raw = reply.trim();
      const parsed = splitEstMinutesTag(raw);
      const estimatedDurationMs =
        parsed.estMinutes != null && parsed.estMinutes > 0
          ? Math.min(parsed.estMinutes * 60_000, 24 * 60 * 60_000) // cap at 24h
          : null;
      const assessment = (parsed.body || raw).slice(0, 500) || `Auto-triaged — "${task.text}".`;
      // Validate the model's grouping picks against the offered ids — never write a
      // fabricated id. A feature carries its milestone, so take a direct milestone
      // ONLY when no feature was chosen (avoids a conflicting double-assignment).
      const featureId = parsed.featureId && features.some((f) => f.id === parsed.featureId) ? parsed.featureId : null;
      const milestoneId =
        !featureId && parsed.milestoneId && milestones.some((m) => m.id === parsed.milestoneId) ? parsed.milestoneId : null;
      return {
        assessment,
        assessmentEffort: parsed.effort,
        assessmentRisks: parsed.risks ?? [],
        estimatedDurationMs,
        clarity: parsed.clarity,
        featureId,
        milestoneId,
      };
    } catch (err) {
      return {
        assessment: `Auto-triaged — "${task.text}" (assessment unavailable: ${(err as Error).message}).`,
        assessmentEffort: null,
        assessmentRisks: [],
        estimatedDurationMs: null,
        clarity: null,
        featureId: null,
        milestoneId: null,
      };
    }
  }

  /**
   * Autonomous review of a finished run's open HITL. Always records a verdict
   * on the task (approve OR flag) so the human has an audit trail of what the
   * reviewer thought. Only when `canResolve` is true does an approve verdict
   * also drive the HITL → merge/done path; with autonomy off, the verdict is
   * recorded and the human retains the merge decision.
   */
  private async autoReview(
    ws: string,
    agent: Agent,
    task: Task,
    hitl: HitlItem,
    canResolve: boolean,
  ): Promise<void> {
    const run = task.runId ? await this.store.getRun(task.runId) : undefined;
    let decision: "approve" | "flag" = "approve";
    let reason = "auto-approved";
    try {
      const provider = await this.getProvider(agent.provider);
      if (provider.consult && run) {
        const apiKey = await secretService.resolve(ws, agent.credentialId ?? agent.provider);
        const context = run.log.slice(-30).map((l) => l.line).join("\n").slice(-3000);
        const project = await this.store.getProject(task.projectId);
        const reply = await provider.consult(
          { task: withInstructions(project?.instructions, task.text), model: agent.model, cwd: config.runnerCwd, apiKey, context },
          `Review whether this run satisfies the task "${task.text}". ${REVIEW_OUTPUT_INSTRUCTION}`,
        );
        // The verdict is the MODEL's, read from a structured field — we never
        // classify its prose (a reason mentioning "flagged" once false-flagged an
        // APPROVE). An unreadable verdict flags for a human, never auto-approves.
        const verdict = parseReviewVerdict(reply);
        decision = verdict.approve ? "approve" : "flag";
        reason = verdict.reason;
      }
    } catch (err) {
      decision = "flag";
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
    // If a verdict raced in ahead of us (parallel tick, unlikely but safe),
    // don't clobber it with another consult's answer.
    if (freshTask.reviewVerdict) return;
    const reviewer = agent.name || agent.id;
    const at = now();
    // Record the auto-review on the run's live log — a short verdict line that
    // folds open to the reviewer's full reasoning. Mirrors how a human's
    // decision is auditable; here the reviewer is a fleet agent, not a person.
    if (task.runId) {
      const suffix = decision === "approve"
        ? canResolve ? "approved (integrating)" : "approved (awaiting human)"
        : "flagged for a human";
      await this.hub.runLog(task.runId, `⟳ auto-reviewed by ${reviewer} — ${suffix}`, reason);
    }
    // ALWAYS persist the verdict on the task so the detail view can show it —
    // approve OR flag, autonomy on OR off. This is the audit trail.
    const verdict = { decision, reason, by: reviewer, at };
    const withVerdict = await this.hub.upsertTask({ ...freshTask, reviewVerdict: verdict });
    if (decision === "approve" && canResolve) {
      const resolution: Resolution = { action: "approve", optionIndex: null, guidance: null, memoryNote: null, by: "autonomy", at };
      const resolved = await this.hub.resolveHitl(hitl.id, resolution);
      if (resolved && resolved.resolution?.at === resolution.at) await this.deliver(hitl, resolution);
      // Once an agent has approved a review-state task, move it to `done` and
      // sync the run's status — regardless of the downstream integration path.
      // The local merge queue's completeMerged() ALSO writes this on merge
      // (idempotent no-op), but for the GitHub-PR path pushToGithub deliberately
      // leaves the run in `review` waiting for a human to merge the PR — that
      // would strand the KANBAN task in `review` too. Advancing the card here
      // reflects Skynet's view: the AGENT signed off; the PR is the follow-
      // through on GitHub, not a Skynet blocker. Re-fetch to avoid a stale-
      // snapshot clobber, and only advance if the task is still ours to move.
      const afterDeliver = await this.store.getTask(task.id);
      if (afterDeliver && afterDeliver.state === "review" && afterDeliver.runId === task.runId) {
        await this.hub.upsertTask({ ...afterDeliver, state: "done" });
        if (afterDeliver.runId) await this.hub.runStatus(afterDeliver.runId, "done").catch(() => undefined);
      }
    }
    // decision === "flag" OR (approve without autonomy) → verdict is recorded
    // (`withVerdict`), HITL stays open for the human. Nothing else to do here.
    void withVerdict;
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
      await this.hub.upsertTask({ ...task, state: "todo", runId: null, reviewVerdict: null });
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
