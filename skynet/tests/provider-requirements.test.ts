// The provider catalog must carry an accurate "what's needed to run this"
// descriptor (server-assembled) and the UI's readiness rule must mirror the
// orchestrator's real usability: an SDK provider needs a credential; a CLI
// provider needs its binary on PATH plus either a credential or a CLI login.
import { describe, it, expect } from "vitest";
import type { ProviderInfo } from "@skynet/shared";
import { providerRequirements, withProviderRequirements } from "../apps/server/src/provider-requirements.js";
import { providerReadiness } from "../apps/web/src/lib/derive.js";

describe("providerRequirements", () => {
  it("marks claude as an in-process SDK with a credential, no binary", () => {
    const r = providerRequirements("claude");
    expect(r.runtime).toBe("sdk");
    expect(r.bin).toBeNull();
    expect(r.authEnvVars).toContain("ANTHROPIC_API_KEY");
    expect(r.installHint).toBeTruthy();
  });

  it("marks hermes as a CLI needing the hermes binary + a provider key", () => {
    const r = providerRequirements("hermes");
    expect(r.runtime).toBe("cli");
    expect(r.bin).toBe("hermes");
    expect(r.authEnvVars[0]).toBe("OPENROUTER_API_KEY");
    expect(r.cliLogin).toBe(false);
    expect(r.docsUrl).toContain("hermes");
  });

  it("marks cursor/copilot as CLI-login providers", () => {
    expect(providerRequirements("cursor").cliLogin).toBe(true);
    expect(providerRequirements("copilot").cliLogin).toBe(true);
  });

  it("marks opencode as a CLI needing the opencode binary + a provider key (Anthropic-first)", () => {
    const r = providerRequirements("opencode");
    expect(r.runtime).toBe("cli");
    expect(r.bin).toBe("opencode");
    expect(r.authEnvVars[0]).toBe("ANTHROPIC_API_KEY");
    expect(r.cliLogin).toBe(false);
    expect(r.docsUrl).toContain("opencode");
  });

  it("attaches binOnPath per provider (null for the SDK provider)", () => {
    const augmented = withProviderRequirements([
      { id: "claude", name: "Claude", glyph: "✱", color: "#000", models: ["opus-4.8"] },
      { id: "hermes", name: "Hermes", glyph: "⬡", color: "#000", models: ["m"] },
    ]);
    expect(augmented.find((p) => p.id === "claude")!.binOnPath).toBeNull();
    expect(typeof augmented.find((p) => p.id === "hermes")!.binOnPath).toBe("boolean");
  });
});

describe("providerReadiness", () => {
  const mk = (over: Partial<ProviderInfo>): ProviderInfo => ({
    id: "hermes", name: "H", glyph: "⬡", color: "#000", models: ["m"],
    requirements: providerRequirements("hermes"), binOnPath: true, available: true, ...over,
  });

  it("SDK provider: ready when a credential is set", () => {
    const p = mk({ id: "claude", requirements: providerRequirements("claude"), binOnPath: null, available: true });
    expect(providerReadiness(p).ready).toBe(true);
  });

  it("SDK provider: not ready without a credential", () => {
    const p = mk({ id: "claude", requirements: providerRequirements("claude"), binOnPath: null, available: false });
    expect(providerReadiness(p).ready).toBe(false);
  });

  it("CLI provider: not ready when the binary is missing", () => {
    const rd = providerReadiness(mk({ binOnPath: false, available: true }));
    expect(rd.ready).toBe(false);
    expect(rd.missing.join(" ")).toContain("hermes");
  });

  it("CLI provider: not ready with binary but no credential (non-login)", () => {
    expect(providerReadiness(mk({ binOnPath: true, available: false })).ready).toBe(false);
  });

  it("CLI-login provider: ready with binary present even without a key", () => {
    const p = mk({ id: "cursor", requirements: providerRequirements("cursor"), binOnPath: true, available: false });
    expect(providerReadiness(p).ready).toBe(true);
  });

  it("falls back to `available` when the server sends no requirements", () => {
    expect(providerReadiness(mk({ requirements: undefined, available: true })).ready).toBe(true);
    expect(providerReadiness(mk({ requirements: undefined, available: false })).ready).toBe(false);
  });
});
