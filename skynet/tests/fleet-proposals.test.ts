// Self-replenishing backlog — scope taxonomy is the valve (ROADMAP v1 "Self-
// replenishing backlog, scope-taxonomied"). Covers three layers:
//   1. review-verdict.ts's parseReviewProposals — pure, field-based parsing.
//   2. orchestrator.ts's resolveProposalPlacement / normalizeProposalTitle /
//      countFleetProposalsToday — pure placement decisions, no I/O.
//   3. End-to-end through autoReview (via tickAutonomy), same reviewRound
//      harness tests/autonomy-circuit-breaker.test.ts already established.
import { describe, it, expect } from "vitest";
import type { Agent, Feature, HitlItem, Project, ProviderId, ServerEvent, Task, TaskRun } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import {
  Orchestrator,
  resolveProposalPlacement,
  normalizeProposalTitle,
  countFleetProposalsToday,
} from "../apps/server/src/orchestrator.js";
import { parseReviewProposals, MAX_PROPOSALS_PER_REVIEW } from "../apps/server/src/review-verdict.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import { config } from "../apps/server/src/config.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

class NullBus implements Bus {
  publish(_ws: string, _e: ServerEvent): void {}
  subscribe(): () => void { return () => {}; }
}

class ReplyProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  reply = "ok";
  async start(spec: StartSpec, _events: RunnerEvents): Promise<RunnerHandle> {
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
  async consult(): Promise<string> { return this.reply; }
}

const mkProject = (over: Partial<Project> = {}): Project => ({
  id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [],
  status: "active", autonomy: true, repoPath: null, gitBacked: false, ...over,
});
const mkAgent = (over: Partial<Agent>): Agent => ({
  id: "a1", workspaceId: DEFAULT_WORKSPACE, name: "a1", provider: "claude",
  model: "opus-4.8", status: "idle", idleSince: 0, ...over,
});
const mkTask = (over: Partial<Task>): Task => ({
  id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "do X", state: "backlog",
  runId: null, autoPick: false, assessment: null, reviewVerdict: null, lint: null,
  assignment: { mode: "any", agentIds: [] }, ...over,
});
const mkRun = (over: Partial<TaskRun>): TaskRun => ({
  id: "r1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", name: "do X", status: "review",
  agentId: "a1", provider: "claude", model: "opus-4.8", branch: "agent/r1", modules: [], progress: 1,
  plan: [], modifiedFiles: [], log: [], startedAt: 0, lastHeartbeatAt: 0, visual: false,
  previewUrl: null, dependsOn: [], parentId: null, branchFromStep: null, archived: false, ...over,
});
const mkHitl = (over: Partial<HitlItem>): HitlItem => ({
  id: "q1", workspaceId: DEFAULT_WORKSPACE, runId: "r1", kind: "diff", title: "Review",
  why: "", risk: "medium", raisedAt: 0, expiresAt: null, resolvedAt: null, resolution: null,
  command: null, options: null, recommended: null, steps: null, diff: null, ...over,
});
const mkFeature = (over: Partial<Feature> = {}): Feature => ({
  id: "f1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", name: "Rate limiting",
  description: null, status: "active", milestoneId: null, archived: false, createdAt: 1, pr: null, ...over,
});

const setup = async (projectOver: Partial<Project> = {}) => {
  const store = new MemoryStore();
  const hub = new Hub(store, new NullBus());
  const provider = new ReplyProvider();
  const orch = new Orchestrator(store, hub, provider);
  await store.putProject(mkProject(projectOver));
  await store.putAgent(mkAgent({ id: "a1" }));
  await store.putAgent(mkAgent({ id: "a2", canReview: true })); // reviews a1's runs
  return { store, orch, provider };
};

/** One review-state run + open diff HITL + task, driven through a single
 *  tickAutonomy() with the reviewer replying `reply` — same harness as
 *  autonomy-circuit-breaker.test.ts's reviewRound. */
async function reviewRound(
  store: MemoryStore,
  orch: Orchestrator,
  provider: ReplyProvider,
  taskOver: Partial<Task>,
  reply: string,
) {
  const id = taskOver.id ?? "t1";
  const runId = `r-${id}`;
  await store.putRun(mkRun({ id: runId, agentId: "a1" }));
  await store.putHitl(mkHitl({ id: `q-${id}`, runId }));
  await store.putTask(mkTask({ ...taskOver, id, runId, state: "review" }));
  provider.reply = reply;
  await orch.tickAutonomy();
}

const fleetTasks = async (store: MemoryStore, projectId: string) =>
  (await store.listTasks(DEFAULT_WORKSPACE)).filter((t) => t.projectId === projectId && t.source?.kind === "fleet");

describe("parseReviewProposals — field-based, prose ignored", () => {
  it("reads a well-formed proposals array", () => {
    const reply = '{"verdict":"approve","reason":"ok","proposals":[{"title":"Fix the thing","why":"noticed a bug","scope":"in-scope"}]}';
    expect(parseReviewProposals(reply)).toEqual([{ title: "Fix the thing", why: "noticed a bug", scope: "in-scope" }]);
  });

  it("prose mentioning proposal-shaped words is never parsed as a proposal", () => {
    const reply = '{"verdict":"approve","reason":"I considered proposing a new-scope task called Fix the thing but decided not to."}';
    expect(parseReviewProposals(reply)).toEqual([]);
  });

  it("caps at MAX_PROPOSALS_PER_REVIEW, silently dropping overflow", () => {
    const many = Array.from({ length: MAX_PROPOSALS_PER_REVIEW + 5 }, (_, i) => ({ title: `T${i}`, why: "w", scope: "new-scope" }));
    const reply = JSON.stringify({ verdict: "approve", reason: "ok", proposals: many });
    expect(parseReviewProposals(reply)).toHaveLength(MAX_PROPOSALS_PER_REVIEW);
  });

  it("drops a malformed entry (missing title / bad scope) but keeps the valid ones", () => {
    const reply = JSON.stringify({
      verdict: "approve",
      reason: "ok",
      proposals: [
        { title: "", why: "no title", scope: "in-scope" },
        { why: "no title field at all", scope: "in-scope" },
        { title: "Bad scope", why: "w", scope: "urgent" },
        { title: "Good one", why: "w", scope: "new-scope" },
      ],
    });
    expect(parseReviewProposals(reply)).toEqual([{ title: "Good one", why: "w", scope: "new-scope" }]);
  });

  it("no proposals field at all is simply no proposals, never an error", () => {
    expect(parseReviewProposals('{"verdict":"flag","reason":"needs work"}')).toEqual([]);
    expect(parseReviewProposals("not even json")).toEqual([]);
  });
});

describe("resolveProposalPlacement — the scope-taxonomy valve, pure", () => {
  const baseCtx = {
    openTaskTitles: new Set<string>(),
    featureStatus: "active" as const,
    siblingCountInFeature: 2,
    featureBatchMaxTasks: 12,
    underBudget: true,
  };

  it("new-scope always parks, even when every other gate would pass", () => {
    expect(resolveProposalPlacement({ title: "Add dark mode", scope: "new-scope" }, baseCtx)).toEqual({
      action: "create-parked",
      degradedReason: null,
    });
  });

  it("in-scope lands active when every gate passes", () => {
    expect(resolveProposalPlacement({ title: "Fix off-by-one", scope: "in-scope" }, baseCtx)).toEqual({ action: "create-active" });
  });

  it("in-scope with no feature to place it under degrades to parked", () => {
    const r = resolveProposalPlacement({ title: "Fix it", scope: "in-scope" }, { ...baseCtx, featureStatus: null });
    expect(r).toEqual({ action: "create-parked", degradedReason: "no feature to place it under" });
  });

  it("in-scope under a shipped/paused feature degrades to parked", () => {
    const shipped = resolveProposalPlacement({ title: "Fix it", scope: "in-scope" }, { ...baseCtx, featureStatus: "shipped" });
    expect(shipped).toEqual({ action: "create-parked", degradedReason: "feature is shipped, not active" });
    const paused = resolveProposalPlacement({ title: "Fix it", scope: "in-scope" }, { ...baseCtx, featureStatus: "paused" });
    expect(paused).toEqual({ action: "create-parked", degradedReason: "feature is paused, not active" });
  });

  it("in-scope over the feature-batch size guardrail degrades to parked", () => {
    const r = resolveProposalPlacement({ title: "Fix it", scope: "in-scope" }, { ...baseCtx, siblingCountInFeature: 12, featureBatchMaxTasks: 12 });
    expect(r).toEqual({ action: "create-parked", degradedReason: "feature already at the 12-task batch guardrail" });
  });

  it("in-scope over the daily budget degrades to parked", () => {
    const r = resolveProposalPlacement({ title: "Fix it", scope: "in-scope" }, { ...baseCtx, underBudget: false });
    expect(r).toEqual({ action: "create-parked", degradedReason: "project is over its daily budget" });
  });

  it("a title matching an existing open task (normalized) is a duplicate, regardless of scope", () => {
    const ctx = { ...baseCtx, openTaskTitles: new Set(["fix off-by-one"]) };
    expect(resolveProposalPlacement({ title: "  Fix Off-By-One  ", scope: "in-scope" }, ctx)).toEqual({ action: "skip-duplicate" });
    expect(resolveProposalPlacement({ title: "Fix off-by-one", scope: "new-scope" }, ctx)).toEqual({ action: "skip-duplicate" });
  });
});

describe("normalizeProposalTitle", () => {
  it("trims, lowercases, and collapses internal whitespace", () => {
    expect(normalizeProposalTitle("  Fix   the   Thing  ")).toBe("fix the thing");
  });
});

describe("countFleetProposalsToday", () => {
  const DAY = 24 * 60 * 60 * 1000;
  it("counts only fleet-sourced tasks created within the local day containing `at`", () => {
    const at = new Date(2026, 0, 15, 12, 0, 0).getTime();
    const tasks: Task[] = [
      mkTask({ id: "a", source: { kind: "fleet", byRun: "r1", reason: "", proposedAt: at } }),
      mkTask({ id: "b", source: { kind: "fleet", byRun: "r1", reason: "", proposedAt: at - DAY } }), // yesterday
      mkTask({ id: "c", source: { kind: "github_issue", repo: "x/y", number: 1, url: "" } }), // not fleet
      mkTask({ id: "d", source: null }),
    ];
    expect(countFleetProposalsToday(tasks, at)).toBe(1);
  });
});

describe("self-replenishing backlog — end to end via autoReview", () => {
  it("new-scope proposal is parked (backlog, unassigned) and never auto-picked", async () => {
    const { store, orch, provider } = await setup();
    await store.putFeature(mkFeature());
    await reviewRound(
      store, orch, provider, { id: "t1", featureId: "f1" },
      '{"verdict":"approve","reason":"ok","proposals":[{"title":"Add a dark mode toggle","why":"an idea, unrelated to this change","scope":"new-scope"}]}',
    );
    const created = await fleetTasks(store, "p1");
    expect(created).toHaveLength(1);
    expect(created[0]!.state).toBe("backlog");
    expect(created[0]!.autoPick).toBe(false);
    expect(created[0]!.assignment).toEqual({ mode: "unassigned", agentIds: [] });
    expect(created[0]!.featureId).toBeNull();
    expect(created[0]!.source).toMatchObject({ kind: "fleet", reason: "an idea, unrelated to this change" });
  });

  it("in-scope proposal lands in the source task's feature, todo, auto-pickable — no extra human step", async () => {
    const { store, orch, provider } = await setup();
    await store.putFeature(mkFeature());
    await reviewRound(
      store, orch, provider, { id: "t1", featureId: "f1" },
      '{"verdict":"approve","reason":"ok","proposals":[{"title":"Fix off-by-one in the paginator","why":"found while reviewing the diff","scope":"in-scope"}]}',
    );
    const created = await fleetTasks(store, "p1");
    expect(created).toHaveLength(1);
    expect(created[0]!.state).toBe("todo");
    expect(created[0]!.featureId).toBe("f1");
    expect(created[0]!.autoPick).toBe(true);
    expect(created[0]!.assignment).toEqual({ mode: "any", agentIds: [] });
  });

  it("in-scope degrades to a parked proposal when the source task has no feature", async () => {
    const { store, orch, provider } = await setup();
    // t1 has no featureId this time — nothing for "in-scope" to mean.
    await reviewRound(
      store, orch, provider, { id: "t1" },
      '{"verdict":"approve","reason":"ok","proposals":[{"title":"Fix it","why":"w","scope":"in-scope"}]}',
    );
    const created = await fleetTasks(store, "p1");
    expect(created).toHaveLength(1);
    expect(created[0]!.state).toBe("backlog");
    expect(created[0]!.autoPick).toBe(false);
  });

  it("in-scope degrades to parked when the feature is already at the batch-size guardrail", async () => {
    const { store, orch, provider } = await setup();
    await store.putFeature(mkFeature());
    // Fill the feature to exactly the guardrail so one more would trip it.
    for (let i = 0; i < config.featureBatchMaxTasks; i++) {
      await store.putTask(mkTask({ id: `sib-${i}`, featureId: "f1", state: "todo", autoPick: false }));
    }
    await reviewRound(
      store, orch, provider, { id: "t1", featureId: "f1" },
      '{"verdict":"approve","reason":"ok","proposals":[{"title":"One more fix","why":"w","scope":"in-scope"}]}',
    );
    const created = await fleetTasks(store, "p1");
    expect(created).toHaveLength(1);
    expect(created[0]!.state).toBe("backlog"); // degraded, not promoted
  });

  it("in-scope degrades to parked when the project is over its daily budget", async () => {
    const { store, orch, provider } = await setup({ dailyBudgetUsd: 1 });
    await store.putFeature(mkFeature());
    // Already spent past the $1 ceiling today, on a run that isn't this review's own.
    await store.putRun(mkRun({ id: "spent-run", projectId: "p1", startedAt: Date.now(), usage: { inputTokens: 0, outputTokens: 0, costUsd: 5, turns: 1, durationMs: 1 } }));
    await reviewRound(
      store, orch, provider, { id: "t1", featureId: "f1" },
      '{"verdict":"approve","reason":"ok","proposals":[{"title":"Fix it","why":"w","scope":"in-scope"}]}',
    );
    const created = await fleetTasks(store, "p1");
    expect(created).toHaveLength(1);
    expect(created[0]!.state).toBe("backlog"); // degraded
  });

  it("never creates a duplicate for a title matching an existing open task", async () => {
    const { store, orch, provider } = await setup();
    await store.putFeature(mkFeature());
    await store.putTask(mkTask({ id: "existing", text: "Fix off-by-one in the paginator", state: "todo" }));
    await reviewRound(
      store, orch, provider, { id: "t1", featureId: "f1" },
      '{"verdict":"approve","reason":"ok","proposals":[{"title":"fix OFF-by-one in the paginator","why":"w","scope":"in-scope"}]}',
    );
    // No new fleet task was created — the proposal matched an existing open task.
    expect(await fleetTasks(store, "p1")).toHaveLength(0);
  });

  it("stops creating once the daily fleet-proposal cap is reached, for both scopes", async () => {
    const ORIG = config.fleetProposalMaxPerProjectPerDay;
    config.fleetProposalMaxPerProjectPerDay = 1;
    try {
      const { store, orch, provider } = await setup();
      await store.putFeature(mkFeature());
      await reviewRound(
        store, orch, provider, { id: "t1", featureId: "f1" },
        '{"verdict":"approve","reason":"ok","proposals":[' +
          '{"title":"First one","why":"w","scope":"new-scope"},' +
          '{"title":"Second one","why":"w","scope":"new-scope"}' +
          "]}",
      );
      const created = await fleetTasks(store, "p1");
      expect(created).toHaveLength(1); // the 2nd was dropped by the cap, not parked either
      expect(created[0]!.text).toBe("First one");
    } finally {
      config.fleetProposalMaxPerProjectPerDay = ORIG;
    }
  });

  it("a flagged verdict can still surface a proposal — proposals aren't gated on approve", async () => {
    const { store, orch, provider } = await setup();
    await store.putFeature(mkFeature());
    await reviewRound(
      store, orch, provider, { id: "t1", featureId: "f1" },
      '{"verdict":"flag","reason":"missing tests","proposals":[{"title":"Add the missing tests","why":"reviewer noticed","scope":"in-scope"}]}',
    );
    expect((await store.getTask("t1"))?.reviewVerdict?.decision).toBe("flag"); // the flag itself is untouched
    const created = await fleetTasks(store, "p1");
    expect(created).toHaveLength(1);
    expect(created[0]!.state).toBe("todo"); // in-scope, feature open + under cap/budget → still promotes
  });
});
