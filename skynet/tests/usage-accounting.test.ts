// Cost accounting: what Skynet reports it spent must match what it actually
// spent. Reconciling recorded run usage against the provider's own console
// showed Skynet seeing barely a third of real token spend. Two causes, both in
// how the runner reads the SDK's `result` message — and one non-cause that's
// easy to "fix" into a much worse bug:
//
//  1. It read `usage`, which the SDK documents as "MAIN AGENT LOOP ONLY —
//     excludes Task subagent, sidechain, and auxiliary model calls". Agents
//     spawn subagents routinely, so all of that work was billed but unrecorded.
//     `modelUsage` is the field the SDK calls "the correct field for token/cost
//     accounting"; it covers subagents, sidechains and compaction.
//  2. It emitted only the CURRENT query segment. A run spans several query()
//     calls (turn-budget continues, transient relaunches) and a resumed session
//     restarts its counters at zero, so every prior segment was dropped.
//
// The non-cause: these readings are CUMULATIVE within a query ("each result
// carries the running total so far, so read the latest result rather than
// summing across results"). Summing every result — or accumulating again in
// Hub.runUsage — would multiply a long run's cost by roughly its turn count.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ServerEvent, Usage } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { addUsage, readUsage } from "../packages/runner-sdk/src/claude.js";
import { Hub } from "../apps/server/src/hub.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

class RecordingBus implements Bus {
  events: ServerEvent[] = [];
  publish(_ws: string, event: ServerEvent): void { this.events.push(event); }
  subscribe(): () => void { return () => {}; }
}

/** An SDK `result` shaped the way the real one is: modelUsage keyed by model. */
const result = (over: {
  main?: Partial<Record<string, number>>;
  sub?: Partial<Record<string, number>>;
  cost?: number;
  turns?: number;
  ms?: number;
} = {}) => {
  const entry = (o: Partial<Record<string, number>> = {}) => ({
    inputTokens: o.inputTokens ?? 0,
    outputTokens: o.outputTokens ?? 0,
    cacheReadInputTokens: o.cacheReadInputTokens ?? 0,
    cacheCreationInputTokens: o.cacheCreationInputTokens ?? 0,
    costUSD: o.costUSD ?? 0,
  });
  const modelUsage: Record<string, unknown> = { "claude-sonnet-5": entry(over.main) };
  if (over.sub) modelUsage["claude-haiku-4-5"] = entry(over.sub);
  return {
    modelUsage,
    total_cost_usd: over.cost,
    num_turns: over.turns ?? 0,
    duration_ms: over.ms,
    // Present and deliberately WRONG/short — nothing may read this field.
    usage: { input_tokens: 1, output_tokens: 1 },
  } as Record<string, unknown>;
};

describe("readUsage — reads modelUsage, not the main-loop-only `usage`", () => {
  it("counts Task subagent / sidechain model calls, which `usage` excludes", () => {
    const u = readUsage(result({
      main: { inputTokens: 1_000, outputTokens: 500, cacheReadInputTokens: 200_000 },
      sub: { inputTokens: 5_000, outputTokens: 2_000, cacheReadInputTokens: 50_000 },
      cost: 1.25,
    }));
    // The bug: reading `usage` would have reported 1 input / 1 output for a
    // call that really consumed 256k input across two models.
    expect(u.inputTokens).toBe(1_000 + 200_000 + 5_000 + 50_000);
    expect(u.outputTokens).toBe(2_500);
    expect(u.costUsd).toBeCloseTo(1.25, 6);
  });

  it("folds cache reads AND cache creation into inputTokens (both are billed)", () => {
    const u = readUsage(result({ main: { inputTokens: 10, cacheReadInputTokens: 900, cacheCreationInputTokens: 90 } }));
    expect(u.inputTokens).toBe(1_000);
  });

  it("falls back to costUSD summed per model when total_cost_usd is absent", () => {
    const u = readUsage(result({ main: { costUSD: 0.4 }, sub: { costUSD: 0.1 } }));
    expect(u.costUsd).toBeCloseTo(0.5, 6);
  });

  it("degrades to the main-loop `usage` only when modelUsage is missing entirely", () => {
    const u = readUsage({ usage: { input_tokens: 7, cache_read_input_tokens: 3, output_tokens: 2 }, num_turns: 1 });
    expect(u.inputTokens).toBe(10);
    expect(u.outputTokens).toBe(2);
  });

  it("degrades to zeros/nulls on an empty or malformed result rather than throwing", () => {
    expect(readUsage({})).toEqual({
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, turns: 0, durationMs: null,
    });
    expect(readUsage({ modelUsage: { m: { inputTokens: "nope" } }, total_cost_usd: "free" }).inputTokens).toBe(0);
  });
});

describe("addUsage — carries COMPLETED query segments across a relaunch", () => {
  it("sums two segments (a resumed session restarts its own counters at zero)", () => {
    const a = readUsage(result({ main: { inputTokens: 1_000_000, outputTokens: 10_000 }, cost: 1.5, turns: 60, ms: 60_000 }));
    const b = readUsage(result({ main: { inputTokens: 2_000_000, outputTokens: 20_000 }, cost: 3.0, turns: 60, ms: 90_000 }));
    expect(addUsage(a, b)).toEqual({
      inputTokens: 3_000_000, outputTokens: 30_000, cacheReadTokens: 0, cacheWriteTokens: 0,
      costUsd: 4.5, turns: 120, durationMs: 150_000,
    });
  });

  it("a null cost never wipes an already-priced total, and stays null only if both are", () => {
    const priced = readUsage(result({ cost: 2 }));
    const unpriced = readUsage({ modelUsage: {} });
    expect(addUsage(priced, unpriced).costUsd).toBeCloseTo(2, 6);
    expect(addUsage(unpriced, unpriced).costUsd).toBeNull();
  });
});

describe("Hub.runUsage — stores the reported total verbatim", () => {
  const setup = async () => {
    const store = new MemoryStore({ seed: false });
    const bus = new RecordingBus();
    const hub = new Hub(store, bus);
    await store.putRun({
      id: "r1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", name: "t", status: "running",
      agentId: "a1", provider: "claude", credentialId: null, model: "sonnet-5", branch: "b",
      modules: [], progress: 0, plan: [], usage: null, modifiedFiles: [], log: [],
      startedAt: 0, lastHeartbeatAt: 0, visual: false, previewUrl: null, dependsOn: [],
      parentId: null, branchFromStep: null, archived: false, pr: null, mergedAt: null, flyDeployment: null,
    });
    return { store, bus, hub };
  };
  const usage = (over: Partial<Usage> = {}): Usage =>
    ({ inputTokens: 1_000, outputTokens: 10, costUsd: 1, turns: 5, durationMs: 100, ...over });

  it("REPLACES rather than accumulating — the runner already sent a running total", async () => {
    const { store, hub } = await setup();
    await hub.runUsage("r1", usage({ inputTokens: 1_000, costUsd: 1, turns: 5 }));
    await hub.runUsage("r1", usage({ inputTokens: 3_000, costUsd: 3, turns: 15 }));
    // Accumulating here would report 4,000/$4 for a run that has spent 3,000/$3.
    // On a 60-turn run (one result per turn) that error compounds ~60x.
    const u = (await store.getRun("r1"))!.usage!;
    expect(u.inputTokens).toBe(3_000);
    expect(u.costUsd).toBeCloseTo(3, 6);
    expect(u.turns).toBe(15);
  });

  it("publishes the same total it stored", async () => {
    const { bus, hub } = await setup();
    await hub.runUsage("r1", usage({ inputTokens: 2_500 }));
    const last = bus.events.filter((e) => e.type === "run.usage").at(-1) as { usage: Usage };
    expect(last.usage.inputTokens).toBe(2_500);
  });
});

// Source-level guards, in the spirit of client-coverage.test.ts. The original
// bug wasn't that someone CHOSE Opus for Steward chat — it's that nobody chose
// anything, and the helper's own `?? "opus"` fallback picked the priciest model
// in the catalog for every caller that didn't think about it.
describe("no one-shot helper may default to a model", () => {
  const claude = read("../packages/runner-sdk/src/claude.ts");

  it('claude.ts has no `?? "opus"` (or any other) implicit model fallback', () => {
    const fallbacks = [...claude.matchAll(/model:\s*(?:mapModel\()?opts\.model\s*\?\?\s*["'][^"']+["']/g)].map((m) => m[0]);
    expect(fallbacks, `Implicit model fallback(s) reintroduced:\n  ${fallbacks.join("\n  ")}`).toEqual([]);
  });

  it("oneShotText / oneShotRepoAssistant declare `model` as REQUIRED, not optional", () => {
    for (const fn of ["oneShotText", "oneShotTextStream", "oneShotRepoAssistant", "oneShotRepoAssistantStream"]) {
      const at = Math.max(claude.indexOf(`export function ${fn}(`), claude.indexOf(`export async function ${fn}(`));
      expect(at, `${fn}() not found`).toBeGreaterThan(-1);
      const opts = claude.slice(at, claude.indexOf("}", at));
      expect(opts.includes("model?"), `${fn}() still declares model as optional`).toBe(false);
      expect(opts.includes("model:"), `${fn}() no longer takes a model`).toBe(true);
    }
  });

  it("readUsage reads modelUsage — never the main-loop-only `usage` as its primary source", () => {
    const body = claude.slice(claude.indexOf("export function readUsage("));
    const fn = body.slice(0, body.indexOf("\n}\n"));
    expect(fn.includes("result.modelUsage"), "readUsage no longer reads modelUsage").toBe(true);
  });
});
