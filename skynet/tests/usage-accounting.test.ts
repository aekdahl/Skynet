// Cost accounting: what Skynet reports it spent must match what it actually
// spent. Reconciling recorded run usage against the provider's own console
// showed Skynet seeing barely a third of real token spend; these pin the two
// causes that were fixable in code.
//
//  1. Hub.runUsage ACCUMULATES. One run launches several SDK queries (turn-
//     budget continues, transient relaunches), each emitting its own `result`
//     meter. The old `putRun({ ...a, usage })` clobbered every prior segment,
//     so a run that burned its whole turn budget recorded only the last slice.
//  2. readUsage folds in the cache tiers — a cache read is ~10x cheaper but is
//     still billed, so dropping it under-reports real spend.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ServerEvent, Usage } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { readUsage } from "../packages/runner-sdk/src/claude.js";
import { Hub } from "../apps/server/src/hub.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

class RecordingBus implements Bus {
  events: ServerEvent[] = [];
  publish(_ws: string, event: ServerEvent): void { this.events.push(event); }
  subscribe(): () => void { return () => {}; }
}

const seg = (over: Partial<Usage> = {}): Usage => ({
  inputTokens: 1_000_000,
  outputTokens: 10_000,
  costUsd: 1.5,
  turns: 60,
  durationMs: 60_000,
  ...over,
});

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

describe("Hub.runUsage — accumulates segments, never overwrites", () => {
  it("a single segment records as-is", async () => {
    const { store, hub } = await setup();
    await hub.runUsage("r1", seg());
    expect((await store.getRun("r1"))?.usage).toEqual(seg());
  });

  it("FOUR segments (a run that exhausted its turn budget 3x) sum — not just the last one", async () => {
    const { store, hub } = await setup();
    for (let i = 0; i < 4; i++) await hub.runUsage("r1", seg());
    const u = (await store.getRun("r1"))!.usage!;
    // The exact bug: this used to report 1 segment (1M tokens / $1.50 / 60 turns)
    // for a run that really burned 4 (4M / $6.00 / 240 turns) — a 4x undercount.
    expect(u.inputTokens).toBe(4_000_000);
    expect(u.outputTokens).toBe(40_000);
    expect(u.costUsd).toBeCloseTo(6.0, 6);
    expect(u.turns).toBe(240);
    expect(u.durationMs).toBe(240_000);
  });

  it("segments with different sizes sum correctly", async () => {
    const { store, hub } = await setup();
    await hub.runUsage("r1", seg({ inputTokens: 500, outputTokens: 5, costUsd: 0.25, turns: 3, durationMs: 100 }));
    await hub.runUsage("r1", seg({ inputTokens: 1_500, outputTokens: 25, costUsd: 0.75, turns: 7, durationMs: 200 }));
    const u = (await store.getRun("r1"))!.usage!;
    expect(u).toEqual({ inputTokens: 2_000, outputTokens: 30, costUsd: 1.0, turns: 10, durationMs: 300 });
  });

  it("a null-cost segment never wipes an already-priced total", async () => {
    const { store, hub } = await setup();
    await hub.runUsage("r1", seg({ costUsd: 2.0 }));
    await hub.runUsage("r1", seg({ costUsd: null }));
    expect((await store.getRun("r1"))!.usage!.costUsd).toBeCloseTo(2.0, 6);
  });

  it("costUsd stays null only while EVERY segment was unpriced", async () => {
    const { store, hub } = await setup();
    await hub.runUsage("r1", seg({ costUsd: null }));
    await hub.runUsage("r1", seg({ costUsd: null }));
    expect((await store.getRun("r1"))!.usage!.costUsd).toBeNull();
  });

  it("publishes the running TOTAL (not the bare segment) so the UI can't show a shrinking number", async () => {
    const { bus, hub } = await setup();
    await hub.runUsage("r1", seg());
    await hub.runUsage("r1", seg());
    const last = bus.events.filter((e) => e.type === "run.usage").at(-1) as { usage: Usage };
    expect(last.usage.inputTokens).toBe(2_000_000);
    expect(last.usage.turns).toBe(120);
  });
});

describe("readUsage — the shared meter read", () => {
  it("folds cache reads + cache creation into inputTokens (they're billed too)", () => {
    const u = readUsage({
      usage: { input_tokens: 1_000, cache_read_input_tokens: 250_000, cache_creation_input_tokens: 9_000, output_tokens: 500 },
      total_cost_usd: 0.42,
      num_turns: 7,
      duration_ms: 1_234,
    });
    // Counting only `input_tokens` would report 1k for a call that really read
    // 260k — the difference between a rounding error and the whole bill.
    expect(u.inputTokens).toBe(260_000);
    expect(u.outputTokens).toBe(500);
    expect(u.costUsd).toBeCloseTo(0.42, 6);
    expect(u.turns).toBe(7);
    expect(u.durationMs).toBe(1_234);
  });

  it("degrades to zeros/nulls on a malformed or empty result rather than throwing", () => {
    expect(readUsage({})).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: null, turns: 0, durationMs: null });
    expect(readUsage({ usage: { input_tokens: "nope" }, total_cost_usd: "free" }).inputTokens).toBe(0);
  });
});

// A source-level guard, in the spirit of client-coverage.test.ts. The original
// bug wasn't that someone CHOSE Opus for Steward chat — it's that nobody chose
// anything, and the helper's own `?? "opus"` fallback picked the priciest model
// in the catalog for every caller that didn't think about it. A type-level
// "model is required" enforces that at each call site; this pins the fallback
// itself so it can't quietly come back.
describe("no one-shot helper may default to a model", () => {
  const claude = read("../packages/runner-sdk/src/claude.ts");

  it("claude.ts has no `?? \"opus\"` (or any other) implicit model fallback", () => {
    const fallbacks = [...claude.matchAll(/model:\s*(?:mapModel\()?opts\.model\s*\?\?\s*["'][^"']+["']/g)].map((m) => m[0]);
    expect(fallbacks, `Implicit model fallback(s) reintroduced:\n  ${fallbacks.join("\n  ")}`).toEqual([]);
  });

  it("oneShotText / oneShotRepoAssistant declare `model` as REQUIRED, not optional", () => {
    // `model?: string` in either signature would restore the silent-default hazard.
    for (const fn of ["oneShotText", "oneShotTextStream", "oneShotRepoAssistant", "oneShotRepoAssistantStream"]) {
      const sig = claude.slice(claude.indexOf(`export function ${fn}(`) >= 0 ? claude.indexOf(`export function ${fn}(`) : claude.indexOf(`export async function ${fn}(`));
      const opts = sig.slice(0, sig.indexOf("}"));
      expect(opts.includes("model?"), `${fn}() still declares model as optional`).toBe(false);
      expect(opts.includes("model:"), `${fn}() no longer takes a model`).toBe(true);
    }
  });
});
