// Auto-refresh of Fleet model SUGGESTIONS (Approach B). The mapping from an
// external models.dev-shaped catalog to per-provider model lists is pure + tested
// here; the fetch/schedule (provider-catalog-refresh.ts) is thin I/O over it. The
// last block proves the discovered suggestions merge into what a store serves,
// while the curated defaults always remain (the fail-safe fallback).
import { describe, it, expect, afterAll } from "vitest";
import { mapExternalCatalog, mergeModels } from "../apps/server/src/provider-catalog.js";
import { setModelOverrides, providerCatalog } from "../apps/server/src/store/providers.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";

// A models.dev-shaped fixture: object keyed by vendor, each with a `models` map.
const RAW = {
  anthropic: {
    id: "anthropic",
    models: {
      "claude-opus-4-6": { id: "claude-opus-4-6", tool_call: true, release_date: "2026-05-01" },
      "claude-haiku-4-5": { id: "claude-haiku-4-5", tool_call: true, release_date: "2025-10-01" },
      "claude-embed-1": { id: "claude-embed-1", tool_call: false, release_date: "2026-06-01" }, // dropped: tool_call false
    },
  },
  openai: {
    models: {
      "gpt-5.2-codex": { tool_call: true, release_date: "2026-01-01" },
      "o3-mini": { release_date: "2025-06-01" },
      "text-embedding-3": { release_date: "2024-01-01" }, // dropped: id shape
      "dall-e-3": {}, // dropped: id shape
    },
  },
  google: {
    models: {
      "gemini-3-pro": { release_date: "2026-02-01" },
      "gemini-2.5-flash": { release_date: "2025-03-01" },
    },
  },
  zhipuai: { models: { "glm-4.6": {} } }, // ignored: not a mapped vendor
};

describe("mapExternalCatalog", () => {
  it("maps vendors → Skynet providers, filters by id shape + tool_call, newest first", () => {
    const out = mapExternalCatalog(RAW);
    expect(out.claude).toEqual(["claude-opus-4-6", "claude-haiku-4-5"]); // embed dropped; newest first
    expect(out.codex).toEqual(["gpt-5.2-codex", "o3-mini"]); // embedding + dall-e dropped
    expect(out.gemini).toEqual(["gemini-3-pro", "gemini-2.5-flash"]);
    // Providers with no external source stay absent (keep their curated list).
    expect(out.cursor).toBeUndefined();
    expect(out.copilot).toBeUndefined();
    expect(out.hermes).toBeUndefined();
  });

  it("is fail-safe on garbage / missing input (→ {})", () => {
    expect(mapExternalCatalog(null)).toEqual({});
    expect(mapExternalCatalog("nope")).toEqual({});
    expect(mapExternalCatalog({ anthropic: {} })).toEqual({}); // no models map
    expect(mapExternalCatalog({ anthropic: { models: {} } })).toEqual({}); // empty models
  });
});

describe("mergeModels", () => {
  it("curated first, then discovered, deduped", () => {
    expect(mergeModels(["opus-4.8", "sonnet-4.6"], ["claude-opus-4-6", "sonnet-4.6"])).toEqual([
      "opus-4.8",
      "sonnet-4.6",
      "claude-opus-4-6", // sonnet-4.6 de-duped
    ]);
  });
  it("caps the list so the picker never balloons", () => {
    expect(mergeModels(["a", "b", "c"], ["d", "e", "f"], 4)).toEqual(["a", "b", "c", "d"]);
  });
  it("handles no discovered models (returns the curated list)", () => {
    expect(mergeModels(["opus-4.8"], undefined)).toEqual(["opus-4.8"]);
  });
});

describe("wiring — discovered suggestions merge into the served catalog", () => {
  afterAll(() => setModelOverrides({})); // never leak overrides into other test files

  it("providerCatalog + store.listProviders reflect the override, keeping curated defaults", async () => {
    setModelOverrides({ claude: ["claude-opus-4-6"] });
    const claude = providerCatalog().find((p) => p.id === "claude")!;
    expect(claude.models).toContain("opus-4.8"); // curated default still present (fallback)
    expect(claude.models).toContain("claude-opus-4-6"); // discovered id merged in
    expect(claude.models.indexOf("opus-4.8")).toBeLessThan(claude.models.indexOf("claude-opus-4-6")); // curated first

    const served = (await new MemoryStore().listProviders()).find((p) => p.id === "claude")!;
    expect(served.models).toContain("claude-opus-4-6"); // reflected through the store live

    setModelOverrides({});
    const reset = providerCatalog().find((p) => p.id === "claude")!;
    expect(reset.models).not.toContain("claude-opus-4-6"); // cleared → back to curated only
  });
});
