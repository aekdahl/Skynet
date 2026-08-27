// Cost on a compatible endpoint. The SDK prices every run from Claude Code's
// own ANTHROPIC table, which is meaningless once another vendor served the
// tokens — so an operator who moved to a cheap endpoint to save money would
// have no trustworthy way to tell whether it worked. That makes the pricing
// path load-bearing for the entire feature, not a nicety.
import { describe, it, expect } from "vitest";
import {
  COMPATIBLE_VENDORS,
  ANTHROPIC_RATES,
  vendorForBaseUrl,
  endpointLabel,
  ratesFor,
  priceUsage,
} from "@skynet/shared";
import { readUsage } from "../packages/runner-sdk/src/claude.js";

describe("the vendor catalog", () => {
  it("matches an endpoint regardless of trailing slash or case", () => {
    expect(vendorForBaseUrl("https://api.moonshot.ai/anthropic")?.id).toBe("moonshot");
    expect(vendorForBaseUrl("https://api.moonshot.ai/anthropic/")?.id).toBe("moonshot");
    expect(vendorForBaseUrl("HTTPS://API.MOONSHOT.AI/anthropic")?.id).toBe("moonshot");
  });

  it("has no duplicate base URLs — one endpoint must resolve to one vendor", () => {
    const urls = COMPATIBLE_VENDORS.map((v) => v.baseUrl.toLowerCase());
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("labels a catalogued endpoint by vendor and an unknown one by host", () => {
    expect(endpointLabel("https://api.z.ai/api/anthropic")).toBe("Z.ai (GLM)");
    expect(endpointLabel("https://my-proxy.internal:8080/anthropic")).toBe("my-proxy.internal:8080");
  });

  it("reports NO label for Anthropic's own API — there's nothing to flag", () => {
    expect(endpointLabel(null)).toBeNull();
    expect(endpointLabel("")).toBeNull();
  });
});

describe("ratesFor", () => {
  it("prices a catalogued (endpoint, model) pair", () => {
    const rates = ratesFor("https://api.deepseek.com/anthropic", "deepseek-v4-flash");
    expect(rates).toMatchObject({ inputPerMTok: 0.44, outputPerMTok: 1.32, cacheReadPerMTok: 0.014 });
  });

  it("prefers the LONGEST matching model id", () => {
    // "kimi-k2.7-code-highspeed" starts with "kimi-k2.7-code"; billing it at
    // the cheaper model's rate would understate spend by half.
    const hs = ratesFor("https://api.moonshot.ai/anthropic", "kimi-k2.7-code-highspeed");
    expect(hs?.inputPerMTok).toBe(1.9);
    expect(ratesFor("https://api.moonshot.ai/anthropic", "kimi-k2.7-code")?.inputPerMTok).toBe(0.95);
  });

  it("still prices a dated or suffixed model id", () => {
    expect(ratesFor("https://api.z.ai/api/anthropic", "glm-5.3-0814")?.inputPerMTok).toBe(1.4);
  });

  it("returns null rather than guessing for an unlisted vendor or model", () => {
    // A made-up cost is worse than an admitted gap: it would silently become
    // the number an operator makes budget decisions on.
    expect(ratesFor("https://unknown.example/anthropic", "whatever")).toBeNull();
    expect(ratesFor("https://api.deepseek.com/anthropic", "some-unreleased-model")).toBeNull();
    expect(ratesFor("https://api.z.ai/api/anthropic", "glm-5.3-flash")).toBeNull(); // listed, rates unpublished
  });

  it("falls back to Anthropic's own rates when there's no endpoint", () => {
    expect(ratesFor(null, "sonnet-5")).toEqual(ANTHROPIC_RATES.sonnet);
    expect(ratesFor(null, "claude-opus-4-8")).toEqual(ANTHROPIC_RATES.opus);
  });
});

describe("priceUsage — cache tiers are priced apart, on purpose", () => {
  const rates = { inputPerMTok: 1, outputPerMTok: 10, cacheReadPerMTok: 0.1, cacheWritePerMTok: 2 };

  it("prices each tier at its own rate", () => {
    const cost = priceUsage(
      { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 },
      rates,
    );
    expect(cost).toBeCloseTo(1 + 10 + 0.1 + 2, 9);
  });

  it("does NOT bill a cache read as fresh input", () => {
    // An agent workload is mostly replayed context. Folding cache reads into
    // input would overstate a cheap endpoint by ~10x and hide the whole saving.
    const cached = priceUsage({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 10_000_000, cacheWriteTokens: 0 }, rates);
    const fresh = priceUsage({ inputTokens: 10_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, rates);
    expect(cached).toBeLessThan(fresh);
    expect(cached).toBeCloseTo(1, 9);
  });

  it("falls back to the input rate for a tier the vendor doesn't publish", () => {
    // Over-states rather than flatters the cheap option — the safe direction.
    const unpublished = { inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: null, cacheWritePerMTok: null };
    const cost = priceUsage({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 }, unpublished);
    expect(cost).toBeCloseTo(4, 9);
  });

  it("a real DeepSeek-shaped run costs a fraction of the same run on Sonnet", () => {
    // The claim the whole feature rests on, at this repo's own observed shape:
    // overwhelmingly cached input, little output.
    const shape = { inputTokens: 5_000_000, outputTokens: 3_400_000, cacheReadTokens: 510_000_000, cacheWriteTokens: 5_000_000 };
    const onSonnet = priceUsage(shape, ANTHROPIC_RATES.sonnet!);
    const onDeepSeek = priceUsage(shape, ratesFor("https://api.deepseek.com/anthropic", "deepseek-v4-flash")!);
    expect(onDeepSeek).toBeLessThan(onSonnet / 5);
  });
});

describe("readUsage applies the endpoint's rates", () => {
  const result = {
    modelUsage: {
      "deepseek-v4-flash": {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadInputTokens: 10_000_000,
        cacheCreationInputTokens: 0,
        costUSD: 999,
      },
    },
    total_cost_usd: 999, // the SDK's Anthropic-priced figure — must be overridden
    num_turns: 3,
  };

  it("overrides the SDK's Anthropic-priced cost when rates are known", () => {
    const rates = ratesFor("https://api.deepseek.com/anthropic", "deepseek-v4-flash")!;
    const usage = readUsage(result, rates);
    expect(usage.costUsd).not.toBe(999);
    // 1M fresh input @0.44 + 1M output @1.32 + 10M cache reads @0.014
    expect(usage.costUsd).toBeCloseTo(0.44 + 1.32 + 0.14, 6);
  });

  it("keeps the SDK's own figure when the endpoint isn't priceable", () => {
    expect(readUsage(result).costUsd).toBe(999);
    expect(readUsage(result, null).costUsd).toBe(999);
  });

  it("still reports the cache tiers separately, and inside inputTokens", () => {
    const usage = readUsage(result);
    expect(usage.cacheReadTokens).toBe(10_000_000);
    expect(usage.cacheWriteTokens).toBe(0);
    expect(usage.inputTokens).toBe(11_000_000); // fresh + cache read + cache write
  });
});
