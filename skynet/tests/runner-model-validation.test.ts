// DEF-004: a runner's model must belong to the chosen provider's catalog.
// POST /api/fleet/runners and PATCH /api/fleet/runners/:id both validate the
// requested model against the provider's model list via modelValidForProvider,
// fed from the live provider catalog (store.listProviders() → GET /api/providers,
// the single source of truth). A nonsensical pairing (e.g. gemini + opus-4.8)
// must be rejected; a valid pairing is accepted.
import { describe, it, expect } from "vitest";
import { modelValidForProvider } from "@skynet/shared";
import { MemoryStore } from "../apps/server/src/store/memory.js";

describe("DEF-004 runner model/provider validation", () => {
  it("rejects a model that is not in the provider's list", async () => {
    const catalog = await new MemoryStore().listProviders();
    // opus-4.8 is a Claude model — nonsensical for gemini (the exact repro).
    const err = modelValidForProvider(catalog, "gemini", "opus-4.8");
    expect(err).toBeDefined();
    expect(err).toMatch(/not valid for provider "gemini"/);
  });

  it("accepts a valid provider+model pairing", async () => {
    const catalog = await new MemoryStore().listProviders();
    expect(modelValidForProvider(catalog, "gemini", "gemini-3-pro")).toBeUndefined();
    expect(modelValidForProvider(catalog, "gemini", "gemini-3-flash")).toBeUndefined();
    expect(modelValidForProvider(catalog, "claude", "opus-4.8")).toBeUndefined();
  });

  it("rejects an unknown provider", async () => {
    const catalog = await new MemoryStore().listProviders();
    expect(modelValidForProvider(catalog, "nope", "gemini-3-pro")).toMatch(/Unknown provider/);
  });

  it("guards a PATCH-style model change against the runner's existing provider", async () => {
    const catalog = await new MemoryStore().listProviders();
    // A gemini runner may switch between gemini models, but not to a Claude one.
    expect(modelValidForProvider(catalog, "gemini", "gemini-3-flash")).toBeUndefined();
    expect(modelValidForProvider(catalog, "gemini", "opus-4.8")).toMatch(/not valid for provider "gemini"/);
  });
});
