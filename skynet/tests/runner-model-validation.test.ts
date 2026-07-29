// Provider+model validation is ADVISORY on the model (supersedes the original
// DEF-004 hard allowlist): the catalog's `models` are curated SUGGESTIONS, not a
// gate — the runner passes the model string straight to the vendor CLI/SDK, which
// is the real authority. So any NON-EMPTY model is accepted for a KNOWN provider
// (this is what lets a just-released model be used without a catalog edit); only
// an unknown provider or an empty model is rejected. `isKnownModel` is the
// separate, non-blocking signal the UI uses to flag a model as "unverified".
import { describe, it, expect } from "vitest";
import { modelValidForProvider, isKnownModel } from "@skynet/shared";
import { MemoryStore } from "../apps/server/src/store/memory.js";

describe("provider/model validation — advisory", () => {
  it("accepts any non-empty model for a known provider, including unlisted/new ones", async () => {
    const catalog = await new MemoryStore().listProviders();
    expect(modelValidForProvider(catalog, "claude", "opus-4.8")).toBeUndefined(); // listed
    expect(modelValidForProvider(catalog, "claude", "claude-opus-4-9-20260601")).toBeUndefined(); // new, unlisted
    expect(modelValidForProvider(catalog, "gemini", "gemini-4-ultra")).toBeUndefined(); // new, unlisted
  });

  it("still rejects an unknown provider", async () => {
    const catalog = await new MemoryStore().listProviders();
    expect(modelValidForProvider(catalog, "nope", "gemini-3-pro")).toMatch(/Unknown provider/);
  });

  it("rejects an empty / whitespace model", async () => {
    const catalog = await new MemoryStore().listProviders();
    expect(modelValidForProvider(catalog, "claude", "")).toMatch(/model is required/i);
    expect(modelValidForProvider(catalog, "claude", "   ")).toMatch(/model is required/i);
  });
});

describe("isKnownModel — UI 'verified' signal (never a gate)", () => {
  it("true only for a provider's curated suggestions", async () => {
    const catalog = await new MemoryStore().listProviders();
    expect(isKnownModel(catalog, "claude", "opus-4.8")).toBe(true);
    expect(isKnownModel(catalog, "claude", " opus-4.8 ")).toBe(true); // trims
    expect(isKnownModel(catalog, "claude", "claude-opus-4-9")).toBe(false); // custom/new
    expect(isKnownModel(catalog, "gemini", "opus-4.8")).toBe(false); // wrong provider
    expect(isKnownModel(catalog, "nope", "anything")).toBe(false); // unknown provider
  });
});
