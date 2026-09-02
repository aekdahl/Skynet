// You cannot optimise a cache hit rate you cannot see.
//
// The runner has always computed the cache tiers (RunnerUsage.cacheReadTokens /
// cacheWriteTokens) and the persisted Usage contract dropped them — so "what
// fraction of our input is cache reads?" was unanswerable. That is the same
// failure as the original under-reporting meter: the data existed, nothing kept
// it. The split matters more than the total because the tiers are priced ~10x
// apart, and the two possible answers call for OPPOSITE fixes:
//   high hit rate → caching works; spend is a volume problem (fewer turns, less context)
//   low  hit rate → something invalidates the prefix; we pay fresh input prices
import { describe, it, expect } from "vitest";
import { Usage } from "@skynet/shared";
import { readUsage, addUsage } from "../packages/runner-sdk/src/claude.js";
import { cacheHitRate, fmtCacheHitRate } from "../apps/web/src/lib/derive.js";

const result = (over: Record<string, unknown> = {}) => ({
  modelUsage: {
    m: { inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 0, cacheCreationInputTokens: 0, ...over },
  },
  num_turns: 3,
});

describe("the tiers survive the contract boundary", () => {
  it("Usage keeps cacheRead/cacheWrite, not just the total", () => {
    const u = Usage.parse({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 5 });
    expect(u.cacheReadTokens).toBe(80);
    expect(u.cacheWriteTokens).toBe(5);
  });

  it("defaults to 0 for a run recorded before the tiers existed", () => {
    const u = Usage.parse({ inputTokens: 100, outputTokens: 10 });
    expect(u.cacheReadTokens).toBe(0);
    expect(u.cacheWriteTokens).toBe(0);
  });

  it("the runner reports the tiers, and they are ALSO inside inputTokens", () => {
    // Load-bearing: inputTokens is the billable total, the tiers are a
    // breakdown of it. Treating them as additive would double-count.
    const u = readUsage({ modelUsage: { m: { inputTokens: 200, outputTokens: 10, cacheReadInputTokens: 700, cacheCreationInputTokens: 100 } } });
    expect(u.cacheReadTokens).toBe(700);
    expect(u.cacheWriteTokens).toBe(100);
    expect(u.inputTokens).toBe(1000);
  });

  it("sums the tiers across relaunched segments", () => {
    const a = readUsage({ modelUsage: { m: { inputTokens: 10, cacheReadInputTokens: 90 } } });
    const b = readUsage({ modelUsage: { m: { inputTokens: 20, cacheReadInputTokens: 180 } } });
    expect(addUsage(a, b).cacheReadTokens).toBe(270);
  });
});

describe("cacheHitRate", () => {
  it("reports the share of input served from cache", () => {
    expect(cacheHitRate({ inputTokens: 1000, cacheReadTokens: 900, cacheWriteTokens: 50 })).toBeCloseTo(0.9, 6);
    expect(fmtCacheHitRate({ inputTokens: 1000, cacheReadTokens: 900 })).toBe("90% cached");
  });

  it("is NULL, not 0%, when the tiers were never recorded", () => {
    // A run from before the tiers were persisted has an UNKNOWN hit rate.
    // Rendering that as "0% cached" would invent an alarming fact out of
    // missing data and send someone hunting a cache bug that isn't there.
    expect(cacheHitRate({ inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeNull();
    expect(fmtCacheHitRate({ inputTokens: 1000 })).toBeNull();
    expect(cacheHitRate(null)).toBeNull();
  });

  it("distinguishes a real 0% (writes but no reads) from unknown", () => {
    // First turn of a fresh session: everything written, nothing read yet.
    // That IS a real 0%, and it should say so.
    expect(cacheHitRate({ inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 1000 })).toBe(0);
  });

  it("never divides by zero", () => {
    expect(cacheHitRate({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeNull();
  });
});
