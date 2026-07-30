// The Settings provider card reads credential state from TWO sources: the "via
// Settings ····" pill from a fresh secret-store fetch, and the readiness badge
// from the snapshot's `available`. When those disagree (a key set out-of-band, or
// a stale snapshot), the badge wrongly claimed "needs a credential" for a key that
// was plainly shown as set right above it. providerReadiness now takes an explicit
// credential override so the card can drive the badge from its fresh source. This
// locks that behavior — and the unchanged snapshot fallback.
import { describe, it, expect } from "vitest";
import type { ProviderInfo } from "@skynet/shared";
import { providerReadiness } from "../apps/web/src/lib/derive.js";

// A Codex-like CLI provider: needs its CLI on PATH AND a credential (no CLI-login
// exemption). `available` is the snapshot's credential signal.
const codex = (over: Partial<ProviderInfo> = {}): ProviderInfo =>
  ({
    id: "codex",
    name: "Codex",
    glyph: "◌",
    color: "#000",
    models: [],
    binOnPath: true,
    available: false,
    requirements: {
      runtime: "cli",
      bin: "codex",
      authEnvVars: ["OPENAI_API_KEY"],
      cliLogin: false,
      installHint: null,
      docsUrl: null,
      install: null,
    },
    ...over,
  }) as ProviderInfo;

describe("providerReadiness credential override", () => {
  it("without an override, a false snapshot `available` reports 'needs a credential'", () => {
    const rd = providerReadiness(codex({ available: false }));
    expect(rd.ready).toBe(false);
    expect(rd.missing.some((m) => m.includes("credential"))).toBe(true);
  });

  it("an override of true suppresses the credential clause even when the snapshot is stale (available:false)", () => {
    // This is the bug: key IS set (fresh fetch says so) but the snapshot lags.
    const rd = providerReadiness(codex({ available: false }), true);
    expect(rd.credentialSet).toBe(true);
    expect(rd.missing.some((m) => m.includes("credential"))).toBe(false);
    // CLI still on PATH here, so with the credential satisfied it's fully ready.
    expect(rd.ready).toBe(true);
  });

  it("an override of false requires a credential even if the snapshot said available:true", () => {
    const rd = providerReadiness(codex({ available: true }), false);
    expect(rd.credentialSet).toBe(false);
    expect(rd.missing.some((m) => m.includes("credential"))).toBe(true);
  });

  it("the override never masks a missing CLI — that clause is independent", () => {
    const rd = providerReadiness(codex({ binOnPath: false }), true);
    expect(rd.ready).toBe(false);
    expect(rd.missing.some((m) => m.includes("CLI on PATH"))).toBe(true);
    // ...but the credential clause is gone (override satisfied it).
    expect(rd.missing.some((m) => m.includes("credential"))).toBe(false);
  });

  it("omitting the override preserves snapshot-driven behavior (available:true → ready)", () => {
    const rd = providerReadiness(codex({ available: true }));
    expect(rd.ready).toBe(true);
  });
});
